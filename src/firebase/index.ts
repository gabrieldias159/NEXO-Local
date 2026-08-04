'use client';

import { firebaseConfig } from '@/firebase/config';
import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore, getFirestore, Firestore, FirestoreSettings, CACHE_SIZE_UNLIMITED, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

// IMPORTANT: DO NOT MODIFY THIS FUNCTION
export function initializeFirebase() {
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return getSdks(app);
}

export function getSdks(firebaseApp: FirebaseApp) {
  // Initialize storage using the default bucket from the Firebase config.
  // This is the most robust method.
  const storage = getStorage(firebaseApp);

  // Enable offline resilience with IndexedDB so the app keeps working when the
  // Firebase backend is unreachable — reads fall back to the local cache and
  // writes sync automatically once the connection is restored.
  let firestore: Firestore;
  try {
    const firestoreSettings: FirestoreSettings = {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
        cacheSizeBytes: CACHE_SIZE_UNLIMITED,
      }),
    };
    firestore = initializeFirestore(firebaseApp, firestoreSettings);
  } catch {
    // Already initialized or persistent cache unavailable — fall back to the
    // shared instance without failing the whole SDK bootstrap.
    firestore = getFirestore(firebaseApp);
  }

  return {
    firebaseApp,
    auth: getAuth(firebaseApp),
    firestore,
    storage: storage,
  };
}

export * from './provider';
export * from './client-provider';
export * from './firestore/use-collection';
export * from './firestore/use-doc';
export * from './firestore/error-utils';
export * from './auth/use-user';
export * from './non-blocking-updates';
export * from './non-blocking-login';
export * from './errors';
export * from './error-emitter';
