/**
 * Cliente do `ffmpeg.worker.ts`.
 *
 * Encapsula o ciclo de vida (init → render → destroy) e o protocolo
 * de mensagens, expondo uma API Promise-friendly para a UI.
 *
 * Uso:
 *   const client = createFFmpegRenderClient();
 *   await client.init();
 *   const blob = await client.render(input, (pct) => setProgress(pct));
 *   client.destroy();
 */

import type { ClientRenderInput } from './build-client-args';

// ============================================================================
// Tipos públicos
// ============================================================================

export interface RenderInput extends ClientRenderInput {
  /** Mime type do output, usado para construir o Blob final. */
  outputMime: string;
}

export interface FFmpegRenderClient {
  init(): Promise<void>;
  render(
    input: RenderInput,
    onProgress: (pct: number) => void,
  ): Promise<Blob>;
  destroy(): void;
}

// ============================================================================
// Implementação
// ============================================================================

export function createFFmpegRenderClient(): FFmpegRenderClient {
  let worker: Worker | null = null;
  let initPromise: Promise<void> | null = null;

  function ensureWorker(): Worker {
    if (worker) return worker;
    // Next 15 reconhece este pattern e emite o worker como bundle separado.
    worker = new Worker(new URL('./ffmpeg.worker.ts', import.meta.url), {
      type: 'module',
    });
    return worker;
  }

  function init(): Promise<void> {
    if (initPromise) return initPromise;
    const w = ensureWorker();
    initPromise = new Promise<void>((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        const { type, payload } = e.data ?? {};
        if (type === 'init-done') {
          w.removeEventListener('message', onMessage);
          w.removeEventListener('error', onError);
          resolve();
        } else if (type === 'error') {
          w.removeEventListener('message', onMessage);
          w.removeEventListener('error', onError);
          reject(new Error(payload?.message ?? 'Erro desconhecido no worker.'));
        }
      };
      const onError = (ev: ErrorEvent) => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        reject(new Error(ev.message || 'Erro no worker.'));
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      w.postMessage({ type: 'init' });
    });
    return initPromise;
  }

  function render(
    input: RenderInput,
    onProgress: (pct: number) => void,
  ): Promise<Blob> {
    const w = ensureWorker();
    return new Promise<Blob>((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        const { type, payload } = e.data ?? {};
        if (type === 'progress') {
          onProgress(Math.round((payload?.progress ?? 0) * 100));
        } else if (type === 'render-done') {
          w.removeEventListener('message', onMessage);
          w.removeEventListener('error', onError);
          const data: ArrayBuffer = payload.data;
          resolve(new Blob([data], { type: input.outputMime }));
        } else if (type === 'error') {
          w.removeEventListener('message', onMessage);
          w.removeEventListener('error', onError);
          reject(new Error(payload?.message ?? 'Erro no render.'));
        }
      };
      const onError = (ev: ErrorEvent) => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        reject(new Error(ev.message || 'Erro no worker.'));
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);

      // Transfer dos buffers de entrada para evitar cópia.
      const transfers = input.inputFiles.map((f) => f.data.buffer);
      w.postMessage(
        {
          type: 'render',
          payload: {
            args: input.args,
            inputFiles: input.inputFiles,
            outputName: input.outputName,
          },
        },
        // ArrayBuffers transferidos — o worker passa a ser dono dos bytes.
        transfers,
      );
    });
  }

  function destroy(): void {
    if (worker) {
      try {
        worker.postMessage({ type: 'destroy' });
      } catch {
        /* ignore */
      }
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
      worker = null;
      initPromise = null;
    }
  }

  return { init, render, destroy };
}
