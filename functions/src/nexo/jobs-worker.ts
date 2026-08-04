/**
 * NEXO — WORKER da fila de jobs/snapshots (Frente E do plano-mestre §2.2).
 *
 * Cloud Function gen2 disparada por CRIAÇÃO de doc em `nexo_tarefas/{chave}`.
 * Materializa o painel pedido (dossie/grafo/alertas/risco/ranking) chamando a
 * ROTA EXISTENTE da aplicação em modo `?compute=1` (sem reimplementar
 * `montar*`/`montarGrafo`/`paraAlerta`) e persiste o resultado em
 * `nexo_snapshots/{chave}:{epoch}`. Em seguida avança a tarefa para `pronto`.
 *
 * Fluxo (plano §2.2):
 *   nexo_tarefas (create, status:'pendente')
 *     → worker: status='processando'
 *     → fetch APP/api/nexo/<tipo>?compute=1  (x-nexo-secret + token de serviço)
 *     → grava nexo_snapshots (payload + geradoEm + expiraEm + delta)
 *     → nexo_tarefas: status='pronto', snapshotId
 *
 * Self-contained: o projeto `functions/` NÃO importa de `src/`. Os tipos vivem
 * em `./jobs-tipos.ts` (espelho verbatim de `src/lib/nexo/jobs-tipos.ts`).
 *
 * CONTRATO com a ROTA `?compute=1` (implementada pela Frente F):
 *   Request  → GET `${APP_URL}/api/nexo/<tipo>?compute=1&exercicio=<n>&alvo=<id>`
 *              header `x-nexo-secret: <DIARIO_BACKFILL_SECRET>`
 *              header `x-nexo-firestore-token: <OAuth2 access token de serviço>`
 *   Response → JSON. O worker aceita DUAS formas (retrocompatível):
 *              (a) envelope `{ payload, nDocsLidos?, hashEntrada? }`
 *              (b) o payload puro (qualquer objeto) — vira `payloadInline` direto.
 *
 * Robustez: NUNCA lança para fora — falha vira `status:'erro'` no doc da tarefa
 * (com `tentativas`/`erro`) e log. O TTL nativo + o cron de varredura limpam o
 * lixo; o nightly re-enfileira o que expira.
 */
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { admin, db, bucket } from "../shared/admin";
import { resolverAppUrl } from "./app-url";
import {
  VERSAO_ESQUEMA_SNAPSHOT,
  VERSAO_WORKER,
  TTL_SNAPSHOT_MS,
  LIMITE_INLINE_BYTES,
  MAX_TENTATIVAS,
  chaveSnapshot,
  type NexoTarefa,
  type ResumoDelta,
  type TipoTarefa,
} from "./jobs-tipos";

/**
 * URL base da aplicação Next.js (App Hosting). `NEXO_APP_URL` com fallback ao
 * host REAL do App Hosting (`*.hosted.app`) — mesmo padrão de `deteccao.ts`/
 * `gerente.ts`. O fallback antigo `oficioexpress.web.app` é o Hosting legado
 * estático (404 em /api/*).
 */
const APP_URL = resolverAppUrl();

/**
 * Timeout da chamada de `?compute=1`. As rotas pesadas (grafo/alertas/dossie)
 * leem coleções grandes do Firestore — o teto real da rota é o App Hosting
 * (1800s). 600s por tarefa cabe com folga.
 */
const COMPUTE_TIMEOUT_MS = 600_000;

/** Reusa o segredo já provisionado (backfill do Diário) p/ o `x-nexo-secret`. */
const BACKFILL_SECRET = defineSecret("DIARIO_BACKFILL_SECRET");

/** Tipos válidos de tarefa — guarda contra docs corrompidos. */
const TIPOS_VALIDOS: ReadonlySet<TipoTarefa> = new Set<TipoTarefa>([
  "dossie",
  "grafo",
  "alertas",
  "risco",
  "ranking",
]);

/**
 * Mina um access token OAuth2 de serviço (ADC do ambiente das functions) para
 * a rota `?compute=1` autenticar a leitura REST das coleções `nexo_*` (a rota
 * não tem `firebase-admin`). Mesmo mecanismo de `deteccao.ts`.
 */
async function obterTokenFirestore(): Promise<string> {
  const credential = admin.app().options.credential;
  if (!credential || typeof credential.getAccessToken !== "function") {
    throw new Error(
      "credencial admin indisponível para obter access token de leitura",
    );
  }
  const { access_token: token } = await credential.getAccessToken();
  if (!token) throw new Error("access token de leitura vazio");
  return token;
}

/**
 * Erro que sinaliza DEPENDÊNCIA FORA (transitória): a rota `?compute=1`
 * respondeu 503/429 (IA esgotada, fonte indisponível, rate-limit) — NÃO é um
 * bug da tarefa. O worker deve DEGRADAR (deixar `pendente`, recuar) em vez de
 * queimar uma tentativa que escala rumo a `_esgotouRetries` (raiz das 150
 * falhas do P1-B: martelar a rota enquanto a IA estava esgotada).
 */
class DependenciaForaError extends Error {
  readonly status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.name = "DependenciaForaError";
    this.status = status;
  }
}

/**
 * Circuit-breaker LEVE por instância (gen2 reusa a instância entre eventos com
 * `concurrency:1`/`maxInstances:3`). Quando a rota `?compute=1` é vista FORA
 * (503/429), abrimos o circuito por uma janela curta: as próximas tarefas que
 * caírem nesta instância pulam o fetch e já saem como `pendente` (degradação
 * barata), sem martelar a rota nem queimar tentativas. Fecha sozinho ao expirar.
 */
const CIRCUITO_JANELA_MS = 60_000;
let circuitoAbertoAte = 0;

/** `true` enquanto o circuito (dependência fora) estiver aberto. */
function circuitoAberto(): boolean {
  return Date.now() < circuitoAbertoAte;
}

/** Abre o circuito por `CIRCUITO_JANELA_MS` a partir de agora. */
function abrirCircuito(): void {
  circuitoAbertoAte = Date.now() + CIRCUITO_JANELA_MS;
}

interface EnvelopeCompute {
  payload?: Record<string, unknown>;
  nDocsLidos?: number;
  hashEntrada?: string;
}

interface ResultadoCompute {
  payload: Record<string, unknown>;
  nDocsLidos: number;
  /** Hash declarado pela rota (preferido); senão derivado do payload. */
  hashEntrada: string;
}

/**
 * Chama a rota `?compute=1` e devolve o payload + metadados. Aceita o envelope
 * `{ payload, nDocsLidos, hashEntrada }` OU o payload puro (retrocompat).
 */
async function chamarCompute(
  tarefa: NexoTarefa,
  secret: string,
  firestoreToken: string,
): Promise<ResultadoCompute> {
  const params = new URLSearchParams({
    compute: "1",
    exercicio: String(tarefa.exercicio),
  });
  if (tarefa.alvo) params.set("alvo", tarefa.alvo);
  const url = `${APP_URL}/api/nexo/${tarefa.tipo}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "x-nexo-secret": secret,
        "x-nexo-firestore-token": firestoreToken,
      },
      signal: AbortSignal.timeout(COMPUTE_TIMEOUT_MS),
    });
  } catch (err) {
    // Timeout/rede ao falar com a rota = dependência fora (transitória).
    throw new DependenciaForaError(
      0,
      `/api/nexo/${tarefa.tipo}?compute=1 inacessível: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // 503/429 = a rota está DEGRADANDO (IA esgotada / fonte indisponível /
  // rate-limit). É transitório — não martelar: o circuit-breaker abre e a
  // tarefa fica `pendente` (não queima tentativa).
  // Cloud Run devolve 429 E 500 para a MESMA condição "no available instance"
  // (saturação), e a edge devolve 500/502/504 para requests abortados/saturados.
  // Tratar toda a família 5xx + 429 como transitória → não queima tentativa.
  if ([429, 500, 502, 503, 504].includes(res.status)) {
    throw new DependenciaForaError(
      res.status,
      `/api/nexo/${tarefa.tipo}?compute=1 HTTP ${res.status} (dependência/capacidade fora)`,
    );
  }
  if (!res.ok) {
    throw new Error(`/api/nexo/${tarefa.tipo}?compute=1 HTTP ${res.status}`);
  }
  const json = (await res.json()) as unknown;
  if (json == null || typeof json !== "object") {
    throw new Error(`/api/nexo/${tarefa.tipo}?compute=1 devolveu corpo vazio`);
  }

  const env = json as EnvelopeCompute;
  const payload: Record<string, unknown> =
    env.payload && typeof env.payload === "object"
      ? env.payload
      : (json as Record<string, unknown>);

  const hashEntrada =
    typeof env.hashEntrada === "string" && env.hashEntrada.length > 0
      ? env.hashEntrada
      : sha1(stableStringify(payload));

  const nDocsLidos =
    typeof env.nDocsLidos === "number" && Number.isFinite(env.nDocsLidos)
      ? env.nDocsLidos
      : 0;

  return { payload, nDocsLidos, hashEntrada };
}

/** sha1 hex de uma string (deteção de alteração / skip-recompile). */
function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/**
 * JSON estável (chaves ordenadas) — para o hash não depender da ordem de
 * inserção das chaves no objeto retornado pela rota.
 */
function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = o[k];
          return acc;
        }, {});
    }
    return val;
  });
}

/**
 * Calcula o delta vs o snapshot anterior (mesma chave), se houver. Heurística
 * conservadora: conta itens da lista mais óbvia do payload (`alertas`/`links`/
 * `nos`/`itens`) e soma `valorEnvolvido`/`valor`. `null` quando não há anterior
 * (NUNCA inventar delta — plano §2.2: "null = primeira").
 */
function calcularDelta(
  atual: Record<string, unknown>,
  anterior: Record<string, unknown> | null,
): ResumoDelta | null {
  if (!anterior) return null;
  const a = extrairItens(atual);
  const b = extrairItens(anterior);
  const idsA = new Set(a.map((x) => x.id));
  const idsB = new Set(b.map((x) => x.id));
  let novos = 0;
  let removidos = 0;
  for (const id of idsA) if (!idsB.has(id)) novos++;
  for (const id of idsB) if (!idsA.has(id)) removidos++;
  const valorA = a.reduce((s, x) => s + x.valor, 0);
  const valorB = b.reduce((s, x) => s + x.valor, 0);
  return { novos, removidos, deltaValor: valorA - valorB };
}

/** Extrai uma lista canônica {id,valor} do payload para o delta. */
function extrairItens(
  p: Record<string, unknown>,
): Array<{ id: string; valor: number }> {
  const lista =
    (Array.isArray(p.alertas) && p.alertas) ||
    (Array.isArray(p.links) && p.links) ||
    (Array.isArray((p.grafo as Record<string, unknown>)?.arestas) &&
      (p.grafo as Record<string, unknown>).arestas) ||
    (Array.isArray(p.itens) && p.itens) ||
    (Array.isArray(p.nos) && p.nos) ||
    [];
  return (lista as unknown[]).map((it, i) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const id = String(
      o.id ?? o.chaveDeteccao ?? o.chave ?? o.docId ?? `#${i}`,
    );
    const valorRaw = o.valorEnvolvido ?? o.valor ?? o.valorAncora ?? 0;
    const valor = typeof valorRaw === "number" ? valorRaw : Number(valorRaw);
    return { id, valor: Number.isFinite(valor) ? valor : 0 };
  });
}

/** Lê o snapshot mais recente de uma chave (para delta + skip-recompile). */
async function lerUltimoSnapshot(
  chave: string,
): Promise<{ id: string; payload: Record<string, unknown> | null; hash: string } | null> {
  const snap = await db
    .collection("nexo_snapshots")
    .where("chave", "==", chave)
    .orderBy("geradoEm", "desc")
    .limit(1)
    .get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  const data = d.data();
  let payload: Record<string, unknown> | null =
    (data.payloadInline as Record<string, unknown>) ?? null;
  // Se o anterior está no Storage, baixa só para o delta (best-effort).
  if (!payload && typeof data.payloadStorage === "string") {
    payload = await lerPayloadStorage(data.payloadStorage as string);
  }
  return {
    id: d.id,
    payload,
    hash: String(data._hashEntrada ?? ""),
  };
}

/** Resolve o path local do bucket a partir de uma URL `gs://bucket/path`. */
function pathDoGs(gs: string): string | null {
  const m = /^gs:\/\/[^/]+\/(.+)$/.exec(gs);
  return m ? m[1] : null;
}

/** Baixa+descomprime um payload do Storage (best-effort; null em falha). */
async function lerPayloadStorage(
  gs: string,
): Promise<Record<string, unknown> | null> {
  try {
    const path = pathDoGs(gs);
    if (!path) return null;
    const [buf] = await bucket.file(path).download();
    const { gunzipSync } = await import("node:zlib");
    const txt = gunzipSync(buf).toString("utf8");
    return JSON.parse(txt) as Record<string, unknown>;
  } catch (err) {
    logger.warn("NEXO worker — falha ao ler payload anterior do Storage", {
      gs,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Grava o snapshot: inline se <900KB, senão `.json.gz` no Storage. Devolve o
 * id do snapshot e o tamanho em bytes.
 */
async function gravarSnapshot(
  chave: string,
  tarefa: NexoTarefa,
  res: ResultadoCompute,
  delta: ResumoDelta | null,
  geradoEm: Date,
): Promise<{ snapshotId: string; tamanhoBytes: number }> {
  const epoch = geradoEm.getTime();
  const snapshotId = chaveSnapshot(chave, epoch);
  const json = JSON.stringify(res.payload);
  const tamanhoBytes = Buffer.byteLength(json, "utf8");

  const base: Record<string, unknown> = {
    chave,
    tipo: tarefa.tipo,
    alvo: tarefa.alvo,
    exercicio: tarefa.exercicio,
    geradoEm: admin.firestore.Timestamp.fromDate(geradoEm),
    expiraEm: admin.firestore.Timestamp.fromMillis(epoch + TTL_SNAPSHOT_MS),
    _versaoEsquema: VERSAO_ESQUEMA_SNAPSHOT,
    _hashEntrada: res.hashEntrada,
    resumoDelta: delta,
    tamanhoBytes,
    nDocsLidos: res.nDocsLidos,
    payloadInline: null,
    payloadStorage: null,
  };

  if (tamanhoBytes <= LIMITE_INLINE_BYTES) {
    base.payloadInline = res.payload;
  } else {
    const path = `nexo-snapshots/${snapshotId}.json.gz`;
    const gz = gzipSync(Buffer.from(json, "utf8"));
    await bucket.file(path).save(gz, {
      contentType: "application/json",
      metadata: {
        contentEncoding: "gzip",
        cacheControl: "private, max-age=0",
      },
    });
    base.payloadStorage = `gs://${bucket.name}/${path}`;
  }

  await db.collection("nexo_snapshots").doc(snapshotId).set(base);
  return { snapshotId, tamanhoBytes };
}

/**
 * DEGRADA a tarefa: a dependência (rota/IA/fonte) está fora — NÃO é culpa da
 * tarefa, então NÃO incrementamos `tentativas` (não escala rumo a
 * `_esgotouRetries` por apagão de dependência — raiz das 150 falhas do P1-B).
 *
 * Status `'erro'` + `degradado:true` (não `'pendente'`): de propósito. O nightly
 * (`enfileirar`) PULA docs já `pendente`/`processando`, mas RE-CRIA limpos os
 * `erro`/`pronto`/expirados — então `'erro'` mantém a tarefa re-disparável no
 * próximo ciclo (quando a IA recompõe), enquanto `'pendente'` a deixaria
 * estagnada. `degradado:true` + `_adiado` distinguem, no painel/log, "recuei por
 * dependência fora" de uma falha dura de processamento. Honesto: não finge
 * sucesso, e o `tentativas` intacto deixa explícito que não foi a tarefa que
 * falhou.
 */
async function marcarPendentePorDependencia(
  ref: FirebaseFirestore.DocumentReference,
  motivo: string,
): Promise<void> {
  await ref.set(
    {
      status: "erro",
      degradado: true,
      _adiado: true,
      erro: motivo,
      progresso: 0,
      _adiadoEm: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** Marca a tarefa como erro/retry, sem lançar. */
async function marcarErro(
  ref: FirebaseFirestore.DocumentReference,
  tarefa: NexoTarefa,
  msg: string,
): Promise<void> {
  const tentativas = (tarefa.tentativas ?? 0) + 1;
  const esgotou = tentativas >= MAX_TENTATIVAS;
  await ref.set(
    {
      status: "erro",
      erro: msg,
      tentativas,
      // Se ainda há retry possível, deixa rastro mas mantém status='erro' — o
      // re-enfileiramento é responsabilidade do nightly/usuário (sem re-create
      // dentro do trigger, que dispararia loop). `esgotou` é informativo.
      _esgotouRetries: esgotou,
      concluidoEm: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

// ── Trigger ──────────────────────────────────────────────────────────────────

export const onNexoTarefaCriada = onDocumentCreated(
  {
    document: "nexo_tarefas/{chave}",
    region: "us-central1",
    // Funcoes por EVENTO (onDocumentCreated) tem teto de 540s (HTTP vai a 3600).
    timeoutSeconds: 540,
    memory: "1GiB",
    // Uma tarefa por vez por instância evita martelar a rota; o gen2 escala
    // por doc, mas limitamos o paralelismo para não derrubar o App Hosting.
    maxInstances: 3,
    concurrency: 1,
    secrets: [BACKFILL_SECRET],
  },
  async (event) => {
    if (!event.data) return;
    const ref = event.data.ref;
    const chave = event.params.chave;
    const tarefa = event.data.data() as NexoTarefa;

    // Só processa o que nasce 'pendente' (a rule só permite create 'pendente').
    if (tarefa.status !== "pendente") {
      logger.debug("NEXO worker — tarefa não-pendente, ignorada", {
        chave,
        status: tarefa.status,
      });
      return;
    }
    if (!TIPOS_VALIDOS.has(tarefa.tipo)) {
      await marcarErro(ref, tarefa, `tipo inválido: ${String(tarefa.tipo)}`);
      return;
    }

    const secret = BACKFILL_SECRET.value();
    if (!secret) {
      logger.error("NEXO worker — DIARIO_BACKFILL_SECRET ausente");
      await marcarErro(ref, tarefa, "segredo DIARIO_BACKFILL_SECRET ausente");
      return;
    }

    // Circuit-breaker: se esta instância viu a rota `?compute=1` FORA há pouco
    // (503/429), não martelamos — adiamos a tarefa (sem queimar tentativa) e
    // saímos. O circuito fecha sozinho após CIRCUITO_JANELA_MS.
    if (circuitoAberto()) {
      logger.warn("NEXO worker — circuito aberto (dependência fora); adiando", {
        chave,
        tipo: tarefa.tipo,
      });
      await marcarPendentePorDependencia(
        ref,
        "compute indisponível (circuito aberto) — adiado, será re-disparado",
      );
      return;
    }

    // Marca processando (idempotente; o nightly/UI leem este estado).
    await ref.set(
      {
        status: "processando",
        iniciadoEm: admin.firestore.FieldValue.serverTimestamp(),
        progresso: 10,
        _versaoWorker: VERSAO_WORKER,
        erro: null,
      },
      { merge: true },
    );

    try {
      const firestoreToken = await obterTokenFirestore();
      const anterior = await lerUltimoSnapshot(chave);
      const res = await chamarCompute(tarefa, secret, firestoreToken);

      // Skip-recompile: se a entrada não mudou, reaproveita o snapshot anterior
      // (renova o TTL do doc da tarefa apontando para ele). Economiza Storage e
      // mantém a UI viva sem recomputar nada.
      if (anterior && anterior.hash && anterior.hash === res.hashEntrada) {
        const now = new Date();
        await db.collection("nexo_snapshots").doc(anterior.id).set(
          {
            expiraEm: admin.firestore.Timestamp.fromMillis(
              now.getTime() + TTL_SNAPSHOT_MS,
            ),
          },
          { merge: true },
        );
        await ref.set(
          {
            status: "pronto",
            snapshotId: anterior.id,
            progresso: 100,
            concluidoEm: admin.firestore.Timestamp.fromDate(now),
            expiraEm: admin.firestore.Timestamp.fromMillis(
              now.getTime() + TTL_SNAPSHOT_MS,
            ),
            reutilizouSnapshot: true,
          },
          { merge: true },
        );
        logger.info("NEXO worker — entrada inalterada, snapshot reutilizado", {
          chave,
          snapshotId: anterior.id,
        });
        return;
      }

      const delta = calcularDelta(res.payload, anterior?.payload ?? null);
      const geradoEm = new Date();
      const { snapshotId, tamanhoBytes } = await gravarSnapshot(
        chave,
        tarefa,
        res,
        delta,
        geradoEm,
      );

      await ref.set(
        {
          status: "pronto",
          snapshotId,
          progresso: 100,
          erro: null,
          concluidoEm: admin.firestore.Timestamp.fromDate(geradoEm),
          expiraEm: admin.firestore.Timestamp.fromMillis(
            geradoEm.getTime() + TTL_SNAPSHOT_MS,
          ),
          reutilizouSnapshot: false,
        },
        { merge: true },
      );

      logger.info("NEXO worker — snapshot pronto", {
        chave,
        snapshotId,
        tamanhoBytes,
        nDocsLidos: res.nDocsLidos,
        delta,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // DEPENDÊNCIA FORA (503/429/timeout da rota): não é falha da tarefa.
      // Abre o circuito (próximas tarefas desta instância pulam o fetch) e
      // ADIA esta tarefa sem queimar tentativa — em vez de reprocessar em loop
      // quente enquanto a IA/fonte está esgotada (P1-B).
      if (err instanceof DependenciaForaError) {
        abrirCircuito();
        logger.warn("NEXO worker — dependência fora, degradando (sem retry)", {
          chave,
          tipo: tarefa.tipo,
          alvo: tarefa.alvo,
          status: err.status,
          err: msg,
        });
        await marcarPendentePorDependencia(ref, msg);
        return;
      }
      logger.error("NEXO worker — falha ao processar tarefa", {
        chave,
        tipo: tarefa.tipo,
        alvo: tarefa.alvo,
        err: msg,
      });
      await marcarErro(ref, tarefa, msg);
    }
  },
);
