/**
 * Web Worker de transcrição local (STT) com Whisper via transformers.js.
 *
 * 100% no navegador, SEM IA paga e SEM CDN em runtime: o runtime ONNX (wasm)
 * e o modelo Whisper quantizado são servidos do MESMO domínio (`/public`),
 * obrigatório porque a rota do Suite de Vídeo é cross-origin-isolated
 * (COEP: require-corp) — qualquer asset cross-origin sem CORP quebraria.
 *
 * Espelha o padrão do `ffmpeg.worker.ts` (Worker dedicado + protocolo de
 * mensagens Promise-friendly no client).
 *
 * Protocolo (`MessageEvent.data`):
 *
 *  Main → Worker:
 *    { type: 'init', payload: { model: 'tiny' | 'base' } }
 *    { type: 'transcribe', payload: { audio: Float32Array, language, sampleRate } }
 *
 *  Worker → Main:
 *    { type: 'init-progress', payload: { file, progress: 0..100, status } }
 *    { type: 'init-done' }
 *    { type: 'transcribe-progress', payload: { progress: 0..1 } }
 *    { type: 'transcribe-done', payload: { chunks } }
 *    { type: 'error', payload: { message } }
 *
 * IMPORTANTE p/ o orquestrador: a dependência `@huggingface/transformers`
 * (transformers.js v3) precisa estar instalada e o modelo + wasm vendorados
 * em `/public` (ver `transcribe-worker-client.ts` p/ caminhos). O import é
 * dinâmico justamente para não quebrar o build enquanto a dep não existe.
 */

/// <reference lib="webworker" />

// IDs de modelo vendorados em /public/models/<id>. Tudo same-origin por causa
// do COEP require-corp (CDN da Hugging Face quebraria o isolamento).
//
// IMPORTANTE: só liste aqui modelos cujos assets EXISTEM em `public/models/`.
// `whisper-base` ainda NÃO foi vendorado, então NÃO está mapeado — se um dia
// for provisionado (`public/models/whisper-base/` com config/tokenizer/onnx),
// reative a entrada `base: 'whisper-base'` e a opção no CaptionTranscribeDialog.
const MODEL_IDS: Record<string, string> = {
  tiny: 'whisper-tiny',
};

// Caminhos LOCAIS (same-origin). NUNCA usar CDN da Hugging Face em runtime.
const LOCAL_MODEL_PATH = '/models/';
const LOCAL_WASM_PATH = '/transformers/';

// Cache do pipeline carregado por modelo (evita recarregar entre transcrições).
type AsrPipeline = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ text: string; chunks?: unknown[] }>;

let currentModel: 'tiny' | 'base' | null = null;
let pipelinePromise: Promise<AsrPipeline> | null = null;

/**
 * Carrega (uma vez) o runtime transformers.js, fixa os caminhos locais e
 * instancia o pipeline de ASR para o modelo escolhido.
 *
 * O import é dinâmico e tipado como `any` de propósito: a lib é vendorada
 * pelo orquestrador e pode não existir em tempo de checagem de tipos.
 */
async function getPipeline(model: 'tiny' | 'base'): Promise<AsrPipeline> {
  const modelId = MODEL_IDS[model];
  if (!modelId) {
    // Defensivo: o dialog só oferece modelos vendorados, mas se algum caminho
    // pedir um modelo sem assets em /public falhamos com mensagem clara em vez
    // de um 404 opaco ("Erro ao carregar modelo").
    throw new Error(
      `Modelo "${model}" indisponível neste app (não vendorado em /public/models). Use o modelo "tiny".`,
    );
  }
  if (pipelinePromise && currentModel === model) {
    return pipelinePromise;
  }
  currentModel = model;

  pipelinePromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transformers: any = await import(
      /* webpackIgnore: false */ '@huggingface/transformers'
    );
    const { pipeline, env } = transformers;

    // ---- Força execução 100% LOCAL (sem rede / sem CDN) --------------------
    env.allowRemoteModels = false; // nunca baixa da Hugging Face em runtime
    env.allowLocalModels = true;
    env.localModelPath = LOCAL_MODEL_PATH; // /models/<id>/...
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.wasmPaths = LOCAL_WASM_PATH; // /transformers/ort-*.wasm
      // Multi-thread só funciona com cross-origin isolation (já garantido na
      // rota do suite). Deixa o transformers.js decidir o nº de threads.
    }

    const asr = await pipeline(
      'automatic-speech-recognition',
      modelId,
      {
        // Quantizado (q8) por padrão — menor download e RAM.
        dtype: 'q8',
        progress_callback: (p: {
          file?: string;
          progress?: number;
          status?: string;
        }) => {
          postMessage({
            type: 'init-progress',
            payload: {
              file: p.file ?? '',
              progress: Math.round(p.progress ?? 0),
              status: p.status ?? '',
            },
          });
        },
      },
    );

    return asr as AsrPipeline;
  })();

  return pipelinePromise;
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data ?? {};

  try {
    if (type === 'init') {
      const model: 'tiny' | 'base' = payload?.model === 'base' ? 'base' : 'tiny';
      await getPipeline(model);
      postMessage({ type: 'init-done' });
      return;
    }

    if (type === 'transcribe') {
      const audio: Float32Array = payload.audio;
      const language: string = payload.language ?? 'pt';
      const model: 'tiny' | 'base' = payload?.model === 'base' ? 'base' : 'tiny';

      const asr = await getPipeline(model);

      const result = await asr(audio, {
        // Segmentos com timestamps -> mapeiam 1:1 pra CaptionCue.
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
        language,
        task: 'transcribe',
        // Progresso aproximado por chunk processado.
        callback_function: (items: unknown[]) => {
          // O callback recebe beams parciais; usamos só pra sinalizar atividade.
          if (Array.isArray(items) && items.length > 0) {
            postMessage({
              type: 'transcribe-progress',
              payload: { progress: 0.5 },
            });
          }
        },
      });

      const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
      postMessage({ type: 'transcribe-done', payload: { chunks } });
      return;
    }

    if (type === 'destroy') {
      pipelinePromise = null;
      currentModel = null;
      postMessage({ type: 'destroyed' });
      return;
    }

    throw new Error(`Mensagem desconhecida: ${String(type)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    postMessage({ type: 'error', payload: { message } });
  }
};

// Export vazio p/ tratar como módulo ESM (necessário p/ Worker type:'module').
export {};
