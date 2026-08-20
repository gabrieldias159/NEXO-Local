'use client';

/**
 * Biblioteca do GABINETE no MediaBin (recurso 9 do fluxo do gabinete).
 *
 * Aba fixa com o acervo aprovado que mora em `biblioteca/` no Storage:
 *   biblioteca/identidade/  → logo, rodapé, vinheta
 *   biblioteca/sons/        → sons aprovados (XP error, moedas... CC0)
 *   biblioteca/memes/       → memes próprios VM*
 *   biblioteca/cards/       → palavras/cards gerados
 *
 * Cada item entra no projeto com UM clique — vira um `MediaAsset` normal
 * (`source: 'firebase'` apontando direto para o arquivo da biblioteca, sem
 * copiar bytes). A escrita na pasta é só por seed/admin (ver storage.rules).
 */

import * as React from 'react';
import { listAll, ref as storageRef, getDownloadURL } from 'firebase/storage';
import type { StorageReference } from 'firebase/storage';
import { useStorage } from '@/firebase';
import { useEditorStore } from '@/lib/editor/store';
import { getMediaDuration } from '@/lib/editor/ingest-files';
import type { MediaAsset } from '@/lib/editor/types';
import type { Timestamp } from 'firebase/firestore';
import { useToast } from '@/hooks/use-toast';
import { EditorIcons } from '../shared/EditorIcons';
import { cn } from '@/lib/utils';

interface LibItem {
  fullPath: string;
  name: string;
  categoria: string;
  type: MediaAsset['type'];
}

function typeFromName(name: string): MediaAsset['type'] {
  if (/\.(mp4|webm|mov)$/i.test(name)) return 'video';
  if (/\.(mp3|wav|m4a|ogg)$/i.test(name)) return 'audio';
  return 'image';
}

const MIME: Record<MediaAsset['type'], string> = {
  video: 'video/mp4',
  audio: 'audio/mpeg',
  image: 'image/png',
};

export function GabineteLibrary() {
  const storage = useStorage();
  const addAsset = useEditorStore((s) => s.addAsset);
  const { toast } = useToast();

  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<LibItem[] | null>(null);
  const [erro, setErro] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState<string | null>(null);

  const carregar = React.useCallback(async () => {
    if (!storage) return;
    setErro(null);
    try {
      const raiz = await listAll(storageRef(storage, 'biblioteca'));
      const subRefs: StorageReference[] = [...raiz.prefixes];
      const encontrados: LibItem[] = raiz.items.map((i) => ({
        fullPath: i.fullPath,
        name: i.name,
        categoria: 'geral',
        type: typeFromName(i.name),
      }));
      for (const sub of subRefs) {
        const lista = await listAll(sub);
        for (const i of lista.items) {
          encontrados.push({
            fullPath: i.fullPath,
            name: i.name,
            categoria: sub.name,
            type: typeFromName(i.name),
          });
        }
      }
      encontrados.sort((a, b) =>
        `${a.categoria}/${a.name}`.localeCompare(`${b.categoria}/${b.name}`),
      );
      setItems(encontrados);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
      setItems([]);
    }
  }, [storage]);

  React.useEffect(() => {
    if (open && items === null) void carregar();
  }, [open, items, carregar]);

  const importar = async (item: LibItem) => {
    if (!storage) return;
    setImporting(item.fullPath);
    try {
      const url = await getDownloadURL(storageRef(storage, item.fullPath));
      const duration = await getMediaDuration({ url, type: MIME[item.type] });
      const now = {
        seconds: Math.floor(Date.now() / 1000),
        nanoseconds: 0,
      } as unknown as Timestamp;
      const asset: MediaAsset = {
        id: `asset_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`,
        name: item.name,
        type: item.type,
        source: 'firebase',
        storagePath: item.fullPath,
        downloadUrl: url,
        size: 0,
        duration,
        status: 'ready',
        createdAt: now,
      };
      addAsset(asset);
      toast({ title: `"${item.name}" adicionada ao projeto` });
    } catch (e) {
      toast({
        title: 'Falha ao importar da biblioteca',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setImporting(null);
    }
  };

  return (
    <div className="rounded-[var(--editor-radius-md)] border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium',
          'text-muted-foreground hover:text-foreground',
        )}
        title="Acervo aprovado do gabinete: identidade, sons, memes VM* e cards"
      >
        <EditorIcons.Layers className="h-3.5 w-3.5" />
        Biblioteca do gabinete
        <span className="ml-auto text-[10px]">
          {open ? '▾' : '▸'}
          {items ? ` ${items.length}` : ''}
        </span>
      </button>

      {open && (
        <div className="max-h-52 overflow-y-auto border-t border-border px-1 py-1">
          {items === null && (
            <p className="px-1 py-2 text-[10px] text-muted-foreground">
              Carregando…
            </p>
          )}
          {erro && (
            <p className="px-1 py-2 text-[10px] text-red-400">
              Não deu para listar a biblioteca: {erro}
            </p>
          )}
          {items?.length === 0 && !erro && (
            <p className="px-1 py-2 text-[10px] text-muted-foreground">
              Biblioteca vazia — os arquivos moram em `biblioteca/` no Storage
              (identidade/, sons/, memes/, cards/).
            </p>
          )}
          {(items ?? []).map((item) => {
            const Icon =
              item.type === 'audio'
                ? EditorIcons.Audio
                : item.type === 'image'
                  ? EditorIcons.Image
                  : EditorIcons.Video;
            return (
              <div
                key={item.fullPath}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted"
              >
                <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[10px] text-foreground">
                    {item.name}
                  </p>
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground">
                    {item.categoria}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void importar(item)}
                  disabled={importing === item.fullPath}
                  className={cn(
                    'shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px]',
                    'text-muted-foreground hover:bg-border hover:text-foreground',
                    'disabled:opacity-50',
                  )}
                  title="Adicionar ao projeto (sem copiar o arquivo)"
                >
                  {importing === item.fullPath ? '…' : '+ usar'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
