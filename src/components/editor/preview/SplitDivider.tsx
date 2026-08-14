'use client';

/**
 * Divisor entre os dois slots quando `stageMode === 'split-vertical'`.
 *
 * Exibe uma linha horizontal posicionada em `ratio * 100%` do topo.
 * Suporta drag para ajustar `splitRatio` (clamp já feito no store).
 *
 * Esta versão (refactor) implementa o drag básico via pointer events.
 */

import { useCallback, useRef } from 'react';
import { useEditorStore } from '@/lib/editor/store';
import { cn } from '@/lib/utils';

interface SplitDividerProps {
  /** 0 - 1, posição vertical do divisor. */
  ratio: number;
  /** Ref do container do palco para calcular drag relativo. */
  stageRef: React.RefObject<HTMLDivElement>;
  className?: string;
}

export function SplitDivider({ ratio, stageRef, className }: SplitDividerProps) {
  const setSplitRatio = useEditorStore((s) => s.setSplitRatio);
  const draggingRef = useRef(false);

  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current || !stageRef.current) return;
      const rect = stageRef.current.getBoundingClientRect();
      const newRatio = (e.clientY - rect.top) / rect.height;
      setSplitRatio(newRatio);
    },
    [setSplitRatio, stageRef],
  );

  const handlePointerUp = useCallback(() => {
    draggingRef.current = false;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  }, [handlePointerMove]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  return (
    <div
      onPointerDown={handlePointerDown}
      className={cn(
        'absolute left-0 right-0 z-10 h-1 -translate-y-1/2 cursor-row-resize',
        'bg-[var(--editor-accent)] opacity-50 hover:opacity-100',
        'transition-opacity duration-[var(--editor-motion-fast)]',
        // Hitbox expandida (±10px) p/ toque confortável no iPad — a linha
        // visível continua com 1px, mas a área clicável fica ~21px.
        "before:absolute before:-inset-y-[10px] before:left-0 before:right-0 before:content-['']",
        className,
      )}
      // touch-action:none impede o iOS de interpretar o arraste como rolagem
      // (sem isso o gesto é "roubado" e o divisor não se mexe no tablet).
      style={{ top: `${ratio * 100}%`, touchAction: 'none' }}
      title="Arraste para ajustar a divisão"
    />
  );
}
