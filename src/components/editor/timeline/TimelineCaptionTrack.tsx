'use client';

/**
 * Track especial de legendas na timeline.
 *
 * Estrutura visual:
 * - Header lateral (similar a `TrackHeader` mas com cor `--editor-track-cc`).
 * - Área de cues: cada cue vira um bloquinho retangular pequeno com texto
 *   truncado.
 * - Click num bloco: seleciona cue, move playhead para `cue.startTime` e
 *   abre o `CaptionsDrawer` (via `useCaptionsDrawer().openWithCue`).
 * - Drag horizontal: move o cue (`moveCaption`).
 * - Trim das duas pontas: 6px nas bordas, ajusta `startTime`/`endTime`
 *   (`resizeCaption`).
 *
 * Diferente das `TimelineTrack` de mídia: caption tracks não recebem drop
 * de assets, e não têm transições/keyframes.
 */

import * as React from 'react';
import type { CaptionTrack, CaptionCue } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import { useCaptionsDrawer } from '../captions/useCaptionsDrawer';
import { isInvalidCue } from '@/lib/editor/captions/utils';
import { EditorIcons } from '../shared/EditorIcons';
import { cn } from '@/lib/utils';
import { Type as TypeIcon, Trash2 } from 'lucide-react';

const TRACK_HEADER_WIDTH = 96;

interface TimelineCaptionTrackProps {
  track: CaptionTrack;
  zoom: number;
  contentWidth: number;
  /** Altura em px (default 36 — menor que clip tracks). */
  height?: number;
}

export function TimelineCaptionTrack({
  track,
  zoom,
  contentWidth,
  height = 36,
}: TimelineCaptionTrackProps) {
  const setCaptionTrackVisible = useEditorStore(
    (s) => s.setCaptionTrackVisible,
  );
  const setCaptionTrackLocked = useEditorStore(
    (s) => s.setCaptionTrackLocked,
  );
  const removeCaptionTrack = useEditorStore((s) => s.removeCaptionTrack);
  const openDrawer = useCaptionsDrawer((s) => s.openWithCue);

  return (
    <div className="flex shrink-0">
      {/* Header */}
      <div
        className={cn(
          'flex w-24 shrink-0 items-center gap-1 px-2',
          'border-b border-border',
          'bg-card hover:bg-muted',
        )}
        style={{ height, width: TRACK_HEADER_WIDTH }}
      >
        <div
          className="h-5 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: 'var(--editor-track-cc)' }}
        />
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <TypeIcon
            className="h-3 w-3 shrink-0"
            style={{ color: 'var(--editor-track-cc)' }}
          />
          <span className="truncate text-[10px] font-medium text-foreground">
            {track.name}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <IconBtn
            active={track.visible}
            onClick={(e) => {
              e.stopPropagation();
              setCaptionTrackVisible(track.id, !track.visible);
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
            active={!track.locked}
            onClick={(e) => {
              e.stopPropagation();
              setCaptionTrackLocked(track.id, !track.locked);
            }}
            title={track.locked ? 'Destravar' : 'Travar'}
          >
            {track.locked ? (
              <EditorIcons.Lock className="h-3 w-3" />
            ) : (
              <EditorIcons.Unlock className="h-3 w-3" />
            )}
          </IconBtn>
          <IconBtn
            active
            onClick={(e) => {
              e.stopPropagation();
              if (
                window.confirm(
                  `Excluir a track "${track.name}" e suas ${track.cues.length} cues?`,
                )
              ) {
                removeCaptionTrack(track.id);
              }
            }}
            title="Excluir track"
          >
            <Trash2 className="h-3 w-3" />
          </IconBtn>
        </div>
      </div>

      {/* Área de cues */}
      <div
        data-caption-track-id={track.id}
        className={cn(
          'relative shrink-0 border-b border-border',
          'bg-background',
        )}
        style={{ width: contentWidth, height }}
      >
        {track.cues.map((cue) => (
          <CaptionCueBlock
            key={cue.id}
            cue={cue}
            zoom={zoom}
            locked={track.locked}
            onOpen={() => openDrawer(cue.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// CaptionCueBlock — bloco interativo
// ============================================================================

interface CaptionCueBlockProps {
  cue: CaptionCue;
  zoom: number;
  locked: boolean;
  onOpen: () => void;
}

type DragMode = 'move' | 'trim-left' | 'trim-right';

function CaptionCueBlock({
  cue,
  zoom,
  locked,
  onOpen,
}: CaptionCueBlockProps) {
  const moveCaption = useEditorStore((s) => s.moveCaption);
  const resizeCaption = useEditorStore((s) => s.resizeCaption);
  const selectCue = useEditorStore((s) => s.selectCue);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const selectedCueIds = useEditorStore((s) => s.ui.selectedCueIds);

  const [drag, setDrag] = React.useState<{
    mode: DragMode;
    startX: number;
    initialStart: number;
    initialEnd: number;
    previewStart: number;
    previewEnd: number;
  } | null>(null);

  const baseLeft = cue.startTime * zoom;
  const baseWidth = Math.max(2, (cue.endTime - cue.startTime) * zoom);

  // Renderização: usa preview enquanto drag.
  let left = baseLeft;
  let width = baseWidth;
  if (drag) {
    if (drag.mode === 'move') {
      left = drag.previewStart * zoom;
      width = (drag.previewEnd - drag.previewStart) * zoom;
    } else if (drag.mode === 'trim-left') {
      left = drag.previewStart * zoom;
      width = (drag.previewEnd - drag.previewStart) * zoom;
    } else {
      width = (drag.previewEnd - drag.previewStart) * zoom;
    }
  }
  width = Math.max(2, width);

  const selected = selectedCueIds.includes(cue.id);
  const invalid = isInvalidCue(cue);

  const startDrag = (
    e: React.PointerEvent,
    mode: DragMode,
  ) => {
    if (locked) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;

    setDrag({
      mode,
      startX,
      initialStart: cue.startTime,
      initialEnd: cue.endTime,
      previewStart: cue.startTime,
      previewEnd: cue.endTime,
    });

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const deltaSec = dx / zoom;
      setDrag((prev) => {
        if (!prev) return prev;
        if (prev.mode === 'move') {
          const ns = Math.max(0, prev.initialStart + deltaSec);
          const dur = prev.initialEnd - prev.initialStart;
          return { ...prev, previewStart: ns, previewEnd: ns + dur };
        }
        if (prev.mode === 'trim-left') {
          const ns = Math.max(
            0,
            Math.min(prev.initialEnd - 0.1, prev.initialStart + deltaSec),
          );
          return { ...prev, previewStart: ns };
        }
        // trim-right
        const ne = Math.max(prev.initialStart + 0.1, prev.initialEnd + deltaSec);
        return { ...prev, previewEnd: ne };
      });
    };

    const onUp = () => {
      setDrag((prev) => {
        if (prev) {
          if (prev.mode === 'move') {
            if (prev.previewStart !== prev.initialStart) {
              moveCaption(cue.id, prev.previewStart);
            }
          } else if (prev.mode === 'trim-left') {
            if (prev.previewStart !== prev.initialStart) {
              resizeCaption(cue.id, 'left', prev.previewStart);
            }
          } else {
            if (prev.previewEnd !== prev.initialEnd) {
              resizeCaption(cue.id, 'right', prev.previewEnd);
            }
          }
        }
        return null;
      });
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (drag) return;
    selectCue(cue.id);
    setPlayhead(cue.startTime);
    onOpen();
  };

  return (
    <div
      data-cue-id={cue.id}
      onClick={handleClick}
      onPointerDown={(e) => {
        // Click body inicia move; bordas (handles) tratam separadamente.
        if (e.button !== 0) return;
        startDrag(e, 'move');
      }}
      className={cn(
        'absolute top-1 bottom-1 cursor-grab overflow-hidden rounded-[var(--editor-radius-xs)]',
        'select-none border-l-[3px]',
        invalid
          ? 'border-l-[var(--editor-danger)] bg-[hsla(0,80%,50%,0.15)]'
          : selected
            ? 'border-l-[var(--editor-accent-strong)] bg-[hsla(280,70%,60%,0.30)]'
            : 'border-l-[var(--editor-track-cc)] bg-[hsla(280,70%,60%,0.20)] hover:bg-[hsla(280,70%,60%,0.30)]',
        drag && 'cursor-grabbing opacity-80',
      )}
      style={{
        left,
        width,
        boxShadow: selected
          ? 'var(--editor-glow-selected)'
          : drag
            ? '0 0 0 1px var(--editor-track-cc)'
            : undefined,
        touchAction: 'none',
      }}
      title={cue.text || '(legenda vazia)'}
    >
      <div className="flex h-full items-center px-1.5">
        <span className="truncate text-[10px] text-foreground">
          {cue.text.split('\n')[0] || '∅'}
        </span>
      </div>

      {/* Handles de trim */}
      {!locked && (
        <>
          <div
            data-cue-handle="left"
            onPointerDown={(e) => startDrag(e, 'trim-left')}
            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-[var(--editor-accent-soft)]"
            style={{ touchAction: 'none' }}
          />
          <div
            data-cue-handle="right"
            onPointerDown={(e) => startDrag(e, 'trim-right')}
            className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-[var(--editor-accent-soft)]"
            style={{ touchAction: 'none' }}
          />
        </>
      )}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

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
        'flex h-4 w-4 items-center justify-center rounded-[var(--editor-radius-sm)]',
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
