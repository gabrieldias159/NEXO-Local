/**
 * NEXO — Guarda do modo `?compute=1` das rotas snapshot-first (Frente F, §2.2/2.3).
 *
 * As rotas pesadas do NEXO (`alertas`/`grafo`/`dossie`/`risco`/`ranking-doadores`)
 * têm DOIS modos:
 *
 *  1. LEITURA (default) — sessão do usuário (`verificarSessao`). A rota LÊ o
 *     snapshot pronto de `nexo_snapshots` (instantâneo) se houver e não expirado;
 *     senão devolve um estado HONESTO "sem snapshot / compile". NUNCA computa o
 *     cálculo pesado ao vivo no GET do usuário.
 *
 *  2. COMPUTE — `?compute=1` + `x-nexo-secret` + `x-nexo-firestore-token`
 *     (mesmo padrão de `/api/nexo/detectar`). É o worker (Frente E) que chama; a
 *     rota COMPUTA de verdade e devolve o payload puro, que o worker persiste em
 *     `nexo_snapshots`. Gateado por segredo compartilhado — não fica aberto por
 *     omissão de configuração (503 honesto).
 *
 * CONTRATO com `functions/src/nexo/jobs-worker.ts` (LIDO e casado):
 *   - Request : `GET ${APP}/api/nexo/<tipo>?compute=1&exercicio=<n>&alvo=<id>`
 *               header `x-nexo-secret`           = NEXO_DETECTAR_SECRET ?? DIARIO_BACKFILL_SECRET
 *               header `x-nexo-firestore-token`  = OAuth2 access token de serviço
 *   - Response: o PAYLOAD PURO da rota (JSON). O worker calcula o `hashEntrada`
 *               sozinho (stableStringify do payload) e o `nDocsLidos` se ausente,
 *               então NÃO precisamos do envelope — devolver o payload basta. O
 *               worker grava `payloadInline` (<900KB) ou `payloadStorage` (gz).
 *
 * Self-contained no app (NÃO importa de `functions/`); o segredo/headers são os
 * mesmos por convenção (verbatim) — não há import cruzado.
 */
import {
  lerSnapshotMaisRecente,
  enfileirarRecompute,
  type SnapshotLido,
} from '@/lib/nexo/firestore-read';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { chaveTarefa, type TipoTarefa } from '@/lib/nexo/jobs-tipos';

/** Resultado da avaliação do modo compute. */
export type ModoCompute =
  | {
      /** Modo COMPUTE liberado: a rota deve computar e devolver o payload puro. */
      modo: 'compute';
      /** Token de serviço para a leitura REST das coleções `nexo_*`. */
      idToken: string;
    }
  | {
      /** Pediu compute mas falhou a guarda — a rota responde `resposta`. */
      modo: 'negado';
      status: number;
      erro: string;
    }
  | {
      /** Não é compute — segue o fluxo de LEITURA (sessão do usuário). */
      modo: 'leitura';
    };

/**
 * Avalia se a requisição é um `?compute=1` válido. Espelha a guarda de
 * `/api/nexo/detectar`: segredo compartilhado + token de serviço nos headers.
 * Quando `?compute=1` NÃO está presente, devolve `{modo:'leitura'}` e a rota
 * segue com `verificarSessao`.
 */
export function avaliarCompute(req: Request): ModoCompute {
  const { searchParams } = new URL(req.url);
  const pediuCompute =
    searchParams.get('compute') === '1' || searchParams.get('compute') === 'true';
  if (!pediuCompute) return { modo: 'leitura' };

  const segredo =
    process.env.NEXO_DETECTAR_SECRET ?? process.env.DIARIO_BACKFILL_SECRET;
  if (!segredo) {
    return {
      modo: 'negado',
      status: 503,
      erro: 'modo compute não configurado (segredo ausente)',
    };
  }
  const enviado = req.headers.get('x-nexo-secret') ?? '';
  if (enviado !== segredo) {
    return { modo: 'negado', status: 401, erro: 'acesso negado (compute)' };
  }
  const idToken = req.headers.get('x-nexo-firestore-token') ?? '';
  if (!idToken) {
    return {
      modo: 'negado',
      status: 401,
      erro: 'token de leitura ausente (x-nexo-firestore-token)',
    };
  }
  return { modo: 'compute', idToken };
}

/** Sessão do usuário para o modo LEITURA (proxy de `verificarSessao`). */
export async function sessaoLeitura(req: Request) {
  return verificarSessao(req);
}

/** Monta a chave canônica de snapshot/tarefa de um painel (`{tipo}:{alvo}:{exerc}`). */
export function chaveSnapshotPainel(
  tipo: TipoTarefa,
  alvo: string,
  exercicio: number,
): string {
  return chaveTarefa(tipo, alvo, exercicio);
}

/**
 * Lê o snapshot pronto mais recente de um painel. Wrapper de
 * `lerSnapshotMaisRecente` que monta a chave canônica. Devolve null quando não
 * há snapshot vivo (a rota responde o estado "compile para gerar").
 */
export async function lerSnapshotPainel(
  tipo: TipoTarefa,
  alvo: string,
  exercicio: number,
  idToken: string,
  /**
   * Quando informado, dispara um recompute em BACKGROUND (best-effort) se o
   * snapshot estiver AUSENTE ou VENCIDO — a UI converge p/ snapshot fresco sem
   * computar pesado no request. Sem `uid`, só lê (comportamento inalterado).
   */
  uid?: string,
): Promise<SnapshotLido | null> {
  // incluirExpirado: serve o último snapshot bom mesmo vencido (stale) em vez
  // de cair no cômputo live — as rotas snapshot-first nunca computam pesado no
  // GET do usuário. O recompute roda em background (abaixo) + nightly/Compilar.
  const snap = await lerSnapshotMaisRecente(
    chaveSnapshotPainel(tipo, alvo, exercicio),
    idToken,
    { incluirExpirado: true },
  );
  if (uid && (!snap || snap.expirado)) {
    // ausente ou stale → recompõe em background (dedupe interno em nexo_tarefas).
    void enfileirarRecompute(tipo, alvo, exercicio, uid, idToken);
  }
  return snap;
}
