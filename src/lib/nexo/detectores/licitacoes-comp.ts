/**
 * Detectores computáveis de Licitações e Compras (área LC do catálogo).
 *
 *  LC-07 — Inexigibilidade frágil (inexigibilidade relevante).
 *  LC-18 — Modalidade incompatível com o valor.
 *  LC-24 — Empenho sem itens detalháveis.
 *
 * LC-22 (Vencedor recém-aberto) foi removido deste arquivo: havia uma
 * implementação idêntica (também `[]` por falta da data de abertura do CNPJ)
 * em `licitacoes-cat.ts`, que é o bloco sistemático LC-08..LC-25. Mantém-se a
 * de `licitacoes-cat.ts` para não ter dois detectores com o mesmo `LC-22`.
 *
 * Trabalham sobre `DespesaAgrupada` (objeto, modalidade, valor) e `empenhos`.
 * Linguagem: indício a apurar — nunca acusação.
 */
import { getLimiteDispensa } from '../limites';
import { formatBRL, type DespesaNorm } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

const RE_INEXIGIBILIDADE = /inexig/i;
const RE_DISPENSA = /dispens/i;
const RE_CONVITE = /convite/i;

/** Limiar de relevância para inexigibilidade (catálogo LC-07: > R$ 50k). */
const LIMIAR_INEXIGIBILIDADE = 50_000;
/** Limiar de relevância para empenho sem itens (catálogo LC-24: > R$ 100k). */
const LIMIAR_SEM_ITENS = 100_000;

// ── LC-07 — Inexigibilidade frágil ───────────────────────────────────────────
/**
 * Lei 14.133/2021 art. 74: a inexigibilidade exige comprovação de inviabilidade
 * de competição (exclusividade). O contexto não traz o texto do DOM com a
 * justificativa — sinaliza, de forma conservadora, inexigibilidades de valor
 * relevante para conferência da carta de exclusividade. Honestidade: a
 * verificação da fragilidade da justificativa exige o DOM, ausente no contexto;
 * aqui o detector aponta o conjunto a apurar por valor.
 */
export const detectorInexigibilidadeFragil: Detector = {
  id: 'LC-07',
  nome: 'Inexigibilidade frágil',
  categoria: 'Licitações e compras',
  detectar(ctx) {
    const inexig = ctx.despesas.filter(
      (d) =>
        d.valorEmpenhado >= LIMIAR_INEXIGIBILIDADE &&
        (RE_INEXIGIBILIDADE.test(d.modalidadeCodigo) || RE_INEXIGIBILIDADE.test(d.objeto)),
    );
    if (inexig.length === 0) return [];

    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of inexig) {
      const chave = d.cpfCnpj || `sem-cnpj-${d.id}`;
      const arr = porCnpj.get(chave) ?? [];
      arr.push(d);
      porCnpj.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porCnpj) {
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || chave;
      out.push({
        detectorId: 'LC-07',
        detectorNome: 'Inexigibilidade frágil',
        categoria: 'Licitações e compras',
        titulo: `Inexigibilidade de valor relevante — ${nome}`,
        descricao:
          `${lista.length} contratação(ões) por inexigibilidade ao mesmo fornecedor ` +
          `somando ${formatBRL(soma)}. Possível indício a apurar: conferir a ` +
          `comprovação de exclusividade.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj || chave,
        sujeitoRotulo: nome,
        classificacao: soma >= 200_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 56,
          probabilidadeIrregularidade: Math.min(66, 34 + lista.length * 6),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 74'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Inexigibilidade ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)}${d.objeto ? ` (${d.objeto})` : ''}`,
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'A inexigibilidade exige comprovação robusta de inviabilidade de ' +
          'competição (Lei 14.133/2021 art. 74). Inexigibilidades de valor ' +
          'relevante são possível indício a apurar — conferir a carta de ' +
          'exclusividade no processo. DEPENDÊNCIA: a avaliação da fragilidade da ' +
          'justificativa exige o texto do DOM/processo, que não está no contexto; ' +
          'o detector sinaliza por valor para conferência manual.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ── LC-18 — Modalidade incompatível com o valor ──────────────────────────────
/**
 * Lei 14.133/2021 art. 28–29 e art. 75: o valor da contratação determina a
 * modalidade exigível. Sinaliza despesas classificadas como dispensa ou convite
 * cujo valor excede o limite legal — caso em que a modalidade usada é menos
 * rigorosa do que o valor exigiria.
 */
export const detectorModalidadeIncompativel: Detector = {
  id: 'LC-18',
  nome: 'Modalidade incompatível com o valor',
  categoria: 'Licitações e compras',
  detectar(ctx) {
    const limite = getLimiteDispensa(ctx.exercicio);
    const out: AlertaDetectado[] = [];
    const suspeitos: { d: DespesaNorm; motivo: string; teto: number }[] = [];

    for (const d of ctx.despesas) {
      if (d.valorEmpenhado <= 0) continue;
      const mod = d.modalidadeCodigo;
      if (!mod) continue;
      const ehObra = /obra|engenharia|pavimenta|constru/i.test(d.objeto);
      const tetoDispensa = ehObra ? limite.obrasEngenharia : limite.comprasServicos;

      if (RE_DISPENSA.test(mod) && d.valorEmpenhado > tetoDispensa) {
        suspeitos.push({
          d,
          motivo: `dispensa acima do limite de ${formatBRL(tetoDispensa)}`,
          teto: tetoDispensa,
        });
      } else if (RE_CONVITE.test(mod) && d.valorEmpenhado > tetoDispensa * 5) {
        // Convite foi extinto pela Lei 14.133/2021; valor alto reforça o indício.
        suspeitos.push({
          d,
          motivo: 'modalidade convite para valor elevado',
          teto: tetoDispensa * 5,
        });
      }
    }
    if (suspeitos.length === 0) return [];

    const porCnpj = new Map<string, typeof suspeitos>();
    for (const s of suspeitos) {
      const chave = s.d.cpfCnpj || `sem-cnpj-${s.d.id}`;
      const arr = porCnpj.get(chave) ?? [];
      arr.push(s);
      porCnpj.set(chave, arr);
    }

    for (const [chave, lista] of porCnpj) {
      const soma = lista.reduce((s, x) => s + x.d.valorEmpenhado, 0);
      const nome = lista.find((x) => x.d.fornecedorNome)?.d.fornecedorNome || chave;
      out.push({
        detectorId: 'LC-18',
        detectorNome: 'Modalidade incompatível com o valor',
        categoria: 'Licitações e compras',
        titulo: `Modalidade aparentemente incompatível com o valor — ${nome}`,
        descricao:
          `${lista.length} contratação(ões) cuja modalidade declarada parece menos ` +
          `rigorosa do que o valor exigiria, somando ${formatBRL(soma)}. ` +
          `Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].d.cpfCnpj || chave,
        sujeitoRotulo: nome,
        classificacao: soma >= limite.comprasServicos * 3 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 64,
          probabilidadeIrregularidade: Math.min(78, 42 + lista.length * 6),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 28–29', 'Lei 14.133/2021 art. 75'],
        evidencias: lista.slice(0, 8).map((x) => ({
          resumo: `${x.d.modalidadeCodigo} — ${formatBRL(x.d.valorEmpenhado)} (${x.motivo})`,
          valor: x.d.valorEmpenhado,
          data: x.d.data,
        })),
        explicacao:
          'O valor da contratação determina a modalidade exigível (Lei ' +
          '14.133/2021 art. 28–29). Dispensa ou convite usados para valores acima ' +
          'do limite legal são possível indício de modalidade incompatível a ' +
          'apurar — verifique se houve desmembramento indevido do objeto.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// LC-22 (Vencedor recém-aberto) — implementado em `licitacoes-cat.ts`
// (detectorVencedorRecemAbertoCat). Removido daqui para não duplicar o ID.

// ── LC-24 — Empenho sem itens detalháveis ────────────────────────────────────
/**
 * Lei 4.320/1964 art. 63: a liquidação apura o que é devido com base em
 * documentação. Empenhos de valor relevante cujo objeto é vazio ou genérico
 * (sem drill-down de itens) dificultam o controle. Sinaliza despesas de alto
 * valor com objeto ausente ou genérico.
 */
const RE_OBJETO_GENERICO =
  /^(diversos|v[áa]rios|outros|servi[çc]os|materiais|despesas?|aquisi[çc][ãa]o)\.?$/i;

export const detectorEmpenhoSemItens: Detector = {
  id: 'LC-24',
  nome: 'Empenho sem itens detalháveis',
  categoria: 'Licitações e compras',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const semItens = ctx.despesas.filter((d) => {
      if (d.valorEmpenhado < LIMIAR_SEM_ITENS) return false;
      const obj = d.objeto.trim();
      return obj.length === 0 || obj.length < 8 || RE_OBJETO_GENERICO.test(obj);
    });
    if (semItens.length === 0) return [];

    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of semItens) {
      const chave = d.cpfCnpj || `sem-cnpj-${d.id}`;
      const arr = porCnpj.get(chave) ?? [];
      arr.push(d);
      porCnpj.set(chave, arr);
    }

    for (const [chave, lista] of porCnpj) {
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || chave;
      out.push({
        detectorId: 'LC-24',
        detectorNome: 'Empenho sem itens detalháveis',
        categoria: 'Licitações e compras',
        titulo: `Empenho relevante sem detalhamento de objeto — ${nome}`,
        descricao:
          `${lista.length} empenho(s) acima de ${formatBRL(LIMIAR_SEM_ITENS)} com objeto ` +
          `vazio ou genérico, somando ${formatBRL(soma)}. Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj || chave,
        sujeitoRotulo: nome,
        classificacao: 'informativo',
        scores: {
          confiabilidade: 60,
          probabilidadeIrregularidade: Math.min(48, 24 + lista.length * 4),
        },
        fundamentoLegal: ['Lei 4.320/1964 art. 63'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Empenho ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)} (objeto: "${d.objeto || '—'}")`,
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'Empenhos de valor relevante com objeto vazio ou genérico dificultam o ' +
          'controle e a transparência (Lei 4.320/1964 art. 63). É possível indício ' +
          'a apurar de falta de detalhamento — pode também ser limitação do campo ' +
          'de objeto no portal, o que deve ser verificado.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};
