'use client';

/**
 * Store Zustand do Media Controller.
 *
 * Centraliza:
 *  - `statuses`: snapshot do estado de cada asset em uso.
 *  - `events`: ring buffer dos ultimos eventos (diagnostico).
 *  - `diagnosticOpen`: estado UI do painel.
 *
 * O controller atualiza o store via `setStatus`/`pushEvent`; componentes
 * React consomem via hooks Zustand para renderizar UI reativa.
 */

import { create } from 'zustand';
import type { MediaEvent, MediaStatus } from './types';
import { DEFAULT_CONFIG } from './types';

interface MediaControllerStore {
  /**
   * Statuses indexados pela CHAVE do slot (= `clipId`, unico por clip da
   * timeline). NAO por `assetId` — clips diferentes podem compartilhar o
   * mesmo asset (split-screen, duplicate/split/paste). O `assetId` continua
   * disponivel como campo dentro de cada `MediaStatus` (metadado p/ UI/log).
   */
  statuses: Record<string, MediaStatus>;
  /** Eventos recentes (mais novos primeiro). */
  events: MediaEvent[];
  /** Estado UI do painel de diagnostico. */
  diagnosticOpen: boolean;

  // --- Mutadores (chamados pelo controller) ---
  /** `key` = chave do slot (clipId). O `assetId` vem dentro do patch. */
  setStatus: (key: string, patch: Partial<MediaStatus>) => void;
  removeStatus: (key: string) => void;
  pushEvent: (event: MediaEvent) => void;
  clearEvents: () => void;
  reset: () => void;

  // --- UI ---
  setDiagnosticOpen: (open: boolean) => void;
}

export const useMediaControllerStore = create<MediaControllerStore>((set) => ({
  statuses: {},
  events: [],
  diagnosticOpen: false,

  setStatus: (key, patch) =>
    set((s) => {
      const prev = s.statuses[key] ?? {
        // key/assetId placeholder: o controller sempre injeta os valores reais
        // no patch (via setStatus(slot, ...)). O assetId placeholder so vale no
        // improvavel caso de um primeiro patch sem assetId.
        key,
        assetId: key,
        state: 'idle' as const,
        retries: 0,
        updatedAt: Date.now(),
      };
      return {
        statuses: {
          ...s.statuses,
          // Spread DEPOIS de prev pra o assetId do patch prevalecer.
          [key]: { ...prev, ...patch, updatedAt: Date.now() },
        },
      };
    }),

  removeStatus: (key) =>
    set((s) => {
      if (!(key in s.statuses)) return s;
      const { [key]: _gone, ...rest } = s.statuses;
      return { statuses: rest };
    }),

  pushEvent: (event) =>
    set((s) => {
      const next = [event, ...s.events];
      if (next.length > DEFAULT_CONFIG.logBufferSize) {
        next.length = DEFAULT_CONFIG.logBufferSize;
      }
      return { events: next };
    }),

  clearEvents: () => set({ events: [] }),

  reset: () => set({ statuses: {}, events: [] }),

  setDiagnosticOpen: (open) => set({ diagnosticOpen: open }),
}));

/** Snapshot fora do React (pra exportar log JSON, etc). */
export function getMediaControllerSnapshot() {
  const s = useMediaControllerStore.getState();
  return {
    capturedAt: new Date().toISOString(),
    statuses: s.statuses,
    events: s.events,
  };
}
