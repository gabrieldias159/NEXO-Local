/**
 * Cliente HTTP das Cloud Functions para o GATEWAY de IA do app.
 *
 * As functions NÃO importam de src/ (regra do projeto). Para "tudo no gateway de
 * IA", elas chamam os endpoints internos do App Hosting:
 *   - POST /api/ia/transcrever  (áudio → texto; Groq Whisper grátis → Gemini)
 *   - POST /api/ia/gerar-json   (texto/visão → JSON; grátis primeiro / Gemini p/ PDF)
 *
 * Auth service-to-service: header `x-internal-ia-token` = INTERNAL_IA_TOKEN
 * (MESMO secret nos dois lados). A URL base do app vem de IA_GATEWAY_URL.
 *
 * Ambos são lidos do ENV em runtime; as functions que usam este cliente devem
 * declarar `secrets: ["INTERNAL_IA_TOKEN"]` e ter `IA_GATEWAY_URL` no ambiente.
 *
 * Node 22 (functions 2ª gen) tem `fetch` global — sem dependência externa.
 */

const HEADER_TOKEN_INTERNO = 'x-internal-ia-token';

function baseUrl(): string {
  const u = process.env.IA_GATEWAY_URL?.trim();
  if (!u) {
    throw new Error(
      'IA_GATEWAY_URL não configurada (URL base do App Hosting para os endpoints /api/ia/*).',
    );
  }
  return u.replace(/\/+$/, '');
}

function token(): string {
  const t = process.env.INTERNAL_IA_TOKEN?.trim();
  if (!t) {
    throw new Error(
      'INTERNAL_IA_TOKEN não configurada (use firebase functions:secrets:set INTERNAL_IA_TOKEN).',
    );
  }
  return t;
}

/**
 * FAIL-FAST de configuração: confirma que a URL base e o token estão presentes
 * ANTES de gastar trabalho pesado (ex.: mixar/fatiar áudio nas legendas). Lança
 * com uma mensagem clara listando o que falta. Chame no início da function.
 */
export function assertGatewayConfigurado(): void {
  const faltando: string[] = [];
  if (!process.env.IA_GATEWAY_URL?.trim()) faltando.push('IA_GATEWAY_URL');
  if (!process.env.INTERNAL_IA_TOKEN?.trim()) faltando.push('INTERNAL_IA_TOKEN');
  if (faltando.length > 0) {
    throw new Error(
      `Gateway de IA não configurado nas functions: faltando ${faltando.join(', ')}.`,
    );
  }
}

interface RespostaGateway {
  texto: string;
  provedor: string;
  modelo: string;
}

/** Segmento de transcrição com tempos em SEGUNDOS (relativos ao áudio enviado). */
export interface SegmentoTranscricao {
  start: number;
  end: number;
  text: string;
}

interface RespostaTranscricaoTemporizada extends RespostaGateway {
  segmentos: SegmentoTranscricao[];
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * POST ao gateway com 1 RETRY em 502/503/504 (gateway saturado / cadeia de IA
 * momentaneamente esgotada). O orçamento de 540s do onDiarioParseRequest
 * comporta a espera de ~30s; erros duros (4xx) NÃO são reprocessados. Falha
 * intermitente da cadeia era ~31 502/semana no parse do diário (auditoria
 * 2026-07-02) — muitos passam na 2ª tentativa.
 */
async function postIa(rota: string, corpo: unknown): Promise<RespostaGateway> {
  const TRANSIENTES = new Set([502, 503, 504]);
  let ultimoErro = '';
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const res = await fetch(`${baseUrl()}${rota}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [HEADER_TOKEN_INTERNO]: token(),
      },
      body: JSON.stringify(corpo),
    });
    const bruto = await res.text();
    if (res.ok) return JSON.parse(bruto) as RespostaGateway;

    let detalhe = bruto.slice(0, 400);
    try {
      const j = JSON.parse(bruto) as { error?: string };
      if (j?.error) detalhe = j.error;
    } catch {
      /* mantém o texto cru */
    }
    ultimoErro = `Gateway ${rota} respondeu ${res.status}: ${detalhe}`;
    // Só reprocessa transiente e apenas uma vez.
    if (!TRANSIENTES.has(res.status) || tentativa === 2) break;
    await dormir(30_000);
  }
  throw new Error(ultimoErro);
}

/**
 * GERA JSON pelo gateway. Sem `mediaUrl` → caminho de TEXTO (grátis primeiro);
 * com `mediaUrl` (ex.: signed URL de PDF no Storage) → VISÃO (Gemini). Devolve o
 * JSON já limpo como string — o chamador faz `JSON.parse` e valida no schema dele.
 */
export async function gerarJsonViaGateway(input: {
  prompt: string;
  system?: string;
  mediaUrl?: string;
  temperature?: number;
}): Promise<RespostaGateway> {
  return postIa('/api/ia/gerar-json', input);
}

/**
 * TRANSCREVE áudio pelo gateway (Groq Whisper grátis → Gemini). O áudio vai
 * INLINE como data URI — fragmente em chunks bem abaixo de ~32MB.
 */
export async function transcreverAudioViaGateway(input: {
  audioDataUri: string;
  mime?: string;
  idioma?: string;
  prompt?: string;
}): Promise<RespostaGateway> {
  return postIa('/api/ia/transcrever', input);
}

/**
 * TRANSCREVE áudio COM SEGMENTOS temporizados (legendas) pelo gateway. Mesmo
 * failover (Whisper verbose_json → Gemini JSON). O endpoint LANÇA se não houver
 * segmentos utilizáveis — então `segmentos` vem sempre preenchido em sucesso.
 * Tempos em SEGUNDOS relativos ao áudio enviado (o chamador soma o offset do chunk).
 */
export async function transcreverAudioTemporizadoViaGateway(input: {
  audioDataUri: string;
  mime?: string;
  idioma?: string;
  prompt?: string;
}): Promise<RespostaTranscricaoTemporizada> {
  return postIa('/api/ia/transcrever', {
    ...input,
    segmentado: true,
  }) as Promise<RespostaTranscricaoTemporizada>;
}
