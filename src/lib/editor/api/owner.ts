/**
 * Descobre o UID do usuário local para carimbar `ownerUid` nos projetos
 * criados pela API.
 *
 * O agente não deveria precisar saber o UID — ele muda a cada vez que a base do
 * emulador de Auth é zerada (quem cria o usuário é o auto-login). Então aqui
 * resolvemos pelo e-mail, na hora.
 */
import { identityToolkitBase } from '@/lib/nexo/emulator-endpoints';

const PROJECT_ID =
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'studio-8612233125-caa0a';
const EMAIL_DEV = process.env.NEXO_DEV_EMAIL || 'dev@local.nexo';

let cache: string | null = null;

/**
 * UID do usuário `dev@local.nexo` no emulador de Auth.
 *
 * As rules de `videoProjects` exigem `resource.data.ownerUid == request.auth.uid`
 * para leitura — se a API gravar um ownerUid diferente do usuário que abre o
 * editor, o projeto existe mas fica invisível na interface. Por isso não há
 * default chutado aqui: sem usuário, falha com mensagem explicando o conserto.
 */
export async function resolverOwnerUid(): Promise<string> {
  if (cache) return cache;

  const url = `${identityToolkitBase()}/projects/${PROJECT_ID}/accounts:query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`nao consegui consultar o emulador de Auth: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    userInfo?: Array<{ localId: string; email?: string }>;
  };
  const contas = body.userInfo ?? [];
  const dev = contas.find((u) => u.email === EMAIL_DEV) ?? contas[0];
  if (!dev) {
    throw new Error(
      `nenhum usuario no emulador de Auth. Rode: node scripts/nexo-seed-dev.mjs`,
    );
  }
  cache = dev.localId;
  return cache;
}

/** Zera o cache — útil quando o emulador é reiniciado no meio da sessão. */
export function limparCacheOwner(): void {
  cache = null;
}
