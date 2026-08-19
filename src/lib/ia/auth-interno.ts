/**
 * Auth INTERNA service-to-service para os endpoints /api/ia/* chamados pelas
 * Cloud Functions (que não importam de src/ e roteiam IA pelo gateway via HTTP).
 *
 * Modelo: um único token compartilhado (`INTERNAL_IA_TOKEN`, secret no App
 * Hosting e nas functions) enviado no header `x-internal-ia-token`. Comparação
 * em tempo CONSTANTE (timingSafeEqual) p/ não vazar o tamanho por timing.
 *
 * Sem o secret configurado → SEMPRE inválido (fail-closed): os endpoints negam
 * em vez de abrir geral.
 */
import crypto from 'node:crypto';

export const HEADER_TOKEN_INTERNO = 'x-internal-ia-token';

/** SHA-256 (32 bytes fixos) — normaliza o tamanho antes do compare. */
function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

/**
 * O request traz o token interno correto? Fail-closed se o secret faltar.
 * Compara DIGESTS de tamanho fixo (sha256) em tempo constante — não vaza o
 * tamanho do token por timing (o length-check ingênuo seria um oráculo).
 */
export function tokenInternoValido(req: Request): boolean {
  const esperado = process.env.INTERNAL_IA_TOKEN?.trim();
  if (!esperado) return false; // sem secret → ninguém entra
  const recebido = (req.headers.get(HEADER_TOKEN_INTERNO) ?? '').trim();
  if (!recebido) return false;
  try {
    return crypto.timingSafeEqual(sha256(recebido), sha256(esperado));
  } catch {
    return false;
  }
}
