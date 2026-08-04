/**
 * Cron de ingestão de PARCERIAS DE EMENDA PARLAMENTAR (Lei 13.019/2014) —
 * `onNexoSyncLei13019`.
 *
 * Coleta o portal de prestação de contas `lei13019.com.br` (orgão Prefeitura
 * Municipal de Marília, orgao_id=23): convênios/termos de colaboração cuja
 * origem é uma emenda parlamentar municipal — QUALQUER vereador, não só um
 * autor específico. Complementa `nexo_emendas` (SAGL + SICONFI/SMARAPD, que
 * cobre a emenda como PEÇA ORÇAMENTÁRIA) com o lado de EXECUÇÃO DA PARCERIA
 * civil com a entidade beneficiária: quem é a OSC, o CNPJ, o objeto da
 * parceria e quanto já foi efetivamente PRESTADO em despesas (comprovação).
 *
 * Persiste em `nexo_emendas_parcerias`, uma doc por parceria (proposta/
 * instrumento). Cadência quinzenal — o portal muda devagar (repasses e
 * prestação de contas de OSC não são diários).
 *
 * Duas fases por ciclo:
 *   1) LISTAGEM — varre `prestacao-de-contas-emenda.php` por ano × origem de
 *      recurso (os anos são DESCOBERTOS da própria página via o <select
 *      name="ano">, não hardcoded — acompanha o portal adicionando anos).
 *   2) DETALHE — para cada parceria única da listagem, busca a página de
 *      detalhe (entidade/CNPJ/objeto) e a de despesas (comprovação). ~150
 *      parcerias × 2 páginas, ritmo respeitoso (350ms entre chamadas) — cabe
 *      folgado no timeout de 1800s.
 *
 * Self-contained: re-implementa o parsing de HTML (não importa de `src/`).
 * Portal público, sem autenticação; exige `User-Agent` de navegador.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { createHash } from "crypto";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

const BASE = "https://www.lei13019.com.br";
const LISTAGEM_PATH = "/prestacao-de-contas-emenda.php";
/** Prefeitura Municipal de Marília no portal lei13019.com.br. */
const ORGAO_PARAMS =
  "orgao_id=23&orgao_nome=Prefeitura+Municipal+de+Marilia&orgao_estado=SP&orgao_logomarca=jpg";
const TIMEOUT_MS = 20_000;
const DELAY_LISTAGEM_MS = 300;
const DELAY_DETALHE_MS = 350;
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; NEXO-Marilia/1.0)" };

/** Origem de recurso — enum fixo do portal (municipal/estadual/federal/mista). */
const ORIGENS = ["1", "2", "5", "mista"] as const;

async function buscarHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`lei13019 HTTP ${res.status} em ${url}`);
  return res.text();
}

function decodeEntidades(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function textoDeHtml(html: string): string {
  return decodeEntidades(
    html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function parseValorBR(v: string): number {
  const n = Number(v.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/** Valida que a string já vem em `yyyy-MM-dd` (formato usado pelos params `inicio`/`termino` do portal), ou null. */
function isoOuNull(v: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** lowercase + sem acento — normalização de busca por autor. */
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

// ── Fase 1: listagem ──────────────────────────────────────────────────────

/** Uma linha crua da listagem (`prestacao-de-contas-emenda.php`). */
interface LinhaListagem {
  proposta: string;
  instrumento: string;
  numeroInstrumento: string;
  parlamentarRaw: string;
  autor: string;
  emendaRaw: string;
  anoListagem: number;
  unidadeGestora: string;
  valor: number;
  idEntidades: string;
  idPlanoTrabalho: string;
  anoInstrumento: number | null;
  vigenciaInicio: string | null;
  vigenciaTermino: string | null;
  /** Path relativo (com querystring) da página de detalhe da parceria. */
  hrefDetalhe: string;
}

/**
 * Descobre os anos disponíveis no filtro da listagem (`<select name="ano">`).
 * Falha ao parsear → devolve `[]` (o chamador cai no fallback hardcoded).
 */
function extrairAnosDoHtml(html: string): number[] {
  const bloco = /<select[^>]*name="ano"[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  if (!bloco) return [];
  const anos: number[] = [];
  for (const m of bloco[1].matchAll(/<option value="(\d{4})"/g)) {
    anos.push(Number(m[1]));
  }
  return anos;
}

/** Extrai o valor de um parâmetro de querystring de uma URL/href (com espaços internos tolerados). */
function paramDeHref(href: string, chave: string): string {
  const limpo = href.replace(/\s+/g, "");
  const m = new RegExp(`[?&]${chave}=([^&"]*)`).exec(limpo);
  return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "";
}

function parseLinhasListagem(html: string): LinhaListagem[] {
  const linhas: LinhaListagem[] = [];
  for (const trM of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const tds = [...trM[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1],
    );
    if (tds.length !== 7) continue; // linha de cabeçalho ou lixo estrutural
    const cel = tds.map(textoDeHtml);
    if (/Tipo do Instrumento/i.test(cel[1])) continue; // cabeçalho

    const href = (trM[1].match(/href="([^"]*)"/) || [])[1] || "";
    const parlamentarRaw = cel[3];
    // O portal usa "Emenda Impositiva:" na maioria das linhas, mas algumas
    // trazem "Demais Emendas:" — aceita ambos os rótulos.
    const am = /Parlamentar:\s*(.*?),\s*(?:Emenda Impositiva|Demais Emendas):\s*(.*)$/.exec(
      parlamentarRaw,
    );
    const anoInstrumentoStr = paramDeHref(href, "ano_instrumento");
    linhas.push({
      proposta: cel[0],
      instrumento: cel[1],
      numeroInstrumento: cel[2],
      parlamentarRaw,
      autor: am ? am[1].trim() : "",
      emendaRaw: am ? am[2].trim() : "",
      anoListagem: Number(cel[4]) || 0,
      unidadeGestora: cel[5],
      valor: parseValorBR(cel[6]),
      idEntidades: paramDeHref(href, "id_entidades"),
      idPlanoTrabalho: paramDeHref(href, "id_plano_de_trabalho"),
      anoInstrumento: anoInstrumentoStr ? Number(anoInstrumentoStr) : null,
      vigenciaInicio: isoOuNull(paramDeHref(href, "inicio")),
      vigenciaTermino: isoOuNull(paramDeHref(href, "termino")),
      hrefDetalhe: href.replace(/\s+/g, ""),
    });
  }
  return linhas;
}

/**
 * Varre a listagem inteira (ano × origem). O portal pagina a busca "todas" e
 * o parser só lê a página 1 — em recortes grandes (>60 itens) isso perderia
 * registro; iterar por ano×origem individualmente mantém cada consulta sob o
 * teto de uma página (validado em campo: a soma por ano×origem bate o total
 * declarado pelo portal). Dedupe por chave estável.
 */
async function coletarListagemCompleta(): Promise<LinhaListagem[]> {
  const anosDescobertos = extrairAnosDoHtml(
    await buscarHtml(`${BASE}${LISTAGEM_PATH}?${ORGAO_PARAMS}`),
  );
  // Fallback honesto: se o parsing do <select> falhar, cobre pelo menos os
  // anos conhecidos em 2026-08 — melhor que não coletar nada.
  const anos = anosDescobertos.length > 0
    ? anosDescobertos
    : [2021, 2023, 2024, 2025, 2026];

  const porChave = new Map<string, LinhaListagem>();
  for (const ano of anos) {
    for (const origem of ORIGENS) {
      const url = `${BASE}${LISTAGEM_PATH}?${ORGAO_PARAMS}&origem_de_recurso=${origem}&ano=${ano}`;
      let html: string;
      try {
        html = await buscarHtml(url);
      } catch (err) {
        logger.warn(
          `NEXO lei13019 — falha na listagem ano=${ano} origem=${origem}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      for (const linha of parseLinhasListagem(html)) {
        const chave = `${linha.idPlanoTrabalho}|${linha.proposta}|${linha.autor}|${linha.emendaRaw}|${linha.valor}`;
        if (!porChave.has(chave)) porChave.set(chave, linha);
      }
      await new Promise((r) => setTimeout(r, DELAY_LISTAGEM_MS));
    }
  }
  return [...porChave.values()];
}

// ── Fase 2: detalhe + despesas ────────────────────────────────────────────

interface DetalheParceria {
  entidade: string;
  cnpj: string;
  endereco: string;
  objeto: string;
}

function extrairCampoH5(html: string, rotulo: string): string {
  const re = new RegExp(`<strong>${rotulo}:</strong>([\\s\\S]*?)</h5>`, "i");
  const m = re.exec(html);
  return m ? textoDeHtml(m[1]) : "";
}

function parseDetalhe(html: string): DetalheParceria {
  const entidadeLinha = /<strong>Entidade:<\/strong>([\s\S]*?)<\/h5>/i.exec(html);
  const entidadeTxt = entidadeLinha ? textoDeHtml(entidadeLinha[1]) : "";
  const cnpj = (/CNPJ:\s*([\d./-]+)/.exec(entidadeTxt) || [])[1] || "";
  const entidade = entidadeTxt.replace(/-?\s*CNPJ:.*$/, "").trim();
  return {
    entidade,
    cnpj: cnpj.replace(/\D/g, ""),
    endereco: extrairCampoH5(html, "Endereço"),
    objeto: extrairCampoH5(html, "Objeto"),
  };
}

interface DespesasParceria {
  total: number;
  count: number;
  porSituacao: Record<string, number>;
}

/**
 * Parseia a tabela de despesas prestadas — 13 colunas, valor líquido na
 * coluna 12 (0-based 11) e situação na 13ª. Linhas sem data de emissão
 * (cabeçalho, rodapé) são descartadas.
 */
function parseDespesas(html: string): DespesasParceria {
  const out: DespesasParceria = { total: 0, count: 0, porSituacao: {} };
  for (const trM of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const tds = [...trM[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      textoDeHtml(m[1]),
    );
    if (tds.length < 13) continue;
    if (/Vínculo Financeiro/i.test(tds[0])) continue;
    if (!/\d{2}\/\d{2}\/\d{4}/.test(tds[6])) continue; // sem data de emissão
    const liquido = parseValorBR(tds[11]);
    const situacao = tds[12] || "—";
    out.total += liquido;
    out.count++;
    out.porSituacao[situacao] = (out.porSituacao[situacao] ?? 0) + liquido;
  }
  return out;
}

/** Busca detalhe + despesas de uma parceria. Nunca lança — devolve parcial em falha. */
async function buscarDetalheEDespesas(
  hrefDetalhe: string,
): Promise<{ detalhe: DetalheParceria; despesas: DespesasParceria; erro: string | null }> {
  let detalhe: DetalheParceria = { entidade: "", cnpj: "", endereco: "", objeto: "" };
  let despesas: DespesasParceria = { total: 0, count: 0, porSituacao: {} };
  try {
    const htmlDetalhe = await buscarHtml(`${BASE}/${hrefDetalhe}`);
    detalhe = parseDetalhe(htmlDetalhe);
  } catch (err) {
    return { detalhe, despesas, erro: err instanceof Error ? err.message : String(err) };
  }
  await new Promise((r) => setTimeout(r, DELAY_DETALHE_MS));
  try {
    const hrefDespesas = hrefDetalhe.replace(
      "propostas-menu-emenda",
      "propostas-despesas-emenda",
    );
    const htmlDespesas = await buscarHtml(`${BASE}/${hrefDespesas}`);
    despesas = parseDespesas(htmlDespesas);
  } catch (err) {
    // Detalhe coletado, despesas falharam — devolve o que deu certo.
    return { detalhe, despesas, erro: err instanceof Error ? err.message : String(err) };
  }
  return { detalhe, despesas, erro: null };
}

// ── Persistência ──────────────────────────────────────────────────────────

interface ParceriaNorm extends LinhaListagem, DetalheParceria {
  id: string;
  autorNorm: string;
  despesasTotal: number;
  despesasCount: number;
  despesasPorSituacao: Record<string, number>;
  pctPrestado: number;
  erroDetalhe: string | null;
}

function idParceria(linha: LinhaListagem): string {
  const natural = linha.idPlanoTrabalho || linha.proposta;
  const hash = createHash("sha1")
    .update(`${linha.proposta}|${linha.idEntidades}|${linha.numeroInstrumento}`)
    .digest("hex")
    .slice(0, 12);
  return `${natural}-${hash}`.replace(/[^\w-]/g, "_");
}

async function persistirParcerias(parcerias: ParceriaNorm[]): Promise<Set<string>> {
  let batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ids = new Set<string>();
  let n = 0;
  for (const p of parcerias) {
    ids.add(p.id);
    batch.set(
      db.collection("nexo_emendas_parcerias").doc(p.id),
      { ...p, _fonte: "lei13019", _orgaoId: 23, _coletadoEm: now },
      { merge: true },
    );
    n++;
    if (n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
  return ids;
}

/** Remove parcerias que a coleta atual não trouxe mais (instrumento encerrado/removido do portal). */
async function purgarObsoletas(idsAtuais: Set<string>): Promise<number> {
  const snap = await db
    .collection("nexo_emendas_parcerias")
    .where("_fonte", "==", "lei13019")
    .select()
    .get();
  let batch = db.batch();
  let removidos = 0;
  for (const doc of snap.docs) {
    if (idsAtuais.has(doc.id)) continue;
    batch.delete(doc.ref);
    removidos++;
    if (removidos % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (removidos % 400 !== 0) await batch.commit();
  return removidos;
}

// ── Orquestração de um ciclo ──────────────────────────────────────────────

interface ResultadoCiclo {
  linhasListagem: number;
  parceriasUnicas: number;
  detalhesOk: number;
  detalhesComErro: number;
  persistidas: number;
  removidas: number;
}

/**
 * Roda um ciclo completo: listagem → (opcional) detalhe/despesas → persiste.
 * `pularDetalhe` permite um ciclo rápido (só listagem) para teste/smoke.
 */
async function rodarCiclo(opts: {
  pularDetalhe?: boolean;
  anosFiltro?: number[];
} = {}): Promise<ResultadoCiclo> {
  let linhas = await coletarListagemCompleta();
  if (opts.anosFiltro && opts.anosFiltro.length > 0) {
    const permitido = new Set(opts.anosFiltro);
    linhas = linhas.filter((l) => permitido.has(l.anoListagem));
  }

  let detalhesOk = 0;
  let detalhesComErro = 0;
  const parcerias: ParceriaNorm[] = [];

  for (const linha of linhas) {
    let detalhe: DetalheParceria = { entidade: "", cnpj: "", endereco: "", objeto: "" };
    let despesas: DespesasParceria = { total: 0, count: 0, porSituacao: {} };
    let erro: string | null = null;
    if (!opts.pularDetalhe && linha.hrefDetalhe) {
      const res = await buscarDetalheEDespesas(linha.hrefDetalhe);
      detalhe = res.detalhe;
      despesas = res.despesas;
      erro = res.erro;
      if (erro) detalhesComErro++;
      else detalhesOk++;
    }
    parcerias.push({
      ...linha,
      ...detalhe,
      id: idParceria(linha),
      autorNorm: norm(linha.autor),
      despesasTotal: despesas.total,
      despesasCount: despesas.count,
      despesasPorSituacao: despesas.porSituacao,
      pctPrestado: linha.valor > 0 ? Math.round((despesas.total / linha.valor) * 1000) / 10 : 0,
      erroDetalhe: erro,
    });
  }

  const ids = await persistirParcerias(parcerias);
  // Purga só roda em ciclo COMPLETO (sem filtro de anos e sem pular detalhe)
  // — um ciclo parcial de teste não deve apagar o resto do snapshot.
  const removidas =
    !opts.pularDetalhe && !opts.anosFiltro ? await purgarObsoletas(ids) : 0;

  return {
    linhasListagem: linhas.length,
    parceriasUnicas: parcerias.length,
    detalhesOk,
    detalhesComErro,
    persistidas: ids.size,
    removidas,
  };
}

// ── Cron quinzenal ─────────────────────────────────────────────────────────

export const onNexoSyncLei13019 = onSchedule(
  {
    // Dias 1 e 16 de cada mês, 06h40 BRT — cadência quinzenal (deslocada dos
    // demais crons quinzenais/1,16 do NEXO para não concorrer por CPU/rede).
    schedule: "40 6 1,16 * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    // ~150 parcerias × 2 páginas de detalhe × ~650ms (fetch+delay) ≈ 6-10min —
    // folga generosa até o teto.
    timeoutSeconds: 1800,
    memory: "512MiB",
    maxInstances: 1,
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    try {
      const r = await rodarCiclo();
      await gravarSyncState({
        syncId: "lei13019",
        fonte: "lei13019",
        colecao: "nexo_emendas_parcerias",
        cadencia: "quinzenal",
        sucesso: true,
        degradado: r.detalhesComErro > 0,
        erro: r.detalhesComErro > 0 ? `${r.detalhesComErro} parceria(s) com falha no detalhe` : null,
        duracaoMs: Date.now() - inicio,
        extra: { ...r },
      });
      logger.info(
        `NEXO lei13019 — concluído: ${r.parceriasUnicas} parcerias ` +
          `(${r.detalhesOk} detalhes ok, ${r.detalhesComErro} com erro), ` +
          `${r.persistidas} persistidas, ${r.removidas} removidas`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO lei13019 — falha no ciclo", err);
      await gravarSyncState({
        syncId: "lei13019",
        fonte: "lei13019",
        colecao: "nexo_emendas_parcerias",
        cadencia: "quinzenal",
        sucesso: false,
        erro: msg,
        duracaoMs: Date.now() - inicio,
      });
    }
  },
);

// ── Backfill/teste HTTP sob demanda ────────────────────────────────────────

/**
 * GET /onNexoBackfillLei13019Http?anos=2025,2026&pular_detalhe=1
 *   Header: x-backfill-secret: <SEGREDO>
 *
 * Dispara um ciclo imediato — útil para o emulador local (`npm run emu`) e
 * para reprocessar sob demanda. `anos` (opcional, csv) restringe o recorte;
 * `pular_detalhe=1` faz um ciclo rápido só de listagem (smoke test, não
 * persiste entidade/CNPJ/despesas e NÃO purga).
 */
export const onNexoBackfillLei13019Http = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 1800,
    memory: "512MiB",
    maxInstances: 1,
    invoker: "public",
  },
  async (req, res) => {
    const provided = String(req.headers["x-backfill-secret"] ?? "");
    const expected = process.env.DIARIO_BACKFILL_SECRET || "";
    if (!expected || provided !== expected) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const anosParam = String(req.query.anos ?? "");
    const anosFiltro = anosParam
      ? [
          ...new Set(
            anosParam
              .split(/[,\s]+/)
              .filter(Boolean)
              .map((s) => Number(s))
              .filter((n) => Number.isInteger(n) && n >= 2013 && n <= 2100),
          ),
        ]
      : undefined;
    const pularDetalhe = String(req.query.pular_detalhe ?? "") === "1";

    const inicio = Date.now();
    try {
      const r = await rodarCiclo({ pularDetalhe, anosFiltro });
      await gravarSyncState({
        syncId: "lei13019",
        fonte: "lei13019",
        colecao: "nexo_emendas_parcerias",
        cadencia: "evento",
        sucesso: true,
        degradado: r.detalhesComErro > 0,
        erro: r.detalhesComErro > 0 ? `${r.detalhesComErro} parceria(s) com falha no detalhe` : null,
        duracaoMs: Date.now() - inicio,
        extra: { ...r, anosFiltro: anosFiltro ?? null, pularDetalhe },
      });
      res.status(200).json({ ok: true, ...r });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO lei13019 — backfill falhou", err);
      res.status(500).json({ ok: false, erro: msg });
    }
  },
);
