import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GOOGLE_APPLICATION_CREDENTIALS = '';

const app = getApps().length === 0
  ? initializeApp({ projectId: 'studio-8612233125-caa0a' })
  : getApps()[0];

const uid = 'Dhx9xCNHot7fwVZMslo8nESPHIN4';

try {
  await getAuth().setCustomUserClaims(uid, { role: 'admin' });
  console.log('Custom claims set: role=admin');
} catch (e) {
  console.error('Erro ao setar claims:', e.message);
}

try {
  await getFirestore().collection('users').doc(uid).set({
    isActive: true,
    role: 'admin',
    email: 'dev@local.nexo',
    displayName: 'Dev Local',
  });
  console.log('Firestore profile created/updated');
} catch (e) {
  console.error('Erro ao criar profile:', e.message);
}

console.log('OK');
