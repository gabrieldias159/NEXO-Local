/**
 * Vertical GERENTE do NEXO — o "gerente de fiscalização" (cron 1x/dia).
 *
 * Uma vez por dia: olha o estado atual do NEXO — os alertas ATIVOS top-
 * priorizados em `nexo_alertas` + a saúde das fontes em `nexo_sync_state` —, manda
 * esse retrato para o endpoint `/api/nexo/gerente` da aplicação (que tem o Gemini)
 * e recebe um BRIEFING de gestão. Persiste o briefing em `nexo_briefings` (um doc
 * por ciclo, com `geradoEm` serverTimestamp) e grava observabilidade em
 * `nexo_sync_state` (doc `_gerente`).
 *
 * Self-contained: o projeto `functions/` NÃO importa de `src/`. O score de
 * priorização usado para escolher os top-N alertas é re-implementado aqui (versão
 * simples da média geométrica do `src/lib/nexo/prioridade.ts`).
 *
 * Robustez: falha de leitura, do endpoint ou Gemini ausente é LOGADA e gravada
 * como sync DEGRADADO — a função NÃO cai (cron de gestão não pode derrubar nada).
 *
 * CONTRATO (fixado com /api/nexo/gerente):
 *   Request  → POST `${APP_URL}/api/nexo/gerente`
 *              header `x-nexo-secret: <DIARIO_BACKFILL_SECRET>`
 *              body `{ alertas: [...], fontes: [...] }`
 *   Response → `{ briefing: { resumo, topPrioridades, fontesDegradadas, proximaAcao } }`
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { resolverAppUrl } from "./app-url";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

/**
 * URL base da aplicação Next.js (App Hosting). `NEXO_APP_URL` com fallback ao
 * host REAL do App Hosting (`*.hosted.app`) — mesmo padrão de `deteccao.ts`.
 *
 * O fallback antigo `oficioexpress.web.app` é o Hosting legado estático (404 em
 * /api/*) e era a raiz do gerente HTTP 404 / briefings=0 (plano-mestre §1.1). O
 * host hosted.app expõe `/api/nexo/gerente` de verdade.
 */
const APP_URL = resolverAppUrl();

/** Timeout da chamada ao gerente (o flow Genkit chama o Gemini). */
const GERENTE_TIMEOUT_MS = 90_000;

/** Quantos alertas top-priorizados enviar ao gerente. */
const TOP_ALERTAS = 12;

/**
 * Teto de alertas ATIVOS lidos para ranquear em memória. Os alertas ativos podem
 * passar de 60 mil (plano-mestre §1.1: OOM a 512 MiB porque `lerTopAlertas` fazia
 * `.where(ativo==true).get()` SEM `.select()`/`limit`, trazendo docs gordos só
 * para `.slice(0,12)`). Com `.select()` dos campos do score + este `limit`, a
 * leitura fica enxuta e limitada. Sem `orderBy` no servidor (evita exigir índice
 * composto novo, território da Frente E): o `.select()` deixa cada doc minúsculo,
 * então mesmo ler até este teto cabe folgado em memória; o ranqueamento fino por
 * score acontece em memória sobre a amostra. */
const MAX_ALERTAS_LIDOS = 2_000;

/**
 * Reutiliza o segredo já provisionado (o mesmo do backfill do Diário) para
 * autenticar o cron junto ao endpoint (`x-nexo-secret`) — sem novo segredo.
 */
const BACKFILL_SECRET = defineSecret("DIARIO_BACKFILL_SECRET");

// ── Score de priorização (re-implementação simples, self-contained) ──────────

/** Peso por severidade — domina a ordenação (crítico antes de tudo). */
const PESO_CLASSIFICACAO: Record<string, number> = {
  critico: 4,
  suspeita: 3,
  atencao: 2,
  informativo: 1,
};

interface AlertaResumo {
  detectorId: string;
  titulo: string;
  classificacao: string;
  valorEnvolvido: number;
  scores: {
    confiabilidade?: number;
    probabilidadeIrregularidade?: number;
    probabilidadeEnquadramento?: number;
  };
  ultimaDeteccaoEm: string | null;
}

/**
 * Score de prioridade simples (0..~400). Severidade pesa primeiro; em empate,
 * a média geométrica das 3 pernas do score triplo (penaliza qualquer perna
 * fraca, default 50 na 3ª ausente) afina o ranking. Espelha a intenção do
 * `scorePrioridade` da aplicação, sem importar de `src/`.
 */
function scorePrioridade(a: AlertaResumo): number {
  const sev = PESO_CLASSIFICACAO[a.classificacao] ?? 1;
  const s = a.scores ?? {};
  const c = Math.max(0, (s.confiabilidade ?? 0) / 100);
  const pi = Math.max(0, (s.probabilidadeIrregularidade ?? 0) / 100);
  const pe = Math.max(0, (s.probabilidadeEnquadramento ?? 50) / 100);
  const triplo = Math.cbrt(c * pi * pe) * 100; // 0..100
  return sev * 100 + triplo;
}

function texto(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function numero(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function numeroOpcional(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Converte um Timestamp/string Firestore em ISO (ou null). */
function comoIso(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v || null;
  // Firestore Timestamp.
  if (typeof v === "object" && v !== null && "toDate" in v) {
    try {
      return (v as { toDate(): Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

/** Mapeia um doc de `nexo_alertas` para o resumo enviado ao gerente. */
function paraAlertaResumo(doc: Record<string, unknown>): AlertaResumo {
  const scores = (doc.scores ?? {}) as Record<string, unknown>;
  return {
    detectorId: texto(doc.detectorId),
    titulo: texto(doc.titulo),
    classificacao: texto(doc.classificacao, "informativo"),
    valorEnvolvido: numero(doc.valorEnvolvido),
    scores: {
      confiabilidade: numeroOpcional(scores.confiabilidade),
      probabilidadeIrregularidade: numeroOpcional(
        scores.probabilidadeIrregularidade,
      ),
      probabilidadeEnquadramento: numeroOpcional(
        scores.probabilidadeEnquadramento,
      ),
    },
    ultimaDeteccaoEm: comoIso(doc.ultimaDeteccaoEm ?? doc.detectadoEm),
  };
}

interface FonteResumo {
  fonte: string;
  statusSaude: string;
  erro: string | null;
}

/** Disclaimer canônico do NEXO — espelha src/lib/nexo/constants.ts. Garante que
 * o doc persistido carregue o aviso mesmo se o endpoint o omitir. */
const NEXO_DISCLAIMER =
  "Este sistema processa dados públicos e identifica padrões estatisticamente " +
  "atípicos que podem (ou não) indicar irregularidades. Nenhuma informação " +
  "aqui constitui acusação, prova de improbidade ou de ilícito. Os indícios " +
  "devem ser investigados pelas instituições competentes (TCE-SP, Ministério " +
  "Público, Controladoria) antes de qualquer juízo de valor.";

/** Briefing devolvido pelo endpoint /api/nexo/gerente. */
interface Briefing {
  resumo: string;
  topPrioridades: { titulo: string; porque: string }[];
  fontesDegradadas: string[];
  proximaAcao: string;
  disclaimer: string;
}

/**
 * Lê os alertas ATIVOS, escolhe os TOP por score de prioridade. Não usa
 * `orderBy` no Firestore (evita exigir índice composto): filtra por `ativo` e
 * ordena em memória — o volume de alertas ativos é pequeno.
 */
async function lerTopAlertas(): Promise<AlertaResumo[]> {
  const snap = await db
    .collection("nexo_alertas")
    .where("ativo", "==", true)
    // Projeção enxuta — só os campos do score/resumo (não traz o doc gordo).
    // Esta linha é o fix do OOM: sem `.select()` os ~60k docs ativos inteiros
    // vinham para a memória só para escolher 12.
    .select(
      "detectorId",
      "titulo",
      "classificacao",
      "valorEnvolvido",
      "scores",
      "ultimaDeteccaoEm",
      "detectadoEm",
    )
    // Teto rígido de leitura — limita o pico de memória mesmo em explosão de
    // alertas (sem `orderBy` para não exigir índice composto novo).
    .limit(MAX_ALERTAS_LIDOS)
    .get();
  const alertas = snap.docs.map((d) => paraAlertaResumo(d.data()));
  alertas.sort((a, b) => {
    const d = scorePrioridade(b) - scorePrioridade(a);
    if (Math.abs(d) > 1e-9) return d;
    // Desempate: mais recente, depois maior valor.
    const ra = a.ultimaDeteccaoEm ?? "";
    const rb = b.ultimaDeteccaoEm ?? "";
    if (ra !== rb) return rb.localeCompare(ra);
    return b.valorEnvolvido - a.valorEnvolvido;
  });
  return alertas.slice(0, TOP_ALERTAS);
}

/** Lê o estado de saúde de cada fonte de coleta em `nexo_sync_state`. */
async function lerFontes(): Promise<FonteResumo[]> {
  const snap = await db.collection("nexo_sync_state").get();
  const fontes: FonteResumo[] = [];
  for (const d of snap.docs) {
    // Não inclui o próprio doc de observabilidade do gerente.
    if (d.id === "_gerente") continue;
    const data = d.data();
    fontes.push({
      fonte: texto(data.fonte, d.id),
      statusSaude: texto(data.statusSaude, "ok"),
      erro: texto(data.erro) || null,
    });
  }
  return fontes;
}

/** Chama `/api/nexo/gerente` e devolve o briefing. Lança em falha. */
async function chamarGerente(
  alertas: AlertaResumo[],
  fontes: FonteResumo[],
  secret: string,
): Promise<Briefing> {
  const res = await fetch(`${APP_URL}/api/nexo/gerente`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexo-secret": secret,
    },
    body: JSON.stringify({ alertas, fontes }),
    signal: AbortSignal.timeout(GERENTE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`/api/nexo/gerente HTTP ${res.status}`);
  }
  const json = (await res.json()) as { briefing?: Partial<Briefing> };
  const b = json.briefing;
  if (!b || typeof b.resumo !== "string") {
    throw new Error("/api/nexo/gerente devolveu resposta sem 'briefing'");
  }
  return {
    resumo: b.resumo,
    topPrioridades: Array.isArray(b.topPrioridades) ? b.topPrioridades : [],
    fontesDegradadas: Array.isArray(b.fontesDegradadas)
      ? b.fontesDegradadas
      : [],
    proximaAcao: typeof b.proximaAcao === "string" ? b.proximaAcao : "",
    // Disclaimer é obrigatório no NEXO: usa o do endpoint se vier, senão o
    // canônico local — o doc persistido NUNCA fica sem o aviso.
    disclaimer:
      typeof b.disclaimer === "string" && b.disclaimer.length > 0
        ? b.disclaimer
        : NEXO_DISCLAIMER,
  };
}

/**
 * Persiste o briefing em `nexo_briefings` — um doc por ciclo (ID = carimbo do
 * ciclo, ordenável). `geradoEm` é serverTimestamp.
 */
async function persistirBriefing(
  briefing: Briefing,
  contagem: { alertas: number; fontes: number; fontesDegradadas: number },
): Promise<string> {
  const now = new Date();
  // ID por ciclo: `yyyymmddThhmm` (BRT-agnóstico, em UTC) — ordenável e estável.
  // Para a cadência diária basta a data, mas manter hh:mm preserva a
  // idempotência se um retry do Scheduler cair no mesmo minuto.
  const ciclo = now.toISOString().slice(0, 16).replace(/[-:]/g, "");
  const ref = db.collection("nexo_briefings").doc(ciclo);
  await ref.set(
    {
      ...briefing,
      ...contagem,
      geradoEm: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return ciclo;
}

// ── Cron 1x/dia ───────────────────────────────────────────────────────────────

export const onNexoGerente = onSchedule(
  {
    // Cadência cortada de 30min para 1x/dia (plano-mestre F1): o briefing de
    // gestão não precisa de mais que um retrato diário, e a cada chamada gasta
    // Gemini — 48 ciclos/dia sangrava o modelo à toa. 09:00 BRT, após a janela
    // de ingestão/detecção noturna, para refletir o estado mais fresco.
    schedule: "0 9 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 300,
    // 512->1024 MiB: a leitura de alertas, mesmo projetada e limitada, mais o
    // briefing do modelo cabem com folga; elimina o `Memory limit exceeded`.
    memory: "1GiB",
    // No máximo UMA execução simultânea — evita dois briefings concorrentes.
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: o doc por ciclo usa merge, então
    // reexecutar após uma falha é seguro. Opções no formato flat aceito pelo
    // onSchedule v2 (mesmo padrão das demais functions NEXO).
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
        "NEXO gerente — segredo DIARIO_BACKFILL_SECRET ausente; ciclo pulado.",
      );
      await gravarSyncState({
        syncId: "_gerente",
        fonte: "gerente",
        colecao: "nexo_briefings",
        cadencia: "diario",
        sucesso: true,
        degradado: true,
        erro: "segredo DIARIO_BACKFILL_SECRET ausente",
        duracaoMs: Date.now() - inicio,
      });
      return;
    }

    let alertas: AlertaResumo[] = [];
    let fontes: FonteResumo[] = [];
    try {
      [alertas, fontes] = await Promise.all([lerTopAlertas(), lerFontes()]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO gerente — falha lendo estado do NEXO", err);
      await gravarSyncState({
        syncId: "_gerente",
        fonte: "gerente",
        colecao: "nexo_briefings",
        cadencia: "diario",
        sucesso: false,
        erro: msg,
        duracaoMs: Date.now() - inicio,
      });
      return;
    }

    logger.info(
      `NEXO gerente — estado: ${alertas.length} alertas (top ${TOP_ALERTAS}), ` +
        `${fontes.length} fontes. Chamando o briefing...`,
    );

    let briefing: Briefing;
    try {
      briefing = await chamarGerente(alertas, fontes, secret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Gemini ausente (503 do endpoint) ou falha do modelo: loga e DEGRADA —
      // não derruba o cron.
      logger.error(
        "NEXO gerente — falha ao gerar briefing (estado preservado)",
        err,
      );
      await gravarSyncState({
        syncId: "_gerente",
        fonte: "gerente",
        colecao: "nexo_briefings",
        cadencia: "diario",
        sucesso: true,
        degradado: true,
        erro: msg,
        duracaoMs: Date.now() - inicio,
        extra: { alertas: alertas.length, fontes: fontes.length },
      });
      return;
    }

    const fontesDegradadas = fontes.filter(
      (f) => f.statusSaude !== "ok",
    ).length;

    let cicloId: string | null = null;
    try {
      cicloId = await persistirBriefing(briefing, {
        alertas: alertas.length,
        fontes: fontes.length,
        fontesDegradadas,
      });
      logger.info(
        `NEXO gerente — briefing gravado em nexo_briefings/${cicloId}: ` +
          `${briefing.topPrioridades.length} prioridades, ` +
          `${briefing.fontesDegradadas.length} fontes degradadas.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO gerente — falha ao gravar nexo_briefings", err);
      await gravarSyncState({
        syncId: "_gerente",
        fonte: "gerente",
        colecao: "nexo_briefings",
        cadencia: "diario",
        sucesso: false,
        erro: msg,
        duracaoMs: Date.now() - inicio,
      });
      return;
    }

    // Sucesso — observabilidade verde (degradado só se houver fonte parada).
    await gravarSyncState({
      syncId: "_gerente",
      fonte: "gerente",
      colecao: "nexo_briefings",
      cadencia: "30min",
      sucesso: true,
      degradado: fontesDegradadas > 0,
      erro:
        fontesDegradadas > 0
          ? `${fontesDegradadas} fonte(s) degradada(s)`
          : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        cicloId,
        alertas: alertas.length,
        fontes: fontes.length,
        fontesDegradadas,
        topPrioridades: briefing.topPrioridades.length,
      },
    });
  },
);
