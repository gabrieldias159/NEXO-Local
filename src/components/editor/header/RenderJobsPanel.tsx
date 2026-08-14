'use client';

/**
 * RenderJobsPanel — painel lateral listando todos os render jobs do usuário.
 *
 * Mostra:
 *  - Ícone com badge de contagem ativa (pending/rendering) no header.
 *  - Sheet/popover ao clicar: lista paginada de jobs com status, progresso,
 *    e botão Baixar/Abrir quando concluído.
 *  - Atualiza em tempo real via `onSnapshot` na collection `renderJobs`
 *    filtrada por `ownerUid`.
 *
 * Útil quando o usuário fecha o ExportDialog mas quer acompanhar o
 * progresso de renders em andamento sem voltar pra modal.
 */

import { useState, useMemo, useEffect } from 'react';
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  doc,
  updateDoc,
  deleteDoc,
  Timestamp,
} from 'firebase/firestore';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from '@/components/ui/sheet';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFirestore, useUser } from '@/firebase';
import { useToast } from '@/hooks/use-toast';
import { cn, truncateFilename } from '@/lib/utils';
import {
  ListChecks,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Download,
  ExternalLink,
  X,
  Clock,
  Trash2,
  Film,
} from 'lucide-react';
import type { RenderJob } from '@/lib/editor/types';

interface RenderJobsPanelProps {
  className?: string;
  /**
   * Variante do trigger: 'icon' (default — botao circular pro header do editor)
   * ou 'inline' (botao com texto pra outros lugares, ex: lista de projetos).
   */
  triggerVariant?: 'icon' | 'inline';
  /** Texto do botao no modo inline. Default: "Renderizacoes". */
  triggerLabel?: string;
}

interface JobDoc extends Partial<RenderJob> {
  id: string;
}

function formatRelative(ts: Timestamp | undefined): string {
  if (!ts) return '';
  try {
    const date = ts.toDate();
    const diff = (Date.now() - date.getTime()) / 1000;
    if (diff < 60) return 'agora';
    if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
    return `${Math.floor(diff / 86400)}d atrás`;
  } catch {
    return '';
  }
}

function statusBadge(status: RenderJob['status'] | undefined) {
  switch (status) {
    case 'pending':
      return (
        <Badge variant="secondary" className="gap-1 text-[10px]">
          <Clock className="h-2.5 w-2.5" />
          Na fila
        </Badge>
      );
    case 'rendering':
      return (
        <Badge variant="secondary" className="gap-1 text-[10px] bg-blue-500/15 text-blue-700 dark:text-blue-300">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          Renderizando
        </Badge>
      );
    case 'complete':
      return (
        <Badge variant="success" className="gap-1 text-[10px]">
          <CheckCircle className="h-2.5 w-2.5" />
          Concluído
        </Badge>
      );
    case 'error':
      return (
        <Badge variant="destructive" className="gap-1 text-[10px]">
          <AlertTriangle className="h-2.5 w-2.5" />
          Erro
        </Badge>
      );
    case 'cancelled':
      return (
        <Badge variant="outline" className="gap-1 text-[10px]">
          Cancelado
        </Badge>
      );
    default:
      return null;
  }
}

export function RenderJobsPanel({
  className,
  triggerVariant = 'icon',
  triggerLabel = 'Renderizações',
}: RenderJobsPanelProps) {
  const firestore = useFirestore();
  const { user } = useUser();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [jobToDelete, setJobToDelete] = useState<JobDoc | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Subscribe to user's render jobs (real-time).
  useEffect(() => {
    if (!firestore || !user?.uid) {
      setJobs([]);
      setIsLoading(false);
      return;
    }
    const q = query(
      collection(firestore, 'renderJobs'),
      where('ownerUid', '==', user.uid),
      orderBy('createdAt', 'desc'),
      limit(30),
    );
    setIsLoading(true);
    const unsub = onSnapshot(
      q,
      (snap) => {
        setJobs(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Partial<RenderJob>) })),
        );
        setIsLoading(false);
      },
      (err) => {
        console.warn('[RenderJobsPanel] subscription error:', err);
        setIsLoading(false);
      },
    );
    return () => unsub();
  }, [firestore, user?.uid]);

  const activeCount = useMemo(
    () => jobs.filter((j) => j.status === 'pending' || j.status === 'rendering').length,
    [jobs],
  );

  const handleCancel = async (jobId: string) => {
    if (!firestore) return;
    try {
      await updateDoc(doc(firestore, 'renderJobs', jobId), { status: 'cancelled' });
      toast({ title: 'Cancelando…', description: 'O worker abortará no próximo checkpoint.' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: 'Erro ao cancelar', description: msg, variant: 'destructive' });
    }
  };

  /**
   * Apaga o renderJob do Firestore. O arquivo do Storage em `outputPath`
   * eh removido pelo trigger Cloud Function `onRenderJobDeleted` (mesma
   * logica usada pelo TTL de 14 dias).
   */
  const handleDelete = async () => {
    if (!firestore || !jobToDelete?.id) return;
    setDeleting(true);
    try {
      await deleteDoc(doc(firestore, 'renderJobs', jobToDelete.id));
      toast({
        title: 'Task removida',
        description: jobToDelete.outputPath
          ? 'O vídeo do Storage será apagado em alguns segundos.'
          : 'A task foi excluída.',
      });
      setJobToDelete(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: 'Erro ao apagar', description: msg, variant: 'destructive' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {triggerVariant === 'inline' ? (
          <Button
            variant="outline"
            className={cn('gap-2 relative', className)}
            title="Tasks de renderização"
            aria-label="Tasks de renderização"
          >
            <ListChecks className="h-4 w-4" />
            {triggerLabel}
            {activeCount > 0 && (
              <span className="ml-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                {activeCount}
              </span>
            )}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-8 w-8 relative', className)}
            title="Processamentos em andamento"
            aria-label="Processamentos em andamento"
          >
            <ListChecks className="h-4 w-4" />
            {activeCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold text-primary-foreground">
                {activeCount}
              </span>
            )}
          </Button>
        )}
      </SheetTrigger>

      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col gap-0">
        <SheetHeader className="border-b px-4 py-3 shrink-0">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ListChecks className="h-4 w-4" />
            Renderizações
          </SheetTitle>
          <SheetDescription className="text-xs">
            Acompanhe o progresso dos seus exports. Atualização em tempo real.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="p-3 space-y-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !user ? (
              <div className="text-center py-8 text-xs text-muted-foreground">
                Faça login pra ver suas renderizações.
              </div>
            ) : jobs.length === 0 ? (
              <div className="text-center py-8 text-xs text-muted-foreground">
                Nenhum render ainda. Use o botão <span className="font-semibold">Exportar</span>{' '}
                pra começar.
              </div>
            ) : (
              jobs.map((job) => {
                const isActive = job.status === 'pending' || job.status === 'rendering';
                const isComplete = job.status === 'complete';
                const isError = job.status === 'error';
                const fmt = job.exportSettings?.format ?? 'mp4';
                const fileName = `render-${job.id?.slice(0, 8)}.${fmt}`;
                return (
                  <div
                    key={job.id}
                    className={cn(
                      'rounded-lg border bg-card p-3 space-y-2 transition-colors',
                      isComplete && 'border-emerald-500/30 bg-emerald-500/5',
                      isError && 'border-destructive/30 bg-destructive/5',
                    )}
                  >
                    {/* Header: status + timestamp */}
                    <div className="flex items-center justify-between gap-2">
                      {statusBadge(job.status)}
                      <span className="text-[10px] text-muted-foreground">
                        {formatRelative(job.createdAt as Timestamp | undefined)}
                      </span>
                    </div>

                    {/* Capa (thumbnail) + Filename + meta.
                        A capa eh gerada server-side pelo trigger
                        `onRenderJobThumbnail` ~1s apos o render concluir; ate la
                        (ou em jobs antigos sem backfill) mostra placeholder. */}
                    <div className="flex items-start gap-2.5">
                      {isComplete && (
                        <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded-md border bg-muted">
                          {job.thumbnailUrl ? (
                            // NAO usar <Image> do Next p/ URL do Storage (token).
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={job.thumbnailUrl}
                              alt={`Capa do render ${fileName}`}
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center">
                              <Film className="h-5 w-5 text-muted-foreground/60" />
                            </div>
                          )}
                        </div>
                      )}
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="text-xs font-medium truncate" title={fileName}>
                          {truncateFilename(fileName, 40, 8)}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {job.exportSettings?.resolution ?? '—'} · {fmt.toUpperCase()}
                          {job.tier && (
                            <>
                              {' · '}
                              <span className="uppercase font-mono">{job.tier}</span>
                            </>
                          )}
                        </p>
                      </div>
                    </div>

                    {/* Progress bar */}
                    {isActive && (
                      <div className="space-y-1">
                        <Progress value={job.progress ?? 0} className="h-1.5" />
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>{job.progress ?? 0}%</span>
                          <button
                            type="button"
                            onClick={() => job.id && handleCancel(job.id)}
                            className="text-destructive hover:underline flex items-center gap-1"
                          >
                            <X className="h-2.5 w-2.5" />
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Error message */}
                    {isError && job.error && (
                      <p className="text-[10px] text-destructive break-words" title={job.error}>
                        {job.error.length > 120 ? job.error.slice(0, 120) + '…' : job.error}
                      </p>
                    )}

                    {/* Saved to recortes indicator */}
                    {isComplete && job.savedVideoId && (
                      <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                        ✓ Salvo em Recortes
                      </p>
                    )}

                    {/* Download / Open buttons */}
                    {isComplete && job.outputUrl && (
                      <div className="flex gap-1.5 pt-1">
                        <Button asChild size="sm" className="flex-1 h-7 text-xs">
                          <a href={job.outputUrl} download={fileName}>
                            <Download className="h-3 w-3 mr-1.5" />
                            Baixar
                          </a>
                        </Button>
                        <Button asChild size="sm" variant="outline" className="flex-1 h-7 text-xs">
                          <a href={job.outputUrl} target="_blank" rel="noreferrer">
                            <ExternalLink className="h-3 w-3 mr-1.5" />
                            Abrir
                          </a>
                        </Button>
                      </div>
                    )}

                    {/* Botao apagar (so para jobs finalizados — nao trava active em
                        andamento; pra cancelar, usar o botao Cancelar) */}
                    {!isActive && (
                      <div className="flex justify-end pt-1">
                        <button
                          type="button"
                          onClick={() => setJobToDelete(job)}
                          className="text-[10px] text-muted-foreground hover:text-destructive flex items-center gap-1"
                          title="Apagar task e vídeo do Storage"
                        >
                          <Trash2 className="h-2.5 w-2.5" />
                          Apagar
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>

        {/* Footer: rodape com info de auto-delete */}
        <div className="border-t px-4 py-2 text-[10px] text-muted-foreground shrink-0">
          Tasks são auto-removidas (com o vídeo) após 14 dias.
        </div>
      </SheetContent>

      <AlertDialog
        open={!!jobToDelete}
        onOpenChange={(o) => !o && !deleting && setJobToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Apagar task de renderização?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {jobToDelete?.outputPath
                ? 'A task será removida e o vídeo renderizado será apagado do Storage. Esta ação não pode ser desfeita.'
                : 'A task será removida. Esta ação não pode ser desfeita.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
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
                  Apagar
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
