/**
 * Video Sync Engine — Fase 2 do Suite Editor de Vídeos.
 *
 * Núcleo lógico (sem React) que sincroniza múltiplos elementos `<video>` ao
 * playhead virtual da timeline. Cada `<video>` toca o trecho do asset
 * correspondente ao tempo do clip; clips fora do intervalo ficam pausados.
 *
 * Conceitos:
 * - Tempo na timeline (s): posição absoluta do projeto.
 * - Tempo no asset (s): `clip.startInAsset + (timelineSec - clip.startInTimeline) * clip.playbackRate`.
 * - Drift correction: a cada frame, `video.currentTime` esperado vs real;
 *   se distância > threshold (default 0.1s), faz re-seek.
 * - Pre-warm: 1s antes do clip ativar, ajusta `preload='auto'` e seek inicial
 *   para ter o frame pronto.
 *
 * Não usa React aqui — o hook em `use-video-sync.ts` conecta o store.
 */
import type { Clip } from '../types';

// ============================================================================
// Tipos públicos
// ============================================================================

export interface VideoSyncManager {
  /** Registra um `<video>` associado a um `Clip`. Substitui registro anterior. */
  registerVideo(clipId: string, video: HTMLVideoElement, clip: Clip): void;
  /**
   * Atualiza o snapshot do `Clip` de um vídeo já registrado (ex.: mudança de
   * `playbackRate`, trim, transform) SEM re-anexar o elemento — evita flicker.
   * Re-aplica o rate efetivo e re-sincroniza. Noop se o clip não estiver
   * registrado.
   */
  updateClip(clipId: string, clip: Clip): void;
  /** Remove registro (cancela seeks pendentes; pausa o vídeo). */
  unregisterVideo(clipId: string): void;
  /** Alinha todos os vídeos com o tempo dado. */
  seekAll(timelineSec: number): void;
  /** `.play()` em todos os vídeos atualmente ativos para o playhead corrente. */
  playAll(): Promise<void>;
  /** Pausa todos os vídeos registrados. */
  pauseAll(): void;
  /** Define `playbackRate` no Engine (multiplicador global aplicado ao clip rate). */
  setPlaybackRate(rate: number): void;
  /** Diferença em ms entre `expectedCurrentTime` e `video.currentTime` real. */
  getDriftMs(clipId: string): number;
  /** Cancela rAF, limpa registros e libera referências. */
  destroy(): void;
}

export interface CreateVideoSyncManagerOpts {
  /**
   * Callback chamado a cada tick (rAF / requestVideoFrameCallback). Recebe o
   * tempo da timeline calculado pelo motor (delta entre frames * rate).
   * Use para empurrar `setPlayhead` no store quando o engine estiver tocando.
   */
  onTick?: (timelineSec: number) => void;
  /**
   * Distância máxima em segundos entre `expectedTime` e `video.currentTime`
   * antes de forçar re-seek. Default 0.1s.
   */
  driftThresholdSec?: number;
  /**
   * Janela em segundos antes do clip ativar para pré-aquecer (`preload='auto'`
   * e seek para o ponto inicial do trim). Default 1s.
   */
  prewarmWindowSec?: number;
  /**
   * Tolerância em segundos para considerar o final do clip (evita "tocar" o
   * último frame de um clip já fora). Default 0.02s (~ 1 frame a 60fps).
   */
  endToleranceSec?: number;
}

// ============================================================================
// Internal
// ============================================================================

interface RegisteredVideo {
  clipId: string;
  video: HTMLVideoElement;
  clip: Clip;
  /** Último timestamp em que driver foi chamado para este vídeo (ms perf). */
  lastSyncMs: number;
  /** Último tempo esperado calculado no asset, em segundos. */
  lastExpectedAssetSec: number;
  /** Já fez pre-warm para este clip (reset ao seekAll fora da janela). */
  prewarmed: boolean;
  /**
   * Cancel handle de `requestVideoFrameCallback` (se suportado). Usamos no
   * cleanup. rAF central já trata de drift; rVFC é opcional para precisão.
   */
  rvfcHandle?: number;
}

interface VideoFrameLikeWindow {
  HTMLVideoElement: {
    prototype: { requestVideoFrameCallback?: unknown };
  };
}

/** Verifica suporte a `requestVideoFrameCallback`. */
function hasRequestVideoFrameCallback(): boolean {
  if (typeof window === 'undefined') return false;
  const proto = (window as unknown as VideoFrameLikeWindow).HTMLVideoElement
    ?.prototype;
  return typeof proto?.requestVideoFrameCallback === 'function';
}

/** Calcula o tempo esperado dentro do asset para um clip dado o playhead. */
function computeExpectedAssetTime(clip: Clip, timelineSec: number): number {
  const offsetTl = timelineSec - clip.startInTimeline;
  const rate = clip.playbackRate || 1;
  const t = clip.startInAsset + offsetTl * rate;
  // Clamp dentro do intervalo do asset trim para não escapar para fora.
  if (t < clip.startInAsset) return clip.startInAsset;
  if (t > clip.endInAsset) return clip.endInAsset;
  return t;
}

/** Clip está ativo se o playhead está dentro do intervalo da timeline dele. */
function isClipActiveAt(
  clip: Clip,
  timelineSec: number,
  endTolerance: number,
): boolean {
  return (
    timelineSec >= clip.startInTimeline &&
    timelineSec < clip.endInTimeline - endTolerance
  );
}

/** Tenta `play()` ignorando `AbortError` (mudança rápida de play/pause). */
async function safePlay(video: HTMLVideoElement): Promise<void> {
  try {
    await video.play();
  } catch (err) {
    // Browsers lançam AbortError se um pause acontece antes do play resolver.
    // Também NotAllowedError pode acontecer (autoplay) — silenciar pois o
    // engine reage à intenção do usuário (clique no play).
    const name = (err as { name?: string } | null)?.name;
    if (name && name !== 'AbortError' && name !== 'NotAllowedError') {
      // eslint-disable-next-line no-console
      console.warn('[video-sync] play() falhou:', err);
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createVideoSyncManager(
  opts: CreateVideoSyncManagerOpts = {},
): VideoSyncManager {
  const driftThreshold = opts.driftThresholdSec ?? 0.1;
  const prewarmWindow = opts.prewarmWindowSec ?? 1;
  const endTolerance = opts.endToleranceSec ?? 0.02;
  const onTick = opts.onTick;

  /** Estado do engine. */
  const videos = new Map<string, RegisteredVideo>();
  /** Playhead corrente (timeline, em segundos). Atualizado via seekAll/tick. */
  let timelineSec = 0;
  /** Multiplicador global de velocidade (default 1). */
  let globalRate = 1;
  /** Engine está tocando? Reflete chamada explícita a play/pauseAll. */
  let isPlaying = false;
  /** Handle do rAF principal. */
  let rafHandle = 0;
  /** Timestamp do último tick em ms (performance.now). */
  let lastFrameMs = 0;
  /** Flag para destruição — evita re-agendar rAF após destroy. */
  let destroyed = false;

  const supportsRvfc = hasRequestVideoFrameCallback();

  // -- helpers ---------------------------------------------------------------

  /** Pausa um único vídeo silenciosamente. */
  function pauseVideo(v: HTMLVideoElement): void {
    if (!v.paused) {
      try {
        v.pause();
      } catch {
        // ignore
      }
    }
  }

  /** Aplica `playbackRate` efetivo no element (clip * global). */
  function applyEffectiveRate(reg: RegisteredVideo): void {
    const target = (reg.clip.playbackRate || 1) * globalRate;
    if (Math.abs(reg.video.playbackRate - target) > 0.001) {
      reg.video.playbackRate = target;
    }
  }

  /**
   * Sincroniza o estado de UM vídeo com o playhead atual.
   * - Se ativo: ajusta `currentTime` se drift, garante play se isPlaying.
   * - Se inativo: pausa. Se dentro da janela de prewarm, pré-aquece.
   */
  function syncOne(reg: RegisteredVideo): void {
    const { clip, video } = reg;
    reg.lastSyncMs = performance.now();

    const active = isClipActiveAt(clip, timelineSec, endTolerance);
    if (active) {
      const expected = computeExpectedAssetTime(clip, timelineSec);
      reg.lastExpectedAssetSec = expected;
      reg.prewarmed = true; // já está ativo, pre-warm é trivialmente "feito".

      // Drift correction: só seek se vídeo já tem dados e drift > threshold.
      // readyState >= 1 (HAVE_METADATA) garante que setar currentTime é seguro.
      if (video.readyState >= 1) {
        const drift = Math.abs(video.currentTime - expected);
        if (drift > driftThreshold) {
          try {
            video.currentTime = expected;
          } catch {
            // alguns browsers reclamam se o elemento ainda não está pronto
            // mesmo com readyState >= 1 — silenciar.
          }
        }
      }

      applyEffectiveRate(reg);

      if (isPlaying) {
        if (video.paused) {
          void safePlay(video);
        }
      } else {
        pauseVideo(video);
      }
    } else {
      // Pausa se não estiver ativo.
      pauseVideo(video);

      // Pre-warm: clip vai ativar em <= prewarmWindow segundos?
      const distanceToStart = clip.startInTimeline - timelineSec;
      if (
        distanceToStart > 0 &&
        distanceToStart <= prewarmWindow &&
        !reg.prewarmed
      ) {
        if (video.preload !== 'auto') {
          video.preload = 'auto';
        }
        // Seek para o ponto inicial do trim, se possível.
        if (video.readyState >= 1) {
          try {
            const target = clip.startInAsset;
            if (Math.abs(video.currentTime - target) > 0.05) {
              video.currentTime = target;
            }
          } catch {
            // ignore
          }
        }
        reg.prewarmed = true;
      } else if (distanceToStart > prewarmWindow) {
        // Saímos da janela — reset da flag para próximo pre-warm.
        reg.prewarmed = false;
      }
    }
  }

  /** Sincroniza todos os vídeos com o playhead corrente. */
  function syncAll(): void {
    for (const reg of videos.values()) {
      syncOne(reg);
    }
  }

  // -- rAF loop --------------------------------------------------------------

  function tick(now: number): void {
    if (destroyed) return;
    const deltaMs = lastFrameMs === 0 ? 0 : now - lastFrameMs;
    lastFrameMs = now;

    if (isPlaying && deltaMs > 0) {
      // Avança o relógio interno; consumidor recebe via onTick e empurra o
      // store. O próprio engine não escreve no store — mantém pureza.
      timelineSec = timelineSec + (deltaMs / 1000) * globalRate;
      onTick?.(timelineSec);
      syncAll();
    }

    rafHandle = requestAnimationFrame(tick);
  }

  // Inicia o loop apenas em ambiente browser.
  if (typeof requestAnimationFrame === 'function') {
    rafHandle = requestAnimationFrame(tick);
  }

  // -- API pública -----------------------------------------------------------

  function registerVideo(
    clipId: string,
    video: HTMLVideoElement,
    clip: Clip,
  ): void {
    // Substitui registro anterior, se existir.
    const previous = videos.get(clipId);
    if (previous && previous.video !== video) {
      pauseVideo(previous.video);
    }

    const reg: RegisteredVideo = {
      clipId,
      video,
      clip,
      lastSyncMs: 0,
      lastExpectedAssetSec: clip.startInAsset,
      prewarmed: false,
    };
    videos.set(clipId, reg);

    // Hint inicial de carregamento — vídeos em clips muito longe ficam
    // metadata-only para economizar banda; o pre-warm troca para 'auto'.
    if (!video.preload) {
      video.preload = 'metadata';
    }
    applyEffectiveRate(reg);

    // Hook de `requestVideoFrameCallback` para ajuste fino quando suportado.
    if (supportsRvfc) {
      type RVFCMethod = (cb: () => void) => number;
      const rvfc = (video as HTMLVideoElement & {
        requestVideoFrameCallback?: RVFCMethod;
      }).requestVideoFrameCallback;
      if (rvfc) {
        const cb = (): void => {
          const current = videos.get(clipId);
          if (!current || current.video !== video) return;
          // Em cada frame de vídeo, valida drift novamente (apenas se ativo).
          if (isClipActiveAt(current.clip, timelineSec, endTolerance)) {
            const expected = computeExpectedAssetTime(
              current.clip,
              timelineSec,
            );
            const drift = Math.abs(video.currentTime - expected);
            if (drift > driftThreshold && video.readyState >= 1) {
              try {
                video.currentTime = expected;
              } catch {
                // ignore
              }
            }
          }
          // Re-arma para o próximo frame.
          if (!destroyed && videos.get(clipId) === current) {
            current.rvfcHandle = rvfc.call(video, cb);
          }
        };
        reg.rvfcHandle = rvfc.call(video, cb);
      }
    }

    // Sync imediato para o estado atual.
    syncOne(reg);
  }

  function updateClip(clipId: string, clip: Clip): void {
    const reg = videos.get(clipId);
    if (!reg) return;
    reg.clip = clip;
    applyEffectiveRate(reg);
    // Re-sincroniza com o tempo atual para corrigir drift causado pela
    // mudança de rate (currentTime esperado muda).
    syncOne(reg);
  }

  function unregisterVideo(clipId: string): void {
    const reg = videos.get(clipId);
    if (!reg) return;
    pauseVideo(reg.video);
    // Não há cancelVideoFrameCallback universal; o callback se auto-extingue
    // ao detectar `videos.get(clipId) !== current`.
    videos.delete(clipId);
  }

  function seekAll(newTimelineSec: number): void {
    timelineSec = Math.max(0, newTimelineSec);
    syncAll();
  }

  async function playAll(): Promise<void> {
    isPlaying = true;
    lastFrameMs = 0; // reset delta para próximo tick.
    const promises: Promise<void>[] = [];
    for (const reg of videos.values()) {
      const active = isClipActiveAt(reg.clip, timelineSec, endTolerance);
      if (active) {
        applyEffectiveRate(reg);
        if (reg.video.paused) {
          promises.push(safePlay(reg.video));
        }
      }
    }
    await Promise.all(promises);
  }

  function pauseAll(): void {
    isPlaying = false;
    for (const reg of videos.values()) {
      pauseVideo(reg.video);
    }
  }

  function setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    globalRate = rate;
    for (const reg of videos.values()) {
      applyEffectiveRate(reg);
    }
  }

  function getDriftMs(clipId: string): number {
    const reg = videos.get(clipId);
    if (!reg) return 0;
    if (!isClipActiveAt(reg.clip, timelineSec, endTolerance)) return 0;
    const expected = computeExpectedAssetTime(reg.clip, timelineSec);
    return Math.abs(reg.video.currentTime - expected) * 1000;
  }

  function destroy(): void {
    destroyed = true;
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    }
    for (const reg of videos.values()) {
      pauseVideo(reg.video);
    }
    videos.clear();
  }

  return {
    registerVideo,
    updateClip,
    unregisterVideo,
    seekAll,
    playAll,
    pauseAll,
    setPlaybackRate,
    getDriftMs,
    destroy,
  };
}
