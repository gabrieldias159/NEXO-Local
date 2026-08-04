/**
 * Ciclo de detecção pré-computada do NEXO (Fase 2 do plano-mestre).
 *
 * Roda APÓS a ingestão diária (`onNexoColetaDiaria`). Para cada exercício
 * monitorado:
 *   1. lê os registros brutos das coleções `nexo_*` de execução orçamentária;
 *   2. envia-os ao endpoint `/api/nexo/detectar` da aplicação Next.js, que
 *      executa os detectores e devolve os alertas com `chaveDeteccao` estável;
 *   3. faz upsert determinístico em `nexo_alertas` (doc ID = `chaveDeteccao`);
 *   4. reconcilia: alertas que sumiram do snapshot atual viram `ativo: false`.
 *
 * Self-contained: o projeto `functions/` não importa de `src/lib/nexo/`. O
 * trabalho pesado dos detectores roda na aplicação (que JÁ tem o motor); aqui
 * só orquestramos a chamada HTTP e a persistência.
 *
 * PERFIL DE MEMÓRIA (fix do OOM): este cron NÃO mais lê os brutos nem os envia
 * no body. O contrato antigo ("manda o exercício inteiro no POST") empurrava
 * dezenas de MB de registros gordos (empenhos+despesas+cross-sources inteiras)
 * para a rota, que mantinha VIVOS ao mesmo tempo o body cru + o grafo do
 * JSON.parse + as cópias normalizadas — pico triplo que estourava o heap V8 da
 * rota mesmo a 4 GiB. Agora a rota LÊ ela mesma do Firestore (mesmo caminho de
 * `/api/nexo/analise`, comprovadamente dentro de 4 GiB), e este cron só manda
 * `{ exercicio }` + um access token de serviço para a rota autenticar a leitura
 * REST do Firestore (a rota não tem `firebase-admin`).
 *
 * CONTRATO (fixado):
 *   Request  → POST `${APP_URL}/api/nexo/detectar`
 *              header `x-nexo-secret: <DIARIO_BACKFILL_SECRET>`
 *              header `x-nexo-firestore-token: <OAuth2 access token de serviço>`
 *              body `{ exercicio }`
 *   Response → `{ exercicio, total, alertas: Array<AlertaDetectado &
 *                 { chaveDeteccao: string }> }`  (INALTERADO)
 *
 * Falha da detecção é LOGADA mas não derruba o cron de coleta.
 */
import * as logger from "firebase-functions/logger";
import { admin, db } from "../shared/admin";
import { resolverAppUrl } from "./app-url";

/**
 * URL base da aplicação Next.js (App Hosting). Lida de `process.env.NEXO_APP_URL`
 * com fallback para o host REAL do App Hosting (`*.hosted.app`). O fallback
 * antigo `oficioexpress.web.app` é o Hosting legado estático (404 em /api/*);
 * o host hosted.app expõe `/api/nexo/detectar`. Configure `NEXO_APP_URL` no
 * deploy das functions caso o domínio mude.
 */
const APP_URL = resolverAppUrl();

/**
 * Timeout da chamada de detecção — a rota lê o exercício inteiro do Firestore e
 * varre ~67 detectores. 600s: o exercício 2025 (43k empenhos + 27k despesas +
 * NDJSON de ~40MB) estourava os 180s antigos (TimeoutError em prod,
 * 2026-06-10); o teto real da rota é o timeoutSeconds=1800 do App Hosting
 * (`maxDuration` do Next é no-op fora da Vercel) e o cron tem 1800s no total —
 * 600s por exercício cabe com folga após a ingestão.
 */
const DETECCAO_TIMEOUT_MS = 600_000;

/**
 * Escopos OAuth2 necessários para a rota ler `nexo_*` via REST do Firestore com
 * o token de serviço (datastore = Firestore; cloud-platform como guarda-chuva).
 */
const TOKEN_SCOPES = [
  "https://www.googleapis.com/auth/datastore",
  "https://www.googleapis.com/auth/cloud-platform",
];

/** Alerta como devolvido pelo endpoint — o detector + a chave determinística. */
interface AlertaComChave {
  chaveDeteccao: string;
  [campo: string]: unknown;
}

interface RespostaDeteccao {
  exercicio: number;
  total: number;
  alertas: AlertaComChave[];
}

/** Resumo de um ciclo de detecção de exercício. */
export interface ResultadoDeteccao {
  exercicio: number;
  /** Alertas retornados pelo detector nesta execução. */
  detectados: number;
  /** Documentos de alerta gravados/atualizados em `nexo_alertas`. */
  persistidos: number;
  /** Alertas antes ativos que sumiram do snapshot → marcados `ativo: false`. */
  resolvidos: number;
  /** Mensagem de erro honesta, ou null. */
  erro: string | null;
}

/**
 * Mina um access token OAuth2 de serviço (a credencial do ambiente das
 * functions — ADC do projeto) para a rota `/api/nexo/detectar` AUTENTICAR a
 * leitura REST das coleções `nexo_*` no Firestore. A rota não tem
 * `firebase-admin`; ela usa este token exatamente como `/api/nexo/analise` usa
 * o ID token do usuário (REST `:runQuery` aceita tanto ID token Firebase quanto
 * access token de serviço). O token é de vida curta e fica só no header.
 */
async function obterTokenFirestore(): Promise<string> {
  const credential = admin.app().options.credential;
  if (!credential || typeof credential.getAccessToken !== "function") {
    throw new Error(
      "credencial admin indisponível para obter access token de leitura",
    );
  }
  // `getAccessToken()` da credencial ADC já devolve um token com escopo de
  // Cloud Platform (inclui Firestore/datastore). TOKEN_SCOPES documenta a
  // intenção; a credencial padrão não permite re-escopar, então confiamos no
  // escopo amplo do ambiente das functions.
  void TOKEN_SCOPES;
  const { access_token: token } = await credential.getAccessToken();
  if (!token) {
    throw new Error("access token de leitura vazio");
  }
  return token;
}

/**
 * Chama o endpoint `/api/nexo/detectar` da aplicação. Lança em falha.
 *
 * Body MÍNIMO `{ exercicio }`: a rota lê os brutos do Firestore ela mesma (sem
 * o payload HTTP gigante que causava OOM). O access token de serviço vai no
 * header `x-nexo-firestore-token` para a rota autenticar essa leitura.
 */
async function chamarDetector(
  exercicio: number,
  secret: string,
  firestoreToken: string,
): Promise<RespostaDeteccao> {
  // Pede NDJSON em streaming: a resposta JSON única de 2025 passou de 32 MiB —
  // o teto de resposta NÃO-streamada do Cloud Run — e chegava truncada (o
  // JSON.parse morria com "Bad control character" a ~33 MB; visto em prod em
  // 2026-06-09). Rota antiga (pré-deploy do app) ignora o query param e
  // devolve JSON único — o fallback abaixo mantém compatibilidade.
  const res = await fetch(`${APP_URL}/api/nexo/detectar?formato=ndjson`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexo-secret": secret,
      "x-nexo-firestore-token": firestoreToken,
    },
    body: JSON.stringify({ exercicio }),
    signal: AbortSignal.timeout(DETECCAO_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `/api/nexo/detectar HTTP ${res.status} para exercício ${exercicio}`,
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("ndjson")) {
    return lerRespostaNdjson(res, exercicio);
  }
  const json = (await res.json()) as Partial<RespostaDeteccao>;
  if (!Array.isArray(json.alertas)) {
    throw new Error(
      `/api/nexo/detectar devolveu resposta sem 'alertas' (exercício ${exercicio})`,
    );
  }
  return {
    exercicio: json.exercicio ?? exercicio,
    total: json.total ?? json.alertas.length,
    alertas: json.alertas,
  };
}

/**
 * Lê a resposta NDJSON em streaming: 1ª linha `{exercicio,total}`, depois um
 * alerta por linha. Parse incremental — nenhum buffer com o corpo inteiro.
 */
async function lerRespostaNdjson(
  res: Response,
  exercicio: number,
): Promise<RespostaDeteccao> {
  if (!res.body) {
    throw new Error(
      `/api/nexo/detectar sem corpo na resposta NDJSON (exercício ${exercicio})`,
    );
  }
  const alertas: RespostaDeteccao["alertas"] = [];
  let meta: { exercicio?: number; total?: number } | null = null;
  const decoder = new TextDecoder();
  let buffer = "";
  const consumir = (linha: string) => {
    const l = linha.trim();
    if (!l) return;
    const obj = JSON.parse(l) as Record<string, unknown>;
    if (meta === null) {
      meta = obj as { exercicio?: number; total?: number };
    } else {
      alertas.push(obj as RespostaDeteccao["alertas"][number]);
    }
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      consumir(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  consumir(buffer + decoder.decode());
  if (meta === null) {
    throw new Error(
      `/api/nexo/detectar devolveu NDJSON vazio (exercício ${exercicio})`,
    );
  }
  const cab = meta as { exercicio?: number; total?: number };
  // Cabeçalho traz o total esperado — divergência = stream truncado no meio.
  if (typeof cab.total === "number" && cab.total !== alertas.length) {
    throw new Error(
      `/api/nexo/detectar NDJSON truncado: esperava ${cab.total} alertas, ` +
        `recebeu ${alertas.length} (exercício ${exercicio})`,
    );
  }
  return {
    exercicio: cab.exercicio ?? exercicio,
    total: cab.total ?? alertas.length,
    alertas,
  };
}

/**
 * Persiste os alertas de um exercício em `nexo_alertas` e reconcilia os que
 * sumiram. Cada alerta vira um doc com ID = `chaveDeteccao`:
 *   - `primeiraDeteccaoEm` — set-once (só no doc novo);
 *   - `ultimaDeteccaoEm`   — serverTimestamp, sempre;
 *   - `ocorrencias`        — FieldValue.increment(1);
 *   - `ativo: true`, `resolvidoEm: null`;
 *   - `status`             — NUNCA tocado pelo cron (preserva marcação humana);
 *                            no doc novo nasce `'aberta'`.
 * Reconciliação: alertas antes `ativo==true` e ausentes deste snapshot →
 * `set(merge)` com `ativo:false, resolvidoEm: serverTimestamp()`. Sem delete.
 */
async function persistirAlertas(
  exercicio: number,
  alertas: AlertaComChave[],
): Promise<{ persistidos: number; resolvidos: number }> {
  const inc = admin.firestore.FieldValue.increment(1);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const col = db.collection("nexo_alertas");

  // Deduplica por chaveDeteccao — duas linhas com a mesma chave são o mesmo
  // episódio; fica a última (evita escrita dupla no mesmo lote).
  const porChave = new Map<string, AlertaComChave>();
  for (const a of alertas) {
    const chave = String(a.chaveDeteccao ?? "").trim();
    if (!chave) continue;
    porChave.set(chave, a);
  }
  const chavesAtuais = new Set(porChave.keys());

  // Lê em lote quais chaves já existem — `primeiraDeteccaoEm` é set-once.
  const refs = [...chavesAtuais].map((c) => col.doc(c));
  const existentes = new Set<string>();
  for (let i = 0; i < refs.length; i += 300) {
    const fatia = refs.slice(i, i + 300);
    if (fatia.length === 0) break;
    const snaps = await db.getAll(...fatia);
    for (const s of snaps) if (s.exists) existentes.add(s.id);
  }

  // Reconciliação: IDs hoje ativos para o exercício que NÃO estão no snapshot.
  const ativosSnap = await col
    .where("exercicio", "==", exercicio)
    .where("ativo", "==", true)
    .get();
  const aResolver = ativosSnap.docs
    .map((d) => d.id)
    .filter((id) => !chavesAtuais.has(id));

  let batch = db.batch();
  let ops = 0;
  let persistidos = 0;
  let resolvidos = 0;

  const flush = async () => {
    if (ops > 0) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  for (const [chave, alerta] of porChave) {
    // Remove a própria chave do corpo para não duplicar; reanexa explícita.
    const { chaveDeteccao: _omit, ...corpo } = alerta;
    void _omit;
    const doc: Record<string, unknown> = {
      ...corpo,
      exercicio,
      // Espelho `_exercicio` (convenção `_*`): o painel lê via lerColecaoNexo,
      // que filtra por `_exercicio`. Sem este espelho a leitura por exercício
      // voltava VAZIA (o painel mostrava "monitor não rodou" mesmo com milhares
      // de indícios já pré-computados sob `exercicio`).
      _exercicio: exercicio,
      chaveDeteccao: chave,
      ultimaDeteccaoEm: now,
      ocorrencias: inc,
      ativo: true,
      resolvidoEm: null,
    };
    // Set-once: só grava `primeiraDeteccaoEm` e `status` quando o doc é novo —
    // assim o cron nunca sobrescreve o status que um humano marcou.
    if (!existentes.has(chave)) {
      doc.primeiraDeteccaoEm = now;
      doc.status = "aberta";
    }
    batch.set(col.doc(chave), doc, { merge: true });
    persistidos++;
    ops++;
    if (ops >= 400) await flush();
  }

  for (const id of aResolver) {
    batch.set(
      col.doc(id),
      { ativo: false, resolvidoEm: now },
      { merge: true },
    );
    resolvidos++;
    ops++;
    if (ops >= 400) await flush();
  }

  await flush();
  return { persistidos, resolvidos };
}

/**
 * Executa o ciclo de detecção para um conjunto de exercícios. Cada exercício é
 * isolado — a falha de um não derruba os demais. NUNCA lança: erros são
 * capturados e devolvidos em `ResultadoDeteccao.erro` (o cron de coleta não
 * pode cair por causa da detecção).
 */
export async function rodarDeteccao(
  exercicios: number[],
  secret: string,
): Promise<ResultadoDeteccao[]> {
  const resultados: ResultadoDeteccao[] = [];

  if (!secret) {
    logger.error(
      "NEXO — detecção pulada: segredo DIARIO_BACKFILL_SECRET ausente.",
    );
    return exercicios.map((exercicio) => ({
      exercicio,
      detectados: 0,
      persistidos: 0,
      resolvidos: 0,
      erro: "segredo DIARIO_BACKFILL_SECRET ausente",
    }));
  }

  // Access token de serviço — UMA vez por ciclo (vida curta, mas a rota
  // re-autentica a cada chamada com este mesmo token; o ciclo dura segundos).
  let firestoreToken: string;
  try {
    firestoreToken = await obterTokenFirestore();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`NEXO — detecção pulada: falha ao obter access token (${msg}).`);
    return exercicios.map((exercicio) => ({
      exercicio,
      detectados: 0,
      persistidos: 0,
      resolvidos: 0,
      erro: `access token de leitura indisponível: ${msg}`,
    }));
  }

  for (const exercicio of exercicios) {
    const base: ResultadoDeteccao = {
      exercicio,
      detectados: 0,
      persistidos: 0,
      resolvidos: 0,
      erro: null,
    };
    try {
      // Guard barato: count aggregation em `nexo_empenhos` — não LÊ os docs
      // (sem custo de memória), só checa se há algo a detectar no exercício. A
      // rota lê os brutos ela mesma; aqui só evitamos uma chamada HTTP inútil.
      const cnt = await db
        .collection("nexo_empenhos")
        .where("_exercicio", "==", exercicio)
        .count()
        .get();
      if (cnt.data().count === 0) {
        logger.info(
          `NEXO — detecção ${exercicio}: nenhum empenho ingerido, pulada.`,
        );
        resultados.push(base);
        continue;
      }

      const resp = await chamarDetector(exercicio, secret, firestoreToken);
      base.detectados = resp.alertas.length;

      const { persistidos, resolvidos } = await persistirAlertas(
        exercicio,
        resp.alertas,
      );
      base.persistidos = persistidos;
      base.resolvidos = resolvidos;

      logger.info(
        `NEXO — detecção ${exercicio}: ${base.detectados} alertas detectados, ` +
          `${persistidos} persistidos, ${resolvidos} reconciliados (inativados).`,
      );
    } catch (err) {
      base.erro = err instanceof Error ? err.message : String(err);
      logger.error(`NEXO — falha na detecção do exercício ${exercicio}`, err);
    }
    resultados.push(base);
  }

  return resultados;
}
