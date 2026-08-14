'use client';

/**
 * Tab Transform do Inspector.
 *
 * Edita `Clip.transform` (ClipTransform) e `Clip.slot`.
 *
 * - Position X/Y: -1 a 1 (relativo ao centro do slot).
 * - Scale: 0.1 a 5.
 * - Rotation: -180 a 180 graus.
 * - Opacity: 0 a 1.
 * - Anchor: 9-point picker (anchorX/anchorY em {0, 0.5, 1}).
 * - Flip horizontal / vertical: toggles.
 * - Slot (visible only if `stageMode === 'split-vertical'`): full/top/bottom.
 *
 * Multi-seleção: aplica em todos os clips selecionados; mostra "Mixed" no
 * input quando os valores divergem.
 */

import * as React from 'react';
import type { Clip, VideoProject } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import { trackLayerCount } from '@/lib/editor/preview-utils';
import { ScrubbableInput } from '../controls/ScrubbableInput';
import { AnchorPicker } from '../controls/AnchorPicker';
import { InspectorSection } from '../controls/InspectorSection';
import { pickCommonValue, pickCommonAnchor } from '../controls/useMixedValue';
import { cn } from '@/lib/utils';
import {
  FlipHorizontal2,
  FlipVertical2,
  Maximize2,
  Minimize2,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';

export interface TransformTabProps {
  clips: Clip[];
  project: VideoProject;
}

export function TransformTab({ clips, project }: TransformTabProps) {
  const setClipTransform = useEditorStore((s) => s.setClipTransform);
  const setClipSlot = useEditorStore((s) => s.setClipSlot);
  const setClipFit = useEditorStore((s) => s.setClipFit);
  const moveClipToLayer = useEditorStore((s) => s.moveClipToLayer);

  // ---- Camada (subtrack) — só faz sentido para clips de tracks de vídeo. ----
  // Resolve a track que contém o(s) clip(s); a UI de camada aparece apenas
  // quando todos os clips selecionados estão numa MESMA track de vídeo.
  const ownerTracks = clips.map((c) =>
    project.tracks.find((t) => t.id === c.trackId),
  );
  const firstTrack = ownerTracks[0];
  const sameVideoTrack =
    !!firstTrack &&
    firstTrack.type === 'video' &&
    ownerTracks.every((t) => t && t.id === firstTrack.id);
  const layerCount = sameVideoTrack ? trackLayerCount(firstTrack) : 1;
  const commonLayer = pickCommonValue(clips, (c) => c.layer ?? 0);

  const moveLayer = (delta: number) => {
    clips.forEach((c) => {
      const cur = c.layer ?? 0;
      const next = Math.max(0, Math.min(layerCount - 1, cur + delta));
      moveClipToLayer(c.id, next);
    });
  };

  const x = pickCommonValue(clips, (c) => c.transform.x);
  const y = pickCommonValue(clips, (c) => c.transform.y);
  const scale = pickCommonValue(clips, (c) => c.transform.scale);
  const rotation = pickCommonValue(clips, (c) => c.transform.rotation);
  const opacity = pickCommonValue(clips, (c) => c.transform.opacity);
  const anchor = pickCommonAnchor(
    clips,
    (c) => c.transform.anchorX,
    (c) => c.transform.anchorY,
  );
  const flipH = pickCommonValue(clips, (c) => c.transform.flipH);
  const flipV = pickCommonValue(clips, (c) => c.transform.flipV);
  const slot = pickCommonValue(clips, (c) => c.slot);
  // `fit` é opcional no modelo (ausente = 'contain').
  const fit = pickCommonValue(clips, (c) => c.fit ?? 'contain');

  const applyTransform = (partial: Parameters<typeof setClipTransform>[1]) => {
    clips.forEach((c) => setClipTransform(c.id, partial));
  };

  const applySlot = (newSlot: 'full' | 'top' | 'bottom') => {
    clips.forEach((c) => setClipSlot(c.id, newSlot));
  };

  const applyFit = (newFit: 'contain' | 'cover') => {
    clips.forEach((c) => setClipFit(c.id, newFit));
  };

  return (
    <div className="space-y-5">
      <InspectorSection title="Posição">
        <ScrubbableInput
          label="X"
          value={x}
          min={-1}
          max={1}
          step={0.01}
          resetValue={0}
          onChange={(v) => applyTransform({ x: v })}
        />
        <ScrubbableInput
          label="Y"
          value={y}
          min={-1}
          max={1}
          step={0.01}
          resetValue={0}
          onChange={(v) => applyTransform({ y: v })}
        />
      </InspectorSection>

      <InspectorSection title="Transformar">
        <ScrubbableInput
          label="Escala"
          value={scale}
          min={0.1}
          max={5}
          step={0.05}
          resetValue={1}
          unit="x"
          onChange={(v) => applyTransform({ scale: v })}
        />
        <ScrubbableInput
          label="Rotação"
          value={rotation}
          min={-180}
          max={180}
          step={1}
          resetValue={0}
          unit="°"
          onChange={(v) => applyTransform({ rotation: v })}
        />
        <ScrubbableInput
          label="Opacidade"
          value={opacity}
          min={0}
          max={1}
          step={0.01}
          resetValue={1}
          unit="%"
          displayScale={100}
          precision={0}
          onChange={(v) => applyTransform({ opacity: v })}
        />
      </InspectorSection>

      <InspectorSection title="Âncora">
        <div className="flex items-center gap-3">
          <AnchorPicker
            value={anchor}
            onChange={(a) => applyTransform({ anchorX: a.x, anchorY: a.y })}
          />
          <div className="text-[10px] text-muted-foreground">
            {anchor === null
              ? 'Variado'
              : `(${anchor.x.toFixed(1)}, ${anchor.y.toFixed(1)})`}
          </div>
        </div>
      </InspectorSection>

      <InspectorSection title="Espelhar">
        <div className="flex gap-2">
          <ToggleButton
            active={flipH === true}
            mixed={flipH === null}
            onClick={() => applyTransform({ flipH: !(flipH ?? false) })}
            aria-label="Espelhar horizontalmente"
          >
            <FlipHorizontal2 className="h-3.5 w-3.5" />
            <span>Horizontal</span>
          </ToggleButton>
          <ToggleButton
            active={flipV === true}
            mixed={flipV === null}
            onClick={() => applyTransform({ flipV: !(flipV ?? false) })}
            aria-label="Espelhar verticalmente"
          >
            <FlipVertical2 className="h-3.5 w-3.5" />
            <span>Vertical</span>
          </ToggleButton>
        </div>
      </InspectorSection>

      {/* Encaixe: como o vídeo/imagem preenche a sua área (palco ou banda). */}
      <InspectorSection title="Encaixe">
        <div className="flex gap-2">
          <ToggleButton
            active={fit === 'cover'}
            mixed={fit === null}
            onClick={() => applyFit('cover')}
            aria-label="Preencher a tela (corta o excesso)"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span>Preencher</span>
          </ToggleButton>
          <ToggleButton
            active={fit === 'contain'}
            mixed={fit === null}
            onClick={() => applyFit('contain')}
            aria-label="Mostrar o vídeo inteiro (com barras)"
          >
            <Minimize2 className="h-3.5 w-3.5" />
            <span>Mostrar tudo</span>
          </ToggleButton>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {fit === 'cover'
            ? 'Preenche a área cortando o que sobra.'
            : fit === 'contain'
              ? 'Mostra o vídeo inteiro (pode sobrar barras).'
              : 'Valores diferentes nos clipes selecionados.'}
        </p>
      </InspectorSection>

      {/* Camada (subtrack) — empilha o clip sobre/sob os da mesma track. */}
      {sameVideoTrack && layerCount > 1 && (
        <InspectorSection title="Camada (subtrack)">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => moveLayer(1)}
              disabled={commonLayer !== null && commonLayer >= layerCount - 1}
              aria-label="Subir uma camada (para cima)"
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-sm border border-border bg-muted',
                'text-muted-foreground hover:bg-border hover:text-foreground',
                'disabled:opacity-40',
              )}
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => moveLayer(-1)}
              disabled={commonLayer !== null && commonLayer <= 0}
              aria-label="Descer uma camada (para baixo)"
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-sm border border-border bg-muted',
                'text-muted-foreground hover:bg-border hover:text-foreground',
                'disabled:opacity-40',
              )}
            >
              <ChevronDown className="h-4 w-4" />
            </button>
            <div className="text-[11px] text-muted-foreground">
              {commonLayer === null
                ? 'Camadas variadas'
                : `Camada ${commonLayer + 1} de ${layerCount}`}
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Camadas maiores ficam por cima no preview e no vídeo final.
          </p>
        </InspectorSection>
      )}

      {project.stageMode === 'split-vertical' && (
        <InspectorSection title="Posição na tela dividida">
          <div className="flex gap-1 rounded-sm border border-border bg-muted p-0.5">
            {(
              [
                { value: 'full', label: 'Tela cheia' },
                { value: 'top', label: 'Cima' },
                { value: 'bottom', label: 'Baixo' },
              ] as const
            ).map((option) => {
              const active = slot === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => applySlot(option.value)}
                  aria-pressed={active}
                  className={cn(
                    'flex-1 rounded-sm px-2 py-1 text-[11px] font-medium transition-colors',
                    active
                      ? 'bg-background text-foreground'
                      : 'text-muted-foreground hover:bg-border',
                    slot === null && !active && 'opacity-60',
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {slot === null && (
            <p className="text-[10px] text-muted-foreground">
              Valores diferentes nos clipes selecionados.
            </p>
          )}
        </InspectorSection>
      )}
    </div>
  );
}

interface ToggleButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean;
  mixed?: boolean;
  children: React.ReactNode;
}

function ToggleButton({ active, mixed, children, className, ...rest }: ToggleButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-sm border px-2 py-1.5 text-[11px] transition-colors',
        active
          ? 'border-[var(--editor-accent)] bg-[var(--editor-accent-soft)] text-foreground'
          : 'border-border bg-muted text-muted-foreground hover:bg-border',
        mixed && 'opacity-60',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
