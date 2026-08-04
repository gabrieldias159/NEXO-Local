/**
 * Catálogo de indicadores do subsistema de Metas Fiscais & Orçamentárias.
 * Limites e fundamentos legais — ver docs/nexo-plano-mestre.md §6.
 */

export type SentidoLimite = 'minimo' | 'maximo';
export type SituacaoIndicador = 'ok' | 'atencao' | 'prudencial' | 'estourado' | 'sem_dado';

export interface DefinicaoIndicadorFiscal {
  chave: string;
  rotulo: string;
  /** Limite/meta legal, em pontos percentuais. */
  limite: number;
  /** Faixa prudencial (95% do limite) — só para indicadores de teto. */
  prudencial?: number;
  /** Faixa de alerta (90% do limite) — só para indicadores de teto. */
  alerta?: number;
  sentido: SentidoLimite;
  fundamento: string;
  descricao: string;
}

export const INDICADORES_FISCAIS: readonly DefinicaoIndicadorFiscal[] = [
  {
    chave: 'saude',
    rotulo: 'Aplicação em Saúde',
    limite: 15,
    sentido: 'minimo',
    fundamento: 'EC 29 · LC 141/2012',
    descricao: '≥ 15% das receitas de impostos',
  },
  {
    chave: 'educacao',
    rotulo: 'Aplicação em Educação (MDE)',
    limite: 25,
    sentido: 'minimo',
    fundamento: 'CF art. 212',
    descricao: '≥ 25% das receitas de impostos',
  },
  {
    chave: 'fundeb',
    rotulo: 'FUNDEB — remuneração do magistério',
    limite: 70,
    sentido: 'minimo',
    fundamento: 'CF art. 212-A',
    descricao: '≥ 70% em remuneração do magistério',
  },
  {
    chave: 'pessoal_executivo',
    rotulo: 'Despesa com pessoal — Executivo',
    limite: 54,
    prudencial: 51.3,
    alerta: 48.6,
    sentido: 'maximo',
    fundamento: 'LRF art. 19–20',
    descricao: '≤ 54% da RCL',
  },
  {
    chave: 'pessoal_legislativo',
    rotulo: 'Despesa com pessoal — Câmara',
    limite: 6,
    prudencial: 5.7,
    alerta: 5.4,
    sentido: 'maximo',
    fundamento: 'LRF art. 20',
    descricao: '≤ 6% da RCL',
  },
  {
    chave: 'divida',
    rotulo: 'Dívida consolidada líquida',
    limite: 120,
    sentido: 'maximo',
    fundamento: 'Res. Senado 40/2001',
    descricao: '≤ 120% da RCL',
  },
];

/** Deriva a situação de um indicador comparando o valor apurado ao limite. */
export function situacaoIndicador(
  def: DefinicaoIndicadorFiscal,
  valor: number | null,
): SituacaoIndicador {
  if (valor == null || Number.isNaN(valor)) return 'sem_dado';
  if (def.sentido === 'minimo') {
    return valor >= def.limite ? 'ok' : 'estourado';
  }
  // Indicador de teto (máximo).
  if (valor > def.limite) return 'estourado';
  if (def.prudencial != null && valor >= def.prudencial) return 'prudencial';
  if (def.alerta != null && valor >= def.alerta) return 'atencao';
  return 'ok';
}
