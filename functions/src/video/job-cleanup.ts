/**
 * Cloud Functions: cleanup de Storage ao apagar tasks de processamento.
 *
 * Dispara em DOIS cenarios:
 *   1. Usuario apaga manualmente a task pelo painel de Renderizacoes
 *      (`deleteDoc` no frontend).
 *   2. TTL nativo do Firestore expira o doc (campo `expiresAt` = now + 14
 *      dias setado na criacao). Quando o TTL apaga, o trigger
 *      `onDocumentDeleted` dispara igual ao delete manual.
 *
 * O proposito eh evitar arquivos orfaos no Storage acumulando custo.
 *
 * Setup do TTL (rodar uma unica vez no projeto):
 *   gcloud firestore fields ttls update expiresAt \\
 *     --collection-group=renderJobs --enable-ttl \\
 *     --project=studio-8612233125-caa0a
 *   gcloud firestore fields ttls update expiresAt \\
 *     --collection-group=quickEditJobs --enable-ttl \\
 *     --project=studio-8612233125-caa0a
 */

import { onDocumentDeleted } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { bucket } from "../shared/admin";

/**
 * Apaga o arquivo do Storage referenciado em `data.outputPath` (se houver).
 * Usa `ignoreNotFound: true` pra ser idempotente — se ja foi apagado por
 * outro caminho, nao gera erro.
 */
async function deleteOutputFromStorage(
  jobId: string,
  data: Record<string, unknown> | undefined,
  collection: string,
): Promise<void> {
  // Apaga o video de saida E a CAPA (thumbnail) gerada pos-render, ambos sob
  // `renders/{uid}/`. `ignoreNotFound` mantem idempotente.
  const paths = [
    data?.outputPath as string | undefined,
    data?.thumbnailPath as string | undefined,
  ].filter((p): p is string => !!p);

  if (paths.length === 0) {
    logger.debug(`[${collection}] sem outputPath/thumbnailPath — nada a apagar`, {
      jobId,
    });
    return;
  }
  for (const filePath of paths) {
    try {
      await bucket.file(filePath).delete({ ignoreNotFound: true });
      logger.info(`[${collection}] arquivo removido do Storage`, {
        jobId,
        filePath,
      });
    } catch (err) {
      // Nao re-throw: cleanup eh best-effort. Erros do Storage nao devem
      // re-disparar o trigger (Firestore ja apagou o doc).
      logger.warn(`[${collection}] falha ao remover arquivo do Storage`, {
        jobId,
        filePath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Trigger ao deletar `renderJobs/{jobId}`. Limpa `renders/{uid}/{id}.{fmt}`
 * (path em `outputPath`). Cobre tanto delete manual quanto TTL de 14 dias.
 */
export const onRenderJobDeleted = onDocumentDeleted(
  {
    document: "renderJobs/{jobId}",
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    if (!event.data) return;
    const data = event.data.data();
    await deleteOutputFromStorage(event.params.jobId, data, "renderJob");
  },
);

/**
 * Trigger ao deletar `quickEditJobs/{jobId}`. So apaga o arquivo do Storage
 * quando o job foi criado em `saveMode: 'download'` (escreve em
 * `renders/{uid}/quickedit-{id}.mp4`). Para 'replace'/'new-copy', a saida
 * eh o proprio video do recorte — nao apagar aqui.
 */
export const onQuickEditJobDeleted = onDocumentDeleted(
  {
    document: "quickEditJobs/{jobId}",
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    if (!event.data) return;
    const data = event.data.data();
    const saveMode = (data?.settings as Record<string, unknown> | undefined)
      ?.saveMode as string | undefined;
    if (saveMode && saveMode !== "download") {
      logger.debug("[quickEditJob] saveMode != download — pula cleanup", {
        jobId: event.params.jobId,
        saveMode,
      });
      return;
    }
    await deleteOutputFromStorage(event.params.jobId, data, "quickEditJob");
  },
);
