'use client';

/**
 * Item de asset no MediaBin.
 *
 * - Exibe ícone (vídeo/imagem/áudio), nome e badge de status.
 * - É `draggable` — coloca payload em `application/vnd.oficioexpresso.asset`
 *   (mesmo MIME usado pela timeline para aceitar o drop).
 * - Mostra progresso quando `status === 'uploading'`.
 *
 * Não implementa preview na hover ainda (fase de funcionalidades).
 */

import type { MediaAsset } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import { useToast } from '@/hooks/use-toast';
import { EditorIcons } from '../shared/EditorIcons';
import { cn } from '@/lib/utils';

interface AssetItemProps {
  asset: MediaAsset;
}

export function AssetItem({ asset }: AssetItemProps) {
  const project = useEditorStore((s) => s.project);
  const addTrack = useEditorStore((s) => s.addTrack);
  const addClipFromAsset = useEditorStore((s) => s.addClipFromAsset);
  const playhead = useEditorStore((s) => s.ui.playhead);
  const selectedTrackId = useEditorStore((s) => s.ui.selectedTrackId);
  const { toast } = useToast();

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(
      'application/vnd.oficioexpresso.asset',
      JSON.stringify({ id: asset.id, type: asset.type, duration: asset.duration }),
    );
    e.dataTransfer.effectAllowed = 'copy';
  };

  /**
   * Click-to-add: insere o asset na primeira track compatível no playhead.
   * Cria a track se ainda não houver compatível.
   */
  const handleClick = () => {
    if (!project) return;
    if (asset.status !== 'ready') return;
    const needType: 'video' | 'audio' = asset.type === 'audio' ? 'audio' : 'video';
    let target;
    if (needType === 'video' && project.stageMode === 'split-vertical') {
      // Split: cai na track do PALCO selecionado; sem seleção válida, no palco
      // superior por padrão. As tracks de palco sempre existem (estrutura fixa).
      const sel = project.tracks.find(
        (t) => t.id === selectedTrackId && t.type === 'video' && t.stageSlot,
      );
      target =
        sel ??
        project.tracks.find((t) => t.type === 'video' && t.stageSlot === 'top') ??
        project.tracks.find((t) => t.type === 'video');
    } else {
      target = project.tracks.find((t) => t.type === needType);
    }
    if (!target) {
      const newTrackId = addTrack(needType);
      // Após addTrack, o store já tem a nova track. Pega a referência atualizada
      // do snapshot do store no próximo tick.
      const latest = useEditorStore.getState().project;
      target = latest?.tracks.find((t) => t.id === newTrackId);
    }
    if (!target) return;
    const id = addClipFromAsset(asset.id, target.id, playhead);
    if (id) {
      toast({
        title: 'Adicionado à timeline',
        description: `${asset.name} na track ${target.name} (no playhead).`,
      });
    } else {
      toast({
        title: 'Não foi possível adicionar',
        description: 'Verifique se o tipo de asset é compatível com a track.',
        variant: 'destructive',
      });
    }
  };

  const Icon =
    asset.type === 'video'
      ? EditorIcons.Video
      : asset.type === 'image'
        ? EditorIcons.Image
        : EditorIcons.Audio;

  const isUploading = asset.status === 'uploading';
  const isError = asset.status === 'error';

  return (
    <div
      draggable={!isUploading && !isError}
      onDragStart={handleDragStart}
      onClick={!isUploading && !isError ? handleClick : undefined}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !isUploading && !isError) {
          e.preventDefault();
          handleClick();
        }
      }}
      className={cn(
        'group relative flex items-center gap-2 rounded-[var(--editor-radius-md)] p-2',
        'border border-border bg-card',
        'text-sm text-foreground',
        'transition-colors duration-[var(--editor-motion-fast)]',
        !isUploading && !isError && 'cursor-grab hover:bg-muted active:cursor-grabbing',
        isError && 'opacity-60',
      )}
      title={`Clique para adicionar no playhead — ou arraste pra timeline. (${asset.name})`}
    >
      {/* Grip — pista visual de que o item é arrastável (aparece no hover). */}
      {!isUploading && !isError && (
        <EditorIcons.DragHandle
          className={cn(
            'pointer-events-none h-3.5 w-3.5 shrink-0 text-muted-foreground',
            'opacity-0 transition-opacity group-hover:opacity-60',
          )}
        />
      )}

      {/* Thumbnail / ícone */}
      <div
        className={cn(
          'flex h-9 w-12 shrink-0 items-center justify-center overflow-hidden',
          'rounded-[var(--editor-radius-sm)] bg-muted',
        )}
      >
        {asset.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={asset.thumbnailUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <Icon className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      {/* Nome + status */}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium">{asset.name}</span>
        <span className="text-[10px] text-muted-foreground">
          {asset.duration ? `${asset.duration.toFixed(1)}s` : asset.type}
        </span>

        {isUploading && (
          <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-border">
            <div
              className="h-full bg-[var(--editor-accent)] transition-all"
              style={{ width: `${asset.uploadProgress ?? 0}%` }}
            />
          </div>
        )}
      </div>

      {/* Status badge */}
      {isError && (
        <EditorIcons.Error className="h-4 w-4 text-[var(--editor-danger)]" />
      )}
      {isUploading && (
        <EditorIcons.Spinner className="h-4 w-4 animate-spin text-muted-foreground" />
      )}
    </div>
  );
}
