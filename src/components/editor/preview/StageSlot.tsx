'use client';

/**
 * Slot do palco — placeholder visual E drop target.
 *
 * Após o refactor, `StageSlot` não renderiza mais o conteúdo do clip — isso
 * é feito por `VideoLayer` / `ImageLayer` em `PreviewStage`. Este componente
 * mostra a "moldura" de placeholder quando aquele slot está vazio e ACEITA
 * drop de mídia (da biblioteca/MediaBin OU arquivo do SO):
 *
 * - `slot === 'full'` → placeholder centralizado.
 * - `slot === 'top' | 'bottom'` → ocupa metade do palco (altura via CSS).
 *
 * Comportamento do drop (casado com o padrão da timeline — mesmo MIME
 * `application/vnd.oficioexpresso.asset` e a action do store):
 * - Soltar um asset da biblioteca → `addClipToSlot(assetId, slot)`, que
 *   garante o modo split-vertical + as DUAS tracks de vídeo (superior e
 *   inferior) e encaixa o vídeo AJUSTADO dentro do limite da camada.
 * - Soltar um arquivo do SO → cria um asset local-blob e adiciona no slot.
 *
 * Mensagem: "Slot superior/inferior — arraste mídia aqui" + ícone.
 */

import { useState } from 'react';
import { EditorIcons } from '../shared/EditorIcons';
import { useEditorStore } from '@/lib/editor/store';
import { useToast } from '@/hooks/use-toast';
import { useIngestFiles, mediaTypeOf } from '@/lib/editor/ingest-files';
import { cn } from '@/lib/utils';

/** MIME usado pela biblioteca/MediaBin (mesmo da timeline). */
const ASSET_MIME = 'application/vnd.oficioexpresso.asset';

interface StageSlotProps {
  slot: 'full' | 'top' | 'bottom';
  className?: string;
}

export function StageSlot({ slot, className }: StageSlotProps) {
  const addClipToSlot = useEditorStore((s) => s.addClipToSlot);
  const project = useEditorStore((s) => s.project);
  const { toast } = useToast();
  const ingest = useIngestFiles();

  const [isDragOver, setIsDragOver] = useState(false);

  const label =
    slot === 'top'
      ? 'Slot superior — arraste mídia aqui'
      : slot === 'bottom'
        ? 'Slot inferior — arraste mídia aqui'
        : 'Arraste mídia aqui';

  /** Aceita drop tanto de asset da biblioteca quanto de arquivo do SO. */
  const canAccept = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    return types.includes(ASSET_MIME) || types.includes('Files');
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!canAccept(e)) return;
    // preventDefault no dragOver é OBRIGATÓRIO para que o `drop` dispare.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!canAccept(e)) return;
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Só limpa quando sai do próprio elemento (ignora bolhas de filhos).
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    if (!canAccept(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (!project) return;

    // 1) Drop de asset da biblioteca (caminho principal).
    const assetData = e.dataTransfer.getData(ASSET_MIME);
    if (assetData) {
      try {
        const payload = JSON.parse(assetData) as { id: string; type?: string };
        if (payload.type === 'audio') {
          toast({
            title: 'Áudio não vai no palco',
            description: 'Arraste áudios para uma track de áudio na timeline.',
            variant: 'destructive',
          });
          return;
        }
        const id = addClipToSlot(payload.id, slot);
        if (!id) {
          toast({
            title: 'Não foi possível adicionar',
            description: 'Verifique se a mídia é compatível com o palco.',
            variant: 'destructive',
          });
        }
      } catch {
        // payload inválido — ignora
      }
      return;
    }

    // 2) Drop de arquivo do SO → ingere (upload em background) e encaixa.
    const file = e.dataTransfer.files[0];
    if (file) {
      const kind = mediaTypeOf(file);
      if (kind !== 'video' && kind !== 'image') {
        toast({
          title: 'Tipo não suportado no palco',
          description: 'Solte um arquivo de vídeo ou imagem.',
          variant: 'destructive',
        });
        return;
      }
      const [asset] = await ingest([file]);
      if (asset) addClipToSlot(asset.id, slot);
    }
  };

  return (
    <div
      data-slot={slot}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'relative overflow-hidden bg-[hsl(var(--editor-stage))]',
        className,
      )}
    >
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-2',
          'border border-dashed transition-colors',
          'pointer-events-none', // deixa os eventos de drag chegarem ao pai
          isDragOver
            ? 'border-[var(--editor-accent)] bg-[var(--editor-accent-soft)] text-[var(--editor-accent)]'
            : 'border-border text-muted-foreground',
        )}
      >
        <EditorIcons.Video className="h-8 w-8 opacity-40" />
        <span className="text-xs">{label}</span>
      </div>
    </div>
  );
}
