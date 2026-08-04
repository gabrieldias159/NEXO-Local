/**
 * Detector FR-06 — Fornecedor operando com múltiplos CNPJs (mesma raiz).
 *
 * Agrupa empenhos pela raiz do CNPJ (8 primeiros dígitos). Quando um mesmo
 * grupo econômico recebe empenhos por 2+ estabelecimentos (filiais), o valor
 * real contratado fica fragmentado e some das análises por CNPJ isolado —
 * caso clássico do HU (3 filiais, ~R$ 6,8M somados).
 *
 * É a resolução de entidades em ação — ver docs/nexo/03-insights-e-correlacoes.md.
 */
import { formatBRL, type EmpenhoNorm } from '../normalizar';
import { ehEntidadePublica } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

export const detectorGrupoCnpj: Detector = {
  id: 'FR-06',
  nome: 'Múltiplos CNPJs da mesma raiz',
  categoria: 'Fornecedores',

  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const porRaiz = new Map<
      string,
      { ests: Set<string>; total: number; n: number; nome: string }
    >();

    for (const e of ctx.empenhos) {
      if (e.cpfCnpj.length !== 14 || e.valorEmpenhado <= 0) continue;
      if (ehEntidadePublica(e.cpfCnpj, e.fornecedorNome)) continue;
      const raiz = e.cpfCnpj.slice(0, 8);
      const cur =
        porRaiz.get(raiz) ?? { ests: new Set<string>(), total: 0, n: 0, nome: e.fornecedorNome };
      cur.ests.add(e.cpfCnpj);
      cur.total += e.valorEmpenhado;
      cur.n += 1;
      if (!cur.nome && e.fornecedorNome) cur.nome = e.fornecedorNome;
      porRaiz.set(raiz, cur);
    }

    for (const [raiz, d] of porRaiz) {
      if (d.ests.size < 2) continue;
      const nome = d.nome || `Grupo ${raiz}`;
      out.push({
        detectorId: 'FR-06',
        detectorNome: 'Múltiplos CNPJs da mesma raiz',
        categoria: 'Fornecedores',
        titulo: `Grupo econômico com ${d.ests.size} CNPJs — ${nome}`,
        descricao:
          `${d.ests.size} estabelecimentos da mesma raiz de CNPJ (${raiz}) ` +
          `receberam empenhos somando ${formatBRL(d.total)}.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: raiz,
        sujeitoRotulo: nome,
        classificacao: d.ests.size >= 3 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 76,
          probabilidadeIrregularidade: Math.min(72, 40 + d.ests.size * 8),
        },
        fundamentoLegal: ['Lei 14.133/2021, art. 75'],
        evidencias: [...d.ests].slice(0, 8).map((c) => ({ resumo: `CNPJ ${c}` })),
        explicacao:
          `O valor contratado distribui-se por ${d.ests.size} CNPJs do mesmo grupo ` +
          `econômico (mesma raiz). Verificar se a soma das contratações por filial ` +
          `não configura fracionamento e se a modalidade licitatória considerou o ` +
          `grupo como um todo.`,
        valorEnvolvido: d.total,
      });
    }

    return out;
  },
};
