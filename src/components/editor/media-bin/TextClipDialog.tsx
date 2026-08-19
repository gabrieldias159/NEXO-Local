'use client';

/**
 * Diálogo "Clip de texto" — palavra empilhável estilo cartaz (recurso 3 do
 * fluxo do gabinete): IPTU / CONTA DE LUZ / ITBI empilhando na tela com som
 * de erro acoplado.
 *
 * O texto vira um PNG transparente (ver `lib/editor/text-asset.ts`) que entra
 * como asset de imagem comum — preview e render funcionam sem caminho novo.
 * O clip é criado no playhead, numa CAMADA livre acima da base da track de
 * vídeo mais alta, com animação de entrada (fade/pop) e, opcionalmente, um
 * som da biblioteca do projeto disparado junto.
 *
 * TODO(edição): reabrir este diálogo a partir de um asset de texto existente
 * (asset.text) para regenerar o PNG no mesmo asset.
 */

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { useEditorStore } from '@/lib/editor/store';
import { useIngestFiles } from '@/lib/editor/ingest-files';
import { generateTextPngFile, DEFAULT_TEXT_SPEC } from '@/lib/editor/text-asset';
import type { Track } from '@/lib/editor/types';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

const SWATCHES = ['#FFFFFF', '#FFFF00', '#FF3B30', '#34C759', '#000000'];

interface TextClipDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TextClipDialog({ open, onOpenChange }: TextClipDialogProps) {
  const { toast } = useToast();
  const ingest = useIngestFiles();

  const audioAssets = useEditorStore((s) =>
    (s.project?.assets ?? []).filter(
      (a) => a.type === 'audio' && a.status !== 'error',
    ),
  );

  const [content, setContent] = React.useState('');
  const [color, setColor] = React.useState('#FFFF00');
  const [strokeColor, setStrokeColor] = React.useState('#000000');
  const [strokePct, setStrokePct] = React.useState(12);
  const [shadow, setShadow] = React.useState(true);
  const [autoSize, setAutoSize] = React.useState(true);
  const [fontSizePct, setFontSizePct] = React.useState(16);
  const [posY, setPosY] = React.useState(-45); // % (-100 topo .. 100 base)
  const [durationSec, setDurationSec] = React.useState(2.5);
  const [anim, setAnim] = React.useState<'none' | 'fade' | 'pop'>('pop');
  const [soundAssetId, setSoundAssetId] = React.useState<string>('__none');
  const [busy, setBusy] = React.useState(false);

  const handleAdd = async () => {
    const state = useEditorStore.getState();
    const project = state.project;
    if (!project) return;
    if (!content.trim()) {
      toast({ title: 'Digite o texto', variant: 'destructive' });
      return;
    }
    setBusy(true);
    try {
      const spec = {
        ...DEFAULT_TEXT_SPEC,
        content: content.trim(),
        color,
        strokeColor,
        strokePct,
        shadow,
        fontSizePct: autoSize ? undefined : fontSizePct,
      };
      const { file } = await generateTextPngFile(spec, project.resolution.width);
      const [asset] = await ingest([file]);
      if (!asset) throw new Error('Falha ao criar o asset do texto.');
      state.updateAsset(asset.id, { text: spec });

      // Track de vídeo mais ALTA (maior index) — o texto empilha ACIMA da base.
      const videoTracks = project.tracks
        .filter((t) => t.type === 'video' && !t.locked)
        .sort((a, b) => b.index - a.index);
      const track: Track | undefined = videoTracks[0];
      if (!track) throw new Error('O projeto não tem track de vídeo.');

      const at = state.ui.playhead;
      const end = at + Math.max(0.3, durationSec);
      const layer = firstFreeLayer(track, at, end);

      const clipId = state.addClipFromAsset(asset.id, track.id, at, layer);
      if (!clipId) throw new Error('Não deu para criar o clip do texto.');
      // Imagem entra com 5s default — encurta/estica para a duração pedida.
      state.trimClip(clipId, 'right', end);
      state.setClipTransform(clipId, { y: posY / 100 });
      if (anim === 'fade') {
        state.setTransition(clipId, 'in', {
          type: 'fade',
          duration: 0.18,
          easing: 'ease-out',
        });
      } else if (anim === 'pop') {
        state.setTransition(clipId, 'in', {
          type: 'zoom-in',
          duration: 0.25,
          easing: 'ease-out',
        });
      }

      // Som acoplado: entra numa track de áudio no MESMO instante.
      if (soundAssetId !== '__none') {
        let audioTrack = project.tracks.find(
          (t) => t.type === 'audio' && !t.locked,
        );
        if (!audioTrack) {
          const newId = state.addTrack('audio', 'Sons');
          audioTrack = useEditorStore
            .getState()
            .project?.tracks.find((t) => t.id === newId);
        }
        if (audioTrack) {
          state.addClipFromAsset(soundAssetId, audioTrack.id, at);
        }
      }

      state.selectClip(clipId);
      toast({
        title: `Texto "${spec.content.split('\n')[0]}" no playhead`,
        description:
          anim === 'none'
            ? undefined
            : `Entrada: ${anim === 'pop' ? 'pop' : 'fade'} · no export vira fade alpha.`,
      });
      onOpenChange(false);
      setContent('');
    } catch (err) {
      toast({
        title: 'Falha ao criar o texto',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Clip de texto</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="space-y-1">
            <Label htmlFor="txt-content" className="text-xs">
              Texto (Enter = nova linha)
            </Label>
            <Textarea
              id="txt-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="IPTU"
              rows={2}
              className="resize-none text-sm font-semibold"
              autoFocus
            />
          </div>

          {/* Cores */}
          <div className="flex items-center gap-3">
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Cor</Label>
              <div className="flex items-center gap-1">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={cn(
                      'h-6 w-6 rounded border',
                      color === c ? 'ring-2 ring-primary' : 'border-border',
                    )}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                ))}
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-6 w-8 cursor-pointer rounded border p-0"
                  title="Cor personalizada"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Contorno</Label>
              <div className="flex items-center gap-1">
                <input
                  type="color"
                  value={strokeColor}
                  onChange={(e) => setStrokeColor(e.target.value)}
                  className="h-6 w-8 cursor-pointer rounded border p-0"
                  title="Cor do contorno"
                />
                <Input
                  type="number"
                  value={strokePct}
                  min={0}
                  max={25}
                  onChange={(e) =>
                    setStrokePct(
                      Math.max(0, Math.min(25, Number(e.target.value) || 0)),
                    )
                  }
                  className="h-6 w-14 text-right text-xs"
                  title="Espessura do contorno (% da fonte)"
                />
                <span className="text-[10px] text-muted-foreground">%</span>
              </div>
            </div>
          </div>

          {/* Sombra + tamanho */}
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={shadow} onCheckedChange={setShadow} />
              Sombra dura
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={autoSize} onCheckedChange={setAutoSize} />
              Tamanho automático
            </label>
          </div>
          {!autoSize && (
            <div className="space-y-1">
              <Label className="text-xs">
                Tamanho da fonte — {fontSizePct}% da largura
              </Label>
              <Slider
                value={[fontSizePct]}
                min={4}
                max={30}
                step={1}
                onValueChange={([v]) => setFontSizePct(v ?? 16)}
              />
            </div>
          )}

          {/* Posição Y */}
          <div className="space-y-1">
            <Label className="text-xs">
              Posição vertical — {posY < 0 ? `${-posY}% p/ cima` : posY > 0 ? `${posY}% p/ baixo` : 'centro'}
            </Label>
            <Slider
              value={[posY]}
              min={-90}
              max={90}
              step={5}
              onValueChange={([v]) => setPosY(v ?? 0)}
            />
          </div>

          {/* Duração + animação + som */}
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Duração (s)</Label>
              <Input
                type="number"
                value={durationSec}
                min={0.3}
                max={30}
                step={0.1}
                onChange={(e) =>
                  setDurationSec(Math.max(0.3, Number(e.target.value) || 2.5))
                }
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Entrada</Label>
              <Select value={anim} onValueChange={(v) => setAnim(v as typeof anim)}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pop" className="text-xs">Pop</SelectItem>
                  <SelectItem value="fade" className="text-xs">Fade</SelectItem>
                  <SelectItem value="none" className="text-xs">Nenhuma</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Som acoplado</Label>
              <Select value={soundAssetId} onValueChange={setSoundAssetId}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none" className="text-xs">
                    Nenhum
                  </SelectItem>
                  {audioAssets.map((a) => (
                    <SelectItem key={a.id} value={a.id} className="text-xs">
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {audioAssets.length === 0 && (
            <p className="text-[10px] text-muted-foreground">
              Sem áudios no projeto — importe o som (ex.: erro do Windows) na
              aba de mídias para poder acoplar.
            </p>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancelar
            </Button>
            <Button type="button" onClick={handleAdd} disabled={busy}>
              {busy ? 'Gerando…' : 'Adicionar no playhead'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Primeira CAMADA da track onde o intervalo [start, end) está livre,
 * começando na camada 1 (a 0 é a base). Sem camada livre → cria uma nova
 * (índice = nº de camadas atual).
 */
function firstFreeLayer(track: Track, start: number, end: number): number {
  const layerCount = Math.max(
    track.layerCount ?? 1,
    ...track.clips.map((c) => (c.layer ?? 0) + 1),
    1,
  );
  for (let layer = 1; layer < layerCount; layer++) {
    const busy = track.clips.some(
      (c) =>
        (c.layer ?? 0) === layer &&
        c.startInTimeline < end &&
        c.endInTimeline > start,
    );
    if (!busy) return layer;
  }
  return layerCount;
}
