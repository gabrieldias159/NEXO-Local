/**
 * Cloud Function: `onCaptionGenerateRequest`.
 *
 * Trigger Firestore em `captionJobs/{jobId}`. Gera legendas (caption track)
 * para um `VideoProject` transcrevendo via gateway de IA do app
 * (`transcreverAudioTemporizadoViaGateway` → Groq Whisper verbose_json →
 * failover Gemini JSON), com segmentos temporizados.
 *
 * Pipeline:
 *  1. Lê o doc do job. Se `status !== 'pending'`, ignora.
 *  2. Se `needsServerMix && !mixedAudioPath`: baixa todos os áudios do
 *     projeto (tracks de áudio + áudio das tracks de vídeo) e mixa via
 *     FFmpeg `amix` com `adelay` por offset. Faz upload de `mixed.mp3`
 *     para `captionJobs/{ownerUid}/{jobId}/mixed.mp3` e atualiza o doc.
 *  3. Se `mixedAudioPath` já existe (cliente mixou): pula etapa 2.
 *  4. Para áudios > 8min, fatia em chunks de 8min com overlap de 5s.
 *  5. Transcreve cada chunk via gateway de IA (Whisper verbose_json →
 *     Gemini JSON), recebendo segmentos temporizados `[{start, end, text}]`.
 *  6. Concatena segmentos (deduplicando overlap) → CaptionCue[].
 *  7. Atualiza o `videoProjects/{projectId}` adicionando uma nova
 *     `CaptionTrack` (source='ai', aiJobId=...).
 *  8. Salva `.srt` cru em `captions/{ownerUid}/{jobId}.srt`.
 *  9. Marca o job como `complete` com `captionTrackId`, `srtStoragePath`,
 *     `completedAt`.
 *
 * Configuração:
 *  - region us-central1, timeoutSeconds 540, memory '2GiB', cpu 2,
 *    maxInstances 5, concurrency 1.
 */

import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import * as os from "os";
import * as path from "path";
import * as fs from "fs-extra";
import { randomUUID } from "crypto";
import type { File } from "@google-cloud/storage";

import { admin, bucket, db, ffmpeg } from "../shared/admin";
import type {
  CaptionGenerationJob,
  CaptionJobStatus,
  CaptionTrack,
  Clip,
  MediaAsset,
  Track,
  VideoProject,
} from "../shared/types";
import { ensureCleanDir } from "../shared/ffmpeg-utils";
import {
  transcreverAudioTemporizadoViaGateway,
  assertGatewayConfigurado,
} from "../ia/gateway-client";

// ============================================================================
// Constantes
// ============================================================================

const MIX_SAMPLE_RATE = 16000; // Whisper/Gemini aceitam 16kHz mono perfeitamente.
const CHUNK_SECONDS = 8 * 60; // 8 minutos.
const CHUNK_OVERLAP_SECONDS = 5;
const MAX_TRANSCRIBE_RETRIES = 2;

// ============================================================================
// Trigger
// ============================================================================

export const onCaptionGenerateRequest = onDocumentCreated(
  {
    document: "captionJobs/{jobId}",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "2GiB",
    cpu: 2,
    maxInstances: 5,
    concurrency: 1,
    secrets: ["INTERNAL_IA_TOKEN"],
  },
  async (event) => {
    const jobSnap = event.data;
    if (!jobSnap) {
      logger.error("No data associated with the event.");
      return;
    }

    const job = jobSnap.data() as CaptionGenerationJob;
    const { jobId } = event.params;
    const jobRef = db.doc(`captionJobs/${jobId}`);

    if (job.status !== "pending") {
      logger.log(`Caption job ${jobId} status=${job.status} — ignorando.`);
      return;
    }
    if (!job.projectId || !job.ownerUid) {
      const msg = "Caption job sem projectId ou ownerUid.";
      logger.error(msg, { jobId });
      await jobRef.update({ status: "error", error: msg });
      return;
    }

    // Fail-fast ANTES de mixar/fatiar áudio: gateway precisa de URL + token.
    try {
      assertGatewayConfigurado();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(msg, { jobId });
      await jobRef.update({ status: "error", error: msg });
      return;
    }

    const tmpDir = path.join(os.tmpdir(), `caption-${jobId}`);
    const localMixedPath = path.join(tmpDir, "mixed.mp3");

    let cancelled = false;
    const setStatus = async (
      status: CaptionJobStatus,
      patch: Record<string, unknown> = {},
    ): Promise<void> => {
      try {
        await jobRef.update({ status, ...patch });
      } catch (e) {
        logger.warn("Falha ao atualizar status do caption job.", {
          jobId,
          err: String(e),
        });
      }
    };
    const setProgress = async (p: number): Promise<void> => {
      try {
        await jobRef.update({ progress: Math.max(0, Math.min(100, Math.round(p))) });
      } catch {
        /* noop */
      }
    };
    const checkCancelled = async (): Promise<boolean> => {
      try {
        const snap = await jobRef.get();
        const data = snap.data() as CaptionGenerationJob | undefined;
        return data?.status === "cancelled";
      } catch {
        return false;
      }
    };

    try {
      await ensureCleanDir(tmpDir);
      await jobRef.update({
        status: "mixing",
        progress: 0,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ---- 1. Carregar projeto -------------------------------------------
      const projectRef = db.doc(`videoProjects/${job.projectId}`);
      const projectSnap = await projectRef.get();
      if (!projectSnap.exists) {
        throw new Error(`Projeto ${job.projectId} não encontrado.`);
      }
      const project = projectSnap.data() as VideoProject;

      // ---- 2. Mixagem (server-side) se necessário -------------------------
      let mixedAudioPath = job.mixedAudioPath;
      if (!mixedAudioPath) {
        if (!job.needsServerMix) {
          throw new Error(
            "Job indica que cliente mixaria, mas mixedAudioPath está vazio.",
          );
        }
        logger.info(`[caption ${jobId}] mixando áudio server-side…`);
        await mixProjectAudioServer(project, localMixedPath, tmpDir);
        if (await checkCancelled()) {
          cancelled = true;
          throw new Error("Job cancelled by user.");
        }
        const dest = `captionJobs/${job.ownerUid}/${jobId}/mixed.mp3`;
        await uploadFile(localMixedPath, dest, "audio/mpeg");
        mixedAudioPath = dest;
        await jobRef.update({ mixedAudioPath });
      } else {
        logger.info(
          `[caption ${jobId}] usando mixedAudioPath fornecido pelo cliente.`,
        );
        await bucket.file(mixedAudioPath).download({ destination: localMixedPath });
      }
      await setProgress(30);

      if (await checkCancelled()) {
        cancelled = true;
        throw new Error("Job cancelled by user.");
      }

      // ---- 3. Transcrição -------------------------------------------------
      await setStatus("transcribing");
      const totalDurationSec = await probeAudioDuration(localMixedPath);
      logger.info(
        `[caption ${jobId}] áudio mixado: ${totalDurationSec.toFixed(1)}s`,
      );

      const segments = await transcribeWithChunking({
        localAudioPath: localMixedPath,
        durationSec: totalDurationSec,
        tmpDir,
        language: job.language,
        onProgress: async (p) => {
          // Mapeia 0..1 da transcrição → 30..85 do progresso global.
          await setProgress(30 + p * 55);
        },
        isCancelled: checkCancelled,
      });

      if (await checkCancelled()) {
        cancelled = true;
        throw new Error("Job cancelled by user.");
      }

      logger.info(
        `[caption ${jobId}] segmentos extraídos: ${segments.length}`,
      );

      // ---- 4. Mapeia segmentos → CaptionTrack ----------------------------
      await setStatus("aligning");
      await setProgress(90);

      const captionTrackId = `captrk_ai_${jobId}`;
      const newTrack: CaptionTrack = {
        id: captionTrackId,
        name: `Legendas IA · ${job.language}`,
        index: project.captionTracks?.length ?? 0,
        visible: true,
        locked: false,
        language: job.language,
        cues: segments.map((seg, i) => ({
          id: `cue_ai_${jobId}_${i}`,
          startTime: seg.start,
          endTime: seg.end,
          text: seg.text,
          slot: "full",
          style: defaultCaptionStyle(),
        })),
      };

      // Adiciona a track no projeto (transação para concorrência).
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(projectRef);
        if (!snap.exists) throw new Error("Projeto sumiu durante o job.");
        const proj = snap.data() as VideoProject;
        const tracks = Array.isArray(proj.captionTracks)
          ? [...proj.captionTracks]
          : [];
        tracks.push({
          ...newTrack,
          index: tracks.length,
          source: "ai",
          aiJobId: jobId,
        });
        tx.update(projectRef, { captionTracks: tracks });
      });

      // ---- 5. SRT cru no Storage -----------------------------------------
      const srt = generateSrtFromSegments(segments);
      const srtPath = `captions/${job.ownerUid}/${jobId}.srt`;
      const localSrtPath = path.join(tmpDir, `${jobId}.srt`);
      await fs.writeFile(localSrtPath, srt, "utf-8");
      await uploadFile(localSrtPath, srtPath, "application/x-subrip");

      // ---- 6. Marca complete --------------------------------------------
      await jobRef.update({
        status: "complete",
        progress: 100,
        captionTrackId,
        srtStoragePath: srtPath,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`[caption ${jobId}] concluído. Track=${captionTrackId}.`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error("Falha no caption job.", { jobId, message });
      const finalStatus =
        cancelled || message.toLowerCase().includes("cancel")
          ? "cancelled"
          : "error";
      await jobRef
        .update({
          status: finalStatus,
          error: message,
        })
        .catch(() => undefined);
    } finally {
      await fs.remove(tmpDir).catch(() => undefined);
    }
  },
);

// ============================================================================
// Mixagem server-side via FFmpeg `amix` + `adelay`
// ============================================================================

async function mixProjectAudioServer(
  project: VideoProject,
  outputPath: string,
  tmpDir: string,
): Promise<void> {
  const audibleClips = collectAudibleClips(project);
  if (audibleClips.length === 0) {
    throw new Error(
      "Projeto não tem clips com áudio — não há nada para transcrever.",
    );
  }

  // Baixa cada asset usado.
  const assetMap = new Map<string, MediaAsset>();
  for (const a of project.assets) assetMap.set(a.id, a);

  const downloads: Array<{
    clip: Clip;
    localPath: string;
  }> = [];
  let i = 0;
  for (const clip of audibleClips) {
    const asset = assetMap.get(clip.assetId);
    if (!asset || !asset.storagePath) {
      logger.warn(
        `[caption mix] clip ${clip.id} sem storagePath — ignorado.`,
      );
      continue;
    }
    const ext = path.extname(asset.name) || extFromType(asset.type);
    const localPath = path.join(tmpDir, `mix-input-${i}-${asset.id}${ext}`);
    try {
      await bucket.file(asset.storagePath).download({ destination: localPath });
      downloads.push({ clip, localPath });
      i += 1;
    } catch (e) {
      logger.warn(
        `[caption mix] falha ao baixar asset ${asset.id}: ${String(e)}`,
      );
    }
  }
  if (downloads.length === 0) {
    throw new Error("Nenhum asset com áudio pôde ser baixado.");
  }

  // Monta filter_complex: para cada input k:
  //   [k:a]atrim=startInAsset:endInAsset,asetpts=PTS-STARTPTS,
  //        adelay=Dms|Dms,
  //        volume=V[a_k]
  // Depois: [a_0][a_1]...amix=inputs=N:dropout_transition=0,
  //         aresample=16000,pan=mono|c0=c0[mixed]
  const filterParts: string[] = [];
  const labels: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cmd: any = ffmpeg();
  downloads.forEach(({ clip, localPath }, k) => {
    cmd = cmd.addInput(localPath);
    const startInAsset = Math.max(0, clip.startInAsset ?? 0);
    const endInAsset = Math.max(
      startInAsset + 0.05,
      clip.endInAsset ?? startInAsset + (clip.endInTimeline - clip.startInTimeline),
    );
    const offsetMs = Math.max(0, Math.round((clip.startInTimeline ?? 0) * 1000));
    const volume = Math.max(0, Math.min(4, clip.audio?.volume ?? 1));
    const muted = clip.audio?.muted === true;
    const effectiveVol = muted ? 0 : volume;

    const label = `a_${k}`;
    const parts = [
      `atrim=start=${startInAsset.toFixed(3)}:end=${endInAsset.toFixed(3)}`,
      `asetpts=PTS-STARTPTS`,
    ];
    if (offsetMs > 0) {
      // adelay precisa de "Dms|Dms" (um por canal); damos os dois.
      parts.push(`adelay=${offsetMs}|${offsetMs}`);
    }
    parts.push(`volume=${effectiveVol.toFixed(3)}`);
    filterParts.push(`[${k}:a]${parts.join(",")}[${label}]`);
    labels.push(label);
  });

  const inputs = labels.map((l) => `[${l}]`).join("");
  const numInputs = labels.length;
  filterParts.push(
    `${inputs}amix=inputs=${numInputs}:dropout_transition=0:normalize=0[mix_raw]`,
  );
  filterParts.push(
    `[mix_raw]aresample=${MIX_SAMPLE_RATE},pan=mono|c0=c0[mixed]`,
  );

  cmd = cmd.complexFilter(filterParts);

  await new Promise<void>((resolve, reject) => {
    cmd
      .map("[mixed]")
      .audioCodec("libmp3lame")
      .audioBitrate("64k")
      .audioChannels(1)
      .audioFrequency(MIX_SAMPLE_RATE)
      .outputOptions(["-vn"])
      .outputFormat("mp3")
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .save(outputPath);
  });
}

function collectAudibleClips(project: VideoProject): Clip[] {
  const out: Clip[] = [];
  for (const track of project.tracks ?? []) {
    if (!isAudibleTrack(track)) continue;
    for (const clip of track.clips ?? []) {
      if (clip.hidden) continue;
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (!asset) continue;
      // Pula clips de imagem (sem áudio).
      if (asset.type === "image") continue;
      // Mute global de track silencia o clip — pulamos.
      if (track.muted) continue;
      out.push(clip);
    }
  }
  return out;
}

function isAudibleTrack(track: Track): boolean {
  // Tracks de vídeo carregam áudio embutido; tracks de áudio são óbvias.
  return track.type === "audio" || track.type === "video";
}

function extFromType(type: "video" | "image" | "audio"): string {
  if (type === "image") return ".png";
  if (type === "audio") return ".mp3";
  return ".mp4";
}

// ============================================================================
// Transcrição via gateway de IA (Whisper verbose_json → Gemini JSON)
// ============================================================================

interface RawSegment {
  start: number;
  end: number;
  text: string;
}

interface TranscribeOpts {
  localAudioPath: string;
  durationSec: number;
  tmpDir: string;
  language: string;
  onProgress: (p: number) => Promise<void>;
  isCancelled: () => Promise<boolean>;
}

async function transcribeWithChunking(
  opts: TranscribeOpts,
): Promise<RawSegment[]> {
  const {
    localAudioPath,
    durationSec,
    tmpDir,
    language,
    onProgress,
    isCancelled,
  } = opts;

  // Se cabe num único chunk, vai direto.
  if (durationSec <= CHUNK_SECONDS) {
    const segs = await transcribeChunk({
      localAudioPath,
      offsetSec: 0,
      language,
    });
    await onProgress(1);
    return mergeOverlappingSegments(segs);
  }

  // Caso contrário, fatia em chunks.
  const chunks: Array<{ start: number; end: number; localPath: string }> = [];
  let cursor = 0;
  let i = 0;
  while (cursor < durationSec) {
    const end = Math.min(durationSec, cursor + CHUNK_SECONDS);
    const localPath = path.join(tmpDir, `chunk-${i}.mp3`);
    chunks.push({ start: cursor, end, localPath });
    if (end >= durationSec) break;
    cursor = end - CHUNK_OVERLAP_SECONDS;
    i += 1;
  }

  // Gera chunks via FFmpeg `-ss / -to`.
  for (const c of chunks) {
    if (await isCancelled()) throw new Error("Job cancelled by user.");
    await sliceAudio(localAudioPath, c.localPath, c.start, c.end);
  }

  // Transcreve sequencial (sequencial evita estourar rate-limit do gateway).
  const all: RawSegment[] = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    if (await isCancelled()) throw new Error("Job cancelled by user.");
    const c = chunks[idx];
    const segs = await transcribeChunk({
      localAudioPath: c.localPath,
      offsetSec: c.start,
      language,
    });
    all.push(...segs);
    await onProgress((idx + 1) / chunks.length);
  }

  return mergeOverlappingSegments(all);
}

async function sliceAudio(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSec)
      .setDuration(Math.max(0.1, endSec - startSec))
      .audioCodec("libmp3lame")
      .audioBitrate("64k")
      .audioChannels(1)
      .audioFrequency(MIX_SAMPLE_RATE)
      .outputOptions(["-vn"])
      .outputFormat("mp3")
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .save(outputPath);
  });
}

interface TranscribeChunkOpts {
  localAudioPath: string;
  offsetSec: number;
  language: string;
}

async function transcribeChunk(opts: TranscribeChunkOpts): Promise<RawSegment[]> {
  const { localAudioPath, offsetSec, language } = opts;
  // Transcrição TEMPORIZADA pelo gateway de IA: Groq Whisper verbose_json
  // (segments[].start/.end em segundos) com failover para Gemini JSON. O
  // endpoint LANÇA se não houver segmentos utilizáveis — em sucesso `segmentos`
  // vem sempre preenchido. Tempos são relativos ao ÁUDIO ENVIADO (o chunk),
  // então somamos `offsetSec` para reposicionar na timeline global.

  // O áudio mixado e os chunks são MP3 (libmp3lame, outputFormat("mp3")) — mime
  // coerente com o arquivo real é `audio/mp3`.
  const audioBytes = await fs.readFile(localAudioPath);
  const audioDataUri = `data:audio/mp3;base64,${audioBytes.toString("base64")}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_TRANSCRIBE_RETRIES; attempt++) {
    try {
      const resp = await transcreverAudioTemporizadoViaGateway({
        audioDataUri,
        mime: "audio/mp3",
        idioma: language,
      });
      logger.info(
        `[caption transcribe] ok via ${resp.provedor}/${resp.modelo} — ` +
          `${resp.segmentos.length} segmentos.`,
      );
      return resp.segmentos
        .filter(
          (s) =>
            typeof s.start === "number" &&
            typeof s.end === "number" &&
            typeof s.text === "string" &&
            s.text.trim().length > 0,
        )
        .map((s) => ({
          start: Math.max(0, s.start) + offsetSec,
          end: Math.max(Math.max(0, s.start) + 0.1, s.end) + offsetSec,
          text: s.text.trim(),
        }));
    } catch (e) {
      lastErr = e;
      logger.warn(
        `[caption transcribe] tentativa ${attempt + 1} falhou: ${String(e)}`,
      );
      // Backoff incremental.
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error(
    `Transcrição via gateway falhou após ${MAX_TRANSCRIBE_RETRIES + 1} tentativas: ${String(lastErr)}`,
  );
}

/**
 * Remove segmentos duplicados/sobrepostos da emenda dos chunks.
 * Mantém o mais cedo quando há overlap > 50%.
 */
function mergeOverlappingSegments(segs: RawSegment[]): RawSegment[] {
  if (segs.length <= 1) return segs.slice();
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out: RawSegment[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(s);
      continue;
    }
    const overlap = prev.end - s.start;
    const sDur = s.end - s.start;
    if (overlap > 0 && overlap / Math.max(0.1, sDur) > 0.5) {
      // Provavelmente o mesmo trecho repetido; mantém prev.
      continue;
    }
    if (overlap > 0) {
      // Pequena sobreposição — encurta `prev.end` para não quebrar UI.
      prev.end = Math.max(prev.start + 0.1, s.start);
    }
    out.push(s);
  }
  return out;
}

// ============================================================================
// Helpers locais
// ============================================================================

async function probeAudioDuration(localPath: string): Promise<number> {
  return new Promise<number>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ffmpeg() as any).ffprobe(localPath, (err: Error | null, data: { format?: { duration?: number } }) => {
      if (err) {
        logger.warn("ffprobe falhou ao medir duração — assumindo 0.", err);
        resolve(0);
        return;
      }
      resolve(Number(data?.format?.duration ?? 0) || 0);
    });
  });
}

async function uploadFile(
  localPath: string,
  destination: string,
  contentType: string,
): Promise<{ url: string; storagePath: string }> {
  const token = randomUUID();
  await bucket.upload(localPath, {
    destination,
    metadata: {
      contentType,
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  const file = bucket.file(destination) as unknown as File;
  const [meta] = await file.getMetadata();
  void meta;
  const encoded = encodeURIComponent(destination);
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encoded}?alt=media&token=${token}`;
  return { url, storagePath: destination };
}

function generateSrtFromSegments(segments: RawSegment[]): string {
  const lines: string[] = [];
  segments.forEach((s, i) => {
    lines.push(String(i + 1));
    lines.push(`${secondsToSrt(s.start)} --> ${secondsToSrt(s.end)}`);
    lines.push(s.text);
    lines.push("");
  });
  return lines.join("\n");
}

function secondsToSrt(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const hh = Math.floor(ms / 3_600_000);
  const mm = Math.floor((ms % 3_600_000) / 60_000);
  const ss = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(milli, 3)}`;
}

function defaultCaptionStyle() {
  return {
    fontFamily: "Inter",
    fontSize: 36,
    fontWeight: 600 as const,
    color: "#FFFFFF",
    backgroundColor: "#000000B3",
    align: "center" as const,
    position: "bottom" as const,
    paddingX: 12,
    paddingY: 4,
    borderRadius: 4,
  };
}
