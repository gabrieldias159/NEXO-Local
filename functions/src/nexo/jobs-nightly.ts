/**
 * NEXO — NIGHTLY de re-enfileiramento de snapshots (Frente E, plano §2.2).
 *
 * Cron 1x/dia (madrugada, após a janela de ingestão/detecção). Garante que a UI
 * nunca abra um painel sem dado fresco:
 *   1. RE-ENFILEIRA snapshots cujo TTL expira em < 12h (re-cálculo roda antes do
 *      TTL nativo apagar o atual — janela `JANELA_REENFILEIRA_MS`).
 *   2. AQUECE as TOP entidades (por `totalEmpenhado` em `nexo_entidades`):
 *      pré-computa `dossie`/`risco` do exercício corrente para abertura
 *      instantânea — mesmo que ninguém tenha clicado em Compilar ainda.
 *
 * Mecânica: cria/atualiza `nexo_tarefas/{chave}` com `status:'pendente'` e
 * `origem:'nightly'`. A criação dispara `onNexoTarefaCriada` (worker). Para que
 * o worker REPROCESSE uma chave já vista (cujo doc já existe em estado
 * pronto/erro), o nightly faz `set(merge)` para `pendente`; o trigger
 * `onDocumentCreated` só dispara em CREATE, então quando o doc JÁ existe o
 * nightly o DELETA antes e re-cria (re-dispara o worker de forma limpa).
 *
 * Self-contained: `functions/` não importa de `src/`. NUNCA derruba nada
 * (best-effort + sync-state degradado).
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import {
  JANELA_REENFILEIRA_MS,
  VERSAO_WORKER,
  chaveTarefa,
  type TipoTarefa,
} from "./jobs-tipos";

/** Quantas TOP entidades aquecer por exercício (dossie + risco). */
const TOP_ENTIDADES = 25;

/** Teto de re-enfileiramentos por ciclo (proteção contra explosão). */
const MAX_REENFILEIRA = 200;

/** Exercício corrente (ano fiscal). */
function exercicioCorrente(): number {
  return new Date().getFullYear();
}

/**
 * (Re)enfileira UMA tarefa: garante um doc `pendente` que dispare o worker.
 * Se já existe, deleta e re-cria (o trigger `onDocumentCreated` só dispara em
 * CREATE). Idempotente por chave. NUNCA lança.
 */
async function enfileirar(
  tipo: TipoTarefa,
  alvo: string,
  exercicio: number,
): Promise<boolean> {
  const chave = chaveTarefa(tipo, alvo, exercicio);
  const ref = db.collection("nexo_tarefas").doc(chave);
  try {
    const atual = await ref.get();
    // Se já está pendente/processando, não mexe (evita re-disparo concorrente).
    if (atual.exists) {
      const st = String(atual.data()?.status ?? "");
      if (st === "pendente" || st === "processando") return false;
      // Doc concluído/erro/expirado: apaga para um CREATE limpo.
      await ref.delete();
    }
    await ref.create({
      tipo,
      alvo,
      exercicio,
      status: "pendente",
      origem: "nightly",
      solicitadoPor: "_nightly",
      tentativas: 0,
      _versaoWorker: VERSAO_WORKER,
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch (err) {
    logger.warn("NEXO nightly — falha ao enfileirar tarefa", {
      chave,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Re-enfileira snapshots cujo TTL expira em < 12h. Lê a tarefa correspondente
 * (uma por chave) e re-dispara o worker, para o re-cálculo concluir antes do
 * TTL nativo apagar o snapshot atual.
 */
async function reenfileirarExpirando(agora: number): Promise<number> {
  const limite = admin.firestore.Timestamp.fromMillis(
    agora + JANELA_REENFILEIRA_MS,
  );
  // Tarefas prontas cujo expiraEm cai dentro da janela. Filtra por status +
  // expiraEm — exige índice composto (declarado em firestore.indexes.json).
  const snap = await db
    .collection("nexo_tarefas")
    .where("status", "==", "pronto")
    .where("expiraEm", "<=", limite)
    .orderBy("expiraEm", "asc")
    .limit(MAX_REENFILEIRA)
    .get();

  let n = 0;
  for (const d of snap.docs) {
    const t = d.data();
    const tipo = t.tipo as TipoTarefa;
    const alvo = String(t.alvo ?? "");
    const exercicio = Number(t.exercicio);
    if (!tipo || !Number.isFinite(exercicio)) continue;
    if (await enfileirar(tipo, alvo, exercicio)) n++;
  }
  return n;
}

/**
 * Aquece as TOP entidades por `totalEmpenhado`: enfileira `dossie` e `risco`
 * do exercício corrente. Exclui entes públicos (tipo != 'empresa' já filtrado
 * na origem por perfil-entidades; aqui pegamos as de maior volume).
 */
async function aquecerTopEntidades(exercicio: number): Promise<number> {
  let snap: FirebaseFirestore.QuerySnapshot;
  try {
    snap = await db
      .collection("nexo_entidades")
      .where("tipo", "==", "empresa")
      .orderBy("totalEmpenhado", "desc")
      .limit(TOP_ENTIDADES)
      .get();
  } catch (err) {
    // Índice ausente ou coleção vazia: aquecimento é best-effort.
    logger.warn("NEXO nightly — falha ao listar top entidades", {
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  let n = 0;
  for (const d of snap.docs) {
    const alvo = d.id;
    if (await enfileirar("dossie", alvo, exercicio)) n++;
    if (await enfileirar("risco", alvo, exercicio)) n++;
  }
  return n;
}

export const onNexoTarefasNightly = onSchedule(
  {
    // 04:30 BRT — após a janela de ingestão/detecção noturna, antes do
    // expediente. Re-cálculo pesado fora do horário de uso.
    schedule: "30 4 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    maxInstances: 1,
    retryCount: 1,
    maxRetrySeconds: 300,
  },
  async () => {
    const inicio = Date.now();
    const exercicio = exercicioCorrente();
    let reenfileirados = 0;
    let aquecidos = 0;
    try {
      reenfileirados = await reenfileirarExpirando(inicio);
      aquecidos = await aquecerTopEntidades(exercicio);
      logger.info("NEXO nightly — concluído", {
        exercicio,
        reenfileirados,
        aquecidos,
      });
      await gravarSyncState({
        syncId: "_jobs_nightly",
        fonte: "jobs-nightly",
        colecao: "nexo_tarefas",
        cadencia: "diario",
        sucesso: true,
        erro: null,
        duracaoMs: Date.now() - inicio,
        extra: { reenfileirados, aquecidos, exercicio },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO nightly — falha", err);
      await gravarSyncState({
        syncId: "_jobs_nightly",
        fonte: "jobs-nightly",
        colecao: "nexo_tarefas",
        cadencia: "diario",
        sucesso: false,
        erro: msg,
        duracaoMs: Date.now() - inicio,
        extra: { reenfileirados, aquecidos, exercicio },
      });
    }
  },
);
