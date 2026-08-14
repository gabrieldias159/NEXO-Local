/**
 * Audio Mixer Engine — Web Audio API.
 *
 * Engine puro (sem React) que conecta `<video>` / `<audio>` HTMLMediaElements a
 * um grafo de mixagem multi-track:
 *
 * ```
 *   MediaElementSource(clipA)
 *     -> clipGain (volume + mute do clip + fade in/out)
 *     -> clipPan  (pan do clip, -1..1)
 *           \
 *            -> trackGain (volume + mute + solo da track)
 *                 \
 *                  -> masterGain (volume + mute do projeto)
 *                       \
 *                        -> AudioContext.destination
 * ```
 *
 * Edge cases tratados:
 * - `AudioContext` é lazy-init: alguns browsers (Chrome/Safari) bloqueiam
 *   criação/auto-resume até gesture do usuário. Por isso expomos
 *   `isContextSuspended()` / `resumeContext()`.
 * - `MediaElementSource` só pode ser criado UMA vez por element. Cacheamos
 *   por element (WeakMap-like via Map<HTMLMediaElement, Source>) para evitar
 *   "InvalidStateError" se o caller registrar 2x.
 * - Solo: enquanto QUALQUER track audio tem `solo: true`, todas as não-solo
 *   ficam em gain 0 (independente de muted).
 * - Cleanup: `disconnect()` em todos nodes em `unregisterSource` / `destroy`.
 *
 * Não depende do store — recebe configuração via parâmetros e expõe setters.
 * O hook `useAudioMixer` faz a ponte com Zustand.
 */

import type { ClipAudio } from '../types';

// ============================================================================
// Tipos públicos
// ============================================================================

export interface AudioMixer {
  /**
   * Conecta um HTMLMediaElement ao grafo. Idempotente para o mesmo element
   * (cachea o MediaElementSource). `audioConfig` aplica volume/pan/mute do
   * clip imediatamente.
   *
   * @param clipId   identificador estável do clip (usado para
   *                 `setPan` / `applyFade` e cleanup posterior).
   * @param trackId  track owner — necessário para roteamento via track gain.
   * @param mediaElement HTMLVideoElement ou HTMLAudioElement.
   * @param audioConfig estado audio do clip (volume, muted, pan, fades).
   */
  registerSource(
    clipId: string,
    trackId: string,
    mediaElement: HTMLMediaElement,
    audioConfig: ClipAudio,
  ): void;
  unregisterSource(clipId: string): void;

  /** Volume da track (0..2). >1 amplifica. */
  setTrackVolume(trackId: string, volume: number): void;
  setTrackMuted(trackId: string, muted: boolean): void;
  setTrackSolo(trackId: string, solo: boolean): void;

  /** Volume master (0..2). */
  setMasterVolume(volume: number): void;
  setMasterMuted(muted: boolean): void;

  /** Volume do clip (0..2). */
  setClipVolume(clipId: string, volume: number): void;
  setClipMuted(clipId: string, muted: boolean): void;
  /** Pan do clip (-1 esquerda .. 1 direita). */
  setPan(clipId: string, pan: number): void;

  /**
   * Aplica fade in/out no GainNode do clip a partir do `currentTime` do
   * AudioContext. Usa `linearRampToValueAtTime`.
   */
  applyFade(clipId: string, type: 'in' | 'out', durationSec: number): void;

  /** AudioContext está em estado suspended? (browser policy) */
  isContextSuspended(): boolean;
  /** Resume o AudioContext (chamar em response a gesture do usuário). */
  resumeContext(): Promise<void>;
  /** Acesso ao AudioContext para integração com outros engines. */
  getContext(): AudioContext | null;

  /** Limpa todos os nodes e fecha o AudioContext. */
  destroy(): void;
}

// ============================================================================
// Tipos internos
// ============================================================================

interface ClipNode {
  clipId: string;
  trackId: string;
  /** Source criado para o element; reutilizado se o mesmo element reaparecer. */
  source: MediaElementAudioSourceNode;
  /** Volume + mute do clip (também é o alvo dos fades). */
  clipGain: GainNode;
  pan: StereoPannerNode;
  /** Snapshot do volume "lógico" (sem efeito de mute) — usado para reaplicar
   * após un-mute, reaplicar fades, etc. */
  baseVolume: number;
  muted: boolean;
}

interface TrackNode {
  trackId: string;
  /** Volume + mute + solo da track. */
  gain: GainNode;
  baseVolume: number;
  muted: boolean;
  solo: boolean;
}

// ============================================================================
// Implementação
// ============================================================================

export function createAudioMixer(): AudioMixer {
  // Lazy-init AudioContext.
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let masterBaseVolume = 1;
  let masterMuted = false;

  const tracks = new Map<string, TrackNode>();
  const clips = new Map<string, ClipNode>();
  /**
   * MediaElementSourceNode é "one shot" por element — manter cache para
   * permitir re-register idempotente.
   */
  const sourceByElement = new Map<HTMLMediaElement, MediaElementAudioSourceNode>();

  // -------- helpers internos -----------------------------------------------

  function ensureContext(): AudioContext {
    if (ctx && masterGain) return ctx;
    const Ctor: typeof AudioContext | undefined =
      typeof window !== 'undefined'
        ? (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext)
        : undefined;
    if (!Ctor) {
      throw new Error(
        '[audio-mixer] Web Audio API indisponível neste ambiente.',
      );
    }
    ctx = new Ctor();
    masterGain = ctx.createGain();
    masterGain.gain.value = effectiveMasterGain();
    masterGain.connect(ctx.destination);
    return ctx;
  }

  function effectiveMasterGain(): number {
    return masterMuted ? 0 : clamp(masterBaseVolume, 0, 2);
  }

  /** Há alguma track em solo? */
  function anySolo(): boolean {
    for (const t of tracks.values()) {
      if (t.solo) return true;
    }
    return false;
  }

  /** Calcula gain efetivo de uma track considerando solo global. */
  function effectiveTrackGain(track: TrackNode): number {
    if (track.muted) return 0;
    if (anySolo() && !track.solo) return 0;
    return clamp(track.baseVolume, 0, 2);
  }

  /** Recalcula gain de TODAS as tracks (chamar quando solo muda). */
  function refreshAllTrackGains(): void {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const t of tracks.values()) {
      // Cancelar agendamentos pendentes para não brigar com fades de track.
      t.gain.gain.cancelScheduledValues(now);
      t.gain.gain.setValueAtTime(effectiveTrackGain(t), now);
    }
  }

  /** Garante que existe um TrackNode para o trackId — criar lazily. */
  function ensureTrackNode(trackId: string): TrackNode {
    let t = tracks.get(trackId);
    if (t) return t;
    const c = ensureContext();
    const gain = c.createGain();
    gain.connect(masterGain!);
    t = {
      trackId,
      gain,
      baseVolume: 1,
      muted: false,
      solo: false,
    };
    gain.gain.value = effectiveTrackGain(t);
    tracks.set(trackId, t);
    return t;
  }

  function effectiveClipGain(clip: ClipNode): number {
    if (clip.muted) return 0;
    return clamp(clip.baseVolume, 0, 2);
  }

  // -------- API pública ----------------------------------------------------

  function registerSource(
    clipId: string,
    trackId: string,
    mediaElement: HTMLMediaElement,
    audioConfig: ClipAudio,
  ): void {
    // Se já registrado, atualiza estado e segue.
    const existing = clips.get(clipId);
    if (existing) {
      // Caso o trackId tenha mudado, religar.
      if (existing.trackId !== trackId) {
        try {
          existing.pan.disconnect();
        } catch {
          // pan pode já estar desconectado em alguns paths — ignore
        }
        const newTrack = ensureTrackNode(trackId);
        existing.pan.connect(newTrack.gain);
        existing.trackId = trackId;
      }
      // Atualiza volume/mute/pan.
      existing.baseVolume = audioConfig.volume;
      existing.muted = audioConfig.muted;
      const c = ensureContext();
      existing.clipGain.gain.cancelScheduledValues(c.currentTime);
      existing.clipGain.gain.setValueAtTime(
        effectiveClipGain(existing),
        c.currentTime,
      );
      existing.pan.pan.setValueAtTime(
        clamp(audioConfig.pan, -1, 1),
        c.currentTime,
      );
      return;
    }

    const c = ensureContext();
    const trackNode = ensureTrackNode(trackId);

    // Reutiliza source existente para o element ou cria.
    let source = sourceByElement.get(mediaElement);
    if (!source) {
      try {
        source = c.createMediaElementSource(mediaElement);
        sourceByElement.set(mediaElement, source);
      } catch (err) {
        // MediaElementSource só permite uma instância por element em todo o
        // documento. Se outro AudioContext já o "consumiu", não dá pra
        // recuperar — log e desiste.
        console.error(
          '[audio-mixer] não foi possível criar MediaElementSource:',
          err,
        );
        return;
      }
    }

    const clipGain = c.createGain();
    const pan = c.createStereoPanner();

    source.connect(clipGain);
    clipGain.connect(pan);
    pan.connect(trackNode.gain);

    const node: ClipNode = {
      clipId,
      trackId,
      source,
      clipGain,
      pan,
      baseVolume: audioConfig.volume,
      muted: audioConfig.muted,
    };
    clipGain.gain.value = effectiveClipGain(node);
    pan.pan.value = clamp(audioConfig.pan, -1, 1);

    clips.set(clipId, node);
  }

  function unregisterSource(clipId: string): void {
    const node = clips.get(clipId);
    if (!node) return;
    try {
      node.pan.disconnect();
    } catch {
      // ok
    }
    try {
      node.clipGain.disconnect();
    } catch {
      // ok
    }
    try {
      // Source pode ser compartilhado se element for reutilizado por outro
      // clip — mas no nosso modelo, cada clip tem element próprio (um
      // <video>/<audio> "oculto" criado pelo video-sync engine). Mesmo
      // assim, só desconectamos o source se este clip for o último que o
      // usa.
      const stillUsed = Array.from(clips.values()).some(
        (c) => c.clipId !== clipId && c.source === node.source,
      );
      if (!stillUsed) {
        node.source.disconnect();
        // Procura o element no cache reverso para limpar.
        for (const [el, src] of sourceByElement.entries()) {
          if (src === node.source) {
            sourceByElement.delete(el);
            break;
          }
        }
      }
    } catch {
      // ok
    }
    clips.delete(clipId);
  }

  function setTrackVolume(trackId: string, volume: number): void {
    const t = ensureTrackNode(trackId);
    t.baseVolume = volume;
    if (!ctx) return;
    t.gain.gain.cancelScheduledValues(ctx.currentTime);
    t.gain.gain.setValueAtTime(effectiveTrackGain(t), ctx.currentTime);
  }

  function setTrackMuted(trackId: string, muted: boolean): void {
    const t = ensureTrackNode(trackId);
    t.muted = muted;
    if (!ctx) return;
    t.gain.gain.cancelScheduledValues(ctx.currentTime);
    t.gain.gain.setValueAtTime(effectiveTrackGain(t), ctx.currentTime);
  }

  function setTrackSolo(trackId: string, solo: boolean): void {
    const t = ensureTrackNode(trackId);
    const wasSolo = t.solo;
    t.solo = solo;
    if (wasSolo === solo) return;
    refreshAllTrackGains();
  }

  function setMasterVolume(volume: number): void {
    masterBaseVolume = volume;
    if (!masterGain || !ctx) return;
    masterGain.gain.cancelScheduledValues(ctx.currentTime);
    masterGain.gain.setValueAtTime(effectiveMasterGain(), ctx.currentTime);
  }

  function setMasterMuted(muted: boolean): void {
    masterMuted = muted;
    if (!masterGain || !ctx) return;
    masterGain.gain.cancelScheduledValues(ctx.currentTime);
    masterGain.gain.setValueAtTime(effectiveMasterGain(), ctx.currentTime);
  }

  function setClipVolume(clipId: string, volume: number): void {
    const node = clips.get(clipId);
    if (!node) return;
    node.baseVolume = volume;
    if (!ctx) return;
    node.clipGain.gain.cancelScheduledValues(ctx.currentTime);
    node.clipGain.gain.setValueAtTime(
      effectiveClipGain(node),
      ctx.currentTime,
    );
  }

  function setClipMuted(clipId: string, muted: boolean): void {
    const node = clips.get(clipId);
    if (!node) return;
    node.muted = muted;
    if (!ctx) return;
    node.clipGain.gain.cancelScheduledValues(ctx.currentTime);
    node.clipGain.gain.setValueAtTime(
      effectiveClipGain(node),
      ctx.currentTime,
    );
  }

  function setPan(clipId: string, pan: number): void {
    const node = clips.get(clipId);
    if (!node) return;
    if (!ctx) return;
    node.pan.pan.setValueAtTime(clamp(pan, -1, 1), ctx.currentTime);
  }

  function applyFade(
    clipId: string,
    type: 'in' | 'out',
    durationSec: number,
  ): void {
    const node = clips.get(clipId);
    if (!node || !ctx) return;
    const target = effectiveClipGain(node);
    const dur = Math.max(0.001, durationSec);
    const now = ctx.currentTime;
    const gain = node.clipGain.gain;
    // Cancela qualquer ramp prévio para evitar acumulação.
    gain.cancelScheduledValues(now);
    if (type === 'in') {
      gain.setValueAtTime(0, now);
      gain.linearRampToValueAtTime(target, now + dur);
    } else {
      gain.setValueAtTime(target, now);
      gain.linearRampToValueAtTime(0, now + dur);
    }
  }

  function isContextSuspended(): boolean {
    return !!ctx && ctx.state === 'suspended';
  }

  async function resumeContext(): Promise<void> {
    const c = ensureContext();
    if (c.state === 'suspended') {
      await c.resume();
    }
  }

  function getContext(): AudioContext | null {
    return ctx;
  }

  function destroy(): void {
    // Disconnect todos os clips.
    for (const id of Array.from(clips.keys())) {
      unregisterSource(id);
    }
    // Disconnect tracks.
    for (const t of tracks.values()) {
      try {
        t.gain.disconnect();
      } catch {
        // ok
      }
    }
    tracks.clear();
    sourceByElement.clear();
    if (masterGain) {
      try {
        masterGain.disconnect();
      } catch {
        // ok
      }
      masterGain = null;
    }
    if (ctx) {
      // close() retorna Promise — não awaitamos pois destroy é sync.
      ctx.close().catch(() => {
        // ignore
      });
      ctx = null;
    }
  }

  return {
    registerSource,
    unregisterSource,
    setTrackVolume,
    setTrackMuted,
    setTrackSolo,
    setMasterVolume,
    setMasterMuted,
    setClipVolume,
    setClipMuted,
    setPan,
    applyFade,
    isContextSuspended,
    resumeContext,
    getContext,
    destroy,
  };
}

// ============================================================================
// Util
// ============================================================================

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
