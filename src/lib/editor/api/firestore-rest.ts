/**
 * Acesso ADMIN ao Firestore para a API de automação do Estúdio.
 *
 * Por que REST e não firebase-admin: este app segue a regra do repo de NÃO
 * carregar o Admin SDK (ver `src/lib/nexo/firestore-read.ts`). As rotas do NEXO
 * já falam a REST API do Firestore com o ID token do usuário; aqui o chamador é
 * uma MÁQUINA (um agente), que não tem sessão — então usamos o token especial
 * `owner`, que o EMULADOR aceita como bypass de rules.
 *
 * CONSEQUÊNCIA IMPORTANTE: isto só funciona contra o emulador. Em um Firestore
 * real `Bearer owner` é rejeitado. É deliberado — o NEXO-Local é um ambiente
 * local, e uma API que escreve sem rules jamais deveria alcançar produção.
 */
import { firestoreDocumentsBase, USING_EMULATOR } from '@/lib/nexo/emulator-endpoints';

/**
 * `firestoreDocumentsBase()` JA devolve ate `.../databases/(default)/documents`
 * — nao remontar o caminho aqui, sob pena de duplica-lo.
 */
function base(): string {
  return firestoreDocumentsBase();
}

function headers(): Record<string, string> {
  return {
    Authorization: 'Bearer owner',
    'Content-Type': 'application/json',
  };
}

/** Falha cedo e com mensagem clara se alguém apontar isto para produção. */
export function assertEmulador(): void {
  if (!USING_EMULATOR) {
    throw new Error(
      'A API de automação do Estúdio só opera contra o Firebase Emulator ' +
        '(NEXO_USE_EMULATOR=1). Ela escreve com privilégio de owner, ignorando ' +
        'as security rules — não pode tocar um projeto real.',
    );
  }
}

// ── Conversão JSON <-> valores tipados do Firestore REST ─────────────────────

type ValorRest = Record<string, unknown>;

/** JS → representação tipada do Firestore REST. */
export function paraRest(v: unknown): ValorRest {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) {
    // Firestore não aceita array DENTRO de array; os arrays aninhados do
    // projeto (tracks[].clips[]) são sempre arrays de MAPAS, o que é válido.
    return { arrayValue: { values: v.map(paraRest) } };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'object') {
    const fields: Record<string, ValorRest> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue; // Firestore rejeita undefined
      fields[k] = paraRest(val);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

/** Representação tipada do Firestore REST → JS. */
export function deRest(v: ValorRest | undefined): unknown {
  if (!v) return undefined;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) {
    const vals = (v.arrayValue as { values?: ValorRest[] })?.values ?? [];
    return vals.map(deRest);
  }
  if ('mapValue' in v) {
    const f = (v.mapValue as { fields?: Record<string, ValorRest> })?.fields ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(f)) out[k] = deRest(val);
    return out;
  }
  return undefined;
}

function docParaObjeto(doc: { fields?: Record<string, ValorRest> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields ?? {})) out[k] = deRest(v);
  return out;
}

// ── Operações de documento ───────────────────────────────────────────────────

/** Lê um documento. Devolve `null` se não existir. */
export async function lerDoc(
  caminho: string,
): Promise<Record<string, unknown> | null> {
  assertEmulador();
  const res = await fetch(`${base()}/${caminho}`, { headers: headers(), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore GET ${caminho}: HTTP ${res.status}`);
  return docParaObjeto(await res.json());
}

/** Substitui um documento inteiro (equivale a `setDoc` com merge:false). */
export async function gravarDoc(
  caminho: string,
  dados: Record<string, unknown>,
): Promise<void> {
  assertEmulador();
  const fields: Record<string, ValorRest> = {};
  for (const [k, v] of Object.entries(dados)) {
    if (v === undefined) continue;
    fields[k] = paraRest(v);
  }
  const res = await fetch(`${base()}/${caminho}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    throw new Error(`Firestore PATCH ${caminho}: HTTP ${res.status} ${await res.text()}`);
  }
}

/** Apaga um documento. */
export async function apagarDoc(caminho: string): Promise<void> {
  assertEmulador();
  const res = await fetch(`${base()}/${caminho}`, { method: 'DELETE', headers: headers() });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Firestore DELETE ${caminho}: HTTP ${res.status}`);
  }
}

/** Lista documentos de uma coleção (sem paginação — uso local). */
export async function listarColecao(
  colecao: string,
  limite = 100,
): Promise<Array<Record<string, unknown> & { id: string }>> {
  assertEmulador();
  const res = await fetch(`${base()}/${colecao}?pageSize=${limite}`, {
    headers: headers(),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Firestore LIST ${colecao}: HTTP ${res.status}`);
  const body = (await res.json()) as {
    documents?: Array<{ name: string; fields?: Record<string, ValorRest> }>;
  };
  return (body.documents ?? []).map((d) => ({
    ...docParaObjeto(d),
    id: d.name.split('/').pop() as string,
  }));
}
