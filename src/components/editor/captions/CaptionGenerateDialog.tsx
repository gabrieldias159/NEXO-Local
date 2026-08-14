'use client';

/**
 * Dialog "Gerar legendas com IA".
 *
 * Fluxo:
 *  1. Usuário escolhe idioma + modelo Gemini + mixagem (browser ou server).
 *  2. Submit:
 *     a) se "mixar no navegador" estiver marcado, tenta `mixProjectAudioClient`.
 *     b) se a mixagem retornar `null` (>10min) ou falhar, cai pro server.
 *     c) chama `requestCaptionGeneration` que cria `captionJobs/{jobId}`.
 *  3. Hook `useCaptionGeneration(jobId)` escuta o doc e expõe progresso.
 *  4. Toast de progresso a cada step. Em `complete`, fecha o dialog.
 *
 * A nova caption track aparece no `CaptionsDrawer` automaticamente (o
 * editor store deveria recarregar `videoProjects/{id}` em tempo real).
 */

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { useFirestore, useStorage, useUser } from '@/firebase';
import { useEditorStore } from '@/lib/editor/store';
import { useToast } from '@/hooks/use-toast';
import { Sparkles, Loader2 } from 'lucide-react';

import { mixProjectAudioClient } from '@/lib/editor/captions/audio-mixer-client';
import { requestCaptionGeneration } from '@/firebase/admin/actions';
import { useCaptionGeneration } from './useCaptionGeneration';
import type { CaptionGenerationJob } from '@/lib/types';

type LanguageOption = { value: string; label: string };
const LANGUAGES: LanguageOption[] = [
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'en', label: 'Inglês' },
  { value: 'es', label: 'Espanhol' },
];

type ModelOption = {
  value: CaptionGenerationJob['model'];
  label: string;
  hint: string;
};
const MODELS: ModelOption[] = [
  {
    value: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    hint: 'rápido, ideal pra falas claras',
  },
  {
    value: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    hint: 'mais preciso em áudios ruidosos',
  },
];

export interface CaptionGenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CaptionGenerateDialog({
  open,
  onOpenChange,
}: CaptionGenerateDialogProps) {
  const firestore = useFirestore();
  const storage = useStorage();
  const { user } = useUser();
  const project = useEditorStore((s) => s.project);
  const { toast } = useToast();

  const [language, setLanguage] = React.useState<string>('pt-BR');
  const [model, setModel] =
    React.useState<CaptionGenerationJob['model']>('gemini-2.5-flash');
  const [tryClientMix, setTryClientMix] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [phase, setPhase] = React.useState<
    'idle' | 'mixing-client' | 'uploading' | 'queued'
  >('idle');
  const [activeJobId, setActiveJobId] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Reset estado quando abre.
  React.useEffect(() => {
    if (open) {
      setSubmitError(null);
      if (!busy && !activeJobId) {
        setPhase('idle');
      }
    }
  }, [open, busy, activeJobId]);

  const jobState = useCaptionGeneration(activeJobId);

  // Quando complete, exibe toast e fecha.
  const lastStatusRef = React.useRef(jobState.status);
  React.useEffect(() => {
    if (lastStatusRef.current === jobState.status) return;
    lastStatusRef.current = jobState.status;

    if (jobState.status === 'complete') {
      toast({
        title: 'Legendas geradas!',
        description: 'A nova track foi adicionada ao projeto.',
      });
      setBusy(false);
      // Fecha após um respiro pra leitura do toast.
      setTimeout(() => {
        onOpenChange(false);
        setActiveJobId(null);
        setPhase('idle');
      }, 600);
    } else if (jobState.status === 'error') {
      toast({
        title: 'Falha ao gerar legendas',
        description: jobState.error ?? 'Tente novamente em alguns instantes.',
        variant: 'destructive',
      });
      setBusy(false);
    } else if (jobState.status === 'cancelled') {
      toast({
        title: 'Geração cancelada',
      });
      setBusy(false);
    }
  }, [jobState.status, jobState.error, toast, onOpenChange]);

  // Watchdog do hook detectou job travado: libera o spinner pra o usuário
  // poder tentar de novo ou fechar.
  React.useEffect(() => {
    if (jobState.stalled) {
      setBusy(false);
    }
  }, [jobState.stalled]);

  const handleSubmit = async () => {
    if (!project) {
      setSubmitError('Nenhum projeto carregado.');
      return;
    }
    if (!user?.uid) {
      setSubmitError('Você precisa estar autenticado.');
      return;
    }
    if (!firestore || !storage) {
      setSubmitError('Firebase não inicializado.');
      return;
    }

    setBusy(true);
    setSubmitError(null);

    try {
      let mixedBlob: Blob | undefined;

      if (tryClientMix) {
        setPhase('mixing-client');
        try {
          const blob = await mixProjectAudioClient(project);
          if (blob) {
            mixedBlob = blob;
          } else {
            // > 10min — cai pro server-side.
            toast({
              title: 'Mixagem grande demais para o navegador',
              description: 'Vamos mixar no servidor — pode demorar mais.',
            });
          }
        } catch (e) {
          console.warn('[CaptionGenerateDialog] mix client falhou:', e);
          toast({
            title: 'Mixagem no navegador falhou',
            description: 'Recorrendo ao servidor.',
          });
        }
      }

      setPhase(mixedBlob ? 'uploading' : 'queued');

      const jobId = await requestCaptionGeneration(
        firestore,
        storage,
        user.uid,
        project.id,
        {
          language,
          model,
          mixedAudioBlob: mixedBlob,
        },
      );
      setActiveJobId(jobId);
      setPhase('queued');
      toast({
        title: 'Pedido enviado',
        description: 'A IA já começou a transcrever o áudio.',
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[CaptionGenerateDialog] submit erro:', e);
      setSubmitError(msg);
      setBusy(false);
      setPhase('idle');
    }
  };

  const isRunning =
    !jobState.stalled &&
    (busy ||
      jobState.status === 'pending' ||
      jobState.status === 'mixing' ||
      jobState.status === 'transcribing' ||
      jobState.status === 'aligning');

  const progress = computeProgress(phase, jobState.status, jobState.progress);
  const phaseLabel = describePhase(phase, jobState.status);

  const handleClose = () => {
    if (isRunning) {
      // Não cancela o job, só fecha o dialog (job continua no servidor).
      onOpenChange(false);
      return;
    }
    onOpenChange(false);
    setActiveJobId(null);
    setPhase('idle');
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? handleClose() : onOpenChange(v))}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--editor-accent-strong,theme(colors.violet.500))]" />
            Gerar legendas com IA
          </DialogTitle>
          <DialogDescription>
            Transcreve o áudio do projeto via Gemini e cria uma nova track de
            legendas. Você pode editar manualmente depois.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Idioma */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cap-gen-lang" className="text-xs">
              Idioma do áudio
            </Label>
            <Select
              value={language}
              onValueChange={setLanguage}
              disabled={isRunning}
            >
              <SelectTrigger id="cap-gen-lang" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value} className="text-xs">
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Modelo */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cap-gen-model" className="text-xs">
              Modelo
            </Label>
            <Select
              value={model}
              onValueChange={(v) => setModel(v as CaptionGenerationJob['model'])}
              disabled={isRunning}
            >
              <SelectTrigger id="cap-gen-model" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value} className="text-xs">
                    <span className="font-medium">{m.label}</span>
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      · {m.hint}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Mixagem cliente */}
          <div className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/30 p-2.5">
            <Checkbox
              id="cap-gen-clientmix"
              checked={tryClientMix}
              onCheckedChange={(v) => setTryClientMix(v === true)}
              disabled={isRunning}
              className="mt-0.5"
            />
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="cap-gen-clientmix"
                className="cursor-pointer text-xs font-medium"
              >
                Tentar mixar no navegador (mais rápido)
              </Label>
              <p className="text-[10px] text-muted-foreground">
                Limite ~10min de projeto. Se exceder, mixamos no servidor
                automaticamente.
              </p>
            </div>
          </div>

          {/* Progresso */}
          {(isRunning || jobState.status === 'complete') && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  {isRunning && <Loader2 className="h-3 w-3 animate-spin" />}
                  {phaseLabel}
                </span>
                <span className="font-mono tabular-nums">{progress}%</span>
              </div>
              <Progress value={progress} className="h-1.5" />
            </div>
          )}

          {jobState.stalled && jobState.status !== 'complete' && (
            <p className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-600 dark:text-amber-400">
              A geração está demorando mais que o esperado e pode ter falhado.
              Tente gerar de novo ou feche e tente mais tarde.
            </p>
          )}

          {submitError && (
            <p className="rounded-sm border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
              {submitError}
            </p>
          )}
          {jobState.status === 'error' && jobState.error && (
            <p className="rounded-sm border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
              {jobState.error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={handleClose}
            disabled={busy && phase !== 'idle' && phase !== 'queued'}
          >
            {isRunning ? 'Fechar (continua rodando)' : 'Cancelar'}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isRunning || !project}
            className="gap-1.5"
          >
            {isRunning ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Processando…
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Gerar
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Helpers de UI
// ============================================================================

function computeProgress(
  phase: 'idle' | 'mixing-client' | 'uploading' | 'queued',
  status: ReturnType<typeof useCaptionGeneration>['status'],
  jobProgress: number,
): number {
  if (status === 'complete') return 100;
  if (status === 'error' || status === 'cancelled') return 0;
  if (status === 'mixing' || status === 'transcribing' || status === 'aligning') {
    return Math.max(5, Math.min(100, jobProgress));
  }
  if (phase === 'mixing-client') return 8;
  if (phase === 'uploading') return 15;
  if (phase === 'queued') return Math.max(20, jobProgress);
  return 0;
}

function describePhase(
  phase: 'idle' | 'mixing-client' | 'uploading' | 'queued',
  status: ReturnType<typeof useCaptionGeneration>['status'],
): string {
  if (status === 'mixing') return 'Mixando áudio no servidor…';
  if (status === 'transcribing') return 'Transcrevendo via Gemini…';
  if (status === 'aligning') return 'Alinhando legendas…';
  if (status === 'complete') return 'Concluído';
  if (status === 'error') return 'Erro';
  if (status === 'cancelled') return 'Cancelado';
  if (phase === 'mixing-client') return 'Mixando no navegador…';
  if (phase === 'uploading') return 'Enviando áudio…';
  if (phase === 'queued') return 'Aguardando servidor…';
  return 'Aguardando início';
}
