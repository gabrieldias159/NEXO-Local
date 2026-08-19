'use client';

/**
 * Lista de projetos do usuário (Suite Editor de Vídeos).
 *
 * - Carrega via `listUserProjects(firestore, ownerUid)`.
 * - Cards: nome, lastUpdated, duração total.
 * - Click → navega para `/apps/suite-editor-videos/[projectId]`.
 * - "Novo projeto" → modal nome + resolução → `createNewProject` → redirect.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Film, Loader2, Trash2, AlertTriangle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useFirestore, useStorage } from '@/firebase/provider';
import { useUser } from '@/firebase/auth/use-user';
import { cn } from '@/lib/utils';
import {
  createNewProject,
  deleteProject,
  listUserProjects,
} from '@/lib/editor/persistence';
import type { ResolutionPreset, VideoProject } from '@/lib/editor/types';
import { useToast } from '@/hooks/use-toast';
import { RenderJobsPanel } from '@/components/editor/header/RenderJobsPanel';

const RESOLUTIONS: Array<{
  key: string;
  preset: ResolutionPreset;
  aspect: '16:9' | '9:16' | '1:1' | '4:5';
  platforms: string;
}> = [
  {
    key: '1080-landscape',
    preset: { width: 1920, height: 1080, label: 'Horizontal 16:9 · 1080p' },
    aspect: '16:9',
    platforms: 'YouTube, Facebook, Twitter, vídeos do site',
  },
  {
    key: '720-landscape',
    preset: { width: 1280, height: 720, label: 'Horizontal 16:9 · 720p' },
    aspect: '16:9',
    platforms: 'YouTube, Facebook (qualidade menor)',
  },
  {
    key: '1080-portrait',
    preset: { width: 1080, height: 1920, label: 'Vertical 9:16 · 1080p' },
    aspect: '9:16',
    platforms: 'Instagram Reels/Stories, TikTok, YouTube Shorts, Kwai',
  },
  {
    key: '720-portrait',
    preset: { width: 720, height: 1280, label: 'Vertical 9:16 · 720p' },
    aspect: '9:16',
    platforms: 'Reels/Stories, TikTok (qualidade menor)',
  },
  {
    key: 'square',
    preset: { width: 1080, height: 1080, label: 'Quadrado 1:1 · 1080p' },
    aspect: '1:1',
    platforms: 'Instagram Feed, Facebook Feed',
  },
  {
    key: 'feed-4-5',
    preset: { width: 1080, height: 1350, label: 'Retrato 4:5 · Feed' },
    aspect: '4:5',
    platforms: 'Instagram Feed (retrato), Facebook Feed',
  },
];

function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(s: number): string {
  if (!s || s <= 0) return '--';
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60)
    .toString()
    .padStart(2, '0');
  return `${mm}:${ss}`;
}

export default function VideoProjectsListPage() {
  const router = useRouter();
  const firestore = useFirestore();
  const storage = useStorage();
  const { user, loading: userLoading } = useUser();
  const { toast } = useToast();

  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('Novo projeto');
  const [newResKey, setNewResKey] = useState<string>('1080-landscape');
  const [newStageMode, setNewStageMode] = useState<'single' | 'split-vertical'>('single');
  const [creating, setCreating] = useState(false);

  // Load lista.
  useEffect(() => {
    if (userLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listUserProjects(firestore, user.uid)
      .then((rows) => {
        if (!cancelled) setProjects(rows);
      })
      .catch((err: unknown) => {
        console.error('[projects/list] erro:', err);
        toast({
          variant: 'destructive',
          title: 'Erro ao carregar projetos',
          description: err instanceof Error ? err.message : 'Tente novamente.',
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [firestore, user, userLoading, reloadKey, toast]);

  const handleCreate = async () => {
    if (!user) return;
    const preset =
      RESOLUTIONS.find((r) => r.key === newResKey)?.preset ??
      RESOLUTIONS[0].preset;
    setCreating(true);
    try {
      const created = await createNewProject(
        firestore,
        user.uid,
        newName.trim() || 'Novo projeto',
        preset,
        newStageMode,
      );
      setCreateOpen(false);
      router.push(`/apps/suite-editor-videos/${created.id}`);
    } catch (err: unknown) {
      console.error('[projects/create] erro:', err);
      toast({
        variant: 'destructive',
        title: 'Erro ao criar projeto',
        description: err instanceof Error ? err.message : 'Tente novamente.',
      });
    } finally {
      setCreating(false);
    }
  };

  const [projectToDelete, setProjectToDelete] = useState<VideoProject | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleConfirmDelete = async () => {
    if (!projectToDelete) return;
    setDeleting(true);
    try {
      await deleteProject(firestore, projectToDelete.id, storage);
      setReloadKey((k) => k + 1);
      toast({ title: 'Projeto apagado.' });
      setProjectToDelete(null);
    } catch (err: unknown) {
      console.error('[projects/delete] erro:', err);
      toast({
        variant: 'destructive',
        title: 'Erro ao apagar projeto',
        description: err instanceof Error ? err.message : 'Tente novamente.',
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto h-full w-full max-w-6xl space-y-6 overflow-y-auto p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
            Meus projetos de vídeo
          </h1>
          <p className="text-muted-foreground">
            Gerencie e abra projetos do Suite Editor.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RenderJobsPanel triggerVariant="inline" triggerLabel="Renderizações" />
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" /> Novo projeto
              </Button>
            </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Novo projeto de vídeo</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="project-name">Nome</Label>
                <Input
                  id="project-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Novo projeto"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="project-resolution">Formato</Label>
                <Select value={newResKey} onValueChange={setNewResKey}>
                  <SelectTrigger id="project-resolution">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOLUTIONS.map((r) => (
                      <SelectItem key={r.key} value={r.key}>
                        <div className="flex flex-col items-start gap-0.5 py-0.5">
                          <span className="font-medium">
                            {r.preset.label}
                            <span className="ml-1 text-xs text-muted-foreground">
                              ({r.preset.width}×{r.preset.height})
                            </span>
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {r.platforms}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(() => {
                  const sel = RESOLUTIONS.find((r) => r.key === newResKey);
                  if (!sel) return null;
                  return (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {sel.aspect}
                      </span>{' '}
                      — Compatível com: {sel.platforms}
                    </p>
                  );
                })()}
              </div>

              <div className="space-y-2">
                <Label>Modelo de palco</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setNewStageMode('single')}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-md border p-3 text-left text-xs transition-colors',
                      newStageMode === 'single'
                        ? 'border-primary bg-primary/5'
                        : 'hover:bg-accent',
                    )}
                  >
                    <div className="flex h-12 w-full items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                      Palco único
                    </div>
                    <p className="font-medium">Único</p>
                    <p className="text-[10px] text-muted-foreground">
                      Vídeo cobre toda a tela
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewStageMode('split-vertical')}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-md border p-3 text-left text-xs transition-colors',
                      newStageMode === 'split-vertical'
                        ? 'border-primary bg-primary/5'
                        : 'hover:bg-accent',
                    )}
                  >
                    <div className="flex h-12 w-full flex-col overflow-hidden rounded bg-muted">
                      <div className="flex-1 border-b border-background/60 bg-primary/20 text-[9px] flex items-center justify-center text-muted-foreground">
                        Palco 1
                      </div>
                      <div className="flex-1 bg-primary/10 text-[9px] flex items-center justify-center text-muted-foreground">
                        Palco 2 (IA)
                      </div>
                    </div>
                    <p className="font-medium">Split vertical</p>
                    <p className="text-[10px] text-muted-foreground">
                      Pessoa em cima, conteúdo gerado por IA embaixo
                    </p>
                  </button>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={creating}
              >
                Cancelar
              </Button>
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Criando...
                  </>
                ) : (
                  'Criar projeto'
                )}
              </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !user ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Faça login para ver seus projetos.
          </CardContent>
        </Card>
      ) : projects.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <Film className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">
              Você ainda não tem projetos. Crie o primeiro!
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              onDelete={() => setProjectToDelete(p)}
            />
          ))}
        </div>
      )}

      <AlertDialog
        open={!!projectToDelete}
        onOpenChange={(o) => !o && !deleting && setProjectToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Apagar projeto?
            </AlertDialogTitle>
            <AlertDialogDescription>
              O projeto{' '}
              <span className="font-semibold text-foreground">
                "{projectToDelete?.name}"
              </span>{' '}
              será excluído permanentemente. Esta ação não pode ser desfeita —
              tracks, clips, recortes de áudio e qualquer trabalho não exportado
              serão perdidos.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Apagando…
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Apagar projeto
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProjectCard({
  project,
  onDelete,
}: {
  project: VideoProject;
  onDelete: () => void;
}) {
  const updatedSeconds =
    typeof project.updatedAt === 'object' && 'seconds' in project.updatedAt
      ? (project.updatedAt as { seconds: number }).seconds
      : 0;
  return (
    <Card className="relative overflow-hidden transition hover:border-primary/50 hover:shadow-md">
      <Link href={`/apps/suite-editor-videos/${project.id}`} className="block">
        <div className="flex aspect-video items-center justify-center bg-muted">
          <Film className="h-12 w-12 text-muted-foreground" />
        </div>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="line-clamp-1 text-base">
            {project.name}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 p-4 pt-0 text-xs text-muted-foreground">
          <div>{project.resolution.label}</div>
          <div>Duração: {formatDuration(project.duration)}</div>
          <div>Atualizado em {formatDate(updatedSeconds)}</div>
        </CardContent>
      </Link>
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 h-8 w-8 text-muted-foreground hover:text-destructive"
        onClick={(e) => {
          e.preventDefault();
          onDelete();
        }}
        title="Apagar projeto"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </Card>
  );
}
