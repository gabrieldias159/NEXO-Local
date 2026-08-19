/**
 * Ativa o usuario de desenvolvimento local no emulador.
 *
 * As rules do NEXO exigem `isActiveUser()`, que so passa se existir
 * `users/{uid}` com `isActive: true` (ou claim de admin). Sem isso toda
 * leitura de colecao `nexo_*` volta 403 e a home do NEXO quebra com
 * "Firestore runQuery HTTP 403".
 *
 * O uid NAO e fixo: quem cria o usuario e o auto-login (`local-auto-auth`),
 * e a cada base de auth zerada ele nasce com um uid novo. Por isso aqui a
 * resolucao e por E-MAIL, criando o usuario se ainda nao existir.
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GOOGLE_APPLICATION_CREDENTIALS = '';

const EMAIL = process.env.NEXO_DEV_EMAIL || 'dev@local.nexo';
const SENHA = process.env.NEXO_DEV_SENHA || 'nexolocal123';

if (getApps().length === 0) {
  initializeApp({ projectId: 'studio-8612233125-caa0a' });
}

const auth = getAuth();
const db = getFirestore();

let user;
try {
  user = await auth.getUserByEmail(EMAIL);
  console.log(`Usuario encontrado: ${EMAIL} (uid ${user.uid})`);
} catch {
  user = await auth.createUser({
    email: EMAIL,
    password: SENHA,
    displayName: 'Dev Local',
    emailVerified: true,
  });
  console.log(`Usuario criado: ${EMAIL} (uid ${user.uid})`);
}

await auth.setCustomUserClaims(user.uid, { role: 'admin' });
console.log('Claims: role=admin');

await db.collection('users').doc(user.uid).set(
  {
    isActive: true,
    role: 'admin',
    email: EMAIL,
    displayName: 'Dev Local',
  },
  { merge: true },
);
console.log('Perfil users/{uid} com isActive=true');

// Higiene: perfis orfaos de uids antigos so poluem a colecao.
const orfaos = await db.collection('users').where('email', '==', EMAIL).get();
const apagar = orfaos.docs.filter((d) => d.id !== user.uid);
for (const d of apagar) await d.ref.delete();
if (apagar.length) console.log(`Removidos ${apagar.length} perfil(is) orfao(s) de uid antigo`);

console.log('OK');
