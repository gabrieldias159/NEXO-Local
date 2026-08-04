/**
 * NEXO — TTL/limpeza de jobs+snapshots (Frente E, plano §2.2).
 *
 * Duas peças, molde de `functions/src/video/job-cleanup.ts`:
 *
 *  1. `onNexoSnapshotDeleted` (onDocumentDeleted em `nexo_snapshots/{id}`):
 *     quando um snapshot é apagado — pelo TTL NATIVO do Firestore (campo
 *     `expiraEm`) OU pela varredura abaixo —, remove o payload órfão do Storage
 *     (`payloadStorage = gs://.../nexo-snapshots/{id}.json.gz`). Idempotente
 *     (`ignoreNotFound`). Evita lixo de Storage acumulando custo.
 *
 *  2. `onNexoTarefasTtl` (cron de varredura — REDE DE SEGURANÇA): o TTL nativo
 *     do Firestore (`gcloud firestore fields ttls update expiraEm ...`) é a via
 *     primária, mas pode atrasar horas e não é deployável por push. Esta
 *     varredura apaga `nexo_tarefas`/`nexo_snapshots` já expirados (e marca
 *     tarefas `pronto` vencidas como `expirado` antes de apagar). O delete do
 *     snapshot dispara `onNexoSnapshotDeleted` → limpa o Storage.
 *
 * Self-contained: `functions/` não importa de `src/`. NUNCA derruba nada.
 */
import { onDocumentDeleted } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db, bucket } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

/** Quantos docs apagar por ciclo de varredura (proteção contra explosão). */
const MAX_VARREDURA = 500;

/** Resolve o path local do bucket a partir de `gs://bucket/path`. */
function pathDoGs(gs: string): string | null {
  const m = /^gs:\/\/[^/]+\/(.+)$/.exec(gs);
  return m ? m[1] : null;
}

/**
 * Trigger ao deletar `nexo_snapshots/{id}`. Remove o payload do Storage se o
 * doc apontava para `payloadStorage`. Cobre delete manual, varredura e TTL
 * nativo. Best-effort: erro do Storage é logado, não re-throw (o doc já sumiu).
 */
export const onNexoSnapshotDeleted = onDocumentDeleted(
  {
    document: "nexo_snapshots/{id}",
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    if (!event.data) return;
    const data = event.data.data();
    const gs = data?.payloadStorage as string | undefined;
    if (!gs) return;
    const path = pathDoGs(gs);
    if (!path) {
      logger.warn("NEXO ttl — payloadStorage com formato inesperado", {
        id: event.params.id,
        gs,
      });
      return;
    }
    try {
      await bucket.file(path).delete({ ignoreNotFound: true });
      logger.info("NEXO ttl — payload de snapshot removido do Storage", {
        id: event.params.id,
        path,
      });
    } catch (err) {
      logger.warn("NEXO ttl — falha ao remover payload do Storage", {
        id: event.params.id,
        path,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

/** Apaga docs expirados de uma coleção (`expiraEm <= agora`). */
async function varrerColecao(
  colecao: string,
  agora: FirebaseFirestore.Timestamp,
): Promise<number> {
  const snap = await db
    .collection(colecao)
    .where("expiraEm", "<=", agora)
    .orderBy("expiraEm", "asc")
    .limit(MAX_VARREDURA)
    .get();
  if (snap.empty) return 0;

  let batch = db.batch();
  let ops = 0;
  let apagados = 0;
  const flush = async () => {
    if (ops > 0) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };
  for (const d of snap.docs) {
    batch.delete(d.ref);
    apagados++;
    ops++;
    if (ops >= 400) await flush();
  }
  await flush();
  return apagados;
}

/**
 * Varredura de TTL — rede de segurança do TTL nativo. Roda a cada 6h. Apaga
 * `nexo_tarefas` e `nexo_snapshots` com `expiraEm` no passado.
 */
export const onNexoTarefasTtl = onSchedule(
  {
    schedule: "0 */6 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "256MiB",
    maxInstances: 1,
    retryCount: 1,
  },
  async () => {
    const inicio = Date.now();
    const agora = admin.firestore.Timestamp.now();
    let tarefas = 0;
    let snapshots = 0;
    try {
      // Apaga snapshots ANTES das tarefas (cada delete dispara a limpeza de
      // Storage). Tarefas não têm Storage associado.
      snapshots = await varrerColecao("nexo_snapshots", agora);
      tarefas = await varrerColecao("nexo_tarefas", agora);
      logger.info("NEXO ttl — varredura concluída", { tarefas, snapshots });
      await gravarSyncState({
        syncId: "_jobs_ttl",
        fonte: "jobs-ttl",
        colecao: "nexo_snapshots",
        cadencia: "6h",
        sucesso: true,
        erro: null,
        duracaoMs: Date.now() - inicio,
        extra: { tarefasApagadas: tarefas, snapshotsApagados: snapshots },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO ttl — falha na varredura", err);
      await gravarSyncState({
        syncId: "_jobs_ttl",
        fonte: "jobs-ttl",
        colecao: "nexo_snapshots",
        cadencia: "6h",
        sucesso: false,
        erro: msg,
        duracaoMs: Date.now() - inicio,
        extra: { tarefasApagadas: tarefas, snapshotsApagados: snapshots },
      });
    }
  },
);
