'use client';

/**
 * Tab Filters do Inspector.
 *
 * Edita `Clip.filters` (ClipFilters): brightness, contrast, saturation, hue,
 * blur, grayscale.
 *
 * Botão "Reset filters" zera todos os valores para os defaults do store
 * (`DEFAULT_FILTERS`), mantendo simetria com o reset por duplo-clique de cada
 * slider individual.
 */

import * as React from 'react';
import type { Clip, ClipChromaKey, ClipFilters } from '@/lib/editor/types';
import { LUMA_BLACK_PRESET } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { ScrubbableInput } from '../controls/ScrubbableInput';
import { InspectorSection } from '../controls/InspectorSection';
import { pickCommonValue } from '../controls/useMixedValue';
import { RotateCcw, Pipette, Cpu, Cloud } from 'lucide-react';
import { cn } from '@/lib/utils';

// Browser EyeDropper API typings (Chrome/Edge 95+).
interface EyeDropperResult {
  sRGBHex: string;
}
interface EyeDropperConstructor {
  new (): { open(): Promise<EyeDropperResult> };
}
declare global {
  interface Window {
    EyeDropper?: EyeDropperConstructor;
  }
}

export interface FiltersTabProps {
  clips: Clip[];
}

const DEFAULTS: ClipFilters = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  hue: 0,
  blur: 0,
  grayscale: 0,
};

export function FiltersTab({ clips }: FiltersTabProps) {
  const setClipFilters = useEditorStore((s) => s.setClipFilters);
  const setClipChromaKey = useEditorStore((s) => s.setClipChromaKey);

  const chromaEnabled = pickCommonValue(clips, (c) => c.chromaKey?.enabled === true);
  const chromaColor = pickCommonValue(clips, (c) => c.chromaKey?.color ?? '#00b140');
  const chromaSimilarity = pickCommonValue(clips, (c) => c.chromaKey?.similarity ?? 0.4);
  const chromaSmoothness = pickCommonValue(clips, (c) => c.chromaKey?.smoothness ?? 0.1);
  const chromaSpill = pickCommonValue(clips, (c) => c.chromaKey?.spillSuppression ?? 0.2);
  const chromaEngine = pickCommonValue(clips, (c) => c.chromaKey?.engine ?? 'webgl');
  const chromaMode = pickCommonValue(clips, (c) => c.chromaKey?.mode ?? 'chroma');
  const lumaThreshold = pickCommonValue(clips, (c) => c.chromaKey?.lumaThreshold ?? 0.05);
  const lumaTolerance = pickCommonValue(clips, (c) => c.chromaKey?.lumaTolerance ?? 0.12);
  const lumaSoftness = pickCommonValue(clips, (c) => c.chromaKey?.lumaSoftness ?? 0.08);

  const { toast } = useToast();

  const applyChroma = (partial: Partial<ClipChromaKey>) => {
    clips.forEach((c) => setClipChromaKey(c.id, partial));
  };

  const pickColorFromScreen = async () => {
    if (typeof window === 'undefined' || !window.EyeDropper) {
      toast({
        title: 'Conta-gotas indisponível',
        description:
          'O navegador atual não suporta a API EyeDropper. Use Chrome ou Edge 95+ para amostrar cor da tela.',
        variant: 'destructive',
      });
      return;
    }
    try {
      const dropper = new window.EyeDropper();
      const res = await dropper.open();
      applyChroma({ color: res.sRGBHex });
    } catch {
      // user cancelou — silenciar
    }
  };

  const brightness = pickCommonValue(clips, (c) => c.filters.brightness);
  const contrast = pickCommonValue(clips, (c) => c.filters.contrast);
  const saturation = pickCommonValue(clips, (c) => c.filters.saturation);
  const hue = pickCommonValue(clips, (c) => c.filters.hue);
  const blur = pickCommonValue(clips, (c) => c.filters.blur);
  const grayscale = pickCommonValue(clips, (c) => c.filters.grayscale);

  const apply = (partial: Partial<ClipFilters>) => {
    clips.forEach((c) => setClipFilters(c.id, partial));
  };

  const resetAll = () => {
    clips.forEach((c) => setClipFilters(c.id, { ...DEFAULTS }));
  };

  return (
    <div className="space-y-5">
      <InspectorSection
        title="Cor"
        action={
          <button
            type="button"
            onClick={resetAll}
            className={cn(
              'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px]',
              'text-muted-foreground',
              'hover:bg-muted hover:text-foreground',
            )}
            aria-label="Restaurar filtros"
          >
            <RotateCcw className="h-3 w-3" />
            Restaurar
          </button>
        }
      >
        <ScrubbableInput
          label="Brilho"
          value={brightness}
          min={0}
          max={2}
          step={0.05}
          resetValue={1}
          unit="x"
          onChange={(v) => apply({ brightness: v })}
        />
        <ScrubbableInput
          label="Contraste"
          value={contrast}
          min={0}
          max={2}
          step={0.05}
          resetValue={1}
          unit="x"
          onChange={(v) => apply({ contrast: v })}
        />
        <ScrubbableInput
          label="Saturação"
          value={saturation}
          min={0}
          max={2}
          step={0.05}
          resetValue={1}
          unit="x"
          onChange={(v) => apply({ saturation: v })}
        />
        <ScrubbableInput
          label="Matiz"
          value={hue}
          min={-180}
          max={180}
          step={1}
          resetValue={0}
          unit="°"
          onChange={(v) => apply({ hue: v })}
        />
      </InspectorSection>

      <InspectorSection title="Efeitos">
        <ScrubbableInput
          label="Desfoque"
          value={blur}
          min={0}
          max={20}
          step={0.5}
          resetValue={0}
          unit="px"
          onChange={(v) => apply({ blur: v })}
        />
        <ScrubbableInput
          label="Escala de cinza"
          value={grayscale}
          min={0}
          max={1}
          step={0.05}
          resetValue={0}
          unit="%"
          displayScale={100}
          precision={0}
          onChange={(v) => apply({ grayscale: v })}
        />
      </InspectorSection>

      <InspectorSection title="Blur de fundo por janela">
        <BlurWindowsSection clips={clips} />
      </InspectorSection>

      <InspectorSection title="Chroma Key (remover fundo)">
        <div className="flex items-center justify-between pb-1">
          <Label htmlFor="chroma-enabled" className="text-[11px] text-muted-foreground">
            Ativar
          </Label>
          <Switch
            id="chroma-enabled"
            checked={chromaEnabled === true}
            onCheckedChange={(v) => applyChroma({ enabled: v })}
          />
        </div>
        {/* Preset do gabinete: arte em fundo PRETO puro vazada sobre o vídeo
            (chuva de R$ etc.) — lumakey threshold 0,05 (efeito_tela). */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mb-2 h-7 w-full gap-1 text-[11px]"
          onClick={() => applyChroma({ ...LUMA_BLACK_PRESET })}
          title="Liga o modo luminância com os valores do render aprovado (threshold 0,05 / tolerância 0,12 / suavidade 0,08)"
        >
          Preset: fundo preto (lumakey)
        </Button>

        <div className={cn(!chromaEnabled && 'pointer-events-none opacity-50')}>
          {/* Modo: cor (chroma) × luminância (luma) */}
          <div className="mb-2 grid grid-cols-2 gap-1">
            {(['chroma', 'luma'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => applyChroma({ mode: m })}
                className={cn(
                  'rounded-sm border px-2 py-1 text-[10px] transition-colors',
                  chromaMode === m
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-accent',
                )}
              >
                {m === 'chroma' ? 'Por cor (verde)' : 'Fundo preto (luma)'}
              </button>
            ))}
          </div>

          {chromaMode === 'luma' && (
            <>
              <ScrubbableInput
                label="Limiar (preto)"
                value={lumaThreshold}
                min={0}
                max={0.5}
                step={0.01}
                resetValue={0.05}
                unit="%"
                displayScale={100}
                precision={0}
                onChange={(v) => applyChroma({ lumaThreshold: v })}
              />
              <ScrubbableInput
                label="Tolerância"
                value={lumaTolerance}
                min={0}
                max={0.5}
                step={0.01}
                resetValue={0.12}
                unit="%"
                displayScale={100}
                precision={0}
                onChange={(v) => applyChroma({ lumaTolerance: v })}
              />
              <ScrubbableInput
                label="Suavidade"
                value={lumaSoftness}
                min={0}
                max={0.5}
                step={0.01}
                resetValue={0.08}
                unit="%"
                displayScale={100}
                precision={0}
                onChange={(v) => applyChroma({ lumaSoftness: v })}
              />
              <p className="pb-1 pt-1 text-[10px] text-muted-foreground">
                Derruba o quase-preto para transparente — arte com fundo preto
                puro flutua sobre o vídeo. Limiar baixo não come texto escuro.
              </p>
            </>
          )}

          {chromaMode !== 'luma' && (
          <>
          <div className="flex items-center justify-between gap-2 pb-2">
            <Label className="text-[11px] text-muted-foreground">Cor do fundo</Label>
            <div className="flex items-center gap-1">
              <Input
                type="color"
                value={(chromaColor as string) ?? '#00b140'}
                onChange={(e) => applyChroma({ color: e.target.value })}
                className="h-7 w-14 cursor-pointer p-0.5"
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-7 w-7"
                onClick={pickColorFromScreen}
                title="Pegar cor da tela (conta-gotas)"
              >
                <Pipette className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <ScrubbableInput
            label="Tolerância"
            value={chromaSimilarity}
            min={0}
            max={1}
            step={0.02}
            resetValue={0.4}
            unit="%"
            displayScale={100}
            precision={0}
            onChange={(v) => applyChroma({ similarity: v })}
          />
          <ScrubbableInput
            label="Suavidade"
            value={chromaSmoothness}
            min={0}
            max={1}
            step={0.02}
            resetValue={0.1}
            unit="%"
            displayScale={100}
            precision={0}
            onChange={(v) => applyChroma({ smoothness: v })}
          />
          <ScrubbableInput
            label="Reduzir verde"
            value={chromaSpill}
            min={0}
            max={1}
            step={0.05}
            resetValue={0.2}
            unit="%"
            displayScale={100}
            precision={0}
            onChange={(v) => applyChroma({ spillSuppression: v })}
          />
          </>
          )}
          <div className="pt-3">
            <Label className="text-[11px] text-muted-foreground">Motor</Label>
            <div className="mt-1 grid grid-cols-3 gap-1">
              {(['webgl', 'canvas2d', 'cloud'] as const).map((eng) => {
                const active = chromaEngine === eng;
                const Icon = eng === 'cloud' ? Cloud : Cpu;
                const label =
                  eng === 'webgl'
                    ? 'GPU'
                    : eng === 'canvas2d'
                      ? 'CPU'
                      : 'Nuvem';
                return (
                  <button
                    key={eng}
                    type="button"
                    onClick={() => applyChroma({ engine: eng })}
                    className={cn(
                      'flex flex-col items-center gap-0.5 rounded-sm border px-2 py-1.5 text-[10px] transition-colors',
                      active
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border bg-card text-muted-foreground hover:bg-accent',
                    )}
                  >
                    <Icon className="h-3 w-3" />
                    <span className="font-medium">{label}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {chromaEngine === 'cloud'
                ? 'Preview via GPU local; chroma key aplicado pelo ffmpeg no servidor durante o EXPORT (qualidade superior).'
                : chromaEngine === 'canvas2d'
                  ? 'CPU pixel-loop (fallback). Use se GPU der erro.'
                  : 'GPU local em tempo real via WebGL shader (recomendado).'}
            </p>
          </div>
          {chromaMode !== 'luma' && (
            <p className="pt-2 text-[10px] text-muted-foreground">
              Use a cor padrão verde (#00b140) ou o conta-gotas pra amostrar
              a cor exata do fundo do seu vídeo.
            </p>
          )}
        </div>
      </InspectorSection>
    </div>
  );
}

// ============================================================================
// Blur de fundo por janela (recurso 7 do fluxo do gabinete)
// ============================================================================

/**
 * Janelas de blur do PRIMEIRO clip selecionado: boxblur=10 + brilho −6%
 * entre t1..t2 — usado sob as palavras empilhadas. O preview aplica um blur
 * CSS equivalente quando o playhead está dentro da janela.
 */
function BlurWindowsSection({ clips }: { clips: Clip[] }) {
  const clip = clips[0];
  const playhead = useEditorStore((s) => s.ui.playhead);
  const setClipBlurWindows = useEditorStore((s) => s.setClipBlurWindows);
  if (!clip) return null;
  const windows = clip.blurWindows ?? [];

  const update = (
    idx: number,
    campo: 'start' | 'end',
    valor: number,
  ) => {
    const next = windows.map((w, i) =>
      i === idx ? { ...w, [campo]: valor } : w,
    );
    setClipBlurWindows(clip.id, next);
  };

  return (
    <div className="space-y-1.5">
      {windows.map((w, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input
            type="number"
            value={w.start}
            step={0.1}
            onChange={(e) => update(i, 'start', Number(e.target.value) || 0)}
            className="h-6 flex-1 text-[11px] tabular-nums"
            title="Início (s da timeline)"
          />
          <span className="text-[10px] text-muted-foreground">→</span>
          <Input
            type="number"
            value={w.end}
            step={0.1}
            onChange={(e) => update(i, 'end', Number(e.target.value) || 0)}
            className="h-6 flex-1 text-[11px] tabular-nums"
            title="Fim (s da timeline)"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() =>
              setClipBlurWindows(
                clip.id,
                windows.filter((_, j) => j !== i),
              )
            }
            title="Remover janela"
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 w-full text-[11px]"
        onClick={() =>
          setClipBlurWindows(clip.id, [
            ...windows,
            { start: playhead, end: playhead + 2 },
          ])
        }
        title="boxblur=10 + brilho −6% entre as janelas (o preset das palavras empilhadas)"
      >
        Adicionar janela no playhead (+2s)
      </Button>
      <p className="text-[10px] text-muted-foreground">
        Desfoca e escurece o clip nos trechos marcados — o fundo das palavras
        empilhadas. Preview aproximado; o export usa boxblur=10 exato.
      </p>
    </div>
  );
}
