/**
 * Leitura server-side das coleções `nexo_*` do Firestore.
 *
 * Usa a REST API do Firestore (`:runQuery`) com o ID token do próprio usuário
 * — o mesmo padrão de `auth-server.ts`. NÃO depende de `firebase-admin`: o app
 * principal só tem o SDK client. As `firestore.rules` liberam `read` nas
 * coleções `nexo_*` para usuário ativo (`isActiveUser()`), então a query roda
 * sob a sessão do usuário que `verificarSessao` já validou.
 *
 * É o que permite as rotas `/api/nexo/*` LEREM o que o cron de ingestão
 * persistiu, em vez de bater nas APIs externas a cada request.
 *
 * Uso exclusivo server-side (API routes).
 */
import { VERSAO_WORKER } from '@/lib/nexo/jobs-tipos';
import {
  firestoreDocumentsBase,
  storageDownloadBase,
} from '@/lib/nexo/emulator-endpoints';

const DOC_BASE = firestoreDocumentsBase();
const RUN_QUERY_URL = `${DOC_BASE}:runQuery`;

// ── Conversão dos valores tipados da REST do Firestore para JS plano ─────────

type ValorFirestore = Record<string, unknown>;

function decodeValor(v: ValorFirestore): unknown {
  if (v == null) return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) {
    const fields =
      (v.mapValue as { fields?: Record<string, ValorFirestore> }).fields ?? {};
    return decodeFields(fields);
  }
  if ('arrayValue' in v) {
    const values =
      (v.arrayValue as { values?: ValorFirestore[] }).values ?? [];
    return values.map((x) => decodeValor(x));
  }
  return null;
}

function decodeFields(
  fields: Record<string, ValorFirestore>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValor(v);
  return out;
}

// ── Leitura de coleção `nexo_*` ──────────────────────────────────────────────

export interface FiltroNexo {
  /** Filtra por `_exercicio`. */
  exercicio?: number;
  /** Filtra por `_fonte` (o nome curto do módulo, ex.: 'empenhos'). */
  fonte?: string;
  /** Filtra por `_cnpj` (só dígitos). */
  cnpj?: string;
  /**
   * Filtro de igualdade por um campo de STRING arbitrário — retrocompatível
   * (sem este campo, comportamento inalterado). Usado pelas rotas snapshot-first
   * para buscar `nexo_snapshots` por `chave` (a chave canônica da tarefa). A
   * igualdade em campo indexável é o que mantém a leitura instantânea (sem varrer
   * a coleção inteira em memória).
   */
  igual?: { campo: string; valor: string };
  /**
   * Teto de documentos trazidos pelo `:runQuery` (`limit` do `structuredQuery`).
   * RETROCOMPATÍVEL: sem este campo, o comportamento é inalterado (a query
   * transmite TODOS os resultados que casam o `where`). Quando informado, o
   * Firestore para de transmitir após `limit` docs — é a defesa server-side
   * contra OOM/latência em coleções grandes (`nexo_empenhos`/`nexo_pagamentos`
   * têm dezenas de milhares de docs/ano). Combine com `campos` (projeção) para
   * cortar payload por dois eixos. Atenção: com `limit`, a leitura passa a ser
   * AMOSTRA — só use quando o agregado tolerar truncamento (ou quando o teto é
   * folgado o bastante para cobrir a coleção inteira no caso esperado).
   */
  limit?: number;
  /** Ordenação simples por um campo indexável. */
  orderBy?: { campo: string; direcao?: 'asc' | 'desc' };
}

interface RunQueryLinha {
  document?: { name: string; fields?: Record<string, ValorFirestore> };
  readTime?: string;
}

interface RunAggregationLinha {
  result?: {
    aggregateFields?: Record<string, ValorFirestore>;
  };
}

function montarStructuredQuery(
  colecao: string,
  filtro: FiltroNexo,
  campos?: string[],
): Record<string, unknown> {
  const filtros: ValorFirestore[] = [];
  if (filtro.exercicio != null) {
    filtros.push({
      fieldFilter: {
        field: { fieldPath: '_exercicio' },
        op: 'EQUAL',
        value: { integerValue: String(filtro.exercicio) },
      },
    });
  }
  if (filtro.fonte) {
    filtros.push({
      fieldFilter: {
        field: { fieldPath: '_fonte' },
        op: 'EQUAL',
        value: { stringValue: filtro.fonte },
      },
    });
  }
  if (filtro.cnpj) {
    filtros.push({
      fieldFilter: {
        field: { fieldPath: '_cnpj' },
        op: 'EQUAL',
        value: { stringValue: filtro.cnpj },
      },
    });
  }
  if (filtro.igual && filtro.igual.campo) {
    filtros.push({
      fieldFilter: {
        field: { fieldPath: filtro.igual.campo },
        op: 'EQUAL',
        value: { stringValue: filtro.igual.valor },
      },
    });
  }

  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: colecao }],
  };
  if (campos && campos.length > 0) {
    structuredQuery.select = { fields: campos.map((f) => ({ fieldPath: f })) };
  }
  if (filtros.length === 1) {
    structuredQuery.where = filtros[0];
  } else if (filtros.length > 1) {
    structuredQuery.where = {
      compositeFilter: { op: 'AND', filters: filtros },
    };
  }
  if (filtro.orderBy?.campo) {
    structuredQuery.orderBy = [
      {
        field: { fieldPath: filtro.orderBy.campo },
        direction: filtro.orderBy.direcao === 'asc' ? 'ASCENDING' : 'DESCENDING',
      },
    ];
  }
  if (filtro.limit != null && filtro.limit > 0) {
    structuredQuery.limit = Math.trunc(filtro.limit);
  }
  return structuredQuery;
}

/**
 * Lê os documentos de uma coleção `nexo_*` que casam o filtro. O `:runQuery`
 * do Firestore transmite todos os resultados que casam o `where` — adequado às
 * coleções por exercício do NEXO. Cada documento volta como o `Record` plano
 * exatamente no formato que os normalizadores de `normalizar.ts` esperam (o
 * cron persiste o registro bruto da fonte + campos `_*`).
 *
 * @throws se a REST responder não-2xx (a rota distingue isso de "vazio").
 */
export async function lerColecaoNexo(
  colecao: string,
  filtro: FiltroNexo,
  idToken: string,
  /**
   * Projeção opcional: se informado, o `:runQuery` traz SÓ estes campos (`select`)
   * — reduz drasticamente o payload em coleções grandes (ex.: `nexo_empenhos`
   * tem dezenas de milhares de docs/ano com ~30 campos cada; projetar os ~14 que
   * o normalizador usa evita trafegar/parsear centenas de MB). `_docId` continua
   * exposto a partir do `name`. Sem o param, comportamento inalterado (todos os
   * campos) — retrocompatível com os demais chamadores.
   */
  campos?: string[],
): Promise<Record<string, unknown>[]> {
  const structuredQuery = montarStructuredQuery(colecao, filtro, campos);

  const res = await fetch(RUN_QUERY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Firestore runQuery HTTP ${res.status} em ${colecao}`);
  }
  const linhas = (await res.json()) as RunQueryLinha[];
  const out: Record<string, unknown>[] = [];
  for (const linha of linhas) {
    if (!linha.document) continue;
    const rec = decodeFields(linha.document.fields ?? {});
    // Expõe o docId do Firestore como `_docId` (último segmento do `name`). É o
    // que o grafo `nexo_links` referencia em `_de`/`_para` (id = docId), e que o
    // raio-x precisa para casar empenho↔vínculo. Não colide com campos da fonte
    // (todos os campos `_*` são carimbados pelo cron; a fonte usa `ID`/`NroEmpenho`).
    const segs = linha.document.name.split('/');
    rec._docId = segs[segs.length - 1];
    out.push(rec);
  }
  return out;
}

/**
 * Conta os documentos que casam o filtro sem transferir a coleção inteira.
 */
export async function contarColecaoNexo(
  colecao: string,
  filtro: FiltroNexo,
  idToken: string,
): Promise<number> {
  const res = await fetch(`${DOC_BASE}:runAggregationQuery`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery: montarStructuredQuery(colecao, filtro),
        aggregations: [{ alias: 'total', count: {} }],
      },
    }),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Firestore runAggregationQuery HTTP ${res.status} em ${colecao}`);
  }
  const linhas = (await res.json()) as RunAggregationLinha[];
  for (const linha of linhas) {
    const total = linha.result?.aggregateFields?.total;
    if (total && 'integerValue' in total) return Number(total.integerValue);
  }
  return 0;
}

/**
 * Lê um único documento por caminho (ex.: `nexo_sync_state/empenhos-2026`).
 * Devolve `null` se não existir.
 */
export async function lerDocNexo(
  caminho: string,
  idToken: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${DOC_BASE}/${caminho}`, {
    headers: { Authorization: `Bearer ${idToken}` },
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Firestore GET HTTP ${res.status} em ${caminho}`);
  }
  const doc = (await res.json()) as { fields?: Record<string, ValorFirestore> };
  return decodeFields(doc.fields ?? {});
}

// ── Leitura snapshot-first de `nexo_snapshots` ───────────────────────────────

const STORAGE_DOWNLOAD_BASE = storageDownloadBase();

/** Metadados + payload resolvido de um snapshot materializado pelo worker. */
export interface SnapshotLido {
  /** O payload completo do snapshot (o que a rota devolveu no modo compute). */
  payload: Record<string, unknown>;
  /** ISO da geração (campo `geradoEm`). */
  geradoEm: string | null;
  /** ISO da expiração (campo `expiraEm`). */
  expiraEm: string | null;
  /** docId do snapshot (`{chave}:{epoch}`). */
  snapshotId: string;
  /**
   * true quando o snapshot JÁ passou do TTL e está sendo servido como STALE
   * (last-good) — só ocorre com `incluirExpirado`. A rota serve o dado vencido
   * em vez de computar live; o nightly/Compilar recompõe em background.
   */
  expirado: boolean;
}

/**
 * Resolve o path local do objeto a partir de uma URL `gs://bucket/path`.
 */
function pathDoGs(gs: string): string | null {
  const m = /^gs:\/\/[^/]+\/(.+)$/.exec(gs);
  return m ? m[1] : null;
}

/**
 * Baixa e descomprime (gzip) um payload de snapshot do Firebase Storage usando o
 * token do próprio usuário (a app não tem admin SDK). Best-effort: devolve null
 * se o objeto não existir/for inacessível — a rota degrada honestamente.
 */
async function baixarPayloadStorage(
  gs: string,
  idToken: string,
): Promise<Record<string, unknown> | null> {
  const path = pathDoGs(gs);
  if (!path) return null;
  // O endpoint de download do Firebase Storage espera o path URL-encoded inteiro
  // (a barra vira %2F). `alt=media` devolve os bytes do objeto.
  const url = `${STORAGE_DOWNLOAD_BASE}/${encodeURIComponent(path)}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  // O worker grava com `contentEncoding: gzip`. O download via `alt=media`
  // entrega os bytes CRUS (gzipados); descomprimimos aqui. Fallback: se já vier
  // texto JSON (não-gzip), tenta parsear direto.
  try {
    const { gunzipSync } = await import('node:zlib');
    const txt = gunzipSync(buf).toString('utf8');
    return JSON.parse(txt) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/**
 * Lê o snapshot PRONTO mais recente (e não expirado) de uma `chave` canônica de
 * tarefa (`{tipo}:{alvo}:{exercicio}`). É o caminho INSTANTÂNEO das rotas
 * snapshot-first: a `chave` é campo indexável de igualdade, então a leitura é
 * O(1) em vez de varrer a coleção. Devolve null quando não há snapshot vivo (a
 * rota responde então o estado honesto "compile para gerar").
 *
 * @throws se a REST responder não-2xx (a rota distingue isso de "vazio").
 */
export async function lerSnapshotMaisRecente(
  chave: string,
  idToken: string,
  opts?: { incluirExpirado?: boolean },
): Promise<SnapshotLido | null> {
  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: 'nexo_snapshots' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'chave' },
        op: 'EQUAL',
        value: { stringValue: chave },
      },
    },
    orderBy: [{ field: { fieldPath: 'geradoEm' }, direction: 'DESCENDING' }],
    limit: 1,
  };

  const res = await fetch(RUN_QUERY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Firestore runQuery HTTP ${res.status} em nexo_snapshots`);
  }
  const linhas = (await res.json()) as RunQueryLinha[];
  const linha = linhas.find((l) => l.document);
  if (!linha?.document) return null;

  const rec = decodeFields(linha.document.fields ?? {});
  const segs = linha.document.name.split('/');
  const snapshotId = segs[segs.length - 1];
  const expiraEm = typeof rec.expiraEm === 'string' ? rec.expiraEm : null;
  const geradoEm = typeof rec.geradoEm === 'string' ? rec.geradoEm : null;

  const expirado = !!(expiraEm && new Date(expiraEm).getTime() <= Date.now());
  // Expirado: por padrão trata como ausente. Com `incluirExpirado`, devolve o
  // ÚLTIMO BOM (stale) — a rota serve dado vencido em vez de computar live; o
  // nightly/Compilar recompõe em background (blindagem snapshot-only do NEXO).
  if (expirado && !opts?.incluirExpirado) return null;

  let payload: Record<string, unknown> | null = null;
  if (rec.payloadInline && typeof rec.payloadInline === 'object') {
    payload = rec.payloadInline as Record<string, unknown>;
  } else if (typeof rec.payloadStorage === 'string' && rec.payloadStorage) {
    payload = await baixarPayloadStorage(rec.payloadStorage, idToken);
  }
  if (!payload) return null;

  return { payload, geradoEm, expiraEm, snapshotId, expirado };
}

// ── Enfileirar recompute em background (nexo_tarefas) ─────────────────────────

/**
 * Enfileira (best-effort, fire-and-forget) uma tarefa de recompute em
 * `nexo_tarefas` via REST, espelhando o botão Compilar (`criarTarefaNexo` em
 * NexoTarefaTracker): permite que uma rota snapshot-first sirva STALE/ausente e
 * recomponha em BACKGROUND, sem computar pesado no request do usuário.
 *
 *  - docId = chave `{tipo}:{alvo}:{exercicio}` (dedupe de tarefa viva);
 *  - se já há tarefa `pendente`/`processando` p/ a chave → NÃO duplica (null);
 *  - se há concluída (`pronto`/`erro`/`expirado`) → cria doc NOVO `{chave}:{epoch}`
 *    (a rule é create-only e o worker é `onDocumentCreated` — precisa NASCER);
 *  - NUNCA lança. A rule exige `solicitadoPor == uid` e `status == 'pendente'`.
 */
export async function enfileirarRecompute(
  tipo: string,
  alvo: string,
  exercicio: number,
  uid: string,
  idToken: string,
): Promise<string | null> {
  if (!uid) return null;
  const chave = `${tipo}:${alvo}:${exercicio}`;
  try {
    const viva = await lerDocNexo(`nexo_tarefas/${chave}`, idToken);
    let docId = chave;
    if (viva) {
      const st = typeof viva.status === 'string' ? viva.status : '';
      if (st === 'pendente' || st === 'processando') return null; // já rodando
      docId = `${chave}:${Date.now()}`; // concluída → doc NOVO p/ disparar o worker
    }
    const body = {
      fields: {
        tipo: { stringValue: tipo },
        alvo: { stringValue: alvo },
        exercicio: { integerValue: String(exercicio) },
        status: { stringValue: 'pendente' },
        origem: { stringValue: 'nightly' },
        solicitadoPor: { stringValue: uid },
        snapshotId: { nullValue: null },
        progresso: { integerValue: '0' },
        erro: { nullValue: null },
        tentativas: { integerValue: '0' },
        _versaoWorker: { integerValue: String(VERSAO_WORKER) },
        criadoEm: { timestampValue: new Date().toISOString() },
      },
    };
    const res = await fetch(
      `${DOC_BASE}/nexo_tarefas?documentId=${encodeURIComponent(docId)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        cache: 'no-store',
      },
    );
    if (!res.ok) return null; // 409 (corrida) ou rule — best-effort
    return docId;
  } catch {
    return null;
  }
}
