/**
 * Detectores de monitoramentos antes PLANEJADOS, agora COMPUTÁVEIS sobre os
 * dados que o `ContextoAnalise` já carrega (empenhos, despesas, restos a pagar).
 *
 * Auditoria das 14 áreas (src/lib/nexo/catalogo-completo.ts): os blocos `*-cat.ts`
 * já materializam os 172 monitoramentos; os 66 `planejado` retornavam `[]`
 * honestamente por dependerem de fonte ausente do contexto. Reavaliando item a
 * item contra o que o contexto REALMENTE traz, há monitoramentos cuja regra do
 * catálogo é, no plano da EXECUÇÃO orçamentária, aproximável por uma proxy
 * defensável já presente em `DespesaAgrupada` — a MESMA família de proxy aceita
 * em OR-06 (suplementações ⇒ reforços por dotação) e OR-09 (reforços por
 * empenho). Este arquivo implementa essas conversões, sem inventar dado:
 *
 *   OB-11 — Aditivos de obra em cadeia.
 *   EM-06 — Aditivo emergencial sucessivo.
 *
 * Os stubs homônimos em `obras-cat.ts` / `emergenciais-diarias-cat.ts`
 * continuam retornando `[]` (degradação honesta); estes detectores produzem o
 * indício real. IDs duplicados no registry são seguros: o stub vazio nada soma.
 *
 * REGRA DE LINGUAGEM: todo alerta é INDÍCIO a apurar — nunca acusação. Limiares
 * conservadores; degrada para `[]` quando a fonte (despesas) está ausente.
 * Ver docs/nexo-plano-mestre.md §6–§7. Apenas dados públicos.
 *
 * LGPD: opera sobre CNPJ de fornecedor (pessoa jurídica) e classificação
 * orçamentária; não toca CPF, sócio ou doação. Sem Lei 8.429/improbidade.
 */
import { formatBRL, type DespesaNorm } from '../normalizar';
import { ehEntidadePublica } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

const CAT_OB = 'Obras públicas';
const CAT_EM = 'Contratos emergenciais';

/** Reconhece obra/serviço de engenharia pelo objeto ou elemento. Conservador. */
const RE_OBRA =
  /\bobra(s)?\b|pavimenta|recape|recapea|tapa[-\s]?buraco|constru[çc]|edifica|engenharia|reforma|amplia[çc]|drenagem|terraplen|asfalt|gale ?ria|ponte|via[ -]?dut|cal[çc]ament|guia(s)? e sarjeta|sarjeta|infraestrutura via/i;

/** Reforma (limite de aditivo de 50%, art. 125) — subconjunto de RE_OBRA. */
const RE_REFORMA = /reforma|reabilita[çc]|restaura[çc]|adequa[çc][ãa]o predial|amplia[çc]/i;

/** Modalidade/objeto de contratação emergencial (art. 75 VIII / 24 IV). */
const RE_EMERGENCIAL =
  /emerg[êe]nci|calamidad|art\.?\s*75[^0-9]*viii|inciso\s*viii|24[^0-9]*iv/i;

/** true quando a despesa é um REFORÇO de empenho (acréscimo orçamentário). */
function ehReforco(d: DespesaNorm): boolean {
  return /REFOR/i.test(d.tipoEmpenho);
}
/** true quando a despesa é um EMPENHO original (não reforço, não anulação). */
function ehEmpenhoOriginal(d: DespesaNorm): boolean {
  return !/REFOR|ANUL/i.test(d.tipoEmpenho);
}
/** Número de empenho aproveitável (tem dígito). */
function temNumero(n: string): boolean {
  return /\d/.test((n || '').trim());
}
/** Chave de contrato/empenho — colapsa parcela após "/" (ex.: 123/2026 → 123). */
function chaveContrato(numero: string): string {
  return (numero || '').trim().replace(/\/.*/, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// OB-11 — Aditivos de obra em cadeia  [COMPUTÁVEL por proxy — RODA]
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: ≥3 aditivos no mesmo contrato de obra OU Σ aditivos > 25%
 * do valor original (50% para reforma). Lei 14.133/2021 art. 125.
 *
 * PROXY DECLARADA (mesma família de OR-06/OR-09): o cadastro de ADITIVOS
 * contratuais não está no `ContextoAnalise`, mas o módulo `DespesaAgrupada` traz
 * o tipo de empenho ("Reforço") e o número do empenho. No plano da execução, o
 * reforço de empenho é o acréscimo orçamentário que normalmente ACOMPANHA um
 * aditivo de valor; uma CADEIA de reforços sobre o empenho de uma OBRA é o
 * sintoma orçamentário do que a regra busca. Diferencia-se do OR-09 (genérico,
 * por empenho) por (a) restringir a fornecedores/empenhos de OBRA e (b) medir a
 * elevação ACUMULADA contra o empenho original do mesmo contrato, aplicando o
 * teto do art. 125 (25%, ou 50% para reforma) — exatamente a regra de OB-11.
 *
 * Conservador: exige empenho original positivo identificável e reforços do mesmo
 * contrato; só dispara quando ≥3 reforços OU a elevação acumulada cruza o teto.
 */
const detectorAditivosObraCadeia: Detector = {
  id: 'OB-11',
  nome: 'Aditivos de obra em cadeia',
  categoria: CAT_OB,
  detectar(ctx) {
    const despesas = ctx.despesas ?? [];
    if (despesas.length === 0) return [];

    // Recorte de obra: despesas cujo objeto/elemento indicam engenharia, com
    // CNPJ de fornecedor privado (ente público não é "fornecedor" de obra).
    const obras = despesas.filter(
      (d) =>
        RE_OBRA.test(d.objeto) || RE_OBRA.test(d.elemento)
          ? d.cpfCnpj && !ehEntidadePublica(d.cpfCnpj, d.fornecedorNome)
          : false,
    );
    if (obras.length === 0) return [];

    // Agrupa por contrato-proxy = número do empenho (sem a parcela após "/").
    const porContrato = new Map<string, DespesaNorm[]>();
    for (const d of obras) {
      if (!temNumero(d.numeroEmpenho)) continue;
      const chave = chaveContrato(d.numeroEmpenho);
      const arr = porContrato.get(chave) ?? [];
      arr.push(d);
      porContrato.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porContrato) {
      const reforcos = lista.filter(ehReforco);
      if (reforcos.length === 0) continue;

      const original = lista
        .filter(ehEmpenhoOriginal)
        .reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
      const somaReforcos = reforcos.reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
      // Sem empenho original positivo do mesmo contrato não há base para a razão.
      if (original <= 0) continue;

      const razao = somaReforcos / original;
      const ehReformaContrato = lista.some(
        (d) => RE_REFORMA.test(d.objeto) || RE_REFORMA.test(d.elemento),
      );
      const teto = ehReformaContrato ? 0.5 : 0.25; // art. 125
      const cruzaTeto = razao > teto;
      const muitosReforcos = reforcos.length >= 3;
      // Regra do catálogo: ≥3 aditivos OU Σ aditivos > teto do original.
      if (!cruzaTeto && !muitosReforcos) continue;

      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || lista[0].cpfCnpj;
      const objeto = lista.find((d) => d.objeto)?.objeto || 'Obra';
      const pct = Math.round(razao * 100);
      out.push({
        detectorId: 'OB-11',
        detectorNome: 'Aditivos de obra em cadeia',
        categoria: CAT_OB,
        titulo: `Reforços sucessivos em empenho de obra — ${nome}`,
        descricao:
          `${reforcos.length} reforço(s) de empenho no contrato-proxy "${chave}" ` +
          `(${objeto}), somando ${formatBRL(somaReforcos)} sobre um empenho original de ` +
          `${formatBRL(original)} (+${pct}%${cruzaTeto ? `, acima do teto de ${Math.round(teto * 100)}%` : ''}). ` +
          `Possível indício a apurar de aditivos de obra em cadeia.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj,
        sujeitoRotulo: nome,
        classificacao: cruzaTeto && muitosReforcos ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 48,
          probabilidadeIrregularidade: Math.min(
            66,
            30 + reforcos.length * 5 + (cruzaTeto ? 12 : 0),
          ),
          probabilidadeEnquadramento: 55,
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 125'],
        evidencias: [
          { resumo: `Empenho original do contrato: ${formatBRL(original)}`, valor: original },
          { resumo: `Soma dos reforços: ${formatBRL(somaReforcos)} (+${pct}%)`, valor: somaReforcos },
          ...reforcos.slice(0, 6).map((d) => ({
            resumo: `Reforço — empenho ${d.numeroEmpenho || d.id} — ${formatBRL(Math.abs(d.valorEmpenhado))}`,
            valor: Math.abs(d.valorEmpenhado),
            data: d.data,
            ref: d.id,
          })),
        ],
        explicacao:
          'Os aditivos a contrato de obra têm teto legal: 25% do valor original ' +
          '(50% para reforma) — art. 125 da Lei 14.133/2021. Uma cadeia de ' +
          'aditivos, ou aditivos que cruzam o teto, é possível indício de projeto ' +
          'deficiente ou de elevação indevida do contrato, a apurar. PROXY ' +
          'DECLARADA: o cadastro de aditivos não está no contexto — usa-se o ' +
          'REFORÇO de empenho do módulo DespesaAgrupada como sinal orçamentário ' +
          'do aditivo de valor, agrupado por número de empenho (contrato-proxy) e ' +
          'medido contra o empenho original. A confirmação exige o histórico de ' +
          'aditivos do contrato (PNCP/portal); o reforço também pode refletir ' +
          'apenas reajuste ou recomposição legítima.',
        valorEnvolvido: somaReforcos,
        discriminador: chave,
      });
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// EM-06 — Aditivo emergencial sucessivo  [COMPUTÁVEL por proxy — RODA]
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: aditivo de prazo em contrato emergencial cuja vigência
 * total ultrapassa o prazo excepcional (em regra 1 ano) — art. 75 VIII da Lei
 * 14.133/2021. A emergência admite contratação por prazo curto e improrrogável;
 * sucessão de aditivos descaracteriza o regime excepcional.
 *
 * PROXY DECLARADA (família OR-06/OR-09): a vigência contratual e os aditivos de
 * PRAZO não estão no contexto. O que É computável é o lado do VALOR: reforços
 * sucessivos de empenho sobre uma contratação EMERGENCIAL — o acréscimo
 * orçamentário que acompanha a prorrogação/ampliação de um contrato que deveria
 * ser pontual. Diferencia-se de OR-09 por restringir a despesas emergenciais e
 * por agrupar por contrato-proxy. NÃO afirma a extensão da vigência (ausente do
 * contexto); sinaliza o reforço de emergencial como indício a apurar.
 *
 * Conservador: exige empenho emergencial original positivo + ≥2 reforços do
 * mesmo contrato (sucessão), ou um reforço acumulado > 25% do original.
 */
const detectorAditivoEmergencialSucessivo: Detector = {
  id: 'EM-06',
  nome: 'Aditivo emergencial sucessivo',
  categoria: CAT_EM,
  detectar(ctx) {
    const despesas = ctx.despesas ?? [];
    if (despesas.length === 0) return [];

    // Recorte emergencial: contratações fundadas em emergência/calamidade.
    const emergenciais = despesas.filter(
      (d) =>
        (RE_EMERGENCIAL.test(d.modalidadeCodigo) || RE_EMERGENCIAL.test(d.objeto)) &&
        d.cpfCnpj &&
        !ehEntidadePublica(d.cpfCnpj, d.fornecedorNome),
    );
    if (emergenciais.length === 0) return [];

    const porContrato = new Map<string, DespesaNorm[]>();
    for (const d of emergenciais) {
      if (!temNumero(d.numeroEmpenho)) continue;
      const chave = chaveContrato(d.numeroEmpenho);
      const arr = porContrato.get(chave) ?? [];
      arr.push(d);
      porContrato.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porContrato) {
      const reforcos = lista.filter(ehReforco);
      const original = lista
        .filter(ehEmpenhoOriginal)
        .reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
      if (original <= 0 || reforcos.length === 0) continue;

      const somaReforcos = reforcos.reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
      const razao = somaReforcos / original;
      const sucessao = reforcos.length >= 2; // aditivos SUCESSIVOS
      const cruzaTeto = razao > 0.25;
      if (!sucessao && !cruzaTeto) continue;

      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || lista[0].cpfCnpj;
      const objeto = lista.find((d) => d.objeto)?.objeto || 'Contrato emergencial';
      const pct = Math.round(razao * 100);
      out.push({
        detectorId: 'EM-06',
        detectorNome: 'Aditivo emergencial sucessivo',
        categoria: CAT_EM,
        titulo: `Reforços sucessivos em contratação emergencial — ${nome}`,
        descricao:
          `${reforcos.length} reforço(s) de empenho sobre a contratação emergencial ` +
          `"${chave}" (${objeto}), somando ${formatBRL(somaReforcos)} sobre um empenho ` +
          `original de ${formatBRL(original)} (+${pct}%). Possível indício a apurar de ` +
          `prorrogação/ampliação sucessiva de contrato que deveria ser pontual.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj,
        sujeitoRotulo: nome,
        classificacao: sucessao && cruzaTeto ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 46,
          probabilidadeIrregularidade: Math.min(
            64,
            32 + reforcos.length * 6 + (cruzaTeto ? 10 : 0),
          ),
          probabilidadeEnquadramento: 52,
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 75 VIII'],
        evidencias: [
          { resumo: `Empenho emergencial original: ${formatBRL(original)}`, valor: original },
          { resumo: `Soma dos reforços: ${formatBRL(somaReforcos)} (+${pct}%)`, valor: somaReforcos },
          ...reforcos.slice(0, 6).map((d) => ({
            resumo: `Reforço — empenho ${d.numeroEmpenho || d.id} — ${formatBRL(Math.abs(d.valorEmpenhado))}`,
            valor: Math.abs(d.valorEmpenhado),
            data: d.data,
            ref: d.id,
          })),
        ],
        explicacao:
          'A contratação emergencial (art. 75 VIII da Lei 14.133/2021) é para fato ' +
          'imprevisível e tem prazo curto e improrrogável; prorrogá-la ou ampliá-la ' +
          'sucessivamente descaracteriza o regime excepcional. PROXY DECLARADA: a ' +
          'vigência contratual e os aditivos de PRAZO não estão no contexto — ' +
          'usa-se o REFORÇO de empenho sobre a contratação emergencial como sinal ' +
          'orçamentário do acréscimo que acompanha a prorrogação. NÃO se afirma a ' +
          'extensão da vigência; a confirmação exige os aditivos do contrato ' +
          '(PNCP/portal). O reforço pode também refletir ajuste pontual legítimo.',
        valorEnvolvido: somaReforcos,
        discriminador: chave,
      });
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

/**
 * Detectores de monitoramentos planejados agora computáveis sobre `despesas`
 * (proxy de reforço/aditivo, família OR-06/OR-09). Os stubs homônimos nos
 * blocos `*-cat.ts` permanecem retornando `[]` — IDs duplicados são seguros.
 */
export const DETECTORES_PLANEJADOS_EXTRA: Detector[] = [
  detectorAditivosObraCadeia, // OB-11 — roda sobre despesas (reforços/contrato-proxy de obra)
  detectorAditivoEmergencialSucessivo, // EM-06 — roda sobre despesas (reforços em emergencial)
];
