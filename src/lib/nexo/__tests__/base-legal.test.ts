/**
 * NEXO — regressão do CRIVO LEGAL (`base-legal.ts`).
 *
 * Protege dois requisitos do dono:
 *  1. o mapeamento PREFIXO do detectorId → normas aplicáveis (família de achado);
 *  2. o invariante INEGOCIÁVEL: o crivo NUNCA injeta/propaga a Lei 8.429/1992
 *     (improbidade) como AFIRMAÇÃO — só como hipótese "a apurar".
 *
 * Auto-executável: `npx tsx src/lib/nexo/__tests__/base-legal.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type AlertaCrivoLike,
  BASE_LEGAL,
  enriquecerCrivoLegal,
  normaPorId,
  normasPorDetector,
  normasPorTema,
} from '../base-legal';

// ── Catálogo: integridade básica ──────────────────────────────────────────────

test('catálogo: ids únicos e não vazios', () => {
  const ids = BASE_LEGAL.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'ids duplicados no catálogo');
  for (const n of BASE_LEGAL) {
    assert.ok(n.titulo.length > 0, `${n.id} sem título`);
    assert.ok(n.ementaCurta.length > 0, `${n.id} sem ementa`);
    assert.ok(n.artigosRelevantes.length > 0, `${n.id} sem artigos`);
    assert.ok(n.temas.length > 0, `${n.id} sem temas`);
  }
});

test('catálogo: as normas-chave pedidas estão presentes', () => {
  for (const id of [
    'lei-14133-2021',
    'lei-4320-1964',
    'lc-101-2000',
    'lei-12527-2011',
    'lei-12846-2013',
    'lei-8429-1992',
    'lei-9504-1997',
    'cf-1988',
    'lom-marilia',
  ]) {
    assert.ok(normaPorId(id), `faltou ${id} no catálogo`);
  }
});

test('8.429 está marcada como apenasAApurar', () => {
  const n = normaPorId('lei-8429-1992');
  assert.ok(n);
  assert.equal(n!.apenasAApurar, true);
});

// ── (2) normasPorDetector — mapeamento por PREFIXO ────────────────────────────

test('LC → 14.133', () => {
  const ids = normasPorDetector('LC-01').map((n) => n.id);
  assert.deepEqual(ids, ['lei-14133-2021']);
});

test('OR → 4.320', () => {
  const ids = normasPorDetector('OR-03').map((n) => n.id);
  assert.deepEqual(ids, ['lei-4320-1964']);
});

test('MF → LRF (LC 101/2000)', () => {
  const ids = normasPorDetector('MF-07').map((n) => n.id);
  assert.deepEqual(ids, ['lc-101-2000']);
});

test('FR → 14.133 + 12.846 (anticorrupção)', () => {
  const ids = normasPorDetector('FR-04').map((n) => n.id);
  assert.deepEqual(ids, ['lei-14133-2021', 'lei-12846-2013']);
});

test('DE → LOM (requisição) + 14.133', () => {
  const ids = normasPorDetector('DE-03').map((n) => n.id);
  assert.deepEqual(ids, ['lom-marilia', 'lei-14133-2021']);
});

test('XS e X2 → LAI + LRF', () => {
  assert.deepEqual(
    normasPorDetector('XS-10').map((n) => n.id),
    ['lei-12527-2011', 'lc-101-2000'],
  );
  assert.deepEqual(
    normasPorDetector('X2-01').map((n) => n.id),
    ['lei-12527-2011', 'lc-101-2000'],
  );
});

test('contexto eleitoral acrescenta a 9.504 de forma aditiva', () => {
  // Um detector de família frota/saúde com gatilho eleitoral no id.
  const ids = normasPorDetector('FC-eleitoral').map((n) => n.id);
  assert.ok(ids.includes('lei-9504-1997'), 'esperava 9.504 pelo gatilho eleitoral');
  assert.ok(ids.includes('lei-14133-2021'), 'manteve a família do prefixo FC');
});

test('EM (contratações emergenciais) → 14.133 (art. 75)', () => {
  const ids = normasPorDetector('EM-01').map((n) => n.id);
  assert.deepEqual(ids, ['lei-14133-2021']);
});

test('detector desconhecido → [] (não inventa lei)', () => {
  assert.deepEqual(normasPorDetector('ZZ-99'), []);
  assert.deepEqual(normasPorDetector(''), []);
});

test('normasPorDetector é tolerante a id sem traço/minúsculo', () => {
  assert.deepEqual(
    normasPorDetector('lc-01').map((n) => n.id),
    ['lei-14133-2021'],
  );
});

// ── normasPorTema ─────────────────────────────────────────────────────────────

test('normasPorTema(aditivo) traz a 14.133', () => {
  const ids = normasPorTema('aditivo').map((n) => n.id);
  assert.ok(ids.includes('lei-14133-2021'));
});

test('normasPorTema(improbidade) traz só a 8.429 (que é apenasAApurar)', () => {
  const ns = normasPorTema('improbidade');
  assert.deepEqual(ns.map((n) => n.id), ['lei-8429-1992']);
  assert.equal(ns[0].apenasAApurar, true);
});

// ── (3) enriquecerCrivoLegal — preenche vazio, preserva existente ─────────────

test('preenche fundamentoLegal vazio a partir do detectorId', () => {
  const out = enriquecerCrivoLegal({ detectorId: 'LC-01', fundamentoLegal: [] });
  assert.ok(out.fundamentoLegal!.length > 0);
  assert.ok(out.fundamentoLegal!.some((c) => /14\.133/.test(c)));
});

test('preenche quando fundamentoLegal está ausente (undefined)', () => {
  const alerta: AlertaCrivoLike = { detectorId: 'OR-01' };
  const out = enriquecerCrivoLegal(alerta);
  assert.ok(out.fundamentoLegal!.some((c) => /4\.320/.test(c)));
});

test('preserva o fundamento que o detector já trouxe (não sobrescreve)', () => {
  const existente = ['Lei 14.133/2021, art. 125'];
  const out = enriquecerCrivoLegal({ detectorId: 'LC-19', fundamentoLegal: existente });
  assert.deepEqual(out.fundamentoLegal, existente);
});

test('detector desconhecido com fundamento vazio → permanece vazio', () => {
  const out = enriquecerCrivoLegal({ detectorId: 'ZZ-99', fundamentoLegal: [] });
  assert.deepEqual(out.fundamentoLegal, []);
});

test('não muta o alerta original', () => {
  const alerta = { detectorId: 'LC-01', fundamentoLegal: [] as string[] };
  const out = enriquecerCrivoLegal(alerta);
  assert.notEqual(out, alerta, 'deveria devolver cópia');
  assert.deepEqual(alerta.fundamentoLegal, [], 'original foi mutado');
});

// ── REGRA ANTI-8.429-AFIRMATIVO (invariante inegociável) ──────────────────────

test('NUNCA injeta 8.429 ao preencher um achado vazio (mesmo família FR)', () => {
  const out = enriquecerCrivoLegal({ detectorId: 'FR-04', fundamentoLegal: [] });
  assert.ok(
    !out.fundamentoLegal!.some((c) => /8\.?429|improbidade/i.test(c)),
    'o crivo injetou improbidade — proibido',
  );
  // mas trouxe a família correta (14.133 + anticorrupção 12.846)
  assert.ok(out.fundamentoLegal!.some((c) => /14\.133/.test(c)));
  assert.ok(out.fundamentoLegal!.some((c) => /12\.846/.test(c)));
});

test('REMOVE afirmação de improbidade já presente no fundamento', () => {
  const out = enriquecerCrivoLegal({
    detectorId: 'OR-01',
    fundamentoLegal: ['Lei 4.320/1964, art. 63', 'Lei 8.429/1992, art. 10 (dano ao erário)'],
  });
  // a citação afirmativa de 8.429 foi removida...
  assert.ok(!out.fundamentoLegal!.some((c) => /8\.?429/.test(c)));
  // ...e o resto do fundamento foi preservado verbatim.
  assert.ok(out.fundamentoLegal!.includes('Lei 4.320/1964, art. 63'));
});

test('PRESERVA menção a 8.429 quando vem com ressalva "a apurar"', () => {
  const ressalva = 'Lei 8.429/1992, art. 10 — a apurar (depende de dolo)';
  const out = enriquecerCrivoLegal({
    detectorId: 'OR-01',
    fundamentoLegal: [ressalva],
  });
  assert.ok(
    out.fundamentoLegal!.includes(ressalva),
    'hipótese "a apurar" deve ser preservada, não removida',
  );
});

test('quando só havia afirmação de 8.429, deriva do detector (sem propagá-la)', () => {
  const out = enriquecerCrivoLegal({
    detectorId: 'LC-01',
    fundamentoLegal: ['Lei 8.429/1992 — improbidade configurada'],
  });
  // removeu a afirmação proibida e caiu na derivação por detector
  assert.ok(!out.fundamentoLegal!.some((c) => /8\.?429|improbidade/i.test(c)));
  assert.ok(out.fundamentoLegal!.some((c) => /14\.133/.test(c)));
});
