'use client';

/**
 * Tab Audio do Inspector.
 *
 * Edita `Clip.audio` (ClipAudio): volume, muted, pan, fadeIn/Out.
 *
 * - Volume: 0-2 (1 = unity gain, >1 amplifica). Mostra também dB derivado
 *   (`20 * log10(volume)`).
 * - Pan: -1 (esquerda) a 1 (direita).
 * - Fades: segundos.
 *
 * Disabled state: se o asset associado não for vídeo nem áudio (ex: imagem),
 * renderiza um aviso e desabilita os controles.
 */

import * as React from 'react';
import { Scissors } from 'lucide-react';
import type { Clip, ClipAudio, MediaAsset } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { ScrubbableInput } from '../controls/ScrubbableInput';
import { InspectorSection } from '../controls/InspectorSection';
import { pickCommonValue } from '../controls/useMixedValue';
import { cn } from '@/lib/utils';

export interface AudioTabProps {
  clips: Clip[];
  assets: MediaAsset[];
}

function volumeToDb(v: number): string {
  if (v <= 0.0001) return '-∞';
  const db = 20 * Math.log10(v);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export function AudioTab({ clips, assets }: AudioTabProps) {
  const setClipAudio = useEditorStore((s) => s.setClipAudio);
  const splitAudio = useEditorStore((s) => s.splitAudioFromVideoClip);
  const { toast } = useToast();

  // Áudio só faz sentido se o asset é audio ou video.
  const allHaveAudio = clips.every((c) => {
    const asset = assets.find((a) => a.id === c.assetId);
    return asset && (asset.type === 'audio' || asset.type === 'video');
  });

  // "Separar áudio" só faz sentido quando há UM clip de vídeo selecionado.
  const canSplitAudio =
    clips.length === 1 &&
    (() => {
      const a = assets.find((x) => x.id === clips[0]!.assetId);
      return a?.type === 'video';
    })();

  const handleSplit = () => {
    if (!canSplitAudio) return;
    const id = splitAudio(clips[0]!.id);
    if (id) {
      toast({
        title: 'Áudio separado',
        description: 'Faixa de áudio criada em uma track de áudio. Vídeo original ficou mudo.',
      });
    } else {
      toast({
        title: 'Não foi possível separar',
        description: 'Verifique se o clip selecionado é de vídeo.',
        variant: 'destructive',
      });
    }
  };

  const volume = pickCommonValue(clips, (c) => c.audio.volume);
  const muted = pickCommonValue(clips, (c) => c.audio.muted);
  const pan = pickCommonValue(clips, (c) => c.audio.pan);
  const fadeIn = pickCommonValue(clips, (c) => c.audio.fadeInDuration);
  const fadeOut = pickCommonValue(clips, (c) => c.audio.fadeOutDuration);

  const apply = (partial: Partial<ClipAudio>) => {
    clips.forEach((c) => setClipAudio(c.id, partial));
  };

  const disabled = !allHaveAudio;

  return (
    <div className={cn('space-y-5', disabled && 'pointer-events-none opacity-50')}>
      {disabled && (
        <p className="rounded-sm bg-muted px-3 py-2 text-[11px] text-muted-foreground">
          Este clip não possui áudio (imagem ou asset estático).
        </p>
      )}

      <InspectorSection title="Saída">
        <ScrubbableInput
          label="Volume"
          value={volume}
          min={0}
          max={2}
          step={0.05}
          resetValue={1}
          unit="%"
          displayScale={100}
          precision={0}
          onChange={(v) => apply({ volume: v })}
          disabled={disabled}
        />
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>Ganho</span>
          <span className="font-mono">
            {volume === null ? 'Variado' : volumeToDb(volume)}
          </span>
        </div>

        <div className="flex items-center justify-between pt-1">
          <label
            htmlFor="audio-muted"
            className="text-[11px] text-muted-foreground"
          >
            Mudo
          </label>
          <Switch
            id="audio-muted"
            aria-label="Silenciar áudio"
            checked={muted === true}
            onCheckedChange={(checked) => apply({ muted: checked })}
            disabled={disabled}
          />
        </div>
      </InspectorSection>

      <InspectorSection title="Panorâmica">
        <ScrubbableInput
          label="E | C | D"
          value={pan}
          min={-1}
          max={1}
          step={0.05}
          resetValue={0}
          onChange={(v) => apply({ pan: v })}
          disabled={disabled}
        />
      </InspectorSection>

      {canSplitAudio && (
        <InspectorSection title="Separar áudio do vídeo">
          <p className="text-[10px] text-muted-foreground">
            Cria uma faixa de áudio em uma track própria. O vídeo original
            fica silencioso e você pode mover/cortar o áudio independente.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 w-full gap-2"
            onClick={handleSplit}
          >
            <Scissors className="h-3.5 w-3.5" />
            Separar áudio
          </Button>
        </InspectorSection>
      )}

      <InspectorSection title="Fades">
        <ScrubbableInput
          label="Fade de entrada"
          value={fadeIn}
          min={0}
          max={5}
          step={0.1}
          resetValue={0}
          unit="s"
          onChange={(v) => apply({ fadeInDuration: v })}
          disabled={disabled}
        />
        <ScrubbableInput
          label="Fade de saída"
          value={fadeOut}
          min={0}
          max={5}
          step={0.1}
          resetValue={0}
          unit="s"
          onChange={(v) => apply({ fadeOutDuration: v })}
          disabled={disabled}
        />
      </InspectorSection>
    </div>
  );
}
