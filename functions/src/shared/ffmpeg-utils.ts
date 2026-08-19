/**
 * Helpers reutilizados por todas as Cloud Functions de vídeo.
 *
 * - Download de assets do Storage para /tmp.
 * - Geração de arquivo ASS (Advanced SubStation Alpha) para queimar
 *   legendas com `subtitles=` filter do FFmpeg.
 * - Upload do render final + URL pública via Firebase token.
 * - Conversão de presets de resolução em width/height.
 *
 * Os helpers de compressão antiga (download por Stream/token) ficam em
 * `compress.ts` e `quick-edit.ts` (escopo bem específico). Aqui ficam
 * helpers genéricos.
 */

import * as logger from "firebase-functions/logger";
import * as path from "path";
import * as fs from "fs-extra";
import { randomUUID } from "crypto";
import type { Bucket, File } from "@google-cloud/storage";

import type {
  CaptionCue,
  CaptionStyle,
  CaptionTrack,
  ExportSettings,
  VideoProject,
} from "./types";

export interface DownloadedAsset {
  assetId: string;
  localPath: string;
  /** Index na lista de inputs do FFmpeg. */
  index: number;
}

/**
 * Baixa todos os assets referenciados pelas tracks do projeto.
 * Retorna a lista na ordem em que cada asset distinto foi encontrado.
 *
 * Nota: assets sem `storagePath` (caso `local-blob`) são ignorados — só
 * faz sentido renderizar server-side com upload já concluído.
 */
export async function downloadAssetsForProject(
  project: VideoProject,
  bucket: Bucket,
  tmpDir: string,
): Promise<DownloadedAsset[]> {
  // Coleta assets em uso por algum clip não-hidden.
  const usedIds = new Set<string>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!clip.hidden) usedIds.add(clip.assetId);
    }
  }

  const downloaded: DownloadedAsset[] = [];
  let index = 0;

  for (const asset of project.assets) {
    if (!usedIds.has(asset.id)) continue;
    if (!asset.storagePath) {
      logger.warn(
        `Asset ${asset.id} (${asset.name}) sem storagePath — ignorado.`,
      );
      continue;
    }

    const ext = path.extname(asset.name) || extFromType(asset.type);
    const localPath = path.join(tmpDir, `asset-${index}-${asset.id}${ext}`);

    try {
      await bucket.file(asset.storagePath).download({ destination: localPath });
      downloaded.push({ assetId: asset.id, localPath, index });
      index += 1;
    } catch (e) {
      logger.error(
        `Falha ao baixar asset ${asset.id} (${asset.storagePath})`,
        e,
      );
      throw new Error(
        `Não foi possível baixar o asset "${asset.name}" do Storage.`,
      );
    }
  }

  return downloaded;
}

function extFromType(type: "video" | "image" | "audio"): string {
  if (type === "image") return ".png";
  if (type === "audio") return ".mp3";
  return ".mp4";
}

/**
 * Gera string ASS (Advanced SubStation Alpha) com todos os cues das
 * caption tracks visíveis. ASS é o formato preferido pelo filtro
 * `subtitles=` do FFmpeg porque suporta estilos ricos.
 *
 * Estilos POR CUE: cada combinação distinta de estilo dentro de uma track
 * vira um Style próprio no ASS (dedup por assinatura). Um preset aplicado a
 * um único cue no editor chega igual no MP4 — não só o estilo do 1º cue.
 */
export function generateAssFromCaptions(
  captionTracks: CaptionTrack[],
  resolution: { width: number; height: number },
): string {
  const visible = captionTracks.filter((t) => t.visible);
  if (visible.length === 0) {
    return buildAssDocument(resolution, [defaultStyleLine()], []);
  }

  // Dedup de estilos por assinatura (campos que afetam o ASS) — um Style por
  // combinação distinta, cues referenciam o Style da sua própria assinatura.
  const styles: string[] = [];
  const events: string[] = [];
  const styleIndex = new Map<string, string>(); // assinatura → nome do Style

  visible.forEach((track, ti) => {
    track.cues.forEach((cue) => {
      const style = cue.style ?? null;
      const assinatura = styleSignature(style);
      let styleName = styleIndex.get(assinatura);
      if (!styleName) {
        styleName = `S${ti}_${styleIndex.size}`;
        styleIndex.set(assinatura, styleName);
        styles.push(styleLineFromCaptionStyle(styleName, style, resolution));
      }
      events.push(eventLineFromCue(styleName, cue));
    });
    // Track visível sem cue não emite nada — sem estilo órfão.
  });

  if (styles.length === 0) styles.push(defaultStyleLine());
  return buildAssDocument(resolution, styles, events);
}

/** Assinatura estável dos campos de estilo que influenciam o Style ASS. */
function styleSignature(style: CaptionStyle | null): string {
  if (!style) return "default";
  return [
    style.fontFamily,
    style.fontSize,
    style.fontWeight,
    style.color,
    style.backgroundColor,
    style.align,
    style.position,
    style.offsetY ?? 0,
    style.outlineColor ?? "",
    style.outlineWidth ?? 0,
    style.shadowColor ?? "",
    style.shadowBlur ?? 0,
    style.textTransform ?? "none",
    style.letterSpacing ?? 0,
    style.maxWidthPct ?? "",
  ].join("|");
}

function buildAssDocument(
  resolution: { width: number; height: number },
  styles: string[],
  events: string[],
): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${resolution.width}`,
    `PlayResY: ${resolution.height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  ];
  const middle = [
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  return [
    ...header,
    ...styles,
    ...middle,
    ...events,
    "",
  ].join("\n");
}

function defaultStyleLine(): string {
  // Branco com contorno preto, fonte 36, alinhamento embaixo-centro (2).
  return "Style: Default,Inter,36,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1";
}

function styleLineFromCaptionStyle(
  name: string,
  style: CaptionStyle | null,
  resolution: { width: number; height: number },
): string {
  if (!style) {
    return `Style: ${name},Inter,36,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1`;
  }
  const fontname = style.fontFamily || "Inter";
  // Os tamanhos do editor são px @1080 DE ALTURA (mesma semântica do preview,
  // que escala por stageHeight/1080). O ASS usa px no PlayRes real — sem este
  // fator, um export vertical (PlayResY 1280/1920) saía com a legenda menor
  // que o preview mostrava.
  const escala = resolution.height / 1080;
  const fontsize = Math.max(12, Math.round(style.fontSize * escala));
  const primary = hexToAssColor(style.color);
  const outline = style.outlineColor ? hexToAssColor(style.outlineColor) : "&H00000000";
  const bold = style.fontWeight >= 600 ? -1 : 0;
  const borderStyle = style.outlineColor ? 1 : 3; // 3 = caixa de fundo
  const outlineWidth =
    Math.round(Math.max(0, style.outlineWidth ?? 1) * escala * 10) / 10;
  // Em ASS, BackColour é a cor da CAIXA quando BorderStyle=3 e a cor da SOMBRA
  // quando BorderStyle=1 — usar backgroundColor nos dois casos pintava a sombra
  // com a cor do fundo (presets com contorno+sombra saíam errados no MP4).
  const back =
    borderStyle === 3
      ? hexToAssColor(style.backgroundColor)
      : hexToAssColor(style.shadowColor ?? "#000000B3");
  // `shadowBlur` no editor é raio de desfoque (px); o Shadow do ASS é DISTÂNCIA
  // do offset (sem blur por estilo). Mapeia para uma profundidade discreta —
  // blur 16 virar offset 16 deslocava a sombra pra fora do texto.
  const shadowBlur = (style.shadowBlur ?? 0) * escala;
  const shadow =
    shadowBlur <= 0 ? 0 : Math.min(4, Math.max(1, Math.round(shadowBlur / 4)));
  const alignment = assAlignment(style.align, style.position);
  // Espaçamento entre letras (px @1080, mesmo referencial do fontSize).
  const spacing = Math.max(0, (style.letterSpacing ?? 0) * escala);
  // maxWidthPct → margens laterais ((100-pct)/2 de cada lado). Sem o campo,
  // mantém os 40px históricos.
  const margemLateral =
    typeof style.maxWidthPct === "number" && style.maxWidthPct >= 10
      ? Math.round((((100 - Math.min(100, style.maxWidthPct)) / 2) / 100) * resolution.width)
      : Math.round(40 * escala);
  // offsetY (% da altura, aplicado sobre `position`): bottom sobe com offset
  // negativo (margem cresce), top desce com offset positivo. Para position
  // center o ASS ignora MarginV — sem ajuste (mesmo fallback do overlay).
  let margemV = Math.round(40 * escala);
  const offsetY = style.offsetY ?? 0;
  if (offsetY !== 0) {
    const px = Math.round((Math.abs(offsetY) / 100) * resolution.height);
    if (style.position === "bottom" && offsetY < 0) margemV += px;
    else if (style.position === "top" && offsetY > 0) margemV += px;
  }

  return [
    `Style: ${name}`,
    fontname,
    String(fontsize),
    primary,
    "&H000000FF",
    outline,
    back,
    String(bold),
    "0",
    "0",
    "0",
    "100",
    "100",
    spacing.toFixed(1),
    "0",
    String(borderStyle),
    String(outlineWidth),
    String(shadow),
    String(alignment),
    String(margemLateral),
    String(margemLateral),
    String(margemV),
    "1",
  ].join(",");
}

function eventLineFromCue(styleName: string, cue: CaptionCue): string {
  const start = secondsToAssTime(cue.startTime);
  const end = secondsToAssTime(cue.endTime);
  // Newlines em ASS = "\N".
  const upper = cue.style?.textTransform === "uppercase";
  const bruto = upper ? cue.text.toLocaleUpperCase("pt-BR") : cue.text;
  const text = bruto.replace(/\r?\n/g, "\\N").replace(/,/g, "\\,");
  return `Dialogue: 0,${start},${end},${styleName},,0,0,0,,${text}`;
}

function secondsToAssTime(s: number): string {
  const totalCs = Math.max(0, Math.round(s * 100));
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const sec = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${hours}:${pad(minutes)}:${pad(sec)}.${pad(cs)}`;
}

/**
 * Converte hex CSS (#RRGGBB ou #RRGGBBAA) para o formato ASS &HAABBGGRR.
 * ASS usa BGR e alpha invertido (0=opaco, 255=transparente).
 */
function hexToAssColor(hex: string): string {
  if (!hex) return "&H00FFFFFF";
  let h = hex.replace("#", "").trim();
  if (h.length === 3) {
    h = h.split("").map((c) => c + c).join("");
  }
  let r = 255;
  let g = 255;
  let b = 255;
  let a = 255;
  if (h.length >= 6) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }
  if (h.length === 8) {
    a = parseInt(h.slice(6, 8), 16);
  }
  const ainv = 255 - a;
  const toHex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
  return `&H${toHex(ainv)}${toHex(b)}${toHex(g)}${toHex(r)}`;
}

function assAlignment(
  align: "left" | "center" | "right",
  position: "top" | "center" | "bottom",
): number {
  // ASS Alignment: 1-3 (bottom), 4-6 (middle), 7-9 (top); col 1=left,2=center,3=right.
  const col = align === "left" ? 1 : align === "right" ? 3 : 2;
  const row = position === "top" ? 6 : position === "center" ? 3 : 0;
  return row + col;
}

/**
 * Faz upload do render final e devolve URL pública (com Firebase token).
 */
export async function uploadRender(
  localPath: string,
  bucket: Bucket,
  destination: string,
  contentType: string,
): Promise<{ url: string; size: number; storagePath: string }> {
  const token = randomUUID();
  await bucket.upload(localPath, {
    destination,
    metadata: {
      contentType,
      // Cache-Control immutable — renders sempre vão pra path único (jobId).
      cacheControl: "public, max-age=31536000, immutable",
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });

  const file = bucket.file(destination) as unknown as File;
  const [meta] = await file.getMetadata();
  const size = Number(meta.size ?? 0);

  const encoded = encodeURIComponent(destination);
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encoded}?alt=media&token=${token}`;
  return { url, size, storagePath: destination };
}

/**
 * Mapeia o preset de export do front para a resolução final.
 * O aspect ratio (landscape vs portrait) vem do projeto, mas aqui só
 * importa a "altura"; o caller multiplica por aspect ratio do projeto.
 */
export function resolutionPresetToWH(
  preset: ExportSettings["resolution"],
  projectResolution: { width: number; height: number },
): { width: number; height: number } {
  const isPortrait = projectResolution.height > projectResolution.width;
  const longSide = preset === "1080p" ? 1080 : preset === "720p" ? 720 : 480;
  const aspect = isPortrait
    ? projectResolution.height / projectResolution.width
    : projectResolution.width / projectResolution.height;
  if (isPortrait) {
    const height = Math.round(longSide * aspect);
    return ensureEven({ width: longSide, height });
  }
  const width = Math.round(longSide * aspect);
  return ensureEven({ width, height: longSide });
}

function ensureEven(d: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return {
    width: d.width % 2 === 0 ? d.width : d.width + 1,
    height: d.height % 2 === 0 ? d.height : d.height + 1,
  };
}


/**
 * Sonda duração (s) e presença de áudio de um arquivo de mídia SEM ffprobe
 * (o pacote @ffmpeg-installer não traz o binário do ffprobe): roda
 * `ffmpeg -i arquivo` e parseia o stderr ("Duration: HH:MM:SS.cc" +
 * "Stream ... Audio:"). Suficiente para timing de overlays/vinheta.
 */
export function probeMediaInfo(
  filePath: string,
): Promise<{ duration: number; hasAudio: boolean }> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFile } = require("child_process") as typeof import("child_process");
    execFile(
      ffmpegPath,
      ["-hide_banner", "-i", filePath],
      { timeout: 30_000 },
      (_err: unknown, _stdout: string, stderr: string) => {
        // `ffmpeg -i` sem output SEMPRE sai com erro — o que vale é o stderr.
        const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr ?? "");
        if (!m) {
          reject(new Error(`probeMediaInfo: sem Duration no stderr de ${filePath}`));
          return;
        }
        const duration =
          Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        const hasAudio = /Stream #\d+:\d+.*Audio:/.test(stderr ?? "");
        resolve({ duration, hasAudio });
      },
    );
  });
}

/**
 * Garante que o diretório existe e está vazio.
 */
export async function ensureCleanDir(dir: string): Promise<void> {
  await fs.remove(dir).catch(() => undefined);
  await fs.ensureDir(dir);
}

/**
 * Mapeia quality preset → CRF do x264. Mantém a paridade com a função
 * antiga `crfFromQuality` do compress.
 */
export function crfFromExportQuality(q: ExportSettings["quality"]): number {
  if (q === "low") return 28;
  if (q === "high") return 18;
  return 23;
}
