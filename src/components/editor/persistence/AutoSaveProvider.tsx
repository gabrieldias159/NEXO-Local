'use client';

/**
 * Contexto que monta o `useAutoSave` no nível raiz do editor e expõe
 * o `forceSave` para componentes filhos (Header → botão "Salvar").
 *
 * Usar uma vez por instância de editor (no `SuiteVideoEditor`).
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAutoSave } from '@/lib/editor/persistence/use-auto-save';

interface AutoSaveContextValue {
  isSaving: boolean;
  lastSavedAt: Date | null;
  saveError: string | null;
  forceSave: () => Promise<void>;
}

const AutoSaveContext = createContext<AutoSaveContextValue | null>(null);

export function AutoSaveProvider({ children }: { children: ReactNode }) {
  const auto = useAutoSave();
  const value = useMemo<AutoSaveContextValue>(
    () => ({
      isSaving: auto.isSaving,
      lastSavedAt: auto.lastSavedAt,
      saveError: auto.saveError,
      forceSave: auto.forceSave,
    }),
    [auto.isSaving, auto.lastSavedAt, auto.saveError, auto.forceSave],
  );
  return (
    <AutoSaveContext.Provider value={value}>
      {children}
    </AutoSaveContext.Provider>
  );
}

/**
 * Hook seguro: retorna `null` se chamado fora do provider — útil para
 * componentes que rendem em modo "preview" ou em rotas sem auth.
 */
export function useAutoSaveContext(): AutoSaveContextValue | null {
  return useContext(AutoSaveContext);
}
