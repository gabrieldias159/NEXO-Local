'use client';

/**
 * Dialog de geração por IA para o palco 2 do editor.
 *
 * Dois modos:
 *  - Prompt manual: usuário escreve a descrição e gera.
 *  - A partir da transcrição: usa a transcrição de um clip do palco 1
 *    e Gemini extrai o conceito visual + gera imagem.
 *
 * O resultado é convertido em `File` e ingerido pelo MESMO caminho dos
 * uploads normais (`useIngestFiles`): sobe pro Firebase Storage em background
 * e vira `source:'firebase'` com `storagePath`/`downloadUrl` persistentes —
 * sobrevivendo ao salvar+recarregar. O usuário arrasta para o palco 2.
 */

import { useMemo, useState } from 'react';
import { Loader2, Sparkles, Mic, ImagePlus } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useEditorStore } from '@/lib/editor/store';
import { useIngestFiles } from '@/lib/editor/ingest-files';
import {
  generateImageAction,
  generateImageFromTranscriptionAction,
  transcribeAudioAction,
} from '@/app/actions';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Limite de áudio enviado pra transcrição (Groq Whisper aceita até 25MB;
 *  WAV 16kHz mono ≈ 1.9 MB/min, então ~13min cabem com folga). Acima disso
 *  avisamos em vez de estourar o limite da API. */
const MAX_TRANSCRIBE_AUDIO_BYTES = 24 * 1024 * 1024;
const TRANSCRIBE_SAMPLE_RATE = 16000;

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Extrai SOMENTE a faixa de áudio do trecho selecionado (respeitando o trim
 * do clip), reamostrada para 16 kHz mono e encodada em WAV PCM16.
 *
 * Antes este componente baixava o VÍDEO INTEIRO e mandava como data URI base64
 * (+33% de overhead), estourando o limite de 25 MB do Groq Whisper / inline do
 * Gemini e ignorando o trim do clip. Agora decodifica o áudio no navegador
 * (OfflineAudioContext), corta a janela [startInAsset, endInAsset] e devolve
 * um áudio leve.
 */
async function extractClipAudioDataUri(
  url: string,
  startInAsset: number,
  endInAsset: number,
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar o clip (HTTP ${res.status}).`);
  const arrayBuffer = await res.arrayBuffer();

  // Decodifica numa taxa alta o suficiente p/ não perder qualidade, depois
  // fazemos downsample só do trecho recortado.
  const decodeCtx = new OfflineAudioContext(1, 1, 48000);
  const decoded = await decodeCtx.decodeAudioData(arrayBuffer);

  const total = decoded.duration;
  const start = Math.max(0, Math.min(startInAsset || 0, total));
  const end =
    endInAsset && endInAsset > start ? Math.min(endInAsset, total) : total;
  const windowDur = Math.max(0.05, end - start);

  // Renderiza só a janela do clip num contexto mono à taxa do decode.
  const renderRate = decoded.sampleRate;
  const renderLen = Math.ceil(windowDur * renderRate);
  const renderCtx = new OfflineAudioContext(1, renderLen, renderRate);
  const src = renderCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(renderCtx.destination);
  src.start(0, start, windowDur);
  const rendered = await renderCtx.startRendering();

  const mono = downsampleMono(
    rendered.getChannelData(0),
    rendered.sampleRate,
    TRANSCRIBE_SAMPLE_RATE,
  );
  const wav = encodeWavPcm16(mono, TRANSCRIBE_SAMPLE_RATE);
  if (wav.size > MAX_TRANSCRIBE_AUDIO_BYTES) {
    const maxMin = Math.floor(MAX_TRANSCRIBE_AUDIO_BYTES / (1.9 * 1024 * 1024));
    throw new Error(
      `Trecho longo demais para transcrição (limite ~${maxMin} min de áudio). Corte o clip antes de gerar.`,
    );
  }
  return blobToDataUri(wav);
}

/** Downsample linear mono→mono (média de janelas). Suficiente p/ STT. */
function downsampleMono(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (outputRate >= inputRate) return input.slice();
  const ratio = inputRate / outputRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  let outIdx = 0;
  let inIdxFrac = 0;
  while (outIdx < outLength) {
    const nextInIdx = Math.floor((outIdx + 1) * ratio);
    let acc = 0;
    let count = 0;
    for (let i = Math.floor(inIdxFrac); i < nextInIdx && i < input.length; i++) {
      acc += input[i] ?? 0;
      count += 1;
    }
    out[outIdx] = count > 0 ? acc / count : 0;
    inIdxFrac = nextInIdx;
    outIdx += 1;
  }
  return out;
}

/** Encoda Float32 mono (-1..1) em WAV PCM 16-bit (zero-dependency). */
function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Extensão de arquivo a partir do MIME da imagem gerada. */
function extFromMime(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'png';
}

/**
 * Converte a data URI da imagem gerada num `File`, para ingerir pelo mesmo
 * caminho dos uploads normais (`useIngestFiles` → Storage).
 */
function dataUriToImageFile(dataUri: string, baseName: string): File {
  const [meta, b64] = dataUri.split(',');
  const mime = meta?.match(/data:([^;]+)/)?.[1] ?? 'image/png';
  const bin = atob(b64 ?? '');
  const len = bin.length;
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
  const safe = (baseName || 'imagem-ia').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
  return new File([buf], `${safe || 'imagem-ia'}.${extFromMime(mime)}`, {
    type: mime,
  });
}

export function AiStageGenerator({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const project = useEditorStore((s) => s.project);
  const updateAsset = useEditorStore((s) => s.updateAsset);
  const ingest = useIngestFiles();

  const [mode, setMode] = useState<'prompt' | 'transcribe'>('prompt');
  const [prompt, setPrompt] = useState('');
  const [clipId, setClipId] = useState<string>('');
  const [loading, setLoading] = useState<'idle' | 'transcribing' | 'generating'>('idle');

  const videoClips = useMemo(() => {
    type ClipOpt = {
      id: string;
      label: string;
      assetId: string;
      startInAsset: number;
      endInAsset: number;
    };
    if (!project) return [] as ClipOpt[];
    const out: ClipOpt[] = [];
    for (const t of project.tracks) {
      if (t.type !== 'video') continue;
      for (const c of t.clips) {
        const asset = project.assets.find((a) => a.id === c.assetId);
        if (!asset) continue;
        out.push({
          id: c.id,
          label: `${asset.name} (track ${t.name})`,
          assetId: asset.id,
          startInAsset: c.startInAsset ?? 0,
          endInAsset: c.endInAsset ?? 0,
        });
      }
    }
    return out;
  }, [project]);

  const aspectHint = useMemo(() => {
    if (!project) return 'landscape' as const;
    const r = project.resolution;
    if (r.width > r.height) return 'landscape' as const;
    if (r.height > r.width) return 'portrait' as const;
    return 'square' as const;
  }, [project]);

  const handleGenerate = async () => {
    if (!project) return;
    try {
      let result;
      if (mode === 'transcribe') {
        const clip = videoClips.find((c) => c.id === clipId);
        if (!clip) {
          toast({
            title: 'Selecione um clip do palco 1',
            variant: 'destructive',
          });
          return;
        }
        const asset = project.assets.find((a) => a.id === clip.assetId);
        if (!asset?.downloadUrl) {
          toast({ title: 'Clip sem URL acessível', variant: 'destructive' });
          return;
        }
        setLoading('transcribing');
        // Extrai SÓ o áudio do trecho (16kHz mono WAV), respeitando o trim do
        // clip — em vez de baixar o vídeo inteiro como data URI (estourava o
        // limite de 25MB do Whisper/Gemini).
        const dataUri = await extractClipAudioDataUri(
          asset.downloadUrl,
          clip.startInAsset,
          clip.endInAsset,
        );
        const transcRes = await transcribeAudioAction({ audioDataUri: dataUri });
        if (!transcRes.success || !transcRes.data) {
          throw new Error(transcRes.error ?? 'Falha na transcrição.');
        }
        setLoading('generating');
        const genRes = await generateImageFromTranscriptionAction({
          transcription: transcRes.data.transcription,
          contextHint: prompt.trim() || undefined,
          aspectHint,
        });
        if (!genRes.success || !genRes.data) {
          throw new Error(genRes.error ?? 'Falha na geração.');
        }
        result = genRes.data;
      } else {
        if (prompt.trim().length < 3) {
          toast({ title: 'Descreva a imagem desejada', variant: 'destructive' });
          return;
        }
        setLoading('generating');
        const genRes = await generateImageAction({
          prompt: prompt.trim(),
          aspectHint,
        });
        if (!genRes.success || !genRes.data) {
          throw new Error(genRes.error ?? 'Falha na geração.');
        }
        result = genRes.data;
      }

      // Ingere pelo MESMO caminho dos uploads normais: vira asset local-blob
      // 'uploading' (preview imediato) e sobe pro Storage em background,
      // virando `source:'firebase'` + `storagePath` — sobrevive ao
      // salvar+recarregar. O blob local é revogado pelo próprio ingest.
      const label = `IA · ${(result.caption || prompt || 'imagem gerada').slice(0, 60)}`;
      const file = dataUriToImageFile(result.imageDataUri, label);
      const [created] = await ingest([file]);
      if (created) {
        // Nome do arquivo é sanitizado; aplica o rótulo amigável da IA.
        updateAsset(created.id, { name: label });
      }
      toast({
        title: 'Imagem gerada',
        description: 'Arraste do MediaBin para uma track de vídeo do palco 2.',
      });
      onOpenChange(false);
      setPrompt('');
    } catch (err) {
      toast({
        title: 'Erro na geração',
        description: err instanceof Error ? err.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setLoading('idle');
    }
  };

  const busy = loading !== 'idle';

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Gerar imagem por IA
          </DialogTitle>
          <DialogDescription>
            Cria uma imagem para o palco 2 a partir de um prompt ou da
            transcrição de um clip do palco 1.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMode('prompt')}
              disabled={busy}
              className={
                'flex flex-col items-start gap-1 rounded-md border p-3 text-left text-xs transition-colors ' +
                (mode === 'prompt' ? 'border-primary bg-primary/5' : 'hover:bg-accent')
              }
            >
              <ImagePlus className="h-4 w-4" />
              <p className="font-medium">Prompt manual</p>
              <p className="text-[10px] text-muted-foreground">
                Descreva o que deseja
              </p>
            </button>
            <button
              type="button"
              onClick={() => setMode('transcribe')}
              disabled={busy || videoClips.length === 0}
              className={
                'flex flex-col items-start gap-1 rounded-md border p-3 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
                (mode === 'transcribe' ? 'border-primary bg-primary/5' : 'hover:bg-accent')
              }
            >
              <Mic className="h-4 w-4" />
              <p className="font-medium">A partir do palco 1</p>
              <p className="text-[10px] text-muted-foreground">
                {videoClips.length === 0
                  ? 'Adicione um clip antes'
                  : 'Transcreve + ilustra'}
              </p>
            </button>
          </div>

          {mode === 'transcribe' && (
            <div className="space-y-2">
              <Label htmlFor="ai-clip">Clip do palco 1</Label>
              <Select value={clipId} onValueChange={setClipId} disabled={busy}>
                <SelectTrigger id="ai-clip">
                  <SelectValue placeholder="Selecione um clip…" />
                </SelectTrigger>
                <SelectContent>
                  {videoClips.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="ai-prompt">
              {mode === 'transcribe'
                ? 'Contexto adicional (opcional)'
                : 'Descrição da imagem'}
            </Label>
            <Textarea
              id="ai-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                mode === 'transcribe'
                  ? 'Ex: vereador falando sobre saúde pública…'
                  : 'Ex: gráfico de barras estilizado mostrando crescimento…'
              }
              rows={3}
              disabled={busy}
            />
          </div>

          {project && (
            <p className="text-[11px] text-muted-foreground">
              Proporção:{' '}
              <span className="font-medium">
                {aspectHint === 'portrait'
                  ? 'vertical'
                  : aspectHint === 'square'
                    ? 'quadrada'
                    : 'horizontal'}
              </span>{' '}
              (derivada da resolução do projeto)
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancelar
          </Button>
          <Button type="button" onClick={handleGenerate} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {loading === 'transcribing' ? 'Transcrevendo…' : 'Gerando…'}
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Gerar
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
