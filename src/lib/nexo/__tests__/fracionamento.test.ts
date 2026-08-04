// Regressão do LC-01 (fracionamento): só empenhos por DISPENSA contam; empenhos
// vinculados a processo licitatório (contrato) são EXCLUÍDOS e não inflam o
// valor. Rodar: npx tsx src/lib/nexo/__tests__/fracionamento.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectorFracionamento } from '../detectores/fracionamento';
import { getLimiteDispensa } from '../limites';
import type { EmpenhoNorm } from '../normalizar';
import type { ContextoAnalise } from '../detectores/tipos';

const teto = getLimiteDispensa(2025).comprasServicos;
const val = Math.round(teto * 0.9); // cada empenho abaixo do teto

function emp(o: Partial<EmpenhoNorm>): EmpenhoNorm {
  return {
    id: o.id ?? 'x',
    cpfCnpj: o.cpfCnpj ?? '12345678000199',
    fornecedorNome: o.fornecedorNome ?? 'FORN LTDA',
    numeroEmpenho: o.numeroEmpenho ?? '1',
    exercicio: 2025,
    data: o.data ?? '2025-02-01',
    valorEmpenhado: o.valorEmpenhado ?? val,
    valorPago: 0,
    temLiquidacao: false,
    processoAdministrativo: o.processoAdministrativo ?? null,
    processoLicitatorio: o.processoLicitatorio ?? null,
    unidadeGestora: 'UG',
  };
}

function ctx(empenhos: EmpenhoNorm[]): ContextoAnalise {
  return {
    exercicio: 2025,
    empenhos,
    diarias: [],
    modalidades: [],
    restosAPagar: [],
    despesas: [],
    totalEmpenhado: 0,
    amostra: false,
  };
}

test('LC-01 dispara com empenhos por dispensa acima do limite', () => {
  const empenhos = [
    emp({ id: 'a', numeroEmpenho: '1', data: '2025-01-10' }),
    emp({ id: 'b', numeroEmpenho: '2', data: '2025-01-20' }),
    emp({ id: 'c', numeroEmpenho: '3', data: '2025-02-01' }),
  ];
  const alertas = detectorFracionamento.detectar(ctx(empenhos));
  assert.equal(alertas.length, 1);
  assert.equal(alertas[0].detectorId, 'LC-01');
  assert.equal(alertas[0].valorEnvolvido, val * 3);
});

test('LC-01 EXCLUI empenhos vinculados a contrato (não inflam o valor)', () => {
  const dispensas = [
    emp({ id: 'a', numeroEmpenho: '1', data: '2025-01-10' }),
    emp({ id: 'b', numeroEmpenho: '2', data: '2025-01-20' }),
    emp({ id: 'c', numeroEmpenho: '3', data: '2025-02-01' }),
  ];
  const contratos = [
    emp({ id: 'd', numeroEmpenho: '4', data: '2025-01-12', processoLicitatorio: 'PE-001/2025' }),
    emp({ id: 'e', numeroEmpenho: '5', data: '2025-01-22', processoLicitatorio: 'PE-001/2025' }),
  ];
  const alertas = detectorFracionamento.detectar(ctx([...dispensas, ...contratos]));
  assert.equal(alertas.length, 1);
  // Valor só das 3 dispensas — os 2 empenhos de contrato NÃO entram.
  assert.equal(alertas[0].valorEnvolvido, val * 3);
});

test('LC-01 NÃO dispara quando tudo é por licitação (contrato)', () => {
  const contratos = [
    emp({ id: 'a', numeroEmpenho: '1', data: '2025-01-10', processoLicitatorio: 'PE-1' }),
    emp({ id: 'b', numeroEmpenho: '2', data: '2025-01-20', processoLicitatorio: 'PE-1' }),
    emp({ id: 'c', numeroEmpenho: '3', data: '2025-02-01', processoLicitatorio: 'PE-1' }),
  ];
  const alertas = detectorFracionamento.detectar(ctx(contratos));
  assert.equal(alertas.length, 0);
});
