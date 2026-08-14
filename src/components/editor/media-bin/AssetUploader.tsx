'use client';

/**
 * Componente de upload do MediaBin.
 *
 * Funções:
 * - Botão de "Importar mídia" (abre file picker via `<input type=file hidden>`).
 * - Botão de "Dos Recortes" (importa vídeo da biblioteca de recortes via dialog).
 * - Drop-zone para arrastar arquivos do desktop.
 *
 * Fluxo (arquivo local):
 * 1. Cria asset local imediatamente com `URL.createObjectURL` →
 *    preview rápido na timeline.
 * 2. Em background, sobe o arquivo para Firebase Storage (`uploadAsset`).
 * 3. Quando upload completa, atualiza o asset com `storagePath` +
 *    `downloadUrl` reais via `updateAsset`. O blob URL local é revogado.
 * 4. Em erro, marca `status: 'error'` e exibe toast.
 *
 * Fluxo (do Recortes):
 * 1. Abre RecortePickerDialog para o usuário escolher uma pasta/vídeo.
 * 2. Obtém downloadUrl via Firebase Storage.
 * 3. Cria asset com `source: 'firebase'` e `status: 'ready'` direto.
 */

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useEditorStore } from '@/lib/editor/store';
import { EditorIcons } from '../shared/EditorIcons';
import { cn } from '@/lib/utils';
import type { MediaAsset } from '@/lib/editor/types';
import type { Timestamp } from 'firebase/firestore';
import { useFirebase } from '@/firebase/provider';
import { ref as storageRef, getDownloadURL } from 'firebase/storage';
import { useToast } from '@/hooks/use-toast';
import { RecortePickerDialog } from './RecortePickerDialog';
import { useIngestFiles, getMediaDuration } from '@/lib/editor/ingest-files';
import type { RecorteVideo } from '@/lib/types';

export function AssetUploader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [recortePickerOpen, setRecortePickerOpen] = useState(false);
  const addAsset = useEditorStore((s) => s.addAsset);
  const updateAsset = useEditorStore((s) => s.updateAsset);
  const project = useEditorStore((s) => s.project);

  const { storage } = useFirebase();
  const { toast } = useToast();
  const ingest = useIngestFiles();

  const handleRecorteSelect = async (video: RecorteVideo) => {
    if (!project) return;

    const now = {
      seconds: Math.floor(Date.now() / 1000),
      nanoseconds: 0,
    } as unknown as Timestamp;

    const tempId = `asset_recorte_${video.id}_${Date.now().toString(36)}`;
    const placeholderAsset: MediaAsset = {
      id: tempId,
      name: video.name,
      type: 'video',
      source: 'firebase',
      storagePath: video.filePath,
      downloadUrl: '',
      size: video.size ?? 0,
      status: 'uploading',
      uploadProgress: 0,
      createdAt: now,
    };
    addAsset(placeholderAsset);

    try {
      const url = await getDownloadURL(storageRef(storage, video.filePath));
      const duration = await getMediaDuration({ url, type: 'video/mp4' });
      updateAsset(tempId, {
        downloadUrl: url,
        duration,
        status: 'ready',
        uploadProgress: 100,
      });
    } catch (err) {
      console.error('[AssetUploader] erro ao importar recorte:', err);
      updateAsset(tempId, { status: 'error' });
      toast({
        title: 'Erro ao importar recorte',
        description: `Não foi possível carregar "${video.name}". Verifique as permissões de storage.`,
        variant: 'destructive',
      });
    }
  };

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    void ingest(e.target.files);
    // reset para permitir reupload do mesmo arquivo
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      void ingest(e.dataTransfer.files);
    }
  };

  const disabled = !project;

  return (
    <>
      <RecortePickerDialog
        open={recortePickerOpen}
        onOpenChange={setRecortePickerOpen}
        onSelect={handleRecorteSelect}
      />

      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'rounded-[var(--editor-radius-md)] border border-dashed p-3 transition-colors',
          isDragOver
            ? 'border-[var(--editor-accent)] bg-[var(--editor-accent-soft)]'
            : 'border-border',
        )}
      >
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1 gap-2"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <EditorIcons.Upload className="h-4 w-4" />
            Importar
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1 gap-2"
            disabled={disabled}
            onClick={() => setRecortePickerOpen(true)}
          >
            <EditorIcons.Video className="h-4 w-4" />
            Recortes
          </Button>
        </div>
        <p className="mt-2 text-center text-[10px] text-muted-foreground">
          ou arraste arquivos para esta área
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept="video/*,image/*,audio/*"
          onChange={handleFiles}
        />
      </div>
    </>
  );
}
