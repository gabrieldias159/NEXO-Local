// seed do usuário dev no modo LOCAL (emuladores).
//
// Idempotente: garante que o usuário dev (dev@local.nexo) exista no Auth
// emulator, com custom claims de admin e o perfil `users/{uid}` (role:'admin',
// isActive:true) no Firestore emulator.
//
// O perfil tem de ser criado aqui (Admin SDK) e NÃO pelo cliente: a regra
// Firestore só permite o próprio usuário criar o doc com role:'user'/isActive:false
// (ou o UID do admin-semente), então um `setDoc` com role:'admin' a partir do
// navegador é negado. Este script usa privilégios de emulador (Admin SDK),
// contornando as regras — como o seed-dev-user.mjs, porém cuidando de criar o
// usuário do zero (não depende de um UID já existente).
//
// Uso:
//   node scripts/nexo-seed-dev.mjs            # cria/garante o dev (UID bootstrap defaults)
//   node scripts/nexo-seed-dev.mjs <uid>      # usa um UID específico
//
// Requer os emuladores de auth (9099) e firestore (8080) já iniciados.
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GOOGLE_APPLICATION_CREDENTIALS = '';

const EMAIL = 'dev@local.nexo';
const SENHA = 'nexolocal123';
const DISPLAY_NAME = 'Dev Local';
// UID do admin-semente/produção é o ideal para o dev local: a regra Firestore o
// aceita como escotilha (pode criar doc de usuário admin/ativo) e o hook client
// `use-user` também o reconhece como bootstrap admin.
const UID_DEFAULT = 'sv2DRdmAkGO3AIH7K6YYIx8ydgi1';

const app = getApps().length === 0
  ? initializeApp({ projectId: 'studio-8612233125-caa0a' })
  : getApps()[0];

const uidPendente = process.argv[2] || UID_DEFAULT;

async function main() {
  const auth = getAuth(app);
  const db = getFirestore(app);

  // 1. Descobre/cria o usuário no Auth emulator pelo email.
  let uid;
  try {
    const found = await auth.getUserByEmail(EMAIL);
    uid = found.uid;
    console.log('usuario ja existe:', uid);
  } catch (e) {
    try {
      const created = await auth.createUser({
        uid: uidPendente,
        email: EMAIL,
        password: SENHA,
        displayName: DISPLAY_NAME,
        emailVerified: true,
      });
      uid = created.uid;
      console.log('usuario criado:', uid);
    } catch (e2) {
      if (e2?.code === 'auth/uid-already-exists' || /already exists/.test(String(e2?.message ?? ''))) {
        // Email/UID conflitante — cai para um UID gerado e repete a consulta.
        const created = await auth.createUser({
          email: EMAIL,
          password: SENHA,
          displayName: DISPLAY_NAME,
          emailVerified: true,
        });
        uid = created.uid;
        console.log('usuario criado (uid proprio):', uid);
      } else {
        throw e2;
      }
    }
  }

  // 2. Custom claims de admin.
  await auth.setCustomUserClaims(uid, { role: 'admin', admin: true });
  console.log('custom claims: role=admin, admin=true');

  // 3. Perfil no Firestore (bypass da regra via Admin SDK).
  await db.collection('users').doc(uid).set({
    role: 'admin',
    isActive: true,
    email: EMAIL,
    displayName: DISPLAY_NAME,
  });
  console.log('perfil firestore users/' + uid + ' gravado (role=admin, isActive=true)');

  // 4. Verificação final via signIn credenciais.
  console.log('OK: dev user pronto em users/' + uid);
}

main()
  .catch((e) => {
    console.error('FALHA:', e?.code ?? e);
    process.exitCode = 1;
  })
  .finally(() => {
    // Encerra de forma limpa para o processo sair.
    setTimeout(() => process.exit(process.exitCode ?? 0), 150);
  });