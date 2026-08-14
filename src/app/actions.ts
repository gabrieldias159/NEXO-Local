'use server';

/**
 * Server Actions do NEXO-Local.
 *
 * Recorte enxuto do `src/app/actions.ts` do oficioexpress: aqui só vivem as
 * actions que o **Estúdio de Vídeo** consome (`components/editor/ai/
 * AiStageGenerator.tsx`). O resto do arsenal de IA do Ofício Expresso
 * (minutas, ofícios, pareceres, agenda…) não faz parte deste repo.
 *
 * Todas passam pelo gateway multi-provider (`@/ai/multi-provider`), então
 * respeitam a configuração de modelo por capacidade e o fallback entre
 * provedores — mesmo comportamento do repo de origem.
 */

import {
  transcribeAudio as runTranscribeAudio,
  type AudioTranscriptionInput,
  type AudioTranscriptionOutput,
} from '@/ai/flows/ai-audio-transcriber';
import {
  generateImage as runGenerateImage,
  generateImageFromTranscription as runGenerateImageFromTranscription,
  type ImageGenInput,
  type ImageGenOutput,
  type ImageFromTranscriptionInput,
} from '@/ai/flows/ai-image-generator';

/**
 * Traduz a falha crua do provedor numa mensagem que o usuário entende.
 * Copiado do oficioexpress para manter as mesmas mensagens na UI.
 */
function getAiErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Ocorreu um erro inesperado ao comunicar com a IA.';
  const msg = error.message.toLowerCase();
  if (msg.includes('api key') || msg.includes('api_key') || msg.includes('permission denied')) {
    return 'Chave de API não configurada ou sem permissão. Verifique as configurações do sistema.';
  }
  if (
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('spending cap') ||
    msg.includes('spend cap') ||
    msg.includes('todos os provedores de ia falharam')
  ) {
    return 'Limite de uso da IA atingido (provedores sobre cota). Aguarde alguns minutos e tente novamente.';
  }
  if (msg.includes('timeout') || msg.includes('deadline') || msg.includes('timed out')) {
    return 'A IA demorou demais para responder. Tente novamente.';
  }
  if (msg.includes('network') || msg.includes('fetch failed') || msg.includes('econnrefused')) {
    return 'Erro de rede ao conectar com a IA. Verifique sua conexão.';
  }
  return error.message;
}

export async function transcribeAudioAction(
  input: AudioTranscriptionInput,
): Promise<{ success: boolean; data?: AudioTranscriptionOutput; error?: string }> {
  try {
    const result = await runTranscribeAudio(input);
    return { success: true, data: result };
  } catch (error: unknown) {
    console.error('AI Transcription Error:', error);
    return { success: false, error: getAiErrorMessage(error) };
  }
}

export async function generateImageAction(
  input: ImageGenInput,
): Promise<{ success: boolean; data?: ImageGenOutput; error?: string }> {
  try {
    const result = await runGenerateImage(input);
    return { success: true, data: result };
  } catch (error: unknown) {
    console.error('AI Image Generation Error:', error);
    return { success: false, error: getAiErrorMessage(error) };
  }
}

export async function generateImageFromTranscriptionAction(
  input: ImageFromTranscriptionInput,
): Promise<{ success: boolean; data?: ImageGenOutput; error?: string }> {
  try {
    const result = await runGenerateImageFromTranscription(input);
    return { success: true, data: result };
  } catch (error: unknown) {
    console.error('AI Image-from-Transcription Error:', error);
    return { success: false, error: getAiErrorMessage(error) };
  }
}
