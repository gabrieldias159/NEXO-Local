/**
 * Cloud Function: `onVideoCompressRequest`.
 *
 * Lê documentos em `compressionJobs/{jobId}` e re-encoda o vídeo
 * referenciado com x264 `veryfast`. Estratégia STREAMING:
 *
 *   GCS read stream → ffmpeg stdin → ffmpeg stdout → GCS write stream
 *
 * Vantagens vs versão anterior que baixava/salvava em `/tmp`:
 *  - /tmp em Functions Gen 2 é RAM-backed → 2 cópias de 2GB = 4GB de
 *    RAM consumidos só com arquivos. Streaming reduz a ~hundreds MB.
 *  - Sem download/upload sequencial: pipeline em paralelo, mais rápido.
 *  - Arquivo final tem moov-atom fragmented (streamable) sem precisar
 *    de segundo passo `+faststart`.
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import * as os from "os";
import * as path from "path";
import * as fs from "fs-extra";
import { randomUUID } from "crypto";
import type { File } from "@google-cloud/storage";

import { admin, bucket, db, ffmpeg } from "../shared/admin";
import type { CompressionJob, CompressionQuality } from "../shared/types";

function crfFromQuality(q: CompressionQuality): number {
  if (q === "low") return 28;
  if (q === "high") return 18;
  return 23;
}

async function getOrCreateFirebaseDownloadToken(file: File): Promise<string> {
  const [meta] = await file.getMetadata();
  const existing = String(meta?.metadata?.firebaseStorageDownloadTokens ?? "").trim();
  if (existing) return existing;

  const token = randomUUID();
  await file.setMetadata({
    metadata: { firebaseStorageDownloadTokens: token },
  } as { metadata: { firebaseStorageDownloadTokens: string } });
  return token;
}

import type { CompressionTier } from "../shared/types";

/**
 * Worker compartilhado pelas 3 Cloud Functions tier. Filtra `job.tier` —
 * jobs sem tier explícito caem em `large` (retrocompat).
 */
async function processCompressionJob(
  jobSnap: FirebaseFirestore.DocumentSnapshot,
  jobId: string,
  expectedTier: CompressionTier,
): Promise<void> {
    const jobData = jobSnap.data() as CompressionJob & { engine?: string };
    const jobRef = db.doc(`compressionJobs/${jobId}`);

    if (jobData.status === "cancelled" || jobData.status !== "pending") {
      logger.log(`Job ${jobId} was not in pending state or was cancelled. Exiting.`);
      return;
    }
    // Guard: jobs com engine 'transcoder' são tratados pela função Transcoder.
    if (jobData.engine === "transcoder") {
      logger.log(`Job ${jobId} usa engine=transcoder; ignorando neste worker.`);
      return;
    }
    // Tier dispatch: jobs sem tier (ou com valor inválido) caem em "large"
    // (retrocompat + safe fallback). Sem validação, um typo no tier deixaria
    // o job órfão — todas as 3 funções fariam early-return.
    const VALID_TIERS: ReadonlyArray<CompressionTier> = ["small", "medium", "large"];
    const rawTier = jobData.tier;
    const jobTier: CompressionTier =
      rawTier && VALID_TIERS.includes(rawTier as CompressionTier)
        ? (rawTier as CompressionTier)
        : "large";
    if (jobTier !== expectedTier) return;

    const { videoId, folderId, videoFilePath, quality } = jobData;

    if (!videoId || !folderId || !videoFilePath || !quality) {
      const errorMsg =
        "Job document is missing required fields (videoId, folderId, videoFilePath, quality).";
      logger.error(errorMsg, { jobId });
      await jobRef.update({ status: "error", error: errorMsg });
      return;
    }

    const videoRef = db.doc(`recortes/${folderId}/videos/${videoId}`);
    const originalFile = bucket.file(videoFilePath) as unknown as File;
    const tempStoragePath = `_compress_temp/${jobId}.mp4`;
    const tempFile = bucket.file(tempStoragePath);
    // Input vai pra disco (tmpfs/RAM). Output streaming pro Storage.
    // ffmpeg precisa de seek no input mp4 (moov atom no final), por isso
    // disco é essencial — pipe stdin falha pra maioria dos mp4 reais.
    const inputExt = path.extname(videoFilePath) || ".bin";
    const localInputPath = path.join(os.tmpdir(), `input-${jobId}${inputExt}`);

    let lastPercent = 0;
    let lastUpdateMs = 0;
    const PERCENT_STEP = 5;
    const MIN_INTERVAL = 7000;

    // Heartbeat — atualiza Firestore a cada 15s para detectar timeout/OOM
    // por outra função (`onCompressionStaleCleanup`). Sem isso, se o
    // worker morre, status fica "compressing" para sempre.
    let heartbeatHandle: NodeJS.Timeout | null = null;
    const startHeartbeat = () => {
      const beat = async () => {
        try {
          await jobRef.update({
            lastHeartbeat: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (err) {
          logger.warn("heartbeat falhou", { jobId, err: String(err) });
        }
      };
      void beat();
      heartbeatHandle = setInterval(() => void beat(), 15000);
    };
    const stopHeartbeat = () => {
      if (heartbeatHandle) {
        clearInterval(heartbeatHandle);
        heartbeatHandle = null;
      }
    };

    const setProgressSafe = async (p: number | null) => {
      try {
        await jobRef.update({ progress: p });
      } catch (e) {
        logger.warn("Falha ao atualizar progresso do job.", { jobId, err: String(e) });
      }
    };

    try {
      await jobRef.update({
        status: "compressing",
        progress: 0,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastHeartbeat: admin.firestore.FieldValue.serverTimestamp(),
      });

      const token = await getOrCreateFirebaseDownloadToken(originalFile);
      logger.info("Token preservado/criado.", { jobId });

      startHeartbeat();

      const crf = crfFromQuality(quality);
      logger.info("Iniciando compressão híbrida.", { jobId, quality, crf });

      // Passo 1: Download pra disco (necessário pra ffmpeg fazer seek
      // no moov atom — pipe-from-stdin falha em mp4s reais).
      logger.info(`Baixando ${videoFilePath} → ${localInputPath}`, { jobId });
      await new Promise<void>((resolve, reject) => {
        const r = originalFile.createReadStream();
        const w = fs.createWriteStream(localInputPath);
        r.on("error", reject);
        w.on("error", reject);
        w.on("finish", () => resolve());
        r.pipe(w);
      });

      // Passo 2: ffmpeg de arquivo local pra Storage stream (saída streaming).
      // Output em fragmented mp4 (não exige seek pra escrever moov).
      await new Promise<void>((resolve, reject) => {
        const writeStream = tempFile.createWriteStream({
          resumable: true,
          metadata: {
            contentType: "video/mp4",
            metadata: { firebaseStorageDownloadTokens: token },
          },
        });

        let done = false;
        const failOnce = (err: Error) => {
          if (done) return;
          done = true;
          reject(err);
        };
        const finishOnce = () => {
          if (done) return;
          done = true;
          resolve();
        };

        writeStream.on("error", (e: Error) =>
          failOnce(new Error(`Falha escrevendo no Storage: ${e.message}`)),
        );
        writeStream.on("finish", () => finishOnce());

        const command = ffmpeg(localInputPath)
          .outputOptions([
            "-vcodec libx264",
            `-crf ${crf}`,
            "-preset veryfast",
            // fragmented mp4 — escrita streamable, sem precisar reseek pro moov.
            "-movflags frag_keyframe+empty_moov+default_base_moof",
            "-f mp4",
          ])
          .on("progress", (progress: { percent?: number }) => {
            const pctRaw = progress?.percent;
            if (typeof pctRaw !== "number" || !Number.isFinite(pctRaw)) return;
            const pct = Math.max(0, Math.min(99, Math.floor(pctRaw)));
            const now = Date.now();
            if (pct >= lastPercent + PERCENT_STEP && now - lastUpdateMs >= MIN_INTERVAL) {
              lastPercent = pct;
              lastUpdateMs = now;
              void setProgressSafe(pct);
            }
          })
          .on("error", (err: Error) => failOnce(err));

        command.pipe(writeStream, { end: true });
      });

      // Confere cancelamento antes de mover.
      const currentJobSnap = await jobRef.get();
      if (
        currentJobSnap.exists &&
        (currentJobSnap.data() as CompressionJob).status === "cancelled"
      ) {
        logger.log(`Job ${jobId} cancelled during compression. Cleaning up temp.`);
        await tempFile.delete().catch(() => undefined);
        throw new Error("Job cancelled by user.");
      }

      // Move o arquivo comprimido para o caminho original.
      logger.info("Movendo temp -> original.", { jobId });
      await tempFile.copy(videoFilePath);
      await tempFile.delete().catch(() => undefined);

      // Re-aplica token de download (copy preserva metadata mas seguro
      // re-setar pra garantir que UI baseada em URL pública funcione).
      await originalFile.setMetadata({
        metadata: { firebaseStorageDownloadTokens: token },
      } as { metadata: { firebaseStorageDownloadTokens: string } });

      const [newMeta] = await originalFile.getMetadata();
      const newSize = Number(newMeta.size ?? 0);

      const batch = db.batch();
      batch.update(jobRef, {
        status: "complete",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        progress: 100,
        finalSize: newSize,
        lastHeartbeat: admin.firestore.FieldValue.serverTimestamp(),
      });
      batch.update(videoRef, {
        size: newSize,
        compressionJobId: admin.firestore.FieldValue.delete(),
      });
      await batch.commit();

      logger.info("Compressão concluída.", { jobId, newSize });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error("Falha na compressão.", { jobId, message });
      const finalStatus = message.includes("cancelled") ? "cancelled" : "error";
      try {
        await jobRef.update({
          status: finalStatus,
          error: message,
          progress: null,
          lastHeartbeat: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (err) {
        logger.error("Falha ao gravar erro do job no Firestore.", {
          jobId,
          err: String(err),
        });
      }
      // Cleanup do temp se sobrou
      await tempFile.delete().catch(() => undefined);
    } finally {
      stopHeartbeat();
      await fs.remove(localInputPath).catch(() => undefined);
    }
}

// ============================================================================
// Exports: 3 Cloud Functions, uma por tier de tamanho de arquivo.
// Cliente seleciona via selectCompressionTier(sizeBytes).
// ============================================================================

const COMPRESS_COMMON = {
  document: "compressionJobs/{jobId}" as const,
  region: "us-central1" as const,
  concurrency: 1,
};

export const onVideoCompressRequestSmall = onDocumentCreated(
  {
    ...COMPRESS_COMMON,
    timeoutSeconds: 300,
    memory: "1GiB",
    cpu: 1,
    maxInstances: 15,
  },
  async (event) => {
    const jobSnap = event.data;
    if (!jobSnap) return;
    await processCompressionJob(jobSnap, event.params.jobId, "small");
  },
);

export const onVideoCompressRequestMedium = onDocumentCreated(
  {
    ...COMPRESS_COMMON,
    timeoutSeconds: 540,
    memory: "2GiB",
    cpu: 2,
    maxInstances: 8,
  },
  async (event) => {
    const jobSnap = event.data;
    if (!jobSnap) return;
    await processCompressionJob(jobSnap, event.params.jobId, "medium");
  },
);

export const onVideoCompressRequestLarge = onDocumentCreated(
  {
    ...COMPRESS_COMMON,
    timeoutSeconds: 540,
    memory: "4GiB",
    cpu: 4,
    maxInstances: 5,
  },
  async (event) => {
    const jobSnap = event.data;
    if (!jobSnap) return;
    await processCompressionJob(jobSnap, event.params.jobId, "large");
  },
);
