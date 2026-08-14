/**
 * Web Worker que hospeda a instância FFmpeg.wasm.
 *
 * Por que Worker:
 *  - Manter o main thread livre (UI responsiva durante render).
 *  - FFmpeg.wasm já cria seus próprios workers internos para multi-thread,
 *    mas a entrada é síncrona o suficiente para travar o main thread em
 *    operações de `writeFile`/`exec`.
 *
 * Protocolo (`MessageEvent.data`):
 *
 *  Main → Worker:
 *    { type: 'init' }
 *    { type: 'render', payload: { args, inputFiles, outputName } }
 *
 *  Worker → Main:
 *    { type: 'init-done' }
 *    { type: 'progress', payload: { progress: 0..1 } }
 *    { type: 'render-done', payload: { data: ArrayBuffer } }
 *    { type: 'error', payload: { message: string } }
 */

/// <reference lib="webworker" />

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

// Bases do core (UMD), em ordem de preferência. O self-hospedado em
// /public/ffmpeg/umd vem PRIMEIRO (mesmo domínio, sem CDN externo); a CDN
// fica só como fallback de resiliência. Versão alinhada ao @ffmpeg/ffmpeg.
const FFMPEG_CORE_BASES = [
  '/ffmpeg/umd',
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
];

const ffmpeg = new FFmpeg();
let initialized = false;

ffmpeg.on('progress', ({ progress }) => {
  const pct = Math.max(0, Math.min(1, progress));
  postMessage({ type: 'progress', payload: { progress: pct } });
});

// Útil para debug — encaminha logs do FFmpeg para o main thread em modo dev.
ffmpeg.on('log', ({ message }) => {
  // Mantemos silencioso por padrão. Descomente para depurar:
  // postMessage({ type: 'log', payload: { message } });
  void message;
});

interface RenderPayload {
  args: string[];
  inputFiles: { name: string; data: Uint8Array }[];
  outputName: string;
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data ?? {};

  try {
    if (type === 'init') {
      if (!initialized) {
        let lastErr: unknown = null;
        for (const base of FFMPEG_CORE_BASES) {
          try {
            await ffmpeg.load({
              coreURL: await toBlobURL(
                `${base}/ffmpeg-core.js`,
                'text/javascript',
              ),
              wasmURL: await toBlobURL(
                `${base}/ffmpeg-core.wasm`,
                'application/wasm',
              ),
            });
            initialized = true;
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (!initialized) {
          throw lastErr instanceof Error
            ? lastErr
            : new Error('FFmpeg core não pôde ser carregado.');
        }
      }
      postMessage({ type: 'init-done' });
      return;
    }

    if (type === 'render') {
      if (!initialized) {
        throw new Error('FFmpeg.wasm não inicializado — envie `init` primeiro.');
      }
      const p = payload as RenderPayload;

      // 1. Escreve inputs no FS virtual
      for (const f of p.inputFiles) {
        await ffmpeg.writeFile(f.name, f.data);
      }

      // 2. Executa a pipeline
      await ffmpeg.exec(p.args);

      // 3. Lê o output
      const out = await ffmpeg.readFile(p.outputName);
      const data =
        typeof out === 'string'
          ? new TextEncoder().encode(out).buffer
          : (out as Uint8Array).buffer;

      // 4. Limpa arquivos do FS virtual (libera memória do worker)
      for (const f of p.inputFiles) {
        try {
          await ffmpeg.deleteFile(f.name);
        } catch {
          /* ignore */
        }
      }
      try {
        await ffmpeg.deleteFile(p.outputName);
      } catch {
        /* ignore */
      }

      // ArrayBuffer é transferable — evita cópia.
      postMessage({ type: 'render-done', payload: { data } }, { transfer: [data] });
      return;
    }

    if (type === 'destroy') {
      try {
        ffmpeg.terminate();
      } catch {
        /* ignore */
      }
      initialized = false;
      postMessage({ type: 'destroyed' });
      return;
    }

    throw new Error(`Mensagem desconhecida: ${String(type)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    postMessage({ type: 'error', payload: { message } });
  }
};

// Export vazio para que o TS trate este arquivo como módulo ESM (necessário
// para o `new Worker(..., { type: 'module' })` que o Next 15 emite).
export {};
