/**
 * Cloud Functions: geração de CAPA (thumbnail) dos vídeos de Recortes.
 *
 * Por que existe: o visualizador público mostrava o primeiro frame carregando o
 * arquivo de vídeo inteiro (lento). Agora o grid usa `thumbnailUrl` como capa —
 * estas funções garantem que TODO vídeo tenha uma capa gerada server-side
 * (ffmpeg extrai 1 frame), tanto para novos uploads quanto para os já enviados.
 *
 *  - `onRecorteVideoCreated` (trigger): gera a capa de um vídeo recém-criado.
 *  - `onGerarCapasRecortes` (callable admin): BACKFILL — varre os vídeos
 *    existentes sem capa e gera (em lotes, idempotente).
 */
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as os from "os";
import * as path from "path";
import * as fs from "fs-extra";
import { randomUUID } from "crypto";

import { bucket, db, ffmpeg } from "../shared/admin";

const SEED_ADMIN_UID = process.env.BOOTSTRAP_ADMIN_UID ?? "";

interface RecorteVideoDoc {
  filePath?: string;
  thumbnailPath?: string;
  thumbnailUrl?: string;
}

/**
 * Gera a capa (1 frame ~1s) de um vídeo de recorte, sobe no Storage com token de
 * download público e atualiza o doc com thumbnailPath/thumbnailUrl. Idempotente.
 */
async function gerarCapaVideo(
  folderId: string,
  videoId: string,
  filePath: string,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `capa-${videoId}-`));
  const ext = path.extname(filePath) || ".mp4";
  const localVideo = path.join(tmpDir, `in${ext}`);
  const thumbName = "capa.jpg";
  const localThumb = path.join(tmpDir, thumbName);
  try {
    await bucket.file(filePath).download({ destination: localVideo });

    await new Promise<void>((resolve, reject) => {
      ffmpeg(localVideo)
        .on("end", () => resolve())
        .on("error", (e: Error) => reject(e))
        .screenshots({
          timestamps: ["1"], // 1s; ffmpeg pega o keyframe mais próximo
          filename: thumbName,
          folder: tmpDir,
          size: "640x?", // largura 640, altura proporcional
        });
    });

    if (!(await fs.pathExists(localThumb))) {
      throw new Error("ffmpeg não produziu o frame da capa");
    }

    const token = randomUUID();
    const thumbPath = `recortes/${folderId}/thumbs/${videoId}.jpg`;
    await bucket.upload(localThumb, {
      destination: thumbPath,
      metadata: {
        contentType: "image/jpeg",
        cacheControl: "public, max-age=31536000",
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });

    const thumbnailUrl =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(thumbPath)}?alt=media&token=${token}`;

    await db
      .doc(`recortes/${folderId}/videos/${videoId}`)
      .set({ thumbnailPath: thumbPath, thumbnailUrl }, { merge: true });
  } finally {
    await fs.remove(tmpDir).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Trigger — novo vídeo de recorte ganha capa automaticamente.
// ---------------------------------------------------------------------------
export const onRecorteVideoCreated = onDocumentCreated(
  {
    document: "recortes/{folderId}/videos/{videoId}",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "1GiB",
    cpu: 2,
    maxInstances: 10,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const d = snap.data() as RecorteVideoDoc;
    const { folderId, videoId } = event.params;
    if (d.thumbnailPath || !d.filePath) return; // já tem capa ou sem arquivo
    try {
      await gerarCapaVideo(folderId, videoId, d.filePath);
    } catch (e) {
      logger.warn("Falha ao gerar capa do recorte", {
        folderId,
        videoId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Backfill (admin) — gera capa para os vídeos JÁ existentes sem thumbnail.
// Processa em lotes (default 20) para caber no timeout; chamar repetidamente
// até `restantes === 0`.
// ---------------------------------------------------------------------------
async function callerEhAdmin(auth: CallableRequest["auth"]): Promise<boolean> {
  if (!auth) return false;
  if (auth.token.admin === true || auth.token.role === "admin") return true;
  if (SEED_ADMIN_UID && auth.uid === SEED_ADMIN_UID) return true;
  const u = await db.doc(`users/${auth.uid}`).get();
  return (u.data() as { role?: string } | undefined)?.role === "admin";
}

export const onGerarCapasRecortes = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
    cpu: 2,
    maxInstances: 1,
  },
  async (req) => {
    if (!(await callerEhAdmin(req.auth))) {
      throw new HttpsError("permission-denied", "Apenas administradores podem gerar capas.");
    }
    const limite = Math.min(
      Math.max(1, Number((req.data as { limite?: number } | undefined)?.limite ?? 20)),
      40,
    );

    const snap = await db.collectionGroup("videos").get();
    let gerados = 0;
    let restantes = 0;
    let erros = 0;

    for (const doc of snap.docs) {
      const d = doc.data() as RecorteVideoDoc;
      // Só vídeos de recortes (path recortes/{folderId}/videos/{videoId}).
      const parts = doc.ref.path.split("/");
      if (parts[0] !== "recortes" || parts.length !== 4) continue;
      if (d.thumbnailPath || !d.filePath) continue; // já tem capa
      if (gerados >= limite) {
        restantes++;
        continue;
      }
      try {
        await gerarCapaVideo(parts[1], parts[3], d.filePath);
        gerados++;
      } catch (e) {
        erros++;
        logger.warn("Backfill de capa falhou", {
          path: doc.ref.path,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    logger.info("Backfill de capas concluído", { gerados, restantes, erros, limite });
    return { ok: true, gerados, restantes, erros };
  },
);
