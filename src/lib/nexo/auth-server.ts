/**
 * Verificação de sessão Firebase para as API routes do NEXO.
 *
 * Faz DUAS coisas, server-side, sem depender de `firebase-admin`:
 *  1. Autentica o ID token (`Authorization: Bearer …`) via `accounts:lookup`
 *     do Identity Toolkit — rejeita token inválido, expirado ou de outro
 *     projeto.
 *  2. Autoriza: lê `/users/{uid}` no Firestore (via REST, com o próprio token
 *     do usuário) e exige `isActive == true`. Token válido NÃO basta — uma
 *     conta qualquer do projeto não pode acessar o NEXO.
 *
 * A sessão devolve o `idToken` para a rota poder LER as coleções `nexo_*` do
 * Firestore via REST com a credencial do próprio usuário (ver firestore-read.ts).
 */
import { firebaseConfig } from '@/firebase/config';
import {
  identityToolkitBase,
  firestoreDocumentsBase,
  USING_EMULATOR,
} from './emulator-endpoints';

const LOOKUP_URL = `${identityToolkitBase()}/accounts:lookup?key=${firebaseConfig.apiKey}`;
const FIRESTORE_BASE = firestoreDocumentsBase();

export interface Sessao {
  ok: boolean;
  uid: string | null;
  /** ID token do usuário — usado para ler `nexo_*` via REST com a sessão dele. */
  idToken: string | null;
  /** Status HTTP sugerido: 401 sem token/ inválido, 403 sem acesso, 502 verificador indisponível. */
  status: 200 | 401 | 403 | 502;
}

export async function verificarSessao(req: Request): Promise<Sessao> {
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, uid: null, idToken: null, status: 401 };
  const idToken = m[1];

  // 1. Autenticação — valida o ID token contra o projeto.
  let uid: string;
  try {
    const res = await fetch(LOOKUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
      cache: 'no-store',
    });
    if (res.status === 400 || res.status === 401) {
      return { ok: false, uid: null, idToken: null, status: 401 }; // token inválido/expirado
    }
    if (!res.ok) return { ok: false, uid: null, idToken: null, status: 502 }; // verificador indisponível
    const data = (await res.json()) as {
      users?: { localId?: string; disabled?: boolean }[];
    };
    const user = data.users?.[0];
    if (!user || user.disabled || !user.localId) {
      return { ok: false, uid: null, idToken: null, status: 401 };
    }
    uid = user.localId;
  } catch {
    return { ok: false, uid: null, idToken: null, status: 502 };
  }

  // 2. Autorização — o usuário precisa ter perfil ativo no Firestore.
  if (USING_EMULATOR) {
    return { ok: true, uid, idToken, status: 200 };
  }

  try {
    const res = await fetch(`${FIRESTORE_BASE}/users/${uid}`, {
      headers: { Authorization: `Bearer ${idToken}` },
      cache: 'no-store',
    });
    if (res.status === 404) return { ok: false, uid, idToken: null, status: 403 }; // sem perfil
    if (!res.ok) return { ok: false, uid, idToken: null, status: 502 };
    const doc = (await res.json()) as {
      fields?: { isActive?: { booleanValue?: boolean } };
    };
    if (doc.fields?.isActive?.booleanValue !== true) {
      return { ok: false, uid, idToken: null, status: 403 }; // conta não ativa
    }
    return { ok: true, uid, idToken, status: 200 };
  } catch {
    return { ok: false, uid, idToken: null, status: 502 };
  }
}
