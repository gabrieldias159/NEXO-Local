/**
 * NEXO — estatística robusta para detecção de outliers (puro, sem I/O).
 *
 * POR QUE NÃO "média + 2σ" (z-score clássico)?
 *  - A média e o desvio-padrão são, eles mesmos, contaminados pelos outliers que
 *    queremos detectar. Um único valor absurdo PUXA a média na sua direção e INFLA
 *    o σ — o efeito é que o próprio outlier "constrói" um intervalo largo o
 *    suficiente para se esconder dentro dele. É o fenômeno do mascaramento
 *    (masking): a fraude grande some justamente porque é grande.
 *  - σ tem "ponto de ruptura" 0%: basta UM ponto indo a infinito para σ ir a
 *    infinito. Não há robustez nenhuma.
 *
 * A alternativa robusta:
 *  - MEDIANA tem ponto de ruptura 50% — metade dos dados pode ser lixo e ela ainda
 *    aponta o centro real.
 *  - MAD (Median Absolute Deviation) é a mediana das distâncias à mediana; é o
 *    análogo robusto de σ e também tem ponto de ruptura 50%.
 *  - O escore de Iglewicz & Hoaglin (modified z-score) usa mediana+MAD no lugar de
 *    média+σ. O fator 0.6745 (≈ Φ⁻¹(0.75)) calibra o MAD para que, sob dados
 *    Normais, ele estime o MESMO σ — então o corte |Z|>3.5 é diretamente
 *    comparável ao "±3.5σ" clássico, mas sem mascaramento.
 *
 * Fallback IQR: quando há muitos valores repetidos (ex.: metade dos empenhos com o
 * mesmo valor), o MAD pode dar 0 e o escore explodir (divisão por zero). Nesse caso
 * trocamos a escala pelo IQR (amplitude interquartílica), também robusto.
 *
 * Referência: Iglewicz, B. & Hoaglin, D. (1993), "How to Detect and Handle
 * Outliers", ASQC Quality Press.
 */

/** Limiar canônico de Iglewicz–Hoaglin para o escore modificado. */
export const LIMIAR_IGLEWICZ_HOAGLIN = 3.5;

/** Constante de consistência: 0.6745 ≈ Φ⁻¹(0.75), calibra o MAD para estimar σ. */
export const FATOR_CONSISTENCIA_MAD = 0.6745;

/** Filtra um vetor para conter apenas números finitos (descarta NaN/±Inf/null). */
function finitos(xs: readonly number[]): number[] {
  return xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
}

/**
 * Mediana de um vetor. Ignora valores não-finitos. Retorna NaN se vazio.
 * Para n par, média dos dois centrais.
 */
export function mediana(xs: readonly number[]): number {
  const v = finitos(xs).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return NaN;
  const meio = n >> 1;
  return n % 2 === 1 ? v[meio] : (v[meio - 1] + v[meio]) / 2;
}

/**
 * Quantil por interpolação linear (método "linear" / R-7), q em [0,1].
 * Usado pelo fallback IQR. Ignora não-finitos; NaN se vazio.
 */
export function quantil(xs: readonly number[], q: number): number {
  const v = finitos(xs).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return NaN;
  if (n === 1) return v[0];
  const pos = (n - 1) * Math.min(1, Math.max(0, q));
  const base = Math.floor(pos);
  const resto = pos - base;
  const proximo = base + 1 < n ? v[base + 1] : v[base];
  return v[base] + resto * (proximo - v[base]);
}

/**
 * MAD — Median Absolute Deviation: mediana de |x − mediana(xs)|.
 * Escala robusta. Por padrão NÃO aplica o fator de consistência (MAD "cru"); o
 * fator 0.6745 entra no escore. Retorna NaN se vazio, 0 se todos iguais.
 */
export function mad(xs: readonly number[], med?: number): number {
  const v = finitos(xs);
  if (v.length === 0) return NaN;
  const centro = med ?? mediana(v);
  return mediana(v.map((x) => Math.abs(x - centro)));
}

/**
 * IQR — amplitude interquartílica (Q3 − Q1). Escala robusta de fallback.
 * Retorna NaN se vazio.
 */
export function iqr(xs: readonly number[]): number {
  const v = finitos(xs);
  if (v.length === 0) return NaN;
  return quantil(v, 0.75) - quantil(v, 0.25);
}

/**
 * Escore modificado de Iglewicz–Hoaglin para um ponto `x`:
 *
 *   Z = 0.6745 * (x − mediana) / MAD
 *
 * Quando MAD = 0 (muitos valores idênticos), cai para uma escala derivada do IQR:
 *
 *   Z = (x − mediana) / (IQR / 1.349)
 *
 * (1.349 ≈ 2·0.6745 é a razão IQR→σ sob normalidade, deixando os dois escores na
 * mesma unidade.) Se também o IQR for 0 (constante absoluta), retorna 0 para
 * x == mediana e ±Infinity caso contrário — não há dispersão para normalizar.
 *
 * @param x      valor a avaliar
 * @param med    mediana da distribuição de referência
 * @param madVal MAD (cru) da distribuição de referência
 * @param iqrVal IQR opcional para o fallback; recomendado quando madVal pode ser 0
 */
export function escoreIglewiczHoaglin(
  x: number,
  med: number,
  madVal: number,
  iqrVal?: number,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(med)) return NaN;

  if (Number.isFinite(madVal) && madVal > 0) {
    return (FATOR_CONSISTENCIA_MAD * (x - med)) / madVal;
  }

  // Fallback IQR (MAD degenerou a 0).
  if (iqrVal !== undefined && Number.isFinite(iqrVal) && iqrVal > 0) {
    const escala = iqrVal / 1.349; // IQR → σ-equivalente
    return (x - med) / escala;
  }

  // Sem dispersão alguma: ou é exatamente o centro (0), ou é infinitamente longe.
  const delta = x - med;
  if (delta === 0) return 0;
  return delta > 0 ? Infinity : -Infinity;
}

export interface ResultadoOutlier {
  /** Escore modificado (com sinal). */
  escore: number;
  /** |escore| > limiar. */
  outlier: boolean;
  /** Mediana usada como centro. */
  mediana: number;
  /** MAD (cru) usado como escala. */
  mad: number;
  /** Indica se o fallback IQR foi acionado (MAD == 0). */
  usouFallbackIqr: boolean;
  /** Limiar aplicado. */
  limiar: number;
}

/**
 * Conveniência: avalia se `x` é outlier face à distribuição `referencia`,
 * computando mediana/MAD/IQR internamente. Útil quando se tem o vetor à mão.
 */
export function avaliarOutlier(
  x: number,
  referencia: readonly number[],
  limiar: number = LIMIAR_IGLEWICZ_HOAGLIN,
): ResultadoOutlier {
  const med = mediana(referencia);
  const madVal = mad(referencia, med);
  const iqrVal = iqr(referencia);
  const escore = escoreIglewiczHoaglin(x, med, madVal, iqrVal);
  // NaN (entrada não-finita ou referência vazia) → indecidível: NÃO flaga, para
  // não transformar dado faltante/garbage em "outlier" falso-positivo. ±Infinity
  // (dispersão zero e x ≠ centro) é um outlier legítimo → flaga.
  const outlier = Number.isNaN(escore)
    ? false
    : Number.isFinite(escore)
      ? Math.abs(escore) > limiar
      : escore !== 0;
  return {
    escore,
    outlier,
    mediana: med,
    mad: madVal,
    usouFallbackIqr: !(Number.isFinite(madVal) && madVal > 0),
    limiar,
  };
}
