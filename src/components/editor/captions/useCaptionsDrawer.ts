'use client';

/**
 * Estado simples (Zustand) para abrir/fechar o `CaptionsDrawer`.
 *
 * Mantemos fora do `useEditorStore` para evitar entradas no histórico de
 * undo (esse é estado UI puro, sem persistência).
 *
 * Uso:
 * - `const { open, set, toggle } = useCaptionsDrawer()` em qualquer parte.
 */

import { create } from 'zustand';

interface CaptionsDrawerState {
  open: boolean;
  /** ID do cue que deve ser focado quando o drawer abrir (opcional). */
  focusCueId: string | null;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Abre o drawer e marca um cue para foco (rola até o card). */
  openWithCue: (cueId: string) => void;
}

export const useCaptionsDrawer = create<CaptionsDrawerState>((set) => ({
  open: false,
  focusCueId: null,
  setOpen: (open) => set({ open, focusCueId: open ? null : null }),
  toggle: () => set((s) => ({ open: !s.open })),
  openWithCue: (cueId) => set({ open: true, focusCueId: cueId }),
}));
