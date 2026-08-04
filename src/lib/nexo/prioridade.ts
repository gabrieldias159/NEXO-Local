/**
 * NEXO — Score de prioridade e comparadores de ordenação.
 *
 * Resolve dois reclamos de qualidade do dono:
 *  - RANKING POR POTENCIAL: ordenar do MAIOR potencial de irregularidade para o
 *    menor — não pelo proxy "valor em R$" (um contrato grande e legítimo de
 *    energia não deve vir antes de um indício pequeno mas crítico).
 *  - ORDENAÇÃO CRONOLÓGICA DECRESCENTE: do mais recente para o mais antigo.
 *
 * O score combina o "score triplo" (confiabilidade × prob. irregularidade ×
 * prob. enquadramento) por MÉDIA GEOMÉTRICA — penaliza quando qualquer perna é
 * fraca, reduzindo falso positivo. A 3ª perna é opcional (default 50).
 */

interface ComScores {
  scores?: {
    confiabilidade?: number;
    probabilidadeIrregularidade?: number;
    probabilidadeEnquadramento?: number;
  };
  ultimaDeteccaoEm?: string | null;
  valorEnvolvido?: number;
}

/** Score de prioridade 0..100 (média geométrica das 3 pernas + bônus de recência). */
export function scorePrioridade(a: ComScores): number {
  const s = a.scores ?? {};
  const c = Math.max(0, (s.confiabilidade ?? 0) / 100);
  const pi = Math.max(0, (s.probabilidadeIrregularidade ?? 0) / 100);
  const pe = Math.max(0, (s.probabilidadeEnquadramento ?? 50) / 100);
  const base = Math.cbrt(c * pi * pe) * 100; // 0..100
  const recencia = a.ultimaDeteccaoEm ? 1 : 0.9; // leve bônus a quem tem data
  return base * recencia;
}

/** Comparador por POTENCIAL desc; desempate por recência desc e depois valor desc. */
export function compararPotencial(a: ComScores, b: ComScores): number {
  const d = scorePrioridade(b) - scorePrioridade(a);
  if (Math.abs(d) > 1e-9) return d;
  return compararRecente(a, b);
}

/** Comparador CRONOLÓGICO desc (mais recente primeiro); desempate por valor desc. */
export function compararRecente(a: ComScores, b: ComScores): number {
  const ra = a.ultimaDeteccaoEm ?? '';
  const rb = b.ultimaDeteccaoEm ?? '';
  if (ra !== rb) return rb.localeCompare(ra);
  return (b.valorEnvolvido ?? 0) - (a.valorEnvolvido ?? 0);
}

/** Comparador por VALOR desc (comportamento legado, disponível via ?ordem=valor). */
export function compararValor(a: ComScores, b: ComScores): number {
  return (b.valorEnvolvido ?? 0) - (a.valorEnvolvido ?? 0);
}

/**
 * Deriva a 3ª perna do score triplo — `probabilidadeEnquadramento` (0..100) —
 * quando o detector não a preencheu (a maioria hoje). Régua jurídica de 4 faixas
 * (plano-mestre do Conselho): quão provável é o indício se enquadrar numa norma
 * cogente, dado a severidade + se há fundamento legal citado.
 *
 * IMPORTANTE: é "aderência a elementos objetivos da norma", NUNCA "% de
 * improbidade/ilícito" — não renderizar como percentual de crime.
 */
export function derivarProbabilidadeEnquadramento(
  classificacao?: string,
  fundamentoLegal?: string[],
  sujeitoTipo?: string,
): number {
  const temFundamento = Array.isArray(fundamentoLegal) && fundamentoLegal.length > 0;
  switch (classificacao) {
    case 'critico':
      return temFundamento ? 90 : 70; // norma cogente + (idealmente) dado cruzado
    case 'suspeita':
      return temFundamento ? 65 : 52;
    case 'atencao':
      return temFundamento ? 46 : 40; // proxy textual / princípio
    default:
      return sujeitoTipo === 'orgao' ? 32 : 30; // informativo
  }
}
