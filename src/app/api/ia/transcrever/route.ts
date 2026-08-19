/**
 * POST /api/ia/transcrever — TRANSCRIÇÃO de áudio pelo gateway multi-provider.
 *
 * Endpoint INTERNO (service-to-service): autenticado por `x-internal-ia-token`
 * (ver `tokenInternoValido`), pensado para a Cloud Function de legendas
 * (video/caption-generate) que não importa de src/. Roteia por
 * `transcreverAudio` → Groq Whisper (GRÁTIS) primeiro, Gemini de fallback REAL.
 *
 * Body JSON: { audioDataUri: string, mime?: string, idioma?: string, prompt?: string }
 * Resposta: { texto: string, provedor: string, modelo: string }
 *
 * Limite: o áudio vai INLINE como data URI no corpo — o chamador deve fragmentar
 * em chunks bem abaixo do limite de corpo do Cloud Run (~32MB).
 */
import { tokenInternoValido } from '@/lib/ia/auth-interno';
import {
  transcreverAudio,
  transcreverAudioTemporizado,
  haAlgumProvedorDeIa,
} from '@/ai/multi-provider';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Body {
  audioDataUri?: string;
  mime?: string;
  idioma?: string;
  prompt?: string;
  /** Pede SEGMENTOS com timestamps (para legendas/captions). */
  segmentado?: boolean;
}

export async function POST(req: Request): Promise<Response> {
  if (!tokenInternoValido(req)) return json({ error: 'não autorizado' }, 401);
  if (!haAlgumProvedorDeIa()) {
    return json({ error: 'Nenhum provedor de IA configurado.' }, 503);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: 'corpo inválido' }, 400);
  }

  const audioDataUri = (body.audioDataUri ?? '').trim();
  if (!audioDataUri) return json({ error: 'audioDataUri ausente' }, 400);

  try {
    if (body.segmentado) {
      const r = await transcreverAudioTemporizado({
        audioDataUri,
        mime: body.mime,
        idioma: body.idioma,
        prompt: body.prompt,
      });
      return json(r, 200); // { texto, segmentos, provedor, modelo }
    }
    const r = await transcreverAudio({
      audioDataUri,
      mime: body.mime,
      idioma: body.idioma,
      prompt: body.prompt,
    });
    return json(r, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 502);
  }
}
