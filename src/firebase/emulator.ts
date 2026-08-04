'use client';

/**
 * Aponta o SDK cliente do Firebase para o Firebase Emulator Suite quando
 * `NEXT_PUBLIC_USE_EMULATOR=1` (desenvolvimento local). Em produção (flag
 * ausente) é um NO-OP — o app fala com o Firebase real, sem mudança de
 * comportamento.
 *
 * `initializeFirebase()` (em `./index`) é marcado "DO NOT MODIFY"; por isso a
 * conexão com os emuladores é feita AQUI, chamada uma única vez pelo
 * `FirebaseClientProvider` logo após a inicialização, ANTES de qualquer uso dos
 * SDKs (exigência do `connectFirestoreEmulator`, que lança se o Firestore já foi
 * usado).
 *
 * Portas: as mesmas do `firebase.json` → auth 9099, firestore 8080, storage 9199.
 */
import { connectAuthEmulator, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, type Firestore } from 'firebase/firestore';
import { connectStorageEmulator, type FirebaseStorage } from 'firebase/storage';

const USE_EMULATOR = process.env.NEXT_PUBLIC_USE_EMULATOR === '1';
const HOST = process.env.NEXT_PUBLIC_EMULATOR_HOST || '127.0.0.1';

let jaConectou = false;

export function connectEmulatorsOnce(sdks: {
  auth: Auth;
  firestore: Firestore;
  storage: FirebaseStorage;
}): void {
  // Só no browser, só quando a flag está ligada, só uma vez (StrictMode
  // remonta os componentes — o guard evita o 2º connect, que lançaria).
  if (!USE_EMULATOR || jaConectou || typeof window === 'undefined') return;
  jaConectou = true;

  connectAuthEmulator(sdks.auth, `http://${HOST}:9099`, {
    disableWarnings: true,
  });
  connectFirestoreEmulator(sdks.firestore, HOST, 8080);
  connectStorageEmulator(sdks.storage, HOST, 9199);

  // eslint-disable-next-line no-console
  console.info(
    '%c[NEXO local]%c Firebase apontado para os EMULADORES (auth:9099 · firestore:8080 · storage:9199). Nenhuma chamada vai para produção.',
    'color:#22c55e;font-weight:bold',
    'color:inherit',
  );
}
