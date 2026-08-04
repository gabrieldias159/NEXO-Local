/**
 * Detector FN-01 — Concentração de fornecedor.
 *
 * Sinaliza fornecedores que concentram uma fatia desproporcional do valor
 * empenhado. Concentração elevada não é, por si, irregularidade — pode
 * refletir um contrato grande e legítimo (ex.: energia elétrica) — mas merece
 * verificação de competitividade e modalidade.
 */
import { formatBRL, type EmpenhoNorm } from '../normalizar';
import { ehEntidadePublica } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

const LIMIAR_PERCENTUAL = 20;

export const detectorConcentracao: Detector = {
  id: 'FN-01',
  nome: 'Concentração de fornecedor',
  categoria: 'Fornecedores',

  detectar(ctx) {
    if (ctx.totalEmpenhado <= 0) return [];
    const out: AlertaDetectado[] = [];

    const porFornecedor = new Map<string, { total: number; n: number; nome: string }>();
    for (const e of ctx.empenhos) {
      if (!e.cpfCnpj || e.valorEmpenhado <= 0) continue;
      // Exclui a própria Prefeitura / órgãos públicos da lista de fornecedores.
      if (ehEntidadePublica(e.cpfCnpj, e.fornecedorNome)) continue;
      const cur = porFornecedor.get(e.cpfCnpj) ?? { total: 0, n: 0, nome: e.fornecedorNome };
      cur.total += e.valorEmpenhado;
      cur.n += 1;
      if (!cur.nome && e.fornecedorNome) cur.nome = e.fornecedorNome;
      porFornecedor.set(e.cpfCnpj, cur);
    }

    for (const [cnpj, dados] of porFornecedor) {
      const pct = (dados.total / ctx.totalEmpenhado) * 100;
      if (pct < LIMIAR_PERCENTUAL) continue;

      const nome = dados.nome || cnpj;
      const classificacao = pct >= 40 ? 'suspeita' : 'atencao';

      out.push({
        detectorId: 'FN-01',
        detectorNome: 'Concentração de fornecedor',
        categoria: 'Fornecedores',
        titulo: `Concentração de empenhos — ${nome}`,
        descricao:
          `Fornecedor concentra ${pct.toFixed(1)}% do valor empenhado analisado ` +
          `(${formatBRL(dados.total)} em ${dados.n} empenhos)` +
          (ctx.amostra ? ' — percentual sobre a amostra coletada.' : '.'),
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao,
        scores: {
          confiabilidade: ctx.amostra ? 60 : 80,
          probabilidadeIrregularidade: Math.min(75, Math.round(30 + pct)),
        },
        fundamentoLegal: ['Lei 14.133/2021, art. 5º (competitividade)'],
        evidencias: [
          {
            resumo: `${dados.n} empenhos · total ${formatBRL(dados.total)}`,
            valor: dados.total,
          },
        ],
        explicacao:
          `Este fornecedor responde por ${pct.toFixed(1)}% do valor empenhado ` +
          `${ctx.amostra ? 'na amostra analisada' : 'no exercício'}. Concentração não é ` +
          `irregularidade em si — verificar se há competitividade real nas contratações ` +
          `e se a modalidade licitatória é adequada ao volume.`,
        valorEnvolvido: dados.total,
      });
    }

    return out;
  },
};
