'use client';

/**
 * Régua de tempo da timeline.
 *
 * - Mostra ticks principais a cada 1s, 2s, 5s, 10s, 30s ou 60s, conforme zoom.
 * - Click → setPlayhead(t).
 * - SHIFT + arrastar → marca um TRECHO na régua (recurso 17). O trecho vira
 *   o `loopRange` do editor: o play repete só ele e o botão "Prévia do
 *   trecho" renderiza só ele em 480p. O × na faixa desmarca.
 * - AVISO DE FLASH (recurso 18): marca em vermelho todo buraco de menos de
 *   0,5s entre dois overlays vizinhos — o ponto onde a base aparece só um
 *   instante e o vídeo "pisca". Clicar leva o playhead até lá. É a mesma
 *   regra que o verificador pré-export aplica, só que AO VIVO.
 * - PointerDown + Move → scrubbing contínuo (atualiza playhead enquanto
 *   arrasta).
 *
 * Mantém-se simples; cálculos detalhados (frame-accurate) virão na fase de
 * playback (com `frameRate`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '@/lib/editor/store';
import { detectFlashes } from '@/lib/editor/preflight';
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
  const tracks = useEditorStore((s) => s.project?.tracks);
  const tickEvery = pickTickInterval(zoom);

  // Flashes AO VIVO (recurso 18). Recalcula só quando as tracks mudam.
  const flashes = useMemo(
    () => (tracks ? detectFlashes({ tracks }) : []),
    [tracks],
  );

  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += tickEvery) {
    ticks.push(t);
  }

  const ref = useRef<HTMLDivElement | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const pointerIdRef = useRef<number | null>(null);

  // Marcação de TRECHO (Shift + arrastar).
  const setLoopRange = useEditorStore((s) => s.setLoopRange);
  const loopRange = useEditorStore((s) => s.ui.loopRange);
  const [marcando, setMarcando] = useState<number | null>(null);

  const tempoEm = (clientX: number): number => {
    const el = ref.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - rect.left) / zoom));
  };

  const seekFromClient = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    setPlayhead(Math.max(0, x / zoom));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Shift + arrastar marca o trecho em vez de mover o playhead.
    if (e.shiftKey) {
      const t = tempoEm(e.clientX);
      setMarcando(t);
      setLoopRange({ start: t, end: t });
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      pointerIdRef.current = e.pointerId;
      return;
    }
    pointerIdRef.current = e.pointerId;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setScrubbing(true);
    seekFromClient(e.clientX);
  };

  // Arrasto da marcação de trecho.
  useEffect(() => {
    if (marcando === null) return;
    const handleMove = (e: PointerEvent) => {
      const t = tempoEm(e.clientX);
      setLoopRange({
        start: Math.min(marcando, t),
        end: Math.max(marcando, t),
      });
    };
    const handleUp = (e: PointerEvent) => {
      const t = tempoEm(e.clientX);
      const start = Math.min(marcando, t);
      const end = Math.max(marcando, t);
      // Shift+clique sem arrastar = desmarca (não deixa trecho de 0s).
      setLoopRange(end - start < 0.05 ? null : { start, end });
      setMarcando(null);
      pointerIdRef.current = null;
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marcando, zoom, duration]);

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

      {/* TRECHO marcado (recurso 17): faixa translúcida + botão de desmarcar. */}
      {loopRange && loopRange.end > loopRange.start && (
        <div
          className="pointer-events-none absolute bottom-0 top-0 border-x border-[var(--editor-accent)] bg-[var(--editor-accent)]/20"
          style={{
            left: loopRange.start * zoom,
            width: (loopRange.end - loopRange.start) * zoom,
          }}
          title={`Trecho marcado: ${(loopRange.end - loopRange.start).toFixed(1)}s`}
        >
          <button
            type="button"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setLoopRange(null);
            }}
            className="pointer-events-auto absolute right-0 top-0 px-1 text-[9px] leading-4 text-[var(--editor-accent)] hover:text-foreground"
            title="Desmarcar o trecho"
          >
            ×
          </button>
        </div>
      )}

      {/* Avisos de FLASH: a base pisca entre dois overlays (recurso 18). */}
      {flashes.map((f) => (
        <button
          key={`flash_${f.at.toFixed(3)}`}
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setPlayhead(Math.max(0, f.at));
          }}
          title={`A base pisca aqui: ${(f.gap * 1000).toFixed(0)} ms de buraco entre dois criativos. Feche o buraco ou espace de vez. Clique para ir ao ponto.`}
          className={cn(
            'absolute top-0 z-10 flex h-4 min-w-[14px] -translate-x-1/2 items-center justify-center',
            'rounded-b-[3px] bg-red-600 px-0.5 text-[8px] font-bold leading-none text-white',
            'hover:bg-red-500',
          )}
          style={{ left: f.at * zoom }}
        >
          !
        </button>
      ))}
    </div>
  );
}
