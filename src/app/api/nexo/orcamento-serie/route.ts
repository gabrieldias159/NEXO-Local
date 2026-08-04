/**
 * GET /api/nexo/orcamento-serie - Serie mensal de execucao e arrecadacao.
 *
 * Retorna dados do mes, acumulado no ano e acumulado na janela de 12 meses.
 * Quando um mes nao foi observado na fonte, a API devolve `null` em vez de `0`
 * para o grafico nao inventar historico.
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import { normalizarExecucaoSintetica, dedupPorRubricaMes } from '@/lib/nexo/orcamento';
import { parseValorBR } from '@/lib/nexo/normalizar';
import { normalizarReceitas, coletarReceita, CAMPOS_RECEITA } from '@/lib/nexo/sources/receita';
import { getRREO } from '@/lib/nexo/sources/siconfi';
import { valorLinha } from '@/lib/nexo/siconfi-fiscal';

export const runtime = 'nodejs';

const headersCache = { 'Cache-Control': 'private, max-age=60' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

type ValorSerie = number | null;

const CAMPOS_DESPESA = [
  'ClassificacaoFuncional',
  'NaturezaDespesa',
  'FonteRecurso',
  'UnidadeOrcamentaria',
  'Mes',
  'DotacaoInicial',
  'DotacaoAutorizada',
  'EmpenhadoAteMes',
  'LiquidadoaPagar',
  'PagoAteMes',
  '_coletadoEm',
];

export interface PontoSerieMensal {
  chave: string;
  ano: number;
  mes: number;
  nomeMes: string;
  nomeCurto: string;
  empenhadoMes: ValorSerie;
  liquidadoMes: ValorSerie;
  pagoMes: ValorSerie;
  arrecadadoMes: ValorSerie;
  /**
   * Origem da receita deste mês: 'smarapd' = valor REAL do Portal da
   * Transparência; 'siconfi-media' = ESTIMATIVA (total anual do RREO ÷ 12 —
   * a fonte oficial é bimestral, não mensal); 'siconfi-bimestral' = valor REAL
   * consolidado do RREO Anexo 01 no fechamento do bimestre (só meses pares);
   * null = sem dado.
   */
  arrecadadoFonte: 'smarapd' | 'siconfi-media' | 'siconfi-bimestral' | null;
  empenhadoAcum: ValorSerie;
  liquidadoAcum: ValorSerie;
  pagoAcum: ValorSerie;
  arrecadadoAcum: ValorSerie;
  empenhadoAcum12m: ValorSerie;
  liquidadoAcum12m: ValorSerie;
  pagoAcum12m: ValorSerie;
  arrecadadoAcum12m: ValorSerie;
}

/** Fonte da receita: 'auto' usa o Portal e cai na média SICONFI onde faltar. */
export type FonteReceita = 'auto' | 'smarapd' | 'siconfi';

/**
 * Fonte da despesa: 'sintese' = módulo Despesa Sintética (por rubrica, publica
 * após o mês fechar — cobre os 3 estágios); 'documentos' = documentos de
 * empenho datados (inclui o mês corrente parcial, mas SÓ o empenhado tem
 * mensal — liquidado/pago não têm data própria nesse módulo); 'siconfi' =
 * RREO Anexo 01 CONSOLIDADO (inclui autarquias/fundos como o IPREMM — é o
 * número do balanço oficial), bimestral: pontos só nos meses pares, e a
 * RECEITA também vem do mesmo anexo para as linhas serem comparáveis.
 */
export type FonteDespesa = 'sintese' | 'documentos' | 'siconfi';

export interface OrcamentoSerieResponse {
  exercicio: number;
  /** Fonte de receita usada nesta resposta (parâmetro `fonteReceita`). */
  fonteReceita: FonteReceita;
  /** Fonte de despesa usada nesta resposta (parâmetro `fonteDespesa`). */
  fonteDespesa: FonteDespesa;
  serieAno: PontoSerieMensal[];
  serie12m: PontoSerieMensal[];
  atualizadoEm: string;
}

const NOMES_MESES: Record<number, { curto: string; label: string }> = {
  1: { curto: 'Jan', label: 'Janeiro' },
  2: { curto: 'Fev', label: 'Fevereiro' },
  3: { curto: 'Mar', label: 'Marco' },
  4: { curto: 'Abr', label: 'Abril' },
  5: { curto: 'Mai', label: 'Maio' },
  6: { curto: 'Jun', label: 'Junho' },
  7: { curto: 'Jul', label: 'Julho' },
  8: { curto: 'Ago', label: 'Agosto' },
  9: { curto: 'Set', label: 'Setembro' },
  10: { curto: 'Out', label: 'Outubro' },
  11: { curto: 'Nov', label: 'Novembro' },
  12: { curto: 'Dez', label: 'Dezembro' },
};

interface CacheAnoSerie {
  pontos: PontoSerieMensal[];
  ts: number;
}

const cacheSerie = new Map<string, CacheAnoSerie>();
const TTL_MS = 5 * 60 * 1000;

function numSeguro(val: unknown): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function diffMensal(acumuladoAtual: ValorSerie, acumuladoAnterior: ValorSerie): ValorSerie {
  if (acumuladoAtual == null || acumuladoAnterior == null) return null;
  return Math.max(0, acumuladoAtual - acumuladoAnterior);
}

function acumularJanela(
  pontos: PontoSerieMensal[],
  campo: 'empenhadoMes' | 'liquidadoMes' | 'pagoMes' | 'arrecadadoMes',
  index: number,
): ValorSerie {
  let total = 0;
  for (let i = 0; i <= index; i++) {
    const valor = pontos[i]?.[campo];
    if (valor == null) return null;
    total += valor;
  }
  return total;
}

function ultimoMesObservado(meses: Set<number>): number {
  return meses.size > 0 ? Math.max(...Array.from(meses)) : 0;
}

/** Valor de uma linha do RREO An. 01 por cod_conta + regex de coluna. */
function valorRREO(
  items: Record<string, unknown>[],
  codConta: string,
  colunaRegex: RegExp,
): ValorSerie {
  for (const item of items) {
    if (String(item.cod_conta ?? '') !== codConta) continue;
    if (!colunaRegex.test(String(item.coluna ?? '').toUpperCase())) continue;
    const n = Number(item.valor);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Série CONSOLIDADA a partir do RREO Anexo 01 (SICONFI). A fonte é bimestral:
 * meses pares recebem o acumulado oficial "até o bimestre" (TotalReceitas ×
 * SubtotalDasDespesas — o mesmo par do Balanço Orçamentário assinado); meses
 * ímpares ficam null (buraco honesto). O mensal vira o delta do bimestre,
 * plotado no mês par.
 */
async function carregarPontosSiconfi(exercicio: number): Promise<PontoSerieMensal[]> {
  const porBimestre: {
    bim: number;
    arrecadado: ValorSerie;
    empenhado: ValorSerie;
    liquidado: ValorSerie;
    pago: ValorSerie;
  }[] = [];

  for (let bim = 1; bim <= 6; bim++) {
    let items: Record<string, unknown>[] = [];
    try {
      items = await getRREO({ exercicio, periodo: bim, anexo: 'RREO-Anexo 01' });
    } catch {
      break; // rede/limite — publica o que já tem
    }
    if (!items.length) break; // bimestre ainda não transmitido
    porBimestre.push({
      bim,
      arrecadado: valorRREO(items, 'TotalReceitas', /^AT[EÉ] O BIMESTRE/),
      empenhado: valorRREO(items, 'SubtotalDasDespesas', /EMPENHADAS AT[EÉ] O BIMESTRE/),
      liquidado: valorRREO(items, 'SubtotalDasDespesas', /LIQUIDADAS AT[EÉ] O BIMESTRE/),
      pago: valorRREO(items, 'SubtotalDasDespesas', /PAGAS AT[EÉ] O BIMESTRE/),
    });
  }

  const pontos: PontoSerieMensal[] = [];
  const totalMeses = porBimestre.length * 2;
  let anterior: (typeof porBimestre)[number] | null = null;

  for (let mes = 1; mes <= totalMeses; mes++) {
    const nomeMes = NOMES_MESES[mes] ?? { curto: `M${mes}`, label: `Mes ${mes}` };
    const ano2 = String(exercicio).slice(-2);
    const base: PontoSerieMensal = {
      chave: `${exercicio}-${String(mes).padStart(2, '0')}`,
      ano: exercicio,
      mes,
      nomeMes: `${nomeMes.curto}/${ano2}`,
      nomeCurto: nomeMes.curto,
      empenhadoMes: null,
      liquidadoMes: null,
      pagoMes: null,
      arrecadadoMes: null,
      arrecadadoFonte: null,
      empenhadoAcum: null,
      liquidadoAcum: null,
      pagoAcum: null,
      arrecadadoAcum: null,
      empenhadoAcum12m: null,
      liquidadoAcum12m: null,
      pagoAcum12m: null,
      arrecadadoAcum12m: null,
    };

    if (mes % 2 === 0) {
      const b = porBimestre[mes / 2 - 1];
      if (b) {
        base.arrecadadoAcum = b.arrecadado;
        base.empenhadoAcum = b.empenhado;
        base.liquidadoAcum = b.liquidado;
        base.pagoAcum = b.pago;
        base.arrecadadoMes = diffMensal(b.arrecadado, anterior?.arrecadado ?? 0);
        base.empenhadoMes = diffMensal(b.empenhado, anterior?.empenhado ?? 0);
        base.liquidadoMes = diffMensal(b.liquidado, anterior?.liquidado ?? 0);
        base.pagoMes = diffMensal(b.pago, anterior?.pago ?? 0);
        base.arrecadadoFonte = b.arrecadado == null ? null : 'siconfi-bimestral';
        anterior = b;
      }
    }
    pontos.push(base);
  }
  return pontos;
}

async function carregarPontosAno(
  exercicio: number,
  idToken: string,
  fonteReceita: FonteReceita,
  fonteDespesa: FonteDespesa,
): Promise<PontoSerieMensal[]> {
  const chaveCache = `${exercicio}:${fonteReceita}:${fonteDespesa}`;
  const cache = cacheSerie.get(chaveCache);
  if (cache && Date.now() - cache.ts < TTL_MS) {
    return cache.pontos;
  }

  // Modo CONSOLIDADO: despesa E receita saem do RREO An. 01 — o parâmetro de
  // receita é ignorado de propósito (misturar recortes é o que este modo evita).
  if (fonteDespesa === 'siconfi') {
    const pontosSiconfi = await carregarPontosSiconfi(exercicio);
    cacheSerie.set(chaveCache, { pontos: pontosSiconfi, ts: Date.now() });
    return pontosSiconfi;
  }

  const [docsDespesa, docsReceita] = await Promise.all([
    lerColecaoNexo(
      'nexo_despesa_sintetica',
      { exercicio, fonte: 'despesa_sintetica' },
      idToken,
      CAMPOS_DESPESA,
    ),
    lerColecaoNexo('nexo_receita', { exercicio, fonte: 'receita' }, idToken, CAMPOS_RECEITA),
  ]);

  const rubricas = normalizarExecucaoSintetica(docsDespesa);
  // 'siconfi' ignora o Portal de propósito; 'smarapd' NUNCA cai na média SICONFI
  // (mês sem dado do Portal fica null — buraco honesto, não estimativa).
  let receitas = fonteReceita === 'siconfi' ? [] : normalizarReceitas(docsReceita, exercicio);
  let receitaDistribuida = false;

  if (receitas.length === 0 && fonteReceita !== 'siconfi') {
    try {
      const coleta = await coletarReceita(exercicio, { maxPaginas: 20, delayMs: 120 });
      receitas = coleta.registros;
    } catch {
      // segue sem fonte ao vivo
    }
  }

  if (receitas.length === 0 && fonteReceita !== 'smarapd') {
    try {
      const rreoAnexo01 = await getRREO({ exercicio, periodo: 6, anexo: 'RREO-Anexo 01' });
      const receitaTotal =
        valorLinha(rreoAnexo01, [/RECEITAS CORRENTES/], /AT[EÉ] O BIMESTRE/) ??
        valorLinha(rreoAnexo01, [/RECEITASCORRENTES/], /AT[EÉ] O BIMESTRE/);

      if (receitaTotal && receitaTotal > 0) {
        receitaDistribuida = true;
        const porMes = receitaTotal / 12;
        for (let mes = 1; mes <= 12; mes++) {
          receitas.push({
            conta: 'RREO.SICONFI',
            descricao: 'Receitas Correntes (SICONFI RREO Anexo 01)',
            mes,
            exercicio,
            previsto: 0,
            arrecadado: porMes,
            familia: 'outras',
          });
        }
      }
    } catch {
      // segue sem fallback
    }
  }

  // Os campos "AteMes" são acumulados POR RUBRICA, mas a fonte não republica
  // TODAS as rubricas todo mês (cobertura oscila) e re-serve rubrica×mês com
  // valores corrigidos (duplicatas por hash de conteúdo). Somar as linhas do
  // mês direto infla meses com duplicata e faz o ACUMULADO REGREDIR em meses de
  // cobertura parcial — impossível por definição. Correção: dedupe (coleta mais
  // recente por rubrica×mês) + CARRY-FORWARD (o acumulado do mês M soma, por
  // rubrica, o último snapshot observado ≤ M).
  const totaisDespesaPorMes = new Map<number, { empenhado: number; liquidado: number; pago: number }>();
  const mesesDespesa = new Set<number>();
  const docsMode = fonteDespesa === 'documentos';

  if (docsMode) {
    // EMPENHADO mensal direto dos DOCUMENTOS de empenho (DataMovEmp) — inclui o
    // mês corrente parcial, que a Despesa Sintética só publica após o fechamento.
    // Anulações vêm com valor NEGATIVO na fonte (a soma já sai líquida).
    // Liquidado/pago não têm data própria neste módulo (só drill-down por
    // empenho) → nesta fonte ficam null no mensal.
    const docsEmp = await lerColecaoNexo(
      'nexo_despesas',
      { exercicio, fonte: 'despesas' },
      idToken,
      ['DataMovEmp', 'ValorEmpenhado'],
    );
    const porMesDoc = new Map<number, number>();
    for (const d of docsEmp) {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(d.DataMovEmp ?? '').trim());
      if (!m || Number(m[3]) !== exercicio) continue;
      const mes = Number(m[2]);
      if (mes < 1 || mes > 12) continue;
      porMesDoc.set(mes, (porMesDoc.get(mes) ?? 0) + parseValorBR(d.ValorEmpenhado));
    }
    let acumDoc = 0;
    const ultimoMesDoc = porMesDoc.size > 0 ? Math.max(...porMesDoc.keys()) : 0;
    for (let mes = 1; mes <= ultimoMesDoc; mes++) {
      acumDoc += porMesDoc.get(mes) ?? 0;
      mesesDespesa.add(mes);
      totaisDespesaPorMes.set(mes, { empenhado: acumDoc, liquidado: 0, pago: 0 });
    }
  } else {
    const linhasDedup = dedupPorRubricaMes(
      rubricas.filter((r) => r.mes >= 1 && r.mes <= 12),
    );
    for (const r of linhasDedup) mesesDespesa.add(r.mes);
    const porRubricaSerie = new Map<string, Map<number, { empenhado: number; liquidado: number; pago: number }>>();
    for (const r of linhasDedup) {
      const meses = porRubricaSerie.get(r.id) ?? new Map();
      meses.set(r.mes, {
        empenhado: numSeguro(r.empenhado),
        liquidado: numSeguro(r.liquidado),
        pago: numSeguro(r.pago),
      });
      porRubricaSerie.set(r.id, meses);
    }

    const ultimoMesDespesa = ultimoMesObservado(mesesDespesa);
    for (const meses of porRubricaSerie.values()) {
      const ordenados = [...meses.keys()].sort((a, b) => a - b);
      let idx = 0;
      let vigente: { empenhado: number; liquidado: number; pago: number } | null = null;
      for (let mes = 1; mes <= ultimoMesDespesa; mes++) {
        while (idx < ordenados.length && ordenados[idx] <= mes) {
          vigente = meses.get(ordenados[idx]) ?? vigente;
          idx++;
        }
        if (!vigente) continue;
        const t = totaisDespesaPorMes.get(mes) ?? { empenhado: 0, liquidado: 0, pago: 0 };
        t.empenhado += vigente.empenhado;
        t.liquidado += vigente.liquidado;
        t.pago += vigente.pago;
        totaisDespesaPorMes.set(mes, t);
      }
    }
  }

  const totaisReceitaPorMes = new Map<number, number>();
  const mesesReceita = new Set<number>();
  for (const receita of receitas) {
    if (receita.mes < 1 || receita.mes > 12) continue;
    mesesReceita.add(receita.mes);
    totaisReceitaPorMes.set(
      receita.mes,
      (totaisReceitaPorMes.get(receita.mes) ?? 0) + numSeguro(receita.arrecadado),
    );
  }

  const mesesComDados = new Set<number>([...mesesDespesa, ...mesesReceita]);
  const maxMesEncontrado =
    mesesComDados.size > 0
      ? Math.max(...Array.from(mesesComDados))
      : exercicio < new Date().getFullYear()
        ? 12
        : 7;
  const totalMeses = Math.min(12, Math.max(1, maxMesEncontrado));
  const maiorMesReceita = ultimoMesObservado(mesesReceita);
  const receitaAnualSemMeses = receitas.length > 0 && !receitas.some((r) => r.mes > 0);

  const pontos: PontoSerieMensal[] = [];
  let empenhadoAcumAnterior: ValorSerie = null;
  let liquidadoAcumAnterior: ValorSerie = null;
  let pagoAcumAnterior: ValorSerie = null;
  let arrecadadoAcumAnterior: ValorSerie = 0;

  for (let mes = 1; mes <= totalMeses; mes++) {
    const totalDespesaMes = totaisDespesaPorMes.get(mes);
    const empenhadoAcum = totalDespesaMes?.empenhado ?? null;
    // No modo documentos, liquidado/pago não têm mensal (sem data na fonte).
    const liquidadoAcum = docsMode ? null : totalDespesaMes?.liquidado ?? null;
    const pagoAcum = docsMode ? null : totalDespesaMes?.pago ?? null;

    const temReceitaObservavel =
      receitaDistribuida || receitaAnualSemMeses || mesesReceita.has(mes) || (maiorMesReceita > 0 && mes <= maiorMesReceita);

    let arrecadadoMes: ValorSerie = temReceitaObservavel ? (totaisReceitaPorMes.get(mes) ?? 0) : null;
    if (arrecadadoMes === 0 && receitaAnualSemMeses) {
      const totalAnual = receitas
        .filter((receita) => receita.mes === 0)
        .reduce((soma, receita) => soma + numSeguro(receita.arrecadado), 0);
      arrecadadoMes = totalAnual / totalMeses;
    }

    const empenhadoMes = mes === 1 ? empenhadoAcum : diffMensal(empenhadoAcum, empenhadoAcumAnterior);
    const liquidadoMes = mes === 1 ? liquidadoAcum : diffMensal(liquidadoAcum, liquidadoAcumAnterior);
    const pagoMes = mes === 1 ? pagoAcum : diffMensal(pagoAcum, pagoAcumAnterior);
    const arrecadadoAcum: ValorSerie =
      arrecadadoAcumAnterior == null || arrecadadoMes == null ? null : arrecadadoAcumAnterior + arrecadadoMes;

    const nomeMes = NOMES_MESES[mes] ?? { curto: `M${mes}`, label: `Mes ${mes}` };
    const ano2 = String(exercicio).slice(-2);

    pontos.push({
      chave: `${exercicio}-${String(mes).padStart(2, '0')}`,
      ano: exercicio,
      mes,
      nomeMes: `${nomeMes.curto}/${ano2}`,
      nomeCurto: nomeMes.curto,
      empenhadoMes,
      liquidadoMes,
      pagoMes,
      arrecadadoMes,
      arrecadadoFonte:
        arrecadadoMes == null ? null : receitaDistribuida ? 'siconfi-media' : 'smarapd',
      empenhadoAcum,
      liquidadoAcum,
      pagoAcum,
      arrecadadoAcum,
      empenhadoAcum12m: empenhadoAcum,
      liquidadoAcum12m: liquidadoAcum,
      pagoAcum12m: pagoAcum,
      arrecadadoAcum12m: arrecadadoAcum,
    });

    empenhadoAcumAnterior = empenhadoAcum;
    liquidadoAcumAnterior = liquidadoAcum;
    pagoAcumAnterior = pagoAcum;
    arrecadadoAcumAnterior = arrecadadoAcum;
  }

  cacheSerie.set(chaveCache, { pontos, ts: Date.now() });
  return pontos;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json({ erro: 'Acesso negado' }, { status: sessao.status, headers: headersNoStore });
  }

  try {
    const { searchParams } = new URL(req.url);
    const exercicio = Number(searchParams.get('exercicio')) || new Date().getFullYear();
    const fonteParam = searchParams.get('fonteReceita');
    const fonteReceita: FonteReceita =
      fonteParam === 'smarapd' || fonteParam === 'siconfi' ? fonteParam : 'auto';
    const fonteDespesaParam = searchParams.get('fonteDespesa');
    const fonteDespesa: FonteDespesa =
      fonteDespesaParam === 'documentos' || fonteDespesaParam === 'siconfi'
        ? fonteDespesaParam
        : 'sintese';

    const pontosAno = await carregarPontosAno(exercicio, sessao.idToken, fonteReceita, fonteDespesa);
    let pontosAnterior: PontoSerieMensal[] = [];
    if (pontosAno.length < 12) {
      try {
        pontosAnterior = await carregarPontosAno(exercicio - 1, sessao.idToken, fonteReceita, fonteDespesa);
      } catch {
        // segue apenas com o ano atual
      }
    }

    const numFaltantes = 12 - pontosAno.length;
    const mesesAnteriores = numFaltantes > 0 ? pontosAnterior.slice(-numFaltantes) : [];
    const combinados12m = [...mesesAnteriores, ...pontosAno].slice(-12);

    const serie12m: PontoSerieMensal[] = combinados12m.map((ponto, index, array) => ({
      ...ponto,
      empenhadoAcum12m: acumularJanela(array, 'empenhadoMes', index),
      liquidadoAcum12m: acumularJanela(array, 'liquidadoMes', index),
      pagoAcum12m: acumularJanela(array, 'pagoMes', index),
      arrecadadoAcum12m: acumularJanela(array, 'arrecadadoMes', index),
    }));

    const resp: OrcamentoSerieResponse = {
      exercicio,
      fonteReceita,
      fonteDespesa,
      serieAno: pontosAno,
      serie12m,
      atualizadoEm: new Date().toISOString(),
    };

    return NextResponse.json(resp, { status: 200, headers: headersCache });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro ao processar serie orcamentaria';
    return NextResponse.json({ erro: msg }, { status: 500, headers: headersNoStore });
  }
}
