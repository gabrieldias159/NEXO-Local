/**
 * NEXO — Lei de Benford (Newcomb–Benford) para triagem de dados financeiros
 * (puro, sem I/O).
 *
 * Em conjuntos de números que crescem multiplicativamente e abrangem várias ordens
 * de grandeza (valores de empenhos, notas, contratos), o PRIMEIRO dígito significativo
 * não é uniforme: P(d) = log10(1 + 1/d). Logo o "1" abre ~30,1% das vezes e o "9"
 * apenas ~4,6%. Lançamentos fabricados/arredondados (números "redondos", limiares de
 * dispensa contornados, valores inventados) tendem a achatar essa curva.
 *
 * Conformidade pelo MAD de Nigrini (Mean Absolute Deviation — média das distâncias
 * |observado − esperado| entre proporções), com a tabela de corte consagrada
 * (Nigrini, 2012, "Benford's Law", tabela 7.1 para o 1º dígito):
 *   close       : MAD < 0.006
 *   acceptable  : MAD < 0.012
 *   marginal    : MAD < 0.015
 *   nonconformity: MAD ≥ 0.015
 *
 * ATENÇÃO ao poder estatístico: Benford só é informativa com amostra grande. Com n
 * pequeno o ruído amostral domina e o teste vira leitura de borra de café. Exigimos
 * n ≥ 50 (`N_MINIMO_BENFORD`) para emitir um veredito; abaixo disso devolvemos
 * `conformidade: 'amostra-insuficiente'` para o detector NÃO disparar alerta.
 */

export const N_MINIMO_BENFORD = 50;

/** Cortes de MAD de Nigrini (1º dígito). Limites superiores exclusivos. */
export const CORTES_MAD_NIGRINI = {
  close: 0.006,
  acceptable: 0.012,
  marginal: 0.015,
} as const;

export type Conformidade =
  | 'close'
  | 'acceptable'
  | 'marginal'
  | 'nonconformity'
  | 'amostra-insuficiente';

/** Probabilidades de Benford para o 1º dígito (d = 1..9): log10(1 + 1/d). */
export function esperadoPrimeiroDigito(): number[] {
  const p: number[] = [];
  for (let d = 1; d <= 9; d++) p.push(Math.log10(1 + 1 / d));
  return p;
}

/**
 * Probabilidades de Benford para o 2º dígito (d = 0..9):
 *   P(d) = Σ_{k=1..9} log10(1 + 1/(10k + d))
 */
export function esperadoSegundoDigito(): number[] {
  const p: number[] = [];
  for (let d = 0; d <= 9; d++) {
    let soma = 0;
    for (let k = 1; k <= 9; k++) soma += Math.log10(1 + 1 / (10 * k + d));
    p.push(soma);
  }
  return p;
}

/**
 * Primeiro dígito significativo de um número (1..9), ignorando sinal, zeros à
 * esquerda e a vírgula decimal. Retorna null para 0, não-finitos ou sem dígito.
 * Ex.: 0.0034 → 3 ; -91.5 → 9 ; 1000 → 1.
 */
export function primeiroDigito(x: number): number | null {
  if (!Number.isFinite(x) || x === 0) return null;
  let v = Math.abs(x);
  // Normaliza para [1,10) por potências de 10 (estável p/ magnitudes extremas).
  while (v < 1) v *= 10;
  while (v >= 10) v /= 10;
  const d = Math.floor(v);
  return d >= 1 && d <= 9 ? d : null;
}

/**
 * Segundo dígito significativo de um número (0..9). Para |x| com um único dígito
 * significativo (ex.: 5, 0.07) retorna null por não haver 2º dígito real.
 * Ex.: 12345 → 2 ; 0.0307 → 0 ; 90 → 0.
 */
export function segundoDigito(x: number): number | null {
  if (!Number.isFinite(x) || x === 0) return null;
  let v = Math.abs(x);
  while (v < 1) v *= 10;
  while (v >= 10) v /= 10;
  // v ∈ [1,10); o 2º dígito é o piso de (v*10) mod 10.
  const segundo = Math.floor(v * 10) % 10;
  return segundo >= 0 && segundo <= 9 ? segundo : null;
}

export interface DistribuicaoDigito {
  /** Rótulos dos dígitos na ordem das contagens. */
  digitos: number[];
  /** Contagens observadas por dígito (mesma ordem de `digitos`). */
  contagens: number[];
  /** Proporções observadas (contagem / n). */
  proporcoes: number[];
  /** Total de valores válidos considerados. */
  n: number;
}

function distribuicao(
  valores: readonly number[],
  digitos: number[],
  extrair: (x: number) => number | null,
): DistribuicaoDigito {
  const indice = new Map<number, number>();
  digitos.forEach((d, i) => indice.set(d, i));
  const contagens = new Array<number>(digitos.length).fill(0);
  let n = 0;
  for (const x of valores) {
    const d = extrair(x);
    if (d === null) continue;
    const i = indice.get(d);
    if (i === undefined) continue;
    contagens[i]++;
    n++;
  }
  const proporcoes = contagens.map((c) => (n > 0 ? c / n : 0));
  return { digitos: [...digitos], contagens, proporcoes, n };
}

/** Distribuição empírica do 1º dígito (1..9). */
export function distribuicaoPrimeiroDigito(valores: readonly number[]): DistribuicaoDigito {
  return distribuicao(valores, [1, 2, 3, 4, 5, 6, 7, 8, 9], primeiroDigito);
}

/** Distribuição empírica do 2º dígito (0..9). */
export function distribuicaoSegundoDigito(valores: readonly number[]): DistribuicaoDigito {
  return distribuicao(valores, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], segundoDigito);
}

/**
 * MAD de Nigrini: média de |observado − esperado| entre proporções.
 * `obs` e `esp` devem ter o mesmo comprimento e somar ~1 cada. NaN se vazios ou
 * de tamanhos diferentes.
 */
export function madDeNigrini(obs: readonly number[], esp: readonly number[]): number {
  if (obs.length === 0 || obs.length !== esp.length) return NaN;
  let soma = 0;
  for (let i = 0; i < obs.length; i++) soma += Math.abs(obs[i] - esp[i]);
  return soma / obs.length;
}

/** Classifica um MAD pela tabela de Nigrini. */
export function classificarConformidade(mad: number): Exclude<Conformidade, 'amostra-insuficiente'> {
  if (!Number.isFinite(mad)) return 'nonconformity';
  if (mad < CORTES_MAD_NIGRINI.close) return 'close';
  if (mad < CORTES_MAD_NIGRINI.acceptable) return 'acceptable';
  if (mad < CORTES_MAD_NIGRINI.marginal) return 'marginal';
  return 'nonconformity';
}

export interface AnaliseBenford {
  /** Rótulos dos dígitos avaliados. */
  digitos: number[];
  /** Proporções esperadas por Benford. */
  esperado: number[];
  /** Proporções observadas na amostra. */
  observado: number[];
  /** MAD de Nigrini (NaN se amostra insuficiente). */
  mad: number;
  /** Veredito de conformidade. */
  conformidade: Conformidade;
  /** Tamanho da amostra válida (valores com dígito extraível). */
  n: number;
}

/**
 * Análise de Benford do 1º dígito de `valores`.
 * Se n < `nMinimo`, devolve `conformidade: 'amostra-insuficiente'` e `mad: NaN`
 * (sem poder estatístico → não veredito).
 */
export function analisarBenford(
  valores: readonly number[],
  nMinimo: number = N_MINIMO_BENFORD,
): AnaliseBenford {
  const esperado = esperadoPrimeiroDigito();
  const dist = distribuicaoPrimeiroDigito(valores);
  if (dist.n < nMinimo) {
    return {
      digitos: dist.digitos,
      esperado,
      observado: dist.proporcoes,
      mad: NaN,
      conformidade: 'amostra-insuficiente',
      n: dist.n,
    };
  }
  const mad = madDeNigrini(dist.proporcoes, esperado);
  return {
    digitos: dist.digitos,
    esperado,
    observado: dist.proporcoes,
    mad,
    conformidade: classificarConformidade(mad),
    n: dist.n,
  };
}

/** Variante do 2º dígito (mesma semântica de poder e cortes). */
export function analisarBenfordSegundoDigito(
  valores: readonly number[],
  nMinimo: number = N_MINIMO_BENFORD,
): AnaliseBenford {
  const esperado = esperadoSegundoDigito();
  const dist = distribuicaoSegundoDigito(valores);
  if (dist.n < nMinimo) {
    return {
      digitos: dist.digitos,
      esperado,
      observado: dist.proporcoes,
      mad: NaN,
      conformidade: 'amostra-insuficiente',
      n: dist.n,
    };
  }
  const mad = madDeNigrini(dist.proporcoes, esperado);
  return {
    digitos: dist.digitos,
    esperado,
    observado: dist.proporcoes,
    mad,
    conformidade: classificarConformidade(mad),
    n: dist.n,
  };
}
