/**
 * Cloud Functions: geração de PREVIEW (rendition leve) dos vídeos de Recortes.
 *
 * Estratégia (combina compressão + armazenamento no Brasil):
 *  - Transcodifica o original para um preview 720p H.264 com `+faststart` (índice
 *    no início do arquivo → o player começa a tocar NA HORA, sem baixar tudo).
 *  - Grava o preview no bucket padrão (path público de recortes/, via token de
 *    download). O ORIGINAL fica intocado (download/edição em qualidade cheia).
 *    (Servir de São Paulo p/ baixar latência é otimização opcional futura.)
 *  - O visualizador toca `previewUrl` se existir; senão, o original (fallback).
 *
 *  - `onRecorteVideoPreview` (trigger): preview de um vídeo recém-criado.
 *  - `onGerarPreviewsRecortes` (callable admin): BACKFILL dos vídeos existentes.
 */
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as os from "os";
import * as path from "path";
import * as fs from "fs-extra";

import { bucket, db, ffmpeg } from "../shared/admin";
import { randomUUID } from "crypto";

const SEED_ADMIN_UID = process.env.BOOTSTRAP_ADMIN_UID ?? "";

interface RecorteVideoDoc {
  filePath?: string;
  previewPath?: string;
  previewUrl?: string;
}

/**
 * Gera o preview (720p, faststart) de um vídeo, grava no bucket SP (público) e
 * atualiza o doc com previewPath/previewUrl. Idempotente.
 */
async function gerarPreviewVideo(
  folderId: string,
  videoId: string,
  filePath: string,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `prev-${videoId}-`));
  const localVideo = path.join(tmpDir, `in${path.extname(filePath) || ".mp4"}`);
  const localPreview = path.join(tmpDir, "preview.mp4");
  try {
    await bucket.file(filePath).download({ destination: localVideo });

    await new Promise<void>((resolve, reject) => {
      ffmpeg(localVideo)
        .videoCodec("libx264")
        .audioCodec("aac")
        .audioBitrate("128k")
        .outputOptions([
          // Altura máx 720 (downscale só o que é maior), dimensões pares.
          "-vf",
          "scale=-2:'min(720,ih)'",
          "-crf",
          "28",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart", // índice no início → streaming instantâneo
        ])
        .on("end", () => resolve())
        .on("error", (e: Error) => reject(e))
        .save(localPreview);
    });

    if (!(await fs.pathExists(localPreview))) {
      throw new Error("ffmpeg não produziu o preview");
    }

    // Grava no bucket padrão, sob recortes/ (path já público pelas storage.rules)
    // + token de download. Funciona na hora, sem depender de bucket público novo.
    // (Latência-Brasil via bucket de SP fica como otimização opcional futura.)
    const previewPath = `recortes/${folderId}/preview/${videoId}.mp4`;
    const token = randomUUID();
    await bucket.upload(localPreview, {
      destination: previewPath,
      metadata: {
        contentType: "video/mp4",
        cacheControl: "public, max-age=604800",
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });
    const previewUrl =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(previewPath)}?alt=media&token=${token}`;

    await db
      .doc(`recortes/${folderId}/videos/${videoId}`)
      .set({ previewPath, previewUrl }, { merge: true });
  } finally {
    await fs.remove(tmpDir).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Trigger — novo vídeo ganha preview automaticamente.
// ---------------------------------------------------------------------------
export const onRecorteVideoPreview = onDocumentCreated(
  {
    document: "recortes/{folderId}/videos/{videoId}",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "2GiB",
    cpu: 2,
    maxInstances: 5,
    concurrency: 1,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const d = snap.data() as RecorteVideoDoc;
    const { folderId, videoId } = event.params;
    if (d.previewPath || !d.filePath) return;
    try {
      await gerarPreviewVideo(folderId, videoId, d.filePath);
    } catch (e) {
      logger.warn("Falha ao gerar preview do recorte", {
        folderId,
        videoId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Backfill (admin) — previews dos vídeos já existentes, em lotes.
// ---------------------------------------------------------------------------
async function callerEhAdmin(auth: CallableRequest["auth"]): Promise<boolean> {
  if (!auth) return false;
  if (auth.token.admin === true || auth.token.role === "admin") return true;
  if (SEED_ADMIN_UID && auth.uid === SEED_ADMIN_UID) return true;
  const u = await db.doc(`users/${auth.uid}`).get();
  return (u.data() as { role?: string } | undefined)?.role === "admin";
}

export const onGerarPreviewsRecortes = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "2GiB",
    cpu: 2,
    maxInstances: 1,
  },
  async (req) => {
    if (!(await callerEhAdmin(req.auth))) {
      throw new HttpsError("permission-denied", "Apenas administradores podem gerar previews.");
    }
    // Preview é pesado (transcode) → lotes pequenos.
    const limite = Math.min(
      Math.max(1, Number((req.data as { limite?: number } | undefined)?.limite ?? 5)),
      10,
    );

    const snap = await db.collectionGroup("videos").get();
    let gerados = 0;
    let restantes = 0;
    let erros = 0;

    for (const doc of snap.docs) {
      const parts = doc.ref.path.split("/");
      if (parts[0] !== "recortes" || parts.length !== 4) continue;
      const d = doc.data() as RecorteVideoDoc;
      if (d.previewPath || !d.filePath) continue;
      if (gerados >= limite) {
        restantes++;
        continue;
      }
      try {
        await gerarPreviewVideo(parts[1], parts[3], d.filePath);
        gerados++;
      } catch (e) {
        erros++;
        logger.warn("Backfill de preview falhou", {
          path: doc.ref.path,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    logger.info("Backfill de previews concluído", { gerados, restantes, erros, limite });
    return { ok: true, gerados, restantes, erros };
  },
);
