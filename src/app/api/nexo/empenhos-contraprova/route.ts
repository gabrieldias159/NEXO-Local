/**
 * GET /api/nexo/empenhos-contraprova — CONTRAPROVA DOCUMENTAL da execução.
 *
 * Computa totais e série mensal DIRETO dos documentos de empenho do Portal da
 * Transparência (coleção `nexo_despesas` — visão `DespesaseInvestimentos`/
 * `DespesaAgrupada`: 1 doc por MOVIMENTO de empenho, `TipEmpenho` "Empenho" ou
 * "Anulação de Empenho" com valor negativo, datado por `DataMovEmp`).
 *
 * É uma medição INDEPENDENTE das outras duas telas: os cards macrofiscais usam
 * SICONFI (oficial, bimestral, consolidado) e a Execução Orçamentária usa a
 * síntese por rubrica (`DespesaSintetica`). Divergências entre as três são
 * esperadas por período/escopo — o valor da contraprova é justamente expor os
 * três números lado a lado.
 *
 * Runtime nodejs. Leitura cacheada ~5 min por exercício.
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import { parseValorBR } from '@/lib/nexo/normalizar';

export const runtime = 'nodejs';

const headersCache = { 'Cache-Control': 'private, max-age=60' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

const CAMPOS = [
  'NroEmpenho',
  'TipEmpenho',
  'DataMovEmp',
  'ValorEmpenhado',
  'ValorLiquidado',
  'ValorPago',
  '_coletadoEm',
];

const NOMES_CURTOS = ['', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

export interface PontoContraprova {
  mes: number;
  nomeCurto: string;
  /** Empenhado do mês já líquido de anulações (movimentos datados no mês). */
  empenhadoLiquido: number;
  /** Valor anulado no mês (positivo, para exibição). */
  anulado: number;
  movimentos: number;
}

export interface ContraprovaResponse {
  exercicio: number;
  documentos: {
    totalMovimentos: number;
    empenhos: number;
    anulacoes: number;
    /** Nº de empenhos distintos (por NroEmpenho). */
    empenhosDistintos: number;
  };
  totais: {
    /** Soma de ValorEmpenhado de todos os movimentos (anulações são negativas). */
    empenhadoLiquido: number;
    /** Total anulado (positivo). */
    anulado: number;
    liquidado: number;
    pago: number;
    /** empenhado − liquidado: obrigações assumidas ainda sem entrega atestada. */
    aLiquidar: number;
    /** liquidado − pago: RAP processado em formação (devido e não desembolsado). */
    aPagar: number;
  };
  seriePorMes: PontoContraprova[];
  /** ISO da coleta mais recente dos documentos — o "até quando" desta medição. */
  ultimaColeta: string | null;
  ingestao: { status: 'ok' | 'pendente' };
  atualizadoEm: string;
}

interface CacheAno {
  resp: Omit<ContraprovaResponse, 'atualizadoEm'>;
  ts: number;
}
const cache = new Map<number, CacheAno>();
const TTL_MS = 5 * 60 * 1000;

/** Mês (1–12) de uma data "dd/MM/yyyy[ HH:mm]" do próprio exercício. */
function mesDe(data: unknown, exercicio: number): number {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(data ?? '').trim());
  if (!m) return 0;
  if (Number(m[3]) !== exercicio) return 0;
  const mes = Number(m[2]);
  return mes >= 1 && mes <= 12 ? mes : 0;
}

async function computar(exercicio: number, idToken: string): Promise<Omit<ContraprovaResponse, 'atualizadoEm'>> {
  const c = cache.get(exercicio);
  if (c && Date.now() - c.ts < TTL_MS) return c.resp;

  const docs = await lerColecaoNexo(
    'nexo_despesas',
    { exercicio, fonte: 'despesas' },
    idToken,
    CAMPOS,
  );

  const nros = new Set<string>();
  let empenhos = 0;
  let anulacoes = 0;
  let empenhadoLiquido = 0;
  let anulado = 0;
  let liquidado = 0;
  let pago = 0;
  let ultimaColeta: string | null = null;
  const porMes = new Map<number, { empenhadoLiquido: number; anulado: number; movimentos: number }>();

  for (const d of docs) {
    const valor = parseValorBR(d.ValorEmpenhado);
    const ehAnulacao = /anula/i.test(String(d.TipEmpenho ?? ''));
    if (ehAnulacao) {
      anulacoes++;
      anulado += Math.abs(valor);
    } else {
      empenhos++;
    }
    empenhadoLiquido += valor;
    liquidado += parseValorBR(d.ValorLiquidado);
    pago += parseValorBR(d.ValorPago);
    const nro = String(d.NroEmpenho ?? '').trim();
    if (nro) nros.add(nro);
    const coletado = typeof d._coletadoEm === 'string' ? d._coletadoEm : null;
    if (coletado && (!ultimaColeta || coletado > ultimaColeta)) ultimaColeta = coletado;

    const mes = mesDe(d.DataMovEmp, exercicio);
    if (mes > 0) {
      const p = porMes.get(mes) ?? { empenhadoLiquido: 0, anulado: 0, movimentos: 0 };
      p.empenhadoLiquido += valor;
      if (ehAnulacao) p.anulado += Math.abs(valor);
      p.movimentos++;
      porMes.set(mes, p);
    }
  }

  const seriePorMes: PontoContraprova[] = [...porMes.keys()]
    .sort((a, b) => a - b)
    .map((mes) => ({
      mes,
      nomeCurto: NOMES_CURTOS[mes] ?? `M${mes}`,
      ...porMes.get(mes)!,
    }));

  const resp: Omit<ContraprovaResponse, 'atualizadoEm'> = {
    exercicio,
    documentos: {
      totalMovimentos: docs.length,
      empenhos,
      anulacoes,
      empenhosDistintos: nros.size,
    },
    totais: {
      empenhadoLiquido,
      anulado,
      liquidado,
      pago,
      aLiquidar: empenhadoLiquido - liquidado,
      aPagar: liquidado - pago,
    },
    seriePorMes,
    ultimaColeta,
    ingestao: { status: docs.length > 0 ? 'ok' : 'pendente' },
  };

  if (cache.size >= 8) {
    const velho = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (velho) cache.delete(velho[0]);
  }
  cache.set(exercicio, { resp, ts: Date.now() });
  return resp;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: headersNoStore },
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const exercicio = Number(searchParams.get('exercicio')) || new Date().getFullYear();
    const base = await computar(exercicio, sessao.idToken);
    const resp: ContraprovaResponse = { ...base, atualizadoEm: new Date().toISOString() };
    return NextResponse.json(resp, { headers: headersCache });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erro ao computar contraprova';
    return NextResponse.json({ erro: msg }, { status: 500, headers: headersNoStore });
  }
}
