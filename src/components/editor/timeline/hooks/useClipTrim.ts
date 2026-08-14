'use client';

/**
 * Hook que gerencia o trim (left/right) de um clip da timeline.
 *
 * Comportamento:
 * - `pointerdown` no handle (left ou right) → inicia trim, captura ponteiro,
 *   guarda `startInTimeline`/`endInTimeline` originais.
 * - `pointermove` (window) → calcula novo tempo (snap se ativado).
 * - `pointerup` → chama `trimClip(clipId, side, newTime)`.
 *
 * Snap guides: durante o trim, populamos `useSnapGuidesStore` com candidatos
 * para que `<SnapGuides />` possa desenhar as linhas verticais e destacar
 * o alvo encaixado.
 *
 * Importante: handles devem ter `data-clip-handle="left|right"` no DOM para
 * que `useClipDrag` os ignore (não inicie um drag horizontal).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useEditorStore } from '@/lib/editor/store';
import {
  getSnapCandidates,
  snapToCandidatesWithTarget,
} from '@/lib/editor/timeline-interactions';
import { useSnapGuidesStore } from './snap-guides-store';

type Side = 'left' | 'right';

export interface UseClipTrimResult {
  isTrimming: Side | null;
  /** Tempo preview (em s) durante trim — usado para HUD e cálculo visual. */
  previewTime: number | null;
  onLeftPointerDown: (e: React.PointerEvent) => void;
  onRightPointerDown: (e: React.PointerEvent) => void;
}

interface TrimState {
  pointerId: number;
  side: Side;
  startClientX: number;
  originalStart: number;
  originalEnd: number;
}

const MIN_DURATION = 0.1;

export function useClipTrim(clipId: string): UseClipTrimResult {
  const trimClip = useEditorStore((s) => s.trimClip);
  const setIsDragging = useEditorStore((s) => s.setIsDragging);

  const trimRef = useRef<TrimState | null>(null);
  const pendingRef = useRef<{ side: Side; newTime: number } | null>(null);

  const [isTrimming, setTrimmingSide] = useState<Side | null>(null);
  const [previewTime, setPreviewTime] = useState<number | null>(null);

  const start = useCallback(
    (e: React.PointerEvent, side: Side) => {
      const project = useEditorStore.getState().project;
      if (!project) return;

      // Encontra clip + track.
      let clip = null;
      let track = null;
      for (const t of project.tracks) {
        const c = t.clips.find((c) => c.id === clipId);
        if (c) {
          clip = c;
          track = t;
          break;
        }
      }
      if (!clip || !track) return;
      if (clip.locked || track.locked) return;

      e.stopPropagation();
      e.preventDefault();

      const el = e.currentTarget as HTMLElement;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }

      trimRef.current = {
        pointerId: e.pointerId,
        side,
        startClientX: e.clientX,
        originalStart: clip.startInTimeline,
        originalEnd: clip.endInTimeline,
      };
      pendingRef.current = null;
      setTrimmingSide(side);
      setIsDragging(true);
      setPreviewTime(side === 'left' ? clip.startInTimeline : clip.endInTimeline);

      // Inicializa snap guides para feedback visual.
      if (useEditorStore.getState().ui.snapEnabled) {
        const candidates = getSnapCandidates(
          project,
          clipId,
          useEditorStore.getState().ui.playhead,
        );
        useSnapGuidesStore.getState().setActive(true, candidates);
      } else {
        useSnapGuidesStore.getState().setActive(false);
      }
    },
    [clipId, setIsDragging],
  );

  const onLeftPointerDown = useCallback(
    (e: React.PointerEvent) => start(e, 'left'),
    [start],
  );
  const onRightPointerDown = useCallback(
    (e: React.PointerEvent) => start(e, 'right'),
    [start],
  );

  useEffect(() => {
    if (!isTrimming) return;

    const handleMove = (e: PointerEvent) => {
      const trim = trimRef.current;
      if (!trim || e.pointerId !== trim.pointerId) return;

      const state = useEditorStore.getState();
      const { zoom, snapEnabled, snapThresholdPx, playhead } = state.ui;
      const project = state.project;
      if (!project) return;

      const dx = e.clientX - trim.startClientX;
      const deltaSec = dx / zoom;

      let newTime: number;
      if (trim.side === 'left') {
        const maxStart = trim.originalEnd - MIN_DURATION;
        newTime = Math.min(maxStart, Math.max(0, trim.originalStart + deltaSec));
      } else {
        const minEnd = trim.originalStart + MIN_DURATION;
        newTime = Math.max(minEnd, trim.originalEnd + deltaSec);
      }

      let snapTarget: number | null = null;
      if (snapEnabled) {
        const candidates = getSnapCandidates(project, clipId, playhead);
        const thresholdSec = snapThresholdPx / zoom;
        const snapped = snapToCandidatesWithTarget(
          newTime,
          candidates,
          thresholdSec,
        );
        newTime = snapped.value;
        snapTarget = snapped.target;
        // Re-clamp após snap.
        if (trim.side === 'left') {
          const maxStart = trim.originalEnd - MIN_DURATION;
          newTime = Math.min(maxStart, Math.max(0, newTime));
        } else {
          const minEnd = trim.originalStart + MIN_DURATION;
          newTime = Math.max(minEnd, newTime);
        }
        useSnapGuidesStore.getState().setHighlighted(snapTarget);
      } else {
        useSnapGuidesStore.getState().setHighlighted(null);
      }

      pendingRef.current = { side: trim.side, newTime };
      setPreviewTime(newTime);
    };

    const handleUp = (e: PointerEvent) => {
      const trim = trimRef.current;
      if (!trim || e.pointerId !== trim.pointerId) return;

      const pending = pendingRef.current;
      if (pending) {
        trimClip(clipId, pending.side, pending.newTime);
      }

      trimRef.current = null;
      pendingRef.current = null;
      setTrimmingSide(null);
      setIsDragging(false);
      setPreviewTime(null);
      useSnapGuidesStore.getState().setActive(false);
    };

    const handleCancel = () => {
      trimRef.current = null;
      pendingRef.current = null;
      setTrimmingSide(null);
      setIsDragging(false);
      setPreviewTime(null);
      useSnapGuidesStore.getState().setActive(false);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };
  }, [isTrimming, clipId, trimClip, setIsDragging]);

  return {
    isTrimming,
    previewTime,
    onLeftPointerDown,
    onRightPointerDown,
  };
}
