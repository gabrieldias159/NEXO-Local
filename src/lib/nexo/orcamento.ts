/**
 * EXECUÇÃO ORÇAMENTÁRIA — normalização da visão `DespesaSintetica` do SMARAPD
 * (coleção `nexo_despesa_sintetica`).
 *
 * Cada doc é um snapshot MENSAL de uma RUBRICA (linha de dotação: classificação
 * funcional × natureza da despesa × fonte de recurso × unidade orçamentária),
 * com os acumulados "AteMes". Para o estado atual do exercício, pega-se o MAIOR
 * `mes` por rubrica (ver `consolidarPorRubrica`).
 *
 * Campos-chave da fonte:
 *  • DotacaoInicial    → orçamento previsto inicial (LOA).
 *  • DotacaoAutorizada → dotação ATUALIZADA (inicial + créditos/emendas). A
 *    diferença (autorizada − inicial) é o IMPACTO das movimentações orçamentárias.
 *  • EmpenhadoAteMes / PagoAteMes → execução acumulada.
 *  • % execução = empenhado / dotacaoAutorizada; ESTOURO quando empenhado > autorizada.
 */
import { parseValorBR } from './normalizar';

export interface ExecucaoRubrica {
  /** Chave da rubrica (classificação funcional + natureza + fonte + UO). */
  id: string;
  classificacaoFuncional: string;
  descricaoClassificacao: string;
  funcaoCodigo: string;
  funcao: string;
  unidadeOrcamentaria: string;
  descricaoUnidadeOrcamentaria: string;
  /**
   * ÓRGÃO (poder/entidade) — código de 2 dígitos derivado da `UnidadeOrcamentaria`
   * (formato `XX.YY.ZZ`): `01` = Câmara, `02` = Prefeitura. As unidades filhas
   * (`01.01.00` Corpo Legislativo, `01.02.00` Corpo Administrativo, …) precisam
   * ser CONSOLIDADAS sob o órgão pai `XX` para o agrupamento por órgão refletir
   * o orçamento total da entidade (ex.: a Câmara inteira ~R$40,2M, não só os
   * R$4M do Corpo Legislativo).
   */
  orgaoCodigo: string;
  /** Nome do órgão (vem da `UnidadeGestora`: "CÂMARA MUNICIPAL …" / "PREFEITURA …"). */
  orgaoNome: string;
  unidadeGestora: string;
  naturezaDespesa: string;
  descricaoNaturezaDespesa: string;
  fonteRecurso: string;
  descricaoFonteRecurso: string;
  mes: number;
  dotacaoInicial: number;
  dotacaoAutorizada: number;
  empenhado: number;
  /** Liquidado acumulado ≈ pago + liquidado-a-pagar (a fonte não traz "AteMes"). */
  liquidado: number;
  pago: number;
  /**
   * ISO da coleta (`_coletadoEm`). A fonte re-serve a MESMA rubrica×mês com
   * valores atualizados e o ID por hash de conteúdo preserva as duas versões —
   * este campo desempata: vale sempre a coleta mais recente.
   */
  coletadoEm: string;
}

function pick(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Normaliza UMA linha (rubrica × mês) da DespesaSintetica. */
export function normalizarExecucaoSintetica(brutos: Record<string, unknown>[]): ExecucaoRubrica[] {
  return brutos.map((rec) => {
    const classificacaoFuncional = pick(rec, 'ClassificacaoFuncional');
    const naturezaDespesa = pick(rec, 'NaturezaDespesa');
    const fonteRecurso = pick(rec, 'FonteRecurso');
    const unidadeOrcamentaria = pick(rec, 'UnidadeOrcamentaria');
    const unidadeGestora = pick(rec, 'UnidadeGestora');
    // Órgão = 2 primeiros dígitos da UO (XX.YY.ZZ). Fallback p/ UO inteira se não casar.
    const orgaoCodigo = (unidadeOrcamentaria.match(/^\s*(\d{2})/)?.[1]) ?? unidadeOrcamentaria;
    const pago = parseValorBR(pick(rec, 'PagoAteMes'));
    const liquidadoAPagar = parseValorBR(pick(rec, 'LiquidadoaPagar'));
    return {
      id: [classificacaoFuncional, naturezaDespesa, fonteRecurso, unidadeOrcamentaria].join('|'),
      classificacaoFuncional,
      descricaoClassificacao: pick(rec, 'DescricaoClassificacaoFuncional'),
      funcaoCodigo: pick(rec, 'Funcao'),
      funcao: pick(rec, 'DescricaoFuncao'),
      unidadeOrcamentaria,
      descricaoUnidadeOrcamentaria: pick(rec, 'DescricaoUnidadeOrcamentaria'),
      orgaoCodigo,
      orgaoNome: unidadeGestora,
      unidadeGestora,
      naturezaDespesa,
      descricaoNaturezaDespesa: pick(rec, 'DescricaoNaturezaDespesa'),
      fonteRecurso,
      descricaoFonteRecurso: pick(rec, 'DescricaoFonteRecurso'),
      mes: Number(pick(rec, 'Mes')) || 0,
      dotacaoInicial: parseValorBR(pick(rec, 'DotacaoInicial')),
      dotacaoAutorizada: parseValorBR(pick(rec, 'DotacaoAutorizada')),
      empenhado: parseValorBR(pick(rec, 'EmpenhadoAteMes')),
      liquidado: pago + liquidadoAPagar,
      pago,
      coletadoEm: pick(rec, '_coletadoEm'),
    };
  });
}

/**
 * Dedup de versões: por rubrica×mês, mantém só a linha da COLETA mais recente.
 * A fonte re-serve a mesma rubrica×mês com valores corrigidos; sem este passo,
 * somas mensais contam as duas versões e inflam o total (visto em Abr/2026:
 * 2.161 linhas p/ 1.061 rubricas → soma 2x maior que o real).
 */
export function dedupPorRubricaMes(linhas: ExecucaoRubrica[]): ExecucaoRubrica[] {
  const porChave = new Map<string, ExecucaoRubrica>();
  for (const l of linhas) {
    const k = `${l.id}|${l.mes}`;
    const atual = porChave.get(k);
    if (!atual || l.coletadoEm > atual.coletadoEm) porChave.set(k, l);
  }
  return [...porChave.values()];
}

/**
 * Consolida as linhas mensais para o ESTADO ATUAL: por rubrica (`id`), mantém o
 * snapshot do MAIOR mês (os campos "AteMes" são acumulados, então o último mês
 * representa o exercício até a coleta).
 */
export function consolidarPorRubrica(linhas: ExecucaoRubrica[]): ExecucaoRubrica[] {
  const porId = new Map<string, ExecucaoRubrica>();
  for (const l of linhas) {
    const atual = porId.get(l.id);
    // Maior mês vence; empate de mês (versões recoletadas) → coleta mais recente.
    if (!atual || l.mes > atual.mes || (l.mes === atual.mes && l.coletadoEm > atual.coletadoEm)) {
      porId.set(l.id, l);
    }
  }
  return [...porId.values()];
}

/** % de execução (empenhado / dotação autorizada), 0 se sem dotação. */
export function pctExecucao(r: { empenhado: number; dotacaoAutorizada: number }): number {
  if (r.dotacaoAutorizada <= 0) return r.empenhado > 0 ? 999 : 0;
  return (r.empenhado / r.dotacaoAutorizada) * 100;
}
