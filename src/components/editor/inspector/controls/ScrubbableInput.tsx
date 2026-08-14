'use client';

/**
 * ScrubbableInput — controle reutilizável do Inspector.
 *
 * Combinação de:
 * - Slider horizontal (Radix via shadcn) com valor numérico ao lado.
 * - Input numérico editável (digitação direta).
 * - "Mixed" placeholder quando `value === null` (multi-seleção com valores
 *   divergentes).
 * - Reset por **duplo-clique** no label ou no slider (volta para
 *   `resetValue` se fornecido).
 * - Acessível: o `<label>` é associado ao slider; teclado Arrow nativo do
 *   slider; `aria-label` ecoa o label visual.
 *
 * Uso típico:
 *   <ScrubbableInput
 *     label="Scale"
 *     value={transform.scale}
 *     min={0.1}
 *     max={5}
 *     step={0.05}
 *     resetValue={1}
 *     unit="x"
 *     onChange={(v) => setClipTransform(id, { scale: v })}
 *   />
 */

import * as React from 'react';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

export interface ScrubbableInputProps {
  label: string;
  /** `null` = valor "mixed" (multi-seleção). */
  value: number | null;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /** Sufixo opcional (%, °, dB, x, px, s). */
  unit?: string;
  /** Valor para reset por duplo-clique. Default: midpoint. */
  resetValue?: number;
  /** Casas decimais para formatação. Auto-detecta a partir de `step`. */
  precision?: number;
  /** Multiplicador para exibição (ex: 100 para mostrar 0-1 como 0-100%). */
  displayScale?: number;
  disabled?: boolean;
  className?: string;
}

function inferPrecision(step: number): number {
  if (step >= 1) return 0;
  // step 0.1 -> 1 casa, 0.01 -> 2, 0.001 -> 3
  const str = step.toString();
  const dot = str.indexOf('.');
  return dot < 0 ? 0 : str.length - dot - 1;
}

export function ScrubbableInput({
  label,
  value,
  min,
  max,
  step,
  onChange,
  unit,
  resetValue,
  precision,
  displayScale = 1,
  disabled,
  className,
}: ScrubbableInputProps) {
  const isMixed = value === null;
  const safeValue = isMixed ? min : (value as number);
  const decimals = precision ?? inferPrecision(step);

  // Buffer local do <input> para permitir digitação livre antes de commitar.
  const [draft, setDraft] = React.useState<string | null>(null);

  const formatted = React.useMemo(() => {
    if (isMixed) return 'Variado';
    return (safeValue * displayScale).toFixed(decimals);
  }, [isMixed, safeValue, displayScale, decimals]);

  const handleSliderChange = React.useCallback(
    (vals: number[]) => {
      if (vals.length > 0) onChange(vals[0]);
    },
    [onChange],
  );

  const handleReset = React.useCallback(() => {
    if (resetValue !== undefined) onChange(resetValue);
  }, [onChange, resetValue]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(e.target.value);
  };

  const commitDraft = () => {
    if (draft === null) return;
    const parsed = Number(draft.replace(',', '.'));
    if (!Number.isNaN(parsed)) {
      const real = parsed / displayScale;
      const clamped = Math.max(min, Math.min(max, real));
      onChange(clamped);
    }
    setDraft(null);
  };

  return (
    <div className={cn('grid w-full min-w-0 grid-cols-[72px_1fr_52px] items-center gap-1.5', className)}>
      <label
        className={cn(
          'cursor-default select-none text-[11px] text-muted-foreground',
          'truncate',
        )}
        onDoubleClick={handleReset}
        title={resetValue !== undefined ? `Duplo-clique para resetar (${resetValue})` : label}
      >
        {label}
      </label>

      <div onDoubleClick={handleReset} className="flex items-center">
        <Slider
          aria-label={label}
          value={[safeValue]}
          min={min}
          max={max}
          step={step}
          onValueChange={handleSliderChange}
          disabled={disabled}
          className={cn(
            isMixed && 'opacity-60',
          )}
        />
      </div>

      <div className="flex min-w-0 items-center justify-end gap-0.5">
        <input
          type="text"
          inputMode="decimal"
          value={draft ?? formatted}
          onChange={handleInputChange}
          onFocus={() => setDraft(formatted)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setDraft(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
          disabled={disabled}
          aria-label={`Valor de ${label}`}
          className={cn(
            'h-6 min-w-0 flex-1 rounded-sm bg-muted px-1.5 text-right',
            'text-[11px] font-mono text-foreground',
            'border border-transparent',
            'focus:border-border focus:outline-none',
            'disabled:opacity-50',
          )}
        />
        {unit && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}
