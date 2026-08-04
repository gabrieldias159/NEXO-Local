/**
 * NEXO — regressão de `entity-detect.ts` (detecção de documentos em texto).
 *
 * Cobre a base do entity-chip universal: pescar CNPJ/CPF VÁLIDOS (Módulo 11) em
 * texto livre, descartar lixo numérico (código TCE, protocolo), preservar o
 * texto VERBATIM (nenhum caractere perdido) e — guardrail LGPD crítico — NUNCA
 * resolver RG a dado pessoal (só destacar, sem dígitos, sem `valido`).
 *
 * Auto-executável: `npx tsx entity-detect.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectarEntidades,
  temEntidade,
  type SegmentoEntidade,
} from '../entity-detect';

// ── Documentos de teste (Módulo 11 confirmado em entidades.test.ts) ───────────
const CNPJ_VALIDO = '11222333000181';
const CNPJ_VALIDO_FMT = '11.222.333/0001-81';
const CNPJ_INVALIDO = '11222333000180'; // dígito verificador errado
const CPF_VALIDO = '77515872020';
const CPF_VALIDO_FMT = '775.158.720-20';
const CPF_INVALIDO = '12345678901'; // não passa no Módulo 11
const LIXO_TCE = '605238'; // código interno de 6 dígitos
const PROTOCOLO = '202600001234567'; // 15 dígitos — nem CPF nem CNPJ

/** Reconstrói a entrada concatenando os `texto` — invariante de não-perda. */
function recompor(segs: SegmentoEntidade[]): string {
  return segs.map((s) => s.texto).join('');
}

// ── Invariante de não-perda (VERBATIM) ────────────────────────────────────────

test('detectarEntidades: concatenar os segmentos reconstrói o texto original', () => {
  const texto = `Empenho ao fornecedor ${CNPJ_VALIDO_FMT} no valor de R$ 10.000,00, ` +
    `responsável CPF ${CPF_VALIDO_FMT}, protocolo ${PROTOCOLO}.`;
  assert.equal(recompor(detectarEntidades(texto)), texto);
});

test('detectarEntidades: texto vazio/nulo devolve um único segmento texto vazio', () => {
  assert.deepEqual(detectarEntidades(''), [
    { texto: '', tipo: 'texto', doc: '', valido: false },
  ]);
  assert.deepEqual(detectarEntidades(null), [
    { texto: '', tipo: 'texto', doc: '', valido: false },
  ]);
  assert.deepEqual(detectarEntidades(undefined), [
    { texto: '', tipo: 'texto', doc: '', valido: false },
  ]);
});

test('detectarEntidades: texto sem documento vira um único segmento texto', () => {
  const segs = detectarEntidades('Nenhum documento aqui, só palavras.');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].tipo, 'texto');
  assert.equal(segs[0].texto, 'Nenhum documento aqui, só palavras.');
});

// ── CNPJ ──────────────────────────────────────────────────────────────────────

test('detectarEntidades: CNPJ válido (formatado e contínuo) vira segmento cnpj', () => {
  for (const forma of [CNPJ_VALIDO, CNPJ_VALIDO_FMT]) {
    const segs = detectarEntidades(`Contratada: ${forma} (ativa).`);
    const cnpj = segs.find((s) => s.tipo === 'cnpj');
    assert.ok(cnpj, `não detectou CNPJ na forma "${forma}"`);
    assert.equal(cnpj.valido, true);
    assert.equal(cnpj.doc, CNPJ_VALIDO); // sempre só dígitos
    assert.equal(cnpj.texto, forma); // trecho preservado como veio
  }
});

test('detectarEntidades: CNPJ com dígito verificador errado NÃO vira chip (lixo)', () => {
  const segs = detectarEntidades(`Doc suspeito ${CNPJ_INVALIDO} fim.`);
  assert.equal(segs.every((s) => s.tipo === 'texto'), true);
  assert.equal(recompor(segs), `Doc suspeito ${CNPJ_INVALIDO} fim.`);
});

// ── CPF (LGPD: detecta para mascarar, valida Módulo 11) ───────────────────────

test('detectarEntidades: CPF válido vira segmento cpf com os 11 dígitos', () => {
  for (const forma of [CPF_VALIDO, CPF_VALIDO_FMT]) {
    const segs = detectarEntidades(`Servidor ${forma}.`);
    const cpf = segs.find((s) => s.tipo === 'cpf');
    assert.ok(cpf, `não detectou CPF na forma "${forma}"`);
    assert.equal(cpf.valido, true);
    assert.equal(cpf.doc, CPF_VALIDO);
  }
});

test('detectarEntidades: CPF inválido (Módulo 11) NÃO vira chip', () => {
  const segs = detectarEntidades(`Número ${CPF_INVALIDO} qualquer.`);
  assert.equal(segs.some((s) => s.tipo === 'cpf'), false);
});

// ── Lixo numérico (anti-ruído) ────────────────────────────────────────────────

test('detectarEntidades: código TCE de 6 dígitos e protocolo de 15 são ignorados', () => {
  const texto = `Pessoa física ${LIXO_TCE}, protocolo ${PROTOCOLO}.`;
  const segs = detectarEntidades(texto);
  assert.equal(
    segs.some((s) => s.tipo === 'cnpj' || s.tipo === 'cpf' || s.tipo === 'rg'),
    false,
  );
  assert.equal(recompor(segs), texto);
});

// ── RG — GUARDRAIL LGPD (só destaca, NUNCA resolve) ───────────────────────────

test('GUARDRAIL LGPD: RG é apenas destacado — sem dígitos, sem valido, sem doc', () => {
  const segs = detectarEntidades('Identidade RG 12.345.678-9 do titular.');
  const rg = segs.find((s) => s.tipo === 'rg');
  assert.ok(rg, 'não destacou o RG');
  assert.equal(rg.valido, false); // RG nunca é "válido/investigável"
  assert.equal(rg.doc, ''); // NUNCA expõe os dígitos do RG
});

test('GUARDRAIL LGPD: RG nunca é tratado como CPF/CNPJ investigável', () => {
  const segs = detectarEntidades('RG 11.222.333-4');
  assert.equal(segs.some((s) => s.tipo === 'cpf' || s.tipo === 'cnpj'), false);
});

// ── Múltiplos documentos na ordem ─────────────────────────────────────────────

test('detectarEntidades: vários documentos saem na ordem do texto', () => {
  const texto = `${CNPJ_VALIDO_FMT} e ${CPF_VALIDO_FMT} no mesmo trecho`;
  const segs = detectarEntidades(texto);
  const tipos = segs.filter((s) => s.tipo !== 'texto').map((s) => s.tipo);
  assert.deepEqual(tipos, ['cnpj', 'cpf']);
  assert.equal(recompor(segs), texto);
});

// ── temEntidade (atalho) ──────────────────────────────────────────────────────

test('temEntidade: true só quando há CNPJ/CPF válido', () => {
  assert.equal(temEntidade(`fornecedor ${CNPJ_VALIDO}`), true);
  assert.equal(temEntidade(`servidor ${CPF_VALIDO}`), true);
  assert.equal(temEntidade(`lixo ${LIXO_TCE} e ${CNPJ_INVALIDO}`), false);
  assert.equal(temEntidade('RG 12.345.678-9'), false); // RG não é entidade
  assert.equal(temEntidade(''), false);
});
