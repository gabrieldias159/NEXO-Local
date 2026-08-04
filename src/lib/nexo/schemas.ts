/**
 * Schemas Zod das coleções `nexo_*` do Firestore.
 *
 * Cobrem as coleções de fundação da Fase 0. As demais (grafo, briefings,
 * merges_log, etc.) entram nas fases seguintes — ver docs/nexo-plano-mestre.md §5.
 */
import { z } from 'zod';

/** Metadados de rastro probatório — presentes em todo documento `nexo_*`. */
export const metaSchema = z.object({
  fonte: z.string(),
  coletadoEm: z.string().datetime(),
  hashConteudo: z.string(),
  versaoSchema: z.string(),
  /** URL de origem do dado, quando aplicável. */
  urlOrigem: z.string().url().nullable().default(null),
});
export type Meta = z.infer<typeof metaSchema>;

export const modalidadeEnum = z.enum([
  'dispensa',
  'dispensada',
  'inexigibilidade',
  'convite',
  'tomada_precos',
  'concorrencia',
  'pregao',
  'chamamento_publico',
  'concurso',
  'leilao',
  'nao_aplicavel',
  'outros',
]);
export type Modalidade = z.infer<typeof modalidadeEnum>;

// ── nexo_empenhos ────────────────────────────────────────────────────────────

export const empenhoSchema = z.object({
  id: z.string(),
  exercicio: z.number().int(),
  numeroEmpenho: z.string(),
  data: z.string(), // ISO yyyy-MM-dd (data-only, conforme normalizar.ts)
  valorEmpenhado: z.number(),
  valorLiquidado: z.number().default(0),
  valorPago: z.number().default(0),
  fornecedorCpfCnpj: z.string().nullable(),
  fornecedorNome: z.string(),
  unidadeGestora: z.string().default(''),
  modalidade: modalidadeEnum.default('outros'),
  numeroProcesso: z.string().nullable().default(null),
  numeroLicitacao: z.string().nullable().default(null),
  numeroContrato: z.string().nullable().default(null),
  historico: z.string().default(''),
  elementoDespesa: z.string().default(''),
  _meta: metaSchema,
});
export type Empenho = z.infer<typeof empenhoSchema>;

// ── nexo_fornecedores ────────────────────────────────────────────────────────

/** Fornecedor em 2 níveis (ver plano-mestre §5). Este é o Estabelecimento. */
export const fornecedorSchema = z.object({
  id: z.string(), // = cpfCnpj (14 ou 11 dígitos)
  cpfCnpj: z.string(),
  /** Raiz do CNPJ (8 primeiros dígitos) — agrupa filiais no EmpresaGrupo. */
  cnpjRaiz: z.string().nullable(),
  razaoSocial: z.string(),
  nomeFantasia: z.string().nullable().default(null),
  uf: z.string().nullable().default(null),
  municipio: z.string().nullable().default(null),
  cnaePrincipal: z.string().nullable().default(null),
  dataAbertura: z.string().nullable().default(null),
  situacaoCadastral: z.string().nullable().default(null),
  inidoneo: z.object({
    ceis: z.boolean(),
    cnep: z.boolean(),
    verificadoEm: z.string().datetime().nullable(),
  }).default({ ceis: false, cnep: false, verificadoEm: null }),
  estatisticasMarilia: z.object({
    totalEmpenhado: z.number(),
    quantidadeEmpenhos: z.number().int(),
  }).default({ totalEmpenhado: 0, quantidadeEmpenhos: 0 }),
  _meta: metaSchema,
});
export type Fornecedor = z.infer<typeof fornecedorSchema>;

// ── nexo_indicadores_fiscais ─────────────────────────────────────────────────

export const indicadorFiscalSchema = z.object({
  id: z.string(), // sha1(indicador+exercicio+periodo)
  /** Chave do indicador: 'saude' | 'educacao' | 'pessoal_executivo' | … */
  indicador: z.string(),
  rotulo: z.string(),
  exercicio: z.number().int(),
  /** Período de referência dentro do exercício (bimestre/quadrimestre). */
  periodo: z.string().default(''),
  /** Valor apurado (percentual ou montante, conforme `unidade`). */
  valor: z.number().nullable(),
  /** Limite ou meta legal. */
  limite: z.number().nullable(),
  /** 'percentual' | 'reais'. */
  unidade: z.string().default('percentual'),
  /** Sentido do limite: 'minimo' (≥) ou 'maximo' (≤). */
  sentido: z.enum(['minimo', 'maximo']),
  /** Situação derivada da comparação valor × limite. */
  situacao: z.enum(['ok', 'atencao', 'prudencial', 'estourado', 'sem_dado']).default('sem_dado'),
  fundamentoLegal: z.string().default(''),
  _meta: metaSchema,
});
export type IndicadorFiscal = z.infer<typeof indicadorFiscalSchema>;

// ── nexo_alertas ─────────────────────────────────────────────────────────────

export const classificacaoEnum = z.enum(['informativo', 'atencao', 'suspeita', 'critico']);
export type Classificacao = z.infer<typeof classificacaoEnum>;

export const alertaSchema = z.object({
  id: z.string(),
  /**
   * Chave de deduplicação determinística do indício — `sha1` de
   * `detectorId|exercicio|sujeitoTipo|sujeitoId|discriminador` (ver
   * `src/lib/nexo/alertas.ts`). É o `id` do documento em `nexo_alertas`:
   * re-rodar o monitor ATUALIZA o alerta existente em vez de duplicar.
   */
  chaveDeteccao: z.string(),
  /** ID do detector que gerou o alerta (esquema unificado, ex.: 'LC-01'). */
  detectorId: z.string(),
  /** Exercício do indício (topo — usado nos índices compostos de `nexo_alertas`). */
  exercicio: z.number().int(),
  categoria: z.string(),
  titulo: z.string(),
  descricao: z.string(),
  sujeito: z.object({
    tipo: z.enum(['fornecedor', 'contrato', 'empenho', 'servidor', 'orgao', 'indicador']),
    id: z.string(),
    rotulo: z.string(),
  }),
  /** Valor financeiro envolvido (R$) — topo, ordena e prioriza os alertas. */
  valorEnvolvido: z.number().default(0),
  detectadoEm: z.string().datetime(),
  /** Primeira vez que o monitor detectou este indício. */
  primeiraDeteccaoEm: z.string().datetime(),
  /** Última execução do monitor que reconfirmou este indício. */
  ultimaDeteccaoEm: z.string().datetime(),
  /** Quantas execuções do monitor já reconfirmaram este indício. */
  ocorrencias: z.number().int().default(1),
  /** false quando o indício deixou de ser detectado na última varredura. */
  ativo: z.boolean().default(true),
  /** Quando o alerta foi resolvido/arquivado; `null` enquanto em aberto. */
  resolvidoEm: z.string().datetime().nullable().default(null),
  /** ID da investigação aberta a partir deste alerta; `null` se nenhuma. */
  investigacaoId: z.string().nullable().default(null),
  /** Os 3 indicadores do score triplo (0–100). */
  scores: z.object({
    confiabilidade: z.number().min(0).max(100),
    probabilidadeIrregularidade: z.number().min(0).max(100),
    /** 3ª perna do score triplo — opcional (default 50 no cálculo de prioridade). */
    probabilidadeEnquadramento: z.number().min(0).max(100).optional(),
  }),
  classificacao: classificacaoEnum,
  /** Checklist de aderência a elementos objetivos da norma (não é %). */
  aderenciaNorma: z.array(z.object({ elemento: z.string(), presente: z.boolean() })).default([]),
  fundamentoLegal: z.array(z.string()).default([]),
  evidencias: z.array(z.object({
    tipo: z.string().optional(),
    refColecao: z.string().optional(),
    refId: z.string().optional(),
    resumo: z.string(),
    valor: z.number().optional(),
    data: z.string().nullable().optional(),
    ref: z.string().optional(),
    /** Procedência documental da evidência (link da prova) — opcional. */
    procedencia: z.object({
      fonte: z.enum(['SMARAPD', 'PNCP', 'SICONFI', 'TCE-SP', 'DOM', 'PORTAL-MARILIA', 'CGU']),
      label: z.string(),
      url: z.string(),
      tipoDoc: z.enum(['pdf', 'pagina', 'api-json', 'modulo']),
      podePreview: z.boolean(),
      refColecao: z.string().optional(),
      refId: z.string().optional(),
    }).optional(),
  })).default([]),
  explicacao: z.string(),
  status: z.enum([
    'aberta', 'em_analise', 'virou_investigacao', 'arquivada', 'falso_positivo',
  ]).default('aberta'),
  _meta: metaSchema,
});
export type Alerta = z.infer<typeof alertaSchema>;

// ── nexo_rap_apuracao ─────────────────────────────────────────────────────────

export const rapApuracaoSchema = z.object({
  id: z.string(),
  exercicio: z.number().int(),
  quadrimestre: z.number().int().min(1).max(3),
  rapInscritos: z.number().nullable(),
  rapProcessados: z.number().nullable(),
  rapNaoProcessados: z.number().nullable(),
  disponibilidadeCaixa: z.number().nullable(),
  coberturaCaixa: z.number().nullable(),
  situacao: z.enum(['ok', 'atencao', 'critico']),
  periodoRef: z.string(),
  _meta: metaSchema,
});
export type RapApuracao = z.infer<typeof rapApuracaoSchema>;

// ── nexo_divida_ativa ─────────────────────────────────────────────────────────

export const dividaAtivaSchema = z.object({
  id: z.string(),
  exercicio: z.number().int(),
  estoqueInicial: z.number(),
  inscricoes: z.number(),
  recebimentos: z.number(),
  prescricoes: z.number(),
  estoqueFinal: z.number(),
  crescimentoAnual: z.number().nullable(),
  recuperacaoPct: z.number().nullable(),
  _meta: metaSchema,
});
export type DividaAtiva = z.infer<typeof dividaAtivaSchema>;

// ── nexo_precatorios ──────────────────────────────────────────────────────────

export const precatorioSchema = z.object({
  id: z.string(),
  exercicio: z.number().int(),
  totalPendente: z.number(),
  totalPago: z.number(),
  ordemCronologica: z.boolean(),
  alertaAtraso: z.boolean(),
  _meta: metaSchema,
});
export type Precatório = z.infer<typeof precatorioSchema>;

// ── nexo_duodecimo ────────────────────────────────────────────────────────────

export const duodecimoSchema = z.object({
  id: z.string(),
  exercicio: z.number().int(),
  mes: z.number().int().min(1).max(12),
  populacao: z.number(),
  repasseRealizado: z.number(),
  limiteLegal: z.number(),
  limitePct: z.number(),
  situacao: z.enum(['ok', 'estourado']),
  _meta: metaSchema,
});
export type Duodecimo = z.infer<typeof duodecimoSchema>;

// ── nexo_suprimento_fundos ────────────────────────────────────────────────────

export const suprimentoFundosSchema = z.object({
  id: z.string(),
  exercicio: z.number().int(),
  servidorCpf: z.string(),
  servidorNome: z.string(),
  valorTotal: z.number(),
  quantidadeOperacoes: z.number().int(),
  mes: z.number().int(),
  _meta: metaSchema,
});
export type SuprimentoFundos = z.infer<typeof suprimentoFundosSchema>;

// ── nexo_checklist_transparencia ──────────────────────────────────────────────

export const checklistTransparenciaSchema = z.object({
  id: z.string(),
  dataVerificacao: z.string(),
  itens: z.array(z.object({
    chave: z.string(),
    rotulo: z.string(),
    presente: z.boolean(),
    atualizado: z.boolean(),
    dataUltimaAtualizacao: z.string().nullable(),
    fundamento: z.string(),
  })),
  conformidadePct: z.number(),
  _meta: metaSchema,
});
export type ChecklistTransparencia = z.infer<typeof checklistTransparenciaSchema>;
