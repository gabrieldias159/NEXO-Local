'use server';
/**
 * @fileOverview AI-powered assistant for transcribing audio files.
 *
 * Exports:
 * - `transcribeAudio`: Asynchronously transcribes an audio file.
 * - `AudioTranscriptionInput`: The input type, containing the audio as a data URI.
 * - `AudioTranscriptionOutput`: The output type, providing the transcribed text.
 *
 * MOTOR (F3 do gateway de IA): a transcrição passa pelo gateway central
 * (`transcreverAudio` → `executarCadeia('audio', ...)`), que tenta a Groq
 * (Whisper `whisper-large-v3`, mais rápido/barato) PRIMEIRO e cai no Gemini se
 * a Groq falhar (timeout/429/erro/áudio grande/sem chave) — FAILOVER REAL.
 *
 * Se a Groq não estiver configurada (sem `GROQ_API_KEY`), a cadeia a pula e o
 * comportamento é IDÊNTICO ao histórico (Gemini-only) — nunca pior que hoje.
 *
 * A interface pública (`transcribeAudio`/`AudioTranscriptionInput`/
 * `AudioTranscriptionOutput`) é PRESERVADA: só o motor mudou por dentro.
 */
import { z } from 'genkit';
import { transcreverAudio } from '@/ai/multi-provider';

const AudioTranscriptionInputSchema = z.object({
  audioDataUri: z.string().describe("An audio file as a data URI. It must include a MIME type and use Base64 encoding. Expected format: 'data:<mimetype>;base64,<encoded_data>'."),
});
export type AudioTranscriptionInput = z.infer<typeof AudioTranscriptionInputSchema>;

const AudioTranscriptionOutputSchema = z.object({
  transcription: z.string().describe('The transcribed text from the audio.'),
});
export type AudioTranscriptionOutput = z.infer<typeof AudioTranscriptionOutputSchema>;

export async function transcribeAudio(input: AudioTranscriptionInput): Promise<AudioTranscriptionOutput> {
  const { texto } = await transcreverAudio({
    audioDataUri: input.audioDataUri,
    prompt: 'Transcreva o áudio a seguir com precisão.',
  });
  if (!texto || !texto.trim()) {
    throw new Error('AI failed to transcribe the audio.');
  }
  return { transcription: texto };
}
