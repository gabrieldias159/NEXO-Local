import { formatBRL } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

function ehPrecatorio(elemento: string): boolean {
  const e = elemento.replace(/[^\d]/g, '');
  if (!e) return false;
  if (e.endsWith('92') || e.endsWith('194')) return true;
  return /339092|449092|339194/i.test(e);
}

const PALAVRAS_PRECATORIO = /precat[óo]rio|requisi[çc][ãa]o.*pequeno|rpv|d[ée]bito.*judicial/i;

export const detectorPrecatorios: Detector = {
  id: 'OR-12',
  nome: 'Precatórios e RPV',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    let totalPrecatorio = 0;
    let qtdPrecatorio = 0;

    for (const d of ctx.despesas) {
      if (d.valorEmpenhado <= 0) continue;
      if (!ehPrecatorio(d.elemento) && !(d.objeto && PALAVRAS_PRECATORIO.test(d.objeto))) continue;
      totalPrecatorio += Math.abs(d.valorEmpenhado);
      qtdPrecatorio++;
    }

    if (qtdPrecatorio === 0 || totalPrecatorio < 10_000) return [];

    const pctEmpenho = ctx.totalEmpenhado > 0 ? (totalPrecatorio / ctx.totalEmpenhado) * 100 : 0;
    const classificacao = pctEmpenho > 5 ? 'suspeita' : pctEmpenho > 2 ? 'atencao' : 'informativo';

    out.push({
      detectorId: 'OR-12',
      detectorNome: 'Precatórios e RPV',
      categoria: 'Execução orçamentária',
      titulo: `Precatórios: ${formatBRL(totalPrecatorio)} (${pctEmpenho.toFixed(1)}% do empenhado)`,
      descricao:
        `${qtdPrecatorio} despesa(s) classificada(s) como precatório/RPV no ` +
        `exercício, somando ${formatBRL(totalPrecatorio)} — ` +
        `${pctEmpenho.toFixed(1)}% do total empenhado (${formatBRL(ctx.totalEmpenhado)}). ` +
        'Possível indício de estoque elevado de passivos judiciais a apurar.',
      sujeitoTipo: 'orgao',
      sujeitoId: `precatorios-${ctx.exercicio}`,
      sujeitoRotulo: `Precatórios ${ctx.exercicio}`,
      classificacao,
      scores: {
        confiabilidade: 68,
        probabilidadeIrregularidade: Math.min(80, 35 + Math.round(pctEmpenho * 8)),
      },
      fundamentoLegal: [
        'Constituição Federal art. 100 (precatórios)',
        'Emenda Constitucional 114/2021 (regime de pagamento)',
      ],
      evidencias: [
        { resumo: `Total de precatórios: ${formatBRL(totalPrecatorio)}`, valor: totalPrecatorio },
        { resumo: `Percentual do total empenhado: ${pctEmpenho.toFixed(1)}%` },
        { resumo: `Quantidade de operações: ${qtdPrecatorio}`, valor: qtdPrecatorio },
      ],
      explicacao:
        'Precatórios são dívidas judiciais do município. O volume elevado ' +
        'de despesas classificadas como precatório/RPV em relação ao total ' +
        'empenhado pode indicar estoque alto de passivos judiciais, ' +
        'comprometendo o orçamento. A apuração requer verificar a relação ' +
        'com o regime de pagamento do art. 100 CF e EC 114/2021. ' +
        'ATENÇÃO: a classificação baseia-se no código de elemento ' +
        '(sufixo 92/194) — a confirmação exige a lista oficial de precatórios.',
      valorEnvolvido: totalPrecatorio,
    });

    return out;
  },
};
