/**
 * NEXO — regressão de `prioridade.ts` (score triplo e comparadores).
 *
 * Protege os dois reclamos de qualidade do dono:
 *  - ranking por POTENCIAL desc (não por valor em R$);
 *  - régua de 4 faixas da 3ª perna (probabilidade de enquadramento).
 *
 * Auto-executável: `npx tsx prioridade.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scorePrioridade,
  compararPotencial,
  compararRecente,
  compararValor,
  derivarProbabilidadeEnquadramento,
} from '../prioridade';

// Fábrica de itens "ComScores" para os testes.
function item(opts: {
  conf?: number;
  pi?: number;
  pe?: number;
  data?: string | null;
  valor?: number;
}) {
  return {
    scores: {
      confiabilidade: opts.conf,
      probabilidadeIrregularidade: opts.pi,
      probabilidadeEnquadramento: opts.pe,
    },
    ultimaDeteccaoEm: opts.data ?? null,
    valorEnvolvido: opts.valor,
  };
}

// ── compararPotencial: ordena por score DESC ──────────────────────────────────

test('compararPotencial: ordena por score de prioridade DESC', () => {
  const alto = item({ conf: 90, pi: 90, pe: 90, data: '2026-03-15' }); // ~90
  const medio = item({ conf: 60, pi: 60, pe: 60, data: '2026-03-15' }); // ~60
  const baixo = item({ conf: 20, pi: 20, pe: 20, data: '2026-03-15' }); // ~20

  // Embaralhado de propósito; após sort deve ficar alto→medio→baixo.
  const ordenado = [baixo, alto, medio].slice().sort(compararPotencial);
  assert.deepEqual(ordenado, [alto, medio, baixo]);

  // E os scores estão de fato em ordem decrescente.
  for (let i = 1; i < ordenado.length; i++) {
    assert.ok(scorePrioridade(ordenado[i - 1]) >= scorePrioridade(ordenado[i]));
  }
});

test('compararPotencial: indício pequeno e crítico vem antes de valor grande fraco', () => {
  // O cerne do reclamo: NÃO ordenar por R$.
  const pequenoCritico = item({ conf: 95, pi: 90, pe: 90, data: '2026-03-15', valor: 5_000 });
  const grandeFraco = item({ conf: 30, pi: 20, pe: 30, data: '2026-03-15', valor: 9_000_000 });

  const [primeiro] = [grandeFraco, pequenoCritico].slice().sort(compararPotencial);
  assert.equal(primeiro, pequenoCritico);
  assert.ok(scorePrioridade(pequenoCritico) > scorePrioridade(grandeFraco));
});

test('compararPotencial: empate de score desempata por recência desc', () => {
  const recente = item({ conf: 70, pi: 70, pe: 70, data: '2026-05-01' });
  const antigo = item({ conf: 70, pi: 70, pe: 70, data: '2026-01-01' });
  // Mesmo score base, mesma recência-flag (ambos têm data) → desempate cronológico.
  const [primeiro] = [antigo, recente].slice().sort(compararPotencial);
  assert.equal(primeiro, recente);
});

// ── derivarProbabilidadeEnquadramento: as 4 faixas da régua ───────────────────

test('derivarProbabilidadeEnquadramento: faixa CRITICO (90 com fundamento, 70 sem)', () => {
  assert.equal(derivarProbabilidadeEnquadramento('critico', ['Lei 14.133/2021']), 90);
  assert.equal(derivarProbabilidadeEnquadramento('critico', []), 70);
  assert.equal(derivarProbabilidadeEnquadramento('critico', undefined), 70);
});

test('derivarProbabilidadeEnquadramento: faixa SUSPEITA (65 com fundamento, 52 sem)', () => {
  assert.equal(derivarProbabilidadeEnquadramento('suspeita', ['art. 24']), 65);
  assert.equal(derivarProbabilidadeEnquadramento('suspeita', []), 52);
});

test('derivarProbabilidadeEnquadramento: faixa ATENCAO (46 com fundamento, 40 sem)', () => {
  assert.equal(derivarProbabilidadeEnquadramento('atencao', ['princípio']), 46);
  assert.equal(derivarProbabilidadeEnquadramento('atencao', []), 40);
});

test('derivarProbabilidadeEnquadramento: faixa DEFAULT (32 órgão, 30 demais)', () => {
  // informativo ou classificação desconhecida cai no default.
  assert.equal(derivarProbabilidadeEnquadramento('informativo', [], 'orgao'), 32);
  assert.equal(derivarProbabilidadeEnquadramento('informativo', [], 'fornecedor'), 30);
  assert.equal(derivarProbabilidadeEnquadramento('informativo', []), 30);
  // Classificação fora do enum também cai no default.
  assert.equal(derivarProbabilidadeEnquadramento('inexistente', ['x'], 'orgao'), 32);
  assert.equal(derivarProbabilidadeEnquadramento(undefined, undefined), 30);
});

test('derivarProbabilidadeEnquadramento: faixas em ordem decrescente de severidade', () => {
  const critico = derivarProbabilidadeEnquadramento('critico', ['l']);
  const suspeita = derivarProbabilidadeEnquadramento('suspeita', ['l']);
  const atencao = derivarProbabilidadeEnquadramento('atencao', ['l']);
  const def = derivarProbabilidadeEnquadramento('informativo', ['l']);
  assert.ok(critico > suspeita && suspeita > atencao && atencao > def);
});

// ── scorePrioridade: monotonicidade ───────────────────────────────────────────

test('scorePrioridade: monotônica crescente em cada perna', () => {
  const base = item({ conf: 50, pi: 50, pe: 50, data: '2026-03-15' });
  const maisConf = item({ conf: 80, pi: 50, pe: 50, data: '2026-03-15' });
  const maisPI = item({ conf: 50, pi: 80, pe: 50, data: '2026-03-15' });
  const maisPE = item({ conf: 50, pi: 50, pe: 80, data: '2026-03-15' });

  assert.ok(scorePrioridade(maisConf) > scorePrioridade(base));
  assert.ok(scorePrioridade(maisPI) > scorePrioridade(base));
  assert.ok(scorePrioridade(maisPE) > scorePrioridade(base));
});

test('scorePrioridade: qualquer perna ZERO derruba o score a 0 (média geométrica)', () => {
  const semIrreg = item({ conf: 100, pi: 0, pe: 100, data: '2026-03-15' });
  assert.equal(scorePrioridade(semIrreg), 0);
});

test('scorePrioridade: bônus de recência — com data > sem data, tudo igual', () => {
  const comData = item({ conf: 70, pi: 70, pe: 70, data: '2026-03-15' });
  const semData = item({ conf: 70, pi: 70, pe: 70, data: null });
  assert.ok(scorePrioridade(comData) > scorePrioridade(semData));
  // O bônus é o fator 1 vs 0.9.
  assert.ok(
    Math.abs(scorePrioridade(semData) - scorePrioridade(comData) * 0.9) < 1e-9,
  );
});

test('scorePrioridade: 3ª perna ausente usa default 50 (não 0)', () => {
  const semPE = {
    scores: { confiabilidade: 80, probabilidadeIrregularidade: 80 },
    ultimaDeteccaoEm: '2026-03-15',
  };
  // Se default fosse 0, a média geométrica zeraria; tem que ser > 0.
  assert.ok(scorePrioridade(semPE) > 0);
  const comPE50 = item({ conf: 80, pi: 80, pe: 50, data: '2026-03-15' });
  assert.ok(Math.abs(scorePrioridade(semPE) - scorePrioridade(comPE50)) < 1e-9);
});

// ── compararRecente / compararValor (comportamentos auxiliares) ───────────────

test('compararRecente: mais recente primeiro; desempate por valor desc', () => {
  const recente = item({ data: '2026-05-01', valor: 100 });
  const antigo = item({ data: '2026-01-01', valor: 999 });
  assert.ok(compararRecente(recente, antigo) < 0); // recente vem antes

  const mesmaDataMaiorValor = item({ data: '2026-05-01', valor: 1000 });
  const mesmaDataMenorValor = item({ data: '2026-05-01', valor: 10 });
  assert.ok(compararRecente(mesmaDataMaiorValor, mesmaDataMenorValor) < 0);
});

test('compararValor: maior valor primeiro (comportamento legado)', () => {
  const grande = item({ valor: 1_000_000 });
  const pequeno = item({ valor: 1 });
  const [primeiro] = [pequeno, grande].slice().sort(compararValor);
  assert.equal(primeiro, grande);
});
