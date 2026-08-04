/**
 * NEXO — SCORE DE RISCO ÚNICO E COERENTE por entidade/indício (0..100).
 *
 * O problema que este módulo resolve: hoje a 3ª perna do score triplo
 * (`probabilidadeEnquadramento`) é DERIVADA na rota `/api/nexo/alertas`
 * (via `derivarProbabilidadeEnquadramento`), mas fica no DEFAULT 50 em
 * `/api/nexo/analise` e no cron gerente (`functions/src/nexo/gerente.ts`).
 * Resultado: a mesma entidade recebe scores diferentes em cada tela e o
 * RANKING DIVERGE — o que o conselho chamou de "régua incoerente"
 * (docs/nexo-hipersistema-conselho.md §3 e §15.3, "scoreRiscoEntidade —
 * coerência de ranking entre TODAS as telas").
 *
 * A correção é centralizar AQUI a régua: dado um indício com seus scores
 * (confiabilidade × probabilidadeIrregularidade × probabilidadeEnquadramento),
 * `scoreRiscoEntidade` SEMPRE deriva a 3ª perna quando ela falta — em vez do
 * flat 50 — e então delega a FÓRMULA à `scorePrioridade` do `prioridade.ts`
 * (média geométrica + bônus de recência). NÃO há fórmula duplicada nem
 * divergente: esta função apenas garante que TODAS as pernas estejam
 * preenchidas pela MESMA régua jurídica antes de chamar o cálculo único.
 *
 * Devolve, além do número, a EXPLICAÇÃO das 3 pernas (o valor usado em cada uma
 * e se a 3ª foi derivada), para a UI mostrar "por que este score" sem recalcular
 * nada — score explicável, como pede o catálogo (§3, "Score explicável e
 * expurgável").
 *
 * Princípio inviolável do NEXO: é "aderência a elementos objetivos da norma"
 * (indício), NUNCA "% de crime/improbidade". A doação política NÃO entra como
 * perna de risco (decisão do dono — §3 do hipersistema).
 */
import {
  scorePrioridade,
  derivarProbabilidadeEnquadramento,
} from './prioridade';

/**
 * Entrada mínima para o cálculo do score de risco. Casa tanto o
 * `AlertaDetectado` (recém-detectado, normalmente SEM a 3ª perna) quanto o
 * alerta persistido em `nexo_alertas`. Todos os campos são opcionais para
 * tolerar formatos parciais — o cálculo degrada honestamente (perna ausente
 * vira 0 ou, no caso da 3ª, é derivada da régua jurídica).
 */
export interface EntradaScoreRisco {
  scores?: {
    confiabilidade?: number;
    probabilidadeIrregularidade?: number;
    /** 3ª perna; quando ausente é DERIVADA (não vira default 50 silencioso). */
    probabilidadeEnquadramento?: number;
  };
  /** Severidade do indício — alimenta a derivação da 3ª perna. */
  classificacao?: string;
  /** Citações legais — fundamento presente eleva a 3ª perna (norma cogente). */
  fundamentoLegal?: string[];
  /** Tipo do sujeito — distingue 'orgao' (informativo) dos demais na derivação. */
  sujeitoTipo?: string;
  /** Data ISO da última detecção — alimenta o bônus de recência da fórmula. */
  ultimaDeteccaoEm?: string | null;
  /** Valor financeiro envolvido (R$) — repassado intacto p/ comparadores. */
  valorEnvolvido?: number;
}

/** Origem do valor de uma perna — para a UI sinalizar o que foi derivado. */
export type OrigemPerna = 'detector' | 'derivada';

/** Uma das 3 pernas do score triplo, já explicada. */
export interface PernaScore {
  /** Identificador estável da perna. */
  chave: 'confiabilidade' | 'probabilidadeIrregularidade' | 'probabilidadeEnquadramento';
  /** Rótulo curto para UI. */
  rotulo: string;
  /** Valor 0..100 efetivamente usado no cálculo. */
  valor: number;
  /**
   * Como o valor foi obtido: 'detector' (veio no indício) ou 'derivada' (a 3ª
   * perna foi inferida da régua jurídica por ausência). As 2 primeiras pernas
   * são sempre 'detector' (default 0 quando ausentes — não inventamos sinal).
   */
  origem: OrigemPerna;
}

/** Resultado do cálculo: o score composto único + a explicação das 3 pernas. */
export interface ResultadoScoreRisco {
  /**
   * Score de risco composto 0..100 — a MESMA régua de `scorePrioridade`
   * (média geométrica das 3 pernas × bônus de recência). É este número, e só
   * ele, que deve ordenar/ranquear em TODAS as telas.
   */
  score: number;
  /** As 3 pernas com seus valores e origens — para "por que este score". */
  pernas: PernaScore[];
  /**
   * true quando a 3ª perna foi DERIVADA (não veio do detector). Sinaliza à UI
   * que o enquadramento é estimado pela régua, não medido pelo detector.
   */
  enquadramentoDerivado: boolean;
}

/** Normaliza a classificação para o conjunto conhecido (ou undefined). */
function normalizarFundamento(fundamento?: string[]): string[] {
  return Array.isArray(fundamento) ? fundamento.filter((f) => typeof f === 'string' && f.length > 0) : [];
}

/**
 * Resolve a 3ª perna (`probabilidadeEnquadramento`, 0..100) de um indício de
 * forma COERENTE entre todas as telas: usa o valor do detector quando presente;
 * senão DERIVA da régua jurídica (`derivarProbabilidadeEnquadramento`) — nunca
 * cai no flat 50. Devolve também a origem (para a explicação).
 *
 * Exposta isoladamente porque é o ponto exato da divergência: qualquer caminho
 * que precise da 3ª perna (rota, cron, materialização) deve passar por aqui em
 * vez de reimplementar o default.
 */
export function resolverProbabilidadeEnquadramento(
  entrada: EntradaScoreRisco,
): { valor: number; origem: OrigemPerna } {
  const pe = entrada.scores?.probabilidadeEnquadramento;
  if (pe != null && Number.isFinite(pe)) {
    return { valor: Math.max(0, Math.min(100, pe)), origem: 'detector' };
  }
  const derivada = derivarProbabilidadeEnquadramento(
    entrada.classificacao,
    normalizarFundamento(entrada.fundamentoLegal),
    entrada.sujeitoTipo,
  );
  return { valor: derivada, origem: 'derivada' };
}

/**
 * SCORE DE RISCO ÚNICO de uma entidade/indício (0..100) + explicação.
 *
 * Garante que as 3 pernas estejam preenchidas pela MESMA régua (derivando a 3ª
 * quando falta) e delega a fórmula à `scorePrioridade` do `prioridade.ts` — a
 * mesma usada pelos comparadores `compararPotencial`. Assim o número aqui é, por
 * construção, idêntico ao que ordena as listas: zero divergência entre telas.
 */
export function scoreRiscoEntidade(entrada: EntradaScoreRisco): ResultadoScoreRisco {
  const s = entrada.scores ?? {};
  const confiabilidade = Number.isFinite(s.confiabilidade) ? Math.max(0, Math.min(100, s.confiabilidade as number)) : 0;
  const probabilidadeIrregularidade = Number.isFinite(s.probabilidadeIrregularidade)
    ? Math.max(0, Math.min(100, s.probabilidadeIrregularidade as number))
    : 0;
  const enquadramento = resolverProbabilidadeEnquadramento(entrada);

  // FÓRMULA ÚNICA: monta a entrada já com a 3ª perna RESOLVIDA e delega ao
  // `scorePrioridade` (média geométrica × recência). Não recalculamos a fórmula
  // aqui — se ela mudar em prioridade.ts, este score acompanha automaticamente.
  const score = scorePrioridade({
    scores: {
      confiabilidade,
      probabilidadeIrregularidade,
      probabilidadeEnquadramento: enquadramento.valor,
    },
    ultimaDeteccaoEm: entrada.ultimaDeteccaoEm ?? null,
    valorEnvolvido: entrada.valorEnvolvido,
  });

  const pernas: PernaScore[] = [
    {
      chave: 'confiabilidade',
      rotulo: 'Confiabilidade do indício',
      valor: confiabilidade,
      origem: 'detector',
    },
    {
      chave: 'probabilidadeIrregularidade',
      rotulo: 'Probabilidade de irregularidade',
      valor: probabilidadeIrregularidade,
      origem: 'detector',
    },
    {
      chave: 'probabilidadeEnquadramento',
      rotulo: 'Aderência a elementos da norma',
      valor: enquadramento.valor,
      origem: enquadramento.origem,
    },
  ];

  return {
    score,
    pernas,
    enquadramentoDerivado: enquadramento.origem === 'derivada',
  };
}
