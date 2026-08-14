/**
 * Cloud Function: `onVideoQuickEditRequest`.
 *
 * Lê documentos em `quickEditJobs/{jobId}` e aplica trim, mudança de
 * aspect ratio, logo/footer e vinheta de encerramento sobre o vídeo.
 *
 * MOVIDA de `functions/src/index.ts` sem alterações de comportamento.
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import * as os from "os";
import * as path from "path";
import * as fs from "fs-extra";
import { randomUUID } from "crypto";
import type { File } from "@google-cloud/storage";

// randomUUID é usado em getOrCreateFirebaseDownloadToken

import { admin, bucket, db, ffmpeg } from "../shared/admin";
import type { AppearanceConfig, QuickEditJob } from "../shared/types";

function parseTimeToSeconds(time: string): number {
  const parts = time.split(":").map(Number);
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) return 0;
  const [m, s] = parts;
  return m * 60 + s;
}

// (removida getOrCreateFirebaseDownloadToken — não usada após refactor do
//  replace mode pra escrever em novo path com novo token sempre.)

async function downloadAsset(
  storagePath: string | undefined,
  localName: string,
): Promise<string | null> {
  if (!storagePath) return null;
  const localPath = path.join(os.tmpdir(), localName);
  try {
    await bucket.file(storagePath).download({ destination: localPath });
    return localPath;
  } catch (e) {
    logger.warn(`Failed to download asset ${storagePath}`, e);
    return null;
  }
}

export const onVideoQuickEditRequest = onDocumentCreated(
  {
    document: "quickEditJobs/{jobId}",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "2GiB",
    maxInstances: 5,
    concurrency: 1,
    cpu: 4,
  },
  async (event) => {
    const jobSnap = event.data;
    if (!jobSnap) {
      logger.error("No data associated with the event.");
      return;
    }

    const jobData = jobSnap.data() as QuickEditJob;
    const { jobId } = event.params;
    const jobRef = db.doc(`quickEditJobs/${jobId}`);
    const { videoId, folderId, videoFilePath, settings } = jobData;

    if (!videoId || !folderId || !videoFilePath || !settings) {
      const errorMsg = "Job document is missing required fields.";
      logger.error(errorMsg, { jobId });
      await jobRef.update({ status: "error", error: errorMsg });
      return;
    }

    const videoRef = db.doc(`recortes/${folderId}/videos/${videoId}`);
    const originalFile = bucket.file(videoFilePath) as unknown as File;
    const localInputPath = path.join(os.tmpdir(), `quickedit-input-${jobId}.mp4`);
    const localOutputPath = path.join(os.tmpdir(), `quickedit-output-${jobId}.mp4`);
    const downloadedAssets: string[] = [localInputPath, localOutputPath];

    try {
      // SECURITY: valida que o usuário que pediu (requestedByUid) tem
      // permissão sobre o folder alvo. Sem isso, atacante autenticado
      // podia montar job com videoFilePath de outro tenant.
      // Regras de acesso ao folder:
      //   - folder.authorUid === requestedByUid (dono), OU
      //   - folder.isPublic === true (compartilhada)
      const requestedByUid = jobData.requestedByUid;
      if (requestedByUid) {
        const folderSnap = await db.doc(`recortes/${folderId}`).get();
        if (!folderSnap.exists) {
          await jobRef.update({ status: "error", error: "Folder não encontrado." });
          return;
        }
        const folderData = folderSnap.data() as { authorUid?: string; isPublic?: boolean } | undefined;
        const isOwner = folderData?.authorUid === requestedByUid;
        const isPublic = folderData?.isPublic === true;
        if (!isOwner && !isPublic) {
          logger.warn("Quick-edit job rejected: requester has no access to folder.", {
            jobId,
            requestedByUid,
            folderId,
          });
          await jobRef.update({
            status: "error",
            error: "Sem permissão pra editar este vídeo.",
          });
          return;
        }
        // Verifica também se o videoFilePath está dentro da folder declarada
        // (impede que job aponte pra path arbitrário fora da estrutura).
        if (!videoFilePath.startsWith(`recortes/${folderId}/`)) {
          await jobRef.update({
            status: "error",
            error: "videoFilePath não corresponde à folder.",
          });
          return;
        }
      }

      await jobRef.update({ status: "processing", progress: 0 });

      // (token do arquivo original já não é usado — replace mode escreve em
      // path novo com token novo. Mantemos só o download do bytes original.)
      await originalFile.download({ destination: localInputPath });
      let ffmpegCommand = ffmpeg(localInputPath);

      const configDoc = await db.doc("configs/main").get();
      const configData = configDoc.data() as AppearanceConfig | undefined;

      const localLogoPath = settings.addLogo
        ? await downloadAsset(configData?.videoLogoUrl, `logo-${jobId}.png`)
        : null;
      if (localLogoPath) downloadedAssets.push(localLogoPath);

      const localFooterPath = settings.addFooter
        ? await downloadAsset(configData?.videoFooterUrl, `footer-${jobId}.png`)
        : null;
      if (localFooterPath) downloadedAssets.push(localFooterPath);

      const localEndingPath = settings.addEnding
        ? await downloadAsset(configData?.videoEncerramentoUrl, `ending-${jobId}.mp4`)
        : null;
      if (localEndingPath) downloadedAssets.push(localEndingPath);

      const filterComplex: string[] = [];
      let videoStream = "[0:v]";
      let audioStream = "[0:a]";
      let overlayIndex = 1;

      const startSeconds = parseTimeToSeconds(settings.trimStart);
      const endSeconds = parseTimeToSeconds(settings.trimEnd);
      filterComplex.push(
        `${videoStream}trim=start=${startSeconds}:end=${endSeconds},setpts=PTS-STARTPTS[v_trimmed]`,
      );
      filterComplex.push(
        `${audioStream}atrim=start=${startSeconds}:end=${endSeconds},asetpts=PTS-STARTPTS[a_trimmed]`,
      );
      videoStream = "[v_trimmed]";
      audioStream = "[a_trimmed]";

      const targetResolution = settings.aspectRatio === "9:16" ? "1080:1920" : "1080:1350";
      const [targetW, targetH] = targetResolution.split(":").map(Number);
      const scaleMode = settings.scaleMode || "fill";

      if (scaleMode === "fill") {
        filterComplex.push(
          `${videoStream}scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}[v_scaled]`,
        );
      } else {
        filterComplex.push(
          `${videoStream}scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:-1:-1:color=black[v_scaled]`,
        );
      }
      videoStream = "[v_scaled]";

      if (localLogoPath) {
        ffmpegCommand = ffmpegCommand.addInput(localLogoPath);
        filterComplex.push(
          `${videoStream}[${overlayIndex}:v]overlay=W-w-30:30[v_logo]`,
        );
        videoStream = "[v_logo]";
        overlayIndex += 1;
      }
      if (localFooterPath) {
        ffmpegCommand = ffmpegCommand.addInput(localFooterPath);
        filterComplex.push(
          `${videoStream}[${overlayIndex}:v]overlay=(W-w)/2:H-h[v_footer]`,
        );
        videoStream = "[v_footer]";
        overlayIndex += 1;
      }

      if (localEndingPath) {
        ffmpegCommand = ffmpegCommand.addInput(localEndingPath);
        filterComplex.push(`[${overlayIndex}:v]setpts=PTS-STARTPTS[v_ending]`);
        filterComplex.push(`[${overlayIndex}:a]asetpts=PTS-STARTPTS[a_ending]`);
        filterComplex.push(
          `${videoStream}[v_ending]concat=n=2:v=1:a=0[v_final]`,
        );
        filterComplex.push(
          `${audioStream}[a_ending]concat=n=2:v=0:a=1[a_final]`,
        );
        videoStream = "[v_final]";
        audioStream = "[a_final]";
        overlayIndex += 1;
      }

      ffmpegCommand = ffmpegCommand.complexFilter(filterComplex);

      await new Promise<void>((resolve, reject) => {
        ffmpegCommand
          .map(videoStream)
          .map(audioStream)
          .outputOptions([
            "-preset veryfast",
            "-movflags +faststart",
            // Keyframe a cada 1s — torna scrub instantâneo nos players.
            "-g 30",
            "-keyint_min 30",
            "-sc_threshold 0",
          ])
          .outputFormat("mp4")
          .on("progress", (progress: { percent?: number }) => {
            if (progress.percent) {
              jobRef.update({ progress: Math.floor(progress.percent) }).catch(() => undefined);
            }
          })
          .on("end", () => resolve())
          .on("error", (err: Error) => reject(err))
          .save(localOutputPath);
      });

      // ---- Destino do output: branch por saveMode ------------------------
      const saveMode = settings.saveMode ?? "replace";
      // requestedByUid já declarado acima na validação de permissões.
      let outputDestPath: string;
      let savedVideoId: string | undefined;
      // Path do arquivo antigo (apenas em replace) pra apagar depois.
      let oldFilePathToDelete: string | undefined;

      if (saveMode === "download") {
        // Upload pra renders/ — não toca em recortes/.
        const ownerUid = requestedByUid ?? "anonymous";
        outputDestPath = `renders/${ownerUid}/quickedit-${jobId}.mp4`;
      } else if (saveMode === "new-copy") {
        // Cria novo path em recortes/{folderId}/
        outputDestPath = `recortes/${folderId}/edited-${Date.now()}-${jobId}.mp4`;
      } else {
        // replace: SEMPRE escreve em NOVO path. Sem isso, o browser/CDN
        // serve bytes antigos em cache (mesma URL = mesmo cache key) e o
        // user nunca vê o resultado da edição. Apagamos o original depois.
        outputDestPath = `recortes/${folderId}/edited-${Date.now()}-${jobId}.mp4`;
        oldFilePathToDelete = videoFilePath;
      }

      const destFile = bucket.file(outputDestPath);
      // Sempre gera token novo — o file de destino é sempre novo.
      const destToken = randomUUID();

      // Em modo download, sugere ao browser baixar em vez de tocar inline.
      const isDownloadMode = saveMode === "download";
      // Transliteração pra preservar nomes em português (ç→c, á→a, ã→a, etc)
      // antes do sanitize. Sem isso, "Vídeo da reunião" virava "V_deo_da_reuni_o".
      const rawName = settings.customName?.trim() || `recorte-${jobId}`;
      const normalized = rawName
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, ""); // remove diacríticos (â, ç, ã, é, etc.)
      const downloadFileName = normalized.replace(/[^a-zA-Z0-9_\-. ]/g, "_") + ".mp4";
      await bucket.upload(localOutputPath, {
        destination: outputDestPath,
        metadata: {
          contentType: "video/mp4",
          // Cache-Control immutable: CDN+browser cacheiam o arquivo "pra sempre".
          // Como cada output tem timestamp único no path, nunca há colisão.
          cacheControl: "public, max-age=31536000, immutable",
          ...(isDownloadMode ? { contentDisposition: `attachment; filename="${downloadFileName}"` } : {}),
          metadata: { firebaseStorageDownloadTokens: destToken },
        },
      });

      const [newMeta] = await destFile.getMetadata();
      const newSize = Number(newMeta.size ?? 0);
      const bucketName = bucket.name;
      const outputUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(outputDestPath)}?alt=media&token=${destToken}`;

      const batch = db.batch();

      if (saveMode === "replace") {
        // Atualiza o doc original do vídeo APONTANDO para o novo path
        // (não sobrescreve fileBytes do original — gera novo arquivo
        // e troca o ponteiro). Libera o jobId.
        batch.update(videoRef, {
          filePath: outputDestPath,
          size: newSize,
          quickEditJobId: admin.firestore.FieldValue.delete(),
        });
        savedVideoId = videoId;
      } else if (saveMode === "new-copy") {
        // Cria novo RecorteVideo na mesma pasta.
        const newVideoRef = db.collection("recortes").doc(folderId).collection("videos").doc();
        savedVideoId = newVideoRef.id;
        // Lê o nome do vídeo original pra prefixar.
        const origSnap = await videoRef.get();
        const origData = origSnap.data() as { name?: string } | undefined;
        const baseName = origData?.name ?? "Vídeo";
        // Usa nome customizado se fornecido; senão prefixa "(editado)".
        const customName = settings.customName?.trim();
        const newName = customName || `${baseName} (editado)`;
        batch.set(newVideoRef, {
          id: savedVideoId,
          name: newName,
          description: `Edição rápida de "${baseName}"`,
          filePath: outputDestPath,
          size: newSize,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          uploaderUid: requestedByUid ?? "system",
        });
      }
      // download mode → nenhuma escrita em recortes/.

      batch.update(jobRef, {
        status: "complete",
        progress: 100,
        completedAt: new Date(),
        outputPath: outputDestPath,
        outputUrl,
        ...(savedVideoId ? { savedVideoId } : {}),
      });

      await batch.commit();

      // Em modo replace, apaga o arquivo antigo do Storage AGORA que o doc
      // já aponta pro novo path. Falha silenciosa — orfão de 1 arquivo é
      // aceitável vs perder consistência.
      if (oldFilePathToDelete && oldFilePathToDelete !== outputDestPath) {
        await bucket.file(oldFilePathToDelete).delete().catch((e) => {
          logger.warn(`Falha ao apagar arquivo antigo ${oldFilePathToDelete}:`, e);
        });
      }

      logger.info("Edição rápida concluída.", { jobId, saveMode, outputDestPath, newSize, savedVideoId });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error("Falha na edição rápida.", { jobId, message });
      await jobRef.update({ status: "error", error: message, progress: null });
    } finally {
      await Promise.all(
        downloadedAssets.map((p) => fs.remove(p).catch(() => undefined)),
      );
      logger.debug("Limpeza de /tmp da edição rápida concluída.", { jobId });
    }
  },
);
