/**
 * POST /api/ia/gerar-json — GERAÇÃO de JSON pelo gateway multi-provider.
 *
 * Endpoint INTERNO (service-to-service, `x-internal-ia-token`), para as Cloud
 * Functions de IA (diario/parse, loa-parse) que não importam de src/. Roteia:
 *  - TEXTO (sem mídia) → `gerarTexto` (provedores GRÁTIS primeiro, Gemini fallback).
 *  - VISÃO (com `mediaUrl`) → `conversarComVisao` (Gemini DENTRO do gateway — único
 *    que lê PDF/imagem hoje). `mediaUrl` é uma URL (ex.: signed URL do Storage)
 *    que o gateway repassa ao modelo; assim o PDF NÃO trafega inline no corpo
 *    (evita o limite ~32MB do Cloud Run no hop function→app).
 *
 * Injeta o contrato "responda só JSON" e faz 1 RETRY de reparo se o JSON vier
 * inválido. Devolve o JSON já LIMPO como texto — o chamador faz `JSON.parse` e
 * valida no schema dele (o schema não trafega pela rede).
 *
 * Body: { prompt: string, system?: string, mediaUrl?: string, temperature?: number }
 * Resposta: { texto: string, provedor: string, modelo: string }
 */
import { tokenInternoValido } from '@/lib/ia/auth-interno';
import {
  gerarJsonBruto,
  conversarComVisao,
  haAlgumProvedorDeIa,
  provedorEsperado,
  PERFIS_IA,
  type MensagemChat,
} from '@/ai/multi-provider';

export const runtime = 'nodejs';
// 480s: cabe o orçamento do diário (NVIDIA 5×45s=225s) + fallback (Groq/Gemini),
// abaixo do timeout de 540s da function que chama esta rota.
export const maxDuration = 480;
export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Body {
  prompt?: string;
  system?: string;
  /** URL da mídia (ex.: signed URL do Storage) — o endpoint baixa e inlina. */
  mediaUrl?: string;
  /** Mídia já como data URI (alternativa ao mediaUrl). */
  mediaDataUri?: string;
  temperature?: number;
}

/** Teto defensivo p/ inline no Gemini (limite ~20MB de request inline da API). */
const MAX_MEDIA_BYTES = 18 * 1024 * 1024;

/**
 * Baixa a `mediaUrl` (signed URL etc.) e devolve um data URI. O modelo (Gemini)
 * NÃO busca URLs arbitrárias — só aceita bytes inline; por isso o FETCH acontece
 * AQUI (no app, com RAM de sobra) e o hop function→app carrega só a URL curta.
 */
async function urlParaDataUri(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Falha ao baixar a mídia (${res.status}).`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_MEDIA_BYTES) {
    throw new Error(
      `Mídia grande demais para inline (${(buf.length / 1048576).toFixed(1)}MB > ${(MAX_MEDIA_BYTES / 1048576).toFixed(0)}MB).`,
    );
  }
  const mime =
    res.headers.get('content-type')?.split(';')[0].trim() || 'application/pdf';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const CONTRATO_JSON =
  'IMPORTANTE: responda EXCLUSIVAMENTE com um único objeto JSON válido que ' +
  'satisfaça o formato pedido. Não inclua texto fora do JSON, nem cercas de ' +
  'código, nem comentários.';

/** Tira cercas ```` ``` ```` e fatia do primeiro `{`/`[` ao último `}`/`]`. */
function limparJson(texto: string): string {
  const t = texto
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const obj = t.indexOf('{');
  const arr = t.indexOf('[');
  const ini = obj === -1 ? arr : arr === -1 ? obj : Math.min(obj, arr);
  if (ini === -1) return t;
  const fecha = t[ini] === '{' ? '}' : ']';
  const fim = t.lastIndexOf(fecha);
  return fim > ini ? t.slice(ini, fim + 1) : t;
}

function ehJsonValido(texto: string): boolean {
  try {
    JSON.parse(texto);
    return true;
  } catch {
    return false;
  }
}

/** Uma rodada de geração (texto OU visão), devolvendo texto + procedência. */
async function gerar(
  system: string,
  prompt: string,
  mediaDataUri: string | undefined,
  temperature: number,
): Promise<{ texto: string; provedor: string; modelo: string }> {
  if (mediaDataUri) {
    const partes: MensagemChat['partes'] = [
      { tipo: 'texto', texto: prompt },
      { tipo: 'media', dataUri: mediaDataUri },
    ];
    const r = await conversarComVisao({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt, partes },
      ],
      temperature,
      // PDF do diário no Gemini leva bem mais que os 14s padrão; sem isto a
      // geração de visão estourava como "retryable" e esgotava a cadeia (502).
      // maxDuration da rota (480s) comporta com folga.
      timeoutMs: 180_000,
    });
    return r;
  }
  // Caminho TEXTO → capacidade 'json' (jsonMode liga response_format nos grátis).
  // Fila do DIÁRIO: NVIDIA primeiro (5 chaves, prompt gigante) + timeout 60s —
  // isola o lote pesado e não rouba a cota do Groq que a redação usa.
  return gerarJsonBruto({ system, prompt, temperature, ...PERFIS_IA.diario });
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

  const prompt = (body.prompt ?? '').trim();
  if (!prompt) return json({ error: 'prompt ausente' }, 400);

  const system = body.system?.trim()
    ? `${body.system.trim()}\n\n${CONTRATO_JSON}`
    : CONTRATO_JSON;
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.1;

  // Resolve a mídia para data URI UMA vez (baixa a mediaUrl, ou usa o dataUri direto).
  let mediaDataUri: string | undefined;
  try {
    if (body.mediaDataUri?.trim()) {
      mediaDataUri = body.mediaDataUri.trim();
    } else if (body.mediaUrl?.trim()) {
      mediaDataUri = await urlParaDataUri(body.mediaUrl.trim());
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 400);
  }

  // VISÃO exige um driver de 'visao' (hoje só o Gemini). `haAlgumProvedorDeIa`
  // passa só com os grátis (texto), mascarando a falta do Gemini → checa explícito.
  if (mediaDataUri) {
    const visao = await provedorEsperado('visao');
    if (!visao) {
      return json(
        { error: 'Sem provedor de visão configurado (a leitura de PDF/imagem exige Gemini).' },
        503,
      );
    }
  }

  try {
    const r1 = await gerar(system, prompt, mediaDataUri, temperature);
    const limpo1 = limparJson(r1.texto);
    if (ehJsonValido(limpo1)) {
      return json({ texto: limpo1, provedor: r1.provedor, modelo: r1.modelo }, 200);
    }

    // RETRY de reparo: devolve o texto cru e pede SOMENTE o JSON corrigido.
    const promptReparo =
      'O texto a seguir DEVERIA ser apenas um objeto JSON válido, mas falhou no ' +
      'parse. Corrija e devolva SOMENTE o JSON, sem comentários nem cercas:\n\n' +
      r1.texto;
    const r2 = await gerar(system, promptReparo, mediaDataUri, 0);
    const limpo2 = limparJson(r2.texto);
    if (!ehJsonValido(limpo2)) {
      return json({ error: 'O modelo não produziu JSON válido (após reparo).' }, 502);
    }
    return json({ texto: limpo2, provedor: r2.provedor, modelo: r2.modelo }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 502);
  }
}
