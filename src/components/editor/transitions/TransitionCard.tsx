'use client';

/**
 * Card individual de transição na gallery.
 *
 * - 96×64 px (área visual; o card pai pode adicionar padding/borda).
 * - Mini preview animado em CSS (`@keyframes`) representando a transição.
 *   A animação roda em loop (3s) com `animation-play-state: paused` por
 *   default; ao passar o mouse (`hover`), volta a rodar — assim a página
 *   não fica "ocupada" com 14 animações simultâneas.
 * - Pressionando o card, a transição pode ser arrastada (`draggable`)
 *   para uma junção entre clips na timeline, ou clicada para
 *   selecionar (callback `onSelect`).
 * - Indicador visual quando selecionado (via prop `selected`).
 */

import * as React from 'react';
import type { TransitionType } from '@/lib/editor/types';
import {
  TRANSITION_DRAG_MIME,
  type TransitionDefinition,
  type TransitionPreviewKind,
} from '@/lib/editor/transitions';
import { cn } from '@/lib/utils';

export interface TransitionCardProps {
  type: TransitionType;
  definition: TransitionDefinition;
  selected?: boolean;
  onSelect?: (type: TransitionType) => void;
  onDragStart?: (type: TransitionType) => void;
  onDragEnd?: () => void;
  className?: string;
}

export function TransitionCard({
  type,
  definition,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
  className,
}: TransitionCardProps) {
  const handleDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
    const payload = JSON.stringify({ type });
    e.dataTransfer.setData(TRANSITION_DRAG_MIME, payload);
    e.dataTransfer.effectAllowed = 'copy';
    onDragStart?.(type);
  };

  const handleDragEnd = () => {
    onDragEnd?.();
  };

  return (
    <button
      type="button"
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={() => onSelect?.(type)}
      title={definition.label}
      className={cn(
        'group relative flex flex-col items-stretch gap-1 rounded-sm border p-1 text-left transition-colors',
        'border-border bg-muted',
        'hover:bg-border',
        selected && 'border-[var(--editor-accent)] bg-[var(--editor-accent-soft)]',
        'cursor-grab active:cursor-grabbing',
        className,
      )}
    >
      {/* Mini preview 96×64. Usa overflow-hidden + dois "frames" coloridos
          que animam segundo a kind preview. */}
      <div
        className={cn(
          'relative h-16 w-24 overflow-hidden rounded-sm',
          'bg-background',
        )}
        data-transition-preview={definition.preview}
      >
        <PreviewAnimation kind={definition.preview} />
      </div>

      <span className="block truncate text-center text-[10px] font-medium text-muted-foreground">
        {definition.label}
      </span>
    </button>
  );
}

// ============================================================================
// PreviewAnimation — anima dois "frames" (A vermelho, B azul) com a transição.
// ============================================================================

interface PreviewAnimationProps {
  kind: TransitionPreviewKind;
}

/**
 * Implementação CSS-only. Cada `kind` mapeia para um par de animations
 * (`a-…` para o frame que sai, `b-…` para o que entra), definidas via
 * `<style>` injetado uma única vez.
 */
function PreviewAnimation({ kind }: PreviewAnimationProps) {
  return (
    <>
      <PreviewKeyframesOnce />
      <div
        className="absolute inset-0"
        style={{
          // Frame A (sai)
          backgroundImage:
            'linear-gradient(135deg, hsl(0 70% 55%), hsl(20 80% 60%))',
          animationName: `tx-${kind}-a`,
          animationDuration: '2.4s',
          animationIterationCount: 'infinite',
          animationTimingFunction: 'ease-in-out',
          animationDirection: 'normal',
          willChange: 'transform, opacity, clip-path',
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          // Frame B (entra)
          backgroundImage:
            'linear-gradient(135deg, hsl(210 70% 55%), hsl(190 80% 60%))',
          animationName: `tx-${kind}-b`,
          animationDuration: '2.4s',
          animationIterationCount: 'infinite',
          animationTimingFunction: 'ease-in-out',
          willChange: 'transform, opacity, clip-path',
        }}
      />
      {/* Letras decorativas, ajudam a leitura da direção do movimento. */}
      <span
        className="pointer-events-none absolute left-1 top-1 text-[9px] font-bold text-white/80"
        aria-hidden
      >
        A
      </span>
      <span
        className="pointer-events-none absolute bottom-1 right-1 text-[9px] font-bold text-white/80"
        aria-hidden
      >
        B
      </span>
    </>
  );
}

// ============================================================================
// Keyframes globais — injetadas uma única vez por mount do gallery.
// ============================================================================

/** Flag para garantir que `<style>` não duplique. */
const STYLE_ID = 'oficioexpress-transition-preview-keyframes';

function PreviewKeyframesOnce() {
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = PREVIEW_KEYFRAMES_CSS;
    document.head.appendChild(el);
  }, []);
  return null;
}

/**
 * Cada par de animations (`tx-<kind>-a` para outgoing, `tx-<kind>-b`
 * para incoming) cobre o ciclo:
 *   0%   → 35%: A visível, B oculto (estado inicial)
 *   35%  → 65%: transição rolando
 *   65%  → 100%: B visível, A oculto (estado final)
 *
 * Exatamente as mesmas curvas usadas em `transitions/index.ts` mas
 * expressas como CSS.
 */
const PREVIEW_KEYFRAMES_CSS = `
/* fade / crossfade ------------------------------------------------- */
@keyframes tx-fade-a { 0%,35%{opacity:1} 65%,100%{opacity:0} }
@keyframes tx-fade-b { 0%,35%{opacity:0} 65%,100%{opacity:1} }

/* slide-left ------------------------------------------------------ */
@keyframes tx-slide-left-a {
  0%,35% { transform: translateX(0); }
  65%,100% { transform: translateX(-100%); }
}
@keyframes tx-slide-left-b {
  0%,35% { transform: translateX(100%); }
  65%,100% { transform: translateX(0); }
}

/* slide-right ----------------------------------------------------- */
@keyframes tx-slide-right-a {
  0%,35% { transform: translateX(0); }
  65%,100% { transform: translateX(100%); }
}
@keyframes tx-slide-right-b {
  0%,35% { transform: translateX(-100%); }
  65%,100% { transform: translateX(0); }
}

/* slide-up -------------------------------------------------------- */
@keyframes tx-slide-up-a {
  0%,35% { transform: translateY(0); }
  65%,100% { transform: translateY(-100%); }
}
@keyframes tx-slide-up-b {
  0%,35% { transform: translateY(100%); }
  65%,100% { transform: translateY(0); }
}

/* slide-down ------------------------------------------------------ */
@keyframes tx-slide-down-a {
  0%,35% { transform: translateY(0); }
  65%,100% { transform: translateY(100%); }
}
@keyframes tx-slide-down-b {
  0%,35% { transform: translateY(-100%); }
  65%,100% { transform: translateY(0); }
}

/* push-left ------------------------------------------------------- */
@keyframes tx-push-left-a {
  0%,35% { transform: translateX(0); }
  65%,100% { transform: translateX(-100%); }
}
@keyframes tx-push-left-b {
  0%,35% { transform: translateX(100%); }
  65%,100% { transform: translateX(0); }
}

/* push-right ------------------------------------------------------ */
@keyframes tx-push-right-a {
  0%,35% { transform: translateX(0); }
  65%,100% { transform: translateX(100%); }
}
@keyframes tx-push-right-b {
  0%,35% { transform: translateX(-100%); }
  65%,100% { transform: translateX(0); }
}

/* zoom-in --------------------------------------------------------- */
@keyframes tx-zoom-in-a {
  0%,35% { opacity:1; transform: scale(1); }
  65%,100% { opacity:0; transform: scale(0.8); }
}
@keyframes tx-zoom-in-b {
  0%,35% { opacity:0; transform: scale(0.6); }
  65%,100% { opacity:1; transform: scale(1); }
}

/* zoom-out -------------------------------------------------------- */
@keyframes tx-zoom-out-a {
  0%,35% { opacity:1; transform: scale(1); }
  65%,100% { opacity:0; transform: scale(1.6); }
}
@keyframes tx-zoom-out-b {
  0%,35% { opacity:0; transform: scale(0.95); }
  65%,100% { opacity:1; transform: scale(1); }
}

/* wipe-left ------------------------------------------------------- */
@keyframes tx-wipe-left-a {
  0%,35% { clip-path: inset(0 0 0 0); }
  65%,100% { clip-path: inset(0 0 0 100%); }
}
@keyframes tx-wipe-left-b {
  0%,35% { clip-path: inset(0 100% 0 0); }
  65%,100% { clip-path: inset(0 0 0 0); }
}

/* wipe-right ------------------------------------------------------ */
@keyframes tx-wipe-right-a {
  0%,35% { clip-path: inset(0 0 0 0); }
  65%,100% { clip-path: inset(0 100% 0 0); }
}
@keyframes tx-wipe-right-b {
  0%,35% { clip-path: inset(0 0 0 100%); }
  65%,100% { clip-path: inset(0 0 0 0); }
}

/* circle ---------------------------------------------------------- */
@keyframes tx-circle-a {
  0%,35% { clip-path: circle(150% at 50% 50%); }
  65%,100% { clip-path: circle(150% at 50% 50%); }
}
@keyframes tx-circle-b {
  0%,35% { clip-path: circle(0% at 50% 50%); }
  65%,100% { clip-path: circle(85% at 50% 50%); }
}

/* iris ------------------------------------------------------------ */
@keyframes tx-iris-a {
  0%,35% { clip-path: ellipse(150% 150% at 50% 50%); }
  65%,100% { clip-path: ellipse(150% 150% at 50% 50%); }
}
@keyframes tx-iris-b {
  0%,35% { clip-path: ellipse(0% 0% at 50% 50%); }
  65%,100% { clip-path: ellipse(95% 65% at 50% 50%); }
}
`;
