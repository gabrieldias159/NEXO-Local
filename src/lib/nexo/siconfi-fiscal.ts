/**
 * NEXO — Extração best-effort de indicadores fiscais avançados do SICONFI.
 *
 * Suporta os detectores MF-09, MF-10, MF-12, MF-13 e MF-14 do catálogo §10.
 * O SICONFI publica RREO/RGF como linhas planas com `conta`, `coluna` e
 * `valor`; cada anexo varia de estrutura por exercício. Aqui a extração é
 * conservadora: casa rótulos por regex sobre `conta` + `coluna` e, quando o
 * dado não é localizável, devolve `null` — NUNCA inventa número.
 *
 * Honestidade > cobertura: cada função documenta o que depende de a fonte
 * publicar, e a apuração degrada para `valor: null` quando o dado falta.
 */

/** Lê um campo numérico tolerando string "1.234,56" ou número cru. */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    // Formato BR "1.234.567,89" → remove pontos de milhar, vírgula vira ponto.
    const n = Number(s.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** Texto da `conta`/`cod_conta` de um item SICONFI, em maiúsculas. */
function conta(item: Record<string, unknown>): string {
  return String(item.conta ?? item.cod_conta ?? '').toUpperCase();
}

/** Texto da `coluna` de um item SICONFI, em maiúsculas. */
function coluna(item: Record<string, unknown>): string {
  return String(item.coluna ?? '').toUpperCase();
}

/**
 * Soma os `valor` de todas as linhas cujo `conta` casa TODAS as regexes de
 * conta e cujo `coluna` casa a regex de coluna (se fornecida). Retorna `null`
 * quando NENHUMA linha casou — distinção honesta entre "soma zero" e "dado
 * ausente".
 */
export function somarLinhas(
  items: Record<string, unknown>[],
  contaRegexes: RegExp[],
  colunaRegex?: RegExp,
): number | null {
  let total = 0;
  let achou = false;
  for (const item of items) {
    const c = conta(item);
    if (!contaRegexes.every((r) => r.test(c))) continue;
    if (colunaRegex && !colunaRegex.test(coluna(item))) continue;
    const v = toNum(item.valor);
    if (v == null) continue;
    total += v;
    achou = true;
  }
  return achou ? total : null;
}

/**
 * Devolve o `valor` da PRIMEIRA linha que casa conta + coluna. Para campos
 * que não devem ser somados (ex.: um percentual, uma previsão única).
 */
export function valorLinha(
  items: Record<string, unknown>[],
  contaRegexes: RegExp[],
  colunaRegex?: RegExp,
): number | null {
  for (const item of items) {
    const c = conta(item);
    if (!contaRegexes.every((r) => r.test(c))) continue;
    if (colunaRegex && !colunaRegex.test(coluna(item))) continue;
    const v = toNum(item.valor);
    if (v != null) return v;
  }
  return null;
}

// ── MF-09 / MF-10 — Restos a pagar e disponibilidade de caixa ────────────────

export interface ApuracaoRAP {
  /** RAP inscritos/saldo do exercício (RREO Anexo 07 / RGF Anexo 05). */
  rapInscritos: number | null;
  /** Disponibilidade de caixa líquida (RGF Anexo 05). */
  disponibilidadeCaixa: number | null;
  /** RAP de exercícios anteriores ainda em aberto, quando publicado. */
  rapAnteriores: number | null;
  periodo: string | null;
}

/**
 * MF-09 — extrai RAP inscritos e disponibilidade de caixa do RGF Anexo 05
 * (Demonstrativo da Disponibilidade de Caixa e dos Restos a Pagar) e, como
 * reforço, do RREO Anexo 07 (Restos a Pagar por Poder e Órgão).
 *
 * Dependência de dado: o art. 42 da LRF compara RAP por FONTE de recurso; o
 * SICONFI publica a disponibilidade já consolidada. A apuração aqui é do
 * AGREGADO — suficiente para o indício, não para a auditoria fonte-a-fonte.
 */
export function apurarRestosAPagar(
  rgfItems: Record<string, unknown>[],
  rreoItems: Record<string, unknown>[],
  periodo: string | null,
): ApuracaoRAP {
  // Disponibilidade de caixa líquida — RGF Anexo 05. A coluna costuma vir
  // como "Disponibilidade de Caixa Líquida (Antes da Inscrição...)" ou
  // similar; aceitamos a linha-total "TOTAL DOS RECURSOS".
  const disponibilidadeCaixa = valorLinha(
    rgfItems,
    [/TOTAL.*RECURSOS|TOTAL\b/],
    /DISPONIBILIDADE DE CAIXA L[ÍI]QUIDA/,
  );

  // RAP inscritos no exercício — RGF Anexo 05 (coluna de inscrição) com
  // fallback para o RREO Anexo 07 (saldo de RAP por poder/órgão).
  const rapRGF = valorLinha(
    rgfItems,
    [/TOTAL.*RECURSOS|TOTAL\b/],
    /RESTOS A PAGAR EMPENHADOS E N[ÃA]O LIQUIDADOS|INSCRI/,
  );
  const rapRREO = somarLinhas(
    rreoItems,
    [/TOTAL|RESTOS A PAGAR/],
    /INSCRITOS|SALDO/,
  );
  const rapInscritos = rapRGF ?? rapRREO;

  // RAP de exercícios anteriores — coluna específica do RREO Anexo 07.
  const rapAnteriores = somarLinhas(
    rreoItems,
    [/RESTOS A PAGAR/],
    /EXERC[ÍI]CIOS ANTERIORES|ANTERIOR/,
  );

  return { rapInscritos, disponibilidadeCaixa, rapAnteriores, periodo };
}

// ── MF-14 — Arrecadação realizada vs. prevista ───────────────────────────────

export interface ApuracaoArrecadacao {
  receitaPrevista: number | null;
  receitaRealizada: number | null;
  /** Percentual realizado/previsto (0–N), ou null se faltar um lado. */
  percentual: number | null;
  periodo: string | null;
}

/**
 * MF-14 — extrai receita prevista atualizada × receita realizada do RREO
 * Anexo 01 (Balanço Orçamentário). Usa a linha de "TOTAL DAS RECEITAS".
 *
 * Dependência de dado: o RREO é bimestral acumulado; comparar realizada com
 * previsão ANUAL no 1º–5º bimestre subestima o percentual naturalmente. Por
 * isso o detector só sinaliza com folga e cita o bimestre apurado.
 */
export function apurarArrecadacao(
  rreoItems: Record<string, unknown>[],
  periodo: string | null,
): ApuracaoArrecadacao {
  const receitaPrevista = valorLinha(
    rreoItems,
    [/TOTAL.*RECEITAS|RECEITAS.*TOTAL|RECEITA TOTAL/],
    /PREVIS[ÃA]O ATUALIZADA|PREVIS[ÃA]O INICIAL/,
  );
  const receitaRealizada = valorLinha(
    rreoItems,
    [/TOTAL.*RECEITAS|RECEITAS.*TOTAL|RECEITA TOTAL/],
    /RECEITAS REALIZADAS|REALIZAD/,
  );
  const percentual =
    receitaPrevista != null && receitaRealizada != null && receitaPrevista > 0
      ? (receitaRealizada / receitaPrevista) * 100
      : null;
  return { receitaPrevista, receitaRealizada, percentual, periodo };
}

// ── MF-13 — Investimento social (saúde + educação) ───────────────────────────

/**
 * MF-13 — extrai a despesa LIQUIDADA/EMPENHADA em saúde e educação de um
 * exercício, pela função de governo no RREO Anexo 02 (Despesa por Função).
 *
 * Dependência de dado: o catálogo fala em "investimento social"; o proxy
 * extraível é a despesa nas funções 10 (Saúde) e 12 (Educação). Não é o
 * mesmo conceito de "investimento" (grupo 4 da natureza), mas é o agregado
 * que o SICONFI publica de forma estável — declarado como proxy no alerta.
 */
export function apurarDespesaFuncao(
  rreoItems: Record<string, unknown>[],
  funcaoRegex: RegExp,
): number | null {
  // Despesas liquidadas acumuladas no exercício (coluna do RREO Anexo 02).
  return (
    valorLinha(rreoItems, [funcaoRegex], /DESPESAS LIQUIDADAS|LIQUIDAD/) ??
    valorLinha(rreoItems, [funcaoRegex], /DESPESAS EMPENHADAS|EMPENHAD/)
  );
}

// ── MF-15 — Empenho total acima da RCL do exercício anterior ─────────────────

export interface ApuracaoEmpenhoRCL {
  /**
   * Total empenhado acumulado no exercício atual (RREO Anexo 02, coluna "Até
   * o Bimestre"), exceto Intra-Orçamentárias.
   */
  empenhado: number | null;
  /**
   * Receita Corrente BRUTA arrecadada no exercício anterior (RREO Anexo 01,
   * coluna "Até o Bimestre" do 6º bimestre do ano passado). Usamos a RC bruta
   * como proxy conservador da RCL — a RCL líquida real é ~15–20% menor (após
   * deduções de FUNDEB + RPPS próprio), tornando o percentual ainda mais
   * elevado. Essa limitação é documentada no alerta.
   */
  receitaCorrenteAnterior: number | null;
  /** Percentual empenhado/RC_anterior (pode ultrapassar 100). */
  percentual: number | null;
  anoRCL: number;
  periodo: string | null;
}

/**
 * MF-15 — compara o total empenhado acumulado do exercício atual com a
 * Receita Corrente arrecadada no exercício anterior (proxy conservador da
 * RCL). Extrai do SICONFI:
 *  - Empenhado: RREO Anexo 02 (conta total, exceto intra) do ano atual.
 *  - RC anterior: RREO Anexo 01 ("Até o Bimestre") do ano anterior.
 *
 * Retorna null em qualquer campo não localizável — nunca inventa número.
 */
export function apurarEmpenhoVsRCL(
  rreoItemsAnoAtual: Record<string, unknown>[],
  rreoItemsAnoAnterior: Record<string, unknown>[],
  anoRCL: number,
  periodo: string | null,
): ApuracaoEmpenhoRCL {
  // Total empenhado acumulado — RREO Anexo 02. Tenta cod_conta primeiro.
  const empenhado =
    valorLinha(
      rreoItemsAnoAtual,
      [/RREO2TOTALDESPESAS/],
      /EMPENHADAS ATÉ/,
    ) ??
    valorLinha(
      rreoItemsAnoAtual,
      [/DESPESAS.*EXCETO INTRA/],
      /EMPENHADAS ATÉ/,
    );

  // Receita Corrente arrecadada no exercício anterior — RREO Anexo 01.
  const receitaCorrenteAnterior =
    valorLinha(
      rreoItemsAnoAnterior,
      [/RECEITASCORRENTES/],
      /ATÉ O BIMESTRE/,
    ) ??
    valorLinha(
      rreoItemsAnoAnterior,
      [/RECEITAS CORRENTES/],
      /ATÉ O BIMESTRE/,
    );

  const percentual =
    empenhado != null && receitaCorrenteAnterior != null && receitaCorrenteAnterior > 0
      ? (empenhado / receitaCorrenteAnterior) * 100
      : null;

  return { empenhado, receitaCorrenteAnterior, percentual, anoRCL, periodo };
}

// ── MF-16 — Liquidação total acima da receita corrente do exercício ──────────

export interface ApuracaoLiquidacaoReceita {
  /**
   * Total liquidado acumulado no exercício (RREO Anexo 02, coluna "Até o
   * Bimestre"), exceto Intra-Orçamentárias.
   */
  liquidado: number | null;
  /**
   * Receita Corrente arrecadada no mesmo exercício (RREO Anexo 01, coluna
   * "Até o Bimestre"). Quando liquidado > receita corrente, a diferença é
   * financiada por caixa anterior, operações de crédito ou resulta em RAP.
   */
  receitaCorrente: number | null;
  /** Percentual liquidado/receita_corrente (pode ultrapassar 100). */
  percentual: number | null;
  periodo: string | null;
}

/**
 * MF-16 — compara o total liquidado acumulado com a Receita Corrente do mesmo
 * exercício. Liquidação acima de 100% da RC indica que o município liquidou
 * mais do que arrecadou — indício de desequilíbrio fiscal a apurar.
 *
 * Dependência de dado: usa RREO Anexo 01 (receitas) e Anexo 02 (despesas)
 * separados, pois a API retorna anexos distintos quando especificado.
 */
export function apurarLiquidacaoVsReceita(
  rreoItemsReceitas: Record<string, unknown>[],
  rreoItemsDespesas: Record<string, unknown>[],
  periodo: string | null,
): ApuracaoLiquidacaoReceita {
  // Total liquidado acumulado — RREO Anexo 02.
  const liquidado =
    valorLinha(
      rreoItemsDespesas,
      [/RREO2TOTALDESPESAS/],
      /LIQUIDADAS ATÉ/,
    ) ??
    valorLinha(
      rreoItemsDespesas,
      [/DESPESAS.*EXCETO INTRA/],
      /LIQUIDADAS ATÉ/,
    );

  // Receita Corrente arrecadada — RREO Anexo 01.
  const receitaCorrente =
    valorLinha(
      rreoItemsReceitas,
      [/RECEITASCORRENTES/],
      /ATÉ O BIMESTRE/,
    ) ??
    valorLinha(
      rreoItemsReceitas,
      [/RECEITAS CORRENTES/],
      /ATÉ O BIMESTRE/,
    );

  const percentual =
    liquidado != null && receitaCorrente != null && receitaCorrente > 0
      ? (liquidado / receitaCorrente) * 100
      : null;

  return { liquidado, receitaCorrente, percentual, periodo };
}
