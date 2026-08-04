'use client';
    
import { useState, useEffect, useCallback } from 'react';
import {
  DocumentReference,
  onSnapshot,
  getDoc,
  DocumentData,
  FirestoreError,
  DocumentSnapshot,
} from 'firebase/firestore';
import { errorEmitter } from '@/firebase/error-emitter';
import { FirestorePermissionError } from '@/firebase/errors';
import { isErroPermissao, comRetry } from '@/firebase/firestore/error-utils';

/** Utility type to add an 'id' field to a given type T. */
type WithId<T> = T & { id: string };

/**
 * Interface for the return value of the useDoc hook.
 * @template T Type of the document data.
 */
export interface UseDocResult<T> {
  data: WithId<T> | null; // Document data with ID, or null.
  isLoading: boolean;       // True if loading.
  error: FirestoreError | Error | null; // Error object, or null.
  /** Refaz a leitura (útil no modo `live:false`). */
  refetch: () => void;
}

/** Ver `UseCollectionOptions`. `live:false` = uma leitura (getDoc), corta custo. */
export interface UseDocOptions {
  live?: boolean;
}

/**
 * React hook to subscribe to a single Firestore document in real-time.
 * Handles nullable references.
 * 
 * IMPORTANT! YOU MUST MEMOIZE the inputted memoizedTargetRefOrQuery or BAD THINGS WILL HAPPEN
 * use useMemo to memoize it per React guidence.  Also make sure that it's dependencies are stable
 * references
 *
 *
 * @template T Optional type for document data. Defaults to any.
 * @param {DocumentReference<DocumentData> | null | undefined} docRef -
 * The Firestore DocumentReference. Waits if null/undefined.
 * @returns {UseDocResult<T>} Object with data, isLoading, error.
 */
export function useDoc<T = any>(
  memoizedDocRef: (DocumentReference<DocumentData> & {__memo?: boolean}) | null | undefined,
  options?: UseDocOptions,
): UseDocResult<T> {
  type StateDataType = WithId<T> | null;

  const live = options?.live ?? true;

  const [data, setData] = useState<StateDataType>(null);
  const [isLoading, setIsLoading] = useState<boolean>(!!memoizedDocRef);
  const [error, setError] = useState<FirestoreError | Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!memoizedDocRef) {
      setData(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    const aoReceber = (snapshot: DocumentSnapshot<DocumentData>) => {
      // This is the key change. If we get a result from cache saying the doc
      // doesn't exist, we should not immediately conclude it's missing.
      // We wait for the server to confirm. This prevents premature redirects
      // on page load when the local cache is not yet populated.
      if (!snapshot.exists() && snapshot.metadata.fromCache) {
        // Still loading, waiting for server data.
        return;
      }

      if (snapshot.exists()) {
        setData({ ...(snapshot.data() as T), id: snapshot.id });
      } else {
        // Document does not exist (confirmed by server or cache had data that was deleted).
        setData(null);
      }
      setError(null); // Clear any previous error on successful snapshot
      setIsLoading(false); // We have a definitive answer from server (or a hydrated cache)
    };
    const aoFalhar = (error: FirestoreError) => {
      // Falha de rede/backend transiente — não é negação de regra. Mantém os
      // dados já carregados (cache offline) e deixa o listener reconectar.
      if (!isErroPermissao(error)) {
        setIsLoading(false);
        return;
      }

      const contextualError = new FirestorePermissionError({
        operation: 'get',
        path: memoizedDocRef.path,
      });

      setError(contextualError);
      setData(null);
      setIsLoading(false);

      // trigger global error propagation
      errorEmitter.emit('permission-error', contextualError);
    };

    // Modo LIVE (default): listener em tempo real.
    if (live) {
      const unsubscribe = onSnapshot(memoizedDocRef, aoReceber, aoFalhar);
      return () => unsubscribe();
    }

    // Modo UMA LEITURA (live:false): getDoc, sem listener.
    let cancelado = false;
    comRetry(() => getDoc(memoizedDocRef))
      .then((snapshot) => {
        if (!cancelado) aoReceber(snapshot);
      })
      .catch((err) => {
        if (!cancelado) aoFalhar(err as FirestoreError);
      });
    return () => {
      cancelado = true;
    };
  }, [memoizedDocRef, live, nonce]); // Re-run if ref/live/refetch changes.

  if(memoizedDocRef && !memoizedDocRef.__memo) {
    throw new Error('Document reference for path "' + memoizedDocRef.path + '" was not properly memoized using useMemoFirebase. This will cause infinite loops.');
  }

  return { data, isLoading, error, refetch };
}
