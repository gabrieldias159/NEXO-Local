/**
 * Detector MF-10 — Restos a pagar antigos sem baixa.
 *
 * Restos a pagar são despesas empenhadas e não pagas, carregadas ao exercício
 * seguinte. Não são irregularidade em si, mas RAP de exercícios antigos (mais
 * de 2 anos) que seguem sem baixa nem pagamento são possível indício a apurar
 * — pode haver despesa não executada inscrita ou falta de cancelamento.
 *
 * NOTA DE NUMERAÇÃO: este arquivo emitia antes `OR-06`, mas esse ID do
 * catálogo é "Suplementações repetidas na mesma dotação" — já implementado em
 * `diversos-cat.ts`. A regra real deste detector ("RAP de exercícios
 * anteriores parados sem baixa") corresponde ao catálogo `MF-10` (RAP com
 * inscrição > 2 anos sem baixa/pagamento). A verificação de cobertura de
 * caixa (MF-09) depende da disponibilidade financeira por fonte e roda na
 * rota dedicada de metas fiscais — fora deste detector.
 */
import { formatBRL } from '../normalizar';
import { ehEntidadePublica } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

const LIMIAR = 50_000;
/** Catálogo MF-10: RAP com inscrição há mais de 2 anos. */
const ANOS_ANTIGO = 2;

export const detectorRestosAPagar: Detector = {
  id: 'MF-10',
  nome: 'Restos a pagar antigos sem baixa',
  categoria: 'Metas fiscais e LRF',

  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const porFornecedor = new Map<
      string,
      { soma: number; n: number; nome: string; anoMaisAntigo: number }
    >();

    for (const r of ctx.restosAPagar) {
      if (!r.cpfCnpj || r.valor <= 0) continue;
      // P0: ente público nunca é "fornecedor" (repasse/RAP intra-governo).
      if (ehEntidadePublica(r.cpfCnpj, r.fornecedorNome)) continue;
      // Só RAP de exercícios antigos: inscrição há mais de 2 anos (MF-10).
      if (!r.exercicio || ctx.exercicio - r.exercicio <= ANOS_ANTIGO) continue;
      const cur =
        porFornecedor.get(r.cpfCnpj) ??
        { soma: 0, n: 0, nome: r.fornecedorNome, anoMaisAntigo: r.exercicio };
      cur.soma += r.valor;
      cur.n += 1;
      if (!cur.nome && r.fornecedorNome) cur.nome = r.fornecedorNome;
      if (r.exercicio < cur.anoMaisAntigo) cur.anoMaisAntigo = r.exercicio;
      porFornecedor.set(r.cpfCnpj, cur);
    }

    for (const [cnpj, d] of porFornecedor) {
      if (d.soma < LIMIAR) continue;
      const nome = d.nome || cnpj;
      const anos = ctx.exercicio - d.anoMaisAntigo;
      out.push({
        detectorId: 'MF-10',
        detectorNome: 'Restos a pagar antigos sem baixa',
        categoria: 'Metas fiscais e LRF',
        titulo: `Restos a pagar antigos sem baixa — ${nome}`,
        descricao:
          `${formatBRL(d.soma)} em restos a pagar inscritos há mais de ${ANOS_ANTIGO} ` +
          `anos (o mais antigo de ${d.anoMaisAntigo}, ${anos} anos) ainda sem baixa ` +
          `nem pagamento (${d.n} registro(s)). Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao: d.soma > 200_000 ? 'atencao' : 'informativo',
        scores: { confiabilidade: 64, probabilidadeIrregularidade: 36 },
        fundamentoLegal: ['LC 101/2000, art. 42', 'Lei 4.320/1964, art. 36'],
        evidencias: [
          {
            resumo: `Restos a pagar antigos: ${formatBRL(d.soma)} (mais antigo: ${d.anoMaisAntigo})`,
            valor: d.soma,
          },
        ],
        explicacao:
          'Restos a pagar de exercícios antigos que seguem sem baixa nem ' +
          'pagamento são possível indício a apurar — convém verificar se a ' +
          'despesa foi efetivamente executada, se há cobertura de caixa para a ' +
          'inscrição (art. 42 da LRF) ou se o resto deveria ter sido cancelado. ' +
          'Pode também ser pendência legítima em discussão judicial ou ' +
          'administrativa, o que deve ser confirmado.',
        valorEnvolvido: d.soma,
      });
    }

    return out;
  },
};
