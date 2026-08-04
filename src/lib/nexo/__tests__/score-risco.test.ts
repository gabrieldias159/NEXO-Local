/**
 * NEXO — regressão de `score-risco.ts` (score de risco ÚNICO e coerente).
 *
 * Protege o que o conselho exigiu (docs/nexo-hipersistema-conselho.md §15.3):
 * a MESMA régua de score em TODAS as telas. O teste-âncora é a COERÊNCIA com
 * `scorePrioridade` (a fórmula que ordena as listas) e a DERIVAÇÃO da 3ª perna
 * (em vez do flat 50 que causava ranking divergente entre /alertas, /analise e
 * o cron gerente).
 *
 * Auto-executável: `npx tsx score-risco.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreRiscoEntidade,
  resolverProbabilidadeEnquadramento,
} from '../score-risco';
import {
  scorePrioridade,
  derivarProbabilidadeEnquadramento,
} from '../prioridade';

// ── Coerência com a fórmula única (scorePrioridade) ───────────────────────────

test('scoreRiscoEntidade: usa A MESMA fórmula de scorePrioridade (zero divergência)', () => {
  // 3ª perna presente → o score TEM de bater exatamente com scorePrioridade.
  const entrada = {
    scores: { confiabilidade: 80, probabilidadeIrregularidade: 70, probabilidadeEnquadramento: 60 },
    ultimaDeteccaoEm: '2026-03-15',
    valorEnvolvido: 1000,
  };
  const r = scoreRiscoEntidade(entrada);
  assert.equal(r.score, scorePrioridade(entrada));
});

test('scoreRiscoEntidade: 3ª perna AUSENTE é derivada (não vira default 50)', () => {
  // Indício crítico COM fundamento → régua jurídica deriva 90, não 50.
  const entrada = {
    scores: { confiabilidade: 80, probabilidadeIrregularidade: 80 },
    classificacao: 'critico',
    fundamentoLegal: ['Lei 14.133/2021'],
    ultimaDeteccaoEm: '2026-03-15',
  };
  const r = scoreRiscoEntidade(entrada);

  // O score deve igualar o de uma entrada com a 3ª perna explicitamente = 90.
  const esperado = scorePrioridade({
    scores: { confiabilidade: 80, probabilidadeIrregularidade: 80, probabilidadeEnquadramento: 90 },
    ultimaDeteccaoEm: '2026-03-15',
  });
  assert.equal(r.score, esperado);

  // E DEVE diferir do velho comportamento default-50 (a fonte da divergência).
  const comDefault50 = scorePrioridade({
    scores: { confiabilidade: 80, probabilidadeIrregularidade: 80, probabilidadeEnquadramento: 50 },
    ultimaDeteccaoEm: '2026-03-15',
  });
  assert.ok(r.score > comDefault50, 'derivar 90 deve dar score MAIOR que o flat 50');
});

test('scoreRiscoEntidade: coerência entre telas — mesmo indício, mesmo score', () => {
  // Simula o MESMO alerta visto por /alertas (3ª perna já derivada/persistida)
  // e por /analise (alerta cru do detector, SEM a 3ª perna). Ambos têm de cair
  // no MESMO score — esse é o reclamo que o módulo resolve.
  const cru = {
    scores: { confiabilidade: 76, probabilidadeIrregularidade: 62 },
    classificacao: 'suspeita',
    fundamentoLegal: ['Lei 14.133/2021 art. 75'],
    ultimaDeteccaoEm: '2026-04-01',
  };
  const pe = derivarProbabilidadeEnquadramento('suspeita', ['Lei 14.133/2021 art. 75']);
  const jaPersistido = {
    scores: { confiabilidade: 76, probabilidadeIrregularidade: 62, probabilidadeEnquadramento: pe },
    classificacao: 'suspeita',
    fundamentoLegal: ['Lei 14.133/2021 art. 75'],
    ultimaDeteccaoEm: '2026-04-01',
  };
  assert.equal(scoreRiscoEntidade(cru).score, scoreRiscoEntidade(jaPersistido).score);
});

// ── resolverProbabilidadeEnquadramento: origem detector vs derivada ──────────

test('resolverProbabilidadeEnquadramento: presente → origem detector, valor preservado', () => {
  const r = resolverProbabilidadeEnquadramento({
    scores: { probabilidadeEnquadramento: 73 },
    classificacao: 'critico',
  });
  assert.deepEqual(r, { valor: 73, origem: 'detector' });
});

test('resolverProbabilidadeEnquadramento: ausente → derivada da régua jurídica', () => {
  const r = resolverProbabilidadeEnquadramento({
    classificacao: 'critico',
    fundamentoLegal: ['Lei 14.133/2021'],
  });
  assert.equal(r.origem, 'derivada');
  assert.equal(r.valor, derivarProbabilidadeEnquadramento('critico', ['Lei 14.133/2021']));
});

test('resolverProbabilidadeEnquadramento: clampa valor do detector a 0..100', () => {
  assert.equal(resolverProbabilidadeEnquadramento({ scores: { probabilidadeEnquadramento: 140 } }).valor, 100);
  assert.equal(resolverProbabilidadeEnquadramento({ scores: { probabilidadeEnquadramento: -10 } }).valor, 0);
});

// ── Explicação das 3 pernas ───────────────────────────────────────────────────

test('scoreRiscoEntidade: explica as 3 pernas com valor e origem', () => {
  const r = scoreRiscoEntidade({
    scores: { confiabilidade: 80, probabilidadeIrregularidade: 70 },
    classificacao: 'atencao',
    fundamentoLegal: ['princípio'],
    sujeitoTipo: 'fornecedor',
  });
  assert.equal(r.pernas.length, 3);

  const [conf, pi, pe] = r.pernas;
  assert.deepEqual(
    { chave: conf.chave, valor: conf.valor, origem: conf.origem },
    { chave: 'confiabilidade', valor: 80, origem: 'detector' },
  );
  assert.deepEqual(
    { chave: pi.chave, valor: pi.valor, origem: pi.origem },
    { chave: 'probabilidadeIrregularidade', valor: 70, origem: 'detector' },
  );
  // 3ª perna derivada (atencao+fundamento = 46) marcada como 'derivada'.
  assert.equal(pe.chave, 'probabilidadeEnquadramento');
  assert.equal(pe.valor, derivarProbabilidadeEnquadramento('atencao', ['princípio'], 'fornecedor'));
  assert.equal(pe.origem, 'derivada');
  assert.equal(r.enquadramentoDerivado, true);
});

test('scoreRiscoEntidade: 3ª perna do detector NÃO é marcada como derivada', () => {
  const r = scoreRiscoEntidade({
    scores: { confiabilidade: 80, probabilidadeIrregularidade: 70, probabilidadeEnquadramento: 65 },
  });
  assert.equal(r.enquadramentoDerivado, false);
  assert.equal(r.pernas[2].origem, 'detector');
  assert.equal(r.pernas[2].valor, 65);
});

// ── Degradação honesta e robustez numérica ────────────────────────────────────

test('scoreRiscoEntidade: pernas ausentes degradam (conf/pi → 0; pe → derivada)', () => {
  // Sem scores algum, classificação desconhecida → conf=0, pi=0 → score 0
  // (média geométrica com perna zero). A 3ª perna ainda é derivada (default 30).
  const r = scoreRiscoEntidade({});
  assert.equal(r.pernas[0].valor, 0);
  assert.equal(r.pernas[1].valor, 0);
  assert.equal(r.pernas[2].valor, 30); // default da régua p/ não-orgão
  assert.equal(r.score, 0); // qualquer perna zero zera o composto
});

test('scoreRiscoEntidade: valores NaN/inválidos viram 0 (não quebram o score)', () => {
  const r = scoreRiscoEntidade({
    scores: {
      confiabilidade: Number.NaN,
      probabilidadeIrregularidade: 80,
      probabilidadeEnquadramento: Number.NaN,
    },
    classificacao: 'suspeita',
    fundamentoLegal: ['x'],
  });
  // confiabilidade NaN → 0 → score 0; pe NaN → derivada (suspeita+fund = 65).
  assert.equal(r.pernas[0].valor, 0);
  assert.equal(r.pernas[2].valor, derivarProbabilidadeEnquadramento('suspeita', ['x']));
  assert.equal(r.pernas[2].origem, 'derivada');
  assert.equal(r.score, 0);
});

test('scoreRiscoEntidade: clampa pernas do detector a 0..100', () => {
  const r = scoreRiscoEntidade({
    scores: { confiabilidade: 150, probabilidadeIrregularidade: -5, probabilidadeEnquadramento: 60 },
    ultimaDeteccaoEm: '2026-03-15',
  });
  assert.equal(r.pernas[0].valor, 100);
  assert.equal(r.pernas[1].valor, 0);
});

// ── Bônus de recência (herda de scorePrioridade) ──────────────────────────────

test('scoreRiscoEntidade: bônus de recência herdado — com data > sem data', () => {
  const base = {
    scores: { confiabilidade: 70, probabilidadeIrregularidade: 70, probabilidadeEnquadramento: 70 },
  };
  const comData = scoreRiscoEntidade({ ...base, ultimaDeteccaoEm: '2026-03-15' }).score;
  const semData = scoreRiscoEntidade({ ...base, ultimaDeteccaoEm: null }).score;
  assert.ok(comData > semData);
});
