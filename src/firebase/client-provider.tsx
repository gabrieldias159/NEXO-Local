'use client';

import React, { useMemo, type ReactNode } from 'react';
import { FirebaseProvider } from '@/firebase/provider';
import { initializeFirebase } from '@/firebase';
import { connectEmulatorsOnce } from '@/firebase/emulator';
import { LocalAutoAuth } from '@/firebase/local-auto-auth';

interface FirebaseClientProviderProps {
  children: ReactNode;
}

export function FirebaseClientProvider({
  children,
}: FirebaseClientProviderProps) {
  const firebaseServices = useMemo(() => {
    // Initialize Firebase on the client side, once per component mount.
    const services = initializeFirebase();
    // Local (emulador): redireciona os SDKs ANTES de qualquer uso. NO-OP em
    // produção (flag NEXT_PUBLIC_USE_EMULATOR ausente).
    connectEmulatorsOnce(services);
    return services;
  }, []); // Empty dependency array ensures this runs only once on mount

  return (
    <FirebaseProvider
      firebaseApp={firebaseServices.firebaseApp}
      auth={firebaseServices.auth}
      firestore={firebaseServices.firestore}
      storage={firebaseServices.storage}
    >
      <LocalAutoAuth />
      {children}
    </FirebaseProvider>
  );
}
