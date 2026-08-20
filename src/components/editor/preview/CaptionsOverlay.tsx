'use client';

/**
 * Overlay de legendas no `PreviewStage`.
 *
 * Renderiza, para cada `CaptionTrack` visível, o(s) cue(s) ativo(s) no
 * playhead atual, posicionados absolutamente sobre o palco.
 *
 * Convenções:
 * - `pointer-events-none`: legendas nunca bloqueiam clicks no preview.
 * - Tamanho: o `fontSize` do cue é em px @ 1080p; aqui escalamos pela
 *   altura real renderizada do stage (medida via `ResizeObserver` no
 *   container pai). Como esse componente recebe os dados do store mas não
 *   conhece a altura, usamos `useStageHeight()` baseado em ref.
 * - Posição: `style.position` = top | center | bottom → flexbox align.
 * - Cor de fundo (`backgroundColor`) já vem com alpha hex (`#000000B3`).
 * - Multi-line: `\n` no texto vira `<br/>`.
 *
 * Sobreposição: se múltiplos cues forem ativos no mesmo instante (mesma
 * track ou tracks diferentes), todos renderizam — o último por cima.
 */

import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '@/lib/editor/store';
import { findActiveCues, isInvalidCue } from '@/lib/editor/captions/utils';
import { effectiveSlot } from '@/lib/editor/preview-utils';
import type { CaptionCue, CaptionStyle } from '@/lib/editor/types';

/**
 * Hook simples: observa altura do `ref.current` (em px). Default 1080 antes
 * de medir (assim o estilo padrão @1080 é "1:1"). Usa `ResizeObserver`.
 */
function useElementSize(): {
  ref: React.RefObject<HTMLDivElement>;
  width: number;
  height: number;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: 1920,
    height: 1080,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize({ width: r.width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width: size.width, height: size.height };
}

interface CaptionsOverlayProps {
  /**
   * Quando renderizado dentro de um stage com `splitRatio`, podemos passar
   * para que slots `top`/`bottom` se posicionem corretamente. Default 0.5.
   */
  splitRatio?: number;
  /** Modo do palco (afeta como interpretar o slot do cue). */
  stageMode?: 'single' | 'split-vertical';
}

export function CaptionsOverlay({
  splitRatio = 0.5,
  stageMode = 'single',
}: CaptionsOverlayProps) {
  const captionTracks = useEditorStore(
    (s) => s.project?.captionTracks ?? [],
  );
  const playhead = useEditorStore((s) => s.ui.playhead);

  const { ref, height } = useElementSize();

  // Para cada track visível, pega cues ativos.
  const activeEntries = captionTracks
    .filter((t) => t.visible)
    .flatMap((t) =>
      findActiveCues(t.cues, playhead).map((c) => ({ cue: c, trackId: t.id })),
    )
    .filter((e) => !isInvalidCue(e.cue));

  // Escala (pixel font @1080 → px no preview real).
  const scale = height > 0 ? height / 1080 : 1;

  return (
    <div
      ref={ref}
      data-component="captions-overlay"
      className="pointer-events-none absolute inset-0 z-[var(--editor-z-clip-selected)] overflow-hidden"
    >
      {activeEntries.map(({ cue, trackId }) => (
        <CueView
          key={`${trackId}_${cue.id}`}
          cue={cue}
          scale={scale}
          stageMode={stageMode}
          splitRatio={splitRatio}
        />
      ))}
    </div>
  );
}

// ============================================================================
// CueView
// ============================================================================

interface CueViewProps {
  cue: CaptionCue;
  scale: number;
  stageMode: 'single' | 'split-vertical';
  splitRatio: number;
}

function CueView({ cue, scale, stageMode, splitRatio }: CueViewProps) {
  const slot = effectiveSlot(cue.slot, stageMode);
  const style = cue.style;

  // Slot-aware bounds (top/bottom no split-vertical).
  const slotStyle = computeSlotStyle(slot, splitRatio);

  // Justify do flex baseado em `position` (top/center/bottom).
  const justify =
    style.position === 'top'
      ? 'flex-start'
      : style.position === 'center'
        ? 'center'
        : 'flex-end';

  // Align (texto): left/center/right.
  const textAlign = style.align;

  // offsetY: ajuste fino em % da altura (- pra cima, + pra baixo).
  const offsetPct = Math.max(-50, Math.min(50, style.offsetY ?? 0));

  return (
    <div
      style={{
        position: 'absolute',
        ...slotStyle,
        display: 'flex',
        justifyContent: 'center',
        alignItems: justify,
        padding: `${24 * scale}px`,
        transform: offsetPct !== 0 ? `translateY(${offsetPct}%)` : undefined,
      }}
    >
      <div
        // `key` no id do cue: trocar de cue remonta o nó e a animação de
        // entrada roda de novo (senão o CSS só animaria a primeira legenda).
        key={cue.id}
        data-anim={style.animation ?? 'none'}
        className={animClassName(style.animation)}
        style={cssForCueText(style, scale)}
        // Multi-line: \n vira <br/> via CSS white-space pre-line.
      >
        {cue.text.split('\n').map((line, i, arr) => (
          <span key={i}>
            {line}
            {i < arr.length - 1 ? <br /> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Classe da ANIMAÇÃO de entrada no preview (recurso 12). Espelha o que o
 * export queima no ASS: `fade` = fade-in de 100 ms; `pop` = o mesmo fade
 * com um crescimento de 70% para 100% em 140 ms.
 */
function animClassName(anim: CaptionStyle['animation']): string | undefined {
  if (anim === 'fade') return 'editor-cue-fade';
  if (anim === 'pop') return 'editor-cue-pop';
  return undefined;
}

function computeSlotStyle(
  slot: 'full' | 'top' | 'bottom',
  splitRatio: number,
): React.CSSProperties {
  if (slot === 'full') {
    return { left: 0, right: 0, top: 0, bottom: 0 };
  }
  const safe = Math.max(0.05, Math.min(0.95, splitRatio));
  const pct = safe * 100;
  if (slot === 'top') {
    return { left: 0, right: 0, top: 0, height: `${pct}%` };
  }
  return { left: 0, right: 0, bottom: 0, height: `${100 - pct}%` };
}

function cssForCueText(
  style: CaptionStyle,
  scale: number,
): React.CSSProperties {
  // Campos aditivos opcionais (fallback p/ cues antigos sem eles).
  const maxWidthPct = clampNum(style.maxWidthPct, 10, 100, 88);
  const lineHeight = clampNum(style.lineHeight, 0.8, 2.5, 1.25);
  const letterSpacing = style.letterSpacing ?? 0;

  return {
    fontFamily: style.fontFamily,
    fontSize: `${style.fontSize * scale}px`,
    fontWeight: style.fontWeight,
    color: style.color,
    backgroundColor: style.backgroundColor,
    textAlign: style.align,
    paddingLeft: `${style.paddingX * scale}px`,
    paddingRight: `${style.paddingX * scale}px`,
    paddingTop: `${style.paddingY * scale}px`,
    paddingBottom: `${style.paddingY * scale}px`,
    borderRadius: `${style.borderRadius * scale}px`,
    maxWidth: `${maxWidthPct}%`,
    lineHeight,
    letterSpacing:
      letterSpacing !== 0 ? `${letterSpacing * scale}px` : undefined,
    textTransform: style.textTransform === 'uppercase' ? 'uppercase' : undefined,
    whiteSpace: 'pre-line',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
    textShadow:
      style.shadowColor && style.shadowBlur
        ? `0 0 ${style.shadowBlur * scale}px ${style.shadowColor}`
        : undefined,
    WebkitTextStroke:
      style.outlineColor && style.outlineWidth
        ? `${style.outlineWidth * scale}px ${style.outlineColor}`
        : undefined,
  };
}

/** Clampa um número opcional num intervalo, com fallback. */
function clampNum(
  v: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}
