/**
 * Detectores de Execução Orçamentária sobre o módulo DespesaAgrupada
 * (que carrega o tipo de empenho: Empenho / Reforço / Anulação).
 *
 *  OR-07 — Anulações recorrentes de empenho (anulações recorrentes ao fornecedor).
 *  OR-08 — Empenhos concentrados no fim do exercício.
 *  OR-09 — Reforço de empenho atípico.
 */
import { formatBRL, type DespesaNorm } from '../normalizar';
import { ehEntidadePublica } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

export const detectorEmpenhoAnulado: Detector = {
  id: 'OR-07',
  nome: 'Anulações recorrentes de empenho',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of ctx.despesas) {
      if (!d.cpfCnpj || !/ANUL/i.test(d.tipoEmpenho)) continue;
      // P0: ente público nunca é "fornecedor" (anulação intra-governamental).
      if (ehEntidadePublica(d.cpfCnpj, d.fornecedorNome)) continue;
      const arr = porCnpj.get(d.cpfCnpj) ?? [];
      arr.push(d);
      porCnpj.set(d.cpfCnpj, arr);
    }
    for (const lista of porCnpj.values()) {
      if (lista.length < 2) continue;
      const soma = lista.reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || lista[0].cpfCnpj;
      out.push({
        detectorId: 'OR-07',
        detectorNome: 'Anulações recorrentes de empenho',
        categoria: 'Execução orçamentária',
        titulo: `Anulações de empenho recorrentes — ${nome}`,
        descricao:
          `${lista.length} anulações de empenho envolvendo o mesmo fornecedor ` +
          `(${formatBRL(soma)}). Anular e reemitir empenhos pode mascarar datas e valores.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj,
        sujeitoRotulo: nome,
        classificacao: lista.length >= 4 ? 'suspeita' : 'atencao',
        scores: { confiabilidade: 70, probabilidadeIrregularidade: Math.min(74, 40 + lista.length * 6) },
        fundamentoLegal: ['Lei 4.320/1964 art. 60; LRF art. 42'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Anulação ${d.numeroEmpenho || d.id} — ${formatBRL(Math.abs(d.valorEmpenhado))}`,
          valor: Math.abs(d.valorEmpenhado),
          data: d.data,
        })),
        explicacao:
          'Anulações de empenho seguidas de reemissão ao mesmo fornecedor merecem ' +
          'verificação — o padrão pode ser correção legítima ou ajuste de datas/valores ' +
          'para acomodar a despesa.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

export const detectorEmpenhosFimExercicio: Detector = {
  id: 'OR-08',
  nome: 'Empenhos concentrados no fim do exercício',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    const positivos = ctx.despesas.filter(
      (d) => d.valorEmpenhado > 0 && !/ANUL/i.test(d.tipoEmpenho) && d.data,
    );
    if (positivos.length < 50) return [];
    const total = positivos.reduce((s, d) => s + d.valorEmpenhado, 0);
    if (total <= 0) return [];
    const dezembro = positivos.filter((d) => d.data!.slice(5, 7) === '12');
    const somaDez = dezembro.reduce((s, d) => s + d.valorEmpenhado, 0);
    const pct = (somaDez / total) * 100;
    if (pct < 30) return [];
    return [
      {
        detectorId: 'OR-08',
        detectorNome: 'Empenhos concentrados no fim do exercício',
        categoria: 'Execução orçamentária',
        titulo: `${pct.toFixed(0)}% dos empenhos concentrados em dezembro`,
        descricao:
          `${dezembro.length} empenhos em dezembro somando ${formatBRL(somaDez)} — ` +
          `${pct.toFixed(1)}% do valor empenhado do exercício.`,
        sujeitoTipo: 'orgao',
        sujeitoId: 'execucao-fim-exercicio',
        sujeitoRotulo: 'Execução de fim de exercício',
        classificacao: pct >= 45 ? 'suspeita' : 'atencao',
        scores: { confiabilidade: 74, probabilidadeIrregularidade: Math.min(72, Math.round(20 + pct)) },
        fundamentoLegal: ['Lei 4.320/1964 art. 63; LRF art. 42'],
        evidencias: [{ resumo: `${dezembro.length} empenhos em dezembro · ${formatBRL(somaDez)}` }],
        explicacao:
          'Concentração de empenhos no fim do exercício pode indicar falha de ' +
          'planejamento ou corrida para consumir a dotação — e tende a gerar restos ' +
          'a pagar. Requer verificar o cronograma de execução.',
        valorEnvolvido: somaDez,
      },
    ];
  },
};

export const detectorReforcoAtipico: Detector = {
  id: 'OR-09',
  nome: 'Reforço de empenho atípico',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const porEmpenho = new Map<string, DespesaNorm[]>();
    for (const d of ctx.despesas) {
      if (!d.numeroEmpenho || !/REFOR/i.test(d.tipoEmpenho)) continue;
      const arr = porEmpenho.get(d.numeroEmpenho) ?? [];
      arr.push(d);
      porEmpenho.set(d.numeroEmpenho, arr);
    }
    for (const [numero, lista] of porEmpenho) {
      if (lista.length < 3) continue;
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || '';
      out.push({
        detectorId: 'OR-09',
        detectorNome: 'Reforço de empenho atípico',
        categoria: 'Execução orçamentária',
        titulo: `Empenho ${numero} reforçado ${lista.length} vezes`,
        descricao:
          `O empenho ${numero}${nome ? ` (${nome})` : ''} recebeu ${lista.length} ` +
          `reforços, somando ${formatBRL(soma)} de acréscimo.`,
        sujeitoTipo: 'empenho',
        sujeitoId: numero,
        sujeitoRotulo: `Empenho ${numero}`,
        classificacao: lista.length >= 5 ? 'suspeita' : 'atencao',
        scores: { confiabilidade: 70, probabilidadeIrregularidade: Math.min(70, 38 + lista.length * 6) },
        fundamentoLegal: ['Lei 4.320/1964 art. 60'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Reforço — ${formatBRL(d.valorEmpenhado)}`,
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'Reforços sucessivos no mesmo empenho podem indicar subdimensionamento ' +
          'inicial da despesa ou ajuste para evitar nova contratação — requer ' +
          'verificar a estimativa original.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};
