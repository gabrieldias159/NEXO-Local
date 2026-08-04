'use client';

import { useMemo } from 'react';
import { type User } from 'firebase/auth';
import { useFirebase, useFirestore, useMemoFirebase } from '../provider';
import { UserProfile } from '@/lib/types';
import { useDoc } from '../firestore/use-doc';
import { doc, Firestore } from 'firebase/firestore';

const LOCAL_BYPASS = process.env.NEXT_PUBLIC_USE_EMULATOR === '1';

interface UseUserReturn {
  user: (User & UserProfile) | null;
  loading: boolean;
  /** Alias de `loading` — usado pela maioria dos call-sites (telas de oficios,
   * requerimentos, indicacoes, projetos-de-lei). Mantemos ambos para nao
   * quebrar consumidores que leem `loading` (ex.: video-editor). */
  isUserLoading: boolean;
}

export const useUser = (): UseUserReturn => {
  const { user: authUser, isUserLoading: authLoading } = useFirebase();
  const firestore = useFirestore() as Firestore;

  const userProfileRef = useMemoFirebase(() => {
    if (!firestore || !authUser) return null;
    return doc(firestore, 'users', authUser.uid);
  }, [firestore, authUser]);
  
  const { data: userProfile, isLoading: profileLoading } = useDoc(userProfileRef);

  const mergedUser = useMemo(() => {
    if (!authUser) {
      return null;
    }

    const dbRole = (userProfile as UserProfile)?.role;
    const isBootstrapAdmin = authUser.uid === (process.env.NEXT_PUBLIC_BOOTSTRAP_ADMIN_UID ?? '');
    const baseUser = {
      ...authUser,
      ...(userProfile as UserProfile),
    };

    if (LOCAL_BYPASS) {
      return {
        ...baseUser,
        isActive: true,
        role: isBootstrapAdmin ? 'admin' : (dbRole ?? 'admin'),
      } as User & UserProfile;
    }

    // If the user is the bootstrap admin, their role is always 'admin' for the client.
    // Otherwise, we rely on the role defined in their Firestore document.
    return {
      ...baseUser,
      role: isBootstrapAdmin ? 'admin' : dbRole,
    };
  }, [authUser, userProfile]);


  const loading = authLoading || profileLoading;
  return { user: mergedUser, loading, isUserLoading: loading };
};
