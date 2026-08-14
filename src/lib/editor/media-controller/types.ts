/**
 * Tipos publicos do Media Controller.
 *
 * O controlador supervisiona cada `<video>` do preview e mantem uma
 * maquina de estados por asset. Quando detecta erro/stall, agenda retry
 * com backoff e (opcionalmente) renova o download URL do Storage.
 */

export type MediaState =
  /** Asset ainda nao foi anexado a nenhum elemento. */
  | 'idle'
  /** loadstart disparado, esperando metadata. */
  | 'loading'
  /** Buffering durante playback (waiting). */
  | 'buffering'
  /** canplay disparado, pronto pra tocar. */
  | 'ready'
  /** Tocando ativamente. */
  | 'playing'
  /** Pausa intencional. */
  | 'paused'
  /** Stalled — sem progresso. Pode escalar pra error. */
  | 'stalled'
  /** Erro de carregamento (vai re-tentar enquanto retries < maxRetries). */
  | 'error'
  /** Desistiu apos esgotar retries. */
  | 'failed';

export type MediaEventKind =
  | 'state'
  | 'error'
  | 'retry'
  | 'url-refresh'
  | 'attached'
  | 'detached'
  | 'ready'
  | 'stall-detected'
  | 'load-timeout';

export interface MediaEvent {
  /** Date.now() ao registrar. */
  ts: number;
  assetId: string;
  clipId?: string;
  kind: MediaEventKind;
  /** Estado resultante (opcional — quando kind=state ou transicoes). */
  state?: MediaState;
  /** Mensagem livre pro humano. */
  message?: string;
  /** Para kind=error/retry, detalhes do MediaError. */
  error?: { code?: number; name?: string; message: string };
  /** readyState do <video> no momento do evento (0-4). */
  readyState?: number;
  /** networkState do <video> (0-3). */
  networkState?: number;
  /** End do ultimo TimeRange em buffered (segundos). */
  bufferedEnd?: number;
  currentTime?: number;
  duration?: number;
  /** URL em uso no momento do evento. */
  url?: string;
}

export interface MediaStatus {
  /**
   * Chave UNICA do slot no store (= `clipId`). Use isto como key de lista /
   * filtro / retry na UI, NUNCA o `assetId` (que pode repetir entre clips).
   */
  key: string;
  /** Asset por tras do clip (metadado p/ exibicao/log). Pode repetir. */
  assetId: string;
  state: MediaState;
  /** Quantos retries ja foram tentados nessa sessao. */
  retries: number;
  /** Ultimo erro humanizado. */
  lastError?: string;
  /** Timestamp da ultima transicao de estado. */
  updatedAt: number;
  /** Segundos bufferizados (end do ultimo range). */
  bufferedEnd?: number;
  duration?: number;
  /** URL em uso (ultima resolvida). */
  url?: string;
  /** Quando o URL foi renovado pela ultima vez (pra debug). */
  urlRefreshedAt?: number;
  /** Quando o asset foi anexado pela primeira vez. */
  attachedAt?: number;
  /** Quando readyState atingiu 3+ pela primeira vez nessa sessao. */
  readyAt?: number;
}

export interface MediaControllerConfig {
  /** Max retries antes de marcar como 'failed'. Default: 3. */
  maxRetries: number;
  /** Backoff inicial (ms). Default: 800. */
  baseBackoffMs: number;
  /** Backoff maximo (ms). Default: 8000. */
  maxBackoffMs: number;
  /**
   * Se o `<video>` ficar `waiting` por mais que isso, escala pra erro e
   * agenda retry. Default: 8000ms.
   */
  stallTimeoutMs: number;
  /**
   * Se nao receber `canplay` em ate isso desde o loadstart, escala pra
   * erro. Default: 30000ms.
   */
  loadTimeoutMs: number;
  /** Tamanho do ring buffer de eventos. Default: 500. */
  logBufferSize: number;
  /**
   * Quando true, antes de cada retry (a partir do 2o) tenta renovar
   * o download URL chamando o provider passado em `attach`. Default: true.
   */
  refreshUrlOnRetry: boolean;
}

export const DEFAULT_CONFIG: MediaControllerConfig = {
  maxRetries: 3,
  baseBackoffMs: 800,
  maxBackoffMs: 8000,
  stallTimeoutMs: 8000,
  loadTimeoutMs: 30000,
  logBufferSize: 500,
  refreshUrlOnRetry: true,
};

/**
 * Funcao que retorna a URL "fresca" do asset. Chamada na anexacao e nos
 * retries (quando `refreshUrlOnRetry` true). Pode ser sincrona ou async.
 * Retorna null quando a URL nao pode ser resolvida — controller marca
 * como `failed` e nao retenta.
 */
export type UrlProvider = () => Promise<string | null> | string | null;
