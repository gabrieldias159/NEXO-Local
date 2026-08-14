/**
 * Cloud Functions: geração de CAPA (thumbnail) dos RENDERS do Suite Editor.
 *
 * Por que existe: a lista "Renderizações" (`RenderJobsPanel`) e "Meus projetos
 * de vídeo" só mostravam texto (nome · resolução · formato) — o dono tinha que
 * ABRIR cada render pra saber o conteúdo. Agora cada render concluído ganha uma
 * CAPA gerada server-side (ffmpeg extrai 1 frame ~1s do `outputPath`), gravada
 * em `thumbnailUrl`/`thumbnailPath` no próprio `renderJobs/{jobId}`.
 *
 * Espelha o padrão de `recorte-thumbnail.ts` (capa dos vídeos de Recortes):
 *   - `onRenderJobThumbnail` (trigger onDocumentUpdated/Created): quando o render
 *     CONCLUI (status `complete` + `outputPath` + sem capa ainda), gera a capa.
 *   - `onGerarCapasRenders` (callable admin): BACKFILL — varre os renders já
 *     concluídos sem capa e gera (em lotes, idempotente).
 *
 * Idempotente: o trigger faz early-return se já houver `thumbnailPath`, e a
 * geração usa um caminho determinístico (`renders/{uid}/{jobId}-thumb.jpg`).
 */

import {
  onDocumentUpdated,
  onDocumentCreated,
} from "firebase-functions/v2/firestore";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as os from "os";
import * as path from "path";
import * as fs from "fs-extra";
import { randomUUID } from "crypto";

import { bucket, db, ffmpeg } from "../shared/admin";
import type { RenderJob } from "../shared/types";

const SEED_ADMIN_UID = process.env.BOOTSTRAP_ADMIN_UID ?? "";

/** Campos que nos interessam de um renderJob para a capa. */
interface RenderJobThumbView {
  status?: RenderJob["status"];
  ownerUid?: string;
  outputPath?: string;
  thumbnailPath?: string;
  thumbnailUrl?: string;
}

/**
 * Um render está "pronto pra capa" quando concluiu com sucesso, tem o arquivo
 * de saída no Storage e ainda não tem capa.
 */
function precisaDeCapa(d: RenderJobThumbView): boolean {
  return (
    d.status === "complete" &&
    !!d.outputPath &&
    !d.thumbnailPath
  );
}

/**
 * Gera a capa (1 frame ~1s) de um render, sobe no Storage com token de download
 * público e atualiza o renderJob com thumbnailPath/thumbnailUrl. Idempotente —
 * o destino é determinístico (`renders/{uid}/{jobId}-thumb.jpg`).
 */
async function gerarCapaRender(
  jobId: string,
  ownerUid: string,
  outputPath: string,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `render-capa-${jobId}-`));
  const ext = path.extname(outputPath) || ".mp4";
  const localVideo = path.join(tmpDir, `in${ext}`);
  const thumbName = "capa.jpg";
  const localThumb = path.join(tmpDir, thumbName);
  try {
    await bucket.file(outputPath).download({ destination: localVideo });

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
    // Mesmo prefixo do output (`renders/{uid}/...`) → coberto pelas storage
    // rules owner-only e pelo cleanup ao apagar o job.
    const thumbPath = `renders/${ownerUid}/${jobId}-thumb.jpg`;
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
      .doc(`renderJobs/${jobId}`)
      .set({ thumbnailPath: thumbPath, thumbnailUrl }, { merge: true });
  } finally {
    await fs.remove(tmpDir).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Trigger — render que CONCLUI ganha capa automaticamente.
//
// Dois triggers porque o render pode chegar a `complete` por dois caminhos:
//   - update (caminho normal: render.ts cria pending → atualiza pra complete);
//   - create (raro: doc já nasce complete, ex. importação/seed).
// Ambos chamam o mesmo gerador, que é idempotente.
// ---------------------------------------------------------------------------

const TRIGGER_OPTS = {
  region: "us-central1" as const,
  timeoutSeconds: 300,
  memory: "1GiB" as const,
  cpu: 2,
  maxInstances: 10,
};

async function tentarGerarCapa(
  jobId: string,
  d: RenderJobThumbView,
): Promise<void> {
  if (!precisaDeCapa(d) || !d.ownerUid || !d.outputPath) return;
  try {
    await gerarCapaRender(jobId, d.ownerUid, d.outputPath);
  } catch (e) {
    logger.warn("Falha ao gerar capa do render", {
      jobId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

export const onRenderJobThumbnail = onDocumentUpdated(
  { ...TRIGGER_OPTS, document: "renderJobs/{jobId}" },
  async (event) => {
    const after = event.data?.after?.data() as RenderJobThumbView | undefined;
    if (!after) return;
    const before = event.data?.before?.data() as RenderJobThumbView | undefined;
    // Só age na TRANSIÇÃO para "complete" (ou se ainda falta capa após complete).
    // Evita reprocessar em cada update de progresso. Como o set de capa também
    // dispara update, o `precisaDeCapa` (já tem thumbnailPath) corta o loop.
    if (before?.status === "complete" && after.status === "complete" && after.thumbnailPath) {
      return; // já processado
    }
    await tentarGerarCapa(event.params.jobId, after);
  },
);

export const onRenderJobThumbnailCreated = onDocumentCreated(
  { ...TRIGGER_OPTS, document: "renderJobs/{jobId}" },
  async (event) => {
    const d = event.data?.data() as RenderJobThumbView | undefined;
    if (!d) return;
    await tentarGerarCapa(event.params.jobId, d);
  },
);

// ---------------------------------------------------------------------------
// Backfill (admin) — gera capa para os renders JÁ concluídos sem thumbnail.
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

export const onGerarCapasRenders = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
    cpu: 2,
    maxInstances: 1,
  },
  async (req) => {
    if (!(await callerEhAdmin(req.auth))) {
      throw new HttpsError(
        "permission-denied",
        "Apenas administradores podem gerar capas.",
      );
    }
    const limite = Math.min(
      Math.max(1, Number((req.data as { limite?: number } | undefined)?.limite ?? 20)),
      40,
    );

    // Só renders concluídos sem capa. `where status == complete` evita varrer
    // pending/error; o filtro de capa é feito em memória (Firestore não indexa
    // "campo ausente").
    const snap = await db
      .collection("renderJobs")
      .where("status", "==", "complete")
      .get();

    let gerados = 0;
    let restantes = 0;
    let erros = 0;

    for (const doc of snap.docs) {
      const d = doc.data() as RenderJobThumbView;
      if (!precisaDeCapa(d) || !d.ownerUid || !d.outputPath) continue;
      if (gerados >= limite) {
        restantes++;
        continue;
      }
      try {
        await gerarCapaRender(doc.id, d.ownerUid, d.outputPath);
        gerados++;
      } catch (e) {
        erros++;
        logger.warn("Backfill de capa de render falhou", {
          jobId: doc.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    logger.info("Backfill de capas de render concluído", {
      gerados,
      restantes,
      erros,
      limite,
    });
    return { ok: true, gerados, restantes, erros };
  },
);
