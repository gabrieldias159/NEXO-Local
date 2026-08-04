/**
 * NEXO — CRIVO LEGAL (base de leis relevantes da fiscalização municipal).
 *
 * Catálogo PURO (sem I/O) das normas-chave que o NEXO SEMPRE considera ao
 * classificar um indício. Mapeia FAMÍLIA de achado (pelo prefixo do `detectorId`)
 * → normas aplicáveis e, via `enriquecerCrivoLegal(alerta)`, preenche o
 * `fundamentoLegal` quando o detector não o trouxe — preservando o existente.
 *
 * Princípio inegociável (pedido do dono): este crivo NUNCA injeta a Lei
 * 8.429/1992 (improbidade) como AFIRMAÇÃO. Pós-Lei 14.230/2021 a improbidade
 * exige DOLO específico e tem rol TAXATIVO de condutas — então a 8.429 só entra
 * como hipótese "a apurar", jamais como enquadramento dado por certo. Todo o
 * resto do crivo é ADITIVO e TOLERANTE: na dúvida, agrega norma; nunca acusa.
 *
 * Ver docs/nexo-plano-mestre.md §6–§7 e MEMORY.md (Módulo NEXO).
 */

// ── Tipos ─────────────────────────────────────────────────────────────────────

/** Temas transversais que conectam achados a normas (família semântica). */
export type TemaLegal =
  | 'licitacao'
  | 'contrato'
  | 'dispensa'
  | 'inexigibilidade'
  | 'aditivo'
  | 'sancao'
  | 'orcamento'
  | 'empenho'
  | 'liquidacao'
  | 'pagamento'
  | 'restos_a_pagar'
  | 'fiscal'
  | 'transparencia'
  | 'anticorrupcao'
  | 'improbidade'
  | 'eleitoral'
  | 'constitucional'
  | 'requisicao_informacao'
  | 'crime_responsabilidade'
  | 'divida'
  | 'previdenciario';

/** Uma norma do crivo, com os artigos que a fiscalização mais aciona. */
export interface NormaLegal {
  /** Chave estável (ex.: 'lei-14133-2021'). */
  id: string;
  /** Título usável em UI (ex.: 'Lei nº 14.133/2021 (Nova Lei de Licitações)'). */
  titulo: string;
  /** Ementa em 1 linha — o que a norma trata, em linguagem de fiscal. */
  ementaCurta: string;
  /** Artigos-chave já formatados para citar no `fundamentoLegal`. */
  artigosRelevantes: string[];
  /** Temas transversais cobertos por esta norma. */
  temas: TemaLegal[];
  /**
   * true quando a norma só pode ser citada como HIPÓTESE "a apurar", nunca como
   * afirmação. Hoje: a Lei 8.429/1992 (improbidade), pós-14.230/2021.
   */
  apenasAApurar?: boolean;
}

// ── (1) Catálogo BASE_LEGAL ───────────────────────────────────────────────────

/**
 * As normas-chave da fiscalização municipal. Ordem por relevância operacional
 * (a 14.133 primeiro porque é a que mais alimenta achados). Aditivo por design:
 * incluir nova norma aqui já a torna disponível ao crivo.
 */
export const BASE_LEGAL: readonly NormaLegal[] = [
  {
    id: 'lei-14133-2021',
    titulo: 'Lei nº 14.133/2021 (Nova Lei de Licitações e Contratos)',
    ementaCurta: 'Licitações, contratações públicas, contratos administrativos e sanções.',
    artigosRelevantes: [
      'Lei 14.133/2021, art. 14 (sanções)',
      'Lei 14.133/2021, art. 74 (inexigibilidade)',
      'Lei 14.133/2021, art. 75 (dispensa de licitação)',
      'Lei 14.133/2021, art. 124–125 (alterações e aditivos contratuais)',
    ],
    temas: ['licitacao', 'contrato', 'dispensa', 'inexigibilidade', 'aditivo', 'sancao'],
  },
  {
    id: 'lei-4320-1964',
    titulo: 'Lei nº 4.320/1964 (normas gerais de direito financeiro)',
    ementaCurta: 'Estágios da despesa pública: empenho, liquidação e pagamento.',
    artigosRelevantes: [
      'Lei 4.320/1964, art. 58–60 (empenho)',
      'Lei 4.320/1964, art. 62–63 (liquidação)',
      'Lei 4.320/1964, art. 64–65 (pagamento)',
    ],
    temas: ['orcamento', 'empenho', 'liquidacao', 'pagamento'],
  },
  {
    id: 'lc-101-2000',
    titulo: 'Lei Complementar nº 101/2000 (Lei de Responsabilidade Fiscal)',
    ementaCurta: 'Responsabilidade na gestão fiscal; limites, restos a pagar e transparência.',
    artigosRelevantes: [
      'LC 101/2000, art. 42 (despesa em fim de mandato sem disponibilidade)',
      'LC 101/2000, art. 48 (transparência da gestão fiscal)',
      'LC 101/2000, art. 50 (escrituração e consolidação das contas)',
    ],
    temas: ['fiscal', 'restos_a_pagar', 'transparencia', 'orcamento'],
  },
  {
    id: 'lei-12527-2011',
    titulo: 'Lei nº 12.527/2011 (Lei de Acesso à Informação — LAI)',
    ementaCurta: 'Direito de acesso a informações públicas e dever de transparência ativa.',
    artigosRelevantes: [
      'Lei 12.527/2011, art. 5º (dever de garantir o acesso)',
      'Lei 12.527/2011, art. 8º (transparência ativa)',
      'Lei 12.527/2011, art. 10–11 (pedido e prazo de resposta)',
    ],
    temas: ['transparencia', 'requisicao_informacao'],
  },
  {
    id: 'lei-12846-2013',
    titulo: 'Lei nº 12.846/2013 (Lei Anticorrupção)',
    ementaCurta: 'Responsabilização administrativa e civil de empresas por atos lesivos.',
    artigosRelevantes: [
      'Lei 12.846/2013, art. 5º (atos lesivos à Administração)',
      'Lei 12.846/2013, art. 6º (sanções administrativas)',
    ],
    temas: ['anticorrupcao', 'sancao', 'contrato'],
  },
  {
    id: 'lei-8429-1992',
    titulo: 'Lei nº 8.429/1992 (Lei de Improbidade Administrativa)',
    ementaCurta:
      'Improbidade administrativa. ATENÇÃO: pós-Lei 14.230/2021 exige DOLO específico e tem rol TAXATIVO — só "a apurar", nunca afirmar.',
    artigosRelevantes: [
      'Lei 8.429/1992, art. 9º (enriquecimento ilícito) — a apurar',
      'Lei 8.429/1992, art. 10 (dano ao erário) — a apurar',
      'Lei 8.429/1992, art. 11 (atos contra princípios) — a apurar',
    ],
    temas: ['improbidade'],
    apenasAApurar: true,
  },
  {
    id: 'lei-9504-1997',
    titulo: 'Lei nº 9.504/1997 (Lei das Eleições)',
    ementaCurta: 'Condutas vedadas aos agentes públicos em ano eleitoral.',
    artigosRelevantes: ['Lei 9.504/1997, art. 73 (condutas vedadas)'],
    temas: ['eleitoral'],
  },
  {
    id: 'cf-1988',
    titulo: 'Constituição Federal de 1988',
    ementaCurta:
      'Princípios da Administração Pública e vinculações mínimas de saúde e educação.',
    artigosRelevantes: [
      'CF/1988, art. 37 (princípios: legalidade, impessoalidade, moralidade, publicidade, eficiência)',
      'CF/1988, art. 198 (financiamento e percentual mínimo da saúde)',
      'CF/1988, art. 212 (percentual mínimo de aplicação em educação)',
    ],
    temas: ['constitucional', 'transparencia', 'fiscal'],
  },
  {
    id: 'lom-marilia',
    titulo: 'Lei Orgânica do Município de Marília',
    ementaCurta:
      'Organização do município; prerrogativa do vereador de requisitar informações ao Executivo.',
    artigosRelevantes: [
      'LOM Marília, art. 16, XXII (requisição de informação ao Executivo)',
    ],
    temas: ['requisicao_informacao', 'transparencia'],
  },
  {
    id: 'dl-201-1967',
    titulo: 'Decreto-Lei nº 201/1967 (Crimes de Responsabilidade de Prefeitos)',
    ementaCurta: 'Crimes de responsabilidade de prefeitos e vereadores — só como hipótese "a apurar".',
    artigosRelevantes: [
      'DL 201/1967, art. 1º, I (apropriar-se de bens ou rendas públicas) — a apurar',
      'DL 201/1967, art. 1º, III (aplicar indevidamente verbas públicas) — a apurar',
      'DL 201/1967, art. 1º, V (ordenar despesa sem empenho) — a apurar',
      'DL 201/1967, art. 1º, XII (quebrar ordem cronológica de pagamentos) — a apurar',
      'DL 201/1967, art. 1º, XIX (deixar de promover liquidação de operação de crédito) — a apurar',
    ],
    temas: ['crime_responsabilidade', 'fiscal', 'anticorrupcao'],
    apenasAApurar: true,
  },
  {
    id: 'rs-40-2001',
    titulo: 'Resolução do Senado nº 40/2001',
    ementaCurta: 'Limites para dívida consolidada líquida e concessão de garantias pelos entes subnacionais.',
    artigosRelevantes: [
      'RS 40/2001, art. 1º (DCL ≤ 120% da RCL)',
      'RS 40/2001, art. 8º (garantias ≤ 22% da RCL)',
    ],
    temas: ['fiscal', 'divida'],
  },
  {
    id: 'rs-43-2001',
    titulo: 'Resolução do Senado nº 43/2001',
    ementaCurta: 'Limites para contratação de operações de crédito pelos entes subnacionais.',
    artigosRelevantes: [
      'RS 43/2001, art. 1º (operações de crédito ≤ 16% da RCL)',
    ],
    temas: ['fiscal', 'divida'],
  },
  {
    id: 'lc-709-1993',
    titulo: 'Lei Complementar estadual nº 709/1993 (Lei Orgânica do TCE-SP)',
    ementaCurta: 'Organização do Tribunal de Contas do Estado de SP; legitimidade para representação de cidadão.',
    artigosRelevantes: [
      'LC 709/1993, art. 113, §1º (legitimidade do cidadão para representar ao TCE-SP)',
    ],
    temas: ['transparencia'],
  },
] as const;

/** Índice por `id` para resolução O(1). */
const PORID: ReadonlyMap<string, NormaLegal> = new Map(
  BASE_LEGAL.map((n) => [n.id, n]),
);

/** Recupera uma norma do crivo pelo seu `id`; `undefined` se não existir. */
export function normaPorId(id: string): NormaLegal | undefined {
  return PORID.get(id);
}

// ── (2) Mapeamentos: tema → normas, e detector → normas ───────────────────────

/** Resolve uma lista de ids de norma em objetos, ignorando ids desconhecidos. */
function resolver(ids: readonly string[]): NormaLegal[] {
  const out: NormaLegal[] = [];
  const visto = new Set<string>();
  for (const id of ids) {
    if (visto.has(id)) continue;
    const n = PORID.get(id);
    if (n) {
      visto.add(id);
      out.push(n);
    }
  }
  return out;
}

/**
 * Normas aplicáveis a um TEMA transversal. Útil para a UI montar o crivo por
 * assunto, independentemente de detector.
 */
export function normasPorTema(tema: TemaLegal): NormaLegal[] {
  return BASE_LEGAL.filter((n) => n.temas.includes(tema));
}

/**
 * Mapa PREFIXO do detectorId → ids de norma aplicáveis (família de achado).
 *
 * Regras pedidas pelo dono:
 *  - LC (licitações/contratos)        → 14.133
 *  - OR (orçamento/execução)          → 4.320
 *  - MF (metas fiscais / LRF)         → LRF
 *  - FR (fornecedores / contratos)    → 14.133 + 12.846 (anticorrupção)
 *  - DE (dispensas/emergenciais)      → LOM (requisição) + 14.133
 *  - XS / X2 (cruzamentos)            → LAI + LRF
 *  - eleitoral                        → 9.504
 *
 *  - EM (contratações emergenciais) → 14.133 (dispensa por urgência, art. 75)
 *
 * Prefixos vizinhos do catálogo recebem a família mais próxima (aditivo):
 * OB→14.133, FC/SA→14.133, FP→4.320, RC→LRF, TS→14.133, DO→LAI, FN→14.133.
 */
const PREFIXO_NORMAS: Record<string, readonly string[]> = {
  // Licitações, compras e contratos.
  LC: ['lei-14133-2021'],
  // Orçamento e execução da despesa.
  OR: ['lei-4320-1964'],
  // Metas/limites fiscais (LRF).
  MF: ['lc-101-2000'],
  // Fornecedores e contratos — risco de sanção/anticorrupção.
  FR: ['lei-14133-2021', 'lei-12846-2013'],
  // Dispensas e emergenciais — pedido de informação + base de licitações.
  DE: ['lom-marilia', 'lei-14133-2021'],
  // Contratações emergenciais (dispensa por urgência) — art. 75 da NLLC.
  EM: ['lei-14133-2021'],
  // Cruzamentos cross-source (XS) e divergência de fonte (X2).
  XS: ['lei-12527-2011', 'lc-101-2000'],
  X2: ['lei-12527-2011', 'lc-101-2000'],
  // ── Famílias vizinhas do catálogo (aproximação aditiva) ──
  OB: ['lei-14133-2021'], // obras públicas
  FC: ['lei-14133-2021'], // frota/combustível
  SA: ['lei-14133-2021'], // saúde
  FP: ['lei-4320-1964'], // folha de pagamento (execução)
  RC: ['lc-101-2000'], // receita / metas fiscais
  TS: ['lei-14133-2021'], // terceiro setor (parcerias)
  DO: ['lei-12527-2011'], // diário oficial / publicidade dos atos
  FN: ['lei-14133-2021'], // concentração de fornecedor
  // Transparência (LAI + TCE-SP).
  TP: ['lei-12527-2011', 'lc-101-2000'],
} as const;

/** Tokens que, no detectorId ou contexto, indicam matéria ELEITORAL. */
const RE_ELEITORAL = /eleitor|9\.?504|art\.?\s*73/i;

/** Extrai o prefixo (parte antes do primeiro '-') de um detectorId. */
function prefixoDe(detectorId: string): string {
  const id = (detectorId ?? '').trim().toUpperCase();
  const dash = id.indexOf('-');
  return dash >= 0 ? id.slice(0, dash) : id;
}

/**
 * Normas aplicáveis a um detector, pelo PREFIXO do seu id. Achados eleitorais
 * (id/contexto batendo em `eleitoral|9.504|art.73`) ganham a 9.504 de forma
 * aditiva. Desconhecido → [] (o crivo degrada honestamente, sem inventar lei).
 */
export function normasPorDetector(detectorId: string): NormaLegal[] {
  const pref = prefixoDe(detectorId);
  const ids = [...(PREFIXO_NORMAS[pref] ?? [])];
  if (RE_ELEITORAL.test(detectorId ?? '')) ids.push('lei-9504-1997');
  return resolver(ids);
}

// ── (3) enriquecerCrivoLegal(alerta) ──────────────────────────────────────────

/**
 * Forma mínima de alerta aceita por `enriquecerCrivoLegal`. Casa tanto o
 * `AlertaDetectado` (recém-detectado) quanto o alerta persistido; os campos são
 * opcionais para tolerar formatos parciais.
 */
export interface AlertaCrivoLike {
  detectorId?: string;
  /** Citações legais já trazidas pelo detector — preservadas verbatim. */
  fundamentoLegal?: string[];
}

/** A citação afirma improbidade (8.429) como dado certo? (heurística defensiva.) */
function afirmaImprobidade(citacao: string): boolean {
  const c = (citacao ?? '').toLowerCase();
  const mencionaLei = /8\.?429|improbidade/.test(c);
  if (!mencionaLei) return false;
  // Tem ressalva "a apurar" / "em tese" / "eventual"? Então NÃO é afirmação.
  const temRessalva = /a apurar|em tese|eventual|hip[óo]tese|se comprovad|investig/.test(c);
  return !temRessalva;
}

/**
 * Preenche o `fundamentoLegal` do alerta a partir do `detectorId` QUANDO ele
 * está vazio — preservando integralmente o que o detector já trouxe. Retorna uma
 * CÓPIA do alerta (não muta o original).
 *
 * Garantias inegociáveis:
 *  - NUNCA injeta a Lei 8.429/1992 como afirmação. Mesmo que a citação existente
 *    afirme improbidade, este crivo não a propaga (filtra a afirmação) — a 8.429
 *    só vive como hipótese "a apurar" nos artigos da própria norma no catálogo.
 *  - Aditivo e tolerante: detector desconhecido → mantém o que havia (ou []);
 *    qualquer falha degrada para o `fundamentoLegal` original.
 */
export function enriquecerCrivoLegal<A extends AlertaCrivoLike>(alerta: A): A {
  try {
    const existente = Array.isArray(alerta.fundamentoLegal)
      ? alerta.fundamentoLegal
      : [];

    // Sanitiza o que já existe: remove QUALQUER afirmação de improbidade (8.429),
    // mantendo o restante verbatim. Isto protege o invariante mesmo quando o
    // alerta chega com o fundamento já preenchido.
    const preservado = existente.filter((c) => !afirmaImprobidade(c));

    // Se o detector já trouxe fundamento (após sanitizar), preserva-o e sai.
    if (preservado.length > 0) {
      // Só devolve cópia nova se a sanitização removeu algo (evita realloc à toa).
      if (preservado.length === existente.length) return alerta;
      return { ...alerta, fundamentoLegal: preservado };
    }

    // Vazio → deriva do detectorId. Nunca injeta 8.429 (o catálogo a marca como
    // `apenasAApurar`; aqui só agregamos citações afirmáveis).
    const derivadas = normasPorDetector(alerta.detectorId ?? '')
      .filter((n) => !n.apenasAApurar)
      .flatMap((n) => n.artigosRelevantes);

    // Dedup preservando ordem.
    const visto = new Set<string>();
    const fundamentoLegal: string[] = [];
    for (const c of derivadas) {
      if (visto.has(c)) continue;
      visto.add(c);
      fundamentoLegal.push(c);
    }

    if (fundamentoLegal.length === 0) {
      // Nada a acrescentar; só devolve cópia se tivemos de sanitizar.
      return preservado.length === existente.length
        ? alerta
        : { ...alerta, fundamentoLegal: preservado };
    }
    return { ...alerta, fundamentoLegal };
  } catch {
    // Degrada honestamente: nunca derruba o alerta por causa do crivo.
    return alerta;
  }
}
