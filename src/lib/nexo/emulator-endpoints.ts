/**
 * Endereços das APIs REST do Google usadas pelas rotas server-side (Identity
 * Toolkit e Firestore REST).
 *
 * As rotas do NEXO (e do Acervo/telemetria) NÃO usam `firebase-admin`: elas
 * falam com o Identity Toolkit (`accounts:lookup`) e com o Firestore
 * (`:runQuery` / documents) via REST, carregando o ID token do próprio usuário.
 * As bases dessas URLs eram fixas nos hosts LIVE do Google — o que impedia rodar
 * o app contra o Firebase Emulator Suite.
 *
 * Este módulo centraliza a escolha da base:
 *   - PRODUÇÃO (padrão): hosts LIVE do Google — comportamento idêntico ao antigo.
 *   - LOCAL (`NEXO_USE_EMULATOR=1`): emulador na máquina — permite rodar o NEXO
 *     100% local, sem custo de Firestore/Auth e sem tocar o projeto de produção.
 *
 * Os hosts do emulador seguem o padrão do Firebase Emulator Suite e podem ser
 * sobrescritos pelas envs oficiais `FIREBASE_AUTH_EMULATOR_HOST` /
 * `FIRESTORE_EMULATOR_HOST` (as mesmas que o `firebase-admin` respeita).
 */
import { firebaseConfig } from '@/firebase/config';

/** Liga o modo emulador para as chamadas REST server-side. */
export const USING_EMULATOR = process.env.NEXO_USE_EMULATOR === '1';

const AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const STORAGE_EMULATOR_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';

/**
 * Base do Identity Toolkit até `/v1` (o caller acrescenta `/accounts:lookup`
 * etc.). No emulador, o Auth serve a API do Google sob o próprio host, com o
 * caminho `identitytoolkit.googleapis.com` prefixado.
 */
export function identityToolkitBase(): string {
  return USING_EMULATOR
    ? `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`
    : 'https://identitytoolkit.googleapis.com/v1';
}

/**
 * Base REST do Firestore até `.../documents` (banco `(default)`). O caller
 * acrescenta `/users/{uid}`, `:runQuery`, etc. No emulador, o Firestore expõe a
 * mesma superfície REST na raiz do seu host.
 */
export function firestoreDocumentsBase(): string {
  const root = USING_EMULATOR
    ? `http://${FIRESTORE_EMULATOR_HOST}/v1`
    : 'https://firestore.googleapis.com/v1';
  return `${root}/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
}

/**
 * Base de DOWNLOAD do Firebase Storage até `.../o` (o caller acrescenta
 * `/{path}?alt=media`). No emulador, o Storage expõe a mesma API de download.
 */
export function storageDownloadBase(): string {
  const root = USING_EMULATOR
    ? `http://${STORAGE_EMULATOR_HOST}/v0`
    : 'https://firebasestorage.googleapis.com/v0';
  return `${root}/b/${firebaseConfig.storageBucket}/o`;
}
