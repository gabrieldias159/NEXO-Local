/**
 * GET /api/nexo/tce?exercicio=2026
 *
 * Subsistema TCE-SP do NEXO — cruzamento XS-14 (fornecedor/contrato de Marília
 * citado em julgado/apontamento do Tribunal de Contas do Estado de São Paulo).
 *
 * ── ESTADO HONESTO DA INTEGRAÇÃO ──
 * O TCE-SP expõe publicamente a API de despesas (que dá a lista de
 * FORNECEDORES de Marília), mas NÃO expõe nenhuma API pública consultável de
 * JULGADOS/APONTAMENTOS filtrável por município. Logo:
 *   • o lado "fornecedores" do XS-14 funciona e é coletado de verdade;
 *   • o lado "julgados/apontamentos" fica `integracao: 'pendente'` — a rota
 *     reporta isso explicitamente em vez de simular dados.
 * Ver `src/lib/nexo/sources/tce-sp.ts` para o levantamento completo da fonte.
 *
 * Apenas dados públicos — indício, nunca acusação. LGPD.
 */
import { NextResponse } from 'next/server';
import {
  coletarFornecedoresTCE,
  coletarJulgadosTCE,
} from '@/lib/nexo/sources/tce-sp';
import type {
  FornecedorTCE,
  EstadoJulgadosTCE,
} from '@/lib/nexo/sources/tce-sp';
import { analisarTCE } from '@/lib/nexo/detectores/tce-det';
import type { AlertaDetectado } from '@/lib/nexo/detectores/tipos';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { NEXO_DISCLAIMER } from '@/lib/nexo/constants';

export const runtime = 'nodejs';
export const revalidate = 3600;
export const maxDuration = 120;

/** Quantos fornecedores devolver no payload (ordenados por valor). */
const TOP_FORNECEDORES = 200;

export interface TceResponse {
  exercicio: number;
  /** Estado do cruzamento XS-14 como um todo. */
  cruzamentoXS14: {
    /** `pendente` enquanto não há fonte pública de julgados por município. */
    integracao: 'pendente' | 'ativa';
    /** Explicação honesta do que falta para o cruzamento operar plenamente. */
    motivo: string;
  };
  /** Coleta do lado FUNCIONAL: fornecedores de Marília (API de despesas TCE). */
  fornecedores: {
    /** Erro de coleta, ou null. */
    erro: string | null;
    /** Meses (1-12) efetivamente coletados. */
    mesesColetados: number[];
    /** Registros brutos de despesa lidos. */
    registrosBrutos: number;
    /** Total de fornecedores distintos identificados. */
    total: number;
    /** Soma empenhada a todos os fornecedores no período (R$). */
    valorTotalEmpenhado: number;
    /** Fonte legível dos dados. */
    fonte: string;
    /** Top fornecedores por valor empenhado. */
    lista: FornecedorTCE[];
  };
  /** Estado do lado julgados/apontamentos (hoje sempre `pendente`). */
  julgados: EstadoJulgadosTCE;
  /** Alertas XS-14 — vazio enquanto a integração estiver pendente. */
  alertas: AlertaDetectado[];
  resumo: {
    totalFornecedores: number;
    totalAlertas: number;
    integracaoPendente: boolean;
  };
  disclaimer: string;
  atualizadoEm: string;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { searchParams } = new URL(req.url);
  const exercicio =
    Number(searchParams.get('exercicio')) || new Date().getFullYear();

  // Lado funcional: fornecedores de Marília via API pública de despesas do TCE.
  const fornecedoresColeta = await coletarFornecedoresTCE(exercicio, {
    delayMs: 120,
  });

  // Lado pendente: julgados/apontamentos. O TCE-SP não expõe isso de forma
  // consultável — `coletarJulgadosTCE` devolve estado `pendente` honesto.
  const numerosProcessoRaw = searchParams.get('processos') ?? '';
  const numerosProcesso = numerosProcessoRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const julgados = await coletarJulgadosTCE(exercicio, { numerosProcesso });

  // Detector XS-14. Com julgados/apontamentos vazios, devolve [] (sem invenção).
  const alertas = analisarTCE({
    fornecedores: fornecedoresColeta.fornecedores,
    julgados: julgados.julgados,
    apontamentos: julgados.apontamentos,
  });

  const valorTotalEmpenhado = fornecedoresColeta.fornecedores.reduce(
    (s, f) => s + f.valorEmpenhado,
    0,
  );

  const integracaoPendente = julgados.integracao === 'pendente';

  const response: TceResponse = {
    exercicio,
    cruzamentoXS14: {
      integracao: julgados.integracao,
      motivo: julgados.motivo,
    },
    fornecedores: {
      erro: fornecedoresColeta.coleta.erro,
      mesesColetados: fornecedoresColeta.coleta.mesesColetados,
      registrosBrutos: fornecedoresColeta.coleta.registrosBrutos,
      total: fornecedoresColeta.fornecedores.length,
      valorTotalEmpenhado,
      fonte: fornecedoresColeta.coleta.fonte,
      lista: fornecedoresColeta.fornecedores.slice(0, TOP_FORNECEDORES),
    },
    julgados,
    alertas,
    resumo: {
      totalFornecedores: fornecedoresColeta.fornecedores.length,
      totalAlertas: alertas.length,
      integracaoPendente,
    },
    disclaimer: NEXO_DISCLAIMER,
    atualizadoEm: new Date().toISOString(),
  };

  // Falha total da coleta de fornecedores (único lado consultável): não
  // mascarar como "nada encontrado" — devolver 502 com Cache-Control no-store.
  const falhaColeta =
    fornecedoresColeta.fornecedores.length === 0 &&
    fornecedoresColeta.coleta.erro !== null;
  if (falhaColeta) {
    return NextResponse.json(response, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // Integração parcial (fornecedores OK, julgados pendentes) é um estado
  // honesto e ESPERADO — não cacheamos como resultado definitivo.
  return NextResponse.json(response, {
    headers: {
      'Cache-Control': integracaoPendente
        ? 'no-store'
        : 'private, max-age=1800',
    },
  });
}
