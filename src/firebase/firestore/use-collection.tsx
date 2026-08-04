'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Query,
  onSnapshot,
  getDocs,
  DocumentData,
  FirestoreError,
  QuerySnapshot,
  CollectionReference,
} from 'firebase/firestore';
import { errorEmitter } from '@/firebase/error-emitter';
import { FirestorePermissionError } from '@/firebase/errors';
import { isErroPermissao, comRetry } from '@/firebase/firestore/error-utils';

/** Utility type to add an 'id' field to a given type T. */
export type WithId<T> = T & { id: string };

/**
 * Interface for the return value of the useCollection hook.
 * @template T Type of the document data.
 */
export interface UseCollectionResult<T> {
  data: WithId<T>[] | null; // Document data with ID, or null.
  isLoading: boolean;       // True if loading.
  error: FirestoreError | Error | null; // Error object, or null.
  /** Refaz a leitura (útil no modo `live:false`; no-op de fato no modo live). */
  refetch: () => void;
}

/**
 * Opções do useCollection.
 * `live:false` troca o listener em tempo real (`onSnapshot`) por UMA leitura
 * (`getDocs`) — CORTA CUSTO de leitura do Firestore (o listener relê a coleção a
 * cada escrita, por aba aberta). Use em telas onde tempo-real não é essencial;
 * chame `refetch()` num botão "Atualizar" ou no foco da aba para recarregar.
 * Default `true` = comportamento antigo (nada muda para callers existentes).
 */
export interface UseCollectionOptions {
  live?: boolean;
}

/* Internal implementation of Query:
  https://github.com/firebase/firebase-js-sdk/blob/c5f08a9bc5da0d2b0207802c972d53724ccef055/packages/firestore/src/lite-api/reference.ts#L143
*/
export interface InternalQuery extends Query<DocumentData> {
  _query: {
    path: {
      canonicalString(): string;
      toString(): string;
    }
  }
}

/**
 * React hook to subscribe to a Firestore collection or query in real-time.
 * Handles nullable references/queries.
 * 
 *
 * IMPORTANT! YOU MUST MEMOIZE the inputted memoizedTargetRefOrQuery or BAD THINGS WILL HAPPEN
 * use useMemo to memoize it per React guidence.  Also make sure that it's dependencies are stable
 * references
 *  
 * @template T Optional type for document data. Defaults to any.
 * @param {CollectionReference<DocumentData> | Query<DocumentData> | null | undefined} targetRefOrQuery -
 * The Firestore CollectionReference or Query. Waits if null/undefined.
 * @returns {UseCollectionResult<T>} Object with data, isLoading, error.
 */
export function useCollection<T = any>(
    memoizedTargetRefOrQuery: ((CollectionReference<DocumentData> | Query<DocumentData>) & {__memo?: boolean})  | null | undefined,
    options?: UseCollectionOptions,
): UseCollectionResult<T> {
  type ResultItemType = WithId<T>;
  type StateDataType = ResultItemType[] | null;

  const live = options?.live ?? true;

  const [data, setData] = useState<StateDataType>(null);
  const [isLoading, setIsLoading] = useState<boolean>(!!memoizedTargetRefOrQuery);
  const [error, setError] = useState<FirestoreError | Error | null>(null);
  // `nonce` só serve para forçar reexecução do efeito no modo live:false (refetch).
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!memoizedTargetRefOrQuery) {
      setData(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    const aoReceber = (snapshot: QuerySnapshot<DocumentData>) => {
      const results: ResultItemType[] = [];
      for (const doc of snapshot.docs) {
        results.push({ ...(doc.data() as T), id: doc.id });
      }
      setData(results);
      setError(null);
      setIsLoading(false);
    };
    const aoFalhar = (error: FirestoreError) => {
      // This logic extracts the path from either a ref or a query
      const path: string =
        memoizedTargetRefOrQuery.type === 'collection'
          ? (memoizedTargetRefOrQuery as CollectionReference).path
          : (memoizedTargetRefOrQuery as unknown as InternalQuery)._query.path.canonicalString();

      // Falha de rede/backend transiente (ex.: "Could not reach backend",
      // modo offline). NÃO é problema de regra de segurança: mantém os dados
      // já recebidos (inclusive os do cache offline — a persistência IndexedDB)
      // e deixa o `onSnapshot` se reconectar sozinho. Não alarmamos o usuário
      // com um "permission error" que engana o diagnóstico.
      if (!isErroPermissao(error)) {
        setIsLoading(false);
        return;
      }

      const contextualError = new FirestorePermissionError({
        operation: 'list',
        path,
      });

      setError(contextualError);
      setData(null);
      setIsLoading(false);

      // trigger global error propagation
      errorEmitter.emit('permission-error', contextualError);
    };

    // Modo LIVE (default): listener em tempo real.
    if (live) {
      const unsubscribe = onSnapshot(memoizedTargetRefOrQuery, aoReceber, aoFalhar);
      return () => unsubscribe();
    }

    // Modo UMA LEITURA (live:false): getDocs, sem listener. Corta reads.
    let cancelado = false;
    comRetry(() => getDocs(memoizedTargetRefOrQuery))
      .then((snapshot) => {
        if (!cancelado) aoReceber(snapshot);
      })
      .catch((err) => {
        if (!cancelado) aoFalhar(err as FirestoreError);
      });
    return () => {
      cancelado = true;
    };
  }, [memoizedTargetRefOrQuery, live, nonce]); // Re-run if target/live/refetch changes.

  if(memoizedTargetRefOrQuery && !memoizedTargetRefOrQuery.__memo) {
    const path: string =
      memoizedTargetRefOrQuery.type === 'collection'
        ? (memoizedTargetRefOrQuery as CollectionReference).path
        : (memoizedTargetRefOrQuery as unknown as InternalQuery)._query.path.canonicalString();
    throw new Error('Collection reference/query for path "' + path + '" was not properly memoized using useMemoFirebase. This will cause infinite loops.');
  }
  return { data, isLoading, error, refetch };
}
