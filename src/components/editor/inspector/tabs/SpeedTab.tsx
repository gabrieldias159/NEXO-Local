'use client';

/**
 * Tab Speed do Inspector.
 *
 * Edita `Clip.playbackRate` (0.25 - 4).
 *
 * - Slider grande para ajuste fino.
 * - Botões pre-set para velocidades comuns.
 * - Preview do impacto na duração:
 *     "Original duration: 4.50s → New duration: 9.00s" (a 0.5x).
 *
 * Em multi-seleção, aplica o mesmo rate a todos os clips e desativa
 * o cálculo de duração (mostra "Mixed").
 */

import * as React from 'react';
import type { Clip } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import { ScrubbableInput } from '../controls/ScrubbableInput';
import { InspectorSection } from '../controls/InspectorSection';
import { pickCommonValue } from '../controls/useMixedValue';
import { cn } from '@/lib/utils';

export interface SpeedTabProps {
  clips: Clip[];
}

const PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const;

export function SpeedTab({ clips }: SpeedTabProps) {
  const setClipPlaybackRate = useEditorStore((s) => s.setClipPlaybackRate);

  const rate = pickCommonValue(clips, (c) => c.playbackRate);

  const apply = (newRate: number) => {
    clips.forEach((c) => setClipPlaybackRate(c.id, newRate));
  };

  // Cálculo de duração só faz sentido para clip único.
  const single = clips.length === 1 ? clips[0] : null;
  const originalDuration = single
    ? (single.endInAsset - single.startInAsset)
    : null;
  const newDuration =
    single && rate && rate > 0 ? originalDuration! / rate : null;

  return (
    <div className="space-y-5">
      <InspectorSection title="Velocidade de reprodução">
        <ScrubbableInput
          label="Velocidade"
          value={rate}
          min={0.25}
          max={4}
          step={0.05}
          resetValue={1}
          unit="x"
          onChange={apply}
        />

        <div className="flex flex-wrap gap-1 pt-1">
          {PRESETS.map((preset) => {
            const active = rate !== null && Math.abs(rate - preset) < 1e-6;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => apply(preset)}
                aria-pressed={active}
                className={cn(
                  'rounded-sm border px-2 py-0.5 text-[11px] font-mono transition-colors',
                  active
                    ? 'border-[var(--editor-accent)] bg-[var(--editor-accent-soft)] text-foreground'
                    : 'border-border bg-muted text-muted-foreground hover:bg-border',
                )}
              >
                {preset}x
              </button>
            );
          })}
        </div>
      </InspectorSection>

      <InspectorSection title="Duração">
        {single && originalDuration !== null && newDuration !== null ? (
          <div className="space-y-1 text-[11px]">
            <DurationRow label="Original" value={`${originalDuration.toFixed(2)}s`} />
            <DurationRow
              label="Nova"
              value={`${newDuration.toFixed(2)}s`}
              accent
            />
            <p className="pt-1 text-[10px] text-muted-foreground">
              {rate && rate < 1 && 'Câmera lenta — mais quadros por segundo.'}
              {rate && rate > 1 && 'Avanço rápido — menos quadros por segundo.'}
              {rate === 1 && 'Velocidade original.'}
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {clips.length > 1
              ? `Aplicando a ${clips.length} clips. Selecione um único clip para ver a duração resultante.`
              : 'Nenhum clip selecionado.'}
          </p>
        )}
      </InspectorSection>
    </div>
  );
}

function DurationRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-mono',
          accent
            ? 'text-[var(--editor-accent-strong)]'
            : 'text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}
