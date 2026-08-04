/**
 * Detectores da RECEITA — categoria RC do catálogo (docs/nexo §14).
 *
 *  RC-01 — Queda atípica de arrecadação de um tributo (outlier mensal).
 *  RC-02 — Receita prevista sem realização (rubrica orçada na LOA sem
 *          arrecadação correspondente no exercício).
 *  RC-05 — Receita de transferência abaixo do esperado.
 *
 * Todos os alertas são INDÍCIO a apurar — nunca acusação. Ver plano-mestre
 * §6–§7. Os detectores trabalham só com dados públicos (Portal da
 * Transparência de Marília) e degradam silenciosamente quando não há dados
 * suficientes para a análise.
 */
import { formatBRL } from '../normalizar';
import type { ReceitaNorm } from '../sources/receita';
import type { AlertaDetectado } from './tipos';

const CATEGORIA = 'Receita e renúncia';

/** Soma valores numéricos de forma segura. */
function soma(ns: number[]): number {
  return ns.reduce((s, n) => s + n, 0);
}

function media(ns: number[]): number {
  return ns.length ? soma(ns) / ns.length : 0;
}

function desvioPadrao(ns: number[], m: number): number {
  if (ns.length < 2) return 0;
  const v = soma(ns.map((n) => (n - m) ** 2)) / ns.length;
  return Math.sqrt(v);
}

/** Agrupa receitas por conta, mantendo a descrição mais informativa. */
function agruparPorConta(
  receitas: ReceitaNorm[],
): Map<string, { descricao: string; familia: string; itens: ReceitaNorm[] }> {
  const out = new Map<
    string,
    { descricao: string; familia: string; itens: ReceitaNorm[] }
  >();
  for (const r of receitas) {
    const chave = r.conta || r.descricao;
    if (!chave) continue;
    const cur =
      out.get(chave) ?? { descricao: r.descricao, familia: r.familia, itens: [] };
    if (!cur.descricao && r.descricao) cur.descricao = r.descricao;
    cur.itens.push(r);
    out.set(chave, cur);
  }
  return out;
}

// ── RC-01 — Queda atípica de arrecadação de um tributo ───────────────────────

/**
 * RC-01: para cada conta de receita tributária, monta a série mensal de
 * arrecadação e sinaliza meses que ficam muito abaixo da média (outlier
 * inferior, abaixo de média − 2 desvios). Indício de queda atípica — pode ter
 * causa legítima (sazonalidade, calendário de lançamento), por isso é
 * "atenção", não "suspeita".
 */
export function detectarQuedaArrecadacao(receitas: ReceitaNorm[]): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];
  const grupos = agruparPorConta(
    receitas.filter((r) => r.familia === 'tributaria' && r.mes >= 1 && r.mes <= 12),
  );

  for (const [conta, g] of grupos) {
    // Série mensal: um valor por mês com arrecadação registrada.
    const porMes = new Map<number, number>();
    for (const r of g.itens) {
      porMes.set(r.mes, (porMes.get(r.mes) ?? 0) + r.arrecadado);
    }
    const serie = [...porMes.values()].filter((v) => v > 0);
    // Precisa de série mínima para que média/desvio façam sentido.
    if (serie.length < 4) continue;

    const m = media(serie);
    const dp = desvioPadrao(serie, m);
    if (m <= 0 || dp <= 0) continue;
    const limiar = m - 2 * dp;
    if (limiar <= 0) continue;

    const mesesBaixos = [...porMes.entries()]
      .filter(([, v]) => v > 0 && v < limiar)
      .sort((a, b) => a[1] - b[1]);
    if (mesesBaixos.length === 0) continue;

    const rotulo = g.descricao || conta;
    const valorFaltante = soma(mesesBaixos.map(([, v]) => Math.max(0, m - v)));

    out.push({
      detectorId: 'RC-01',
      detectorNome: 'Queda atípica de arrecadação de tributo',
      categoria: CATEGORIA,
      titulo: `Arrecadação mensal atípica — ${rotulo}`,
      descricao:
        `${mesesBaixos.length} mês(es) com arrecadação abaixo de ` +
        `${formatBRL(limiar)} (média mensal ${formatBRL(m)}).`,
      sujeitoTipo: 'orgao',
      sujeitoId: `receita:${conta}`,
      sujeitoRotulo: rotulo,
      classificacao: mesesBaixos.length >= 3 ? 'suspeita' : 'atencao',
      scores: {
        confiabilidade: 62,
        probabilidadeIrregularidade: Math.min(58, 32 + mesesBaixos.length * 8),
      },
      fundamentoLegal: ['LC 101/2000 (LRF), art. 11'],
      evidencias: [
        { resumo: `Média mensal de arrecadação: ${formatBRL(m)}` },
        ...mesesBaixos.slice(0, 6).map(([mes, v]) => ({
          resumo: `Mês ${String(mes).padStart(2, '0')}: arrecadado ${formatBRL(v)}`,
          valor: v,
        })),
      ],
      explicacao:
        'A arrecadação desta rubrica tributária ficou, em um ou mais meses, ' +
        'muito abaixo da própria média do exercício (mais de 2 desvios). ' +
        'A LRF (art. 11) exige a efetiva arrecadação dos tributos de ' +
        'competência do município. A queda pode ter causa legítima — ' +
        'sazonalidade, calendário de lançamento ou parcelamento — e deve ser ' +
        'verificada antes de qualquer conclusão.',
      valorEnvolvido: valorFaltante,
    });
  }

  return out;
}

// ── RC-02 — Receita prevista sem realização ──────────────────────────────────

/**
 * RC-02: rubrica de receita com previsão (LOA) relevante e arrecadação
 * praticamente nula no exercício. Indício de previsão orçamentária
 * superestimada ou de receita não lançada. Limiar mínimo evita ruído de
 * rubricas residuais.
 */
const LIMIAR_PREVISTO = 50_000;
/** Realização considerada "praticamente nula": até 1% do previsto. */
const PISO_REALIZACAO = 0.01;

export function detectarReceitaSemRealizacao(
  receitas: ReceitaNorm[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];
  const grupos = agruparPorConta(receitas);

  for (const [conta, g] of grupos) {
    const previsto = soma(g.itens.map((r) => r.previsto));
    const arrecadado = soma(g.itens.map((r) => r.arrecadado));
    if (previsto < LIMIAR_PREVISTO) continue;
    if (arrecadado > previsto * PISO_REALIZACAO) continue;

    const rotulo = g.descricao || conta;
    const percentual = previsto > 0 ? (arrecadado / previsto) * 100 : 0;

    out.push({
      detectorId: 'RC-02',
      detectorNome: 'Receita prevista sem realização',
      categoria: CATEGORIA,
      titulo: `Rubrica orçada sem arrecadação — ${rotulo}`,
      descricao:
        `Previsão de ${formatBRL(previsto)} na LOA com arrecadação de ` +
        `apenas ${formatBRL(arrecadado)} (${percentual.toFixed(1)}% do previsto).`,
      sujeitoTipo: 'orgao',
      sujeitoId: `receita:${conta}`,
      sujeitoRotulo: rotulo,
      classificacao: 'atencao',
      scores: { confiabilidade: 70, probabilidadeIrregularidade: 44 },
      fundamentoLegal: [
        'Lei 4.320/1964',
        'LC 101/2000 (LRF), art. 12',
      ],
      evidencias: [
        { resumo: `Previsão (LOA): ${formatBRL(previsto)}`, valor: previsto },
        { resumo: `Arrecadado no exercício: ${formatBRL(arrecadado)}`, valor: arrecadado },
      ],
      explicacao:
        'Esta rubrica foi orçada na LOA mas não registra arrecadação ' +
        'correspondente no exercício. A LRF (art. 12) veda a previsão de ' +
        'receitas superior à efetivamente provável. O indício pode refletir ' +
        'previsão superestimada, receita ainda não lançada no portal ou ' +
        'rubrica desativada — convém verificar a fonte do desvio.',
      valorEnvolvido: previsto - arrecadado,
    });
  }

  return out;
}

// ── RC-05 — Receita de transferência abaixo do esperado ──────────────────────

/**
 * RC-05: receita de transferência (FPM, cota-parte de ICMS, FUNDEB, convênios)
 * realizada muito abaixo do previsto. Considera apenas rubricas com previsão
 * relevante e realização abaixo de 60% do previsto. Como transferências
 * dependem de fatores macroeconômicos, é classificado como "atenção".
 */
/** Abaixo deste fração do previsto, a transferência é sinalizada. */
const PISO_TRANSFERENCIA = 0.6;

export function detectarTransferenciaBaixa(
  receitas: ReceitaNorm[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];
  const grupos = agruparPorConta(
    receitas.filter((r) => r.familia === 'transferencia'),
  );

  for (const [conta, g] of grupos) {
    const previsto = soma(g.itens.map((r) => r.previsto));
    const arrecadado = soma(g.itens.map((r) => r.arrecadado));
    if (previsto < LIMIAR_PREVISTO) continue;
    const razao = previsto > 0 ? arrecadado / previsto : 1;
    // Já coberto por RC-02 quando a realização é ~nula.
    if (razao <= PISO_REALIZACAO || razao >= PISO_TRANSFERENCIA) continue;

    const rotulo = g.descricao || conta;
    const percentual = razao * 100;
    const defasagem = previsto - arrecadado;

    out.push({
      detectorId: 'RC-05',
      detectorNome: 'Receita de transferência abaixo do esperado',
      categoria: CATEGORIA,
      titulo: `Transferência abaixo do previsto — ${rotulo}`,
      descricao:
        `Realizado ${formatBRL(arrecadado)} de ${formatBRL(previsto)} ` +
        `previstos (${percentual.toFixed(0)}% do previsto).`,
      sujeitoTipo: 'orgao',
      sujeitoId: `receita:${conta}`,
      sujeitoRotulo: rotulo,
      classificacao: razao < 0.4 ? 'suspeita' : 'atencao',
      scores: {
        confiabilidade: 64,
        probabilidadeIrregularidade: Math.min(54, 30 + Math.round((1 - razao) * 40)),
      },
      fundamentoLegal: ['Lei 4.320/1964'],
      evidencias: [
        { resumo: `Previsão (LOA): ${formatBRL(previsto)}`, valor: previsto },
        { resumo: `Transferência realizada: ${formatBRL(arrecadado)}`, valor: arrecadado },
        { resumo: `Defasagem: ${formatBRL(defasagem)}`, valor: defasagem },
      ],
      explicacao:
        'Uma receita de transferência (FPM, cota-parte de ICMS, FUNDEB ou ' +
        'convênio) foi realizada bem abaixo do previsto na LOA. Transferências ' +
        'constitucionais dependem de fatores macroeconômicos e da arrecadação ' +
        'de outros entes, de modo que a defasagem pode ter causa externa. ' +
        'Recomenda-se verificar se houve frustração de receita reconhecida ou ' +
        'previsão inicial superestimada.',
      valorEnvolvido: defasagem,
    });
  }

  return out;
}

/** Runner — roda todos os detectores da RECEITA e ordena por valor. */
export function analisarReceita(receitas: ReceitaNorm[]): AlertaDetectado[] {
  const detectores = [
    detectarQuedaArrecadacao,
    detectarReceitaSemRealizacao,
    detectarTransferenciaBaixa,
  ];
  const alertas: AlertaDetectado[] = [];
  for (const det of detectores) {
    try {
      alertas.push(...det(receitas));
    } catch {
      // Detector isolado — falha individual não interrompe a análise.
    }
  }
  return alertas.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
}
