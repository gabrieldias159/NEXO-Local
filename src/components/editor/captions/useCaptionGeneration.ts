'use client';

/**
 * Hook que escuta um `captionJobs/{jobId}` em tempo real e expõe progresso
 * + status da geração de legendas via IA.
 *
 * Usado pelo `CaptionGenerateDialog` para mostrar a barra de progresso
 * enquanto a Cloud Function `onCaptionGenerateRequest` mixar/transcrever.
 *
 * Quando `status === 'complete'`, o consumidor pode fechar o dialog e
 * confiar que `videoProjects/{projectId}` recebeu uma nova `CaptionTrack`.
 */

import * as React from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { useFirestore } from '@/firebase';
import type { CaptionGenerationJob, CaptionJobStatus } from '@/lib/types';

export interface CaptionGenerationState {
  status: CaptionJobStatus | 'idle';
  progress: number;
  error: string | null;
  captionTrackId: string | null;
  srtStoragePath: string | null;
  loading: boolean;
  /**
   * `true` quando o job ficou preso num estado não-terminal por tempo demais
   * (Cloud Function morreu sem escrever status final, ou nenhum progresso há
   * minutos). Sinaliza pro dialog mostrar "pode ter falhado — tente de novo".
   */
  stalled: boolean;
}

const INITIAL: CaptionGenerationState = {
  status: 'idle',
  progress: 0,
  error: null,
  captionTrackId: null,
  srtStoragePath: null,
  loading: false,
  stalled: false,
};

const TERMINAL_STATUSES: ReadonlySet<CaptionJobStatus | 'idle'> = new Set([
  'complete',
  'error',
  'cancelled',
]);

/** Tempo máximo total num estado não-terminal antes de considerar travado. */
const STALL_TIMEOUT_MS = 6 * 60 * 1000; // 6 min
/** Tempo máximo sem qualquer atualização (status/progresso) antes de travar. */
const NO_PROGRESS_TIMEOUT_MS = 6 * 60 * 1000; // 6 min

export function useCaptionGeneration(
  jobId: string | null,
): CaptionGenerationState {
  const firestore = useFirestore();
  const [state, setState] = React.useState<CaptionGenerationState>(INITIAL);

  React.useEffect(() => {
    if (!jobId || !firestore) {
      setState(INITIAL);
      return;
    }
    setState((s) => ({ ...s, loading: true, stalled: false }));

    // Watchdog: se o job não chegar a um estado terminal em N minutos, OU
    // ficar sem nenhuma atualização (snapshot) por N minutos, marca `stalled`
    // pra liberar o usuário do spinner infinito (function pode ter morrido).
    const startedAt = Date.now();
    let lastSnapshotAt = startedAt;
    let watchdog: ReturnType<typeof setInterval> | null = null;

    const ref = doc(firestore, 'captionJobs', jobId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        lastSnapshotAt = Date.now();
        const data = snap.data() as CaptionGenerationJob | undefined;
        if (!data) {
          setState({
            ...INITIAL,
            loading: false,
            status: 'idle',
          });
          return;
        }
        setState({
          status: data.status ?? 'pending',
          progress: typeof data.progress === 'number' ? data.progress : 0,
          error: data.error ?? null,
          captionTrackId: data.captionTrackId ?? null,
          srtStoragePath: data.srtStoragePath ?? null,
          loading: false,
          stalled: false,
        });
      },
      (err) => {
        console.error('[useCaptionGeneration] snapshot error:', err);
        setState((s) => ({
          ...s,
          status: 'error',
          error: err.message ?? 'Falha ao escutar o job.',
          loading: false,
        }));
      },
    );

    watchdog = setInterval(() => {
      setState((s) => {
        // Já terminou ou já está marcado — nada a fazer.
        if (TERMINAL_STATUSES.has(s.status) || s.stalled) return s;
        const now = Date.now();
        const overall = now - startedAt > STALL_TIMEOUT_MS;
        const noProgress = now - lastSnapshotAt > NO_PROGRESS_TIMEOUT_MS;
        if (overall || noProgress) {
          return { ...s, stalled: true };
        }
        return s;
      });
    }, 15_000);

    return () => {
      unsub();
      if (watchdog) clearInterval(watchdog);
    };
  }, [jobId, firestore]);

  return state;
}
