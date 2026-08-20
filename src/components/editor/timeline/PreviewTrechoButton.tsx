'use client';

/**
 * PRÉVIA DE TRECHO (recurso 17).
 *
 * Com um intervalo marcado na régua (Shift + arrastar), renderiza SÓ aquele
 * pedaço em 480p — dá para conferir um ajuste em segundos, sem esperar o
 * vídeo inteiro. A prévia não leva identidade nem vinheta, senão sairia mais
 * longa que o trecho pedido.
 *
 * Usa o mesmo caminho do export normal (`renderJobs` + Cloud Function), só
 * que com `exportSettings.trecho` e tier baixo.
 */

import * as React from 'react';
import { doc, onSnapshot, setDoc, Timestamp } from 'firebase/firestore';

import { Button } from '@/components/ui/button';
import { useFirestore } from '@/firebase/provider';
import { useUser } from '@/firebase/auth/use-user';
import { useEditorStore } from '@/lib/editor/store';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { EditorIcons } from '../shared/EditorIcons';

/** Trecho menor que isso não vale um render. */
const MIN_TRECHO = 0.3;

export function PreviewTrechoButton() {
  const firestore = useFirestore();
  const { user } = useUser();
  const { toast } = useToast();
  const loopRange = useEditorStore((s) => s.ui.loopRange);
  const createRenderJob = useEditorStore((s) => s.createRenderJob);

  const [jobId, setJobId] = React.useState<string | null>(null);
  const [progresso, setProgresso] = React.useState(0);
  const [url, setUrl] = React.useState<string | null>(null);

  const duracao = loopRange ? loopRange.end - loopRange.start : 0;
  const podeRenderizar = !!loopRange && duracao >= MIN_TRECHO && !jobId;

  // Acompanha o job até terminar.
  React.useEffect(() => {
    if (!firestore || !jobId) return;
    const ref = doc(firestore, 'renderJobs', jobId);
    const unsub = onSnapshot(ref, (snap) => {
      const d = snap.data() as
        | { status?: string; progress?: number; outputUrl?: string; error?: string }
        | undefined;
      if (!d) return;
      setProgresso(d.progress ?? 0);
      if (d.status === 'complete' && d.outputUrl) {
        setUrl(d.outputUrl);
        setJobId(null);
        toast({
          title: 'Prévia do trecho pronta',
          description: 'Abra pelo link ao lado do botão.',
        });
      } else if (d.status === 'error') {
        setJobId(null);
        toast({
          variant: 'destructive',
          title: 'A prévia falhou',
          description: d.error ?? 'Erro no render.',
        });
      }
    });
    return () => unsub();
  }, [firestore, jobId, toast]);

  const renderizar = async () => {
    if (!firestore || !user || !loopRange) return;
    const job = createRenderJob(
      {
        resolution: '480p',
        format: 'mp4',
        quality: 'low',
        burnCaptions: true,
        trecho: {
          start: Number(loopRange.start.toFixed(3)),
          end: Number(loopRange.end.toFixed(3)),
        },
      },
      'cloud-ffmpeg',
      user.uid,
    );
    if (!job) return;
    setUrl(null);
    setProgresso(0);
    try {
      await setDoc(doc(firestore, 'renderJobs', job.id), {
        id: job.id,
        projectId: job.projectId,
        ownerUid: job.ownerUid,
        engine: 'cloud-ffmpeg',
        tier: 'low',
        status: 'pending',
        progress: 0,
        exportSettings: job.exportSettings,
        createdAt: Timestamp.now(),
        // Prévia é descartável: 1 dia de TTL.
        expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
      });
      setJobId(job.id);
      toast({
        title: `Renderizando ${duracao.toFixed(1)}s em 480p…`,
        description: 'Só o trecho marcado, sem identidade nem vinheta.',
      });
    } catch (e) {
      toast({
        variant: 'destructive',
        title: 'Não deu para pedir a prévia',
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn('h-7 gap-1 px-2 text-[11px]', jobId && 'text-amber-400')}
        onClick={() => void renderizar()}
        disabled={!podeRenderizar || !user}
        title={
          loopRange
            ? `Renderiza só os ${duracao.toFixed(1)}s marcados na régua, em 480p — para conferir um ajuste sem exportar o vídeo inteiro.`
            : 'Marque um trecho na régua (Shift + arrastar) para renderizar só ele.'
        }
      >
        <EditorIcons.Play className="h-3.5 w-3.5" />
        {jobId ? `Prévia ${progresso}%` : 'Prévia do trecho'}
      </Button>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-emerald-600/60 px-1.5 py-0.5 text-[10px] text-emerald-400 hover:bg-emerald-600/10"
          title="Abrir a última prévia renderizada"
        >
          abrir prévia
        </a>
      )}
    </div>
  );
}
