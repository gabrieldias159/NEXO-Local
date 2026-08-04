/**
 * NEXO — regressão de `entidades.ts` (resolução/sanitização de entidades).
 *
 * Cobre a fonte da verdade do problema de qualidade nº 1 do dono: separar
 * "fornecedor privado de verdade" de ente público, e a chave canônica que
 * colapsa filiais de um mesmo grupo.
 *
 * Auto-executável: `npx tsx entidades.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ehEntidadePublica,
  cnpjRaiz,
  docValido,
  idCanonicoEntidade,
  rotuloCanonico,
  normalizarNome,
} from '../entidades';
import { MARILIA } from '../constants';

// ── Documentos de teste (Módulo 11 confirmado via cpf-cnpj-validator) ─────────
// CNPJ matriz e filial do MESMO grupo (raiz 11222333):
const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL = '11222333000262';
// CNPJ privado de grupo diferente (raiz 19131243):
const CNPJ_OUTRO = '19131243000197';
// Lixo numérico do TCE — código interno de pessoa física (6 dígitos):
const LIXO_TCE = '605238';
// Entes públicos:
const CNPJ_PREFEITURA = MARILIA.cnpjPrefeitura; // 44477909000100 (na denylist)
const CNPJ_IPREMM = '59989830000136'; // RPPS de Marília (na denylist)

// ── ehEntidadePublica ─────────────────────────────────────────────────────────

test('ehEntidadePublica: TRUE por doc na denylist (Prefeitura e IPREMM)', () => {
  assert.equal(ehEntidadePublica(CNPJ_PREFEITURA), true);
  assert.equal(ehEntidadePublica(CNPJ_IPREMM), true);
  // Filial de uma raiz pública também é pública (RAIZES_PUBLICAS).
  const filialPrefeitura = CNPJ_PREFEITURA.slice(0, 8) + '000262';
  assert.equal(ehEntidadePublica(filialPrefeitura), true);
});

test('ehEntidadePublica: TRUE por NOME via RE_ORGAO_PUBLICO', () => {
  // Mesmo com CNPJ privado/desconhecido, o nome inequívoco marca como público.
  assert.equal(ehEntidadePublica(CNPJ_OUTRO, 'PREFEITURA MUNICIPAL DE MARILIA'), true);
  assert.equal(ehEntidadePublica('', 'Câmara Municipal de Marília'), true);
  assert.equal(ehEntidadePublica('', 'Serviço Autônomo de Água e Esgoto - SAAE'), true);
  assert.equal(ehEntidadePublica('', 'Instituto de Previdência - IPREMM'), true);
  // Sem acento e em caixa baixa também (normalizarNome resolve).
  assert.equal(ehEntidadePublica('', 'fundo municipal de saude'), true);
});

test('ehEntidadePublica: FALSE para empresa privada (doc e nome)', () => {
  assert.equal(ehEntidadePublica(CNPJ_MATRIZ, 'COMERCIAL ALFA LTDA'), false);
  assert.equal(ehEntidadePublica(CNPJ_OUTRO, 'BETA SERVICOS EIRELI'), false);
  // Sem doc e sem nome: não dá pra afirmar que é público → FALSE.
  assert.equal(ehEntidadePublica('', ''), false);
  assert.equal(ehEntidadePublica(null, null), false);
});

// ── cnpjRaiz ──────────────────────────────────────────────────────────────────

test('cnpjRaiz: pega os 8 primeiros dígitos de um CNPJ de 14', () => {
  assert.equal(cnpjRaiz(CNPJ_MATRIZ), '11222333');
  assert.equal(cnpjRaiz(CNPJ_FILIAL), '11222333'); // mesma raiz da matriz
  // Aceita CNPJ formatado (só dígitos é extraído).
  assert.equal(cnpjRaiz('11.222.333/0001-81'), '11222333');
});

test('cnpjRaiz: CPF (11 díg) não tem raiz — devolve os dígitos inteiros', () => {
  const cpfDigits = '77515872020'; // 11 dígitos
  assert.equal(cnpjRaiz(cpfDigits), cpfDigits);
  // Lixo de tamanho diferente de 14 também volta como veio.
  assert.equal(cnpjRaiz(LIXO_TCE), LIXO_TCE);
});

// ── docValido (Módulo 11) ─────────────────────────────────────────────────────

test('docValido: rejeita lixo numérico do TCE e 6 dígitos', () => {
  assert.equal(docValido('PESSOA FISICA - 605238'), false); // soDigitos => 605238
  assert.equal(docValido(LIXO_TCE), false); // 6 dígitos não é CPF nem CNPJ
  assert.equal(docValido(''), false);
  assert.equal(docValido(null), false);
});

test('docValido: aceita um CNPJ válido real de teste', () => {
  assert.equal(docValido(CNPJ_MATRIZ), true);
  assert.equal(docValido(CNPJ_FILIAL), true);
  assert.equal(docValido(CNPJ_OUTRO), true);
  // Dígito verificador errado é rejeitado.
  assert.equal(docValido('11222333000180'), false);
});

// ── idCanonicoEntidade ────────────────────────────────────────────────────────

test('idCanonicoEntidade: agrupa filiais de um grupo pela raiz do CNPJ', () => {
  const idMatriz = idCanonicoEntidade(CNPJ_MATRIZ, 'GRUPO ALFA MATRIZ LTDA');
  const idFilial = idCanonicoEntidade(CNPJ_FILIAL, 'GRUPO ALFA FILIAL LTDA');
  assert.equal(idMatriz, '11222333');
  assert.equal(idFilial, '11222333');
  assert.equal(idMatriz, idFilial); // colapsam na MESMA entidade
  // Grupo diferente não colapsa.
  assert.notEqual(idCanonicoEntidade(CNPJ_OUTRO, 'BETA'), idMatriz);
});

test('idCanonicoEntidade: doc inválido cai no rótulo do nome', () => {
  // Código interno do TCE não é doc real → usa o rótulo canônico do nome.
  const id = idCanonicoEntidade(LIXO_TCE, 'Construtora Gama Ltda.');
  assert.equal(id, rotuloCanonico('Construtora Gama Ltda.'));
  assert.equal(id, 'CONSTRUTORA GAMA');
  // Sem doc e sem nome → marcador estável '(sem id)'.
  assert.equal(idCanonicoEntidade('', ''), '(sem id)');
  assert.equal(idCanonicoEntidade(null, null), '(sem id)');
});

test('idCanonicoEntidade: mesmo nome com grafias diferentes colapsa via rótulo', () => {
  // Dois registros sem doc válido, mesma empresa escrita de formas distintas.
  const a = idCanonicoEntidade(LIXO_TCE, 'COMERCIAL ALFA LTDA');
  const b = idCanonicoEntidade('', 'comercial alfa  ltda.');
  assert.equal(a, b);
  assert.equal(a, 'COMERCIAL ALFA');
});

// ── normalizarNome / rotuloCanonico (helpers públicos de apoio) ───────────────

test('normalizarNome: remove acento, normaliza caixa e espaços', () => {
  assert.equal(normalizarNome('  Construção   Civíl  '), 'CONSTRUCAO CIVIL');
  assert.equal(normalizarNome(null), '');
});

test('rotuloCanonico: tira sufixo empresarial e pontuação final', () => {
  assert.equal(rotuloCanonico('Comercial Alfa LTDA.'), 'COMERCIAL ALFA');
  assert.equal(rotuloCanonico('Beta Serviços EIRELI'), 'BETA SERVICOS');
});
