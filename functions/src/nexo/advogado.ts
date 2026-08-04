/**
 * Vertical ADVOGADO do NEXO — o "advogado" da fiscalização (cron a cada 6 horas).
 *
 * A cada ciclo: lê os alertas ABERTOS em `nexo_alertas` (status == 'aberta'),
 * manda-os ao endpoint `/api/nexo/advogado` da aplicação (que tem o Gemini) e
 * recebe, para cada alerta, um PARECER jurídico — enquadramento em norma
 * administrativa cogente (14.133/4.320/LRF/LAI, NUNCA afirmar improbidade),
 * checklist de aderência à norma e minuta de representação (TCE-SP art. 113, §1º
 * da LC 709/93, ou Notícia de Fato ao MP-SP). Persiste cada parecer em
 * `nexo_pareceres` (doc id = chaveDeteccao, merge) e grava observabilidade em
 * `nexo_sync_state` (doc `_advogado`).
 *
 * Self-contained: o projeto `functions/` NÃO importa de `src/`. O crivo jurídico
 * (e os invariantes — nunca afirmar 8.429, checklist em vez de "% de ilícito")
 * vive no flow Genkit, chamado via HTTP.
 *
 * Robustez: falha de leitura, do endpoint ou Gemini ausente é LOGADA e gravada
 * como sync DEGRADADO — a função NÃO cai. Os alertas são enviados em LOTES para
 * não estourar o tamanho do prompt nem o timeout do modelo; a falha de um lote
 * não impede os demais.
 *
 * CONTRATO (fixado com /api/nexo/advogado):
 *   Request  → POST `${APP_URL}/api/nexo/advogado`
 *              header `x-nexo-secret: <DIARIO_BACKFILL_SECRET>`
 *              body `{ alertas: [{ chaveDeteccao, detectorId, titulo, descricao,
 *                      classificacao, fundamentoLegal[], evidencias[] }] }`
 *   Response → `{ pareceres: [{ chaveDeteccao, enquadramento, normaPrincipal,
 *                  aderenciaNorma, minutaRepresentacao }] }`
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { resolverAppUrl } from "./app-url";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

/**
 * URL base da aplicação Next.js (App Hosting). `NEXO_APP_URL` com fallback ao
 * host REAL do App Hosting (`*.hosted.app`) — mesmo padrão de `deteccao.ts`/
 * `gerente.ts`. O fallback antigo `oficioexpress.web.app` é o Hosting legado
 * estático (404 em /api/*); o host hosted.app expõe `/api/nexo/advogado`.
 */
const APP_URL = resolverAppUrl();

/**
 * Timeout da chamada ao advogado (o flow Genkit chama o Gemini por lote).
 * 120s -> 300s (plano-mestre F1): o antigo era MENOR que o `maxDuration=300` da
 * rota, abortando o request antes de a rota terminar (257 falhas consecutivas,
 * "operation aborted"). Agora dá à rota a janela inteira.
 */
const ADVOGADO_TIMEOUT_MS = 300_000;

/**
 * Quantos alertas mandar por lote (limita tamanho do prompt e do timeout).
 * 6 -> 3 (plano-mestre F1): lotes menores cabem com folga na janela do modelo,
 * reduzindo o risco de abort por lote pesado.
 */
const LOTE = 3;

/**
 * Teto de alertas processados por ciclo — protege contra acúmulo inesperado.
 * 60 -> 30 (plano-mestre F1): com LOTE=3 e ADVOGADO_TIMEOUT_MS=300s, 30 alertas
 * = até 10 lotes sequenciais; isso cabe na janela `timeoutSeconds=540` da
 * function mesmo se alguns lotes forem lentos, sem estourar o cron. A fila é
 * drenada ao longo de vários ciclos (idempotente: pula quem já tem parecer).
 */
const MAX_ALERTAS_CICLO = 30;

/**
 * Reutiliza o segredo já provisionado (o mesmo do backfill do Diário) para
 * autenticar o cron junto ao endpoint (`x-nexo-secret`) — sem novo segredo.
 */
const BACKFILL_SECRET = defineSecret("DIARIO_BACKFILL_SECRET");

// ── Tipos do contrato ─────────────────────────────────────────────────────────

interface EvidenciaResumo {
  resumo: string;
  valor?: number;
  data?: string | null;
}

interface AlertaParaCrivo {
  chaveDeteccao: string;
  detectorId: string;
  titulo: string;
  descricao: string;
  classificacao: string;
  fundamentoLegal: string[];
  evidencias: EvidenciaResumo[];
}

interface Parecer {
  chaveDeteccao: string;
  enquadramento: string;
  normaPrincipal: string;
  aderenciaNorma: string;
  minutaRepresentacao: string;
}

// ── Coerções tolerantes ───────────────────────────────────────────────────────

function texto(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (v == null) return fallback;
  // O modelo às vezes devolve os campos de texto do parecer (aderenciaNorma
  // etc.) como array de checklist ou objeto — em vez de degradar para "" (que
  // apagava o parecer no lado function), stringifica preservando o conteúdo.
  if (Array.isArray(v)) {
    const linhas = v
      .map((item) => {
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const rot = String(
            o.elemento ?? o.item ?? o.requisito ?? o.texto ?? o.descricao ?? "",
          ).trim();
          return rot ? `- ${rot}` : `- ${JSON.stringify(o)}`;
        }
        return `- ${String(item).trim()}`;
      })
      .filter((l) => l !== "- ");
    return linhas.length ? linhas.join("\n") : fallback;
  }
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${typeof val === "object" ? JSON.stringify(val) : String(val)}`)
      .join("\n");
  }
  return String(v);
}
function numeroOpcional(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function listaTexto(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => texto(x)).filter((s) => s.length > 0);
}
/** Converte um Timestamp/string Firestore em ISO `yyyy-mm-dd` (ou null). */
function comoData(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v || null;
  if (typeof v === "object" && v !== null && "toDate" in v) {
    try {
      return (v as { toDate(): Date }).toDate().toISOString().slice(0, 10);
    } catch {
      return null;
    }
  }
  return null;
}

/** Mapeia uma evidência bruta do doc de alerta para o resumo enviado ao crivo. */
function comoEvidencia(raw: unknown): EvidenciaResumo {
  const e = (raw ?? {}) as Record<string, unknown>;
  return {
    resumo: texto(e.resumo),
    valor: numeroOpcional(e.valor),
    data: comoData(e.data),
  };
}

/**
 * Mapeia um doc de `nexo_alertas` para o alerta enviado ao advogado. Só os
 * campos que o crivo jurídico precisa — não vaza o doc inteiro.
 */
function paraAlerta(
  chaveDeteccao: string,
  doc: Record<string, unknown>,
): AlertaParaCrivo {
  const evidencias = Array.isArray(doc.evidencias) ? doc.evidencias : [];
  return {
    chaveDeteccao,
    detectorId: texto(doc.detectorId),
    titulo: texto(doc.titulo),
    descricao: texto(doc.descricao),
    classificacao: texto(doc.classificacao, "informativo"),
    fundamentoLegal: listaTexto(doc.fundamentoLegal),
    // Limita a 8 evidências por alerta — controla o tamanho do prompt.
    evidencias: evidencias.slice(0, 8).map(comoEvidencia),
  };
}

// ── Leitura ───────────────────────────────────────────────────────────────────

/**
 * Lê os alertas ABERTOS (status == 'aberta') que AINDA NÃO TÊM PARECER, do
 * maior valor envolvido para o menor. Doc id = chaveDeteccao (mesma chave de
 * `nexo_pareceres`). Teto de `MAX_ALERTAS_CICLO` por ciclo.
 *
 * IDEMPOTÊNCIA REAL (auditoria 2026-06-09): a versão antiga pegava sempre os
 * mesmos 60 primeiros docIds e re-gerava os mesmos pareceres no Gemini a cada
 * hora, para sempre (custo em loop + starvation dos demais 16 mil). Como a
 * `chaveDeteccao` é derivada do CONTEÚDO do alerta, "parecer já existe" é o
 * sinal completo de processado — alerta que mudar materialmente ganha chave
 * nova e volta à fila sozinho. A cada ciclo o cron avança pelos próximos N sem
 * parecer, em ordem de valor (proxy de prioridade), até cobrir a fila inteira.
 */
async function lerAlertasAbertos(): Promise<AlertaParaCrivo[]> {
  // 1. Projeção enxuta de TODOS os abertos (id + valor + ativo) — barato em
  // memória mesmo com dezenas de milhares (campos selecionados no servidor).
  const snap = await db
    .collection("nexo_alertas")
    .where("status", "==", "aberta")
    .select("valorEnvolvido", "ativo")
    .get();
  const candidatos = snap.docs
    .filter((d) => d.data().ativo !== false) // reconciliado → fora da fila
    .map((d) => ({
      id: d.id,
      valor:
        typeof d.data().valorEnvolvido === "number"
          ? (d.data().valorEnvolvido as number)
          : 0,
    }))
    .sort((a, b) => b.valor - a.valor);

  // 2. Caminha do maior valor para o menor pulando quem já tem parecer
  // (getAll em fatias de 300), até juntar MAX_ALERTAS_CICLO sem parecer.
  const col = db.collection("nexo_pareceres");
  const escolhidos: string[] = [];
  for (let i = 0; i < candidatos.length && escolhidos.length < MAX_ALERTAS_CICLO; i += 300) {
    const fatia = candidatos.slice(i, i + 300);
    const refs = fatia.map((c) => col.doc(c.id));
    const got = await db.getAll(...refs);
    for (let j = 0; j < fatia.length; j++) {
      if (got[j].exists) continue;
      escolhidos.push(fatia[j].id);
      if (escolhidos.length >= MAX_ALERTAS_CICLO) break;
    }
  }
  if (escolhidos.length === 0) return [];

  // 3. Busca o corpo completo SÓ dos escolhidos.
  const colAlertas = db.collection("nexo_alertas");
  const docs = await db.getAll(...escolhidos.map((id) => colAlertas.doc(id)));
  return docs
    .filter((d) => d.exists)
    .map((d) => {
      const data = d.data() as Record<string, unknown>;
      return paraAlerta(texto(data.chaveDeteccao) || d.id, data);
    });
}

// ── Chamada ao endpoint ───────────────────────────────────────────────────────

/**
 * IA esgotada (cota/spend cap/rate-limit) — a rota responde 503/429. Sinaliza
 * que NÃO adianta martelar os lotes seguintes do mesmo ciclo (a quota não
 * recompõe em segundos): o loop aborta e retoma no próximo ciclo.
 */
class IaEsgotadaError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
    this.name = "IaEsgotadaError";
  }
}

function ehIaEsgotada(msg: string): boolean {
  return /todos os provedores|resource_exhausted|quota|spending cap|rate.?limit|too many requests|\b429\b|esgotad/i.test(
    msg,
  );
}

/** Chama `/api/nexo/advogado` para UM lote. Lança em falha. */
async function chamarAdvogado(
  alertas: AlertaParaCrivo[],
  secret: string,
): Promise<Parecer[]> {
  const res = await fetch(`${APP_URL}/api/nexo/advogado`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexo-secret": secret,
    },
    body: JSON.stringify({ alertas }),
    signal: AbortSignal.timeout(ADVOGADO_TIMEOUT_MS),
  });
  if (!res.ok) {
    let corpo: { esgotado?: boolean; erro?: string } = {};
    try {
      corpo = (await res.json()) as typeof corpo;
    } catch {
      /* corpo não-JSON */
    }
    const msgErro = typeof corpo.erro === "string" ? corpo.erro : "";
    if (
      res.status === 503 ||
      res.status === 429 ||
      corpo.esgotado === true ||
      ehIaEsgotada(msgErro)
    ) {
      throw new IaEsgotadaError(
        res.status,
        `/api/nexo/advogado HTTP ${res.status} (IA esgotada${msgErro ? `: ${msgErro}` : ""})`,
      );
    }
    throw new Error(
      `/api/nexo/advogado HTTP ${res.status}${msgErro ? `: ${msgErro}` : ""}`,
    );
  }
  const json = (await res.json()) as { pareceres?: unknown };
  if (!Array.isArray(json.pareceres)) {
    throw new Error("/api/nexo/advogado devolveu resposta sem 'pareceres'");
  }
  return json.pareceres
    .map((p): Parecer | null => {
      const o = (p ?? {}) as Record<string, unknown>;
      const chave = texto(o.chaveDeteccao);
      if (!chave) return null;
      return {
        chaveDeteccao: chave,
        enquadramento: texto(o.enquadramento),
        normaPrincipal: texto(o.normaPrincipal),
        aderenciaNorma: texto(o.aderenciaNorma),
        minutaRepresentacao: texto(o.minutaRepresentacao),
      };
    })
    .filter((p): p is Parecer => p !== null);
}

// ── Persistência ──────────────────────────────────────────────────────────────

/**
 * Persiste os pareceres em `nexo_pareceres` — UM doc por achado (ID =
 * chaveDeteccao, igual ao alerta de origem), em merge. `geradoEm` é
 * serverTimestamp; reexecutar o cron ATUALIZA o parecer em vez de duplicar.
 */
async function persistirPareceres(pareceres: Parecer[]): Promise<number> {
  if (pareceres.length === 0) return 0;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const col = db.collection("nexo_pareceres");
  let batch = db.batch();
  let n = 0;
  for (const p of pareceres) {
    const { chaveDeteccao, ...corpo } = p;
    batch.set(
      col.doc(chaveDeteccao),
      { ...corpo, chaveDeteccao, geradoEm: now },
      { merge: true },
    );
    n++;
    if (n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
  return n;
}

/** Fatia uma lista em lotes de tamanho `tam`. */
function emLotes<T>(itens: T[], tam: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < itens.length; i += tam) out.push(itens.slice(i, i + tam));
  return out;
}

// ── Cron a cada 6 horas ───────────────────────────────────────────────────────

export const onNexoAdvogado = onSchedule(
  {
    // Cadência: 1h → 6h → 1×/dia (corte de custo 2026-07). Cada ciclo lê alertas
    // e chama a IA (tokens) + reads; 1×/dia drena a fila de pareceres com folga
    // (cada ciclo cobre até MAX_ALERTAS_CICLO). Roda 09:30, após o gerente (09:00).
    schedule: "30 9 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    // No máximo UMA execução simultânea — evita dois crivos concorrentes sobre
    // os mesmos alertas (a escrita por chaveDeteccao é idempotente, mas isto
    // poupa chamadas duplicadas ao modelo).
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: a escrita por chaveDeteccao usa
    // merge, então reexecutar após uma falha é seguro. Campos flatten no nível
    // de ScheduleOptions (firebase-functions v5) — mesmo formato de coleta.ts.
    retryCount: 2,
    maxRetrySeconds: 600,
    minBackoffSeconds: 30,
    maxBackoffSeconds: 120,
    maxDoublings: 2,
    secrets: [BACKFILL_SECRET],
  },
  async () => {
    const inicio = Date.now();
    const secret = BACKFILL_SECRET.value();

    // Sem segredo → não dá para chamar o endpoint. Loga e grava DEGRADADO.
    if (!secret) {
      logger.error(
        "NEXO advogado — segredo DIARIO_BACKFILL_SECRET ausente; ciclo pulado.",
      );
      await gravarSyncState({
        syncId: "_advogado",
        fonte: "advogado",
        colecao: "nexo_pareceres",
        cadencia: "6h",
        sucesso: true,
        degradado: true,
        erro: "segredo DIARIO_BACKFILL_SECRET ausente",
        duracaoMs: Date.now() - inicio,
      });
      return;
    }

    // 1. Lê os alertas abertos.
    let alertas: AlertaParaCrivo[] = [];
    try {
      alertas = await lerAlertasAbertos();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO advogado — falha lendo nexo_alertas abertos", err);
      await gravarSyncState({
        syncId: "_advogado",
        fonte: "advogado",
        colecao: "nexo_pareceres",
        cadencia: "6h",
        sucesso: false,
        erro: msg,
        duracaoMs: Date.now() - inicio,
      });
      return;
    }

    // Nada aberto → sucesso limpo, nada a fazer (não chama o modelo à toa).
    if (alertas.length === 0) {
      logger.info("NEXO advogado — nenhum alerta aberto; ciclo encerrado.");
      await gravarSyncState({
        syncId: "_advogado",
        fonte: "advogado",
        colecao: "nexo_pareceres",
        cadencia: "6h",
        sucesso: true,
        erro: null,
        duracaoMs: Date.now() - inicio,
        extra: { alertas: 0, pareceres: 0, lotesComErro: 0 },
      });
      return;
    }

    logger.info(
      `NEXO advogado — ${alertas.length} alertas abertos; aplicando o crivo ` +
        `em lotes de ${LOTE}...`,
    );

    // 2. Processa em lotes — cada lote é isolado (a falha de um não derruba os
    // demais). Persiste o parecer de cada lote assim que volta.
    const lotes = emLotes(alertas, LOTE);
    let totalPareceres = 0;
    let lotesComErro = 0;
    let ultimoErro: string | null = null;

    let iaEsgotada = false;
    for (let i = 0; i < lotes.length; i++) {
      const lote = lotes[i];
      try {
        const pareceres = await chamarAdvogado(lote, secret);
        const gravados = await persistirPareceres(pareceres);
        totalPareceres += gravados;
        logger.info(
          `NEXO advogado — lote ${i + 1}/${lotes.length}: ` +
            `${gravados} pareceres gravados (${lote.length} alertas).`,
        );
      } catch (err) {
        if (err instanceof IaEsgotadaError) {
          // Quota/spend cap não recompõe em segundos: aborta o ciclo (a fila é
          // idempotente — os lotes restantes voltam no próximo ciclo).
          iaEsgotada = true;
          ultimoErro = err.message;
          logger.warn(
            `NEXO advogado — IA esgotada (HTTP ${err.status}) no lote ` +
              `${i + 1}/${lotes.length}; ciclo interrompido (respeita Retry-After; ` +
              `${lotes.length - i - 1} lote(s) p/ o próximo ciclo).`,
          );
          break;
        }
        lotesComErro++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.error(
          `NEXO advogado — falha no lote ${i + 1}/${lotes.length} ` +
            `(demais lotes preservados)`,
          err,
        );
      }
    }

    // 3. Observabilidade. Sucesso se ALGUM parecer saiu; degradado se houve
    // qualquer lote com erro. Falha total (nenhum parecer + todos os lotes
    // falharam) marca sync como falha honesta.
    const todosFalharam = lotesComErro === lotes.length;
    await gravarSyncState({
      syncId: "_advogado",
      fonte: "advogado",
      colecao: "nexo_pareceres",
      cadencia: "6h",
      // IA esgotada é DEGRADADO, não falha dura: a fila é idempotente e retoma
      // no próximo ciclo respeitando o Retry-After.
      sucesso: !todosFalharam,
      degradado: (lotesComErro > 0 && !todosFalharam) || iaEsgotada,
      erro: iaEsgotada
        ? `IA esgotada — ciclo interrompido (Retry-After)${ultimoErro ? `: ${ultimoErro}` : ""}`
        : lotesComErro > 0
          ? `${lotesComErro}/${lotes.length} lote(s) com erro` +
            (ultimoErro ? `: ${ultimoErro}` : "")
          : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        alertas: alertas.length,
        pareceres: totalPareceres,
        lotes: lotes.length,
        lotesComErro,
        iaEsgotada,
      },
    });

    logger.info(
      `NEXO advogado — ciclo concluído: ${totalPareceres} pareceres gravados, ` +
        `${lotesComErro}/${lotes.length} lotes com erro.`,
    );
  },
);
