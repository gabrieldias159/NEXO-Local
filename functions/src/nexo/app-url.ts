/**
 * Resolve a URL base da aplicação Next.js consumida pelas Cloud Functions NEXO.
 *
 * Prioridade:
 *   1. `NEXO_APP_URL` explícita (override manual).
 *   2. Emulador local de functions -> app local em `localhost:9002`.
 *   3. Fallback do App Hosting publicado.
 *
 * Isso evita que o NEXO local bata no host de produção por padrão.
 */

const APP_URL_PROD =
  "https://studio--studio-8612233125-caa0a.us-central1.hosted.app";
const APP_URL_LOCAL = process.env.NEXO_LOCAL_APP_URL ?? "http://127.0.0.1:9002";

function emuladorAtivo(): boolean {
  return (
    process.env.FUNCTIONS_EMULATOR === "true" ||
    Boolean(process.env.FIREBASE_EMULATOR_HUB)
  );
}

export function resolverAppUrl(): string {
  const explicit = process.env.NEXO_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return (emuladorAtivo() ? APP_URL_LOCAL : APP_URL_PROD).replace(/\/+$/, "");
}
