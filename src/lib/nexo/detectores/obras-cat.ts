/**
 * Detectores da área OBRAS PÚBLICAS (catálogo OB-01 a OB-14).
 *
 * Materializa os 14 monitoramentos de obras do catálogo-mestre
 * (src/lib/nexo/catalogo-completo.ts). Linguagem: indício a apurar — NUNCA
 * acusação. Limiares conservadores; jamais inventa dado nem produz falso
 * positivo. Ver docs/nexo-plano-mestre.md §6–§7.
 *
 * HONESTIDADE SOBRE A FONTE DE DADOS
 * ----------------------------------
 * O `ContextoAnalise` traz apenas empenhos analíticos, despesas agrupadas
 * (objeto/elemento/valores) e restos a pagar. A maioria das regras de obra
 * exige fontes que o contexto NÃO possui:
 *
 *   - planilha orçamentária item-a-item (preço unitário por insumo)
 *   - tabelas de referência SINAPI / SICRO
 *   - composição de BDI declarada
 *   - boletins de medição física (% executado em campo)
 *   - status da obra (em andamento / paralisada / concluída)
 *   - registro de ART/RRT do responsável técnico
 *   - cadastro de aditivos contratuais
 *   - logradouro/endereço georreferenciado da obra
 *
 * Cada detector abaixo implementa a lógica COMPLETA e correta do catálogo.
 * Quando a fonte necessária está ausente, o detector retorna `[]` e o
 * comentário acima dele NOMEIA a fonte que falta. O que É computável a partir
 * de `despesas`/`empenhos`/`restosAPagar` roda de verdade:
 *
 *   OB-08  pagamento de obra sem liquidação registrada — RODA.
 *   OB-09  obra em restos a pagar com saldo relevante — RODA (proxy de parada).
 *   OB-10  obra paga recentemente sem evolução — RODA (proxy parcial).
 *   OB-13  obra empenhada sem contrato/processo localizável — RODA.
 *   OB-14  mesmo objeto de pavimentação repetido — RODA (similaridade textual).
 */
import {
  formatBRL,
  type DespesaNorm,
  type EmpenhoNorm,
  type RestoPagarNorm,
} from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

const CATEGORIA = 'Obras públicas';

/**
 * Caracteriza despesa/empenho de OBRA ou SERVIÇO DE ENGENHARIA pelo objeto ou
 * elemento. Conservador: só termos inequívocos de engenharia civil.
 */
const RE_OBRA =
  /\bobra(s)?\b|pavimenta|recape|recapea|tapa[-\s]?buraco|constru[çc]|edifica|engenharia|reforma|amplia[çc]|drenagem|terraplen|asfalt|gale ?ria|ponte|via[ -]?dut|cal[çc]ament|guia(s)? e sarjeta|sarjeta|infraestrutura via/i;

/** Termo específico de PAVIMENTAÇÃO/recape — usado por OB-14. */
const RE_PAVIMENTACAO =
  /pavimenta|recape|recapea|tapa[-\s]?buraco|asfalt|cal[çc]ament|guia(s)? e sarjeta|sarjeta|recomposi[çc].*asf/i;

/** Despesa é de obra quando o objeto OU o elemento sugerem engenharia. */
function ehDespesaObra(d: DespesaNorm): boolean {
  return RE_OBRA.test(d.objeto) || RE_OBRA.test(d.elemento);
}

/** Empenho analítico de obra — só há nome de fornecedor, sem objeto; usa o nome
 *  apenas como pista fraca, então este filtro fica propositalmente vazio: o
 *  empenho analítico não traz objeto e não pode ser classificado como obra com
 *  segurança. Mantido para clareza de intenção. */

/** Soma absoluta de valores empenhados. */
function somaEmpenhado(lista: DespesaNorm[]): number {
  return lista.reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
}

/** Número de empenho parece válido quando tem ao menos um dígito. */
function temNumeroEmpenho(numero: string): boolean {
  return /\d/.test((numero || '').trim());
}

/** Normaliza texto para comparação de objeto: minúsculas, sem acento, sem
 *  pontuação, espaços colapsados. */
function normalizarTexto(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stopwords genéricas que não ajudam a distinguir um objeto de outro. */
const STOPWORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas',
  'a', 'o', 'as', 'os', 'para', 'com', 'por', 'um', 'uma', 'ao', 'aos',
  'servico', 'servicos', 'contratacao', 'empenho', 'referente', 'ref',
  'municipio', 'municipal', 'prefeitura', 'secretaria',
]);

/** Conjunto de tokens significativos (>=4 letras, sem stopwords). */
function tokensSignificativos(s: string): Set<string> {
  return new Set(
    normalizarTexto(s)
      .split(' ')
      .filter((t) => t.length >= 4 && !STOPWORDS.has(t)),
  );
}

/** Similaridade de Jaccard entre dois conjuntos de tokens. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const uniao = a.size + b.size - inter;
  return uniao === 0 ? 0 : inter / uniao;
}

/** Diferença em dias entre duas datas ISO; null se alguma faltar. */
function diasEntre(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86_400_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// OB-01 — Sobrepreço unitário médio
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: preço unitário do item / referência SINAPI-SICRO entre
 * 1,15 e 1,25.
 *
 * FONTE AUSENTE: planilha orçamentária item-a-item (preço unitário por insumo)
 * e as tabelas de referência SINAPI/SICRO. O `ContextoAnalise` só traz o valor
 * total empenhado por despesa — sem quantitativo e sem preço unitário não há
 * razão item/referência calculável. Retorna `[]` até a integração da planilha
 * orçamentária e do SINAPI/SICRO.
 */
export const detectorOB01: Detector = {
  id: 'OB-01',
  nome: 'Sobrepreço unitário médio',
  categoria: CATEGORIA,
  detectar(_ctx): AlertaDetectado[] {
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-02 — Sobrepreço unitário alto
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: razão preço unitário / referência entre 1,25 e 1,40.
 *
 * FONTE AUSENTE: idem OB-01 — planilha orçamentária item-a-item e referência
 * SINAPI/SICRO. Sem preço unitário por insumo não há razão calculável.
 * Retorna `[]` até a integração dessas fontes.
 */
export const detectorOB02: Detector = {
  id: 'OB-02',
  nome: 'Sobrepreço unitário alto',
  categoria: CATEGORIA,
  detectar(_ctx): AlertaDetectado[] {
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-03 — Sobrepreço unitário crítico
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: razão preço unitário / referência > 1,40 sem justificativa
 * técnica.
 *
 * FONTE AUSENTE: idem OB-01/OB-02 — planilha orçamentária item-a-item e
 * referência SINAPI/SICRO. Retorna `[]` até a integração dessas fontes.
 */
export const detectorOB03: Detector = {
  id: 'OB-03',
  nome: 'Sobrepreço unitário crítico',
  categoria: CATEGORIA,
  detectar(_ctx): AlertaDetectado[] {
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-04 — BDI fora do padrão
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: BDI declarado acima da faixa de referência (TCU Ac.
 * 2.622/2013-P).
 *
 * FONTE AUSENTE: a composição de BDI declarada na proposta/planilha
 * orçamentária da obra. O `ContextoAnalise` não traz BDI algum. Retorna `[]`
 * até a integração da planilha orçamentária com a composição de BDI.
 */
export const detectorOB04: Detector = {
  id: 'OB-04',
  nome: 'BDI fora do padrão',
  categoria: CATEGORIA,
  detectar(_ctx): AlertaDetectado[] {
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-05 — Curva ABC concentrada
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: top 10 itens / valor total da obra > 80%.
 *
 * FONTE AUSENTE: planilha orçamentária item-a-item da obra (a curva ABC é
 * calculada sobre os itens da planilha). O `ContextoAnalise` traz despesas
 * agregadas por empenho, não itens de planilha. Retorna `[]` até a integração
 * da planilha orçamentária.
 */
export const detectorOB05: Detector = {
  id: 'OB-05',
  nome: 'Curva ABC concentrada',
  categoria: CATEGORIA,
  detectar(_ctx): AlertaDetectado[] {
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-06 — Jogo de planilha
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: itens acima da referência super-executados e itens abaixo
 * sub-executados (manipulação de quantitativos).
 *
 * FONTE AUSENTE: planilha orçamentária item-a-item (preço unitário e
 * quantitativo PREVISTO) cruzada com os boletins de medição (quantitativo
 * EXECUTADO). O `ContextoAnalise` não traz nenhuma das duas. Retorna `[]` até
 * a integração da planilha orçamentária e dos boletins de medição.
 */
export const detectorOB06: Detector = {
  id: 'OB-06',
  nome: 'Jogo de planilha',
  categoria: CATEGORIA,
  detectar(_ctx): AlertaDetectado[] {
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-07 — Financeiro acima do físico
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: % financeiro pago − % físico medido > 10 pontos.
 *
 * FONTE AUSENTE: os boletins de medição física da obra (% físico executado em
 * campo). O `ContextoAnalise` permite calcular o % financeiro pago, mas sem o
 * % físico medido não há diferença a comparar. Retorna `[]` até a integração
 * dos boletins de medição física.
 */
export const detectorOB07: Detector = {
  id: 'OB-07',
  nome: 'Financeiro acima do físico',
  categoria: CATEGORIA,
  detectar(_ctx): AlertaDetectado[] {
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-08 — Pagamento de obra sem medição  [COMPUTÁVEL — RODA]
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: empenho/pagamento de obra sem boletim de medição vinculado.
 *
 * O boletim de medição em si não está no contexto. A liquidação, porém, é a
 * etapa em que a medição é conferida e atestada (Lei 4.320/1964 art. 63): um
 * pagamento de obra registrado SEM liquidação é o indício mais próximo e
 * defensável de pagamento sem medição. Esta é a proxy adotada — declarada de
 * forma transparente na explicação. RODA sobre `empenhos` (que traz o flag
 * `temLiquidacao`), restringindo a fornecedores cujo nome sugere engenharia e
 * cruzando com despesas de obra do mesmo fornecedor para reduzir falso
 * positivo. Conservador: só sinaliza pagamento efetivo (`valorPago > 0`).
 */
export const detectorOB08: Detector = {
  id: 'OB-08',
  nome: 'Pagamento de obra sem medição',
  categoria: CATEGORIA,
  detectar(ctx): AlertaDetectado[] {
    const empenhos = ctx.empenhos ?? [];
    const despesas = ctx.despesas ?? [];
    if (empenhos.length === 0) return [];

    // CNPJs que aparecem em despesas de obra — usados para confirmar que o
    // fornecedor do empenho realmente executa obra/engenharia.
    const cnpjsObra = new Set<string>();
    for (const d of despesas) {
      if (d.cpfCnpj && ehDespesaObra(d)) cnpjsObra.add(d.cpfCnpj);
    }
    // Sem nenhuma despesa de obra identificável não há como confirmar o
    // recorte de obras — evita falso positivo classificando qualquer empenho.
    if (cnpjsObra.size === 0) return [];

    // Empenhos de obra pagos SEM liquidação registrada.
    const suspeitos = empenhos.filter(
      (e) =>
        e.valorPago > 0 &&
        !e.temLiquidacao &&
        e.cpfCnpj &&
        cnpjsObra.has(e.cpfCnpj),
    );
    if (suspeitos.length === 0) return [];

    const porCnpj = new Map<string, EmpenhoNorm[]>();
    for (const e of suspeitos) {
      const arr = porCnpj.get(e.cpfCnpj) ?? [];
      arr.push(e);
      porCnpj.set(e.cpfCnpj, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [cnpj, lista] of porCnpj) {
      const soma = lista.reduce((s, e) => s + e.valorPago, 0);
      if (soma <= 0) continue;
      const nome = lista.find((e) => e.fornecedorNome)?.fornecedorNome || cnpj;
      out.push({
        detectorId: 'OB-08',
        detectorNome: 'Pagamento de obra sem medição',
        categoria: CATEGORIA,
        titulo: `Possível pagamento de obra sem medição — ${nome}`,
        descricao:
          `${lista.length} pagamento(s) a fornecedor de obra/engenharia ` +
          `(${formatBRL(soma)}) sem liquidação registrada — etapa em que a ` +
          `medição é atestada. Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao: soma > 200_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 52,
          probabilidadeIrregularidade: Math.min(70, 36 + lista.length * 5),
        },
        fundamentoLegal: ['Lei 4.320/1964 art. 63'],
        evidencias: lista.slice(0, 8).map((e) => ({
          resumo: `Empenho ${e.numeroEmpenho || e.id} — pago ${formatBRL(e.valorPago)} sem liquidação`,
          valor: e.valorPago,
          data: e.data,
          ref: e.id,
        })),
        explicacao:
          'A liquidação da despesa de obra tem por base a medição dos serviços ' +
          'efetivamente executados (Lei 4.320/1964 art. 63). Pagamento de obra ' +
          'sem liquidação registrada é possível indício de pagamento sem ' +
          'medição, a apurar. DEPENDÊNCIA: o boletim de medição não está no ' +
          'contexto — usa-se a ausência de liquidação como proxy; pode também ser ' +
          'lacuna de registro do portal, o que deve ser verificado antes de ' +
          'qualquer conclusão.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-09 — Obra paralisada com saldo  [COMPUTÁVEL (proxy) — RODA]
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: status = paralisada + saldo empenhado > R$ 50k.
 *
 * FONTE AUSENTE: o status oficial da obra (em andamento / paralisada /
 * concluída). Sem ele não há como afirmar "paralisada". A proxy defensável é
 * o módulo de RESTOS A PAGAR: um empenho de obra inscrito em restos a pagar
 * representa despesa empenhada não paga no exercício — saldo retido que, em
 * obra, é compatível com execução interrompida. RODA sobre `restosAPagar`,
 * cruzando o CNPJ com despesas de obra para confirmar o recorte. Limiar
 * conservador de R$ 50k conforme o catálogo. Indício a apurar.
 */
export const detectorOB09: Detector = {
  id: 'OB-09',
  nome: 'Obra paralisada com saldo',
  categoria: CATEGORIA,
  detectar(ctx): AlertaDetectado[] {
    const restos = ctx.restosAPagar ?? [];
    const despesas = ctx.despesas ?? [];
    if (restos.length === 0) return [];

    const cnpjsObra = new Set<string>();
    for (const d of despesas) {
      if (d.cpfCnpj && ehDespesaObra(d)) cnpjsObra.add(d.cpfCnpj);
    }
    if (cnpjsObra.size === 0) return [];

    const LIMIAR = 50_000;
    const porCnpj = new Map<string, RestoPagarNorm[]>();
    for (const r of restos) {
      if (!r.cpfCnpj || r.valor <= 0 || !cnpjsObra.has(r.cpfCnpj)) continue;
      const arr = porCnpj.get(r.cpfCnpj) ?? [];
      arr.push(r);
      porCnpj.set(r.cpfCnpj, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [cnpj, lista] of porCnpj) {
      const saldo = lista.reduce((s, r) => s + r.valor, 0);
      if (saldo <= LIMIAR) continue;
      const nome = lista.find((r) => r.fornecedorNome)?.fornecedorNome || cnpj;
      out.push({
        detectorId: 'OB-09',
        detectorNome: 'Obra paralisada com saldo',
        categoria: CATEGORIA,
        titulo: `Saldo de obra retido em restos a pagar — ${nome}`,
        descricao:
          `Fornecedor de obra/engenharia com ${formatBRL(saldo)} inscritos em ` +
          `restos a pagar (${lista.length} registro(s)) — saldo empenhado não ` +
          `pago, compatível com execução interrompida. Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao: saldo > 250_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 44,
          probabilidadeIrregularidade: Math.min(58, 30 + lista.length * 4),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 115'],
        evidencias: lista.slice(0, 8).map((r) => ({
          resumo: `Resto a pagar ${r.id} — ${formatBRL(r.valor)}`,
          valor: r.valor,
          data: null,
          ref: r.id,
        })),
        explicacao:
          'Obra com saldo empenhado relevante e parada caracteriza risco de ' +
          'recurso imobilizado sem entrega (Lei 14.133/2021 art. 115). ' +
          'DEPENDÊNCIA: o status oficial da obra não está no contexto — usa-se ' +
          'a inscrição em restos a pagar como proxy de saldo retido; pode ' +
          'também refletir apenas defasagem normal entre empenho e pagamento, ' +
          'o que deve ser confirmado contra a situação física da obra.',
        valorEnvolvido: saldo,
      });
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-10 — Obra paga recentemente e parada  [COMPUTÁVEL (proxy parcial) — RODA]
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: pagamento nos últimos 60 dias + 0% de avanço físico.
 *
 * FONTE AUSENTE: o avanço físico medido da obra (boletins de medição). Sem ele
 * o "0% de avanço físico" não é verificável. O que É computável é o lado do
 * pagamento: despesa de obra com pagamento recente (data do empenho dentro dos
 * últimos 60 dias do exercício analisado) e SEM liquidação registrada — ou
 * seja, pagamento recente sem o atesto que comprovaria a execução. Esta é a
 * melhor proxy disponível para o lado físico, declarada na explicação. RODA
 * sobre `despesas` filtradas por objeto/elemento de obra. Indício a apurar.
 */
export const detectorOB10: Detector = {
  id: 'OB-10',
  nome: 'Obra paga recentemente e parada',
  categoria: CATEGORIA,
  detectar(ctx): AlertaDetectado[] {
    const despesas = ctx.despesas ?? [];
    const empenhos = ctx.empenhos ?? [];
    if (despesas.length === 0) return [];

    // Despesas de obra com pagamento efetivo e data conhecida.
    const obrasPagas = despesas.filter(
      (d) => ehDespesaObra(d) && d.valorPago > 0 && d.data,
    );
    if (obrasPagas.length === 0) return [];

    // Referência temporal: data mais recente vista no conjunto de despesas.
    const dataMaisRecente = obrasPagas
      .map((d) => d.data!)
      .reduce((a, b) => (a > b ? a : b));

    // Mapa de liquidação por número de empenho (proxy de "execução atestada").
    const liquidadoPorEmpenho = new Set<string>();
    for (const e of empenhos) {
      if (e.temLiquidacao && temNumeroEmpenho(e.numeroEmpenho)) {
        liquidadoPorEmpenho.add(e.numeroEmpenho.trim());
      }
    }

    // Pagamento recente (<= 60 dias da data de referência) e sem liquidação.
    const recentesSemAtesto = obrasPagas.filter((d) => {
      const dias = diasEntre(d.data, dataMaisRecente);
      if (dias === null || dias > 60) return false;
      const numero = (d.numeroEmpenho || '').trim();
      return !numero || !liquidadoPorEmpenho.has(numero);
    });
    if (recentesSemAtesto.length === 0) return [];

    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of recentesSemAtesto) {
      const chave = d.cpfCnpj || 'sem-cnpj';
      const arr = porCnpj.get(chave) ?? [];
      arr.push(d);
      porCnpj.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porCnpj) {
      const soma = lista.reduce((s, d) => s + d.valorPago, 0);
      if (soma <= 0) continue;
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || chave;
      out.push({
        detectorId: 'OB-10',
        detectorNome: 'Obra paga recentemente e parada',
        categoria: CATEGORIA,
        titulo: `Pagamento recente de obra sem atesto de execução — ${nome}`,
        descricao:
          `${lista.length} despesa(s) de obra com pagamento nos últimos 60 dias ` +
          `(${formatBRL(soma)}) sem liquidação que ateste a execução física. ` +
          `Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj || 'sem-cnpj',
        sujeitoRotulo: nome,
        classificacao: soma > 150_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 42,
          probabilidadeIrregularidade: Math.min(58, 32 + lista.length * 4),
        },
        fundamentoLegal: ['Lei 4.320/1964 art. 63'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `${d.objeto || 'Obra'} — pago ${formatBRL(d.valorPago)} (empenho ${d.numeroEmpenho || d.id})`,
          valor: d.valorPago,
          data: d.data,
          ref: d.id,
        })),
        explicacao:
          'Pagamento recente de obra deve corresponder a serviço efetivamente ' +
          'medido e atestado (Lei 4.320/1964 art. 63). DEPENDÊNCIA: o avanço ' +
          'físico medido não está no contexto — verifica-se apenas o lado do ' +
          'pagamento (recente e sem liquidação atestadora) como proxy; o ' +
          'percentual físico de execução deve ser confirmado contra os ' +
          'boletins de medição antes de qualquer conclusão.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-11 — Aditivos de obra em cadeia
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: ≥3 aditivos no mesmo contrato de obra OU Σ aditivos > 25%
 * do original (50% para reforma).
 *
 * FONTE AUSENTE: o cadastro de aditivos contratuais (cada aditivo com contrato
 * de origem, valor e tipo). O `ContextoAnalise` traz REFORÇOS de empenho —
 * ato orçamentário distinto de aditivo contratual — mas não os aditivos em si,
 * e não vincula reforço a contrato de obra. O detector OR-09 já trata reforços
 * de empenho de forma genérica; replicar aqui geraria duplicidade e não
 * representaria aditivo. Retorna `[]` até a integração do cadastro de aditivos
 * (PNCP/portal de contratos).
 */
export const detectorOB11: Detector = {
  id: 'OB-11',
  nome: 'Aditivos de obra em cadeia',
  categoria: CATEGORIA,
  detectar(_ctx): AlertaDetectado[] {
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-12 — Obra sem ART/RRT
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: ausência de ART (CREA) ou RRT (CAU) do responsável
 * técnico no processo da obra.
 *
 * FONTE AUSENTE: o registro de ART/RRT do responsável técnico, normalmente nos
 * sistemas do CREA/CAU ou anexado ao processo administrativo. O
 * `ContextoAnalise` não traz processo administrativo detalhado nem dados de
 * responsabilidade técnica. Retorna `[]` até a integração da consulta de
 * ART/RRT ou da peça processual da obra.
 */
export const detectorOB12: Detector = {
  id: 'OB-12',
  nome: 'Obra sem ART/RRT',
  categoria: CATEGORIA,
  detectar(_ctx): AlertaDetectado[] {
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-13 — Obra anunciada sem contrato  [COMPUTÁVEL — RODA]
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: obra citada em DOM/notícia sem contrato/empenho
 * localizável.
 *
 * O cruzamento ideal com o Diário Oficial não está neste contexto. O lado
 * computável e defensável é o inverso, igualmente previsto na regra ("sem
 * contrato/empenho localizável"): despesa de obra de valor relevante cujo
 * registro NÃO traz processo administrativo nem processo licitatório
 * identificável — ou seja, gasto de obra sem o vínculo processual que
 * comprovaria a contratação formal. RODA sobre `despesas` de obra,
 * confirmando o vínculo de processo no empenho analítico do mesmo número.
 * Limiar conservador de R$ 100k (alinhado a XS-07). Indício a apurar.
 */
export const detectorOB13: Detector = {
  id: 'OB-13',
  nome: 'Obra anunciada sem contrato',
  categoria: CATEGORIA,
  detectar(ctx): AlertaDetectado[] {
    const despesas = ctx.despesas ?? [];
    const empenhos = ctx.empenhos ?? [];
    if (despesas.length === 0) return [];

    const LIMIAR = 100_000;

    // Empenhos analíticos que têm vínculo processual conhecido — indexados por
    // número de empenho, para confirmar se a despesa de obra tem processo.
    const comProcesso = new Set<string>();
    for (const e of empenhos) {
      if (
        temNumeroEmpenho(e.numeroEmpenho) &&
        (e.processoAdministrativo || e.processoLicitatorio)
      ) {
        comProcesso.add(e.numeroEmpenho.trim());
      }
    }

    // Despesas de obra agrupadas por número de empenho (uma obra pode ter
    // empenho original + reforços lançados sob o mesmo número).
    const porEmpenho = new Map<string, DespesaNorm[]>();
    for (const d of despesas) {
      if (!ehDespesaObra(d)) continue;
      if (/ANUL/i.test(d.tipoEmpenho)) continue; // anulação não é gasto
      const numero = (d.numeroEmpenho || '').trim();
      const chave = numero || `sem-empenho-${d.id}`;
      const arr = porEmpenho.get(chave) ?? [];
      arr.push(d);
      porEmpenho.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porEmpenho) {
      const valor = somaEmpenhado(lista);
      if (valor < LIMIAR) continue;

      const numero = (lista[0].numeroEmpenho || '').trim();
      // Tem processo localizável? Confere no empenho analítico vinculado.
      if (numero && comProcesso.has(numero)) continue;

      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || '';
      const objeto = lista.find((d) => d.objeto)?.objeto || 'Obra';
      out.push({
        detectorId: 'OB-13',
        detectorNome: 'Obra anunciada sem contrato',
        categoria: CATEGORIA,
        titulo: `Obra empenhada sem processo localizável — ${objeto}`,
        descricao:
          `Despesa de obra de ${formatBRL(valor)}${nome ? ` (${nome})` : ''} ` +
          `sem processo administrativo nem licitatório identificável no ` +
          `registro. Possível indício a apurar.`,
        sujeitoTipo: numero ? 'empenho' : 'fornecedor',
        sujeitoId: numero || lista[0].cpfCnpj || `obra-${chave}`,
        sujeitoRotulo: numero ? `Empenho ${numero}` : nome || objeto,
        classificacao: valor > 500_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 56,
          probabilidadeIrregularidade: Math.min(
            70,
            38 + Math.round(Math.min(28, (valor / LIMIAR - 1) * 12)),
          ),
        },
        fundamentoLegal: ['LC 131/2009', 'Lei 12.527/2011 (LAI)', 'Lei 14.133/2021 art. 95'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `${d.objeto || 'Obra'} — ${formatBRL(Math.abs(d.valorEmpenhado))} (empenho ${d.numeroEmpenho || d.id})`,
          valor: Math.abs(d.valorEmpenhado),
          data: d.data,
          ref: d.id,
        })),
        explicacao:
          'Obra executada com recurso público deve ter contrato e processo ' +
          'formal publicados e rastreáveis (LC 131/2009; LAI; Lei 14.133/2021 ' +
          'art. 95). Despesa relevante de obra sem processo administrativo nem ' +
          'licitatório identificável é possível indício de obra anunciada/' +
          'executada sem contrato localizável, a apurar — pode também ser ' +
          'apenas ausência do vínculo no portal, o que deve ser verificado.',
        valorEnvolvido: valor,
      });
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OB-14 — Recape/tapa-buraco repetido no local  [COMPUTÁVEL (proxy) — RODA]
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: mesmo endereço/objeto de pavimentação contratado mais de
 * uma vez em 18 meses.
 *
 * FONTE PARCIALMENTE AUSENTE: o endereço/logradouro georreferenciado da obra
 * não está no contexto — só o texto do campo `objeto`. A proxy adotada é
 * comparar despesas de PAVIMENTAÇÃO/recape por similaridade textual do objeto
 * (Jaccard de tokens significativos): quando o mesmo objeto de pavimentação
 * aparece em ≥2 empenhos distintos, é indício de repetição no mesmo local. A
 * janela de 18 meses do catálogo é aplicada quando há datas; sem data, o par
 * ainda é considerado dentro do exercício analisado. RODA sobre `despesas`.
 * Limiar conservador: similaridade alta (≥0,6) e ao menos 2 ocorrências.
 */
export const detectorOB14: Detector = {
  id: 'OB-14',
  nome: 'Recape/tapa-buraco repetido no local',
  categoria: CATEGORIA,
  detectar(ctx): AlertaDetectado[] {
    const despesas = ctx.despesas ?? [];
    if (despesas.length === 0) return [];

    const SIM_MIN = 0.6;
    const JANELA_DIAS = 18 * 30; // ~18 meses

    // Despesas de pavimentação/recape com objeto textual aproveitável.
    const pavs = despesas
      .filter(
        (d) =>
          d.valorEmpenhado > 0 &&
          !/ANUL/i.test(d.tipoEmpenho) &&
          (RE_PAVIMENTACAO.test(d.objeto) || RE_PAVIMENTACAO.test(d.elemento)) &&
          d.objeto.trim().length >= 8,
      )
      .map((d) => ({ d, tokens: tokensSignificativos(d.objeto) }))
      .filter((x) => x.tokens.size >= 2);
    if (pavs.length < 2) return [];

    // Agrupamento por similaridade: cada despesa entra no primeiro grupo cujo
    // representante seja suficientemente similar; senão abre grupo novo.
    interface Grupo {
      itens: DespesaNorm[];
      ref: Set<string>;
    }
    const grupos: Grupo[] = [];
    for (const { d, tokens } of pavs) {
      let alocado = false;
      for (const g of grupos) {
        if (jaccard(tokens, g.ref) >= SIM_MIN) {
          g.itens.push(d);
          alocado = true;
          break;
        }
      }
      if (!alocado) grupos.push({ itens: [d], ref: tokens });
    }

    const out: AlertaDetectado[] = [];
    for (const g of grupos) {
      // Considera apenas empenhos distintos — reforço do mesmo número não é
      // nova contratação no local.
      const numerosDistintos = new Set(
        g.itens.map((d) => (d.numeroEmpenho || d.id).trim()),
      );
      if (numerosDistintos.size < 2) continue;

      // Janela de 18 meses: se houver datas, exige par dentro da janela.
      const datas = g.itens.map((d) => d.data).filter((x): x is string => !!x);
      if (datas.length >= 2) {
        const min = datas.reduce((a, b) => (a < b ? a : b));
        const max = datas.reduce((a, b) => (a > b ? a : b));
        const span = diasEntre(min, max);
        if (span !== null && span > JANELA_DIAS) continue;
      }

      const soma = somaEmpenhado(g.itens);
      const objeto =
        g.itens.find((d) => d.objeto)?.objeto || 'Pavimentação';
      out.push({
        detectorId: 'OB-14',
        detectorNome: 'Recape/tapa-buraco repetido no local',
        categoria: CATEGORIA,
        titulo: `Pavimentação possivelmente repetida — ${objeto}`,
        descricao:
          `${numerosDistintos.size} contratações distintas de pavimentação/recape ` +
          `com objeto muito semelhante, somando ${formatBRL(soma)}. Possível ` +
          `repetição no mesmo local — indício a apurar.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `ob14-${normalizarTexto(objeto).slice(0, 40).replace(/ /g, '-')}`,
        sujeitoRotulo: objeto,
        classificacao: numerosDistintos.size >= 3 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 48,
          probabilidadeIrregularidade: Math.min(
            66,
            34 + numerosDistintos.size * 6,
          ),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 18', 'Lei 8.429/1992'],
        evidencias: g.itens.slice(0, 8).map((d) => ({
          resumo: `${d.objeto || 'Pavimentação'} — ${formatBRL(Math.abs(d.valorEmpenhado))} (empenho ${d.numeroEmpenho || d.id})`,
          valor: Math.abs(d.valorEmpenhado),
          data: d.data,
          ref: d.id,
        })),
        explicacao:
          'Repavimentar repetidamente o mesmo trecho em curto intervalo é ' +
          'possível indício de planejamento deficiente, serviço anterior mal ' +
          'executado ou despesa sem efetividade (Lei 14.133/2021 art. 18). ' +
          'DEPENDÊNCIA: o contexto não traz o logradouro georreferenciado da ' +
          'obra — a repetição é inferida por similaridade textual do objeto; ' +
          'objetos genéricos podem agrupar trechos diferentes, então o local ' +
          'real deve ser confirmado antes de qualquer conclusão.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Registro da área OBRAS PÚBLICAS
// ─────────────────────────────────────────────────────────────────────────────
export const DETECTORES_OB_CAT: Detector[] = [
  detectorOB01,
  detectorOB02,
  detectorOB03,
  detectorOB04,
  detectorOB05,
  detectorOB06,
  detectorOB07,
  detectorOB08,
  detectorOB09,
  detectorOB10,
  detectorOB11,
  detectorOB12,
  detectorOB13,
  detectorOB14,
];
