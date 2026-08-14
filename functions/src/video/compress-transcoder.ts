/**
 * Cloud Functions do engine Transcoder (Google Cloud Transcoder API).
 *
 * ALTERNATIVA ao `onVideoCompressRequest` (ffmpeg em /tmp).
 * - Lê direto de gs://bucket/path, escreve direto em gs://bucket/output
 * - Sem download/upload manual no worker, sem /tmp, sem RAM
 * - Suporta qualquer tamanho de vídeo
 *
 * ARQUITETURA DESACOPLADA (fix do timeout):
 *  - `onVideoCompressTranscoderRequest` (trigger): cria o job no Transcoder e
 *    RETORNA imediatamente — nada de polling bloqueante (antes o loop esperava
 *    até 30 min com `timeoutSeconds: 60`, então a função MORRIA antes de
 *    finalizar e o output nunca era copiado).
 *  - `onTranscoderPoll` (agendada, 1/min): varre os jobs em `compressing`,
 *    consulta o estado no Transcoder e finaliza (copia o output e marca
 *    `complete`) ou marca `error`. Não há limite de tempo: o trabalho pesado
 *    roda no serviço gerenciado, fora da função.
 *
 * TRADE-OFF DE CUSTO:
 *  - ffmpeg em Function: ~$0.001 por vídeo HD de 10min
 *  - Transcoder API:    ~$0.60 por vídeo HD de 10min (~200x), mas escala
 *    infinitamente e nunca falha por OOM/timeout.
 *
 * Trigger: doc em `compressionJobs/{jobId}` com `engine: 'transcoder'`.
 * Requer: `gcloud services enable transcoder.googleapis.com` e o SDK
 *         `@google-cloud/video-transcoder` no functions/package.json.
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { admin, bucket, db } from "../shared/admin";
import type { CompressionJob, CompressionQuality } from "../shared/types";

function bitrateFromQuality(q: CompressionQuality): number {
  if (q === "low") return 800_000;
  if (q === "high") return 4_000_000;
  return 1_500_000;
}

/** Carrega o SDK pesado do Transcoder sob demanda. Lança se não instalado. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTranscoderClient(): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(
    "@google-cloud/video-transcoder" as never
  ).catch(() => null);
  if (!mod?.TranscoderServiceClient) {
    throw new Error(
      "Dependência @google-cloud/video-transcoder não instalada. Rode `npm install @google-cloud/video-transcoder --prefix functions` e redeploy.",
    );
  }
  return new mod.TranscoderServiceClient();
}

// ---------------------------------------------------------------------------
// Função A — cria o job e RETORNA (sem polling bloqueante).
// ---------------------------------------------------------------------------
export const onVideoCompressTranscoderRequest = onDocumentCreated(
  {
    document: "compressionJobs/{jobId}",
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "256MiB",
    maxInstances: 20,
  },
  async (event) => {
    const jobSnap = event.data;
    if (!jobSnap) return;
    const jobData = jobSnap.data() as CompressionJob & { engine?: string };
    const { jobId } = event.params;
    // Só processa se o doc pediu explicitamente o engine 'transcoder'.
    if (jobData.engine !== "transcoder") return;
    if (jobData.status !== "pending") return;

    const jobRef = db.doc(`compressionJobs/${jobId}`);
    const { videoFilePath, quality } = jobData;
    if (!videoFilePath) {
      await jobRef.update({ status: "error", error: "videoFilePath ausente" });
      return;
    }

    try {
      await jobRef.update({
        status: "compressing",
        progress: 0,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastHeartbeat: admin.firestore.FieldValue.serverTimestamp(),
        engineUsed: "transcoder",
      });

      const client = await getTranscoderClient();
      const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
      if (!projectId) throw new Error("PROJECT_ID não detectado");
      const location = "us-central1";
      const inputUri = `gs://${bucket.name}/${videoFilePath}`;
      const outputUri = `gs://${bucket.name}/_compress_temp/${jobId}/`;
      const bitrateBps = bitrateFromQuality(quality ?? "medium");

      const [job] = await client.createJob({
        parent: `projects/${projectId}/locations/${location}`,
        job: {
          inputUri,
          outputUri,
          config: {
            elementaryStreams: [
              {
                key: "video-stream0",
                videoStream: {
                  h264: { bitrateBps, frameRate: 30, pixelFormat: "yuv420p" },
                },
              },
              {
                key: "audio-stream0",
                audioStream: { codec: "aac", bitrateBps: 128_000 },
              },
            ],
            muxStreams: [
              {
                key: "compressed",
                container: "mp4",
                elementaryStreams: ["video-stream0", "audio-stream0"],
              },
            ],
          },
        },
      });

      logger.info("Transcoder job criado — finalização via onTranscoderPoll", {
        jobId,
        transcoderJobName: job.name,
      });
      await jobRef.update({
        transcoderJobName: job.name ?? null,
        progress: 10,
        lastHeartbeat: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Falha ao criar job no Transcoder", { jobId, message });
      await jobRef
        .update({ status: "error", error: message, progress: null })
        .catch(() => undefined);
    }
  },
);

// ---------------------------------------------------------------------------
// Função B — poll agendado que finaliza os jobs do Transcoder.
// ---------------------------------------------------------------------------
// CUSTO: o Transcoder API está desligado (compressão roteia só por ffmpeg via
// `requestVideoCompression`), então nenhum job com engine='transcoder' é criado
// e este poll não tem o que finalizar. Mantido DORMENTE a cada 6h (era 1min =
// 1.440 invocações/dia) como rede de segurança caso o Transcoder seja reativado.
export const onTranscoderPoll = onSchedule(
  {
    schedule: "every 6 hours",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "256MiB",
    maxInstances: 1,
  },
  async () => {
    // Filtra só por status (sem índice composto); o engine é checado em código.
    const snap = await db
      .collection("compressionJobs")
      .where("status", "==", "compressing")
      .get();
    if (snap.empty) return;

    const pending = snap.docs.filter(
      (d) => (d.data() as { engine?: string }).engine === "transcoder",
    );
    if (pending.length === 0) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any;
    try {
      client = await getTranscoderClient();
    } catch (e) {
      logger.error("Transcoder SDK indisponível no poll", {
        err: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    for (const docSnap of pending) {
      const jobId = docSnap.id;
      const jobRef = docSnap.ref;
      const jobData = docSnap.data() as CompressionJob & {
        transcoderJobName?: string;
      };
      const transcoderJobName = jobData.transcoderJobName;
      const videoFilePath = jobData.videoFilePath;
      // Job ainda não criado (Função A pode não ter rodado ainda) — espera.
      if (!transcoderJobName || !videoFilePath) continue;

      try {
        const [current] = await client.getJob({ name: transcoderJobName });
        const state: string = current.state ?? "UNKNOWN";
        await jobRef.update({
          lastHeartbeat: admin.firestore.FieldValue.serverTimestamp(),
        });

        if (state === "SUCCEEDED") {
          const outputFile = bucket.file(`_compress_temp/${jobId}/compressed.mp4`);
          await outputFile.copy(videoFilePath);
          await outputFile.delete().catch(() => undefined);
          const [meta] = await bucket.file(videoFilePath).getMetadata();
          await jobRef.update({
            status: "complete",
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            progress: 100,
            finalSize: Number(meta.size ?? 0),
          });
          logger.info("Transcoder compressão concluída.", { jobId });
        } else if (state === "FAILED") {
          await jobRef.update({
            status: "error",
            error: "Transcoder job state final: FAILED",
            progress: null,
          });
          logger.error("Transcoder job FAILED", { jobId });
        }
        // Outros estados (PROCESSING/PENDING): só atualiza o heartbeat e
        // tenta de novo no próximo ciclo. A limpeza de jobs travados fica a
        // cargo do onCompressionStaleCleanup.
      } catch (err) {
        // Erro transitório no getJob — não marca falha definitiva, tenta depois.
        logger.warn("Falha ao consultar/finalizar Transcoder job", {
          jobId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  },
);
