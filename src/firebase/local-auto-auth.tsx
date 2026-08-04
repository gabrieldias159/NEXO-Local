'use client';

/**
 * Login AUTOMÁTICO no modo LOCAL (emulador). Quando `NEXT_PUBLIC_USE_EMULATOR=1`
 * e não há usuário logado, entra sozinho com as credenciais de dev semeadas —
 * assim o NEXO abre já autenticado, sem passar pela tela de login.
 *
 * AUTO-CONSTRUTIVO: se o usuário dev não existir no emulador de auth (ex.:
 * emulador resetado no restart → EMAIL_NOT_FOUND), ele é CRIADO na hora via
 * `createUserWithEmailAndPassword`, o perfil `users/{uid}` é gravado (role
 * admin + isActive) e os custom claims são sincronizados via callable
 * `syncAdminClaims`. Ou seja: o login local nunca depende de seed manual.
 *
 * É NO-OP em produção (flag ausente) — lá o login normal continua valendo. As
 * credenciais são as do seed local (emulador), sem valor fora da máquina.
 */
import { useEffect, useRef } from 'react';
import {
  signInWithEmailAndPassword,
  signOut,
  createUserWithEmailAndPassword,
} from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { useFirebase } from '@/firebase/provider';
import { syncAdminClaims } from '@/firebase/admin/actions';
import { type FirebaseError } from 'firebase/app';

const ENABLED = process.env.NEXT_PUBLIC_USE_EMULATOR === '1';
const EMAIL = process.env.NEXT_PUBLIC_LOCAL_AUTH_EMAIL || 'dev@local.nexo';
const SENHA = process.env.NEXT_PUBLIC_LOCAL_AUTH_PASSWORD || 'nexolocal123';

const SLEEP_MS = 2000;
const MAX_TENTATIVAS = 90;

export function LocalAutoAuth(): null {
  const { auth, firestore, user, isUserLoading } = useFirebase();
  // Impede loop: após resetar o emulador, o SDK restaura do localStorage um
  // usuário fantasma (token inválido → 403 nas rules). Limpamos essa sessão
  // APENAS UMA VEZ no mount; dali em diante o fluxo normal (auto-login com o
  // dev) assume e `signOut` não volta a disparar sobre a sessão recém-criada.
  const limpouSessaoFantasma = useRef(false);

  useEffect(() => {
    if (!ENABLED || isUserLoading) return;

    if (user && !limpouSessaoFantasma.current) {
      limpouSessaoFantasma.current = true;
      console.info('[NEXO local] limpando sessao fantasma (emulador resetado).');
      signOut(auth).catch(() => {});
      return;
    }

    if (user) return;

    let cancelado = false;
    let tentativas = 0;

    const tentarCriarDev = async (): Promise<boolean> => {
      try {
        const cred = await createUserWithEmailAndPassword(auth, EMAIL, SENHA);
        const uid = cred.user.uid;
        console.info('[NEXO local] usuario dev criado no emulador:', uid);
        await setDoc(doc(firestore, 'users', uid), {
          role: 'admin',
          isActive: true,
          email: EMAIL,
          displayName: 'Dev Local',
        });
        // Propaga claims admin (callable) — best-effort, não trava o login.
        syncAdminClaims().catch(() => {});
        console.info(
          '[NEXO local] perfil users/' + uid + ' gravado + claims sincronizados.',
        );
        return true;
      } catch (e) {
        if (cancelado) return false;
        const err = e as FirebaseError;
        // EMAIL_EXISTS = outra aba já criou; o signIn do loop seguinte resolve.
        if (err?.code !== 'auth/email-already-in-use') {
          console.warn('[NEXO local] falha ao criar usuario dev:', err?.code ?? err);
        }
        return false;
      }
    };

    const entrar = async () => {
      if (cancelado) return;
      tentativas++;

      try {
        await signInWithEmailAndPassword(auth, EMAIL, SENHA);
        console.info('[NEXO local] login automatico OK — sem tela de login.');
      } catch (e) {
        const err = e as FirebaseError;
        if (cancelado) return;

        // Usuário dev ainda não existe (emulador resetado)? Cria na hora.
        if (tentativas === 1 || tentativas % 5 === 0) {
          const criado = await tentarCriarDev();
          // Criou → o `createUserWithEmailAndPassword` já assina; o efeito
          // re-executa com `user` setado. Não deixar um novo disparo pendente.
          if (criado || cancelado) return;
        }

        if (tentativas < MAX_TENTATIVAS) {
          setTimeout(entrar, SLEEP_MS);
        } else {
          console.warn(
            '[NEXO local] auto-login desistiu após ' +
              tentativas +
              ' tentativas:',
            err?.code ?? err,
          );
        }
      }
    };

    entrar();
    return () => {
      cancelado = true;
    };
  }, [auth, firestore, user, isUserLoading]);

  return null;
}