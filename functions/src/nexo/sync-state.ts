/**
 * Helpers de observabilidade do `nexo_sync_state` (Fase 4/5 do plano-mestre).
 *
 * Centraliza a gravação do estado de sincronização de cada cron NEXO com os
 * campos que o painel de saúde consome:
 *   - `statusSaude`        — `'ok' | 'stale' | 'degradado' | 'falha'`;
 *   - `errosConsecutivos` — incrementa em erro, zera em sucesso;
 *   - `ultimoSucessoEm`   — carimbo do último ciclo bem-sucedido (≠ `coletadoEm`,
 *                            que é toda execução, com ou sem êxito);
 *   - `duracaoMs`         — duração do ciclo;
 *   - `cadencia`          — `'diario' | 'quinzenal' | '6h' | '30min' | '1h'`.
 *
 * Self-contained: o projeto `functions/` não importa de `src/`.
 */
import { admin, db } from "../shared/admin";

/**
 * Cadência de execução do cron — alimenta o cálculo de "stale" no painel.
 * `30min`/`1h` cobrem crons de alta frequência (ex.: vigilância/sondas); o
 * painel de saúde usa a cadência para dimensionar a janela de frescor.
 */
export type Cadencia = "diario" | "quinzenal" | "6h" | "30min" | "1h" | "evento";

/** Saúde derivada do ciclo, para o painel de monitoramento. */
export type StatusSaude = "ok" | "stale" | "degradado" | "falha";

export interface GravarSyncStateInput {
  /** ID do doc em `nexo_sync_state` (estável por fonte/escopo). */
  syncId: string;
  /** Nome curto/estável da fonte. */
  fonte: string;
  /** Coleção `nexo_*` de destino (informativo). */
  colecao: string;
  /** Cadência do cron que produziu este estado. */
  cadencia: Cadencia;
  /** `true` quando o ciclo concluiu sem erro fatal. */
  sucesso: boolean;
  /** Mensagem de erro honesta, ou null. */
  erro: string | null;
  /** Duração do ciclo em ms. */
  duracaoMs: number;
  /**
   * `true` quando o ciclo concluiu mas em estado degradado (ex.: token
   * ausente, coleta parcial). Mapeia para `statusSaude: 'degradado'`.
   */
  degradado?: boolean;
  /**
   * `true` quando a coleta bateu o teto de páginas (`maxPag`) e os dados foram
   * CORTADOS — a fonte tem mais registros do que coletamos. Persistido como
   * `truncado` para o painel de saúde sinalizar cobertura incompleta (≠
   * `parcial`, que é falha de página no meio; `truncado` é dado a mais que o
   * cap deixou de fora). Quando omitido, o campo NÃO é tocado no merge.
   */
  truncado?: boolean;
  /** Campos extras específicos da fonte (registros, hash, etc.). */
  extra?: Record<string, unknown>;
}

/**
 * Grava (merge) o `nexo_sync_state` de um ciclo, calculando `statusSaude` e
 * `errosConsecutivos` a partir do estado anterior. Nunca lança — a
 * observabilidade não pode derrubar o cron que a alimenta.
 */
export async function gravarSyncState(
  input: GravarSyncStateInput,
): Promise<void> {
  const {
    syncId,
    fonte,
    colecao,
    cadencia,
    sucesso,
    erro,
    duracaoMs,
    degradado = false,
    truncado,
    extra = {},
  } = input;
  try {
    const ref = db.collection("nexo_sync_state").doc(syncId);
    const anterior = await ref.get();
    const errosAnteriores = anterior.exists
      ? Number(anterior.data()?.errosConsecutivos ?? 0)
      : 0;

    const errosConsecutivos = sucesso ? 0 : errosAnteriores + 1;
    const statusSaude: StatusSaude = !sucesso
      ? "falha"
      : degradado
        ? "degradado"
        : "ok";

    const now = admin.firestore.FieldValue.serverTimestamp();
    const payload: Record<string, unknown> = {
      ...extra,
      fonte,
      colecao,
      cadencia,
      erro,
      duracaoMs,
      errosConsecutivos,
      statusSaude,
      coletadoEm: now,
    };
    // `ultimoSucessoEm` só avança quando o ciclo de fato deu certo — assim o
    // painel mede há quanto tempo a fonte está sem coletar com êxito.
    if (sucesso) payload.ultimoSucessoEm = now;
    // `truncado` só é gravado quando o chamador o informa explicitamente —
    // assim um ciclo que não sabe do cap não apaga (merge) a flag de outro.
    if (truncado !== undefined) payload.truncado = truncado;

    await ref.set(payload, { merge: true });
  } catch (err) {
    // Falha ao gravar observabilidade é logada pelo chamador; aqui só
    // garantimos que não propague.
    void err;
  }
}
