'use client';

/**
 * Linha vertical do playhead na timeline.
 *
 * - Posicionada em `playhead * zoom` px do começo do "container de tracks".
 * - Inclui um handle (triângulo invertido) no topo, com cursor `grab`,
 *   que permite arrastar para reposicionar o playhead (scrubbing).
 * - Durante o drag, recebe glow accent extra para feedback visual.
 * - O resto do indicator é `pointer-events-none` (não bloqueia clicks na
 *   timeline).
 */

import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '@/lib/editor/store';
import { cn } from '@/lib/utils';

interface PlayheadIndicatorProps {
  /** Zoom px/s. */
  zoom: number;
  className?: string;
}

export function PlayheadIndicator({ zoom, className }: PlayheadIndicatorProps) {
  const playhead = useEditorStore((s) => s.ui.playhead);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const left = playhead * zoom;

  const [isDragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; offsetX: number; container: HTMLElement | null } | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    // O container de referência (área de clips) é o pai do PlayheadIndicator.
    // Subimos no DOM até encontrar um ancestral com posição relativa adequada.
    const container = target.parentElement?.parentElement ?? null;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    dragRef.current = {
      pointerId: e.pointerId,
      offsetX: 0,
      container,
    };
    setDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const c = drag.container;
      if (!c) return;
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const time = Math.max(0, x / zoom);
      setPlayhead(time);
    };
    const handleUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      setDragging(false);
    };
    const handleCancel = () => {
      dragRef.current = null;
      setDragging(false);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };
  }, [isDragging, setPlayhead, zoom]);

  return (
    <div
      className={cn(
        'absolute top-0 bottom-0 z-[var(--editor-z-handles)] w-0',
        className,
      )}
      style={{ left }}
    >
      {/* Linha vertical — pointer events bloqueados para não capturar clicks. */}
      <div
        className="pointer-events-none absolute top-0 bottom-0 w-px"
        style={{
          backgroundColor: 'var(--editor-accent)',
          boxShadow: isDragging
            ? '0 0 6px var(--editor-accent), 0 0 1px var(--editor-accent)'
            : undefined,
        }}
      />
      {/* Handle arrastável no topo (triângulo invertido). */}
      <div
        onPointerDown={handlePointerDown}
        role="slider"
        aria-label="Playhead"
        aria-valuenow={Math.round(playhead * 100) / 100}
        className={cn(
          'absolute -left-2 -top-1 h-3 w-4',
          isDragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
        style={{
          touchAction: 'none',
          // Triângulo "para baixo" + corpo retangular pequeno em cima.
          background: 'var(--editor-accent)',
          clipPath: 'polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)',
          boxShadow: isDragging
            ? '0 0 8px var(--editor-accent)'
            : undefined,
        }}
      />
    </div>
  );
}
