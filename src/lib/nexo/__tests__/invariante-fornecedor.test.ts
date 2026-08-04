/**
 * NEXO — A INVARIANTE-MÃE de qualidade.
 *
 * "A Prefeitura/órgão público NUNCA pode aparecer como FORNECEDOR." Foi o
 * problema de qualidade nº 1 do dono (transferências intra-governamentais,
 * repasse ao RPPS, duodécimo da Câmara, folha lançada como fornecedor).
 *
 * Monta um ContextoAnalise de fixture onde a Prefeitura, o IPREMM e a Câmara
 * figuram como "fornecedor" em empenhos, roda TODOS os detectores e afirma que
 * NENHUM alerta com `sujeitoTipo === 'fornecedor'` aponta para um ente público
 * (checado por `ehEntidadePublica`, a fonte da verdade). Se algum detector
 * voltar a tratar a Prefeitura como fornecedor, este teste quebra.
 *
 * Auto-executável: `npx tsx invariante-fornecedor.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rodarDetectores } from '../detectores/index';
import type { ContextoAnalise, AlertaDetectado } from '../detectores/tipos';
import type { EmpenhoNorm, DespesaNorm, RestoPagarNorm } from '../normalizar';
import type { ConsultaSancaoCnpj, SancaoFederal } from '../sources/sancoes-federais';
import { ehEntidadePublica } from '../entidades';
import { MARILIA } from '../constants';

// ── Documentos ────────────────────────────────────────────────────────────────
const CNPJ_PREFEITURA = MARILIA.cnpjPrefeitura; // 44477909000100 — denylist
const CNPJ_IPREMM = '59989830000136'; // RPPS — denylist
// Fornecedores privados reais (Módulo 11 ok):
const CNPJ_ALFA = '11222333000181';
const CNPJ_ALFA_FILIAL = '11222333000262'; // mesmo grupo (raiz 11222333)
const CNPJ_BETA = '19131243000197';
const CNPJ_GAMA = '11444777000161';

const DATA_REF = '2026-06-01';

// ── Fábricas ──────────────────────────────────────────────────────────────────

function empenho(over: Partial<EmpenhoNorm> & { cpfCnpj: string }): EmpenhoNorm {
  return {
    id: over.id ?? `emp-${over.cpfCnpj}-${Math.random().toString(36).slice(2, 7)}`,
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

function despesa(over: Partial<DespesaNorm> & { cpfCnpj: string }): DespesaNorm {
  return {
    id: over.id ?? `desp-${over.cpfCnpj}`,
    numeroEmpenho: over.numeroEmpenho ?? '2026/0001',
    cpfCnpj: over.cpfCnpj,
    fornecedorNome: over.fornecedorNome ?? 'FORNECEDOR TESTE LTDA',
    data: over.data ?? '2026-03-15',
    valorEmpenhado: over.valorEmpenhado ?? 100_000,
    valorPago: over.valorPago ?? 0,
    unidadeGestora: over.unidadeGestora ?? 'PREFEITURA MUNICIPAL',
    objeto: over.objeto ?? 'AQUISICAO DE MATERIAL',
    elemento: over.elemento ?? '339030',
    modalidadeCodigo: over.modalidadeCodigo ?? '05',
    tipoEmpenho: over.tipoEmpenho ?? 'Empenho',
    bemOuServico: over.bemOuServico ?? 'Bem',
  };
}

function resto(over: Partial<RestoPagarNorm> & { cpfCnpj: string }): RestoPagarNorm {
  return {
    id: over.id ?? `resto-${over.cpfCnpj}`,
    cpfCnpj: over.cpfCnpj,
    fornecedorNome: over.fornecedorNome ?? 'FORNECEDOR TESTE LTDA',
    exercicio: over.exercicio ?? 2026,
    valor: over.valor ?? 50_000,
  };
}

function sancao(cnpj: string): SancaoFederal {
  return {
    cadastro: 'CEIS',
    cnpjSancionado: cnpj,
    nomeSancionado: 'SANCIONADO',
    tipoSancao: 'Inidoneidade',
    dataInicio: '2026-01-01',
    dataFim: '2027-01-01', // vigente em DATA_REF
    orgaoSancionador: 'CGU',
    fundamentacao: 'Lei 14.133/2021',
  };
}

function consulta(cnpj: string): ConsultaSancaoCnpj {
  return { cnpj, sancoes: [sancao(cnpj)], tokenConfigurado: true, erro: null };
}

// ── Fixture: entes públicos LANÇADOS COMO "fornecedor" + privados de verdade ──

function fixtureComEntesPublicosComoFornecedor(): ContextoAnalise {
  const empenhos: EmpenhoNorm[] = [
    // ── O BUG: entes públicos aparecendo como "fornecedor" ──
    empenho({
      cpfCnpj: CNPJ_PREFEITURA,
      fornecedorNome: 'PREFEITURA MUNICIPAL DE MARILIA',
      valorEmpenhado: 12_000_000,
      data: '2026-04-10',
    }),
    empenho({
      cpfCnpj: CNPJ_IPREMM,
      fornecedorNome: 'INSTITUTO DE PREVIDENCIA DOS SERVIDORES - IPREMM',
      valorEmpenhado: 8_000_000,
      data: '2026-04-11',
    }),
    // Ente público por NOME (CNPJ qualquer, mas nome inequívoco):
    empenho({
      cpfCnpj: CNPJ_BETA, // doc privado, porém nome de órgão
      fornecedorNome: 'CAMARA MUNICIPAL DE MARILIA',
      valorEmpenhado: 3_000_000,
      data: '2026-04-12',
    }),
    empenho({
      cpfCnpj: CNPJ_GAMA,
      fornecedorNome: 'SERVICO AUTONOMO DE AGUA E ESGOTO - SAAE',
      valorEmpenhado: 2_500_000,
      data: '2026-04-13',
    }),
    // OR-03 exercitado JÁ (não só quando os de abril envelhecerem): empenho
    // público VELHO (>90 dias, sem liquidação) — não pode virar alerta.
    empenho({
      cpfCnpj: CNPJ_PREFEITURA,
      fornecedorNome: 'PREFEITURA MUNICIPAL DE MARILIA',
      valorEmpenhado: 700_000,
      data: '2026-01-10',
    }),
    // ── FRACIONAMENTO (LC-01/LC-05/AN-04) com ente público: 5 empenhos ABAIXO
    // do teto de dispensa (compras 2026 ~R$ 62,7k) em <90 dias, mesmo objeto.
    // ESTE é o gatilho que fazia a "PREFEITURA como fornecedor" vazar — a
    // fixture antiga só tinha valores acima do teto e passava vacuamente.
    ...Array.from({ length: 5 }).map((_, i) =>
      empenho({
        id: `frac-pref-${i}`,
        cpfCnpj: CNPJ_PREFEITURA,
        fornecedorNome: 'PREFEITURA MUNICIPAL DE MARILIA',
        valorEmpenhado: 50_000,
        data: `2026-05-0${i + 1}`,
        processoLicitatorio: null,
      }),
    ),

    // ── Fornecedores PRIVADOS de verdade (devem poder virar alerta) ──
    empenho({ cpfCnpj: CNPJ_ALFA, fornecedorNome: 'COMERCIAL ALFA LTDA', valorEmpenhado: 900_000, data: '2026-02-01' }),
    empenho({ cpfCnpj: CNPJ_ALFA, fornecedorNome: 'COMERCIAL ALFA LTDA', valorEmpenhado: 850_000, data: '2026-02-15' }),
    empenho({ cpfCnpj: CNPJ_ALFA_FILIAL, fornecedorNome: 'COMERCIAL ALFA LTDA FILIAL', valorEmpenhado: 800_000, data: '2026-03-01' }),
    empenho({ cpfCnpj: CNPJ_BETA, fornecedorNome: 'BETA SERVICOS EIRELI', valorEmpenhado: 600_000, data: '2026-03-20' }),
    empenho({ cpfCnpj: CNPJ_GAMA, fornecedorNome: 'GAMA CONSTRUCOES LTDA', valorEmpenhado: 1_200_000, data: '2026-05-05' }),
  ];

  const despesas: DespesaNorm[] = [
    despesa({ cpfCnpj: CNPJ_PREFEITURA, fornecedorNome: 'PREFEITURA MUNICIPAL DE MARILIA', valorEmpenhado: 12_000_000 }),
    despesa({ cpfCnpj: CNPJ_ALFA, fornecedorNome: 'COMERCIAL ALFA LTDA', valorEmpenhado: 900_000 }),
    despesa({ cpfCnpj: CNPJ_GAMA, fornecedorNome: 'GAMA CONSTRUCOES LTDA', valorEmpenhado: 1_200_000, objeto: 'OBRA' }),
    // LC-03 (mesmo objeto em 2 UGs) com ente público — não pode virar alerta.
    despesa({ id: 'lc03-pref-a', cpfCnpj: CNPJ_PREFEITURA, fornecedorNome: 'PREFEITURA MUNICIPAL DE MARILIA', valorEmpenhado: 40_000, objeto: 'GENEROS ALIMENTICIOS', unidadeGestora: 'SECRETARIA DE EDUCACAO' }),
    despesa({ id: 'lc03-pref-b', cpfCnpj: CNPJ_PREFEITURA, fornecedorNome: 'PREFEITURA MUNICIPAL DE MARILIA', valorEmpenhado: 40_000, objeto: 'GENEROS ALIMENTICIOS', unidadeGestora: 'SECRETARIA DE SAUDE' }),
    // ── OR-07 exercitado de verdade: ≥2 ANULAÇÕES por CNPJ, ente público E
    // privado — o público NÃO pode virar alerta; o privado DEVE poder.
    despesa({ id: 'anul-pref-1', cpfCnpj: CNPJ_PREFEITURA, fornecedorNome: 'PREFEITURA MUNICIPAL DE MARILIA', valorEmpenhado: -400_000, tipoEmpenho: 'Anulação' }),
    despesa({ id: 'anul-pref-2', cpfCnpj: CNPJ_PREFEITURA, fornecedorNome: 'PREFEITURA MUNICIPAL DE MARILIA', valorEmpenhado: -250_000, tipoEmpenho: 'Anulação' }),
    despesa({ id: 'anul-gama-1', cpfCnpj: CNPJ_GAMA, fornecedorNome: 'GAMA CONSTRUCOES LTDA', valorEmpenhado: -120_000, tipoEmpenho: 'Anulação' }),
    despesa({ id: 'anul-gama-2', cpfCnpj: CNPJ_GAMA, fornecedorNome: 'GAMA CONSTRUCOES LTDA', valorEmpenhado: -90_000, tipoEmpenho: 'Anulação' }),
  ];

  const restosAPagar: RestoPagarNorm[] = [
    resto({ cpfCnpj: CNPJ_PREFEITURA, fornecedorNome: 'PREFEITURA MUNICIPAL DE MARILIA', valor: 5_000_000 }),
    resto({ cpfCnpj: CNPJ_ALFA, fornecedorNome: 'COMERCIAL ALFA LTDA', valor: 300_000 }),
    // ── MF-10 exercitado de verdade: RAP ANTIGO (inscrição > 2 anos) de ente
    // público E de privado acima do limiar de 50k.
    resto({ id: 'rap-antigo-pref', cpfCnpj: CNPJ_PREFEITURA, fornecedorNome: 'PREFEITURA MUNICIPAL DE MARILIA', valor: 900_000, exercicio: 2022 }),
    resto({ id: 'rap-antigo-alfa', cpfCnpj: CNPJ_ALFA, fornecedorNome: 'COMERCIAL ALFA LTDA', valor: 250_000, exercicio: 2022 }),
  ];

  const totalEmpenhado = empenhos.reduce((s, e) => s + e.valorEmpenhado, 0);

  return {
    exercicio: 2026,
    empenhos,
    diarias: [],
    modalidades: [
      { modalidade: 'Dispensa', valorEmpenhado: 4_000_000 },
      { modalidade: 'Pregão', valorEmpenhado: 10_000_000 },
    ],
    restosAPagar,
    despesas,
    totalEmpenhado,
    amostra: false,
    // FR-04 ativo: até entes públicos têm "sanção" no fixture — não podem alertar.
    sancoes: [
      consulta(CNPJ_PREFEITURA),
      consulta(CNPJ_IPREMM),
      consulta(CNPJ_ALFA),
      consulta(CNPJ_BETA),
      consulta(CNPJ_GAMA),
    ],
    // FR-04E ativo: sanção ESTADUAL (Apenados TCE-SP) — inclui a Prefeitura, que
    // NÃO pode virar alerta de fornecedor (era regressão do padrão nesse detector).
    sancoesEstaduais: [
      consulta(CNPJ_PREFEITURA),
      consulta(CNPJ_ALFA),
      consulta(CNPJ_GAMA),
    ],
    dataReferencia: DATA_REF,
  };
}

// ── A INVARIANTE ──────────────────────────────────────────────────────────────

test('INVARIANTE-MÃE: nenhum alerta de fornecedor aponta para ente público', () => {
  const ctx = fixtureComEntesPublicosComoFornecedor();
  const alertas = rodarDetectores(ctx);

  const violacoes = alertas.filter(
    (a: AlertaDetectado) =>
      a.sujeitoTipo === 'fornecedor' &&
      ehEntidadePublica(a.sujeitoId, a.sujeitoRotulo),
  );

  assert.deepEqual(
    violacoes.map((v) => ({
      detectorId: v.detectorId,
      sujeitoId: v.sujeitoId,
      sujeitoRotulo: v.sujeitoRotulo,
    })),
    [],
    'Detector(es) trataram um ente público como FORNECEDOR — bug "Prefeitura como fornecedor"',
  );
});

test('INVARIANTE: o pipeline NÃO está vazio — há fornecedores privados detectáveis', () => {
  // Garante que a invariante acima não passou só porque ninguém emitiu nada.
  // A fixture tem concentração/grupo de CNPJ entre privados — algo deve sair.
  const ctx = fixtureComEntesPublicosComoFornecedor();
  const alertas = rodarDetectores(ctx);
  assert.ok(alertas.length > 0, 'pipeline não gerou nenhum alerta — fixture fraca');

  // E pelo menos um alerta de fornecedor aponta para um CNPJ privado de verdade.
  const fornecedoresPrivados = alertas.filter(
    (a) => a.sujeitoTipo === 'fornecedor' && !ehEntidadePublica(a.sujeitoId, a.sujeitoRotulo),
  );
  assert.ok(
    fornecedoresPrivados.length > 0,
    'nenhum fornecedor PRIVADO virou alerta — a invariante seria vacuamente verdadeira',
  );
});

test('INVARIANTE: especificamente FR-04 não acusa ente público mesmo "sancionado"', () => {
  const ctx = fixtureComEntesPublicosComoFornecedor();
  const fr04 = rodarDetectores(ctx).filter((a) => a.detectorId === 'FR-04');
  // Há sanção vigente no fixture para os privados → FR-04 deve disparar para eles…
  assert.ok(fr04.length > 0, 'FR-04 deveria ter disparado para fornecedores privados');
  // …e para NENHUM ente público.
  for (const a of fr04) {
    assert.equal(
      ehEntidadePublica(a.sujeitoId, a.sujeitoRotulo),
      false,
      `FR-04 acusou ente público: ${a.sujeitoRotulo} (${a.sujeitoId})`,
    );
  }
});

test('DETECTOR-VIVO: OR-07 e MF-10 EMITEM (guarda contra import quebrado engolido por rodarDetectores)', () => {
  // rodarDetectores captura erro por detector — um import faltando vira
  // ReferenceError ENGOLIDA e o detector some silenciosamente (regressão real,
  // 2026-06-10). A invariante-mãe é vacuamente verde nesse caso. Este teste
  // afirma que os dois detectores REALMENTE produzem alerta para os
  // fornecedores PRIVADOS da fixture (anulações de GAMA / RAP antigo de ALFA).
  const ctx = fixtureComEntesPublicosComoFornecedor();
  const alertas = rodarDetectores(ctx);
  const or07 = alertas.filter((a) => a.detectorId === 'OR-07');
  const mf10 = alertas.filter((a) => a.detectorId === 'MF-10');
  assert.ok(
    or07.length > 0,
    'OR-07 não emitiu — detector provavelmente QUEBRADO (import faltando engolido por rodarDetectores)',
  );
  assert.ok(
    mf10.length > 0,
    'MF-10 não emitiu — detector provavelmente QUEBRADO (import faltando engolido por rodarDetectores)',
  );
  // E o filtro P0 segue valendo: nenhum deles aponta ente público.
  for (const a of [...or07, ...mf10]) {
    assert.equal(
      ehEntidadePublica(a.sujeitoId, a.sujeitoRotulo),
      false,
      `${a.detectorId} acusou ente público: ${a.sujeitoRotulo} (${a.sujeitoId})`,
    );
  }
});
