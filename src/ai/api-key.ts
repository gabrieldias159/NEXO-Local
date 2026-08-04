/**
 * Resolução e sanitização da chave da API do Gemini.
 *
 * Bug recorrente: chaves coladas em `.env` no Windows ou via cmdlets do
 * PowerShell podem conter BOM (`﻿`), zero-width space (`​`) ou
 * espaços/aspas/CR. Isso faz o SDK do Gemini explodir em runtime com:
 *
 *   "Cannot convert argument to a ByteString because the character at
 *    index 0 has a value of 65279 which is greater than 255."
 *
 * Esse helper trata o valor antes de devolver — barato, idempotente e
 * cobre todas as fontes (`.env`, Secret Manager, env vars do sistema).
 */

/** Caracteres invisíveis que não podem entrar em headers HTTP. */
const STRIP_CHARS_RE = /[﻿​-‍⁠ ]/g;

/**
 * Limpa uma chave de API: remove BOM, zero-width chars, NBSP, aspas
 * e qualquer whitespace nas bordas. Devolve `undefined` para vazio.
 */
export function sanitizeApiKey(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(STRIP_CHARS_RE, '')
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
  return cleaned || undefined;
}

/**
 * Resolve a chave da API do Gemini a partir das env vars conhecidas
 * (`GEMINI_API_KEY` > `GOOGLE_API_KEY` > `GOOGLE_GENAI_API_KEY`),
 * sanitizando antes de devolver.
 */
export function resolveGeminiApiKey(): string | undefined {
  return (
    sanitizeApiKey(process.env.GEMINI_API_KEY) ??
    sanitizeApiKey(process.env.GOOGLE_API_KEY) ??
    sanitizeApiKey(process.env.GOOGLE_GENAI_API_KEY)
  );
}
