'use client';

/**
 * Captura de atalhos de teclado globais do editor.
 *
 * Atalhos:
 * - `Space`               → togglePlay()
 * - `K`                   → pause() (padrão de editores estilo YouTube/Premiere)
 * - `J`                   → recua: 1ª pressão → pause + −1s; já pausado → −2s
 * - `L`                   → avança: 1ª pressão → play; consecutivas dobram a velocidade
 * - `Ctrl/Cmd+Z`          → undo()
 * - `Ctrl/Cmd+Y` ou
 *   `Ctrl/Cmd+Shift+Z`    → redo()
 * - `Ctrl/Cmd+C`          → copia o clip selecionado (clipboard interno)
 * - `Ctrl/Cmd+V`          → cola o clip do clipboard no playhead
 * - `Ctrl/Cmd+Alt+C`      → copia os AJUSTES do clip selecionado
 * - `Ctrl/Cmd+Alt+V`      → cola os ajustes nos clips selecionados
 * - `Delete`/`Backspace`  → removeClip(selectedClipId) ou removeCaption(selectedCueId)
 * - `V`                   → tool = select
 * - `C`                   → tool = blade
 * - `S` ou `Ctrl/Cmd+B`   → CORTA no playhead: os clips selecionados; sem
 *                           seleção, os clips da track selecionada; sem track
 *                           selecionada, todos os clips sob o playhead
 * - `Shift+L`             → toggle CaptionsDrawer
 * - `T`                   → cria novo caption no playhead atual (4s default)
 *
 * Atalhos de navegação na timeline (Fase 6 — visual polish):
 * - `Home`                → playhead = 0
 * - `End`                 → playhead = duração total
 * - `←` / `→`             → playhead ±1 frame (assume 30 fps)
 * - `Shift + ←` / `→`     → playhead ±1 segundo
 * - `↑` / `↓`             → seleciona clip anterior/próximo na mesma track
 * - `+` / `-`             → zoom in/out (1.25x por step, clamp 5..1000 px/s)
 * - `M`                   → toggle mute do(s) clip(s) selecionado(s)
 * - `F`                   → "fit": ajusta zoom para enquadrar o clip
 *                           selecionado (ou o projeto inteiro se nenhum)
 *
 * Detalhes:
 * - Ignora eventos quando o foco está em `<input>`, `<textarea>` ou
 *   elementos com `contenteditable` para não interceptar digitação.
 * - Renderiza `null` (efeito puro).
 */

import { useEffect } from 'react';
import { useEditorStore } from '@/lib/editor/store';
import { useCaptionsDrawer } from '../captions/useCaptionsDrawer';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/** Frame "padrão" assumido para os atalhos de seek (←/→). */
const ASSUMED_FPS = 30;

export function KeyboardShortcuts() {
  const togglePlay = useEditorStore((s) => s.togglePlay);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const removeClip = useEditorStore((s) => s.removeClip);
  const setTool = useEditorStore((s) => s.setTool);
  const splitClip = useEditorStore((s) => s.splitClip);
  const toggleCaptionsDrawer = useCaptionsDrawer((s) => s.toggle);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      const meta = e.ctrlKey || e.metaKey;

      // Space → toggle play
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
        return;
      }

      // J / K / L (estilo Premiere/YouTube). Sem modificadores.
      // K → pausa.
      // J → recua: pausa primeiro; pressões consecutivas pulam −1s.
      // L → avança: dá play; pressões consecutivas dobram playbackRate.
      // Implementação conservadora: como não há controle global de
      // playbackRate no store, J/L apenas movem o playhead em ±1s e
      // garantem o estado de play/pause apropriado.
      if (!meta && !e.altKey && !e.shiftKey) {
        if (e.key === 'k' || e.key === 'K') {
          e.preventDefault();
          useEditorStore.getState().pause();
          return;
        }
        if (e.key === 'j' || e.key === 'J') {
          e.preventDefault();
          const st = useEditorStore.getState();
          st.pause();
          st.setPlayhead(Math.max(0, st.ui.playhead - 1));
          return;
        }
        if (e.key === 'l' || e.key === 'L') {
          e.preventDefault();
          const st = useEditorStore.getState();
          if (!st.ui.isPlaying) {
            st.play();
          } else {
            // Já tocando: avança 1s extra como pseudo-aceleração.
            st.setPlayhead(st.ui.playhead + 1);
          }
          return;
        }
      }

      // Ctrl/Cmd+Alt+C → copia os AJUSTES do clip selecionado ("Copiar atributos").
      // Checado ANTES do Ctrl+C "puro" (que exige !altKey).
      if (meta && e.altKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        useEditorStore.getState().copiarAjustes();
        return;
      }

      // Ctrl/Cmd+Alt+V → cola os ajustes nos clips selecionados ("Colar atributos").
      if (meta && e.altKey && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        useEditorStore.getState().aplicarAjustes();
        return;
      }

      // Ctrl/Cmd+C → copia o clip selecionado.
      if (meta && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        useEditorStore.getState().copySelectedClip();
        return;
      }

      // Ctrl/Cmd+V → cola o clip do clipboard no playhead atual.
      if (meta && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        useEditorStore.getState().pasteClip();
        return;
      }

      // Undo / redo
      if (meta && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }
      if (meta && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redo();
        return;
      }

      // Ctrl/Cmd+B → corta no playhead (mesma ação do `S`).
      if (meta && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        cortarNoPlayhead(splitClip);
        return;
      }

      // Shift+L → toggle CaptionsDrawer
      if (e.shiftKey && !meta && !e.altKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        toggleCaptionsDrawer();
        return;
      }

      // ---- Navegação na timeline ------------------------------------------
      // Home / End → começo / fim
      if (!meta && !e.altKey && e.key === 'Home') {
        e.preventDefault();
        useEditorStore.getState().setPlayhead(0);
        return;
      }
      if (!meta && !e.altKey && e.key === 'End') {
        e.preventDefault();
        const dur = useEditorStore.getState().project?.duration ?? 0;
        useEditorStore.getState().setPlayhead(dur);
        return;
      }

      // ←/→ : ±1 frame  | Shift+←/→ : ±1 segundo
      if (!meta && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const state = useEditorStore.getState();
        const fps = state.project?.frameRate ?? ASSUMED_FPS;
        const step = e.shiftKey ? 1 : 1 / fps;
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        const next = Math.max(0, state.ui.playhead + dir * step);
        state.setPlayhead(next);
        return;
      }

      // ↑/↓ : navega entre clips na mesma track
      if (!meta && !e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        navigateClips(e.key === 'ArrowDown' ? 'next' : 'prev');
        return;
      }

      // +/- : zoom in/out (com ou sem shift, e considerando layouts BR/US).
      if (!meta && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) {
        e.preventDefault();
        const state = useEditorStore.getState();
        const cur = state.ui.zoom;
        const factor = e.key === '+' || e.key === '=' ? 1.25 : 1 / 1.25;
        state.setZoom(cur * factor);
        return;
      }

      // Tools (sem modificador).
      if (!meta && !e.shiftKey && !e.altKey) {
        if (e.key === 'v' || e.key === 'V') {
          e.preventDefault();
          setTool('select');
          return;
        }
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault();
          setTool('blade');
          return;
        }
        // S → corta no playhead (atalho clássico de lâmina).
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          cortarNoPlayhead(splitClip);
          return;
        }
        // M → toggle mute do(s) clip(s) selecionado(s)
        if (e.key === 'm' || e.key === 'M') {
          e.preventDefault();
          toggleMuteSelected();
          return;
        }
        // F → focar (fit zoom) no clip selecionado
        if (e.key === 'f' || e.key === 'F') {
          e.preventDefault();
          fitToSelected();
          return;
        }
        // T → criar caption no playhead atual (4s default).
        if (e.key === 't' || e.key === 'T') {
          e.preventDefault();
          const state = useEditorStore.getState();
          const { addCaption, addCaptionTrack, project } = state;
          if (!project) return;
          const playhead = state.ui.playhead;
          let trackId: string | undefined = project.captionTracks[0]?.id;
          if (!trackId) {
            trackId = addCaptionTrack();
          }
          addCaption(trackId, {
            startTime: playhead,
            endTime: playhead + 4,
            text: '',
            slot: 'full',
            style: {
              fontFamily: 'Inter',
              fontSize: 36,
              fontWeight: 600,
              color: '#FFFFFF',
              backgroundColor: '#000000B3',
              align: 'center',
              position: 'bottom',
              paddingX: 12,
              paddingY: 4,
              borderRadius: 4,
            },
          });
          return;
        }
      }

      // Delete clip ou cue selecionado(s)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const state = useEditorStore.getState();
        const selectedClips = state.ui.selectedClipIds;
        const selectedCues = state.ui.selectedCueIds;
        if (selectedClips.length > 0) {
          e.preventDefault();
          for (const id of selectedClips) {
            removeClip(id);
          }
          state.clearSelection();
        } else if (selectedCues.length > 0) {
          e.preventDefault();
          const removeCaption = state.removeCaption;
          for (const id of selectedCues) {
            removeCaption(id);
          }
          state.clearSelection();
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [togglePlay, undo, redo, removeClip, setTool, splitClip, toggleCaptionsDrawer]);

  return null;
}

// ============================================================================
// Helpers de atalhos (Fase 6)
// ============================================================================

/**
 * CORTA no playhead (recurso 20). Ordem de alvo, do mais específico pro mais
 * amplo — é o que faz o `S` ser útil sem exigir seleção:
 *   1. clips SELECIONADOS;
 *   2. sem seleção, os clips da TRACK selecionada que estão sob o playhead;
 *   3. sem track selecionada, todos os clips sob o playhead (tracks
 *      destravadas) — a lâmina "corta tudo".
 *
 * Clip travado nunca é cortado. Um `undo` desfaz o corte inteiro.
 */
function cortarNoPlayhead(
  splitClip: (clipId: string, atTime: number) => unknown,
): void {
  const state = useEditorStore.getState();
  const project = state.project;
  if (!project) return;
  const { selectedClipIds, playhead, selectedTrackId } = state.ui;

  if (selectedClipIds.length > 0) {
    for (const id of selectedClipIds) splitClip(id, playhead);
    return;
  }

  const tracks = selectedTrackId
    ? project.tracks.filter((t) => t.id === selectedTrackId)
    : project.tracks;
  const alvos = tracks
    .filter((t) => !t.locked)
    .flatMap((t) => t.clips)
    .filter(
      (c) =>
        !c.locked &&
        playhead > c.startInTimeline + 0.02 &&
        playhead < c.endInTimeline - 0.02,
    );
  for (const c of alvos) splitClip(c.id, playhead);
}

/**
 * Navega para o clip anterior/próximo dentro da mesma track do clip
 * atualmente selecionado. Se nenhum clip selecionado, seleciona o primeiro
 * clip da primeira track.
 */
function navigateClips(direction: 'next' | 'prev'): void {
  const state = useEditorStore.getState();
  const project = state.project;
  if (!project) return;

  const selected = state.ui.selectedClipIds[0];
  if (!selected) {
    // Seleciona primeiro clip da primeira track com clips.
    for (const t of project.tracks) {
      if (t.clips.length > 0) {
        const sorted = [...t.clips].sort((a, b) => a.startInTimeline - b.startInTimeline);
        state.selectClip(sorted[0].id);
        state.setPlayhead(sorted[0].startInTimeline);
        return;
      }
    }
    return;
  }

  // Encontra track + index na ordem temporal.
  for (const t of project.tracks) {
    const sorted = [...t.clips].sort((a, b) => a.startInTimeline - b.startInTimeline);
    const idx = sorted.findIndex((c) => c.id === selected);
    if (idx < 0) continue;
    const target = direction === 'next' ? sorted[idx + 1] : sorted[idx - 1];
    if (target) {
      state.selectClip(target.id);
      state.setPlayhead(target.startInTimeline);
    }
    return;
  }
}

/** Toggles `audio.muted` em todos os clips atualmente selecionados. */
function toggleMuteSelected(): void {
  const state = useEditorStore.getState();
  const project = state.project;
  if (!project) return;
  const ids = state.ui.selectedClipIds;
  if (ids.length === 0) return;
  for (const id of ids) {
    let cur = false;
    for (const t of project.tracks) {
      const c = t.clips.find((x) => x.id === id);
      if (c) {
        cur = c.audio.muted;
        break;
      }
    }
    state.setClipAudio(id, { muted: !cur });
  }
}

/**
 * Ajusta o zoom para "encaixar" no clip selecionado (com 10% de padding em
 * cada lado). Se não há clip selecionado, encaixa o projeto inteiro. Move
 * o playhead para o início do clip ou 0.
 */
function fitToSelected(): void {
  const state = useEditorStore.getState();
  const project = state.project;
  if (!project) return;

  const selected = state.ui.selectedClipIds[0];
  // Estimamos largura "visível" da timeline em px. Como não temos acesso ao
  // layout, usamos 800px como base — fica próximo do real na maioria dos
  // viewports e o clamp do setZoom protege contra valores absurdos.
  const VISIBLE_PX = 800;

  let span = 0;
  let start = 0;
  if (selected) {
    for (const t of project.tracks) {
      const c = t.clips.find((x) => x.id === selected);
      if (c) {
        start = c.startInTimeline;
        span = c.endInTimeline - c.startInTimeline;
        break;
      }
    }
  }
  if (!span) {
    span = Math.max(1, project.duration);
    start = 0;
  }

  const padded = span * 1.2;
  const newZoom = VISIBLE_PX / padded;
  state.setZoom(newZoom);
  state.setPlayhead(start);
}
