'use client';

/**
 * Marker visual + interativo da transição na timeline.
 *
 * Renderizado entre dois clips adjacentes que possuem `transitionOut`
 * em A e/ou `transitionIn` em B. Fica posicionado no PONTO DO MEIO da
 * janela de transição (em segundos), absoluto dentro da área de clips
 * (mesma referência usada pelos clips).
 *
 * Visual:
 * - Diamante 12×12 px (rotacionado 45deg) na altura média da track.
 * - Hatching diagonal (CSS `repeating-linear-gradient`) por trás,
 *   cobrindo a janela de overlap entre os clips, indicando onde a
 *   transição acontece.
 * - Click no diamante → abre Popover com config (tipo / duration /
 *   easing) e botão "Remover".
 * - Drag horizontal no diamante → ajusta `duration` (estende para
 *   esquerda/direita simultaneamente, mantendo o ponto central).
 *
 * Acessibilidade:
 * - Diamante é um `<button>` com `aria-label` descritivo.
 * - Drag usa `pointerdown/move/up` e ignora click após drag.
 */

import * as React from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
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
import { ScrubbableInput } from '../inspector/controls/ScrubbableInput';
import { transitions, CATEGORY_LABEL } from '@/lib/editor/transitions';
import type { TransitionConfig, TransitionType } from '@/lib/editor/types';
import { cn } from '@/lib/utils';
import { Trash2 } from 'lucide-react';

const DIAMOND_SIZE = 12; // px
const MIN_DURATION = 0.05; // s
const MAX_DURATION_FALLBACK = 5; // s

export interface TransitionMarkerProps {
  fromClipId: string;
  toClipId: string;
  transition: TransitionConfig;
  /** Tempo (s) onde o diamante aparece — meio da janela de transição. */
  position: number;
  /** Zoom px/segundo, para posicionamento absoluto e drag. */
  zoom: number;
  /**
   * Largura visível do hatching (em segundos). Default = `transition.duration`.
   * Permite override caso o caller queira mostrar overlap explícito.
   */
  overlapDuration?: number;
  /** Altura da track (px), para centralizar verticalmente o diamante. */
  trackHeight: number;
  /**
   * Limite máximo (s) ao qual o usuário pode estender duration via drag.
   * Caller passa o min entre as durations de A e B / 2.
   */
  maxDuration?: number;
  onUpdate: (patch: Partial<TransitionConfig>) => void;
  onRemove: () => void;
  className?: string;
}

export function TransitionMarker({
  transition,
  position,
  zoom,
  overlapDuration,
  trackHeight,
  maxDuration = MAX_DURATION_FALLBACK,
  onUpdate,
  onRemove,
  className,
}: TransitionMarkerProps) {
  const dur = overlapDuration ?? transition.duration;
  const half = dur / 2;
  const left = (position - half) * zoom;
  const width = Math.max(2, dur * zoom);

  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const [draftDuration, setDraftDuration] = React.useState<number | null>(null);

  // Drag state — ajusta duration arrastando horizontalmente.
  const dragRef = React.useRef<{
    startX: number;
    startDuration: number;
    moved: boolean;
  } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startDuration: transition.duration,
      moved: false,
    };
    setDraftDuration(transition.duration);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return;
    const deltaPx = e.clientX - dragRef.current.startX;
    if (!dragRef.current.moved && Math.abs(deltaPx) > 3) {
      dragRef.current.moved = true;
    }
    if (!dragRef.current.moved) return;
    const deltaSec = (deltaPx * 2) / zoom; // *2 porque cresce dos dois lados
    const next = clamp(
      dragRef.current.startDuration + deltaSec,
      MIN_DURATION,
      maxDuration,
    );
    setDraftDuration(next);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current) return;
    (e.currentTarget as HTMLButtonElement).releasePointerCapture(e.pointerId);
    if (dragRef.current.moved && draftDuration !== null) {
      onUpdate({ duration: draftDuration });
    }
    const moved = dragRef.current.moved;
    dragRef.current = null;
    setDraftDuration(null);
    // Se moveu, prevent click. Senão, o click abrirá o popover.
    if (moved) {
      e.preventDefault();
    }
  };

  const def = transitions[transition.type];

  // Posicionamento centralizado vertical na altura da track.
  const top = (trackHeight - DIAMOND_SIZE) / 2;

  // Hatching: cobrindo a janela ([position - half, position + half]).
  return (
    <>
      {/* Hatching de fundo */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute',
          'mix-blend-screen',
          className,
        )}
        style={{
          left,
          width,
          top: 4,
          bottom: 4,
          backgroundImage:
            'repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 4px, transparent 4px 8px)',
          borderLeft: '1px dashed rgba(255,255,255,0.25)',
          borderRight: '1px dashed rgba(255,255,255,0.25)',
        }}
      />

      {/* Diamante clicável + drag */}
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Transição ${def.label}, duração ${transition.duration.toFixed(2)}s. Clique para configurar, arraste para ajustar duração.`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onClick={(e) => {
              // Abre só se não foi drag.
              if (dragRef.current?.moved) {
                e.preventDefault();
              }
            }}
            className={cn(
              'absolute z-10',
              'flex items-center justify-center',
              'rounded-[2px] border border-[var(--editor-accent,white)]',
              'bg-[var(--editor-accent,white)]',
              'shadow-md',
              'hover:scale-110 transition-transform',
              'cursor-ew-resize',
            )}
            style={{
              width: DIAMOND_SIZE,
              height: DIAMOND_SIZE,
              left: position * zoom - DIAMOND_SIZE / 2,
              top,
              transform: 'rotate(45deg)',
              touchAction: 'none',
            }}
            title={`${def.label} · ${transition.duration.toFixed(2)}s`}
          />
        </PopoverTrigger>

        <PopoverContent
          align="center"
          side="top"
          sideOffset={8}
          className={cn(
            'w-72 space-y-3 p-3',
            'bg-card text-foreground',
            'border border-border',
          )}
        >
          <header className="flex items-center justify-between">
            <span className="text-[11px] font-semibold">{def.label}</span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {CATEGORY_LABEL[def.category]}
            </span>
          </header>

          {/* Tipo */}
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Tipo
            </label>
            <Select
              value={transition.type}
              onValueChange={(v) => onUpdate({ type: v as TransitionType })}
            >
              <SelectTrigger className="h-7 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['fade', 'slide', 'zoom', 'wipe', 'special'] as const).map(
                  (cat) => (
                    <SelectGroup key={cat}>
                      <SelectLabel className="text-[10px] uppercase tracking-wide">
                        {CATEGORY_LABEL[cat]}
                      </SelectLabel>
                      {Object.entries(transitions)
                        .filter(([, d]) => d.category === cat)
                        .map(([type, d]) => (
                          <SelectItem
                            key={type}
                            value={type}
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
            value={transition.duration}
            min={MIN_DURATION}
            max={maxDuration}
            step={0.05}
            unit="s"
            resetValue={0.5}
            onChange={(v) => onUpdate({ duration: v })}
          />

          {/* Easing */}
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Easing
            </label>
            <Select
              value={transition.easing}
              onValueChange={(v) =>
                onUpdate({ easing: v as TransitionConfig['easing'] })
              }
            >
              <SelectTrigger className="h-7 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="linear" className="text-[11px]">
                  Linear
                </SelectItem>
                <SelectItem value="ease-in" className="text-[11px]">
                  Ease In
                </SelectItem>
                <SelectItem value="ease-out" className="text-[11px]">
                  Ease Out
                </SelectItem>
                <SelectItem value="ease-in-out" className="text-[11px]">
                  Ease In-Out
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onRemove();
                setPopoverOpen(false);
              }}
              className="h-7 gap-1 text-[11px] text-red-400 hover:bg-red-400/10 hover:text-red-300"
            >
              <Trash2 className="h-3 w-3" />
              Remover
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
