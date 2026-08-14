'use client';

/**
 * Contexto que expõe os toggles dos drawers laterais (MediaBin e Inspector)
 * para componentes filhos como o `EditorHeader`. Em telas largas (≥1024px)
 * os painéis ficam visíveis no layout principal e os toggles ficam ocultos.
 */

import { createContext, useContext } from 'react';

export interface EditorLayoutContextValue {
  /** Abre/fecha o drawer do MediaBin (lado esquerdo). */
  toggleMediaBin: () => void;
  /** Abre/fecha o drawer do Inspector (lado direito). */
  toggleInspector: () => void;
  /** Indica se a janela está em layout mobile (<1024px). */
  isMobileLayout: boolean;
}

const EditorLayoutContext = createContext<EditorLayoutContextValue | null>(null);

export const EditorLayoutProvider = EditorLayoutContext.Provider;

export function useEditorLayout(): EditorLayoutContextValue | null {
  return useContext(EditorLayoutContext);
}
