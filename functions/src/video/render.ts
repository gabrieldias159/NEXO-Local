/**
 * Cloud Functions de render do Suite Editor.
 *
 * Listener para `renderJobs/{jobId}`. Três tiers de recursos:
 *   - `onRenderRequestLow`   — 1 vCPU / 1 GiB / 300 s
 *   - `onRenderRequestMedium`— 2 vCPU / 2 GiB / 540 s
 *   - `onRenderRequestHigh`  — 4 vCPU / 4 GiB / 540 s   (default)
 *
 * Cada uma filtra por `job.tier`. Jobs sem `tier` caem em `high` (retrocompat
 * com o `onRenderRequest` legado). Cliente seleciona o tier via
 * `selectRenderTier()` baseado em duração + tamanho de assets + complexidade.
 *
 * Modos de saída:
 *   - sem `destinationFolderId` nem `replaceVideoId` → apenas `outputUrl`.
 *   - `destinationFolderId` → cria NOVO doc em `recortes/{folderId}/videos/`.
 *   - `replaceVideoId` + `replaceFolderId` → SUBSTITUI o vídeo existente.
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import * as os from "os";
import * as path from "path";
import * as fs from "fs-extra";

import { admin, bucket, db, ffmpeg } from "../shared/admin";
import type { AppearanceConfig, ExportSettings, RenderJob, RenderTier, VideoProject } from "../shared/types";
import { buildFilterComplex } from "../shared/ffmpeg-builder";
import {
  crfFromExportQuality,
  downloadAssetsForProject,
  ensureCleanDir,
  generateAssFromCaptions,
  resolutionPresetToWH,
  uploadRender,
} from "../shared/ffmpeg-utils";

/**
 * Worker compartilhado pelas 3 Cloud Functions tier. Filtra `job.tier` —
 * jobs sem tier explícito caem em `high` (retrocompat).
 */
async function processRenderJob(
  jobSnap: FirebaseFirestore.DocumentSnapshot,
  jobId: string,
  expectedTier: RenderTier,
): Promise<void> {
    const job = jobSnap.data() as RenderJob;
    const jobRef = db.doc(`renderJobs/${jobId}`);

    // Apenas processar jobs cloud-ffmpeg em estado pendente.
    if (job.status !== "pending") {
      logger.log(`Render job ${jobId} status=${job.status} — ignorando.`);
      return;
    }
    if (job.engine !== "cloud-ffmpeg") {
      logger.log(`Render job ${jobId} engine=${job.engine} — não é cloud, ignorando.`);
      return;
    }

    // Tier dispatch: cada uma das 3 funções só processa jobs do seu tier.
    // Jobs sem `tier` (ou com valor inválido) → tratados como `high`
    // (retrocompat + safe fallback). Sem isso, um tier inválido (typo)
    // deixaria o job órfão — todas as 3 funções fariam early-return.
    const VALID_TIERS: ReadonlyArray<RenderTier> = ["low", "medium", "high"];
    const rawTier = job.tier;
    const jobTier: RenderTier =
      rawTier && VALID_TIERS.includes(rawTier as RenderTier)
        ? (rawTier as RenderTier)
        : "high";
    if (jobTier !== expectedTier) {
      // Outra função vai pegar — early return barato.
      return;
    }

    if (!job.projectId || !job.ownerUid) {
      const msg = "Render job sem projectId ou ownerUid.";
      logger.error(msg, { jobId });
      await jobRef.update({ status: "error", error: msg });
      return;
    }

    const tmpDir = path.join(os.tmpdir(), `render-${jobId}`);
    const localOutputPath = path.join(tmpDir, `output.mp4`);
    const captionsAssPath = path.join(tmpDir, `captions.ass`);

    let lastPercent = 0;
    let lastUpdateMs = 0;
    const PERCENT_STEP = 5;
    const MIN_INTERVAL_MS = 7000;
    let cancelRequested = false;

    const setProgressSafe = async (p: number | null) => {
      try {
        await jobRef.update({ progress: p });
      } catch (e) {
        logger.warn("Falha ao atualizar progresso do render.", {
          jobId,
          err: String(e),
        });
      }
    };

    const checkCancelled = async (): Promise<boolean> => {
      try {
        const snap = await jobRef.get();
        const data = snap.data() as RenderJob | undefined;
        return data?.status === "cancelled";
      } catch {
        return false;
      }
    };

    try {
      await ensureCleanDir(tmpDir);
      await jobRef.update({
        status: "rendering",
        progress: 0,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ---- 1. Carregar projeto ---------------------------------------------
      const projectSnap = await db.doc(`videoProjects/${job.projectId}`).get();
      if (!projectSnap.exists) {
        throw new Error(`Projeto ${job.projectId} não encontrado.`);
      }
      const project = projectSnap.data() as VideoProject;

      const totalClips = project.tracks.reduce(
        (acc, t) => acc + t.clips.filter((c) => !c.hidden).length,
        0,
      );
      if (totalClips === 0) {
        throw new Error("Projeto sem clips — não há nada para renderizar.");
      }

      // ---- 2. Resolução final ---------------------------------------------
      const outRes = resolutionPresetToWH(
        job.exportSettings.resolution,
        project.resolution,
      );

      // ---- 3. Download de assets ------------------------------------------
      logger.info(`Baixando assets para o render ${jobId}...`);
      const inputAssets = await downloadAssetsForProject(project, bucket, tmpDir);
      if (inputAssets.length === 0) {
        throw new Error(
          "Nenhum asset com storagePath encontrado — verifique se os uploads concluíram.",
        );
      }

      if (await checkCancelled()) {
        cancelRequested = true;
        throw new Error("Job cancelled by user.");
      }
      await setProgressSafe(15);

      // ---- 4. Captions ASS (se burnCaptions) ------------------------------
      if (job.exportSettings.burnCaptions && project.captionTracks.length > 0) {
        const ass = generateAssFromCaptions(project.captionTracks, outRes);
        await fs.writeFile(captionsAssPath, ass, "utf-8");
        logger.info(`ASS gerado em ${captionsAssPath} (${ass.length} bytes).`);
      }

      // ---- 5. Build filter_complex ----------------------------------------
      const built = buildFilterComplex({
        project,
        inputAssets,
        exportSettings: job.exportSettings,
        outputResolution: outRes,
        captionsAssPath: job.exportSettings.burnCaptions ? captionsAssPath : undefined,
      });

      logger.debug(`filter_complex (${built.filterComplex.length} chars)`);

      // ---- 6. Execução FFmpeg ---------------------------------------------
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let cmd: any = ffmpeg();
      for (const asset of inputAssets) {
        cmd = cmd.addInput(asset.localPath);
      }
      for (const synth of built.syntheticInputs) {
        cmd = cmd.addInput(synth.url).inputOptions(synth.options);
      }
      cmd = cmd.complexFilter(built.filterComplex);

      const crf = crfFromExportQuality(job.exportSettings.quality);
      const outputFmt = job.exportSettings.format === "webm" ? "webm" : "mp4";
      const codec = outputFmt === "webm" ? "libvpx-vp9" : "libx264";

      const baseOpts = [
        `-c:v ${codec}`,
        `-preset veryfast`,
        `-crf ${crf}`,
        `-pix_fmt yuv420p`,
        `-r ${project.frameRate}`,
        `-c:a aac`,
        `-b:a 192k`,
        // Keyframe a cada 1s — torna scrub instantâneo nos players (vs default
        // GOP grande que força decode de muitos frames atrás do ponto buscado).
        `-g ${project.frameRate}`,
        `-keyint_min ${project.frameRate}`,
        `-sc_threshold 0`,
      ];
      if (outputFmt === "mp4") baseOpts.push("-movflags +faststart");
      if (job.exportSettings.bitrate) {
        baseOpts.push(`-b:v ${job.exportSettings.bitrate}k`);
      }

      const projectDuration = computeProjectDuration(project);

      await new Promise<void>((resolve, reject) => {
        cmd
          .map(built.outputVideoStream)
          .map(built.outputAudioStream)
          .outputOptions(baseOpts)
          .outputFormat(outputFmt)
          .on("progress", (progress: { percent?: number; timemark?: string }) => {
            // Calcula percent a partir de timemark se necessário.
            let pct = progress?.percent;
            if (typeof pct !== "number" || !Number.isFinite(pct)) {
              const tm = progress?.timemark;
              if (tm && projectDuration > 0) {
                const elapsed = parseTimemark(tm);
                pct = (elapsed / projectDuration) * 100;
              }
            }
            if (typeof pct !== "number" || !Number.isFinite(pct)) return;

            const clamped = Math.max(0, Math.min(99, Math.floor(pct)));
            const now = Date.now();
            if (
              clamped >= lastPercent + PERCENT_STEP &&
              now - lastUpdateMs >= MIN_INTERVAL_MS
            ) {
              lastPercent = clamped;
              lastUpdateMs = now;
              setProgressSafe(clamped);
              checkCancelled().then((c) => {
                if (c) {
                  cancelRequested = true;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  try {
                    (cmd as { kill?: (sig: string) => void }).kill?.("SIGKILL");
                  } catch {
                    /* noop */
                  }
                }
              });
            }
          })
          .on("end", () => resolve())
          .on("error", (err: Error) => reject(err))
          .save(localOutputPath);
      });

      if (cancelRequested) {
        throw new Error("Job cancelled by user.");
      }

      // ---- 7. Sobreposições (logo/rodapé/vinheta) — passo extra ------------
      const needsOverlay =
        job.exportSettings.includeLogo ||
        job.exportSettings.includeFooter ||
        job.exportSettings.includeEnding;

      if (needsOverlay) {
        if (await checkCancelled()) {
          cancelRequested = true;
          throw new Error("Job cancelled by user.");
        }
        await setProgressSafe(85);
        logger.info(`Aplicando sobreposições ao render ${jobId}...`);

        const configSnap = await db.doc("configs/main").get();
        const configData = configSnap.data() as AppearanceConfig | undefined;

        const overlayOutputPath = path.join(tmpDir, `output-overlaid.mp4`);
        await applyOverlays(
          localOutputPath,
          overlayOutputPath,
          configData ?? {},
          job.exportSettings,
          tmpDir,
          jobId,
        );
        await fs.move(overlayOutputPath, localOutputPath, { overwrite: true });
        logger.info("Sobreposições aplicadas.");
      }

      // ---- 8. Upload -------------------------------------------------------
      const dest = `renders/${job.ownerUid}/${jobId}.${outputFmt}`;
      const contentType = outputFmt === "webm" ? "video/webm" : "video/mp4";
      logger.info(`Subindo render para ${dest}.`);
      const uploaded = await uploadRender(localOutputPath, bucket, dest, contentType);

      // ---- 9. Salvar / substituir em pasta de Recortes ---------------------
      let savedVideoId: string | undefined;
      if (job.replaceVideoId && job.replaceFolderId) {
        // Modo SUBSTITUIR: atualiza o vídeo existente e remove arquivo antigo.
        const videoRef = db
          .collection("recortes")
          .doc(job.replaceFolderId)
          .collection("videos")
          .doc(job.replaceVideoId);
        const oldSnap = await videoRef.get();
        if (oldSnap.exists) {
          const oldData = oldSnap.data() as { filePath?: string } | undefined;
          const oldFilePath = oldData?.filePath;
          await videoRef.update({
            filePath: uploaded.storagePath,
            size: uploaded.size,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          savedVideoId = job.replaceVideoId;
          if (oldFilePath && oldFilePath !== uploaded.storagePath) {
            await bucket.file(oldFilePath).delete().catch((e) => {
              logger.warn(`Falha ao remover arquivo antigo ${oldFilePath}:`, e);
            });
          }
          logger.info(`Vídeo SUBSTITUÍDO em recortes/${job.replaceFolderId}/videos/${savedVideoId}.`);
        } else {
          logger.warn(`Vídeo ${job.replaceVideoId} não encontrado — fallback para criar novo.`);
          // Cai para o branch abaixo com destinationFolderId.
          job.destinationFolderId = job.destinationFolderId ?? job.replaceFolderId;
        }
      }
      if (!savedVideoId && job.destinationFolderId) {
        // Modo NOVA CÓPIA: cria um novo doc na pasta selecionada.
        const videoRef = db
          .collection("recortes")
          .doc(job.destinationFolderId)
          .collection("videos")
          .doc();
        savedVideoId = videoRef.id;
        await videoRef.set({
          id: savedVideoId,
          name: project.name,
          description: `Render do projeto "${project.name}"`,
          filePath: uploaded.storagePath,
          size: uploaded.size,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          uploaderUid: job.ownerUid,
        });
        logger.info(`Vídeo salvo em recortes/${job.destinationFolderId}/videos/${savedVideoId}.`);
      }

      // ---- 10. Marca job como complete ------------------------------------
      await jobRef.update({
        status: "complete",
        progress: 100,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        outputPath: uploaded.storagePath,
        outputUrl: uploaded.url,
        outputSize: uploaded.size,
        ...(savedVideoId ? { savedVideoId } : {}),
      });

      logger.info("Render concluído.", { jobId, size: uploaded.size, url: uploaded.url });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error("Falha no render.", { jobId, message });
      const finalStatus =
        cancelRequested || message.includes("cancelled") ? "cancelled" : "error";
      await jobRef
        .update({
          status: finalStatus,
          error: message,
          progress: null,
        })
        .catch(() => undefined);
    } finally {
      await fs.remove(tmpDir).catch(() => undefined);
      logger.debug("Limpeza de /tmp do render concluída.", { jobId });
    }
}

// ============================================================================
// Exports: 3 Cloud Functions, uma por tier de recursos.
// ============================================================================

const COMMON = {
  document: "renderJobs/{jobId}" as const,
  region: "us-central1" as const,
  concurrency: 1,
};

export const onRenderRequestLow = onDocumentCreated(
  {
    ...COMMON,
    timeoutSeconds: 300,
    memory: "1GiB",
    cpu: 1,
    maxInstances: 10,
  },
  async (event) => {
    const jobSnap = event.data;
    if (!jobSnap) return;
    await processRenderJob(jobSnap, event.params.jobId, "low");
  },
);

export const onRenderRequestMedium = onDocumentCreated(
  {
    ...COMMON,
    timeoutSeconds: 540,
    memory: "2GiB",
    cpu: 2,
    maxInstances: 6,
  },
  async (event) => {
    const jobSnap = event.data;
    if (!jobSnap) return;
    await processRenderJob(jobSnap, event.params.jobId, "medium");
  },
);

export const onRenderRequestHigh = onDocumentCreated(
  {
    ...COMMON,
    timeoutSeconds: 540,
    memory: "4GiB",
    cpu: 4,
    maxInstances: 3,
  },
  async (event) => {
    const jobSnap = event.data;
    if (!jobSnap) return;
    await processRenderJob(jobSnap, event.params.jobId, "high");
  },
);

// ============================================================================
// Helpers locais
// ============================================================================

async function downloadOverlayAsset(
  storagePath: string | undefined,
  localPath: string,
): Promise<string | null> {
  if (!storagePath) return null;
  try {
    await bucket.file(storagePath).download({ destination: localPath });
    return localPath;
  } catch (e) {
    logger.warn(`Falha ao baixar overlay asset: ${storagePath}`, e);
    return null;
  }
}

async function applyOverlays(
  inputPath: string,
  outputPath: string,
  config: AppearanceConfig,
  settings: ExportSettings,
  tmpDir: string,
  jobId: string,
): Promise<void> {
  const downloadedAssets: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cmd: any = ffmpeg(inputPath);
    const filterParts: string[] = [];
    let videoStream = "[0:v]";
    let audioStream = "[0:a]";
    let overlayIndex = 1;

    const localLogoPath = settings.includeLogo
      ? await downloadOverlayAsset(config.videoLogoUrl, path.join(tmpDir, `logo-${jobId}.png`))
      : null;
    if (localLogoPath) {
      cmd = cmd.addInput(localLogoPath);
      downloadedAssets.push(localLogoPath);
    }

    const localFooterPath = settings.includeFooter
      ? await downloadOverlayAsset(config.videoFooterUrl, path.join(tmpDir, `footer-${jobId}.png`))
      : null;
    if (localFooterPath) {
      cmd = cmd.addInput(localFooterPath);
      downloadedAssets.push(localFooterPath);
    }

    const localEndingPath = settings.includeEnding
      ? await downloadOverlayAsset(config.videoEncerramentoUrl, path.join(tmpDir, `ending-${jobId}.mp4`))
      : null;
    if (localEndingPath) {
      cmd = cmd.addInput(localEndingPath);
      downloadedAssets.push(localEndingPath);
    }

    if (localLogoPath) {
      filterParts.push(`${videoStream}[${overlayIndex}:v]overlay=W-w-30:30[v_logo]`);
      videoStream = "[v_logo]";
      overlayIndex++;
    }
    if (localFooterPath) {
      filterParts.push(`${videoStream}[${overlayIndex}:v]overlay=(W-w)/2:H-h[v_footer]`);
      videoStream = "[v_footer]";
      overlayIndex++;
    }
    if (localEndingPath) {
      filterParts.push(`[${overlayIndex}:v]setpts=PTS-STARTPTS[v_ending]`);
      filterParts.push(`[${overlayIndex}:a]asetpts=PTS-STARTPTS[a_ending]`);
      filterParts.push(`${videoStream}[v_ending]concat=n=2:v=1:a=0[v_final]`);
      filterParts.push(`${audioStream}[a_ending]concat=n=2:v=0:a=1[a_final]`);
      videoStream = "[v_final]";
      audioStream = "[a_final]";
    }

    if (filterParts.length === 0) return;

    cmd = cmd.complexFilter(filterParts);

    await new Promise<void>((resolve, reject) => {
      cmd
        .map(videoStream)
        .map(audioStream)
        .outputOptions([
          "-c:v libx264",
          "-preset veryfast",
          "-pix_fmt yuv420p",
          "-c:a aac",
          "-b:a 192k",
          "-movflags +faststart",
        ])
        .outputFormat("mp4")
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .save(outputPath);
    });
  } finally {
    await Promise.all(downloadedAssets.map((p) => fs.remove(p).catch(() => undefined)));
  }
}

function computeProjectDuration(project: VideoProject): number {
  let max = project.duration ?? 0;
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.hidden) continue;
      if (c.endInTimeline > max) max = c.endInTimeline;
    }
  }
  return Math.max(0.1, max);
}

function parseTimemark(tm: string): number {
  // Format: HH:MM:SS.cs
  const parts = tm.split(":");
  if (parts.length !== 3) return 0;
  const [h, m, s] = parts;
  const sec = parseFloat(s);
  return Number(h) * 3600 + Number(m) * 60 + (Number.isFinite(sec) ? sec : 0);
}
