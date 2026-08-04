/**
 * POST /api/nexo/gerente
 *
 * Vertical GERENTE — recebe o estado do NEXO (alertas ativos top-priorizados +
 * saúde das fontes) e devolve um BRIEFING de gestão da fiscalização gerado pelo
 * flow Genkit `nexo-gerente-flow`. NÃO grava nada — é cômputo puro (IA). Quem
 * persiste o briefing em `nexo_briefings` é a Cloud Function `onNexoGerente`
 * (cron a cada 30 min), que tem `firebase-admin`; o app só tem o Gemini.
 *
 * Proteção: header `x-nexo-secret`, comparado a `NEXO_DETECTAR_SECRET` (ou, em
 * fallback, `DIARIO_BACKFILL_SECRET`) — idêntica à de `/api/nexo/detectar`. Sem
 * segredo no ambiente → 503 honesto (não fica aberta por omissão).
 *
 * CONTRATO DA REQUISIÇÃO (fixado — a Cloud Function manda exatamente isto):
 *   POST body JSON:
 *   {
 *     alertas: [{ detectorId, titulo, classificacao, valorEnvolvido,
 *                 scores: { confiabilidade?, probabilidadeIrregularidade?,
 *                           probabilidadeEnquadramento? },
 *                 ultimaDeteccaoEm }],
 *     fontes:  [{ fonte, statusSaude, erro }]
 *   }
 *
 * CONTRATO DA RESPOSTA (fixado):
 *   { briefing: { resumo, topPrioridades: [{ titulo, porque }],
 *                 fontesDegradadas: string[], proximaAcao } }
 *
 * Gemini ausente → 503 honesto (a Function loga e grava sync degradado).
 */
import { NextResponse } from 'next/server';
import { haAlgumProvedorDeIa } from '@/ai/multi-provider';
import {
  gerarBriefingGerente,
  type NexoGerenteInput,
} from '@/ai/flows/nexo-gerente-flow';

export const runtime = 'nodejs';
export const maxDuration = 120;

const SEM_CACHE = { 'Cache-Control': 'no-store' } as const;

/** Coage a string ou null (vazio → null). */
function textoOuNulo(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
/** Coage a número finito (default 0). */
function numero(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
/** Coage a número finito opcional (undefined quando ausente/inválido). */
function numeroOpcional(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Normaliza um alerta bruto do payload para o schema do flow (tolerante). */
function comoAlerta(raw: unknown): NexoGerenteInput['alertas'][number] {
  const a = (raw ?? {}) as Record<string, unknown>;
  const scores = (a.scores ?? {}) as Record<string, unknown>;
  return {
    detectorId: textoOuNulo(a.detectorId) ?? '',
    titulo: textoOuNulo(a.titulo) ?? '',
    classificacao: textoOuNulo(a.classificacao) ?? 'informativo',
    valorEnvolvido: numero(a.valorEnvolvido),
    scores: {
      confiabilidade: numeroOpcional(scores.confiabilidade),
      probabilidadeIrregularidade: numeroOpcional(
        scores.probabilidadeIrregularidade,
      ),
      probabilidadeEnquadramento: numeroOpcional(
        scores.probabilidadeEnquadramento,
      ),
    },
    ultimaDeteccaoEm: textoOuNulo(a.ultimaDeteccaoEm),
  };
}

/** Normaliza uma fonte bruta do payload para o schema do flow (tolerante). */
function comoFonte(raw: unknown): NexoGerenteInput['fontes'][number] {
  const f = (raw ?? {}) as Record<string, unknown>;
  return {
    fonte: textoOuNulo(f.fonte) ?? '',
    statusSaude: textoOuNulo(f.statusSaude) ?? 'ok',
    erro: textoOuNulo(f.erro),
  };
}

export async function POST(req: Request) {
  // 1. Proteção por segredo compartilhado (mesma de /api/nexo/detectar).
  const segredo =
    process.env.NEXO_DETECTAR_SECRET ?? process.env.DIARIO_BACKFILL_SECRET;
  if (!segredo) {
    return NextResponse.json(
      { erro: 'rota do gerente não configurada (segredo ausente)' },
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
  const corpo = (body ?? {}) as { alertas?: unknown; fontes?: unknown };
  const alertasBrutos = Array.isArray(corpo.alertas) ? corpo.alertas : [];
  const fontesBrutas = Array.isArray(corpo.fontes) ? corpo.fontes : [];

  const input: NexoGerenteInput = {
    alertas: alertasBrutos.map(comoAlerta),
    fontes: fontesBrutas.map(comoFonte),
  };

  // 4. Chama o flow Genkit. Falha do modelo → 502 (a Function loga e degrada).
  let briefing;
  try {
    briefing = await gerarBriefingGerente(input);
  } catch (err) {
    return NextResponse.json(
      { erro: err instanceof Error ? err.message : 'falha ao gerar briefing' },
      { status: 502, headers: SEM_CACHE },
    );
  }

  return NextResponse.json({ briefing }, { headers: SEM_CACHE });
}
