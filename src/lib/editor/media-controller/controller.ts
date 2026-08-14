'use client';

/**
 * MediaController — orquestrador central do player.
 *
 * Para cada `<video>` anexado:
 *  - Escuta eventos nativos (loadstart, loadedmetadata, canplay, waiting,
 *    stalled, error, progress, playing, pause).
 *  - Atualiza a maquina de estados no store.
 *  - Programa watchdogs (loadTimeout + stallTimeout).
 *  - No erro/stall, agenda retry com backoff exponencial e (opcional)
 *    renova o downloadURL via UrlProvider.
 *
 * Singleton: use `getMediaController()` ao inves de instanciar diretamente.
 */

import { useMediaControllerStore } from './store';
import type {
  MediaControllerConfig,
  MediaEvent,
  MediaEventKind,
  MediaState,
  UrlProvider,
} from './types';
import { DEFAULT_CONFIG } from './types';

interface Slot {
  /**
   * Chave UNICA do slot no Map/store. Eh o `clipId` (globalmente unico por
   * clip da timeline) — NUNCA o `assetId`, pois varios clips compartilham o
   * mesmo asset (ex.: split-screen usando o mesmo recorte em cima/embaixo,
   * ou duplicate/split/paste que reaproveitam o `assetId`). Keyar por asset
   * fazia o 2o `<video>` roubar o slot do 1o.
   */
  key: string;
  /** Metadado: asset por tras desse clip (logging / resolucao de URL). */
  assetId: string;
  clipId?: string;
  videoEl: HTMLVideoElement;
  urlProvider: UrlProvider;
  /** Listener handlers para podermos remover no detach. */
  handlers: Map<string, EventListener>;
  /** Timer do loadTimeout. */
  loadTimer: number | null;
  /** Timer do stallTimeout. */
  stallTimer: number | null;
  /** Timer do retry agendado. */
  retryTimer: number | null;
  retries: number;
  /** URL atualmente em uso (pra detectar se algo externo trocou o src). */
  currentUrl: string | null;
  /** Quando atingiu canplay nesse ciclo. */
  reachedCanplay: boolean;
  /** Pra evitar retries em cascata. */
  retryInFlight: boolean;
}

export class MediaController {
  private slots = new Map<string, Slot>();
  private config: MediaControllerConfig;

  constructor(config: Partial<MediaControllerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Anexa um `<video>` ao controller. O controller passa a gerenciar o
   * src/lifecycle desse elemento. Se ja havia um slot para a mesma chave
   * (`clipId`), substitui (limpa o antigo).
   *
   * A chave do slot eh o `clipId` (unico por clip), NAO o `assetId`. Assim
   * dois clips do mesmo asset (split-screen, duplicate/split/paste) coexistem
   * sem roubar o slot um do outro.
   *
   * O caller NAO seta o `src` manualmente — o controller chama
   * `urlProvider()` e seta. Isso permite refresh no retry.
   */
  async attach(opts: {
    assetId: string;
    clipId?: string;
    videoEl: HTMLVideoElement;
    urlProvider: UrlProvider;
  }): Promise<void> {
    const { assetId, clipId, videoEl, urlProvider } = opts;
    // Chave do slot: clipId (unico). Fallback p/ assetId apenas se o clipId
    // estiver realmente ausente (nao deveria acontecer em video layers) — assim
    // nunca crashamos com chave undefined.
    const key = clipId ?? assetId;
    // Se ja existe um slot pra essa chave, detacha primeiro pra evitar
    // listeners duplicados.
    if (this.slots.has(key)) {
      this.detach(key);
    }

    const slot: Slot = {
      key,
      assetId,
      clipId,
      videoEl,
      urlProvider,
      handlers: new Map(),
      loadTimer: null,
      stallTimer: null,
      retryTimer: null,
      retries: 0,
      currentUrl: null,
      reachedCanplay: false,
      retryInFlight: false,
    };
    this.slots.set(key, slot);

    this.installListeners(slot);
    this.setStatus(slot, {
      state: 'idle',
      retries: 0,
      attachedAt: Date.now(),
    });
    this.log(slot, 'attached', { state: 'idle' });

    // Carrega a URL inicial.
    await this.loadCurrentUrl(slot);
  }

  /**
   * Desanexa um slot pela chave (`clipId`). Remove listeners, cancela timers,
   * e remove do store.
   */
  detach(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.clearAllTimers(slot);
    for (const [event, handler] of slot.handlers) {
      slot.videoEl.removeEventListener(event, handler);
    }
    slot.handlers.clear();
    this.slots.delete(key);
    this.log(slot, 'detached');
    useMediaControllerStore.getState().removeStatus(key);
  }

  /**
   * Forca um retry manual (pra botao "tentar de novo" na UI). Recebe a chave
   * do slot (`clipId`), igual a usada no store.
   */
  retryManually(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.retries = 0; // reseta contador
    this.scheduleRetry(slot, 0, 'manual');
  }

  // ============================================================================
  // Listeners e maquina de estados
  // ============================================================================

  private installListeners(slot: Slot): void {
    const { videoEl } = slot;

    const on = (name: string, fn: () => void) => {
      const handler = fn as EventListener;
      videoEl.addEventListener(name, handler);
      slot.handlers.set(name, handler);
    };

    on('loadstart', () => {
      this.clearStallTimer(slot);
      this.setStatus(slot, { state: 'loading' });
      this.log(slot, 'state', { state: 'loading' });
      this.armLoadTimer(slot);
    });

    on('loadedmetadata', () => {
      this.setStatus(slot, {
        duration: isFinite(videoEl.duration) ? videoEl.duration : undefined,
      });
    });

    on('canplay', () => {
      slot.reachedCanplay = true;
      this.clearLoadTimer(slot);
      this.clearStallTimer(slot);
      // A midia se curou: cancela qualquer retry pendente (senao o load() do
      // retry dispararia mesmo com o video ja pronto, zerando currentTime e
      // descartando o buffer). canplay = falhas consecutivas zeradas.
      this.clearRetryTimer(slot);
      slot.retryInFlight = false;
      slot.retries = 0;
      this.setStatus(slot, {
        state: 'ready',
        readyAt: Date.now(),
      });
      this.log(slot, 'ready', { state: 'ready' });
    });

    on('playing', () => {
      this.clearStallTimer(slot);
      // Tocando = recuperado: cancela retry pendente p/ nao recarregar por cima.
      this.clearRetryTimer(slot);
      slot.retryInFlight = false;
      this.setStatus(slot, { state: 'playing' });
    });

    on('pause', () => {
      // Nao sobrescreve estados de erro/buffering.
      const cur = useMediaControllerStore.getState().statuses[slot.key];
      if (cur?.state === 'playing' || cur?.state === 'ready') {
        this.setStatus(slot, { state: 'paused' });
      }
    });

    on('waiting', () => {
      this.setStatus(slot, { state: 'buffering' });
      this.armStallTimer(slot);
    });

    on('stalled', () => {
      this.log(slot, 'stall-detected', {
        readyState: videoEl.readyState,
        networkState: videoEl.networkState,
      });
      this.armStallTimer(slot);
    });

    on('progress', () => {
      // Sinal de vida: progresso de buffer cancela o stall watchdog atual.
      this.clearStallTimer(slot);
      const buf = videoEl.buffered;
      const end = buf.length > 0 ? buf.end(buf.length - 1) : undefined;
      this.setStatus(slot, { bufferedEnd: end });
    });

    on('error', () => {
      const err = videoEl.error;
      const message = mediaErrorMessage(err);
      this.log(slot, 'error', {
        error: { code: err?.code, message },
        state: 'error',
      });
      this.handleErrorOrStall(slot, message);
    });
  }

  /**
   * True se `slot` ainda e o slot ATUAL para sua chave. Apos um `await`, o slot
   * pode ter sido removido (detach) ou substituido por um novo (re-attach na
   * mesma chave) — nesse caso a continuacao adiada NAO deve mexer no elemento.
   */
  private isCurrent(slot: Slot): boolean {
    return this.slots.get(slot.key) === slot;
  }

  /**
   * Carrega/recarrega o asset chamando o urlProvider. Se a URL mudou,
   * atualiza `video.src` e chama `load()`.
   */
  private async loadCurrentUrl(slot: Slot): Promise<void> {
    let url: string | null;
    try {
      url = await Promise.resolve(slot.urlProvider());
    } catch (err) {
      if (!this.isCurrent(slot)) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.log(slot, 'error', {
        error: { message: `urlProvider falhou: ${msg}` },
      });
      this.giveUp(slot, `urlProvider falhou: ${msg}`);
      return;
    }

    // urlProvider e async: se o slot foi desanexado/recriado durante o await
    // (troca rapida de clip, asset blob->firebase ao concluir upload, StrictMode),
    // a continuacao velha NAO deve setar src/load — senao aborta o load do slot
    // novo (MEDIA_ERR_ABORTED / tela preta).
    if (!this.isCurrent(slot)) return;

    if (!url) {
      this.giveUp(slot, 'urlProvider retornou null');
      return;
    }

    slot.currentUrl = url;
    slot.reachedCanplay = false;
    this.setStatus(slot, { url });

    if (slot.videoEl.src !== url) {
      slot.videoEl.src = url;
    }
    // load() forca reset do pipeline (necessario apos retry).
    try {
      slot.videoEl.load();
    } catch {
      /* alguns navegadores throw em load() durante seek — ignorar */
    }
  }

  private async refreshUrl(slot: Slot): Promise<boolean> {
    try {
      const newUrl = await Promise.resolve(slot.urlProvider());
      if (!this.isCurrent(slot)) return false;
      if (!newUrl) return false;
      this.setStatus(slot, {
        url: newUrl,
        urlRefreshedAt: Date.now(),
      });
      this.log(slot, 'url-refresh', { url: newUrl });
      slot.currentUrl = newUrl;
      if (slot.videoEl.src !== newUrl) {
        slot.videoEl.src = newUrl;
      }
      return true;
    } catch (err) {
      this.log(slot, 'url-refresh', {
        message:
          'falha ao renovar URL: ' +
          (err instanceof Error ? err.message : String(err)),
      });
      return false;
    }
  }

  // ============================================================================
  // Retry/backoff
  // ============================================================================

  private handleErrorOrStall(slot: Slot, reason: string): void {
    if (slot.retryInFlight) return;
    if (slot.retries >= this.config.maxRetries) {
      this.giveUp(slot, reason);
      return;
    }
    const delay = Math.min(
      this.config.maxBackoffMs,
      this.config.baseBackoffMs * Math.pow(2, slot.retries),
    );
    this.setStatus(slot, {
      state: 'error',
      lastError: reason,
    });
    this.scheduleRetry(slot, delay, reason);
  }

  private scheduleRetry(slot: Slot, delayMs: number, reason: string): void {
    slot.retryInFlight = true;
    this.clearRetryTimer(slot);
    this.log(slot, 'retry', {
      message: `retry agendado em ${delayMs}ms (razao: ${reason}); tentativa ${
        slot.retries + 1
      }/${this.config.maxRetries}`,
    });
    slot.retryTimer = window.setTimeout(async () => {
      slot.retryTimer = null;
      // Slot pode ter sido desanexado/recriado entre agendar e disparar.
      if (!this.isCurrent(slot)) return;
      slot.retries++;
      this.setStatus(slot, {
        retries: slot.retries,
        state: 'loading',
      });
      // Renova URL a partir da 2a tentativa (se config permitir).
      if (
        this.config.refreshUrlOnRetry &&
        slot.retries >= 1 // refresh inclusive na 1a re-tentativa
      ) {
        await this.refreshUrl(slot);
      }
      // Re-checa apos o await do refresh antes de tocar no elemento.
      if (!this.isCurrent(slot)) return;
      // Recarrega o pipeline.
      try {
        slot.videoEl.load();
      } catch {
        /* ignore */
      }
      slot.retryInFlight = false;
      this.armLoadTimer(slot);
    }, delayMs);
  }

  private giveUp(slot: Slot, reason: string): void {
    this.clearAllTimers(slot);
    this.setStatus(slot, {
      state: 'failed',
      lastError: reason,
    });
    this.log(slot, 'state', {
      state: 'failed',
      message: `desistiu apos ${slot.retries} tentativas: ${reason}`,
    });
  }

  // ============================================================================
  // Watchdogs
  // ============================================================================

  private armLoadTimer(slot: Slot): void {
    this.clearLoadTimer(slot);
    slot.loadTimer = window.setTimeout(() => {
      slot.loadTimer = null;
      if (slot.reachedCanplay) return;
      this.log(slot, 'load-timeout', {
        message: `sem canplay em ${this.config.loadTimeoutMs}ms`,
      });
      this.handleErrorOrStall(
        slot,
        `timeout de carregamento (${this.config.loadTimeoutMs}ms)`,
      );
    }, this.config.loadTimeoutMs);
  }

  private armStallTimer(slot: Slot): void {
    this.clearStallTimer(slot);
    slot.stallTimer = window.setTimeout(() => {
      slot.stallTimer = null;
      this.log(slot, 'stall-detected', {
        message: `buffering > ${this.config.stallTimeoutMs}ms — escalando pra retry`,
      });
      this.handleErrorOrStall(
        slot,
        `stall durante playback (${this.config.stallTimeoutMs}ms sem progresso)`,
      );
    }, this.config.stallTimeoutMs);
  }

  private clearLoadTimer(slot: Slot): void {
    if (slot.loadTimer != null) {
      window.clearTimeout(slot.loadTimer);
      slot.loadTimer = null;
    }
  }
  private clearStallTimer(slot: Slot): void {
    if (slot.stallTimer != null) {
      window.clearTimeout(slot.stallTimer);
      slot.stallTimer = null;
    }
  }
  private clearRetryTimer(slot: Slot): void {
    if (slot.retryTimer != null) {
      window.clearTimeout(slot.retryTimer);
      slot.retryTimer = null;
    }
  }
  private clearAllTimers(slot: Slot): void {
    this.clearLoadTimer(slot);
    this.clearStallTimer(slot);
    this.clearRetryTimer(slot);
  }

  // ============================================================================
  // Helpers de store
  // ============================================================================

  /**
   * Atualiza o status do slot no store. Keya por `slot.key` (clipId) e injeta
   * o `assetId` como metadado pra UI/log.
   */
  private setStatus(
    slot: Slot,
    patch: Parameters<
      ReturnType<typeof useMediaControllerStore.getState>['setStatus']
    >[1],
  ): void {
    useMediaControllerStore
      .getState()
      .setStatus(slot.key, { ...patch, key: slot.key, assetId: slot.assetId });
  }

  private log(
    slot: Slot,
    kind: MediaEventKind,
    extra: Partial<MediaEvent> = {},
  ): void {
    const video = slot.videoEl;
    const buf = video.buffered;
    const event: MediaEvent = {
      ts: Date.now(),
      assetId: slot.assetId,
      clipId: slot.clipId,
      kind,
      readyState: video.readyState,
      networkState: video.networkState,
      bufferedEnd: buf.length > 0 ? buf.end(buf.length - 1) : undefined,
      currentTime: video.currentTime,
      duration: isFinite(video.duration) ? video.duration : undefined,
      url: slot.currentUrl ?? undefined,
      ...extra,
    };
    useMediaControllerStore.getState().pushEvent(event);
  }
}

// ============================================================================
// Singleton + helpers
// ============================================================================

let _instance: MediaController | null = null;

export function getMediaController(): MediaController {
  if (!_instance) {
    _instance = new MediaController();
  }
  return _instance;
}

/** Mapa human-friendly do MediaError.code. */
function mediaErrorMessage(err: MediaError | null | undefined): string {
  if (!err) return 'erro desconhecido no <video>';
  switch (err.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return 'fetch abortado';
    case MediaError.MEDIA_ERR_NETWORK:
      return 'erro de rede ao baixar a midia';
    case MediaError.MEDIA_ERR_DECODE:
      return 'erro ao decodificar a midia';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'codec/formato nao suportado OU URL expirada/forbidden';
    default:
      return err.message || `MediaError code=${err.code}`;
  }
}

/** Traduz estado pra label legivel (pra UI). */
export function mediaStateLabel(state: MediaState): string {
  switch (state) {
    case 'idle':
      return 'Aguardando';
    case 'loading':
      return 'Carregando';
    case 'buffering':
      return 'Buffering';
    case 'ready':
      return 'Pronto';
    case 'playing':
      return 'Tocando';
    case 'paused':
      return 'Pausado';
    case 'stalled':
      return 'Travado';
    case 'error':
      return 'Erro (vai re-tentar)';
    case 'failed':
      return 'Falhou (desistiu)';
  }
}
