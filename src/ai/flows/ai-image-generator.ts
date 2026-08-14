'use server';
/**
 * @fileOverview Geração de imagem para uso no palco 2 do editor.
 *
 * Exports:
 * - `generateImage(input)`: gera uma imagem a partir de um prompt textual e
 *   devolve o dataUri (image/png base64).
 * - `generateImageFromTranscription(input)`: variante que recebe a
 *   transcrição de um trecho falado e usa como contexto pra gerar imagem
 *   ilustrativa do conteúdo.
 *
 * TUDO PELO GATEWAY (multi-provider):
 *  - `generateImage` GERA IMAGEM → capacidade 'imagem' (`gerarImagem`). Hoje só o
 *    Gemini emite mídia, então a cadeia resolve só ele — mas o acesso passa pelo
 *    GATEWAY (config/meta/telemetria unificados), não por `ai.generate` direto.
 *  - `generateImageFromTranscription` tem um passo 1 de TEXTO PURO (extrair o
 *    conceito visual da transcrição) → `gerarTexto` (grátis primeiro). O passo 2
 *    (gerar a imagem do conceito) usa `generateImage` (gateway, capacidade imagem).
 */

import { z } from 'genkit';
import { gerarTexto, gerarImagem } from '@/ai/multi-provider';

const ImageGenInputSchema = z.object({
  prompt: z.string().min(3).describe('Descrição textual da imagem a gerar.'),
  /** Orientação preferida para o palco 2. */
  aspectHint: z
    .enum(['landscape', 'portrait', 'square'])
    .optional()
    .describe('Orientação desejada (landscape/portrait/square).'),
});
export type ImageGenInput = z.infer<typeof ImageGenInputSchema>;

const ImageGenOutputSchema = z.object({
  imageDataUri: z
    .string()
    .describe(
      'Imagem gerada como data URI (data:image/png;base64,…) — embedável diretamente.',
    ),
  caption: z.string().describe('Legenda curta descritiva da imagem.'),
});
export type ImageGenOutput = z.infer<typeof ImageGenOutputSchema>;

function buildPromptText(prompt: string, aspect?: ImageGenInput['aspectHint']): string {
  const orientationHint =
    aspect === 'portrait'
      ? 'Orientação retrato (9:16) adequada para Reels/Stories.'
      : aspect === 'square'
        ? 'Composição quadrada (1:1) adequada para feed.'
        : 'Composição horizontal (16:9) adequada para palco amplo.';
  return [
    'Gere uma imagem ilustrativa de alta qualidade para acompanhar um vídeo institucional.',
    'Estilo: limpo, profissional, sem texto sobre a imagem.',
    orientationHint,
    `Conteúdo: ${prompt}`,
  ].join('\n');
}

/**
 * Gera uma imagem via GATEWAY (capacidade 'imagem'). A cadeia resolve só o
 * Gemini hoje (único que emite mídia), mas o acesso passa pelo gateway —
 * config/meta/telemetria unificados, nada de `ai.generate` direto.
 */
export async function generateImage(input: ImageGenInput): Promise<ImageGenOutput> {
  const validated = ImageGenInputSchema.parse(input);
  const fullPrompt = buildPromptText(validated.prompt, validated.aspectHint);

  const { imageDataUri, caption } = await gerarImagem({
    prompt: fullPrompt,
    aspecto: validated.aspectHint,
  });

  return {
    imageDataUri,
    caption: (caption || '').slice(0, 200) || validated.prompt.slice(0, 200),
  };
}

const TranscriptionInputSchema = z.object({
  transcription: z
    .string()
    .min(5)
    .describe('Texto transcrito do trecho do palco 1.'),
  contextHint: z
    .string()
    .optional()
    .describe('Contexto adicional do vídeo (assunto geral, tom etc).'),
  aspectHint: z
    .enum(['landscape', 'portrait', 'square'])
    .optional(),
});
export type ImageFromTranscriptionInput = z.infer<typeof TranscriptionInputSchema>;

/**
 * Gera imagem a partir da transcrição do palco 1.
 *
 * Pipeline: transcrição → extrai conceito visual (TEXTO PURO) → gera imagem
 * com o conceito como prompt.
 *
 * Passo 1 (conceito): TEXTO PURO → multi-provider (`gerarTexto`), grátis
 * primeiro e Gemini de fallback. Passo 2 (imagem): GERA IMAGEM → continua no
 * Gemini via `generateImage`. A transcrição é só TEXTO (vem do palco 1 já
 * transcrito), então o passo 1 não é multimodal e pode usar os grátis.
 */
export async function generateImageFromTranscription(
  input: ImageFromTranscriptionInput,
): Promise<ImageGenOutput> {
  const validated = TranscriptionInputSchema.parse(input);

  // 1) Resumir a transcrição em um conceito visual (texto puro → multi-provider).
  const conceptPrompt = [
    'Extraia da transcrição abaixo o conceito visual mais relevante para ilustrar o que está sendo dito.',
    'Retorne APENAS uma descrição curta (máx 30 palavras), sem aspas, sem prefixos como "Imagem de…".',
    validated.contextHint ? `Contexto: ${validated.contextHint}` : '',
    `Transcrição: """${validated.transcription}"""`,
  ]
    .filter(Boolean)
    .join('\n');
  const { texto } = await gerarTexto({ prompt: conceptPrompt });
  const concept = texto?.trim();
  if (!concept) throw new Error('Não foi possível extrair conceito da transcrição.');

  // 2) Gerar imagem com o conceito como prompt (gera IMAGEM → fica no Gemini).
  return generateImage({ prompt: concept, aspectHint: validated.aspectHint });
}
