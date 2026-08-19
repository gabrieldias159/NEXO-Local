'use client';

/**
 * Página do editor de vídeo para um projeto específico.
 *
 * - Lê `[projectId]` da rota.
 * - Carrega via `loadProject(firestore, projectId)` no useEffect.
 * - Hidrata o store com `loadProject(project)`.
 * - Renderiza `<SuiteVideoEditor skipBootstrap />`.
 * - Mostra loading + estados de erro (404, sem permissão).
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFirestore } from '@/firebase/provider';
import { useUser } from '@/firebase/auth/use-user';
import { loadProject } from '@/lib/editor/persistence';
import { useEditorStore } from '@/lib/editor/store';
import { SuiteVideoEditor } from '@/components/editor/SuiteVideoEditor';

export default function VideoProjectPage() {
  const router = useRouter();
  const params = useParams<{ projectId: string }>();
  const projectId = params?.projectId;
  const firestore = useFirestore();
  const { user, loading: userLoading } = useUser();
  const loadProjectIntoStore = useEditorStore((s) => s.loadProject);

  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    if (userLoading) return;
    if (!user) {
      setStatus('error');
      setError('Você precisa estar autenticado para abrir um projeto.');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    loadProject(firestore, projectId)
      .then((project) => {
        if (cancelled) return;
        if (project.ownerUid !== user.uid) {
          setStatus('error');
          setError('Você não tem acesso a este projeto.');
          return;
        }
        loadProjectIntoStore(project);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('[project/load] erro:', err);
        setStatus('error');
        setError(
          err instanceof Error ? err.message : 'Erro ao carregar projeto.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [firestore, projectId, user, userLoading, loadProjectIntoStore]);

  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Carregando projeto...</span>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md space-y-4 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertCircle className="h-6 w-6 text-destructive" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Não foi possível abrir</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
          <Button
            variant="outline"
            onClick={() => router.push('/apps/suite-editor-videos/projects')}
          >
            Voltar à lista de projetos
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <SuiteVideoEditor projectId={projectId} skipBootstrap />
      </div>
    </div>
  );
}
