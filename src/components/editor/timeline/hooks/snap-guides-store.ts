'use client';

/**
 * Store local (zustand) que controla a renderização das linhas verticais
 * de snap durante drag/trim na timeline.
 *
 * Não é persistido. Não entra em histórico de undo. Vive apenas em memória,
 * apenas pelo tempo de um drag/trim ativo.
 *
 * Quem usa:
 * - `useClipDrag` / `useClipTrim`: chamam `setActive(true, candidates)` quando
 *   inicia interação e `setActive(false)` ao terminar. Durante o move, podem
 *   chamar `setHighlighted(target)` para destacar o candidato em snap atual.
 * - `<SnapGuides />`: lê `active`, `positions` e `highlighted` para desenhar.
 */

import { create } from 'zustand';

interface SnapGuidesState {
  /** Se as linhas devem aparecer (true durante drag/trim). */
  active: boolean;
  /** Posições (em segundos) para mostrar linha vertical. */
  positions: number[];
  /** Posição (em segundos) atualmente "encaixada" — destacada com glow. */
  highlighted: number | null;
  setActive: (active: boolean, positions?: number[]) => void;
  setPositions: (positions: number[]) => void;
  setHighlighted: (target: number | null) => void;
}

export const useSnapGuidesStore = create<SnapGuidesState>((set) => ({
  active: false,
  positions: [],
  highlighted: null,
  setActive: (active, positions) =>
    set(() => ({
      active,
      positions: positions ?? [],
      highlighted: null,
    })),
  setPositions: (positions) => set(() => ({ positions })),
  setHighlighted: (target) => set(() => ({ highlighted: target })),
}));
