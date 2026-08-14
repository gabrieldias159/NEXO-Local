'use client';

/**
 * Hook que computa o `TransitionState` ativo para um clip no instante
 * atual do playhead.
 *
 * Lógica:
 * - Se o playhead está nos primeiros `transitionIn.duration` segundos do
 *   clip (intervalo `[startInTimeline, startInTimeline + dur)`), retorna
 *   o estado `incoming(easing(progress))` da transição configurada.
 * - Se o playhead está nos últimos `transitionOut.duration` segundos
 *   (intervalo `[endInTimeline - dur, endInTimeline)`), retorna o estado
 *   `outgoing(easing(progress))`.
 * - Caso contrário, retorna `null` — o caller aplica nenhum overlay.
 *
 * Performance:
 * - O hook não cria nenhum objeto fora da janela de transição (early
 *   return com `null`).
 * - Dentro da janela, o estado é memoizado via `useMemo` na tupla
 *   (clip.transitionIn?, clip.transitionOut?, playheadSec).
 *
 * Caso o clip tenha AMBAS transitionIn e transitionOut e os intervalos
 * se sobreponham (clip muito curto), priorizamos `transitionIn` no
 * primeiro frame e `transitionOut` no último, com tratamento simétrico
 * para o meio (cada lado limitado a metade do clip — já garantido pela
 * action `applyTransitionBetween`).
 */

import { useMemo } from 'react';
import type { Clip } from '@/lib/editor/types';
import {
  clampProgress,
  easings,
  transitions,
  type TransitionState,
} from '@/lib/editor/transitions';

export function useTransitionState(
  clip: Clip,
  playheadSec: number,
): TransitionState | null {
  return useMemo(() => {
    return computeTransitionState(clip, playheadSec);
  }, [
    clip.transitionIn?.type,
    clip.transitionIn?.duration,
    clip.transitionIn?.easing,
    clip.transitionOut?.type,
    clip.transitionOut?.duration,
    clip.transitionOut?.easing,
    clip.startInTimeline,
    clip.endInTimeline,
    playheadSec,
  ]);
}

/**
 * Versão pura (não-React) do cálculo. Útil para testes e para uso
 * fora de componentes (ex: lógica de export, tooling).
 */
export function computeTransitionState(
  clip: Clip,
  playheadSec: number,
): TransitionState | null {
  const { transitionIn, transitionOut, startInTimeline, endInTimeline } = clip;

  // ---- transitionIn -------------------------------------------------------
  if (transitionIn && transitionIn.duration > 0) {
    const inEnd = startInTimeline + transitionIn.duration;
    if (playheadSec >= startInTimeline && playheadSec < inEnd) {
      const linear = (playheadSec - startInTimeline) / transitionIn.duration;
      const eased = easings[transitionIn.easing](clampProgress(linear));
      return transitions[transitionIn.type].incoming(eased);
    }
  }

  // ---- transitionOut ------------------------------------------------------
  if (transitionOut && transitionOut.duration > 0) {
    const outStart = endInTimeline - transitionOut.duration;
    if (playheadSec >= outStart && playheadSec < endInTimeline) {
      const linear = (playheadSec - outStart) / transitionOut.duration;
      const eased = easings[transitionOut.easing](clampProgress(linear));
      return transitions[transitionOut.type].outgoing(eased);
    }
  }

  return null;
}
