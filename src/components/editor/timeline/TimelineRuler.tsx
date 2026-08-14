'use client';

/**
 * Régua de tempo da timeline.
 *
 * - Mostra ticks principais a cada 1s, 2s, 5s, 10s, 30s ou 60s, conforme zoom.
 * - Click → setPlayhead(t).
 * - PointerDown + Move → scrubbing contínuo (atualiza playhead enquanto
 *   arrasta).
 *
 * Mantém-se simples; cálculos detalhados (frame-accurate) virão na fase de
 * playback (com `frameRate`).
 */

import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '@/lib/editor/store';
import { cn } from '@/lib/utils';

interface TimelineRulerProps {
  /** Largura em px do conteúdo da timeline (= duration * zoom). */
  contentWidth: number;
  /** Duração em segundos. */
  duration: number;
  /** Zoom em px/s. */
  zoom: number;
}

function pickTickInterval(zoom: number): number {
  if (zoom >= 100) return 1;
  if (zoom >= 40) return 2;
  if (zoom >= 20) return 5;
  if (zoom >= 8) return 10;
  if (zoom >= 4) return 30;
  return 60;
}

function formatTick(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function TimelineRuler({ contentWidth, duration, zoom }: TimelineRulerProps) {
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const tickEvery = pickTickInterval(zoom);

  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += tickEvery) {
    ticks.push(t);
  }

  const ref = useRef<HTMLDivElement | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const pointerIdRef = useRef<number | null>(null);

  const seekFromClient = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    setPlayhead(Math.max(0, x / zoom));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    pointerIdRef.current = e.pointerId;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setScrubbing(true);
    seekFromClient(e.clientX);
  };

  useEffect(() => {
    if (!scrubbing) return;
    const handleMove = (e: PointerEvent) => {
      if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) return;
      seekFromClient(e.clientX);
    };
    const handleUp = (e: PointerEvent) => {
      if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) return;
      pointerIdRef.current = null;
      setScrubbing(false);
    };
    const handleCancel = () => {
      pointerIdRef.current = null;
      setScrubbing(false);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing, zoom]);

  // Decisão de label: tick principal a cada 5x o intervalo (visualmente fica
  // um label a cada 5s/10s/30s dependendo do zoom — coerente com a spec).
  const labelEvery = tickEvery * 5;

  return (
    <div
      ref={ref}
      onPointerDown={handlePointerDown}
      className={cn(
        'relative h-7 shrink-0 cursor-pointer select-none',
        'border-b border-border bg-background',
        scrubbing && 'cursor-grabbing',
      )}
      style={{ width: contentWidth, touchAction: 'none' }}
    >
      {ticks.map((t) => {
        const isMajor = t % labelEvery === 0;
        return (
          <div
            key={t}
            className="pointer-events-none absolute top-0 flex h-full flex-col items-start"
            style={{ left: t * zoom }}
          >
            <div
              className={cn(
                'w-px',
                isMajor
                  ? 'h-3 bg-muted-foreground'
                  : 'h-1.5 bg-muted-foreground/50',
              )}
            />
            {isMajor && (
              <span className="mt-0.5 select-none pl-1 font-mono text-[9px] text-muted-foreground">
                {formatTick(t)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
