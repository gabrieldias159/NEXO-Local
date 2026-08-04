/**
 * NEXO — regressão de `procedencia.ts` (camada de provas documentais).
 *
 * Protege o requisito central do dono (2026-06-03): cada evidência precisa de um
 * link clicável para a PROVA documental. Testa os builders de deep-link novos
 * (contrato/edital/dispensa/DOM-PDF/doc-catálogo) e a anexação por-evidência via
 * `enriquecerProcedencia(alerta)`, sem inventar URL (só padrões confirmados).
 *
 * Auto-executável: `npx tsx src/lib/nexo/__tests__/procedencia.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contratoMunicipal,
  dispensa,
  docCatalogo,
  domEdicaoPdf,
  editalLicitacao,
  enriquecerProcedencia,
  pncpFromRef,
  smarapdPdf,
} from '../procedencia';
import type { Evidencia } from '../detectores/tipos';

// ── Builders de documento ─────────────────────────────────────────────────────

test('contratoMunicipal: PDF assinado quando há token (embedável)', () => {
  const p = contratoMunicipal({ tokenPdf: 'abc123', numeroContrato: '45/2026' });
  assert.equal(p.fonte, 'PORTAL-MARILIA');
  assert.equal(p.tipoDoc, 'pdf');
  assert.equal(p.podePreview, true);
  assert.match(p.url, /\/portal\/download\/contratos\/abc123\//);
  assert.equal(p.refColecao, 'nexo_contratos_municipais');
  assert.equal(p.refId, '45/2026');
});

test('contratoMunicipal: detalhe forte quando há id interno', () => {
  const p = contratoMunicipal({ idInterno: '5512', numeroContrato: '45/2026' });
  assert.equal(p.tipoDoc, 'pagina');
  assert.match(p.url, /\/portal\/contrato\/5512$/);
});

test('contratoMunicipal: busca pré-preenchida como fallback (nunca null)', () => {
  const p = contratoMunicipal({
    numeroContrato: '45/2026',
    numeroProcesso: '12345/2026',
    contratada: 'ACME LTDA',
  });
  assert.equal(p.tipoDoc, 'modulo');
  // forma posicional do portal: .../contratos/1/0/{contratada}/{numero}/{processo}/...
  assert.match(p.url, /\/portal\/contratos\/1\/0\/ACME%20LTDA\/45%2F2026\/12345%2F2026\//);
});

test('editalLicitacao: detalhe forte com id; listagem sem id', () => {
  const forte = editalLicitacao({ idInterno: '991' });
  assert.match(forte.url, /\/portal\/editais\/0\/1\/991\//);
  assert.equal(forte.tipoDoc, 'pagina');

  const fraco = editalLicitacao({ numeroProcesso: '77/2026' });
  // listagem de licitações = forma posicional `/portal/editais/1` (tipo 1).
  // O antigo `/portal/licitacoes` dava HTTP 404 (rota inexistente no SiGoverno).
  assert.match(fraco.url, /\/portal\/editais\/1$/);
  assert.equal(fraco.refId, '77/2026');
});

test('dispensa: listagem de compras diretas + ponteiro pro processo', () => {
  const p = dispensa({ numeroProcesso: '88/2026' });
  assert.equal(p.fonte, 'PORTAL-MARILIA');
  // compras diretas = forma posicional `/portal/editais/4` (tipo 4 = Compra
  // Direta). O antigo `/portal/compras-diretas` dava HTTP 404 (rota inexistente).
  assert.match(p.url, /\/portal\/editais\/4$/);
  assert.equal(p.refColecao, 'nexo_licitacoes');
  assert.equal(p.refId, '88/2026');
});

test('domEdicaoPdf: proxy interno embedável; null se ano inválido', () => {
  const p = domEdicaoPdf(2026, 4188);
  assert.ok(p);
  assert.equal(p!.fonte, 'DOM');
  assert.equal(p!.tipoDoc, 'pdf');
  assert.equal(p!.podePreview, true);
  assert.equal(p!.url, '/api/diario-oficial/edition/2026/4188/pdf');
  assert.equal(p!.refId, '2026_4188');

  assert.equal(domEdicaoPdf('20', 4188), null);
  assert.equal(domEdicaoPdf(2026, ''), null);
});

test('docCatalogo: PDF direto > página; pointer ao catálogo por docId', () => {
  const comPdf = docCatalogo({
    docId: 'deadbeef',
    pdfUrl: 'https://x/y.pdf',
    url: 'https://x/page',
  });
  assert.equal(comPdf.tipoDoc, 'pdf');
  assert.equal(comPdf.podePreview, true);
  assert.equal(comPdf.url, 'https://x/y.pdf');
  assert.equal(comPdf.refColecao, 'nexo_documentos');
  assert.equal(comPdf.refId, 'deadbeef');

  const soPagina = docCatalogo({ chave: 'processo:1/2026', url: 'https://x/page' });
  assert.equal(soPagina.tipoDoc, 'pagina');
  assert.equal(soPagina.podePreview, false);
  assert.equal(soPagina.refId, 'processo:1/2026');

  // Sem URL alguma: degrada honestamente (url '' → UI cai no registro bruto).
  const semUrl = docCatalogo({ docId: 'abc' });
  assert.equal(semUrl.url, '');
  assert.equal(semUrl.tipoDoc, 'modulo');
  assert.equal(semUrl.podePreview, false);
});

// ── PNCP por ref (sanity do roteamento contrato vs edital) ────────────────────

test('pncpFromRef: tipo 2 → contrato, tipo 1 → edital', () => {
  const contrato = pncpFromRef('44477909000100-2-000001/2024');
  assert.ok(contrato);
  assert.match(contrato!.url, /\/app\/contratos\/44477909000100\/2024\/1$/);

  const edital = pncpFromRef('44477909000100-1-000007/2025');
  assert.ok(edital);
  assert.match(edital!.url, /\/app\/editais\/44477909000100\/2025\/7$/);

  assert.equal(pncpFromRef('nao-e-pncp'), null);
});

test('smarapdPdf: filemanager inline-embedável, arquivoUrl verbatim', () => {
  const p = smarapdPdf('rel%2Flrf%2F2026.pdf');
  assert.equal(p.tipoDoc, 'pdf');
  assert.equal(p.podePreview, true);
  // NÃO re-encoda: o %2F precisa chegar verbatim.
  assert.match(p.url, /nomeArquivo=rel%2Flrf%2F2026\.pdf&isInlineContent=true/);
});

// ── enriquecerProcedencia(alerta): anexa por-evidência, preserva existentes ───

function alertaBase(over: Record<string, unknown> = {}) {
  return {
    detectorId: 'LC-01',
    categoria: 'Licitações e compras',
    sujeitoTipo: 'fornecedor' as const,
    sujeitoId: '44477909000100',
    sujeitoRotulo: 'ACME LTDA',
    exercicio: 2026,
    evidencias: [] as Evidencia[],
    ...over,
  };
}

test('anexa procedência às evidências SEM procedência e preserva as COM', () => {
  const existente = smarapdPdf('rel%2Fx.pdf');
  const alerta = alertaBase({
    evidencias: [
      { resumo: 'Empenho 12345 — R$ 10.000,00', ref: 'EMP-1' },
      { resumo: 'Já tem prova', ref: 'EMP-2', procedencia: existente },
    ],
  });

  const out = enriquecerProcedencia(alerta);
  // não muta o original
  assert.equal(alerta.evidencias[0].procedencia, undefined);
  // evidência 0 ganhou procedência (módulo SMARAPD, contexto empenho)
  assert.ok(out.evidencias[0].procedencia);
  assert.equal(out.evidencias[0].procedencia!.fonte, 'SMARAPD');
  // evidência 1 preservada VERBATIM
  assert.equal(out.evidencias[1].procedencia, existente);
});

test('alerta de contrato → prova vira deep-link de contrato municipal', () => {
  const alerta = alertaBase({
    detectorId: 'LC-19',
    categoria: 'Contratos e licitações',
    sujeitoTipo: 'contrato',
    sujeitoId: 'pncp-id',
    sujeitoRotulo: '45/2026',
    evidencias: [{ resumo: 'Valor global atualizado: R$ 1.000.000,00' }],
  });
  const out = enriquecerProcedencia(alerta);
  const p = out.evidencias[0].procedencia!;
  assert.equal(p.fonte, 'PORTAL-MARILIA');
  assert.equal(p.refColecao, 'nexo_contratos_municipais');
  assert.equal(p.refId, '45/2026');
});

test('evidência com ref PNCP usa o builder PNCP (prova forte) e ignora o resto', () => {
  const alerta = alertaBase({
    sujeitoTipo: 'contrato',
    evidencias: [{ resumo: 'contrato X', ref: '44477909000100-2-000009/2024' }],
  });
  const out = enriquecerProcedencia(alerta);
  const p = out.evidencias[0].procedencia!;
  assert.equal(p.fonte, 'PNCP');
  assert.match(p.url, /\/app\/contratos\/44477909000100\/2024\/9$/);
});

test('evidência com ref DOM linka a edição do Diário', () => {
  const alerta = alertaBase({
    detectorId: 'DO-05',
    categoria: 'Diário Oficial',
    sujeitoTipo: 'orgao',
    evidencias: [{ resumo: 'Extrato no DOM', ref: '2026_4188' }],
  });
  const out = enriquecerProcedencia(alerta);
  const p = out.evidencias[0].procedencia!;
  assert.equal(p.fonte, 'DOM');
  assert.match(p.url, /\/diario-oficial\/2026\/4188$/);
});

test('forma LEGADA de 4 args segue funcionando (compat com route.ts)', () => {
  // ref PNCP → procedência única
  const p = enriquecerProcedencia('44477909000100-2-000001/2024', 'Contratos');
  assert.ok(p);
  assert.equal((p as { fonte: string }).fonte, 'PNCP');

  // ref vazio + contexto diária → módulo SMARAPD de diárias
  const m = enriquecerProcedencia(null, 'Diárias e viagens', 'servidor', 2026);
  assert.ok(m);
  assert.equal((m as { fonte: string }).fonte, 'SMARAPD');
});

test('contratação direta (DE-xx) → listagem de compras diretas', () => {
  const alerta = alertaBase({
    detectorId: 'DE-03',
    categoria: 'Dispensas e emergenciais',
    sujeitoTipo: 'fornecedor',
    evidencias: [{ resumo: 'Dispensa do processo 88/2026' }],
  });
  const out = enriquecerProcedencia(alerta);
  const p = out.evidencias[0].procedencia!;
  assert.equal(p.fonte, 'PORTAL-MARILIA');
  assert.match(p.url, /\/portal\/editais\/4$/);
  assert.equal(p.refId, '88/2026');
});
