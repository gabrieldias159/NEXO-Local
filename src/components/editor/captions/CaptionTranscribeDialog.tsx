'use client';

/**
 * Dialog "Gerar legenda do áudio" — transcrição LOCAL (STT no navegador).
 *
 * 100% client-side, SEM IA paga, SEM CDN: mixa o áudio do projeto no browser
 * (`mixProjectAudioPCM`), roda Whisper via transformers.js num Web Worker
 * (modelo + wasm vendorados em `/public`), mapeia os segmentos pra
 * `CaptionCue` e cria uma nova `CaptionTrack`. O usuário edita texto/tempos no
 * `CaptionsDrawer` e posiciona/estiliza no `CaptionStyleEditor` — nada novo.
 *
 * Espelha a UX do `CaptionGenerateDialog` (idioma, modelo, barra de progresso
 * com fases), mas sem job no Firestore — tudo acontece no navegador.
 *
 * Vantagem vs. fluxo Gemini: funciona até com assets `blob:` locais (não
 * exige o asset no Storage) e não tem custo de API.
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
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { useEditorStore } from '@/lib/editor/store';
import { useToast } from '@/hooks/use-toast';
import { Captions, Loader2 } from 'lucide-react';

import { mixProjectAudioPCM } from '@/lib/editor/captions/audio-mixer-client';
import {
  createTranscribeClient,
  type WhisperModel,
} from '@/lib/editor/captions/transcribe-worker-client';
import { chunksToCues } from '@/lib/editor/captions/transcription';

type LanguageOption = { value: string; label: string };
const LANGUAGES: LanguageOption[] = [
  { value: 'pt', label: 'Português' },
  { value: 'en', label: 'Inglês' },
  { value: 'es', label: 'Espanhol' },
];

type ModelOption = { value: WhisperModel; label: string; hint: string };
// Só expomos modelos cujos assets estão REALMENTE vendorados em
// `public/models/<id>` (same-origin, exigido pelo COEP require-corp). O modelo
// `base` (whisper-base) ainda não foi provisionado em /public, então oferecê-lo
// resultava em 404 + "Erro ao carregar modelo". Reintroduzir `base` aqui SOMENTE
// depois de vendorar `public/models/whisper-base/` (config/tokenizer/onnx).
const MODELS: ModelOption[] = [
  { value: 'tiny', label: 'Rápido (tiny)', hint: 'leve, ideal pra falas claras' },
];

type Phase =
  | 'idle'
  | 'extracting-audio'
  | 'loading-model'
  | 'transcribing'
  | 'done';

export interface CaptionTranscribeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Notifica o drawer da nova track criada (pra selecioná-la). */
  onTrackCreated?: (trackId: string) => void;
}

export function CaptionTranscribeDialog({
  open,
  onOpenChange,
  onTrackCreated,
}: CaptionTranscribeDialogProps) {
  const project = useEditorStore((s) => s.project);
  const addCaptionTrack = useEditorStore((s) => s.addCaptionTrack);
  const addCaption = useEditorStore((s) => s.addCaption);
  const setCaptionTrackSource = useEditorStore((s) => s.setCaptionTrackSource);
  const { toast } = useToast();

  const [language, setLanguage] = React.useState<string>('pt');
  const [model, setModel] = React.useState<WhisperModel>('tiny');
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [modelPct, setModelPct] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  const busy =
    phase === 'extracting-audio' ||
    phase === 'loading-model' ||
    phase === 'transcribing';

  // Reset ao abrir.
  React.useEffect(() => {
    if (open && !busy) {
      setPhase('idle');
      setError(null);
      setModelPct(0);
    }
  }, [open, busy]);

  const handleSubmit = async () => {
    if (!project) {
      setError('Nenhum projeto carregado.');
      return;
    }
    setError(null);

    const client = createTranscribeClient();
    try {
      // 1) Extrai PCM 16kHz mono direto do projeto (sem WAV, sem upload).
      setPhase('extracting-audio');
      const pcm = await mixProjectAudioPCM(project);
      const totalDuration = pcm.length / 16000;

      // 2) Carrega o modelo Whisper do /public (worker). Mostra % de download.
      setPhase('loading-model');
      setModelPct(0);
      await client.init(model, (p) => {
        if (typeof p.progress === 'number') setModelPct(p.progress);
      });

      // 3) Transcreve.
      setPhase('transcribing');
      const chunks = await client.transcribe(pcm, language, () => {
        /* progresso aproximado por chunk — barra fica indeterminada */
      });

      // 4) Mapeia segmentos -> cues e popula uma nova track.
      const cues = chunksToCues(chunks, totalDuration);
      if (cues.length === 0) {
        throw new Error('Nenhuma fala reconhecida no áudio.');
      }

      const langLabel =
        LANGUAGES.find((l) => l.value === language)?.label ?? language;
      const trackId = addCaptionTrack(`Transcrição (${langLabel})`, language);
      setCaptionTrackSource(trackId, 'transcribed');
      for (const cue of cues) {
        addCaption(trackId, cue);
      }

      setPhase('done');
      toast({
        title: `Legenda gerada — ${cues.length} trecho(s)`,
        description: 'Revise o texto e os tempos no editor de legendas.',
      });
      onTrackCreated?.(trackId);
      setTimeout(() => {
        onOpenChange(false);
        setPhase('idle');
      }, 600);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[CaptionTranscribeDialog] erro:', e);
      setError(msg);
      setPhase('idle');
    } finally {
      client.destroy();
    }
  };

  const handleClose = () => {
    // Não interrompe um worker em andamento de forma graciosa; apenas fecha.
    onOpenChange(false);
  };

  const progress = computeProgress(phase, modelPct);
  const phaseLabel = describePhase(phase);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => (!v ? handleClose() : onOpenChange(v))}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Captions className="h-4 w-4" style={{ color: 'var(--editor-track-cc)' }} />
            Gerar legenda do áudio
          </DialogTitle>
          <DialogDescription>
            Transcreve o áudio do projeto direto no seu navegador (sem internet
            de IA, sem custo) e cria uma nova track. Revise o texto depois.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Idioma */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cap-tr-lang" className="text-xs">
              Idioma do áudio
            </Label>
            <Select value={language} onValueChange={setLanguage} disabled={busy}>
              <SelectTrigger id="cap-tr-lang" className="h-8 text-xs">
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
            <Label htmlFor="cap-tr-model" className="text-xs">
              Qualidade
            </Label>
            <Select
              value={model}
              onValueChange={(v) => setModel(v as WhisperModel)}
              disabled={busy}
            >
              <SelectTrigger id="cap-tr-model" className="h-8 text-xs">
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
            <p className="text-[10px] text-muted-foreground">
              O modelo é baixado uma vez do próprio app (sem CDN externo). A 1ª
              transcrição pode demorar mais pra carregar.
            </p>
          </div>

          {/* Progresso */}
          {(busy || phase === 'done') && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                  {phaseLabel}
                </span>
                {phase === 'loading-model' && (
                  <span className="font-mono tabular-nums">{modelPct}%</span>
                )}
              </div>
              <Progress
                value={progress}
                className="h-1.5"
              />
            </div>
          )}

          {error && (
            <p className="rounded-sm border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={handleClose} disabled={busy}>
            {busy ? 'Processando…' : 'Cancelar'}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={busy || !project}
            className="gap-1.5"
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Processando…
              </>
            ) : (
              <>
                <Captions className="h-3.5 w-3.5" />
                Gerar legenda
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

function computeProgress(phase: Phase, modelPct: number): number {
  switch (phase) {
    case 'extracting-audio':
      return 5;
    case 'loading-model':
      // 10..70% durante o download do modelo.
      return Math.round(10 + (Math.max(0, Math.min(100, modelPct)) / 100) * 60);
    case 'transcribing':
      return 85;
    case 'done':
      return 100;
    default:
      return 0;
  }
}

function describePhase(phase: Phase): string {
  switch (phase) {
    case 'extracting-audio':
      return 'Extraindo áudio do projeto…';
    case 'loading-model':
      return 'Carregando modelo…';
    case 'transcribing':
      return 'Transcrevendo (pode demorar)…';
    case 'done':
      return 'Concluído';
    default:
      return 'Aguardando início';
  }
}
