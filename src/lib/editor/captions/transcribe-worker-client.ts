/**
 * Cliente do `transcribe.worker.ts`.
 *
 * Encapsula o ciclo de vida (init → transcribe → destroy) e o protocolo de
 * mensagens, expondo uma API Promise-friendly para a UI. Espelha o shape de
 * `ffmpeg-worker-client.ts`.
 *
 * Uso:
 *   const client = createTranscribeClient();
 *   await client.init('tiny', (p) => setLoad(p));   // baixa modelo do /public
 *   const chunks = await client.transcribe(pcm, 'pt', () => {});
 *   client.destroy();
 *
 * NOTA p/ o orquestrador: requer `@huggingface/transformers` instalado e o
 * modelo + wasm vendorados em:
 *   - /public/models/whisper-tiny/  e  /public/models/whisper-base/
 *   - /public/transformers/         (ort-wasm*.{wasm,mjs})
 * Nada de CDN em runtime (rota é cross-origin-isolated, COEP require-corp).
 */

import type { TranscriptionChunk } from './transcription';

export type WhisperModel = 'tiny' | 'base';

export interface InitProgress {
  file: string;
  /** 0..100 (download/parse do arquivo do modelo). */
  progress: number;
  status: string;
}

export interface TranscribeClient {
  init(
    model: WhisperModel,
    onProgress?: (p: InitProgress) => void,
  ): Promise<void>;
  transcribe(
    audio: Float32Array,
    language: string,
    onProgress?: (pct: number) => void,
  ): Promise<TranscriptionChunk[]>;
  destroy(): void;
}

export function createTranscribeClient(): TranscribeClient {
  let worker: Worker | null = null;
  let activeModel: WhisperModel | null = null;

  function ensureWorker(): Worker {
    if (worker) return worker;
    // Next 15 reconhece este pattern e emite o worker como bundle separado.
    worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), {
      type: 'module',
    });
    return worker;
  }

  function init(
    model: WhisperModel,
    onProgress?: (p: InitProgress) => void,
  ): Promise<void> {
    const w = ensureWorker();
    activeModel = model;
    return new Promise<void>((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        const { type, payload } = e.data ?? {};
        if (type === 'init-progress') {
          onProgress?.(payload as InitProgress);
        } else if (type === 'init-done') {
          cleanup();
          resolve();
        } else if (type === 'error') {
          cleanup();
          reject(new Error(payload?.message ?? 'Erro ao carregar modelo.'));
        }
      };
      const onError = (ev: ErrorEvent) => {
        cleanup();
        reject(new Error(ev.message || 'Erro no worker de transcrição.'));
      };
      const cleanup = () => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      w.postMessage({ type: 'init', payload: { model } });
    });
  }

  function transcribe(
    audio: Float32Array,
    language: string,
    onProgress?: (pct: number) => void,
  ): Promise<TranscriptionChunk[]> {
    const w = ensureWorker();
    return new Promise<TranscriptionChunk[]>((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        const { type, payload } = e.data ?? {};
        if (type === 'transcribe-progress') {
          onProgress?.(Math.round((payload?.progress ?? 0) * 100));
        } else if (type === 'transcribe-done') {
          cleanup();
          resolve((payload?.chunks ?? []) as TranscriptionChunk[]);
        } else if (type === 'error') {
          cleanup();
          reject(new Error(payload?.message ?? 'Erro na transcrição.'));
        }
      };
      const onError = (ev: ErrorEvent) => {
        cleanup();
        reject(new Error(ev.message || 'Erro no worker de transcrição.'));
      };
      const cleanup = () => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);

      // Transfere o buffer do PCM para evitar cópia (o worker passa a ser dono).
      const buf = audio.buffer;
      w.postMessage(
        {
          type: 'transcribe',
          payload: {
            audio,
            language,
            sampleRate: 16000,
            model: activeModel ?? 'tiny',
          },
        },
        [buf],
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
      activeModel = null;
    }
  }

  return { init, transcribe, destroy };
}
