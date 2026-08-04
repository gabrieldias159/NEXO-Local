/**
 * NEXO — regressão do detector FR-04 (`sancoes-det.ts`):
 * fornecedor inidôneo recebendo recurso público.
 *
 * Cobre: degradação honesta sem fonte de sanções; alerta crítico quando há
 * sanção VIGENTE × empenho; blindagem do ente público (denylist) NUNCA virar
 * "fornecedor sancionado"; e a regra de agregação (`fornecedoresParaSancoes`).
 *
 * Auto-executável: `npx tsx fr04.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectorSancoesFornecedor,
  fornecedoresParaSancoes,
  analisarSancoes,
} from '../detectores/sancoes-det';
import type { ContextoAnalise } from '../detectores/tipos';
import type { EmpenhoNorm } from '../normalizar';
import type { ConsultaSancaoCnpj, SancaoFederal } from '../sources/sancoes-federais';
import { MARILIA } from '../constants';

// ── Documentos (Módulo 11 confirmado) ─────────────────────────────────────────
const CNPJ_PRIVADO = '11222333000181'; // fornecedor privado válido
const CNPJ_PRIVADO_2 = '19131243000197'; // segundo fornecedor privado válido
const CNPJ_PREFEITURA = MARILIA.cnpjPrefeitura; // 44477909000100 — denylist
const CNPJ_IPREMM = '59989830000136'; // RPPS de Marília — denylist
const CPF_BENEF = '77515872020'; // 11 dígitos — não entra em FR-04 (só CNPJ)

const DATA_REF = '2026-06-01';

// ── Fábricas de fixture ───────────────────────────────────────────────────────

function empenho(over: Partial<EmpenhoNorm> & { cpfCnpj: string }): EmpenhoNorm {
  return {
    id: over.id ?? `emp-${over.cpfCnpj}`,
    cpfCnpj: over.cpfCnpj,
    fornecedorNome: over.fornecedorNome ?? 'FORNECEDOR TESTE LTDA',
    numeroEmpenho: over.numeroEmpenho ?? '2026/0001',
    exercicio: over.exercicio ?? 2026,
    data: over.data ?? '2026-03-15',
    valorEmpenhado: over.valorEmpenhado ?? 100_000,
    valorPago: over.valorPago ?? 0,
    temLiquidacao: over.temLiquidacao ?? false,
    processoAdministrativo: over.processoAdministrativo ?? null,
    processoLicitatorio: over.processoLicitatorio ?? null,
    unidadeGestora: over.unidadeGestora ?? 'PREFEITURA MUNICIPAL',
  };
}

function sancao(over: Partial<SancaoFederal> & { cnpjSancionado: string }): SancaoFederal {
  return {
    cadastro: over.cadastro ?? 'CEIS',
    cnpjSancionado: over.cnpjSancionado,
    nomeSancionado: over.nomeSancionado ?? 'FORNECEDOR TESTE LTDA',
    tipoSancao: over.tipoSancao ?? 'Inidoneidade',
    dataInicio: over.dataInicio ?? null,
    dataFim: over.dataFim ?? null,
    orgaoSancionador: over.orgaoSancionador ?? 'CGU',
    fundamentacao: over.fundamentacao ?? 'Lei 14.133/2021',
  };
}

function consulta(cnpj: string, sancoes: SancaoFederal[]): ConsultaSancaoCnpj {
  return { cnpj, sancoes, tokenConfigurado: true, erro: null };
}

function ctxBase(over: Partial<ContextoAnalise>): ContextoAnalise {
  return {
    exercicio: 2026,
    empenhos: over.empenhos ?? [],
    diarias: [],
    modalidades: [],
    restosAPagar: [],
    despesas: [],
    totalEmpenhado: 0,
    amostra: false,
    sancoes: over.sancoes,
    dataReferencia: over.dataReferencia ?? DATA_REF,
  };
}

// ── (a) SEM ctx.sancoes → lista vazia (cruzamento inativo, honesto) ───────────

test('FR-04 (a): sem ctx.sancoes retorna lista vazia', () => {
  const ctx = ctxBase({
    empenhos: [empenho({ cpfCnpj: CNPJ_PRIVADO, valorEmpenhado: 500_000 })],
    // sancoes: undefined  → fonte não anexada
  });
  assert.deepEqual(detectorSancoesFornecedor.detectar(ctx), []);

  // Array de sanções vazio também degrada para [].
  const ctxVazio = ctxBase({
    empenhos: [empenho({ cpfCnpj: CNPJ_PRIVADO })],
    sancoes: [],
  });
  assert.deepEqual(detectorSancoesFornecedor.detectar(ctxVazio), []);
});

// ── (b) sanção VIGENTE × empenho de CNPJ privado → 1 alerta crítico FR-04 ─────

test('FR-04 (b): sanção vigente + empenho privado → 1 alerta crítico', () => {
  const ctx = ctxBase({
    empenhos: [
      empenho({
        cpfCnpj: CNPJ_PRIVADO,
        fornecedorNome: 'COMERCIAL ALFA LTDA',
        valorEmpenhado: 750_000,
      }),
    ],
    sancoes: [
      consulta(CNPJ_PRIVADO, [
        sancao({
          cnpjSancionado: CNPJ_PRIVADO,
          // vigência aberta englobando a data de referência
          dataInicio: '2026-01-10',
          dataFim: '2027-01-10',
        }),
      ]),
    ],
  });

  const alertas = detectorSancoesFornecedor.detectar(ctx);
  assert.equal(alertas.length, 1);
  const a = alertas[0];
  assert.equal(a.detectorId, 'FR-04');
  assert.equal(a.classificacao, 'critico');
  assert.equal(a.sujeitoTipo, 'fornecedor');
  assert.equal(a.sujeitoId, CNPJ_PRIVADO);
  assert.equal(a.sujeitoRotulo, 'COMERCIAL ALFA LTDA');
  assert.equal(a.valorEnvolvido, 750_000);
});

test('FR-04 (b2): sanção sem datas é tratada como vigente (conservador) → crítico', () => {
  const ctx = ctxBase({
    empenhos: [empenho({ cpfCnpj: CNPJ_PRIVADO, valorEmpenhado: 10_000 })],
    sancoes: [consulta(CNPJ_PRIVADO, [sancao({ cnpjSancionado: CNPJ_PRIVADO })])],
  });
  const alertas = detectorSancoesFornecedor.detectar(ctx);
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].classificacao, 'critico');
});

test('FR-04 (b3): sanção JÁ ENCERRADA antes da ref → atenção, não crítico', () => {
  const ctx = ctxBase({
    empenhos: [empenho({ cpfCnpj: CNPJ_PRIVADO, valorEmpenhado: 10_000 })],
    sancoes: [
      consulta(CNPJ_PRIVADO, [
        sancao({
          cnpjSancionado: CNPJ_PRIVADO,
          dataInicio: '2020-01-01',
          dataFim: '2021-01-01', // antes de DATA_REF
        }),
      ]),
    ],
  });
  const alertas = detectorSancoesFornecedor.detectar(ctx);
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].classificacao, 'atencao');
});

// ── (c) ente público na denylist NUNCA aparece como fornecedor sancionado ─────

test('FR-04 (c): ente público (denylist) com "sanção" NUNCA vira alerta', () => {
  // Cenário absurdo de propósito: a Prefeitura figura como "empenho" e há
  // um doc de sanção para o CNPJ dela. O detector NÃO pode gerar alerta:
  // ente público é filtrado em fornecedoresParaSancoes ANTES do cruzamento.
  const ctx = ctxBase({
    empenhos: [
      empenho({
        cpfCnpj: CNPJ_PREFEITURA,
        fornecedorNome: 'PREFEITURA MUNICIPAL DE MARILIA',
        valorEmpenhado: 9_000_000,
      }),
      empenho({
        cpfCnpj: CNPJ_IPREMM,
        fornecedorNome: 'INSTITUTO DE PREVIDENCIA IPREMM',
        valorEmpenhado: 4_000_000,
      }),
    ],
    sancoes: [
      consulta(CNPJ_PREFEITURA, [sancao({ cnpjSancionado: CNPJ_PREFEITURA })]),
      consulta(CNPJ_IPREMM, [sancao({ cnpjSancionado: CNPJ_IPREMM })]),
    ],
  });
  assert.deepEqual(detectorSancoesFornecedor.detectar(ctx), []);
});

test('FR-04 (c2): ente público filtrado, mas fornecedor privado real ainda alerta', () => {
  const ctx = ctxBase({
    empenhos: [
      empenho({ cpfCnpj: CNPJ_PREFEITURA, fornecedorNome: 'PREFEITURA', valorEmpenhado: 9_000_000 }),
      empenho({ cpfCnpj: CNPJ_PRIVADO, fornecedorNome: 'BETA LTDA', valorEmpenhado: 200_000 }),
    ],
    sancoes: [
      consulta(CNPJ_PREFEITURA, [sancao({ cnpjSancionado: CNPJ_PREFEITURA })]),
      consulta(CNPJ_PRIVADO, [sancao({ cnpjSancionado: CNPJ_PRIVADO })]),
    ],
  });
  const alertas = detectorSancoesFornecedor.detectar(ctx);
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].sujeitoId, CNPJ_PRIVADO);
});

// ── (d) fornecedoresParaSancoes: exclui ≠14 díg e entes públicos ──────────────

test('FR-04 (d): fornecedoresParaSancoes exclui CPF/≠14 díg e entes públicos', () => {
  const forn = fornecedoresParaSancoes([
    empenho({ cpfCnpj: CNPJ_PRIVADO, fornecedorNome: 'ALFA LTDA', valorEmpenhado: 100 }),
    empenho({ cpfCnpj: CNPJ_PRIVADO_2, fornecedorNome: 'BETA LTDA', valorEmpenhado: 200 }),
    // CPF (11 díg) → excluído (sanção federal é por CNPJ).
    empenho({ cpfCnpj: CPF_BENEF, fornecedorNome: 'FULANO DE TAL', valorEmpenhado: 300 }),
    // Lixo numérico (≠14 díg) → excluído.
    empenho({ cpfCnpj: '605238', fornecedorNome: 'PESSOA FISICA', valorEmpenhado: 400 }),
    // Ente público por doc → excluído.
    empenho({ cpfCnpj: CNPJ_PREFEITURA, fornecedorNome: 'PREFEITURA', valorEmpenhado: 500 }),
    // Ente público por NOME (CNPJ válido mas nome inequívoco) → excluído.
    empenho({ cpfCnpj: CNPJ_PRIVADO_2, fornecedorNome: 'CAMARA MUNICIPAL DE MARILIA', valorEmpenhado: 600 }),
  ]);

  const cnpjs = forn.map((f) => f.cnpj).sort();
  // Sobram só os 2 privados de verdade (CNPJ_PRIVADO_2 aparece com nome de
  // empresa privada num registro; o registro "CAMARA" é filtrado pelo nome,
  // mas o outro registro do mesmo CNPJ é privado — vira 1 fornecedor).
  assert.deepEqual(cnpjs, [CNPJ_PRIVADO, CNPJ_PRIVADO_2].sort());

  for (const f of forn) {
    assert.equal(f.cnpj.length, 14);
  }
});

test('FR-04 (d2): fornecedoresParaSancoes soma valor por CNPJ (matriz/filial pelo doc cheio)', () => {
  const forn = fornecedoresParaSancoes([
    empenho({ cpfCnpj: CNPJ_PRIVADO, valorEmpenhado: 100_000 }),
    empenho({ cpfCnpj: CNPJ_PRIVADO, valorEmpenhado: 50_000 }),
  ]);
  assert.equal(forn.length, 1);
  assert.equal(forn[0].cnpj, CNPJ_PRIVADO);
  assert.equal(forn[0].valorEmpenhado, 150_000);
});

// ── analisarSancoes: agrega valor de múltiplos empenhos do mesmo CNPJ ─────────

test('FR-04 (analisarSancoes): consolida valor empenhado por CNPJ no alerta', () => {
  const alertas = analisarSancoes({
    fornecedores: [
      { cnpj: CNPJ_PRIVADO, nome: 'ALFA LTDA', valorEmpenhado: 300_000 },
      { cnpj: CNPJ_PRIVADO, nome: '', valorEmpenhado: 200_000 },
    ],
    consultas: [consulta(CNPJ_PRIVADO, [sancao({ cnpjSancionado: CNPJ_PRIVADO })])],
    dataReferencia: DATA_REF,
  });
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].valorEnvolvido, 500_000);
  assert.equal(alertas[0].sujeitoRotulo, 'ALFA LTDA');
});
