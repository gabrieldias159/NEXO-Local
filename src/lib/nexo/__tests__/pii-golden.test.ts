/**
 * GOLDEN cross-ambiente do pii.ts — guarda a invariante que silenciosamente
 * quebra todo o cruzamento do NEXO se violada.
 *
 * `src/lib/nexo/pii.ts` (app) e `functions/src/nexo/pii.ts` (coletores) DEVEM
 * produzir hash/máscara IDÊNTICOS: o coletor grava `docHash = hashDoc(x)` com o
 * pii das functions; o detector casa o fornecedor com `hashDoc(x)` do pii do
 * app. Se os dois divergirem (salt ou algoritmo), o JOIN doador↔fornecedor↔sócio
 * não casa NADA — sem erro, sem alerta, só silêncio. Este teste falha o build
 * antes disso chegar em prod (recomendação B1/golden do conselho).
 *
 * Também canário do SALT: prova que `hashDoc` respeita `NEXO_PII_SALT` — se o
 * segredo for ignorado, o salt público não protege contra ataque de dicionário.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as piiApp from '../pii';
import * as piiFns from '../../../../functions/src/nexo/pii';

// Bateria: CNPJ válido, CPF, vazio, lixo, e já-mascarado/formatado.
const DOCS = [
  '11222333000181',
  '19131243000197',
  '11444777000161',
  '12345678901',
  '',
  '0',
  'abc.123',
  '11.222.333/0001-81',
];

test('GOLDEN: hashDoc IDÊNTICO entre src/ e functions/ (join cross-source não quebra)', () => {
  for (const d of DOCS) {
    assert.equal(
      piiApp.hashDoc(d),
      piiFns.hashDoc(d),
      `hashDoc divergiu para "${d}" — o cruzamento empenho↔contrato↔sanção quebraria SILENCIOSAMENTE`,
    );
  }
});

test('GOLDEN: mascararDoc IDÊNTICO entre src/ e functions/', () => {
  for (const d of DOCS) {
    assert.equal(piiApp.mascararDoc(d), piiFns.mascararDoc(d), `mascararDoc divergiu para "${d}"`);
  }
});

test('CANÁRIO de salt: hashDoc respeita NEXO_PII_SALT (o segredo protege de fato)', () => {
  const doc = '11222333000181';
  const comFallback = piiApp.hashDoc(doc);
  process.env.NEXO_PII_SALT = 'salt-de-teste-canario-distinto-do-fallback';
  try {
    const comSegredo = piiApp.hashDoc(doc);
    assert.notEqual(
      comSegredo,
      comFallback,
      'hashDoc IGNOROU NEXO_PII_SALT — o salt público não estaria protegendo nada',
    );
    // E os dois lados continuam casando com o MESMO segredo ativo.
    assert.equal(comSegredo, piiFns.hashDoc(doc), 'src/ e functions/ divergem com NEXO_PII_SALT setado');
  } finally {
    delete process.env.NEXO_PII_SALT;
  }
});
