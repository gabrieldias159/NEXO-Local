/**
 * Hook React que expõe o `AudioMixer` integrado ao Zustand store.
 *
 * - Usa um singleton de mixer (módulo-level) para que múltiplos componentes
 *   compartilhem o mesmo grafo de áudio.
 * - Subscreve mudanças nos campos `tracks[*].volume/muted/solo` e
 *   `audioMaster.volume/muted` e propaga para o engine via setters.
 * - O ciclo de vida do mixer **não** é dono dos sources — o caller (video-sync
 *   engine ou o componente Preview) chama `registerSource` /
 *   `unregisterSource` quando elements `<video>`/`<audio>` são criados/
 *   destruídos.
 *
 * Observação sobre AudioContext autoplay policy:
 * - Browsers (Chrome, Safari) bloqueiam o AudioContext até o primeiro gesture
 *   do usuário. O hook expõe `ensureContextResumed` para ser chamado em um
 *   handler de `onClick` (ex: botão Play).
 */

'use client';

import { useCallback, useEffect, useRef } from 'react';

import { useEditorStore } from '../store';
import type { ClipAudio, Track, VideoProject } from '../types';
import { createAudioMixer, type AudioMixer } from './audio-mixer';

// ----------------------------------------------------------------------------
// Singleton: o mixer é único por sessão do navegador.
// ----------------------------------------------------------------------------

let sharedMixer: AudioMixer | null = null;

function getSharedMixer(): AudioMixer {
  if (typeof window === 'undefined') {
    // SSR: retornar um stub no-op para não estourar import-time.
    return SSR_STUB;
  }
  if (!sharedMixer) {
    sharedMixer = createAudioMixer();
  }
  return sharedMixer;
}

/** Stub SSR-safe (todos métodos no-op). */
const SSR_STUB: AudioMixer = {
  registerSource: () => {},
  unregisterSource: () => {},
  setTrackVolume: () => {},
  setTrackMuted: () => {},
  setTrackSolo: () => {},
  setMasterVolume: () => {},
  setMasterMuted: () => {},
  setClipVolume: () => {},
  setClipMuted: () => {},
  setPan: () => {},
  applyFade: () => {},
  isContextSuspended: () => false,
  resumeContext: async () => {},
  getContext: () => null,
  destroy: () => {},
};

// ----------------------------------------------------------------------------
// Hook
// ----------------------------------------------------------------------------

export interface UseAudioMixerResult {
  registerSource: (
    clipId: string,
    trackId: string,
    mediaElement: HTMLMediaElement,
    audioConfig: ClipAudio,
  ) => void;
  unregisterSource: (clipId: string) => void;
  /** Chamar em handler de gesture (onClick do play). */
  ensureContextResumed: () => Promise<void>;
  /** Aplica fade (in/out) no clipGain de um source registrado. */
  applyFade: (clipId: string, type: 'in' | 'out', durationSec: number) => void;
  /** Acesso ao AudioContext (ex: para sincronizar com outros engines). */
  getContext: () => AudioContext | null;
}

export function useAudioMixer(): UseAudioMixerResult {
  const mixerRef = useRef<AudioMixer | null>(null);
  if (mixerRef.current === null) {
    mixerRef.current = getSharedMixer();
  }
  const mixer = mixerRef.current;

  // -----------------------------------------------------------------------
  // Sincroniza estado do store -> mixer.
  //
  // Subscribe direto na API base do Zustand para evitar re-renders quando
  // somente parâmetros de áudio mudam (mixagem é "side-effect" de áudio).
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!mixer) return;

    // Snapshot inicial: aplica estado atual.
    const initial = useEditorStore.getState().project;
    if (initial) {
      applyProjectAudioState(mixer, initial);
    }

    // Track de hashes para diff cheap.
    let lastTracksKey = projectTracksKey(initial);
    let lastMasterKey = projectMasterKey(initial);

    const unsub = useEditorStore.subscribe((state) => {
      const project = state.project;
      const tracksKey = projectTracksKey(project);
      const masterKey = projectMasterKey(project);

      if (tracksKey !== lastTracksKey) {
        lastTracksKey = tracksKey;
        applyTracksAudioState(mixer, project);
      }
      if (masterKey !== lastMasterKey) {
        lastMasterKey = masterKey;
        applyMasterAudioState(mixer, project);
      }
    });

    return () => {
      unsub();
    };
  }, [mixer]);

  // -----------------------------------------------------------------------
  // API exposta ao caller.
  // -----------------------------------------------------------------------

  const registerSource = useCallback(
    (
      clipId: string,
      trackId: string,
      mediaElement: HTMLMediaElement,
      audioConfig: ClipAudio,
    ) => {
      mixer?.registerSource(clipId, trackId, mediaElement, audioConfig);
    },
    [mixer],
  );

  const unregisterSource = useCallback(
    (clipId: string) => {
      mixer?.unregisterSource(clipId);
    },
    [mixer],
  );

  const ensureContextResumed = useCallback(async () => {
    if (!mixer) return;
    await mixer.resumeContext();
  }, [mixer]);

  const applyFade = useCallback(
    (clipId: string, type: 'in' | 'out', durationSec: number) => {
      mixer?.applyFade(clipId, type, durationSec);
    },
    [mixer],
  );

  const getContext = useCallback(() => {
    return mixer?.getContext() ?? null;
  }, [mixer]);

  return {
    registerSource,
    unregisterSource,
    ensureContextResumed,
    applyFade,
    getContext,
  };
}

// ----------------------------------------------------------------------------
// Helpers internos
// ----------------------------------------------------------------------------

/**
 * Cria string-key a partir do estado de áudio das tracks. Mudou a key →
 * propagamos para o mixer. Inclui id, volume, muted, solo (e visibilidade
 * para futuro uso do mute em "olho" — atualmente o mute visual NÃO afeta
 * áudio, conforme spec).
 */
function projectTracksKey(project: VideoProject | null): string {
  if (!project) return '';
  return project.tracks
    .map(
      (t) =>
        `${t.id}:${t.type}:${'volume' in t ? '' : ''}${(t as Track).muted ? 'M' : ''}${t.solo ? 'S' : ''}`,
    )
    .join('|');
}

function projectMasterKey(project: VideoProject | null): string {
  if (!project) return '';
  return `${project.audioMaster.volume}:${project.audioMaster.muted ? 'M' : ''}`;
}

function applyTracksAudioState(
  mixer: AudioMixer,
  project: VideoProject | null,
): void {
  if (!project) return;
  for (const track of project.tracks) {
    // Volume: o tipo Track no spec não tem volume explícito (apenas muted/
    // solo), então a track herda volume "1" e a granularidade fica no clip.
    // Mantemos o setter pronto caso o tipo evolua. Se a Track ganhar
    // `volume`, ler aqui.
    const trackVol = (track as unknown as { volume?: number }).volume ?? 1;
    mixer.setTrackVolume(track.id, trackVol);
    mixer.setTrackMuted(track.id, track.muted);
    mixer.setTrackSolo(track.id, track.solo);
  }
}

function applyMasterAudioState(
  mixer: AudioMixer,
  project: VideoProject | null,
): void {
  if (!project) return;
  mixer.setMasterVolume(project.audioMaster.volume);
  mixer.setMasterMuted(project.audioMaster.muted);
}

function applyProjectAudioState(
  mixer: AudioMixer,
  project: VideoProject | null,
): void {
  applyTracksAudioState(mixer, project);
  applyMasterAudioState(mixer, project);
}
