/**
 * Detectores adicionais de Execução Orçamentária (área OR do catálogo).
 *
 * Implementam as regras computáveis do catálogo-mestre que ainda não tinham
 * lógica, todos sobre os módulos `DespesaAgrupada` (com objeto, elemento e
 * tipo de empenho) e `fornecedor` (empenho analítico).
 *
 *  OR-01 — Pagamento sem empenho prévio (pagamento sem NroEmpenho válido).
 *  OR-02 — Liquidação sem empenho (liquidação/pagamento sem empenho vinculado).
 *  OR-04 — Quebra da ordem cronológica de pagamento.
 *  OR-05 — Dotação executada acima de 100% (proxy via tipo de empenho).
 *  OR-10 — Despesa em elemento incompatível com o objeto.
 *
 * Linguagem: indício a apurar — nunca acusação. Ver docs/nexo-plano-mestre.md.
 */
import { formatBRL, type DespesaNorm } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

/** Soma absoluta de uma lista de despesas. */
function somaAbs(lista: DespesaNorm[]): number {
  return lista.reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
}

/** Número de empenho parece válido quando tem ao menos um dígito. */
function temNumeroEmpenho(numero: string): boolean {
  return /\d/.test(numero.trim());
}

// ── OR-01 — Pagamento sem empenho prévio ─────────────────────────────────────
/**
 * Lei 4.320/1964 art. 60: é vedada a realização de despesa sem prévio empenho.
 * Sinaliza despesas com valor pago > 0 cujo registro não traz número de
 * empenho identificável. Conservador: só conta o que tem pagamento efetivo.
 */
export const detectorPagamentoSemEmpenho: Detector = {
  id: 'OR-01',
  nome: 'Pagamento sem empenho prévio',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    const semEmpenho = ctx.despesas.filter(
      (d) => d.valorPago > 0 && !temNumeroEmpenho(d.numeroEmpenho),
    );
    if (semEmpenho.length === 0) return [];

    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of semEmpenho) {
      const chave = d.cpfCnpj || `sem-cnpj`;
      const arr = porCnpj.get(chave) ?? [];
      arr.push(d);
      porCnpj.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porCnpj) {
      const somaPaga = lista.reduce((s, d) => s + d.valorPago, 0);
      if (somaPaga <= 0) continue;
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || chave;
      out.push({
        detectorId: 'OR-01',
        detectorNome: 'Pagamento sem empenho prévio',
        categoria: 'Execução orçamentária',
        titulo: `Possível pagamento sem empenho prévio — ${nome}`,
        descricao:
          `${lista.length} registro(s) de despesa com pagamento (${formatBRL(somaPaga)}) ` +
          `sem número de empenho identificável. Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj || 'sem-cnpj',
        sujeitoRotulo: nome,
        classificacao: somaPaga > 100_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 58,
          probabilidadeIrregularidade: Math.min(74, 38 + lista.length * 5),
        },
        fundamentoLegal: ['Lei 4.320/1964 art. 60'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Despesa ${d.id} — ${formatBRL(d.valorPago)}${d.objeto ? ` (${d.objeto})` : ''}`,
          valor: d.valorPago,
          data: d.data,
        })),
        explicacao:
          'O empenho deve preceder a despesa (Lei 4.320/1964 art. 60). Pagamentos ' +
          'sem número de empenho identificável são possível indício de quebra dessa ' +
          'etapa a apurar — pode também ser lacuna de dados do portal, o que deve ' +
          'ser verificado antes de qualquer conclusão.',
        valorEnvolvido: somaPaga,
      });
    }
    return out;
  },
};

// ── OR-02 — Liquidação sem empenho ───────────────────────────────────────────
/**
 * Lei 4.320/1964 art. 63: a liquidação tem por base o contrato, a nota de
 * empenho e os comprovantes de entrega. O `ContextoAnalise` não traz o número
 * de liquidação no módulo de despesas, mas o empenho analítico (`empenhos`)
 * traz o flag `temLiquidacao`. Aqui usamos a proxy mais correta possível:
 * registros com liquidação e/ou pagamento efetivado cujo empenho de origem
 * não é identificável.
 */
export const detectorLiquidacaoSemEmpenho: Detector = {
  id: 'OR-02',
  nome: 'Liquidação sem empenho',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    // Empenhos analíticos com liquidação registrada mas sem número de empenho.
    const suspeitos = ctx.empenhos.filter(
      (e) => e.temLiquidacao && !temNumeroEmpenho(e.numeroEmpenho) && e.valorPago > 0,
    );
    if (suspeitos.length === 0) return [];

    const porCnpj = new Map<string, typeof suspeitos>();
    for (const e of suspeitos) {
      const chave = e.cpfCnpj || 'sem-cnpj';
      const arr = porCnpj.get(chave) ?? [];
      arr.push(e);
      porCnpj.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porCnpj) {
      const soma = lista.reduce((s, e) => s + e.valorPago, 0);
      if (soma <= 0) continue;
      const nome = lista.find((e) => e.fornecedorNome)?.fornecedorNome || chave;
      out.push({
        detectorId: 'OR-02',
        detectorNome: 'Liquidação sem empenho',
        categoria: 'Execução orçamentária',
        titulo: `Possível liquidação sem empenho vinculado — ${nome}`,
        descricao:
          `${lista.length} registro(s) com liquidação/pagamento (${formatBRL(soma)}) ` +
          `sem número de empenho vinculado. Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj || 'sem-cnpj',
        sujeitoRotulo: nome,
        classificacao: soma > 100_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 56,
          probabilidadeIrregularidade: Math.min(70, 36 + lista.length * 5),
        },
        fundamentoLegal: ['Lei 4.320/1964 art. 63'],
        evidencias: lista.slice(0, 8).map((e) => ({
          resumo: `Liquidação ${e.id} — ${formatBRL(e.valorPago)}`,
          valor: e.valorPago,
          data: e.data,
        })),
        explicacao:
          'A liquidação tem por base a nota de empenho (Lei 4.320/1964 art. 63). ' +
          'Liquidações sem empenho vinculado são possível indício de quebra de ' +
          'etapa a apurar — verifique se não é apenas ausência do vínculo no portal.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ── OR-04 — Quebra da ordem cronológica de pagamento ─────────────────────────
/**
 * Lei 14.133/2021 art. 141: a Administração deve observar a ordem cronológica
 * de pagamento por fonte. O `ContextoAnalise` não traz a data de pagamento nem
 * a fonte de recurso, apenas a data do empenho. Usamos a proxy mais correta
 * possível: dentro da mesma unidade gestora, fornecedores com empenho liquidado
 * (`temLiquidacao`) e pago integralmente enquanto outro fornecedor da MESMA UG,
 * com empenho mais antigo e também liquidado, segue sem pagamento.
 *
 * É um indício fraco por natureza (falta data e fonte de pagamento) — por isso
 * a confiabilidade é baixa e só sinaliza casos com diferença de data relevante.
 */
export const detectorOrdemCronologica: Detector = {
  id: 'OR-04',
  nome: 'Quebra da ordem cronológica de pagamento',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    // Agrupa empenhos liquidáveis por unidade gestora.
    const porUg = new Map<string, typeof ctx.empenhos>();
    for (const e of ctx.empenhos) {
      if (!e.unidadeGestora || !e.data || e.valorEmpenhado <= 0) continue;
      const arr = porUg.get(e.unidadeGestora) ?? [];
      arr.push(e);
      porUg.set(e.unidadeGestora, arr);
    }

    for (const [ug, lista] of porUg) {
      if (lista.length < 10) continue;
      // Pagos = empenho com pagamento efetivo. Pendentes = liquidado sem pagar.
      const pagos = lista.filter((e) => e.valorPago > 0 && e.data);
      const pendentes = lista.filter(
        (e) => e.temLiquidacao && e.valorPago <= 0 && e.data,
      );
      if (pagos.length === 0 || pendentes.length === 0) continue;

      // Pendente mais antigo (já liquidado, deveria estar na fila à frente).
      const pendenteAntigo = pendentes.reduce((a, b) => (a.data! < b.data! ? a : b));
      // Pagos cuja despesa foi empenhada DEPOIS do pendente mais antigo.
      const furaFila = pagos.filter((e) => e.data! > pendenteAntigo.data!);
      if (furaFila.length < 3) continue;

      const somaFura = furaFila.reduce((s, e) => s + e.valorPago, 0);
      const somaPendente = pendentes.reduce((s, e) => s + e.valorEmpenhado, 0);
      out.push({
        detectorId: 'OR-04',
        detectorNome: 'Quebra da ordem cronológica de pagamento',
        categoria: 'Execução orçamentária',
        titulo: `Possível quebra de ordem cronológica de pagamento — ${ug}`,
        descricao:
          `Na ${ug}, ${furaFila.length} empenho(s) mais recentes foram pagos ` +
          `(${formatBRL(somaFura)}) enquanto empenhos liquidados mais antigos ` +
          `seguem sem pagamento (${formatBRL(somaPendente)}). Possível indício a apurar.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `ordem-cronologica-${ug}`,
        sujeitoRotulo: ug,
        classificacao: furaFila.length >= 8 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 46,
          probabilidadeIrregularidade: Math.min(60, 30 + furaFila.length * 3),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 141', 'LC 131/2009'],
        evidencias: [
          {
            resumo: `Empenho liquidado mais antigo sem pagamento: ${pendenteAntigo.numeroEmpenho || pendenteAntigo.id}`,
            data: pendenteAntigo.data,
            valor: pendenteAntigo.valorEmpenhado,
          },
          ...furaFila.slice(0, 6).map((e) => ({
            resumo: `Pago à frente da fila — empenho ${e.numeroEmpenho || e.id}`,
            valor: e.valorPago,
            data: e.data,
          })),
        ],
        explicacao:
          'A ordem cronológica de pagamento por fonte é exigência legal (Lei ' +
          '14.133/2021 art. 141). Empenhos recentes pagos enquanto empenhos ' +
          'liquidados mais antigos da mesma unidade seguem em aberto são possível ' +
          'indício a apurar. ATENÇÃO: a fonte não traz data de pagamento nem fonte ' +
          'de recurso — usa-se a data de empenho como proxy, então o resultado deve ' +
          'ser confirmado contra a ordem cronológica oficial por fonte.',
        valorEnvolvido: somaFura,
      });
    }
    return out;
  },
};

// ── OR-05 — Dotação executada acima de 100% ──────────────────────────────────
/**
 * Lei 4.320/1964 art. 59: o empenho não pode exceder o limite dos créditos
 * concedidos. O `ContextoAnalise` NÃO traz a dotação orçada por dotação/elemento
 * — sem isso não há como medir `empenhado/dotação`. A proxy mais correta
 * disponível é: empenhos cujo valor de REFORÇO acumulado supera o valor do
 * empenho original — ou seja, a despesa foi executada bem acima do que foi
 * originalmente dotado para aquele empenho, sem que o reforço fosse modesto.
 *
 * Dependência de dado faltante: a dotação orçamentária autorizada por
 * classificação (LOA + créditos adicionais). Enquanto não disponível, este
 * detector usa o reforço acumulado vs. empenho original como melhor proxy.
 */
export const detectorDotacaoAcima100: Detector = {
  id: 'OR-05',
  nome: 'Dotação executada acima de 100%',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    // Agrupa por número de empenho: identifica empenho original vs. reforços.
    const porEmpenho = new Map<string, DespesaNorm[]>();
    for (const d of ctx.despesas) {
      if (!d.numeroEmpenho) continue;
      const arr = porEmpenho.get(d.numeroEmpenho) ?? [];
      arr.push(d);
      porEmpenho.set(d.numeroEmpenho, arr);
    }

    for (const [numero, lista] of porEmpenho) {
      const originais = lista.filter(
        (d) => !/REFOR/i.test(d.tipoEmpenho) && !/ANUL/i.test(d.tipoEmpenho),
      );
      const reforcos = lista.filter((d) => /REFOR/i.test(d.tipoEmpenho));
      if (reforcos.length === 0) continue;
      const valorOriginal = somaAbs(originais);
      const valorReforco = reforcos.reduce((s, d) => s + d.valorEmpenhado, 0);
      if (valorOriginal <= 0) continue;
      // Execução acima de 100% do valor originalmente empenhado: reforço > 100%.
      const fator = (valorOriginal + valorReforco) / valorOriginal;
      if (fator <= 2) continue; // reforço somou mais que o dobro do original

      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || '';
      const total = valorOriginal + valorReforco;
      out.push({
        detectorId: 'OR-05',
        detectorNome: 'Dotação executada acima de 100%',
        categoria: 'Execução orçamentária',
        titulo: `Empenho ${numero} executado a ${Math.round(fator * 100)}% do valor original`,
        descricao:
          `O empenho ${numero}${nome ? ` (${nome})` : ''} foi reforçado em ` +
          `${formatBRL(valorReforco)} sobre ${formatBRL(valorOriginal)} originais ` +
          `(execução ${Math.round(fator * 100)}% do dotado inicialmente). ` +
          `Possível indício a apurar.`,
        sujeitoTipo: 'empenho',
        sujeitoId: numero,
        sujeitoRotulo: `Empenho ${numero}`,
        classificacao: fator >= 3 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 52,
          probabilidadeIrregularidade: Math.min(68, 30 + Math.round(fator * 8)),
        },
        fundamentoLegal: ['Lei 4.320/1964 art. 59', 'LRF'],
        evidencias: [
          { resumo: `Empenho original: ${formatBRL(valorOriginal)}`, valor: valorOriginal },
          { resumo: `Reforços acumulados: ${formatBRL(valorReforco)}`, valor: valorReforco },
        ],
        explicacao:
          'Execução muito acima do valor originalmente dotado para um empenho é ' +
          'possível indício de subdimensionamento da dotação ou de despesa sem ' +
          'crédito adicional suficiente, a apurar (Lei 4.320/1964 art. 59). ' +
          'DEPENDÊNCIA: a verificação exata de dotação > 100% exige a dotação ' +
          'orçamentária autorizada por classificação (LOA + créditos), que não ' +
          'está no contexto — usa-se o reforço acumulado vs. empenho original como proxy.',
        valorEnvolvido: total,
      });
    }
    return out;
  },
};

// ── OR-10 — Despesa em elemento incompatível ─────────────────────────────────
/**
 * Lei 4.320/1964 art. 12–13: a despesa deve ser classificada no elemento
 * correspondente à sua natureza. Sinaliza casos em que a descrição do objeto
 * aponta claramente para uma natureza de despesa diferente do elemento
 * declarado (ex.: objeto "obra/pavimentação" classificado em elemento de
 * "material de consumo" ou "diárias").
 *
 * Conservador: só dispara em incompatibilidades textuais inequívocas.
 */
const REGRAS_ELEMENTO: ReadonlyArray<{
  /** Termo no objeto que caracteriza uma natureza. */
  objeto: RegExp;
  /** Elementos coerentes com aquela natureza. */
  elementoEsperado: RegExp;
  natureza: string;
}> = [
  {
    objeto: /\bobra|pavimenta|constru[çc]|reforma de pr[eé]dio|edifica/i,
    elementoEsperado: /obra|instala|44|investiment/i,
    natureza: 'obra / serviço de engenharia',
  },
  {
    objeto: /\bdi[áa]ria/i,
    elementoEsperado: /di[áa]ria|14|aux[ií]lio/i,
    natureza: 'diária',
  },
  {
    objeto: /combust[íi]vel|gasolina|diesel|etanol/i,
    elementoEsperado: /combust|consumo|30/i,
    natureza: 'combustível (material de consumo)',
  },
  {
    objeto: /\bsal[áa]rio|vencimento|folha de pagamento|remunera[çc]/i,
    elementoEsperado: /pessoal|vencimento|11|sal[áa]rio/i,
    natureza: 'despesa de pessoal',
  },
];

export const detectorElementoIncompativel: Detector = {
  id: 'OR-10',
  nome: 'Despesa em elemento incompatível',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const incompativeis: { d: DespesaNorm; natureza: string }[] = [];
    for (const d of ctx.despesas) {
      if (!d.objeto || !d.elemento || d.valorEmpenhado <= 0) continue;
      for (const regra of REGRAS_ELEMENTO) {
        if (regra.objeto.test(d.objeto) && !regra.elementoEsperado.test(d.elemento)) {
          incompativeis.push({ d, natureza: regra.natureza });
          break;
        }
      }
    }
    if (incompativeis.length === 0) return [];

    // Agrupa por natureza para um alerta consolidado por tipo de inconsistência.
    const porNatureza = new Map<string, { d: DespesaNorm }[]>();
    for (const it of incompativeis) {
      const arr = porNatureza.get(it.natureza) ?? [];
      arr.push({ d: it.d });
      porNatureza.set(it.natureza, arr);
    }

    for (const [natureza, itens] of porNatureza) {
      const soma = itens.reduce((s, x) => s + Math.abs(x.d.valorEmpenhado), 0);
      out.push({
        detectorId: 'OR-10',
        detectorNome: 'Despesa em elemento incompatível',
        categoria: 'Execução orçamentária',
        titulo: `Possível classificação incompatível — ${natureza}`,
        descricao:
          `${itens.length} despesa(s) descritas como "${natureza}" classificadas em ` +
          `elemento de despesa aparentemente incompatível, somando ${formatBRL(soma)}. ` +
          `Possível indício a apurar.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `elemento-incompativel-${natureza}`,
        sujeitoRotulo: `Classificação de despesa — ${natureza}`,
        classificacao: 'atencao',
        scores: {
          confiabilidade: 54,
          probabilidadeIrregularidade: Math.min(62, 32 + itens.length * 3),
        },
        fundamentoLegal: ['Lei 4.320/1964 art. 12–13'],
        evidencias: itens.slice(0, 8).map((x) => ({
          resumo: `${x.d.objeto} → elemento "${x.d.elemento}" — ${formatBRL(Math.abs(x.d.valorEmpenhado))}`,
          valor: Math.abs(x.d.valorEmpenhado),
          data: x.d.data,
        })),
        explicacao:
          'A despesa deve ser classificada no elemento correspondente à sua ' +
          'natureza (Lei 4.320/1964 art. 12–13). Objeto e elemento aparentemente ' +
          'incompatíveis são possível indício de classificação incorreta a apurar — ' +
          'pode também refletir descrição genérica do campo de objeto.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};
