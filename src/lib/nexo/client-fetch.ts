/**
 * `fetch` autenticado para as rotas `/api/nexo/*`.
 *
 * Anexa o ID token Firebase do usuário logado no header `Authorization`.
 * Uso client-side, dentro das páginas do NEXO (onde o usuário já está
 * autenticado e ativo — ver NexoShell).
 *
 * Se a rota responder 401, tenta FORÇAR refresh do token (getIdToken(true)) e
 * retenta a requisição — cobre o cenário de emulador reiniciado onde o token
 * cached do browser perdeu validade.
 */
import { getAuth, signOut } from 'firebase/auth';

/** Teto de espera no cliente — nenhuma página do NEXO fica em loading eterno. */
const TIMEOUT_MS = 90_000;

async function obterToken(): Promise<string | null> {
  const user = getAuth().currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
  }
}

async function obterTokenForcado(): Promise<string | null> {
  const user = getAuth().currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(true);
  } catch {
    // Token irremediavelmente inválido (emulador reiniciou) — desloga para
    // que o LocalAutoAuth faça um login novo.
    await signOut(getAuth()).catch(() => {});
    return null;
  }
}

async function fetchComToken(input: string, init: RequestInit | undefined, token: string | null, signal: AbortSignal): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers, signal });
}

export async function nexoFetch(input: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const token = await obterToken();
    const res = await fetchComToken(input, init, token, ctrl.signal);

    // 401 com token existente → pode ser token expirado/invalidado por
    // reinicialização do emulador. Tenta refresh forçado uma vez.
    if (res.status === 401 && token) {
      const tokenNovo = await obterTokenForcado();
      if (tokenNovo && tokenNovo !== token) {
        const res2 = await fetchComToken(input, init, tokenNovo, ctrl.signal);
        if (res2.ok) return res2;
        if (res2.status !== 401) return res2;
        // Refresh não resolveu — cai fora e retorna o 401 original.
      }
    }

    return res;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(
        'tempo de resposta excedido — a fonte de dados está lenta ou indisponível',
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
