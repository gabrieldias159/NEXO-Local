/**
 * Inicializa o `firebase-admin` uma única vez no processo. Todas as
 * Cloud Functions do NEXO importam `db`/`bucket` daqui — sem duplicar
 * `admin.initializeApp()`.
 *
 * O helper `ffmpeg()` (lazy-load de `fluent-ffmpeg` + binário do
 * `@ffmpeg-installer/ffmpeg`) é usado pelas functions do Estúdio de Vídeo
 * (`functions/src/video/*`). O lazy-load importa: carregar o binário no
 * top-level atrasaria a subida de TODAS as functions, inclusive as de coleta
 * do NEXO, que não têm nada a ver com vídeo.
 */

import admin from "firebase-admin";

if (admin.apps.length === 0) {
  admin.initializeApp();
}

export const db = admin.firestore();

// LAZY: a Bucket só é resolvida no PRIMEIRO uso. Chamar
// `admin.storage().bucket()` (default, sem nome) no TOP-LEVEL força uma busca
// de projectId no metadata server; na ANÁLISE do deploy (ambiente sem metadata
// nem storageBucket) isso trava ~10s e lança "Bucket name not specified" — o
// firebase então reporta "User code failed to load. Timeout after 10000" e o
// deploy de functions falha. Em runtime o ambiente já tem o bucket, então adiar
// o acesso até o primeiro uso elimina a falha de carga SEM mudar os call sites
// (todos acessam `bucket.file()/upload()/name/...`, que o Proxy encaminha).
let _bucket: ReturnType<ReturnType<typeof admin.storage>["bucket"]> | null =
  null;
function resolveBucket(): ReturnType<ReturnType<typeof admin.storage>["bucket"]> {
  if (!_bucket) _bucket = admin.storage().bucket();
  return _bucket;
}
export const bucket = new Proxy(
  {} as ReturnType<typeof resolveBucket>,
  {
    get(_target, prop) {
      const b = resolveBucket() as unknown as Record<string | symbol, unknown>;
      const value = b[prop];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(b)
        : value;
    },
  },
);

export { admin };

let _ffmpegPath: string | null = null;
/**
 * Caminho do binário do ffmpeg usado pelas functions de vídeo.
 *
 * O `@ffmpeg-installer/ffmpeg` embute um build de 2018 (pré-4.1) — sem
 * `xfade`, `amix normalize`, `lumakey`... No EMULADOR local, preferimos um
 * ffmpeg moderno: `FFMPEG_PATH` explícito ou o primeiro `ffmpeg` do PATH do
 * sistema. Fora do emulador (produção) mantém o binário embutido.
 */
export function ffmpegBinaryPath(): string {
  if (_ffmpegPath) return _ffmpegPath;
  const fs = require("fs") as typeof import("fs");
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && fs.existsSync(envPath)) {
    _ffmpegPath = envPath;
    return _ffmpegPath;
  }
  if (process.env.FUNCTIONS_EMULATOR) {
    try {
      const { execSync } = require("child_process") as typeof import("child_process");
      const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
      const found = execSync(cmd, { encoding: "utf8" })
        .split(/\r?\n/)
        .map((l: string) => l.trim())
        .filter(Boolean)[0];
      if (found && fs.existsSync(found)) {
        _ffmpegPath = found;
        return _ffmpegPath;
      }
    } catch {
      // sem ffmpeg no PATH — cai no embutido
    }
  }
  const { path: bundled } = require("@ffmpeg-installer/ffmpeg");
  _ffmpegPath = bundled as string;
  return _ffmpegPath;
}

let _ffmpegLib: any;
function getFFmpeg() {
  if (!_ffmpegLib) {
    const fluentFfmpeg = require("fluent-ffmpeg");
    fluentFfmpeg.setFfmpegPath(ffmpegBinaryPath());
    _ffmpegLib = fluentFfmpeg;
  }
  return _ffmpegLib;
}

export function ffmpeg(input?: any) {
  return getFFmpeg()(input);
}
