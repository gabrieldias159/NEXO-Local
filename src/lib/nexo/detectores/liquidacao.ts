/**
 * Detector de execução orçamentária ligado à liquidação.
 *
 * A liquidação (Lei 4.320/1964, art. 63) é a etapa que comprova a entrega ou
 * execução da despesa — deve ocorrer entre o empenho e o pagamento.
 *
 *  OR-03 — Empenho sem liquidação prolongada.
 *
 * NOTA DE NUMERAÇÃO: este arquivo emitia antes `OR-01`/`OR-02`, mas esses IDs
 * do catálogo são "Pagamento sem empenho prévio" e "Liquidação sem empenho" —
 * ambos já implementados corretamente em `orcamento-extra.ts`. A regra real
 * deste detector ("empenho aberto há muito tempo sem liquidar") é o catálogo
 * `OR-03`. O antigo `detectorPagamentoSemLiquidacao` (que emitia `OR-02`) foi
 * removido: não correspondia a nenhum ID do catálogo e colidia com o `OR-02`
 * canônico de `orcamento-extra.ts`.
 */
import { formatBRL, type EmpenhoNorm } from '../normalizar';
import { ehEntidadePublica } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

const MIN_DIAS_SEM_LIQUIDACAO = 90;
const VALOR_RELEVANTE = 10_000;

function diasDesde(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return 0;
  return (Date.now() - d.getTime()) / 86_400_000;
}

export const detectorEmpenhoSemLiquidacao: Detector = {
  id: 'OR-03',
  nome: 'Empenho sem liquidação prolongada',
  categoria: 'Execução orçamentária',

  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const porFornecedor = new Map<string, EmpenhoNorm[]>();

    for (const e of ctx.empenhos) {
      if (!e.cpfCnpj || !e.data || e.temLiquidacao) continue;
      // P0: ente público (Prefeitura/IPREMM/Câmara/fundos) nunca é
      // "fornecedor" — repasse intra-governamental não vira alerta.
      if (ehEntidadePublica(e.cpfCnpj, e.fornecedorNome)) continue;
      if (e.valorEmpenhado < VALOR_RELEVANTE) continue;
      if (diasDesde(e.data) < MIN_DIAS_SEM_LIQUIDACAO) continue;
      const arr = porFornecedor.get(e.cpfCnpj) ?? [];
      arr.push(e);
      porFornecedor.set(e.cpfCnpj, arr);
    }

    for (const [cnpj, lista] of porFornecedor) {
      const soma = lista.reduce((s, e) => s + e.valorEmpenhado, 0);
      const nome = lista.find((e) => e.fornecedorNome)?.fornecedorNome || cnpj;
      out.push({
        detectorId: 'OR-03',
        detectorNome: 'Empenho sem liquidação prolongada',
        categoria: 'Execução orçamentária',
        titulo: `Empenhos sem liquidação há mais de ${MIN_DIAS_SEM_LIQUIDACAO} dias — ${nome}`,
        descricao:
          `${lista.length} empenho(s) somando ${formatBRL(soma)} sem registro de ` +
          `liquidação após ${MIN_DIAS_SEM_LIQUIDACAO} dias. Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao: soma > 200_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 70,
          probabilidadeIrregularidade: Math.min(78, 40 + lista.length * 5),
        },
        fundamentoLegal: ['Lei 4.320/1964, arts. 58–63'],
        evidencias: lista.slice(0, 8).map((e) => ({
          resumo: `Empenho ${e.numeroEmpenho || e.id} — ${formatBRL(e.valorEmpenhado)}`,
          valor: e.valorEmpenhado,
          data: e.data,
        })),
        explicacao:
          'A liquidação comprova a entrega ou execução antes do pagamento. ' +
          'Empenhos abertos há muito tempo sem liquidação são possível indício a ' +
          'apurar — convém verificar o andamento da despesa e se o objeto foi ' +
          'efetivamente entregue. Pode também ser lacuna de dados do portal.',
        valorEnvolvido: soma,
      });
    }

    return out;
  },
};
