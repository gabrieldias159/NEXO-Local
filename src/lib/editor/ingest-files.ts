'use client';

/**
 * Ingestão de arquivos do SO → assets do editor.
 *
 * Centraliza o fluxo "arquivo local → MediaAsset" que antes vivia duplicado
 * em `AssetUploader.tsx` (upload em background) e `StageSlot.tsx`
 * (`readMediaDuration` + asset local volátil). Agora MediaBin, palco e
 * timeline reusam o MESMO caminho — todo arquivo solto vira asset 'uploading'
 * e sobe pro Storage em background, evitando blobs voláteis que somem ao
 * recarregar.
 *
 * Uso:
 *   const ingest = useIngestFiles();
 *   const assets = await ingest(fileList);  // assets já adicionados ao store
 *
 * `ingest` devolve os assets criados (na ordem dos arquivos aceitos), o que
 * permite ao caller usar o `id` recém-criado para encaixar num slot/track.
 */

import { useCallback } from 'react';
import type { MediaAsset } from './types';
import type { Timestamp } from 'firebase/firestore';
import { useEditorStore } from './store';
import { useFirebase } from '@/firebase/provider';
import { uploadAsset } from './persistence/asset-uploader';
import { useToast } from '@/hooks/use-toast';

/** Lê a duração de um arquivo de mídia (vídeo/áudio). Imagem → undefined. */
export function getMediaDuration(
  input: File | { url: string; type: string },
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const mime = input instanceof File ? input.type : input.type;
    if (mime.startsWith('image')) {
      resolve(undefined);
      return;
    }
    if (!mime.startsWith('video') && !mime.startsWith('audio')) {
      resolve(undefined);
      return;
    }

    let blobUrl: string | null = null;
    const src =
      input instanceof File ? (blobUrl = URL.createObjectURL(input)) : input.url;
    const el = document.createElement(
      mime.startsWith('video') ? 'video' : 'audio',
    );
    el.preload = 'metadata';

    // Garante um estado terminal mesmo se nem `loadedmetadata` nem `error`
    // dispararem (CORS/rede travada num recorte do Storage): sem isso a
    // importação ficaria presa em "enviando" pra sempre. A duração não é
    // crítica, então o timeout simplesmente resolve `undefined`.
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (value: number | undefined) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      el.onloadedmetadata = null;
      el.onerror = null;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      // Libera o elemento/requisição de rede pendente.
      el.removeAttribute('src');
      el.src = '';
      resolve(value);
    };

    timer = setTimeout(() => settle(undefined), 15_000);
    el.onloadedmetadata = () =>
      settle(Number.isFinite(el.duration) ? el.duration : undefined);
    el.onerror = () => settle(undefined);
    el.src = src;
  });
}

/** Tipo de mídia aceito a partir do MIME do arquivo, ou null se não suportado. */
export function mediaTypeOf(file: File): MediaAsset['type'] | null {
  if (file.type.startsWith('video')) return 'video';
  if (file.type.startsWith('image')) return 'image';
  if (file.type.startsWith('audio')) return 'audio';
  return null;
}

/** Cria um `MediaAsset` em memória (blob local) a partir de um File. */
export async function fileToAsset(
  file: File,
): Promise<{ asset: MediaAsset; localUrl: string } | null> {
  const type = mediaTypeOf(file);
  if (!type) return null;

  const duration = await getMediaDuration(file);
  const now = {
    seconds: Math.floor(Date.now() / 1000),
    nanoseconds: 0,
  } as unknown as Timestamp;

  const localUrl = URL.createObjectURL(file);

  const asset: MediaAsset = {
    id: `asset_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`,
    name: file.name,
    type,
    source: 'local-blob',
    downloadUrl: localUrl,
    size: file.size,
    duration,
    status: 'uploading',
    uploadProgress: 0,
    createdAt: now,
  };
  return { asset, localUrl };
}

/**
 * Hook que devolve a função `ingest(files)`.
 *
 * Para cada arquivo aceito:
 * 1. Cria asset local-blob 'uploading' e adiciona no store (preview imediato).
 * 2. Sobe pro Storage em background; ao concluir, troca pra `source:'firebase'`
 *    + `downloadUrl` persistente e revoga o blob local.
 * 3. Em erro, marca `status:'error'` e toasta.
 *
 * Devolve (resolve) a lista dos assets criados — útil pra encaixar logo
 * em uma track/slot pelo `id`.
 */
export function useIngestFiles() {
  const addAsset = useEditorStore((s) => s.addAsset);
  const updateAsset = useEditorStore((s) => s.updateAsset);
  const setAssetUploadProgress = useEditorStore(
    (s) => s.setAssetUploadProgress,
  );

  const { storage } = useFirebase();
  const { toast } = useToast();

  const ingest = useCallback(
    async (files: FileList | File[]): Promise<MediaAsset[]> => {
      const project = useEditorStore.getState().project;
      if (!project) return [];

      const arr = Array.from(files);
      const created: MediaAsset[] = [];

      for (const f of arr) {
        const made = await fileToAsset(f);
        if (!made) continue;
        const { asset, localUrl } = made;

        // Adiciona como 'uploading' e sobe em background.
        addAsset(asset);
        created.push(asset);

        void (async () => {
          try {
            const result = await uploadAsset(
              storage,
              project.id,
              f,
              (pct) => setAssetUploadProgress(asset.id, pct),
            );
            updateAsset(asset.id, {
              source: 'firebase',
              storagePath: result.storagePath,
              downloadUrl: result.downloadUrl,
              status: 'ready',
              uploadProgress: 100,
            });
            URL.revokeObjectURL(localUrl);
          } catch (err) {
            console.error('[ingest-files] erro no upload:', err);
            updateAsset(asset.id, { status: 'error' });
            toast({
              title: 'Falha no upload',
              description: `Não foi possível enviar "${f.name}". Verifique sua conexão e tente novamente.`,
              variant: 'destructive',
            });
          }
        })();
      }

      return created;
    },
    [addAsset, updateAsset, setAssetUploadProgress, storage, toast],
  );

  return ingest;
}
