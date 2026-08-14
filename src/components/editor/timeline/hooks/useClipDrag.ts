'use client';

/**
 * Hook que gerencia o drag (horizontal + vertical) de um clip da timeline.
 *
 * Comportamento:
 * - `pointerdown` no clip → inicia drag (captura ponteiro), salva posição
 *   inicial em px (clientX/Y) e o `startInTimeline` original.
 * - `pointermove` (window) → calcula delta px → converte para segundos via
 *   `zoom` → aplica snap (se habilitado) → publica `dragOffset` no estado
 *   local.
 * - Detecta track sob o pointer via `document.elementsFromPoint` para
 *   permitir trocar de track. Se a nova track tem tipo compatível e está
 *   destrancada, marca como `hoverTrackId`.
 * - `pointerup` → chama `moveClip(clipId, newStart, hoverTrackId?)`.
 *
 * Snap guides: durante o drag, populamos `useSnapGuidesStore` com a lista de
 * candidatos atuais e o "alvo" encaixado. `<SnapGuides />` lê esse store e
 * desenha as linhas verticais.
 *
 * Esconde detalhes de DOM via `data-track-id` e `data-track-type` colocados
 * em `TimelineTrack` (área de clips).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useEditorStore } from '@/lib/editor/store';
import {
  getSnapCandidates,
  snapToCandidatesWithTarget,
} from '@/lib/editor/timeline-interactions';
import { useSnapGuidesStore } from './snap-guides-store';

export interface UseClipDragResult {
  isDragging: boolean;
  /** Offset visual aplicado ao clip durante o drag (px na timeline + px de Y). */
  dragOffset: { x: number; y: number };
  /** Tempo de início preview (segundos) durante o drag — usado por HUD. */
  previewStart: number | null;
  /** Track-id de destino durante hover (null se segue na original). */
  hoverTrackId: string | null;
  onPointerDown: (e: React.PointerEvent) => void;
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originalStart: number;
  /** Duração do clip (não muda durante drag horizontal). */
  duration: number;
  /** Track-id original. */
  originalTrackId: string;
  /** Tipo do clip (derivado da track original). */
  trackType: 'video' | 'audio';
  /** Camada (subtrack) original do clip. */
  originalLayer: number;
}

export function useClipDrag(clipId: string): UseClipDragResult {
  const moveClip = useEditorStore((s) => s.moveClip);
  const moveClipToLayer = useEditorStore((s) => s.moveClipToLayer);
  const setIsDragging = useEditorStore((s) => s.setIsDragging);

  const dragRef = useRef<DragState | null>(null);

  const [isDragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [previewStart, setPreviewStart] = useState<number | null>(null);
  const [hoverTrackId, setHoverTrackId] = useState<string | null>(null);

  /** Estado final pendente — aplicado em pointerup. */
  const pendingFinalRef = useRef<{
    newStart: number;
    newTrackId: string | null;
    /** Camada (subtrack) de destino na track sob o cursor, ou null. */
    newLayer: number | null;
  } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Não inicia drag se ferramenta atual não é select.
      const { tool } = useEditorStore.getState().ui;
      if (tool !== 'select') return;

      const project = useEditorStore.getState().project;
      if (!project) return;

      // Encontra clip e track owner.
      let foundClip = null;
      let foundTrack = null;
      for (const t of project.tracks) {
        const c = t.clips.find((c) => c.id === clipId);
        if (c) {
          foundClip = c;
          foundTrack = t;
          break;
        }
      }
      if (!foundClip || !foundTrack) return;
      if (foundClip.locked || foundTrack.locked) return;

      // Não interfere com handles de trim (pointer down em [data-clip-handle]).
      const target = e.target as HTMLElement;
      if (target?.closest?.('[data-clip-handle]')) return;

      e.stopPropagation();
      e.preventDefault();

      // Captura ponteiro no elemento do clip (garante eventos mesmo se sair).
      const el = e.currentTarget as HTMLElement;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }

      dragRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        originalStart: foundClip.startInTimeline,
        duration: foundClip.endInTimeline - foundClip.startInTimeline,
        originalTrackId: foundTrack.id,
        trackType: foundTrack.type,
        originalLayer: foundClip.layer ?? 0,
      };
      pendingFinalRef.current = null;
      setDragging(true);
      setIsDragging(true);
      setDragOffset({ x: 0, y: 0 });
      setPreviewStart(foundClip.startInTimeline);
      setHoverTrackId(null);

      // Inicializa snap guides com candidatos atuais.
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

  // Listeners globais — montados apenas quando isDragging.
  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;

      const state = useEditorStore.getState();
      const { zoom, snapEnabled, snapThresholdPx, playhead } = state.ui;
      const project = state.project;
      if (!project) return;

      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;

      // Calcula novo start em segundos.
      const deltaSec = dx / zoom;
      let newStart = Math.max(0, drag.originalStart + deltaSec);
      let snapTarget: number | null = null;

      // Snap às bordas de outros clips e ao playhead.
      if (snapEnabled) {
        const candidates = getSnapCandidates(project, clipId, playhead);
        const thresholdSec = snapThresholdPx / zoom;
        const startSnap = snapToCandidatesWithTarget(
          newStart,
          candidates,
          thresholdSec,
        );
        const newEnd = startSnap.value + drag.duration;
        const endSnap = snapToCandidatesWithTarget(
          newEnd,
          candidates,
          thresholdSec,
        );
        // Prefere o snap mais "agressivo" (que mexeu mais) — desempate: start.
        const startMoved = Math.abs(startSnap.value - newStart);
        const endMovedRaw = Math.abs(endSnap.value - newEnd);
        if (startMoved >= endMovedRaw) {
          newStart = endSnap.value - drag.duration;
          snapTarget = endSnap.target;
        } else {
          newStart = startSnap.value;
          snapTarget = startSnap.target;
        }
        if (newStart < 0) newStart = 0;

        useSnapGuidesStore.getState().setHighlighted(snapTarget);
      } else {
        useSnapGuidesStore.getState().setHighlighted(null);
      }

      // Detecção de track + CAMADA (subtrack) sob o pointer. Cada lane expõe
      // `data-track-id`, `data-track-type` e `data-layer`.
      let candidateTrackId: string | null = null;
      let candidateLayer: number | null = null;
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      for (const el of elements) {
        if (!(el instanceof HTMLElement)) continue;
        const tId = el.dataset?.trackId;
        const tType = el.dataset?.trackType;
        if (!tId || !tType) continue;
        if (tType !== drag.trackType) break; // tipo incompatível → não muda
        const targetTrack = project.tracks.find((t) => t.id === tId);
        if (!targetTrack || targetTrack.locked) break;
        candidateTrackId = tId;
        const rawLayer = el.dataset?.layer;
        candidateLayer = rawLayer != null ? Number(rawLayer) : 0;
        break;
      }
      const finalHoverTrack =
        candidateTrackId && candidateTrackId !== drag.originalTrackId
          ? candidateTrackId
          : null;

      // Camada de destino: só relevante para tracks de vídeo. Mantém null
      // quando não mudou (evita escrita desnecessária).
      let finalHoverLayer: number | null = null;
      if (drag.trackType === 'video' && candidateLayer != null) {
        const sameTrack =
          (finalHoverTrack ?? drag.originalTrackId) === drag.originalTrackId;
        // Numa lane diferente da origem (mesma track) OU em qualquer lane de
        // outra track → registra a camada de destino.
        if (!sameTrack || candidateLayer !== drag.originalLayer) {
          finalHoverLayer = candidateLayer;
        }
      }

      pendingFinalRef.current = {
        newStart,
        newTrackId: finalHoverTrack,
        newLayer: finalHoverLayer,
      };
      setDragOffset({ x: dx, y: dy });
      setPreviewStart(newStart);
      setHoverTrackId(finalHoverTrack);
    };

    const handleUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;

      const pending = pendingFinalRef.current;
      if (pending) {
        moveClip(
          clipId,
          pending.newStart,
          pending.newTrackId ?? undefined,
        );
        // Aplica a camada de destino (subtrack) DEPOIS do moveClip — o clip
        // já está na track correta, então `moveClipToLayer` só ajusta `layer`.
        if (pending.newLayer != null) {
          moveClipToLayer(clipId, pending.newLayer);
        }
      }

      dragRef.current = null;
      pendingFinalRef.current = null;
      setDragging(false);
      setIsDragging(false);
      setDragOffset({ x: 0, y: 0 });
      setPreviewStart(null);
      setHoverTrackId(null);
      useSnapGuidesStore.getState().setActive(false);
    };

    const handleCancel = () => {
      dragRef.current = null;
      pendingFinalRef.current = null;
      setDragging(false);
      setIsDragging(false);
      setDragOffset({ x: 0, y: 0 });
      setPreviewStart(null);
      setHoverTrackId(null);
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
  }, [isDragging, clipId, moveClip, moveClipToLayer, setIsDragging]);

  return {
    isDragging,
    dragOffset,
    previewStart,
    hoverTrackId,
    onPointerDown,
  };
}
