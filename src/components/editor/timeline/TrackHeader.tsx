'use client';

/**
 * Header (lateral esquerda) de uma track na timeline.
 *
 * Mostra:
 * - Nome da track (V1, V2, A1, …) — clicar seleciona.
 * - Botões: visível, mute, lock.
 *
 * O componente **não** controla largura; o pai (`TimelineTrack`) escolhe.
 */

import { useRef } from 'react';
import type { Track } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import { trackLayerCount } from '@/lib/editor/preview-utils';
import { useIngestFiles, mediaTypeOf } from '@/lib/editor/ingest-files';
import { useToast } from '@/hooks/use-toast';
import { EditorIcons } from '../shared/EditorIcons';
import { cn } from '@/lib/utils';

interface TrackHeaderProps {
  track: Track;
  selected: boolean;
}

/** Seleciona a cor lateral da track conforme tipo + index. */
function trackAccent(track: Track): string {
  if (track.type === 'video') {
    if (track.index === 0) return 'var(--editor-track-v1)';
    if (track.index === 1) return 'var(--editor-track-v2)';
    return 'var(--editor-track-v3)';
  }
  if (track.index === 0) return 'var(--editor-track-a1)';
  if (track.index === 1) return 'var(--editor-track-a2)';
  return 'var(--editor-track-a3)';
}

export function TrackHeader({ track, selected }: TrackHeaderProps) {
  const selectTrack = useEditorStore((s) => s.selectTrack);
  const toggleMute = useEditorStore((s) => s.toggleTrackMute);
  const setLocked = useEditorStore((s) => s.setTrackLocked);
  const setVisible = useEditorStore((s) => s.setTrackVisible);
  const addSubtrack = useEditorStore((s) => s.addSubtrack);
  const removeSubtrack = useEditorStore((s) => s.removeSubtrack);
  const addClipFromAsset = useEditorStore((s) => s.addClipFromAsset);
  const ingest = useIngestFiles();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Camadas (subtracks) só existem em tracks de vídeo.
  const layerCount = trackLayerCount(track);
  const isVideo = track.type === 'video';

  /** Insere arquivos do SO nesta track, no playhead atual. */
  const handlePickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    e.target.value = ''; // permite repicar o mesmo arquivo
    if (!files || files.length === 0) return;
    const playhead = useEditorStore.getState().ui.playhead;
    for (const file of Array.from(files)) {
      const kind = mediaTypeOf(file);
      const ok =
        track.type === 'audio'
          ? kind === 'audio'
          : kind === 'video' || kind === 'image';
      if (!ok) {
        toast({
          title: 'Tipo incompatível com a track',
          description:
            track.type === 'audio'
              ? `"${file.name}" não é áudio.`
              : `"${file.name}" não é vídeo/imagem.`,
          variant: 'destructive',
        });
        continue;
      }
      const [asset] = await ingest([file]);
      if (asset) addClipFromAsset(asset.id, track.id, playhead);
    }
  };

  return (
    <div
      onClick={() => selectTrack(track.id)}
      className={cn(
        'flex h-full w-24 shrink-0 cursor-pointer items-center gap-1 px-2',
        'border-b border-border',
        selected
          ? 'bg-muted'
          : 'bg-card hover:bg-muted',
      )}
      style={{ height: track.height }}
    >
      {/* Faixa colorida */}
      <div
        className="h-6 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: trackAccent(track) }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[11px] font-medium text-foreground">
          {track.name}
        </span>
        {/* Controle de CAMADAS (subtracks) — só vídeo. */}
        {isVideo && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                addSubtrack(track.id);
              }}
              title="Adicionar camada (subtrack) por cima"
              disabled={track.locked}
              className={cn(
                'flex h-3.5 w-3.5 items-center justify-center rounded-[var(--editor-radius-sm)]',
                'text-muted-foreground hover:bg-border hover:text-foreground',
                'disabled:opacity-40',
              )}
            >
              <EditorIcons.Plus className="h-2.5 w-2.5" />
            </button>
            <span
              className="text-[9px] tabular-nums text-muted-foreground"
              title={`${layerCount} camada(s)`}
            >
              {layerCount > 1 ? `${layerCount} camadas` : '1 camada'}
            </span>
            {layerCount > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  // Remove a camada do TOPO (índice maior).
                  removeSubtrack(track.id, layerCount - 1);
                }}
                title="Remover a camada de cima (e seus clips)"
                disabled={track.locked}
                className={cn(
                  'flex h-3.5 w-3.5 items-center justify-center rounded-[var(--editor-radius-sm)]',
                  'text-muted-foreground hover:bg-border hover:text-foreground',
                  'disabled:opacity-40',
                )}
              >
                <EditorIcons.Minus className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-0.5">
        {/* Adicionar mídia direto nesta track (atalho de inclusão). */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept={track.type === 'audio' ? 'audio/*' : 'video/*,image/*'}
          onChange={handlePickFiles}
        />
        <IconBtn
          active
          onClick={(e) => {
            e.stopPropagation();
            if (track.locked) return;
            fileInputRef.current?.click();
          }}
          title={
            track.locked
              ? 'Track travada'
              : track.type === 'audio'
                ? 'Adicionar áudio nesta track'
                : 'Adicionar mídia nesta track'
          }
        >
          <EditorIcons.Plus
            className={cn('h-3 w-3', track.locked && 'opacity-40')}
          />
        </IconBtn>

        <IconBtn
          active={track.visible}
          onClick={(e) => {
            e.stopPropagation();
            setVisible(track.id, !track.visible);
          }}
          title={track.visible ? 'Ocultar' : 'Mostrar'}
        >
          {track.visible ? (
            <EditorIcons.Eye className="h-3 w-3" />
          ) : (
            <EditorIcons.EyeOff className="h-3 w-3" />
          )}
        </IconBtn>

        <IconBtn
          active={!track.muted}
          onClick={(e) => {
            e.stopPropagation();
            toggleMute(track.id);
          }}
          title={track.muted ? 'Desmutar' : 'Mutar'}
        >
          {track.muted ? (
            <EditorIcons.VolumeOff className="h-3 w-3" />
          ) : (
            <EditorIcons.VolumeOn className="h-3 w-3" />
          )}
        </IconBtn>

        <IconBtn
          active={!track.locked}
          onClick={(e) => {
            e.stopPropagation();
            setLocked(track.id, !track.locked);
          }}
          title={track.locked ? 'Destravar' : 'Travar'}
        >
          {track.locked ? (
            <EditorIcons.Lock className="h-3 w-3" />
          ) : (
            <EditorIcons.Unlock className="h-3 w-3" />
          )}
        </IconBtn>
      </div>
    </div>
  );
}

function IconBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded-[var(--editor-radius-sm)]',
        'transition-colors duration-[var(--editor-motion-fast)]',
        active
          ? 'text-foreground hover:bg-border'
          : 'text-muted-foreground hover:bg-border',
      )}
    >
      {children}
    </button>
  );
}
