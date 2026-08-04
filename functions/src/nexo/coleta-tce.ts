/**
 * Cron de ingestão TCE-SP — `onNexoSyncTce` (Fase 3 do plano-mestre).
 *
 * Coleta os fornecedores da Prefeitura de Marília a partir da API pública de
 * despesas do Tribunal de Contas do Estado de São Paulo e persiste em
 * `nexo_tce_fornecedores`. É a metade funcional do cruzamento XS-14 (o conjunto
 * "fornecedores que receberam empenho da Prefeitura de Marília").
 *
 * Cadência: quinzenal (dias 1 e 16, 05h45 BRT).
 *
 * A API do TCE-SP exige uma chamada por mês (`{ano}/{mes}`); a coleta varre os
 * meses em paralelo e tolera a falha de um mês sem derrubar o ciclo.
 *
 * Self-contained: re-implementa o fetch ao TCE-SP (não importa de `src/`).
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

/** Base da API pública do Portal da Transparência Municipal do TCE-SP. */
const TCE_API = "https://transparencia.tce.sp.gov.br/api/json";
/** Slug de Marília na API do TCE-SP (confirmado via /municipios). */
const TCE_SLUG = "marilia";
const TIMEOUT_MS = 20_000;
const UA = "NEXO/1.0 (monitoramento de transparência pública; +nexo)";

interface FornecedorTCE {
  documento: string;
  tipoDocumento: string;
  nome: string;
  valorEmpenhado: number;
  qtdEmpenhos: number;
  orgaos: string[];
  exercicio: number;
}

function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

function pickStr(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return "";
}

/** Converte valor em formato BR (`1.234,56`) ou numérico para number. */
function parseValorBR(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v !== "string") return 0;
  const n = Number(v.replace(/[R$\s.]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/**
 * O campo `id_fornecedor` vem como `"CNPJ - PESSOA JURÍDICA - 5998...0136"`.
 * Separa o tipo do documento (só dígitos). Defensiva — nunca lança.
 */
function parseIdFornecedor(raw: string): { tipo: string; documento: string } {
  const partes = raw.split("-").map((p) => p.trim());
  if (partes.length >= 3) {
    return {
      tipo: partes.slice(0, -1).join(" - "),
      documento: soDigitos(partes[partes.length - 1]),
    };
  }
  return { tipo: raw.trim(), documento: soDigitos(raw) };
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json, */*" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`TCE-SP HTTP ${res.status} em ${url}`);
  const txt = await res.text();
  if (!txt.trim()) return [];
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`TCE-SP devolveu resposta não-JSON em ${url}`);
  }
}

/**
 * Coleta e agrega os fornecedores de Marília num exercício. Varre os 12 meses
 * em paralelo; só eventos de "empenhado" entram (anulação/estorno são
 * descartados explicitamente — a raiz "empenh" sozinha não basta).
 */
async function coletarFornecedores(exercicio: number): Promise<{
  fornecedores: FornecedorTCE[];
  mesesColetados: number[];
  registrosBrutos: number;
  erro: string | null;
}> {
  const meses = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const acc = new Map<string, FornecedorTCE>();
  const mesesColetados: number[] = [];
  let registrosBrutos = 0;
  let erro: string | null = null;

  const respostas = await Promise.allSettled(
    meses.map(async (mes) => {
      const url = `${TCE_API}/despesas/${TCE_SLUG}/${exercicio}/${mes}`;
      return { mes, data: await fetchJson(url) };
    }),
  );

  for (const resposta of respostas) {
    if (resposta.status === "rejected") {
      if (!erro) {
        erro =
          resposta.reason instanceof Error
            ? resposta.reason.message
            : "erro desconhecido na coleta TCE-SP";
      }
      continue;
    }
    const { mes, data } = resposta.value;
    const linhas: Record<string, unknown>[] = Array.isArray(data)
      ? (data as Record<string, unknown>[])
      : Array.isArray((data as { despesas?: unknown }).despesas)
        ? (data as { despesas: Record<string, unknown>[] }).despesas
        : [];
    mesesColetados.push(mes);
    registrosBrutos += linhas.length;

    for (const rec of linhas) {
      const evento = pickStr(rec, "evento", "tp_despesa").toLowerCase();
      if (evento) {
        if (/anula|estorno|cancel/.test(evento)) continue;
        if (!evento.includes("empenh")) continue;
      }
      const idRaw = pickStr(rec, "id_fornecedor", "fornecedor_id");
      const nome = pickStr(rec, "nm_fornecedor", "fornecedor", "nome_fornecedor");
      if (!idRaw && !nome) continue;

      const { tipo, documento } = parseIdFornecedor(idRaw);
      const chave = documento || nome.toUpperCase();
      if (!chave) continue;

      const valor = parseValorBR(pickStr(rec, "vl_despesa", "valor", "vl_empenho"));
      const orgao = pickStr(rec, "orgao", "unidade");
      const atual = acc.get(chave);
      if (atual) {
        atual.valorEmpenhado += valor;
        atual.qtdEmpenhos += 1;
        if (orgao && !atual.orgaos.includes(orgao)) atual.orgaos.push(orgao);
        if (!atual.nome && nome) atual.nome = nome;
      } else {
        acc.set(chave, {
          documento,
          tipoDocumento: tipo,
          nome,
          valorEmpenhado: valor,
          qtdEmpenhos: 1,
          orgaos: orgao ? [orgao] : [],
          exercicio,
        });
      }
    }
  }

  const fornecedores = [...acc.values()].sort(
    (a, b) => b.valorEmpenhado - a.valorEmpenhado,
  );
  return { fornecedores, mesesColetados, registrosBrutos, erro };
}

/** ID determinístico de um fornecedor TCE — exercício + documento (ou nome). */
function idFornecedor(f: FornecedorTCE): string {
  const base = f.documento || f.nome.toUpperCase().slice(0, 40) || "sem-id";
  return `${f.exercicio}-${base}`.replace(/[^\w-]/g, "_");
}

/** Persiste os fornecedores em `nexo_tce_fornecedores`, em lotes de 400. */
async function persistirFornecedores(
  exercicio: number,
  fornecedores: FornecedorTCE[],
): Promise<{ count: number; ids: Set<string> }> {
  let batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ids = new Set<string>();
  let n = 0;
  for (const f of fornecedores) {
    const id = idFornecedor(f);
    if (ids.has(id)) continue;
    ids.add(id);
    batch.set(
      db.collection("nexo_tce_fornecedores").doc(id),
      {
        ...f,
        _fonte: "tce_sp",
        _exercicio: exercicio,
        _cnpj: f.documento,
        _fornecedor: f.nome,
        _valor: f.valorEmpenhado,
        _coletadoEm: now,
      },
      { merge: true },
    );
    n++;
    if (n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
  return { count: n, ids };
}

/** Remove fornecedores do exercício ausentes do snapshot atual. */
async function purgarObsoletos(
  exercicio: number,
  idsAtuais: Set<string>,
): Promise<number> {
  const snap = await db
    .collection("nexo_tce_fornecedores")
    .where("_exercicio", "==", exercicio)
    .where("_fonte", "==", "tce_sp")
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

// ── Cron quinzenal ───────────────────────────────────────────────────────────

export const onNexoSyncTce = onSchedule(
  {
    schedule: "45 5 1,16 * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    // Hardening (#13): no máximo UMA execução simultânea — evita que um disparo
    // atrasado/retry concorra com a execução em andamento e refaça a coleta.
    // (Lease/lock distribuído fica para onda posterior.)
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: fornecedores têm doc ID
    // determinístico (`{exercicio}-{documento|nome}`) com `merge`, então
    // reexecutar o cron após falha SOBRESCREVE, nunca duplica.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    const anoAtual = new Date().getFullYear();
    const anos = [anoAtual, anoAtual - 1];
    let totalFornecedores = 0;
    let totalRemovidos = 0;
    let falhas = 0;
    let parcial = false;
    let ultimoErro: string | null = null;

    for (const ano of anos) {
      try {
        const { fornecedores, mesesColetados, registrosBrutos, erro } =
          await coletarFornecedores(ano);
        // Falha total (nenhum mês coletado) — não persiste/purga este exercício.
        if (mesesColetados.length === 0) {
          falhas++;
          ultimoErro = erro ?? "nenhum mês coletado";
          logger.error(`NEXO TCE — ${ano}: coleta vazia (${ultimoErro})`);
          continue;
        }
        const { count, ids } = await persistirFornecedores(ano, fornecedores);
        totalFornecedores += count;
        if (mesesColetados.length === 12) {
          // Coleta íntegra (12 meses) — pode purgar com segurança.
          totalRemovidos += await purgarObsoletos(ano, ids);
        } else {
          // Coleta parcial — NÃO purga (apagaria fornecedores dos meses ausentes).
          parcial = true;
          if (erro) ultimoErro = erro;
        }
        logger.info(
          `NEXO TCE — ${ano}: ${count} fornecedores, ` +
            `${mesesColetados.length}/12 meses, ${registrosBrutos} registros` +
            (mesesColetados.length < 12 ? " [PARCIAL]" : ""),
        );
      } catch (err) {
        falhas++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.error(`NEXO TCE — falha no exercício ${ano}`, err);
      }
    }

    const sucesso = falhas < anos.length;
    await gravarSyncState({
      syncId: "tce",
      fonte: "tce_sp",
      colecao: "nexo_tce_fornecedores",
      cadencia: "quinzenal",
      sucesso,
      degradado: falhas > 0 || parcial,
      erro: falhas > 0 || parcial ? ultimoErro : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        exerciciosTentados: anos.length,
        exerciciosComFalha: falhas,
        registros: totalFornecedores,
        removidos: totalRemovidos,
        parcial,
      },
    });
    logger.info(
      `NEXO TCE — concluído: ${totalFornecedores} fornecedores, ` +
        `${totalRemovidos} obsoletos removidos, ${falhas} falhas`,
    );
  },
);
