/**
 * NEXO — regressão da camada de estatística robusta + Benford (puras, sem I/O).
 *
 * Cobre:
 *  - mediana/MAD em vetores conhecidos (valores fechados, conferidos à mão);
 *  - Iglewicz–Hoaglin detecta um outlier óbvio que "média+2σ" mascararia;
 *  - fallback IQR quando MAD = 0 (muitos valores repetidos);
 *  - Benford reconhece uma série Benford-conforme vs. uma uniforme;
 *  - guarda de poder estatístico (n < 50 → amostra-insuficiente).
 *
 * Auto-executável: `npx tsx src/lib/nexo/__tests__/estatistica.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mediana,
  mad,
  iqr,
  quantil,
  escoreIglewiczHoaglin,
  avaliarOutlier,
  FATOR_CONSISTENCIA_MAD,
} from '../estatistica/robusto';
import {
  primeiroDigito,
  segundoDigito,
  esperadoPrimeiroDigito,
  esperadoSegundoDigito,
  distribuicaoPrimeiroDigito,
  madDeNigrini,
  classificarConformidade,
  analisarBenford,
  N_MINIMO_BENFORD,
} from '../estatistica/benford';

// ── mediana ───────────────────────────────────────────────────────────────────

test('mediana: vetor ímpar = valor central; ordena antes', () => {
  assert.equal(mediana([3, 1, 2]), 2);
  assert.equal(mediana([7, 1, 3, 9, 5]), 5);
});

test('mediana: vetor par = média dos dois centrais', () => {
  assert.equal(mediana([1, 2, 3, 4]), 2.5);
  assert.equal(mediana([10, 2, 8, 4]), 6); // ordenado: 2,4,8,10 → (4+8)/2
});

test('mediana: ignora não-finitos; vazio → NaN', () => {
  assert.equal(mediana([1, NaN, 3, Infinity, 5]), 3);
  assert.ok(Number.isNaN(mediana([])));
});

// ── MAD ───────────────────────────────────────────────────────────────────────

test('mad: vetor conhecido — mediana das distâncias à mediana', () => {
  // xs = [1,2,3,4,5] → med=3 ; desvios |x-3| = [2,1,0,1,2] → med=1
  assert.equal(mad([1, 2, 3, 4, 5]), 1);
});

test('mad: outro vetor fechado', () => {
  // xs = [2,4,6,8] → med=5 ; |x-5| = [3,1,1,3] (ord 1,1,3,3) → med=2
  assert.equal(mad([2, 4, 6, 8]), 2);
});

test('mad: todos iguais → 0; vazio → NaN', () => {
  assert.equal(mad([7, 7, 7, 7]), 0);
  assert.ok(Number.isNaN(mad([])));
});

// ── quantil / IQR ─────────────────────────────────────────────────────────────

test('quantil: interpolação linear (R-7) em pontos conhecidos', () => {
  const xs = [1, 2, 3, 4, 5];
  assert.equal(quantil(xs, 0), 1);
  assert.equal(quantil(xs, 1), 5);
  assert.equal(quantil(xs, 0.5), 3);
  assert.equal(quantil(xs, 0.25), 2);
  assert.equal(quantil(xs, 0.75), 4);
});

test('iqr: Q3 − Q1', () => {
  assert.equal(iqr([1, 2, 3, 4, 5]), 2); // 4 - 2
});

// ── Iglewicz–Hoaglin ──────────────────────────────────────────────────────────

test('escoreIglewiczHoaglin: fórmula 0.6745*(x-med)/MAD', () => {
  // med=3, MAD=1 → Z(x) = 0.6745*(x-3)
  assert.ok(Math.abs(escoreIglewiczHoaglin(5, 3, 1) - FATOR_CONSISTENCIA_MAD * 2) < 1e-12);
  assert.equal(escoreIglewiczHoaglin(3, 3, 1), 0); // no centro → 0
  assert.ok(escoreIglewiczHoaglin(1, 3, 1) < 0); // abaixo do centro → negativo
});

test('Iglewicz detecta outlier óbvio que média+2σ MASCARARIA', () => {
  // Cenário CLÁSSICO de mascaramento: ~30 valores normais perto de 10 e um GRUPO
  // de 10 contaminantes grandes (500..1580). O grupo infla σ a ponto de cada
  // contaminante individual cair DENTRO de ±2σ — a fraude grande some por ser
  // grande. A mediana/MAD, robustas, ignoram o grupo e os denunciam.
  const normais = Array.from({ length: 30 }, (_, i) => 9 + (i % 3)); // 9..11
  const contaminantes = Array.from({ length: 10 }, (_, i) => 500 + i * 120); // 500..1580
  const dados = [...normais, ...contaminantes];
  const suspeito = 500; // o menor contaminante: o mais fácil de mascarar

  // --- método ingênuo (média + 2σ) MASCARA o contaminante ---
  const mu = dados.reduce((a, b) => a + b, 0) / dados.length;
  const sigma = Math.sqrt(
    dados.reduce((a, b) => a + (b - mu) ** 2, 0) / dados.length,
  );
  const zClassico = Math.abs(suspeito - mu) / sigma;
  assert.ok(zClassico < 2, `classico deveria mascarar, mas |z|=${zClassico}`);

  // --- Iglewicz–Hoaglin PEGA o contaminante ---
  const r = avaliarOutlier(suspeito, dados);
  assert.equal(r.outlier, true);
  assert.ok(Math.abs(r.escore) > 3.5);
  assert.equal(r.usouFallbackIqr, false);

  // e um ponto normal NÃO é flagado.
  assert.equal(avaliarOutlier(10, dados).outlier, false);
});

test('Iglewicz: fallback IQR quando MAD = 0 (muitos repetidos)', () => {
  // Maioria (8 de 15) exatamente em 100 → mediana=100 e MAD=0; mas há cauda
  // suficiente para o IQR ser > 0. O fallback IQR mantém o escore finito e ainda
  // denuncia o 500.
  const dados = [40, 50, 60, 70, 100, 100, 100, 100, 100, 100, 100, 100, 300, 400, 500];
  const r = avaliarOutlier(500, dados);
  assert.equal(r.mediana, 100);
  assert.equal(r.mad, 0);
  assert.equal(r.usouFallbackIqr, true);
  assert.ok(Number.isFinite(r.escore));
  assert.equal(r.outlier, true);

  // ponto na própria mediana não é outlier mesmo no fallback.
  assert.equal(avaliarOutlier(100, dados).outlier, false);
});

test('Iglewicz: MAD=0 e IQR=0 (constante absoluta) → centro 0, fora ±Infinity', () => {
  const constante = Array.from({ length: 8 }, () => 42);
  assert.equal(escoreIglewiczHoaglin(42, 42, 0, 0), 0);
  assert.equal(escoreIglewiczHoaglin(99, 42, 0, 0), Infinity);
  // via avaliarOutlier: valor diferente do centro absoluto é outlier.
  assert.equal(avaliarOutlier(99, constante).outlier, true);
  assert.equal(avaliarOutlier(42, constante).outlier, false);
});

test('Iglewicz: escore NaN (x não-finito / referência vazia) NÃO flaga outlier', () => {
  // Dado faltante/garbage não pode virar "outlier" falso-positivo: escore NaN é
  // indecidível e deve resultar em outlier:false (≠ do caso ±Infinity legítimo).
  const rNaN = avaliarOutlier(NaN, [1, 2, 3, 4, 5]);
  assert.ok(Number.isNaN(rNaN.escore));
  assert.equal(rNaN.outlier, false);

  const rInf = avaliarOutlier(Infinity, [1, 2, 3, 4, 5]);
  assert.ok(Number.isNaN(rInf.escore)); // x não-finito → escore NaN
  assert.equal(rInf.outlier, false);

  const rVazio = avaliarOutlier(10, []); // referência vazia → mediana NaN
  assert.ok(Number.isNaN(rVazio.escore));
  assert.equal(rVazio.outlier, false);
});

// ── Benford: extração de dígitos ──────────────────────────────────────────────

test('primeiroDigito: ignora sinal, zeros à esquerda e vírgula', () => {
  assert.equal(primeiroDigito(0.0034), 3);
  assert.equal(primeiroDigito(-91.5), 9);
  assert.equal(primeiroDigito(1000), 1);
  assert.equal(primeiroDigito(0), null);
  assert.equal(primeiroDigito(NaN), null);
});

test('segundoDigito: 2º significativo (0..9)', () => {
  assert.equal(segundoDigito(12345), 2);
  assert.equal(segundoDigito(0.0307), 0);
  assert.equal(segundoDigito(90), 0);
  assert.equal(segundoDigito(0), null);
});

test('esperadoPrimeiroDigito: soma 1 e P(1)≈0.301, P(9)≈0.046', () => {
  const e = esperadoPrimeiroDigito();
  assert.equal(e.length, 9);
  assert.ok(Math.abs(e.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(e[0] - 0.30103) < 1e-4);
  assert.ok(Math.abs(e[8] - 0.04576) < 1e-4);
});

test('esperadoSegundoDigito: 10 entradas que somam 1', () => {
  const e = esperadoSegundoDigito();
  assert.equal(e.length, 10);
  assert.ok(Math.abs(e.reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

// ── Benford: madDeNigrini + tabela de conformidade ────────────────────────────

test('madDeNigrini: média das distâncias absolutas entre proporções', () => {
  assert.equal(madDeNigrini([0.5, 0.5], [0.5, 0.5]), 0);
  // |0.3-0.2| + |0.7-0.8| = 0.2 ; /2 = 0.1
  assert.ok(Math.abs(madDeNigrini([0.3, 0.7], [0.2, 0.8]) - 0.1) < 1e-12);
  assert.ok(Number.isNaN(madDeNigrini([], [])));
});

test('classificarConformidade: cortes de Nigrini', () => {
  assert.equal(classificarConformidade(0.003), 'close');
  assert.equal(classificarConformidade(0.006), 'acceptable'); // limite superior exclusivo
  assert.equal(classificarConformidade(0.01), 'acceptable');
  assert.equal(classificarConformidade(0.012), 'marginal');
  assert.equal(classificarConformidade(0.014), 'marginal');
  assert.equal(classificarConformidade(0.015), 'nonconformity');
  assert.equal(classificarConformidade(0.2), 'nonconformity');
});

// ── Benford: conforme vs. uniforme ────────────────────────────────────────────

/**
 * Série Benford-conforme: progressão geométrica espalhada por muitas ordens de
 * grandeza. A distribuição de mantissas de log10 fica ~uniforme, então os
 * primeiros dígitos seguem Benford de perto. Determinístico (sem RNG).
 */
function serieBenford(n: number): number[] {
  const xs: number[] = [];
  // razão irracional para não cair em ciclo de dígitos; começa em 1.
  const r = Math.sqrt(2); // ≈1.4142
  let v = 1;
  for (let i = 0; i < n; i++) {
    xs.push(v);
    v *= r;
  }
  return xs;
}

/** Série uniforme em [100, 999]: todos os 1ºs dígitos ~igualmente prováveis. */
function serieUniforme(n: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    // varredura determinística e densa do intervalo [100,1000).
    xs.push(100 + ((i * 900) / n));
  }
  return xs;
}

test('Benford: série geométrica é reconhecida como conforme', () => {
  const a = analisarBenford(serieBenford(400));
  assert.equal(a.n, 400);
  assert.ok(a.mad < 0.015, `MAD=${a.mad} deveria indicar conformidade`);
  assert.notEqual(a.conformidade, 'nonconformity');
  assert.notEqual(a.conformidade, 'amostra-insuficiente');
});

test('Benford: série UNIFORME é reconhecida como NÃO conforme', () => {
  const a = analisarBenford(serieUniforme(400));
  assert.equal(a.n, 400);
  // distribuição uniforme afasta-se muito de Benford → MAD alto.
  assert.ok(a.mad >= 0.015, `MAD=${a.mad} deveria reprovar a uniforme`);
  assert.equal(a.conformidade, 'nonconformity');

  // sanidade: o 1º dígito da uniforme é bem mais "achatado" que o de Benford.
  const dist = distribuicaoPrimeiroDigito(serieUniforme(400));
  const esp = esperadoPrimeiroDigito();
  // Benford prevê ~30% no dígito 1; a uniforme fica perto de ~11%.
  assert.ok(dist.proporcoes[0] < esp[0] - 0.1);
});

test('Benford: amostra pequena (< 50) → veredito de poder insuficiente', () => {
  const a = analisarBenford(serieBenford(N_MINIMO_BENFORD - 1));
  assert.equal(a.conformidade, 'amostra-insuficiente');
  assert.ok(Number.isNaN(a.mad));
  assert.ok(a.n < N_MINIMO_BENFORD);
});
