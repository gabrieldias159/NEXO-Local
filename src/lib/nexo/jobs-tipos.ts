/**
 * NEXO — TIPOS da infra de jobs/snapshots (Frente E do plano-mestre §2.2).
 *
 * Contratos de dados de `nexo_tarefas` (fila) e `nexo_snapshots` (resultado
 * materializado), mais constantes de versão/TTL compartilhadas pelo cliente
 * (botão Compilar, tracker) e pelas rotas snapshot-first.
 *
 * ESPELHO: este arquivo é cópia VERBATIM de `functions/src/nexo/jobs-tipos.ts`
 * (regra `functions/` NÃO importa de `src/`). Qualquer mudança aqui deve ser
 * replicada no espelho das functions — eles formam o contrato cliente↔worker.
 */

/** Tipos de painel que viram tarefa/snapshot. */
export type TipoTarefa = "dossie" | "grafo" | "alertas" | "risco" | "ranking";

/** Estados de uma tarefa na fila `nexo_tarefas`. */
export type StatusTarefa =
  | "pendente"
  | "processando"
  | "pronto"
  | "erro"
  | "expirado";

/** Origem da tarefa — manual (botão Compilar) ou re-enfileirada pelo nightly. */
export type OrigemTarefa = "manual" | "nightly";

/** Versão do esquema do payload de snapshot. Bump invalida `_hashEntrada`. */
export const VERSAO_ESQUEMA_SNAPSHOT = 1;

/** Versão do worker — carimbada em `nexo_tarefas` para auditoria/migração. */
export const VERSAO_WORKER = 1;

/** TTL dos snapshots/tarefas: 3 dias (alinhado ao plano §2.2). */
export const TTL_SNAPSHOT_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Janela do nightly: re-enfileira snapshots que expiram em < 12h para a UI
 * nunca ficar sem dado (o re-cálculo roda antes do TTL apagar o atual).
 */
export const JANELA_REENFILEIRA_MS = 12 * 60 * 60 * 1000;

/** Teto de payload inline no doc do snapshot (Firestore limita ~1 MiB/doc). */
export const LIMITE_INLINE_BYTES = 900_000;

/** Número máximo de tentativas do worker antes de marcar a tarefa como `erro`. */
export const MAX_TENTATIVAS = 3;

/**
 * Documento de `nexo_tarefas/{chave}` — docId = `{tipo}:{alvo}:{exercicio}`
 * (dedupe natural: uma tarefa viva por painel/alvo/exercício).
 */
export interface NexoTarefa {
  tipo: TipoTarefa;
  /** Alvo do painel: id de entidade (dossie/risco), "" para grafo/alertas globais. */
  alvo: string;
  exercicio: number;
  status: StatusTarefa;
  origem: OrigemTarefa;
  /** UID de quem solicitou (manual); para o nightly, marcador de sistema. */
  solicitadoPor: string;
  /** ID do snapshot pronto (`{chave}:{epoch}`), quando `status==='pronto'`. */
  snapshotId?: string | null;
  /** 0..100 — informativo para a UI. */
  progresso?: number;
  erro?: string | null;
  tentativas?: number;
  _versaoWorker?: number;
  // Timestamps (serverTimestamp na escrita; lidos como Timestamp).
  criadoEm?: unknown;
  iniciadoEm?: unknown;
  concluidoEm?: unknown;
  /** = concluidoEm + 3d; campo do TTL nativo. */
  expiraEm?: unknown;
}

/** Resumo de diferença vs o snapshot anterior. `null` = primeira geração. */
export interface ResumoDelta {
  novos: number;
  removidos: number;
  deltaValor: number;
}

/**
 * Documento de `nexo_snapshots/{chave}:{epoch}` — N versões por chave
 * (histórico). Payload inline (<900KB) ou apontamento para o Storage.
 */
export interface NexoSnapshot {
  chave: string;
  tipo: TipoTarefa;
  alvo: string;
  exercicio: number;
  geradoEm: unknown;
  /** = geradoEm + 3d; campo do TTL nativo. */
  expiraEm: unknown;
  _versaoEsquema: number;
  /** sha1 dos campos de entrada — igual ao anterior ⇒ não recompila. */
  _hashEntrada: string;
  /** Payload completo se couber inline. */
  payloadInline?: Record<string, unknown> | null;
  /** `gs://.../nexo-snapshots/{id}.json.gz` quando excede o limite inline. */
  payloadStorage?: string | null;
  /** `null` na primeira geração (não inventar delta). */
  resumoDelta?: ResumoDelta | null;
  tamanhoBytes: number;
  nDocsLidos: number;
}

/** Monta o docId canônico de uma tarefa (dedupe estável). */
export function chaveTarefa(
  tipo: TipoTarefa,
  alvo: string,
  exercicio: number,
): string {
  return `${tipo}:${alvo}:${exercicio}`;
}

/** Monta o docId de um snapshot a partir da chave da tarefa e do epoch (ms). */
export function chaveSnapshot(chave: string, epochMs: number): string {
  return `${chave}:${epochMs}`;
}
