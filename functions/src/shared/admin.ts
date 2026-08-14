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

let _ffmpegLib: any;
function getFFmpeg() {
  if (!_ffmpegLib) {
    const fluentFfmpeg = require("fluent-ffmpeg");
    const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg");
    fluentFfmpeg.setFfmpegPath(ffmpegPath);
    _ffmpegLib = fluentFfmpeg;
  }
  return _ffmpegLib;
}

export function ffmpeg(input?: any) {
  return getFFmpeg()(input);
}
