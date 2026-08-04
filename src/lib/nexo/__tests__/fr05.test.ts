/**
 * NEXO — regressão do detector FR-05 (`leniencia-det.ts`):
 * fornecedor com acordo de leniência recebendo empenhos.
 *
 * Cobre: degradação honesta sem fonte de leniência; alerta quando há acordo
 * VIGENTE × empenho; severidade MAIOR (crítico) quando o acordo foi
 * DESCUMPRIDO; CNPJ verificado e limpo nunca alerta; blindagem do ente
 * público (denylist, invariante-mãe) NUNCA virar "fornecedor com leniência";
 * procedência (deep-link do Portal da Transparência federal) presente; e o
 * loader `acordosDeDocsLeniencia`.
 *
 * Molde: fr04.test.ts. Auto-executável: `npx tsx fr05.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectorLenienciaFornecedor,
  analisarLeniencia,
  acordoVigente,
  acordoDescumprido,
  procedenciaLeniencia,
} from '../detectores/leniencia-det';
import type { ContextoAnalise } from '../detectores/tipos';
import type { EmpenhoNorm } from '../normalizar';
import {
  acordosDeDocsLeniencia,
  type AcordoLeniencia,
  type ConsultaLenienciaCnpj,
} from '../sources/leniencia';
import { MARILIA } from '../constants';

// ── Documentos (Módulo 11 confirmado) ─────────────────────────────────────────
const CNPJ_PRIVADO = '11222333000181'; // fornecedor privado válido
const CNPJ_PRIVADO_2 = '19131243000197'; // segundo fornecedor privado válido
const CNPJ_PREFEITURA = MARILIA.cnpjPrefeitura; // 44477909000100 — denylist
const CNPJ_IPREMM = '59989830000136'; // RPPS de Marília — denylist

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

function acordo(
  over: Partial<AcordoLeniencia> & { cnpjSancionado: string },
): AcordoLeniencia {
  return {
    idAcordo: over.idAcordo ?? '1000006',
    cnpjSancionado: over.cnpjSancionado,
    razaoSocial: over.razaoSocial ?? 'FORNECEDOR TESTE LTDA',
    situacaoAcordo: over.situacaoAcordo ?? 'Acordo em vigência',
    orgaoResponsavel: over.orgaoResponsavel ?? 'Controladoria-Geral da União',
    dataInicio: over.dataInicio ?? '2025-01-10',
    dataFim: over.dataFim ?? '2030-01-10',
    qtdEmpresasAbrangidas: over.qtdEmpresasAbrangidas ?? 1,
  };
}

function consulta(cnpj: string, acordos: AcordoLeniencia[]): ConsultaLenienciaCnpj {
  return { cnpj, acordos };
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
    leniencia: over.leniencia,
    dataReferencia: over.dataReferencia ?? DATA_REF,
  };
}

// ── (a) SEM ctx.leniencia → lista vazia (cruzamento inativo, honesto) ─────────

test('FR-05 (a): sem ctx.leniencia retorna lista vazia', () => {
  const ctx = ctxBase({
    empenhos: [empenho({ cpfCnpj: CNPJ_PRIVADO, valorEmpenhado: 500_000 })],
    // leniencia: undefined → fonte não anexada
  });
  assert.deepEqual(detectorLenienciaFornecedor.detectar(ctx), []);

  // Array de consultas vazio também degrada para [].
  const ctxVazio = ctxBase({
    empenhos: [empenho({ cpfCnpj: CNPJ_PRIVADO })],
    leniencia: [],
  });
  assert.deepEqual(detectorLenienciaFornecedor.detectar(ctxVazio), []);
});

// ── (b) acordo VIGENTE × empenho de CNPJ privado → 1 alerta (atenção) ─────────

test('FR-05 (b): acordo em vigência + empenho privado → 1 alerta de atenção', () => {
  const ctx = ctxBase({
    empenhos: [
      empenho({
        cpfCnpj: CNPJ_PRIVADO,
        fornecedorNome: 'COMERCIAL ALFA LTDA',
        valorEmpenhado: 750_000,
      }),
    ],
    leniencia: [
      consulta(CNPJ_PRIVADO, [
        acordo({
          cnpjSancionado: CNPJ_PRIVADO,
          situacaoAcordo: 'Acordo em vigência',
          dataInicio: '2025-01-10',
          dataFim: '2030-01-10', // engloba DATA_REF
        }),
      ]),
    ],
  });

  const alertas = detectorLenienciaFornecedor.detectar(ctx);
  assert.equal(alertas.length, 1);
  const a = alertas[0];
  assert.equal(a.detectorId, 'FR-05');
  assert.equal(a.classificacao, 'atencao'); // acordo é LÍCITO — não é crítico
  assert.equal(a.sujeitoTipo, 'fornecedor');
  assert.equal(a.sujeitoId, CNPJ_PRIVADO);
  assert.equal(a.sujeitoRotulo, 'COMERCIAL ALFA LTDA');
  assert.equal(a.valorEnvolvido, 750_000);
  // Crivo legal: Lei Anticorrupção, arts. 16–17.
  assert.ok(
    a.fundamentoLegal.some((f) => /12\.846\/2013.*art\.? ?16/i.test(f)),
    'fundamento legal deve citar a Lei 12.846/2013, art. 16',
  );
});

test('FR-05 (b2): acordo sem datas nem situação conclusiva é tratado como vigente (conservador)', () => {
  const ctx = ctxBase({
    empenhos: [empenho({ cpfCnpj: CNPJ_PRIVADO, valorEmpenhado: 10_000 })],
    leniencia: [
      consulta(CNPJ_PRIVADO, [
        acordo({
          cnpjSancionado: CNPJ_PRIVADO,
          situacaoAcordo: '',
          dataInicio: null,
          dataFim: null,
        }),
      ]),
    ],
  });
  const alertas = detectorLenienciaFornecedor.detectar(ctx);
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].classificacao, 'atencao');
});

test('FR-05 (b3): acordo já CUMPRIDO/encerrado → informativo (histórico)', () => {
  const ctx = ctxBase({
    empenhos: [empenho({ cpfCnpj: CNPJ_PRIVADO, valorEmpenhado: 10_000 })],
    leniencia: [
      consulta(CNPJ_PRIVADO, [
        acordo({
          cnpjSancionado: CNPJ_PRIVADO,
          situacaoAcordo: 'Acordo cumprido',
          dataInicio: '2020-01-01',
          dataFim: '2024-01-01', // antes de DATA_REF
        }),
      ]),
    ],
  });
  const alertas = detectorLenienciaFornecedor.detectar(ctx);
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].classificacao, 'informativo');
});

// ── (c) acordo DESCUMPRIDO → severidade MAIOR (crítico) ───────────────────────

test('FR-05 (c): acordo descumprido → crítico (severidade maior que vigente)', () => {
  const ctx = ctxBase({
    empenhos: [
      empenho({ cpfCnpj: CNPJ_PRIVADO, fornecedorNome: 'ALFA LTDA', valorEmpenhado: 100_000 }),
      empenho({ cpfCnpj: CNPJ_PRIVADO_2, fornecedorNome: 'BETA LTDA', valorEmpenhado: 900_000 }),
    ],
    leniencia: [
      // ALFA descumpriu o acordo; BETA tem acordo vigente (e valor MAIOR).
      consulta(CNPJ_PRIVADO, [
        acordo({
          cnpjSancionado: CNPJ_PRIVADO,
          situacaoAcordo: 'Acordo descumprido',
        }),
      ]),
      consulta(CNPJ_PRIVADO_2, [
        acordo({
          cnpjSancionado: CNPJ_PRIVADO_2,
          situacaoAcordo: 'Acordo em vigência',
        }),
      ]),
    ],
  });

  const alertas = detectorLenienciaFornecedor.detectar(ctx);
  assert.equal(alertas.length, 2);

  const alfa = alertas.find((a) => a.sujeitoId === CNPJ_PRIVADO)!;
  const beta = alertas.find((a) => a.sujeitoId === CNPJ_PRIVADO_2)!;
  assert.equal(alfa.classificacao, 'critico');
  assert.equal(beta.classificacao, 'atencao');
  // Score do descumprido é maior que o do vigente.
  assert.ok(
    alfa.scores.probabilidadeIrregularidade > beta.scores.probabilidadeIrregularidade,
  );
  // Ordenação: crítico vem ANTES de atenção, mesmo com valor menor.
  assert.equal(alertas[0].sujeitoId, CNPJ_PRIVADO);
});

test('FR-05 (c2): "descumprido" não é confundido com "cumprido" pelos helpers', () => {
  const descumprido = acordo({
    cnpjSancionado: CNPJ_PRIVADO,
    situacaoAcordo: 'Acordo descumprido',
  });
  const cumprido = acordo({
    cnpjSancionado: CNPJ_PRIVADO,
    situacaoAcordo: 'Acordo cumprido',
  });
  assert.equal(acordoDescumprido(descumprido), true);
  assert.equal(acordoDescumprido(cumprido), false);
  assert.equal(acordoVigente(descumprido, DATA_REF), false);
  assert.equal(acordoVigente(cumprido, DATA_REF), false);
});

// ── (d) CNPJ sem acordo → sem alerta ──────────────────────────────────────────

test('FR-05 (d): CNPJ verificado e limpo (acordos: []) não vira alerta', () => {
  const ctx = ctxBase({
    empenhos: [empenho({ cpfCnpj: CNPJ_PRIVADO, valorEmpenhado: 500_000 })],
    leniencia: [consulta(CNPJ_PRIVADO, [])], // doc comAcordo:false reidratado
  });
  assert.deepEqual(detectorLenienciaFornecedor.detectar(ctx), []);
});

test('FR-05 (d2): acordo de CNPJ que NÃO é fornecedor de Marília não vira alerta', () => {
  const ctx = ctxBase({
    empenhos: [empenho({ cpfCnpj: CNPJ_PRIVADO, valorEmpenhado: 500_000 })],
    leniencia: [
      consulta(CNPJ_PRIVADO_2, [acordo({ cnpjSancionado: CNPJ_PRIVADO_2 })]),
    ],
  });
  assert.deepEqual(detectorLenienciaFornecedor.detectar(ctx), []);
});

// ── (e) ente público na denylist NUNCA vira "fornecedor com leniência" ────────

test('FR-05 (e): ente público (denylist) com "acordo" NUNCA vira alerta', () => {
  // Cenário absurdo de propósito (mesma blindagem do FR-04): a Prefeitura e o
  // IPREMM figuram como "empenho" e há docs de leniência para os CNPJs deles.
  // O detector NÃO pode gerar alerta: ente público é filtrado em
  // fornecedoresParaSancoes ANTES do cruzamento (invariante-mãe).
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
    leniencia: [
      consulta(CNPJ_PREFEITURA, [
        acordo({ cnpjSancionado: CNPJ_PREFEITURA, situacaoAcordo: 'Acordo descumprido' }),
      ]),
      consulta(CNPJ_IPREMM, [acordo({ cnpjSancionado: CNPJ_IPREMM })]),
    ],
  });
  assert.deepEqual(detectorLenienciaFornecedor.detectar(ctx), []);
});

test('FR-05 (e2): ente público filtrado, mas fornecedor privado real ainda alerta', () => {
  const ctx = ctxBase({
    empenhos: [
      empenho({ cpfCnpj: CNPJ_PREFEITURA, fornecedorNome: 'PREFEITURA', valorEmpenhado: 9_000_000 }),
      empenho({ cpfCnpj: CNPJ_PRIVADO, fornecedorNome: 'BETA LTDA', valorEmpenhado: 200_000 }),
    ],
    leniencia: [
      consulta(CNPJ_PREFEITURA, [acordo({ cnpjSancionado: CNPJ_PREFEITURA })]),
      consulta(CNPJ_PRIVADO, [acordo({ cnpjSancionado: CNPJ_PRIVADO })]),
    ],
  });
  const alertas = detectorLenienciaFornecedor.detectar(ctx);
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].sujeitoId, CNPJ_PRIVADO);
});

// ── (f) PROCEDÊNCIA: deep-link do Portal da Transparência federal presente ────

test('FR-05 (f): evidências de acordo trazem procedência CGU com deep-link público', () => {
  const ctx = ctxBase({
    empenhos: [empenho({ cpfCnpj: CNPJ_PRIVADO, valorEmpenhado: 50_000 })],
    leniencia: [
      consulta(CNPJ_PRIVADO, [
        acordo({ cnpjSancionado: CNPJ_PRIVADO, idAcordo: '1000006' }),
      ]),
    ],
  });
  const [a] = detectorLenienciaFornecedor.detectar(ctx);
  const comProva = a.evidencias.filter((e) => e.procedencia);
  assert.ok(comProva.length > 0, 'ao menos uma evidência deve ter procedência');
  const p = comProva[0].procedencia!;
  assert.equal(p.fonte, 'CGU');
  // Com idAcordo → detalhe forte do acordo no portal federal.
  assert.equal(
    p.url,
    'https://portaldatransparencia.gov.br/sancoes/acordos-leniencia/1000006',
  );
  assert.equal(p.refColecao, 'nexo_leniencia');
  assert.equal(p.refId, CNPJ_PRIVADO);
});

test('FR-05 (f2): sem idAcordo a procedência cai na consulta pré-filtrada por CNPJ', () => {
  const p = procedenciaLeniencia(CNPJ_PRIVADO);
  assert.equal(p.fonte, 'CGU');
  assert.equal(
    p.url,
    `https://portaldatransparencia.gov.br/sancoes/consulta?cadastro=4&cpfCnpj=${CNPJ_PRIVADO}`,
  );
  assert.equal(p.tipoDoc, 'pagina');
  assert.equal(p.podePreview, false);
});

// ── analisarLeniencia: agrega valor de múltiplos empenhos do mesmo CNPJ ───────

test('FR-05 (analisarLeniencia): consolida valor empenhado por CNPJ no alerta', () => {
  const alertas = analisarLeniencia({
    fornecedores: [
      { cnpj: CNPJ_PRIVADO, nome: 'ALFA LTDA', valorEmpenhado: 300_000 },
      { cnpj: CNPJ_PRIVADO, nome: '', valorEmpenhado: 200_000 },
    ],
    consultas: [consulta(CNPJ_PRIVADO, [acordo({ cnpjSancionado: CNPJ_PRIVADO })])],
    dataReferencia: DATA_REF,
  });
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].valorEnvolvido, 500_000);
  assert.equal(alertas[0].sujeitoRotulo, 'ALFA LTDA');
});

// ── loader: acordosDeDocsLeniencia reidrata docs crus de nexo_leniencia ───────

test('FR-05 (loader): acordosDeDocsLeniencia coage docs e descarta CNPJ inválido', () => {
  const docs: Record<string, unknown>[] = [
    {
      _cnpj: CNPJ_PRIVADO,
      cnpj: CNPJ_PRIVADO,
      comAcordo: true,
      acordos: [
        {
          idAcordo: '777',
          cnpjSancionado: CNPJ_PRIVADO,
          razaoSocial: 'ALFA LTDA',
          situacaoAcordo: 'Acordo em vigência',
          orgaoResponsavel: 'CGU',
          dataInicio: '2025-01-10',
          dataFim: '2030-01-10',
          qtdEmpresasAbrangidas: 3,
        },
        'lixo não-objeto', // descartado pela coerção
      ],
    },
    // Verificado e limpo — vira consulta com acordos: [].
    { cnpj: CNPJ_PRIVADO_2, comAcordo: false, acordos: [] },
    // CNPJ inválido (≠14 dígitos) — descartado.
    { cnpj: '605238', acordos: [{ idAcordo: '1' }] },
  ];

  const consultas = acordosDeDocsLeniencia(docs);
  assert.equal(consultas.length, 2);

  const alfa = consultas.find((c) => c.cnpj === CNPJ_PRIVADO)!;
  assert.equal(alfa.acordos.length, 1);
  assert.equal(alfa.acordos[0].idAcordo, '777');
  assert.equal(alfa.acordos[0].situacaoAcordo, 'Acordo em vigência');
  assert.equal(alfa.acordos[0].qtdEmpresasAbrangidas, 3);

  const beta = consultas.find((c) => c.cnpj === CNPJ_PRIVADO_2)!;
  assert.deepEqual(beta.acordos, []);
});
