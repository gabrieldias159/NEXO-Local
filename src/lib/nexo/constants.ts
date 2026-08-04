/**
 * NEXO — Núcleo de Enfrentamento e Inteligência Pública.
 *
 * Constantes do alvo ÚNICO de investigação: a Prefeitura Municipal de
 * Marília/SP. As fontes nacionais abaixo são sempre consultadas filtradas a
 * Marília — nenhuma outra prefeitura é monitorada.
 *
 * Ver docs/nexo-plano-mestre.md.
 */

export const MARILIA = {
  nome: 'Marília',
  uf: 'SP',
  /**
   * Código IBGE do município (7 dígitos) — usado em SICONFI, PNCP, IBGE, etc.
   * ✅ Marília/SP = 3529005 (confirmado em servicodados.ibge.gov.br). O valor
   * antigo 3529401 era de MAUÁ/SP — bug corrigido em 2026-06-03.
   */
  ibge: '3529005',
  /** Código IBGE de 6 dígitos (sem dígito verificador). */
  ibge6: '352900',
  /**
   * CNPJ da Prefeitura Municipal de Marília (só dígitos) — usado como
   * `cnpjOrgao` nas consultas ao PNCP.
   * ⚠ CONFIRMAR contra fonte oficial. As rotas aceitam override via `?cnpj=`.
   */
  cnpjPrefeitura: '44477909000100',
} as const;

/** URLs-base das fontes de dados. Ver docs/nexo/01-fontes-de-dados.md. */
export const FONTES = {
  /** API do Portal da Transparência (plataforma SMARAPD). */
  smarapd: 'https://transparencia.marilia.sp.gov.br/paiportalserver',
  /** Servidor de arquivos (PDFs) do portal SMARAPD. */
  smarapdFiles: 'https://transparencia.marilia.sp.gov.br/paifileserver',
  /** Espelho da API SMARAPD. */
  smarapdMirror: 'https://transparencia-marilia.smarapd.com.br/paiportalserver',
  /** API SICONFI/STN — dados fiscais (RREO, RGF, DCA). */
  siconfi: 'https://apidatalake.tesouro.gov.br/ords/siconfi/tt',
  /** API de Consulta do PNCP — Portal Nacional de Contratações Públicas. */
  pncp: 'https://pncp.gov.br/api/consulta',
  /** Portal institucional da Prefeitura (Dados Abertos em /dados-abertos/{cat}/{ano}). */
  portalPrefeitura: 'https://www.marilia.sp.gov.br/portal',
  /** Querido Diário (OKBR) — DOM full-text por território IBGE. */
  queridoDiario: 'https://api.queridodiario.ok.org.br',
  /** Portal de Transparência do TCE-SP — despesas/receitas municipais. */
  tce: 'https://transparencia.tce.sp.gov.br',
} as const;

/** Prefixo das coleções do NEXO no Firestore. */
export const NEXO_COLLECTION_PREFIX = 'nexo_';

/**
 * Disclaimer obrigatório — todo relatório, dossiê ou exportação do NEXO
 * carrega este texto. Ver plano-mestre §2.
 */
export const NEXO_DISCLAIMER =
  'Este sistema processa dados públicos e identifica padrões estatisticamente ' +
  'atípicos que podem (ou não) indicar irregularidades. Nenhuma informação ' +
  'aqui constitui acusação, prova de improbidade ou de ilícito. Os indícios ' +
  'devem ser investigados pelas instituições competentes (TCE-SP, Ministério ' +
  'Público, Controladoria) antes de qualquer juízo de valor.';
