/**
 * Detector AN-04 — Valores próximos do teto de dispensa de licitação.
 *
 * Sinaliza empenhos cujo valor fica logo ABAIXO de um limite legal de dispensa
 * (art. 75, I/II da Lei 14.133/2021). Concentração de valores "colados" no teto
 * é indício clássico de fracionamento/direcionamento A APURAR — a despesa pode
 * ter sido fatiada para caber na dispensa e evitar a licitação. Nunca acusação:
 * pode refletir contratações legítimas próximas do limite.
 *
 * Fonte ÚNICA dos limites: src/lib/nexo/limites.ts (getLimiteDispensa) — nunca
 * uma constante digitada à mão (anti-padrão que gera falso pos/neg sistemático).
 *
 * Degrada honestamente: sem ctx.empenhos → retorna [].
 */
import { formatBRL, type EmpenhoNorm } from '../normalizar';
import { ehEntidadePublica, cnpjValido } from '../entidades';
import { getLimiteDispensa } from '../limites';
import type { AlertaDetectado, Classificacao, Detector } from './tipos';

/**
 * Faixa de proximidade ao teto: entre (1 - PROXIMIDADE)·teto e teto.
 * 0.10 = valores dentro dos 10% finais logo abaixo do limite de dispensa.
 */
const PROXIMIDADE = 0.1;
/** Piso de relevância — abaixo disso o "colado no teto" é irrelevante. */
const VALOR_MINIMO = 5_000;

export const detectorValorProximoTetoDispensa: Detector = {
  id: 'AN-04',
  nome: 'Valor próximo do teto de dispensa',
  categoria: 'Anomalia estatística',

  detectar(ctx): AlertaDetectado[] {
    if (!Array.isArray(ctx.empenhos) || ctx.empenhos.length === 0) return [];

    const limite = getLimiteDispensa(ctx.exercicio);
    // Os dois tetos legais (compras/serviços e obras/engenharia). O contexto não
    // diferencia a natureza do empenho, então aferimos contra AMBOS — basta um.
    const tetos: ReadonlyArray<{ valor: number; rotulo: string; inciso: string }> = [
      { valor: limite.comprasServicos, rotulo: 'compras e serviços', inciso: 'art. 75, II' },
      { valor: limite.obrasEngenharia, rotulo: 'obras e engenharia', inciso: 'art. 75, I' },
    ];

    // Agrupa por fornecedor os empenhos colados em algum teto.
    const porFornecedor = new Map<
      string,
      { empenhos: { e: EmpenhoNorm; teto: (typeof tetos)[number] }[]; nome: string }
    >();

    for (const e of ctx.empenhos) {
      const valor = e.valorEmpenhado;
      if (valor < VALOR_MINIMO) continue;
      if (ehEntidadePublica(e.cpfCnpj, e.fornecedorNome)) continue;
      // Só CNPJ válido — "colado no teto de dispensa" é sobre COMPRA de pessoa
      // jurídica; CPF de servidor/folha (subsídio, diária) não fraciona dispensa.
      if (!cnpjValido(e.cpfCnpj)) continue;

      // Acha o teto cujo intervalo [ (1-p)·teto , teto ] contém o valor.
      const teto = tetos.find(
        (t) => valor <= t.valor && valor >= t.valor * (1 - PROXIMIDADE),
      );
      if (!teto) continue;

      const chave = e.cpfCnpj || 'sem-cnpj';
      const cur = porFornecedor.get(chave) ?? { empenhos: [], nome: e.fornecedorNome };
      cur.empenhos.push({ e, teto });
      if (!cur.nome && e.fornecedorNome) cur.nome = e.fornecedorNome;
      porFornecedor.set(chave, cur);
    }

    const out: AlertaDetectado[] = [];
    for (const [cnpj, dados] of porFornecedor) {
      const lista = dados.empenhos;
      if (lista.length === 0) continue;
      const soma = lista.reduce((s, x) => s + x.e.valorEmpenhado, 0);
      const nome = dados.nome || cnpj;

      // Mais de um empenho colado no teto agrava (padrão de fracionamento).
      const classificacao: Classificacao = lista.length >= 2 ? 'suspeita' : 'atencao';

      out.push({
        detectorId: 'AN-04',
        detectorNome: 'Valor próximo do teto de dispensa',
        categoria: 'Anomalia estatística',
        titulo: `Empenho(s) logo abaixo do teto de dispensa — ${nome}`,
        descricao:
          `${lista.length} empenho(s) (${formatBRL(soma)}) com valor nos ${Math.round(
            PROXIMIDADE * 100,
          )}% finais abaixo do limite legal de dispensa do exercício ${ctx.exercicio}` +
          (limite.exato ? '' : ' (limite estimado — exercício fora da tabela oficial)') +
          `. Possível indício de fracionamento/direcionamento a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao,
        scores: {
          confiabilidade: limite.exato ? (ctx.amostra ? 58 : 72) : 50,
          probabilidadeIrregularidade: Math.min(76, 42 + lista.length * 6),
        },
        fundamentoLegal: [
          `Lei 14.133/2021, art. 75, I e II (${limite.decreto})`,
        ],
        evidencias: lista.slice(0, 8).map(({ e, teto }) => ({
          resumo:
            `Empenho ${e.numeroEmpenho || e.id} — ${formatBRL(e.valorEmpenhado)} ` +
            `(${((e.valorEmpenhado / teto.valor) * 100).toFixed(1)}% do teto de ${teto.rotulo}, ` +
            `${formatBRL(teto.valor)})`,
          valor: e.valorEmpenhado,
          data: e.data,
        })),
        explicacao:
          'Valores que ficam sistematicamente logo abaixo do teto de dispensa ' +
          '(Lei 14.133/2021 art. 75) são possível indício de fracionamento — fatiar ' +
          'uma despesa maior em várias dispensas para evitar a licitação — ou de ' +
          'direcionamento, A APURAR. Não é, por si, irregularidade: pode haver ' +
          'contratações legítimas próximas do limite. Verificar se há objeto único ' +
          'fracionado e se a soma no exercício exigiria modalidade licitatória.',
        valorEnvolvido: soma,
      });
    }

    return out;
  },
};
