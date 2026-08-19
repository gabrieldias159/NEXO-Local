'use client';

/**
 * Hook de auto-save do `VideoProject` no Firestore.
 *
 * Comportamento:
 * - Subscribe ao `project` do store via `useEditorStore.subscribe`.
 * - Quando muda, agenda um save com debounce de `DEBOUNCE_MS`.
 * - Chama `saveProject(firestore, project)` do repository.
 * - Atualiza `ui.lastSavedAt` e `ui.isSaving` via store.
 * - Em erro de rede, marca `ui.saveError` (componente UI lê).
 *
 * O hook deve ser montado uma vez (no `SuiteVideoEditor` raiz). Devolve
 * estado pronto para mostrar no `SaveIndicator`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store';
import { useFirestore } from '@/firebase/provider';
import { useUser } from '@/firebase/auth/use-user';
import { saveProject as saveProjectToFirestore } from './project-repository';
import type { VideoProject } from '../types';

/** Debounce do auto-save em milissegundos (idle entre edições). */
const DEBOUNCE_MS = 5_000;
/**
 * Tempo máximo (ms) que aceitamos ter mudanças "sujas" sem persistir. Se o
 * usuário fica editando continuamente (cada edit reseta o debounce), o
 * auto-save jamais dispararia. Esta janela força um flush periódico.
 */
const MAX_FLUSH_MS = 60_000;

interface UseAutoSaveReturn {
  isSaving: boolean;
  lastSavedAt: Date | null;
  saveError: string | null;
  /** Força um save imediato (cancela qualquer debounce pendente). */
  forceSave: () => Promise<void>;
}

export function useAutoSave(): UseAutoSaveReturn {
  const firestore = useFirestore();
  const { user } = useUser();

  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const setSavingState = useEditorStore((s) => s.setSavingState);
  const setStoreLastSavedAt = useEditorStore((s) => s.setLastSavedAt);
  const setStoreSaveError = useEditorStore((s) => s.setSaveError);

  // Refs para controlar o debounce sem re-renderizar.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSerializedRef = useRef<string | null>(null);
  const inFlightRef = useRef<boolean>(false);
  /** Timestamp da primeira edição "suja" desde o último save bem-sucedido. */
  const dirtySinceRef = useRef<number | null>(null);

  /** Executa save imediato (síncrono em relação ao timer). */
  const runSave = useCallback(
    async (project: VideoProject) => {
      if (inFlightRef.current) return;
      // Só salva projetos do owner atual.
      if (!user || project.ownerUid !== user.uid) return;
      inFlightRef.current = true;
      setIsSaving(true);
      setSavingState(true);
      try {
        await saveProjectToFirestore(firestore, project);
        const now = new Date();
        setLastSavedAt(now);
        setStoreLastSavedAt(now);
        setSaveError(null);
        setStoreSaveError(null);
        // Limpou o estado "dirty" — janela MAX_FLUSH reinicia.
        dirtySinceRef.current = null;
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Falha ao salvar projeto.';
        setSaveError(msg);
        setStoreSaveError(msg);
        // Não relança — auto-save é best-effort.
      } finally {
        inFlightRef.current = false;
        setIsSaving(false);
        setSavingState(false);
      }
    },
    [firestore, user, setSavingState, setStoreLastSavedAt, setStoreSaveError],
  );

  // Subscribe ao store: a cada mudança no `project`, agenda debounce.
  // Implementa também um teto MAX_FLUSH_MS: se o usuário edita
  // continuamente (cada edit reseta o debounce de 5s), forçamos um
  // save após 60s desde a primeira mudança "suja".
  useEffect(() => {
    const unsubscribe = useEditorStore.subscribe((state, prev) => {
      const project = state.project;
      if (!project) return;
      if (project === prev.project) return;

      // PROGRESSO DE UPLOAD NAO E EDICAO.
      //
      // `setAssetUploadProgress` dispara dezenas de vezes por arquivo enquanto
      // a midia sobe. Como cada mudanca no `project` reagendava o debounce de
      // 5s, importar varios arquivos mantinha o save adiado ate o teto de 60s
      // (MAX_FLUSH) — o rodape ficava com "Salvo as ..." velho e, se a aba
      // fechasse antes, os assets recem-importados sumiam do documento.
      //
      // Aqui detectamos o caso em que SO o `uploadProgress` mudou e saimos sem
      // reagendar. A comparacao usa igualdade REFERENCIAL nas partes pesadas
      // (o immer troca a referencia so quando o conteudo muda), entao nao ha
      // custo de serializar tracks/clips a cada tique.
      const ant = prev.project;
      if (ant) {
        const soProgresso =
          project.tracks === ant.tracks &&
          project.captionTracks === ant.captionTracks &&
          project.name === ant.name &&
          project.duration === ant.duration &&
          project.resolution === ant.resolution &&
          project.audioMaster === ant.audioMaster &&
          project.assets.length === ant.assets.length &&
          project.assets.every((a, i) => {
            const b = ant.assets[i];
            if (a === b) return true;
            return (
              a.id === b.id &&
              a.status === b.status &&
              a.name === b.name &&
              a.downloadUrl === b.downloadUrl &&
              a.storagePath === b.storagePath
            );
          });
        if (soProgresso) return;
      }

      // Marca timestamp da primeira edição "suja" desta janela.
      const now = Date.now();
      if (dirtySinceRef.current === null) {
        dirtySinceRef.current = now;
      }

      // Se já passou do teto MAX_FLUSH_MS, força save imediato em vez
      // de continuar reagendando. Não cancela um save em vôo.
      const dirtyAge = now - (dirtySinceRef.current ?? now);
      if (dirtyAge >= MAX_FLUSH_MS) {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const current = useEditorStore.getState().project;
        if (current && !inFlightRef.current) {
          void runSave(current);
        }
        return;
      }

      if (timerRef.current) clearTimeout(timerRef.current);
      // O debounce não pode ultrapassar a janela MAX_FLUSH_MS restante.
      const remainingFlush = Math.max(0, MAX_FLUSH_MS - dirtyAge);
      const delay = Math.min(DEBOUNCE_MS, remainingFlush);
      timerRef.current = setTimeout(() => {
        const current = useEditorStore.getState().project;
        if (current) void runSave(current);
      }, delay);
    });

    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [runSave]);

  const forceSave = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const project = useEditorStore.getState().project;
    if (project) await runSave(project);
  }, [runSave]);

  // ---- beforeunload: best-effort flush --------------------------------------
  // Estratégia: se há mudanças não salvas (`dirtySinceRef !== null`), dispara
  // `runSave` em background. Como Firestore SDK não suporta `sendBeacon`
  // diretamente, escrevemos também um snapshot serializado em
  // `localStorage` como rede de segurança — caso o usuário recarregue antes
  // do save no Firestore concluir, é possível recuperar o estado.
  //
  // NÃO bloqueamos o unload (sem `e.preventDefault()` nem `returnValue`):
  // só sinalizamos a tentativa.
  useEffect(() => {
    const handler = () => {
      if (dirtySinceRef.current === null && !inFlightRef.current) return;
      const project = useEditorStore.getState().project;
      if (!project) return;
      // 1) Snapshot local (síncrono — confiável durante unload).
      try {
        const snapshot = JSON.stringify({
          projectId: project.id,
          savedAt: Date.now(),
          // Nota: serialização "leve". O save Firestore real envia tudo
          // separadamente via `runSave`.
          payload: project,
        });
        window.localStorage.setItem(
          `editor:autosave:${project.id}`,
          snapshot,
        );
      } catch {
        // QuotaExceeded, etc — best-effort.
      }
      // 2) Dispara save Firestore best-effort. Como o SDK retorna Promise
      //    e o navegador pode descartar pendências, isto é só uma
      //    tentativa — o snapshot acima é a garantia.
      try {
        void runSave(project);
      } catch {
        // ignora
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [runSave]);

  // Sincroniza estado local quando outro caller (botão Salvar manual) atualiza
  // o store. Mantemos local + store para componentes flexíveis.
  return {
    isSaving,
    lastSavedAt,
    saveError,
    forceSave,
  };
}
