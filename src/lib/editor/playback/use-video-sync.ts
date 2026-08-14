/**
 * Hook React do Video Sync Engine.
 *
 * Conecta um singleton `VideoSyncManager` ao `useEditorStore`:
 *  - Reage a mudanças em `ui.isPlaying` → `playAll()` / `pauseAll()`.
 *  - Reage a mudanças externas em `ui.playhead` (scrubbing, atalho de teclado,
 *    clique no ruler) → `seekAll(playhead)`.
 *  - A cada tick do rAF, empurra o novo tempo para o store via
 *    `setPlayhead(t, { fromPlayback: true })`. A flag evita feedback loop:
 *    o effect que escuta playhead ignora updates marcados como playback.
 *
 * O singleton é criado uma única vez por sessão (módulo) — múltiplos
 * componentes podem chamar `useVideoSync()` sem duplicar o engine.
 */
import { useCallback, useEffect, useRef } from 'react';

import { useEditorStore } from '../store';
import type { Clip } from '../types';
import {
  createVideoSyncManager,
  type VideoSyncManager,
} from './video-sync';

// ============================================================================
// Singleton do manager
// ============================================================================

/**
 * Em SSR não criamos o engine (usa `requestAnimationFrame`). O hook lazy-cria
 * na primeira execução em browser.
 */
let managerInstance: VideoSyncManager | null = null;

/**
 * Flag compartilhada que sinaliza "estou empurrando playhead via tick";
 * o subscriber de playhead checa antes de chamar `seekAll`. Necessário porque
 * o `setPlayhead` no store não distingue origem — usamos a flag em memória
 * para fechar o loop.
 */
let isTickWriting = false;

function getManager(): VideoSyncManager | null {
  if (typeof window === 'undefined') return null;
  if (!managerInstance) {
    managerInstance = createVideoSyncManager({
      driftThresholdSec: 0.1,
      onTick: (timelineSec) => {
        const st = useEditorStore.getState();
        const duration = st.project?.duration ?? 0;

        // Loop ativo: ao passar do fim do range, dá WRAP em vez de parar.
        if (duration > 0 && st.ui.isLooping) {
          const loopStart = st.ui.loopRange?.start ?? 0;
          const loopEnd = st.ui.loopRange?.end ?? duration;
          if (timelineSec >= loopEnd) {
            isTickWriting = true;
            try {
              st.setPlayhead(loopStart, { fromPlayback: true });
            } finally {
              isTickWriting = false;
            }
            // Reposiciona o relógio interno do engine (e re-seeka os vídeos)
            // para o início do loop, mantendo engine e store em sincronia.
            managerInstance?.seekAll(loopStart);
            return;
          }
        }

        // Sem loop: ao alcançar o fim do conteúdo, crava no fim e pausa.
        if (duration > 0 && timelineSec >= duration) {
          isTickWriting = true;
          try {
            st.setPlayhead(duration, { fromPlayback: true });
            st.pause();
          } finally {
            isTickWriting = false;
          }
          // Alinha o relógio interno do engine ao fim para um próximo seek
          // não reaproveitar o tempo "estourado".
          managerInstance?.seekAll(duration);
          return;
        }

        // Caso normal: empurra o tempo cru. Marca a escrita como playback.
        isTickWriting = true;
        try {
          st.setPlayhead(timelineSec, { fromPlayback: true });
        } finally {
          // Permite que o subscriber reaja a updates externos novamente.
          isTickWriting = false;
        }
      },
    });
  }
  return managerInstance;
}

// ============================================================================
// API pública do hook
// ============================================================================

export interface UseVideoSyncResult {
  /** Registra um `<video>` ligado a um clip. */
  registerVideo: (
    clipId: string,
    video: HTMLVideoElement,
    clip: Clip,
  ) => void;
  /** Atualiza o snapshot do clip de um vídeo já registrado (rate/trim/etc). */
  updateClip: (clipId: string, clip: Clip) => void;
  /** Remove o registro (pausa o vídeo). */
  unregisterVideo: (clipId: string) => void;
  /** True se o playhead corrente está dentro do intervalo do clip. */
  isClipActive: (clipId: string) => boolean;
  /** Tempo atual a ser exibido pelo asset (`currentTime` esperado), em segundos. */
  getCurrentAssetTime: (clipId: string) => number;
}

export function useVideoSync(): UseVideoSyncResult {
  const managerRef = useRef<VideoSyncManager | null>(null);

  // Lazy-init em browser.
  if (managerRef.current === null && typeof window !== 'undefined') {
    managerRef.current = getManager();
  }

  // ---------------- Subscribe ao store --------------------------------------
  // Em zustand v4, `subscribe(listener)` recebe o state inteiro a cada mudança.
  // Mantemos cache local dos campos relevantes para detectar transições.
  useEffect(() => {
    const mgr = managerRef.current;
    if (!mgr) return;

    // Aplica estado inicial (em caso de re-mount com store já tocando).
    const initial = useEditorStore.getState().ui;
    let prevIsPlaying = initial.isPlaying;
    let prevPlayhead = initial.playhead;
    mgr.seekAll(initial.playhead);
    if (initial.isPlaying) {
      void mgr.playAll();
    } else {
      mgr.pauseAll();
    }

    const unsub = useEditorStore.subscribe((state) => {
      const isPlaying = state.ui.isPlaying;
      const playhead = state.ui.playhead;

      // Mudança de play/pause.
      if (isPlaying !== prevIsPlaying) {
        if (isPlaying) {
          mgr.seekAll(playhead);
          void mgr.playAll();
        } else {
          mgr.pauseAll();
        }
        prevIsPlaying = isPlaying;
      }

      // Mudança de playhead — ignorar updates originados do tick interno.
      if (playhead !== prevPlayhead) {
        if (!isTickWriting) {
          mgr.seekAll(playhead);
        }
        prevPlayhead = playhead;
      }
    });
    return unsub;
  }, []);

  // ---------------- Cleanup global ------------------------------------------
  // Não destruímos o manager singleton em unmount — múltiplos componentes
  // podem usá-lo. O `destroy` fica reservado para casos extremos (HMR,
  // navegação fora do editor); deixamos como API mas não chamamos aqui.

  // ---------------- Métodos retornados (estáveis) ---------------------------
  const registerVideo = useCallback(
    (clipId: string, video: HTMLVideoElement, clip: Clip) => {
      managerRef.current?.registerVideo(clipId, video, clip);
    },
    [],
  );

  const updateClip = useCallback((clipId: string, clip: Clip) => {
    managerRef.current?.updateClip(clipId, clip);
  }, []);

  const unregisterVideo = useCallback((clipId: string) => {
    managerRef.current?.unregisterVideo(clipId);
  }, []);

  const isClipActive = useCallback((clipId: string): boolean => {
    // Reaproveita a lógica do manager via tempo do store + clip do projeto.
    const state = useEditorStore.getState();
    if (!state.project) return false;
    const playhead = state.ui.playhead;
    for (const track of state.project.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (!clip) continue;
      return (
        playhead >= clip.startInTimeline && playhead < clip.endInTimeline
      );
    }
    return false;
  }, []);

  const getCurrentAssetTime = useCallback((clipId: string): number => {
    const state = useEditorStore.getState();
    if (!state.project) return 0;
    const playhead = state.ui.playhead;
    for (const track of state.project.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (!clip) continue;
      const offset = playhead - clip.startInTimeline;
      const rate = clip.playbackRate || 1;
      const t = clip.startInAsset + offset * rate;
      if (t < clip.startInAsset) return clip.startInAsset;
      if (t > clip.endInAsset) return clip.endInAsset;
      return t;
    }
    return 0;
  }, []);

  return {
    registerVideo,
    updateClip,
    unregisterVideo,
    isClipActive,
    getCurrentAssetTime,
  };
}

/**
 * Acesso direto ao singleton (para casos avançados — render dedicado, testes).
 * Componentes normais devem usar `useVideoSync()`.
 */
export function getVideoSyncManager(): VideoSyncManager | null {
  return getManager();
}
