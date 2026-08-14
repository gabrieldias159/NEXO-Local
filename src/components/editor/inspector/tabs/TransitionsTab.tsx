'use client';

/**
 * Tab Transitions do Inspector.
 *
 * Mostra a configuração de `transitionIn` e `transitionOut` do clip
 * atualmente selecionado. Permite:
 *
 * - Adicionar uma transição (escolhe tipo num select).
 * - Editar tipo, duration (slider) e easing (select) de cada lado.
 * - Remover a transição (botão).
 *
 * Comportamento em multi-seleção:
 * - Mostra valores comuns; se divergem, indica "Mixed" e não desabilita
 *   os controles — qualquer mudança aplica a TODOS os clips selecionados
 *   (comportamento dos outros tabs).
 *
 * Esta tab é INDEPENDENTE da action `applyTransitionBetween` (que liga
 * dois clips adjacentes pela timeline). Aqui o usuário edita por CLIP,
 * útil para fade-in inicial / fade-out final isolados.
 */

import * as React from 'react';
import type { Clip, TransitionConfig, TransitionType } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import {
  CATEGORY_LABEL,
  transitions as TRANSITION_DEFS,
} from '@/lib/editor/transitions';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ScrubbableInput } from '../controls/ScrubbableInput';
import { InspectorSection } from '../controls/InspectorSection';
import { pickCommonValue } from '../controls/useMixedValue';
import { cn } from '@/lib/utils';
import { Plus, Trash2 } from 'lucide-react';

export interface TransitionsTabProps {
  clips: Clip[];
}

const DEFAULT_TYPE: TransitionType = 'crossfade';
const DEFAULT_DURATION = 0.5;
const DEFAULT_EASING: TransitionConfig['easing'] = 'ease-in-out';

export function TransitionsTab({ clips }: TransitionsTabProps) {
  const setTransition = useEditorStore((s) => s.setTransition);
  const removeTransition = useEditorStore((s) => s.removeTransition);

  // ---- Comuns ------------------------------------------------------------
  const allHaveIn = clips.every((c) => c.transitionIn !== undefined);
  const someHaveIn = clips.some((c) => c.transitionIn !== undefined);
  const allHaveOut = clips.every((c) => c.transitionOut !== undefined);
  const someHaveOut = clips.some((c) => c.transitionOut !== undefined);

  // Para os campos só faz sentido se todos têm a transição setada.
  const inType = allHaveIn
    ? pickCommonValue(clips, (c) => c.transitionIn!.type)
    : null;
  const inDuration = allHaveIn
    ? pickCommonValue(clips, (c) => c.transitionIn!.duration)
    : null;
  const inEasing = allHaveIn
    ? pickCommonValue(clips, (c) => c.transitionIn!.easing)
    : null;

  const outType = allHaveOut
    ? pickCommonValue(clips, (c) => c.transitionOut!.type)
    : null;
  const outDuration = allHaveOut
    ? pickCommonValue(clips, (c) => c.transitionOut!.duration)
    : null;
  const outEasing = allHaveOut
    ? pickCommonValue(clips, (c) => c.transitionOut!.easing)
    : null;

  // ---- Helpers -----------------------------------------------------------
  const applyIn = (patch: Partial<TransitionConfig>) => {
    clips.forEach((c) => {
      const base: TransitionConfig =
        c.transitionIn ?? {
          type: DEFAULT_TYPE,
          duration: DEFAULT_DURATION,
          easing: DEFAULT_EASING,
        };
      setTransition(c.id, 'in', { ...base, ...patch });
    });
  };

  const applyOut = (patch: Partial<TransitionConfig>) => {
    clips.forEach((c) => {
      const base: TransitionConfig =
        c.transitionOut ?? {
          type: DEFAULT_TYPE,
          duration: DEFAULT_DURATION,
          easing: DEFAULT_EASING,
        };
      setTransition(c.id, 'out', { ...base, ...patch });
    });
  };

  const addIn = () => {
    clips.forEach((c) => {
      setTransition(c.id, 'in', {
        type: DEFAULT_TYPE,
        duration: DEFAULT_DURATION,
        easing: DEFAULT_EASING,
      });
    });
  };

  const addOut = () => {
    clips.forEach((c) => {
      setTransition(c.id, 'out', {
        type: DEFAULT_TYPE,
        duration: DEFAULT_DURATION,
        easing: DEFAULT_EASING,
      });
    });
  };

  const removeIn = () => clips.forEach((c) => removeTransition(c.id, 'in'));
  const removeOut = () => clips.forEach((c) => removeTransition(c.id, 'out'));

  // Limite de duração: metade da menor duração entre os clips selecionados.
  const maxDuration = clips.reduce((acc, c) => {
    const dur = c.endInTimeline - c.startInTimeline;
    return Math.min(acc, dur / 2);
  }, Infinity);
  const safeMax = Number.isFinite(maxDuration) && maxDuration > 0.1
    ? maxDuration
    : 5;

  return (
    <div className="space-y-5">
      <SidePanel
        title="Entrada (In)"
        present={allHaveIn}
        partial={!allHaveIn && someHaveIn}
        type={inType}
        duration={inDuration}
        easing={inEasing}
        onAdd={addIn}
        onRemove={removeIn}
        onChange={applyIn}
        maxDuration={safeMax}
      />

      <SidePanel
        title="Saída (Out)"
        present={allHaveOut}
        partial={!allHaveOut && someHaveOut}
        type={outType}
        duration={outDuration}
        easing={outEasing}
        onAdd={addOut}
        onRemove={removeOut}
        onChange={applyOut}
        maxDuration={safeMax}
      />

      {clips.length > 1 && (
        <p className="text-[10px] text-muted-foreground">
          Aplicando em {clips.length} clips selecionados.
        </p>
      )}
    </div>
  );
}

// ============================================================================
// Sub-componente — painel para um lado (in OU out).
// ============================================================================

interface SidePanelProps {
  title: string;
  present: boolean;
  partial: boolean;
  type: TransitionType | null;
  duration: number | null;
  easing: TransitionConfig['easing'] | null;
  onAdd: () => void;
  onRemove: () => void;
  onChange: (patch: Partial<TransitionConfig>) => void;
  maxDuration: number;
}

function SidePanel({
  title,
  present,
  partial,
  type,
  duration,
  easing,
  onAdd,
  onRemove,
  onChange,
  maxDuration,
}: SidePanelProps) {
  return (
    <InspectorSection
      title={title}
      action={
        present ? (
          <button
            type="button"
            onClick={onRemove}
            className={cn(
              'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px]',
              'text-muted-foreground hover:bg-red-400/10 hover:text-red-300',
            )}
            aria-label={`Remover ${title}`}
          >
            <Trash2 className="h-3 w-3" />
            Remover
          </button>
        ) : null
      }
    >
      {!present && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAdd}
          className="h-7 w-full gap-1 text-[11px]"
        >
          <Plus className="h-3 w-3" />
          {partial ? 'Igualar em todos' : 'Adicionar transição'}
        </Button>
      )}

      {present && (
        <div className="space-y-2">
          {/* Tipo */}
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Tipo
            </label>
            <Select
              value={type ?? undefined}
              onValueChange={(v) => onChange({ type: v as TransitionType })}
            >
              <SelectTrigger className="h-7 text-[11px]">
                <SelectValue placeholder={type === null ? 'Variado' : undefined} />
              </SelectTrigger>
              <SelectContent>
                {(['fade', 'slide', 'zoom', 'wipe', 'special'] as const).map(
                  (cat) => (
                    <SelectGroup key={cat}>
                      <SelectLabel className="text-[10px] uppercase tracking-wide">
                        {CATEGORY_LABEL[cat]}
                      </SelectLabel>
                      {Object.entries(TRANSITION_DEFS)
                        .filter(([, d]) => d.category === cat)
                        .map(([t, d]) => (
                          <SelectItem
                            key={t}
                            value={t}
                            className="text-[11px]"
                          >
                            {d.label}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Duration */}
          <ScrubbableInput
            label="Duração"
            value={duration}
            min={0.05}
            max={maxDuration}
            step={0.05}
            unit="s"
            resetValue={0.5}
            onChange={(v) => onChange({ duration: v })}
          />

          {/* Easing */}
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Suavização
            </label>
            <Select
              value={easing ?? undefined}
              onValueChange={(v) =>
                onChange({ easing: v as TransitionConfig['easing'] })
              }
            >
              <SelectTrigger className="h-7 text-[11px]">
                <SelectValue
                  placeholder={easing === null ? 'Variado' : undefined}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="linear" className="text-[11px]">
                  Linear
                </SelectItem>
                <SelectItem value="ease-in" className="text-[11px]">
                  Suave no início
                </SelectItem>
                <SelectItem value="ease-out" className="text-[11px]">
                  Suave no fim
                </SelectItem>
                <SelectItem value="ease-in-out" className="text-[11px]">
                  Suave nas pontas
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </InspectorSection>
  );
}
