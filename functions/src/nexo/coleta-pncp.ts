/**
 * Cron de ingestão PNCP — `onNexoSyncPncp` (Fase 3 do plano-mestre).
 *
 * Coleta os contratos da Prefeitura de Marília no Portal Nacional de
 * Contratações Públicas (PNCP, Lei 14.133/2021) e persiste em `nexo_contratos`.
 *
 * ⚠ REGIÃO `southamerica-east1`: o PNCP responde HTTP 403 para IPs fora do
 * Brasil. Esta função PRECISA rodar em região brasileira — `us-central1`
 * falharia o ano inteiro com geo-bloqueio.
 *
 * Cadência: diária (05h25 BRT).
 *
 * Self-contained: re-implementa o fetch ao PNCP (não importa de `src/`).
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { createHash } from "crypto";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

/** Base da API de Consulta do PNCP. */
const PNCP_BASE = "https://pncp.gov.br/api/consulta";
/** CNPJ da Prefeitura Municipal de Marília (só dígitos) — `cnpjOrgao`. */
const MARILIA_CNPJ = "44477909000100";
const TIMEOUT_MS = 25_000;
/** Teto de páginas por exercício — uma prefeitura raramente excede. */
const MAX_PAGINAS = 30;

/** UA de browser — o PNCP recusa clients sem UA reconhecível. */
const PNCP_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
};

interface PncpPagina {
  data?: Record<string, unknown>[];
  totalPaginas?: number;
  totalRegistros?: number;
}

/** Consulta uma página de contratos do PNCP por intervalo de publicação. */
async function pncpContratos(
  cnpjOrgao: string,
  dataInicial: string,
  dataFinal: string,
  pagina: number,
): Promise<PncpPagina> {
  const url = new URL(`${PNCP_BASE}/v1/contratos`);
  url.searchParams.set("dataInicial", dataInicial);
  url.searchParams.set("dataFinal", dataFinal);
  url.searchParams.set("cnpjOrgao", cnpjOrgao);
  url.searchParams.set("pagina", String(pagina));

  const res = await fetch(url.toString(), {
    headers: PNCP_HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 403) {
    throw new Error(
      "PNCP HTTP 403 — geo-bloqueio (a função deve rodar em southamerica-east1)",
    );
  }
  if (res.status === 204) return { data: [], totalPaginas: 0 };
  if (!res.ok) throw new Error(`PNCP /v1/contratos HTTP ${res.status}`);
  return (await res.json()) as PncpPagina;
}

/**
 * Varre todas as páginas de contratos de um exercício (limitado por
 * `MAX_PAGINAS`). Falha numa página intermediária devolve o que já veio,
 * marcando a coleta como parcial.
 */
async function coletarContratos(
  exercicio: number,
): Promise<{ contratos: Record<string, unknown>[]; parcial: boolean }> {
  const dataInicial = `${exercicio}0101`;
  const dataFinal = `${exercicio}1231`;
  const primeira = await pncpContratos(MARILIA_CNPJ, dataInicial, dataFinal, 1);
  const out: Record<string, unknown>[] = [...(primeira.data ?? [])];
  const total = Math.min(primeira.totalPaginas ?? 1, MAX_PAGINAS);
  let parcial = false;
  for (let p = 2; p <= total; p++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const resp = await pncpContratos(MARILIA_CNPJ, dataInicial, dataFinal, p);
      out.push(...(resp.data ?? []));
    } catch (err) {
      parcial = true;
      logger.warn(
        `NEXO PNCP — ${exercicio}: falha na página ${p}/${total}, ` +
          `coleta parcial com ${out.length} contratos. ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }
  }
  return { contratos: out, parcial };
}

function campo(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    if (rec[k] != null && rec[k] !== "") return String(rec[k]);
  }
  return "";
}

/** ID estável de um contrato — usa o nº de controle PNCP (único nacional). */
function idContrato(rec: Record<string, unknown>, exercicio: number): string {
  const natural = campo(
    rec,
    "numeroControlePncpCompra",
    "numeroControlePNCP",
    "numeroControlePncp",
    "id",
  );
  const base = natural
    ? natural
    : createHash("sha1")
        .update(JSON.stringify(rec, Object.keys(rec).sort()))
        .digest("hex")
        .slice(0, 20);
  return `${exercicio}-${base}`.replace(/[^\w-]/g, "_");
}

/** Persiste os contratos em `nexo_contratos`, em lotes de 400. */
async function persistirContratos(
  exercicio: number,
  contratos: Record<string, unknown>[],
): Promise<{ count: number; ids: Set<string> }> {
  let batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ids = new Set<string>();
  let n = 0;
  for (const rec of contratos) {
    const id = idContrato(rec, exercicio);
    if (ids.has(id)) continue;
    ids.add(id);
    batch.set(
      db.collection("nexo_contratos").doc(id),
      {
        ...rec,
        _exercicio: exercicio,
        _fonte: "pncp",
        _cnpj: campo(rec, "niFornecedor", "cnpjCpfFornecedor").replace(
          /\D/g,
          "",
        ),
        _fornecedor: campo(
          rec,
          "nomeRazaoSocialFornecedor",
          "nomeFornecedor",
          "razaoSocialFornecedor",
        ),
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

/**
 * Remove de `nexo_contratos` os contratos do exercício que não constam mais no
 * snapshot atual. Só roda em coleta ÍNTEGRA (não parcial) — numa coleta parcial
 * os IDs das páginas não lidas seriam apagados como "obsoletos".
 */
async function purgarObsoletos(
  exercicio: number,
  idsAtuais: Set<string>,
): Promise<number> {
  const snap = await db
    .collection("nexo_contratos")
    .where("_exercicio", "==", exercicio)
    .where("_fonte", "==", "pncp")
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

/** Exercícios cobertos: o corrente e o anterior. */
function exerciciosAlvo(): number[] {
  const atual = new Date().getFullYear();
  return [atual, atual - 1];
}

// ── Cron diário (região brasileira) ──────────────────────────────────────────

export const onNexoSyncPncp = onSchedule(
  {
    schedule: "25 5 * * *",
    timeZone: "America/Sao_Paulo",
    // OBRIGATÓRIO: o PNCP bloqueia IPs fora do Brasil.
    region: "southamerica-east1",
    timeoutSeconds: 540,
    memory: "512MiB",
    // Hardening (#13): no máximo UMA execução simultânea — evita que um disparo
    // atrasado/retry concorra com a execução em andamento e refaça a coleta.
    // (Lease/lock distribuído fica para onda posterior.)
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: contratos têm doc ID determinístico
    // (nº de controle PNCP) com `merge`, então reexecutar o cron após falha
    // SOBRESCREVE, nunca duplica.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    const anos = exerciciosAlvo();
    let totalContratos = 0;
    let totalRemovidos = 0;
    let parcialGeral = false;
    let falhas = 0;
    let ultimoErro: string | null = null;

    for (const ano of anos) {
      try {
        const { contratos, parcial } = await coletarContratos(ano);
        const { count, ids } = await persistirContratos(ano, contratos);
        totalContratos += count;
        if (parcial) {
          // Coleta parcial: NÃO purga (apagaria contratos das páginas não lidas).
          parcialGeral = true;
        } else {
          totalRemovidos += await purgarObsoletos(ano, ids);
        }
        logger.info(
          `NEXO PNCP — ${ano}: ${count} contratos persistidos` +
            (parcial ? " [PARCIAL]" : ""),
        );
      } catch (err) {
        falhas++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.error(`NEXO PNCP — falha no exercício ${ano}`, err);
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    const sucesso = falhas < anos.length;
    await gravarSyncState({
      syncId: "pncp",
      fonte: "pncp",
      colecao: "nexo_contratos",
      cadencia: "diario",
      sucesso,
      degradado: falhas > 0 || parcialGeral,
      erro: ultimoErro,
      duracaoMs: Date.now() - inicio,
      extra: {
        exerciciosTentados: anos.length,
        exerciciosComFalha: falhas,
        registros: totalContratos,
        removidos: totalRemovidos,
        parcial: parcialGeral,
      },
    });
    logger.info(
      `NEXO PNCP — concluído: ${totalContratos} contratos, ` +
        `${totalRemovidos} obsoletos removidos, ${falhas} falhas`,
    );
  },
);
