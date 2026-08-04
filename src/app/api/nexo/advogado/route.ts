/**
 * POST /api/nexo/advogado
 *
 * Vertical ADVOGADO — recebe os alertas ABERTOS e devolve, para cada um, o
 * PARECER jurídico (enquadramento em norma administrativa cogente + checklist de
 * aderência + minuta de representação) gerado pelo flow Genkit
 * `nexo-advogado-flow`. NÃO grava nada — é cômputo puro (IA). Quem persiste em
 * `nexo_pareceres` é a Cloud Function `onNexoAdvogado` (cron a cada 1 hora), que
 * tem `firebase-admin`; o app só tem o Gemini.
 *
 * Proteção: header `x-nexo-secret`, comparado a `NEXO_DETECTAR_SECRET` (ou, em
 * fallback, `DIARIO_BACKFILL_SECRET`) — idêntica à de `/api/nexo/detectar` e
 * `/api/nexo/gerente`. Sem segredo no ambiente → 503 honesto (não fica aberta
 * por omissão).
 *
 * CONTRATO DA REQUISIÇÃO (fixado — a Cloud Function manda exatamente isto):
 *   POST body JSON:
 *   {
 *     alertas: [{ chaveDeteccao, detectorId, titulo, descricao, classificacao,
 *                 fundamentoLegal: string[],
 *                 evidencias: [{ resumo, valor?, data? }] }]
 *   }
 *
 * CONTRATO DA RESPOSTA (fixado):
 *   { pareceres: [{ chaveDeteccao, enquadramento, normaPrincipal,
 *                   aderenciaNorma, minutaRepresentacao }] }
 *
 * Gemini ausente → 503 honesto (a Function loga e grava sync degradado).
 */
import { NextResponse } from 'next/server';
import { haAlgumProvedorDeIa } from '@/ai/multi-provider';
import {
  rodarAdvogado,
  type NexoAdvogadoInput,
} from '@/ai/flows/nexo-advogado-flow';

export const runtime = 'nodejs';
export const maxDuration = 300;

const SEM_CACHE = { 'Cache-Control': 'no-store' } as const;

/**
 * Detecta, pela mensagem do erro do flow, que a camada de IA está ESGOTADA /
 * indisponível por motivo TRANSITÓRIO (não um bug nosso): todos os provedores
 * caíram (429/rate-limit/quota/spending cap, 5xx, timeout). O orquestrador
 * multi-provider lança `Error('Todos os provedores de IA falharam. Detalhes:
 * ...')` agregando as causas, ou `NoDriverForCapability`. Distinguir esse caso
 * de uma falha dura permite à rota devolver 503 + Retry-After em vez de 502 —
 * sinal HONESTO de "tente de novo mais tarde", que o cron (`onNexoAdvogado`)
 * lê para DEGRADAR (parar de martelar o lote inteiro) em vez de queimar quota.
 */
function ehIaEsgotada(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /todos os provedores/.test(msg) ||
    /nodriverforcapability|sem driver/.test(msg) ||
    /\b429\b|rate.?limit|too many requests/.test(msg) ||
    /resource_exhausted|quota|spending cap|limite de requisi/.test(msg) ||
    /\b5\d\d\b|timeout|timed out|aborted|esgotad/.test(msg)
  );
}

/**
 * Janela (s) que pedimos ao chamador (cron) para esperar antes de retentar
 * quando a IA está esgotada. Casa com a cadência de 6h do cron: não adianta
 * martelar enquanto a quota não recompõe.
 */
const RETRY_AFTER_IA_ESGOTADA_S = 1800;

/** Coage a string (default ''). */
function texto(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
/** Coage a string ou null (vazio → null). */
function textoOuNulo(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
/** Coage a número finito opcional (undefined quando ausente/inválido). */
function numeroOpcional(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
/** Coage a array de strings (filtra não-strings vazias). */
function listaTexto(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => texto(x)).filter((s) => s.length > 0);
}

/** Normaliza uma evidência bruta do payload para o schema do flow (tolerante). */
function comoEvidencia(
  raw: unknown,
): NexoAdvogadoInput['alertas'][number]['evidencias'][number] {
  const e = (raw ?? {}) as Record<string, unknown>;
  return {
    resumo: texto(e.resumo),
    valor: numeroOpcional(e.valor),
    data: textoOuNulo(e.data),
  };
}

/** Normaliza um alerta bruto do payload para o schema do flow (tolerante). */
function comoAlerta(raw: unknown): NexoAdvogadoInput['alertas'][number] {
  const a = (raw ?? {}) as Record<string, unknown>;
  const evidencias = Array.isArray(a.evidencias) ? a.evidencias : [];
  return {
    chaveDeteccao: texto(a.chaveDeteccao),
    detectorId: texto(a.detectorId),
    titulo: texto(a.titulo),
    descricao: texto(a.descricao),
    classificacao: textoOuNulo(a.classificacao) ?? 'informativo',
    fundamentoLegal: listaTexto(a.fundamentoLegal),
    evidencias: evidencias.map(comoEvidencia),
  };
}

export async function POST(req: Request) {
  // 1. Proteção por segredo compartilhado (mesma de /api/nexo/detectar).
  const segredo =
    process.env.NEXO_DETECTAR_SECRET ?? process.env.DIARIO_BACKFILL_SECRET;
  if (!segredo) {
    return NextResponse.json(
      { erro: 'rota do advogado não configurada (segredo ausente)' },
      { status: 503, headers: SEM_CACHE },
    );
  }
  const enviado = req.headers.get('x-nexo-secret') ?? '';
  if (enviado !== segredo) {
    return NextResponse.json(
      { erro: 'acesso negado' },
      { status: 401, headers: SEM_CACHE },
    );
  }

  // 2. Nenhum provedor de IA configurado → 503 honesto. A cadeia usa os grátis
  //    (NVIDIA/Groq/OpenRouter) primeiro e o Gemini de fallback; basta UM estar
  //    no env. A Function loga e grava sync degradado.
  if (!haAlgumProvedorDeIa()) {
    return NextResponse.json(
      {
        erro:
          'IA indisponível: configure ao menos um provedor ' +
          '(NVIDIA_API_KEY/GROQ_API_KEY/OPENROUTER_API_KEY ou GEMINI_API_KEY)',
      },
      { status: 503, headers: SEM_CACHE },
    );
  }

  // 3. Body — contrato fixado com a Cloud Function.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { erro: 'corpo inválido — JSON esperado' },
      { status: 400, headers: SEM_CACHE },
    );
  }
  const corpo = (body ?? {}) as { alertas?: unknown };
  const alertasBrutos = Array.isArray(corpo.alertas) ? corpo.alertas : [];

  // Só alertas com chave de detecção entram — é a identidade que liga o parecer
  // de volta ao alerta (doc id em nexo_pareceres). Sem chave, descarta.
  const alertas = alertasBrutos
    .map(comoAlerta)
    .filter((a) => a.chaveDeteccao.length > 0);

  const input: NexoAdvogadoInput = { alertas };

  // 4. Chama o flow Genkit. Duas classes de falha, tratadas DIFERENTE para que o
  //    cron degrade em vez de martelar:
  //    - IA ESGOTADA / indisponível (todos os provedores caíram, 429/quota/5xx/
  //      timeout): 503 + Retry-After. É transitório — o cron deve recuar, não
  //      insistir no lote seguinte queimando quota (raiz dos 264 erros do P0-2).
  //    - Falha DURA (bug/contrato): 502, como antes.
  let resultado;
  try {
    resultado = await rodarAdvogado(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'falha ao gerar pareceres';
    if (ehIaEsgotada(err)) {
      return NextResponse.json(
        { erro: msg, esgotado: true },
        {
          status: 503,
          headers: {
            ...SEM_CACHE,
            'Retry-After': String(RETRY_AFTER_IA_ESGOTADA_S),
          },
        },
      );
    }
    return NextResponse.json({ erro: msg }, { status: 502, headers: SEM_CACHE });
  }

  return NextResponse.json(
    { pareceres: resultado.pareceres },
    { headers: SEM_CACHE },
  );
}
