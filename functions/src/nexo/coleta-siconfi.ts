/**
 * Cron de ingestão SICONFI/STN — `onNexoSyncSiconfi` (Fase 3 do plano-mestre).
 *
 * Coleta os indicadores fiscais de Marília (RREO e RGF) da API SICONFI do
 * Tesouro Nacional e persiste em `nexo_indicadores_fiscais`, versionado por
 * período. É uma SÉRIE TEMPORAL — não há purga: cada bimestre/quadrimestre é
 * um registro histórico que permanece.
 *
 * Cadência: quinzenal (1º e 16º dia do mês, 05h05 BRT).
 *
 * Self-contained: re-implementa o fetch ao SICONFI (não importa de `src/`).
 * API pública, sem autenticação. Docs: apidatalake.tesouro.gov.br/docs/siconfi
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { createHash } from "crypto";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

/** Base da API SICONFI (datalake do Tesouro). */
const SICONFI_BASE = "https://apidatalake.tesouro.gov.br/ords/siconfi/tt";
/**
 * Código IBGE de Marília (7 dígitos) — `id_ente` nas consultas SICONFI.
 * ✅ 3529005 (Marília/SP). O antigo 3529401 era MAUÁ/SP — bug corrigido 2026-06-03.
 */
const MARILIA_IBGE = "3529005";
const TIMEOUT_MS = 25_000;
/** Primeiro exercício do SICONFI com série histórica (F1: backfill 2013+). */
const SICONFI_ANO_MIN = 2013;

interface SiconfiPage {
  items?: Record<string, unknown>[];
  hasMore?: boolean;
}

/** Varre todas as páginas de um endpoint SICONFI (paginação por offset). */
async function siconfiGetAll(
  endpoint: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let offset = 0;
  for (let guard = 0; guard < 60; guard++) {
    const url = new URL(`${SICONFI_BASE}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (offset) url.searchParams.set("offset", String(offset));

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`SICONFI ${endpoint} HTTP ${res.status}`);
    const json = (await res.json()) as SiconfiPage;
    const items = json.items ?? [];
    out.push(...items);
    if (!json.hasMore || items.length === 0) break;
    offset += items.length;
  }
  return out;
}

/** Especificação de um demonstrativo SICONFI a coletar. */
interface DemonstrativoSpec {
  /** Nome curto/estável (compõe o ID do doc e a chave de período). */
  tipo: "RREO" | "RGF";
  /** Período: bimestre (RREO 1-6) ou quadrimestre (RGF 1-3). */
  periodo: number;
}

/**
 * Coleta um demonstrativo de um exercício/período. Devolve os itens crus —
 * cada item já traz os campos identificadores do SICONFI (anexo, conta, valor).
 */
async function coletarDemonstrativo(
  spec: DemonstrativoSpec,
  exercicio: number,
): Promise<Record<string, unknown>[]> {
  if (spec.tipo === "RREO") {
    return siconfiGetAll("rreo", {
      an_exercicio: String(exercicio),
      nr_periodo: String(spec.periodo),
      co_tipo_demonstrativo: "RREO",
      id_ente: MARILIA_IBGE,
    });
  }
  return siconfiGetAll("rgf", {
    an_exercicio: String(exercicio),
    nr_periodo: String(spec.periodo),
    in_periodicidade: "Q",
    co_tipo_demonstrativo: "RGF",
    co_poder: "E",
    id_ente: MARILIA_IBGE,
  });
}

/**
 * Lista os demonstrativos a coletar: RREO até o bimestre corrente e RGF até o
 * quadrimestre corrente do exercício atual; do exercício anterior, todos os
 * períodos (o SICONFI publica com defasagem — o ano anterior fecha tardiamente).
 */
function periodosAlvo(): { exercicio: number; specs: DemonstrativoSpec[] }[] {
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mes = hoje.getMonth() + 1; // 1-12
  const bimestreAtual = Math.ceil(mes / 2); // 1-6
  const quadrimestreAtual = Math.ceil(mes / 4); // 1-3

  const specsAno = (
    bimestres: number,
    quadrimestres: number,
  ): DemonstrativoSpec[] => {
    const s: DemonstrativoSpec[] = [];
    for (let b = 1; b <= bimestres; b++) s.push({ tipo: "RREO", periodo: b });
    for (let q = 1; q <= quadrimestres; q++) s.push({ tipo: "RGF", periodo: q });
    return s;
  };

  return [
    { exercicio: anoAtual, specs: specsAno(bimestreAtual, quadrimestreAtual) },
    { exercicio: anoAtual - 1, specs: specsAno(6, 3) },
  ];
}

/**
 * Persiste os itens de um demonstrativo em `nexo_indicadores_fiscais`. O ID do
 * doc é determinístico por exercício/tipo/período — re-coletar o mesmo período
 * SOBRESCREVE (idempotente), nunca duplica a série.
 */
async function persistirIndicador(
  spec: DemonstrativoSpec,
  exercicio: number,
  itens: Record<string, unknown>[],
): Promise<void> {
  const periodoChave = `${exercicio}-${spec.tipo}-P${spec.periodo}`;
  const docId = periodoChave;
  const hash = createHash("sha1")
    .update(JSON.stringify(itens))
    .digest("hex");
  await db
    .collection("nexo_indicadores_fiscais")
    .doc(docId)
    .set(
      {
        _fonte: "siconfi",
        _exercicio: exercicio,
        tipoDemonstrativo: spec.tipo,
        periodo: spec.periodo,
        periodoChave,
        idEnte: MARILIA_IBGE,
        registros: itens.length,
        hashConteudo: hash,
        itens,
        _coletadoEm: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

// ── Cron quinzenal ───────────────────────────────────────────────────────────

export const onNexoSyncSiconfi = onSchedule(
  {
    // Dias 1 e 16 de cada mês, 05h05 BRT — cadência quinzenal.
    schedule: "5 5 1,16 * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    // Hardening (#13): no máximo UMA execução simultânea — evita que um disparo
    // atrasado/retry concorra com a execução em andamento e refaça a coleta.
    // (Lease/lock distribuído fica para onda posterior.)
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: cada período tem doc ID
    // determinístico (`{exercicio}-{tipo}-P{periodo}`) e `merge`, então
    // reexecutar o cron após falha SOBRESCREVE, nunca duplica a série.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    const grupos = periodosAlvo();
    let totalPeriodos = 0;
    let totalRegistros = 0;
    let falhas = 0;
    let ultimoErro: string | null = null;

    for (const { exercicio, specs } of grupos) {
      for (const spec of specs) {
        totalPeriodos++;
        try {
          const itens = await coletarDemonstrativo(spec, exercicio);
          await persistirIndicador(spec, exercicio, itens);
          totalRegistros += itens.length;
          logger.info(
            `NEXO SICONFI — ${exercicio}/${spec.tipo} P${spec.periodo}: ` +
              `${itens.length} itens persistidos`,
          );
        } catch (err) {
          falhas++;
          ultimoErro = err instanceof Error ? err.message : String(err);
          logger.error(
            `NEXO SICONFI — falha em ${exercicio}/${spec.tipo} P${spec.periodo}`,
            err,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const sucesso = falhas < totalPeriodos; // sucesso parcial ainda conta
    await gravarSyncState({
      syncId: "siconfi",
      fonte: "siconfi",
      colecao: "nexo_indicadores_fiscais",
      cadencia: "quinzenal",
      sucesso,
      degradado: falhas > 0,
      erro: ultimoErro,
      duracaoMs: Date.now() - inicio,
      extra: {
        periodosTentados: totalPeriodos,
        periodosComFalha: falhas,
        registros: totalRegistros,
      },
    });
    logger.info(
      `NEXO SICONFI — concluído: ${totalPeriodos - falhas}/${totalPeriodos} ` +
        `períodos, ${totalRegistros} registros, ${falhas} falhas`,
    );
  },
);

// ── Backfill HTTP histórico (F1: série 2013+) ────────────────────────────────

/**
 * Todos os demonstrativos de um exercício: RREO (bimestres 1-6) + RGF
 * (quadrimestres 1-3). O cron só cobre corrente+anterior; o backfill usa esta
 * lista para um ano histórico inteiro.
 */
function especsExercicioInteiro(): DemonstrativoSpec[] {
  const specs: DemonstrativoSpec[] = [];
  for (let b = 1; b <= 6; b++) specs.push({ tipo: "RREO", periodo: b });
  for (let q = 1; q <= 3; q++) specs.push({ tipo: "RGF", periodo: q });
  return specs;
}

/**
 * GET /onNexoBackfillSiconfi?anos=2013,2014
 *   Header: x-backfill-secret: <SEGREDO>
 *
 * Coleta RREO/RGF de exercícios históricos (2013+) sob demanda — a âncora
 * plurianual do orçamento (despesa consolidada pré-2017, RAP, receita). Cada
 * período tem doc ID determinístico (`{exercicio}-{tipo}-P{periodo}`) + merge:
 * reexecutar após falha SOBRESCREVE, nunca duplica (idempotente).
 */
export const onNexoBackfillSiconfi = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 900,
    memory: "512MiB",
    maxInstances: 1,
    invoker: "public",
  },
  async (req, res) => {
    const provided = String(req.headers["x-backfill-secret"] ?? "");
    const expected = process.env.DIARIO_BACKFILL_SECRET || "";
    if (!expected || provided !== expected) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const anosParam = String(req.query.anos ?? "");
    const anos = [
      ...new Set(
        anosParam
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((s) => Number(s))
          .filter((n) => Number.isInteger(n) && n >= SICONFI_ANO_MIN && n <= 2100),
      ),
    ].sort((a, b) => b - a);
    if (anos.length === 0) {
      res.status(400).json({
        error: `Parâmetro 'anos' obrigatório (csv, ex.: anos=2013,2014; faixa ${SICONFI_ANO_MIN}-2100).`,
      });
      return;
    }

    const inicio = Date.now();
    let totalPeriodos = 0;
    let totalRegistros = 0;
    let falhas = 0;
    let ultimoErro: string | null = null;
    const porAno: Record<string, unknown> = {};

    logger.info("NEXO SICONFI — backfill histórico iniciado", { anos });

    for (const exercicio of anos) {
      const specs = especsExercicioInteiro();
      let okAno = 0;
      let falhasAno = 0;
      let registrosAno = 0;
      for (const spec of specs) {
        totalPeriodos++;
        try {
          const itens = await coletarDemonstrativo(spec, exercicio);
          await persistirIndicador(spec, exercicio, itens);
          registrosAno += itens.length;
          okAno++;
          logger.info(
            `NEXO SICONFI — backfill ${exercicio}/${spec.tipo} P${spec.periodo}: ` +
              `${itens.length} itens`,
          );
        } catch (err) {
          falhas++;
          falhasAno++;
          ultimoErro = err instanceof Error ? err.message : String(err);
          logger.error(
            `NEXO SICONFI — backfill ${exercicio}/${spec.tipo} P${spec.periodo} falhou`,
            err,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      totalRegistros += registrosAno;
      porAno[String(exercicio)] = { ok: okAno, falhas: falhasAno, registros: registrosAno };
    }

    const sucesso = falhas < totalPeriodos;
    await gravarSyncState({
      syncId: "siconfi_backfill",
      fonte: "siconfi",
      colecao: "nexo_indicadores_fiscais",
      cadencia: "evento",
      sucesso,
      degradado: falhas > 0,
      erro: ultimoErro,
      duracaoMs: Date.now() - inicio,
      extra: { exerciciosTentados: anos.length, periodosTentados: totalPeriodos, periodosComFalha: falhas, registros: totalRegistros, porAno },
    });

    res.status(200).json({
      ok: true,
      exercicios: anos.length,
      periodos: totalPeriodos,
      periodosComFalha: falhas,
      registros: totalRegistros,
      porAno,
    });
  },
);
