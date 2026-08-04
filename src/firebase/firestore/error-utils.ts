'use client';

import { FirestoreError } from 'firebase/firestore';

/**
 * Códigos de erro transientes — o backend estava inalcançável, indisponível ou
 * demorou demais. Ao contrário de uma negação de permissão, esses sinalizam uma
 * FALHA DE REDE/recurso, não uma violação de regras de segurança. O SDK se
 * recupera sozinho (retry com backoff no `onSnapshot`, reconexão ao voltar o
 * backend). O app não deve tratá-los como "permission error" nem apagar os
 * dados que já tem no cache offline.
 */
const CODIGOS_TRANSIENTES = new Set<string>([
  'aborted',
  'busy',
  'cancelled',
  'deadline-exceeded',
  'internal',
  'resource-exhausted',
  'stopped',
  'unavailable',
  'unknown',
]);

/**
 * Códigos que indicam um problema REAL de autorização / segurança.
 */
const CODIGOS_PERMISSAO = new Set<string>(['permission-denied', 'unauthenticated']);

/** True se o erro indica indisponibilidade/falha transitória de rede. */
export function isErroTransitorio(error: FirestoreError | Error | null): boolean {
  if (!error) return false;
  const code = (error as FirestoreError).code;
  if (!code) return false;
  return CODIGOS_TRANSIENTES.has(code);
}

/** True se o erro é um problema real de permissão (regras de segurança). */
export function isErroPermissao(error: FirestoreError | Error | null): boolean {
  if (!error) return false;
  const code = (error as FirestoreError).code;
  if (!code) return false;
  return CODIGOS_PERMISSAO.has(code);
}

const ESPERA_MS = 250;
const RETRIES_ONE_SHOT = 2;

/**
 * Executa um one-shot (`getDocs`/`getDoc`) com tolerância a falhas transitórias:
 * reintenta com backoff quando o resultado é uma falha de rede. Só desiste
 * (rejeita) depois de esgotar as tentativas OU diante de erro não-transitório
 * (ex.: permissão negada).
 */
export async function comRetry<T>(
  executar: () => Promise<T>,
  maxTentativas = RETRIES_ONE_SHOT,
): Promise<T> {
  let ultimaFalha: unknown = null;
  for (let tentativa = 0; tentativa <= maxTentativas; tentativa++) {
    try {
      return await executar();
    } catch (err) {
      ultimaFalha = err;
      const erro = err as FirestoreError | Error;
      // Erro definitivo — não vale reintentar.
      if (isErroPermissao(erro)) throw err;
      if (isErroTransitorio(erro)) {
        if (tentativa < maxTentativas) {
          await new Promise((r) => setTimeout(r, ESPERA_MS * Math.pow(2, tentativa)));
          continue;
        }
      }
      throw err;
    }
  }
  throw ultimaFalha;
}