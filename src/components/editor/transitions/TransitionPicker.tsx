'use client';

/**
 * Gallery de transições — drawer/popover com grid de cards.
 *
 * Comportamento:
 * - Renderizado via `Sheet` (lateral direito) para não bloquear a
 *   visualização da timeline durante drag.
 * - Filtro por categoria no topo (`Fades`, `Slides`, `Zooms`, `Wipes`,
 *   `Especiais`).
 * - Cada `TransitionCard` é arrastável para uma junção entre clips na
 *   timeline (drop tratado em `TimelineClip`/`TimelineTrack`).
 * - Click no card: chama `onSelect(config)` para que o caller decida o
 *   que fazer (ex: aplicar à seleção atual, ou só destacar).
 *
 * Tipagem:
 * - `onSelect` recebe `TransitionConfig` (com `duration` e `easing`
 *   default — caller pode editar via Inspector).
 */

import * as React from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  CATEGORY_LABEL,
  getTransitionsByCategory,
  type TransitionCategory,
} from '@/lib/editor/transitions';
import type { TransitionConfig, TransitionType } from '@/lib/editor/types';
import { TransitionCard } from './TransitionCard';
import { cn } from '@/lib/utils';

export interface TransitionPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tipo selecionado (apenas visual, opcional). */
  selectedType?: TransitionType;
  /**
   * Disparado quando o usuário CLICA em um card (não inclui drag).
   * O config vem com `duration: 0.5s` e `easing: 'ease-in-out'` —
   * caller pode customizar (ou aplicar diretamente via store).
   */
  onSelect?: (config: TransitionConfig) => void;
}

const ALL_CATEGORIES: Array<TransitionCategory | 'all'> = [
  'all',
  'fade',
  'slide',
  'zoom',
  'wipe',
  'special',
];

const CATEGORY_DISPLAY: Record<TransitionCategory | 'all', string> = {
  all: 'Todas',
  ...CATEGORY_LABEL,
};

export function TransitionPicker({
  open,
  onOpenChange,
  selectedType,
  onSelect,
}: TransitionPickerProps) {
  const [filter, setFilter] = React.useState<TransitionCategory | 'all'>('all');

  const groups = React.useMemo(() => getTransitionsByCategory(), []);

  // Lista renderizada conforme filtro.
  const visibleGroups = React.useMemo(() => {
    const cats: TransitionCategory[] =
      filter === 'all'
        ? (['fade', 'slide', 'zoom', 'wipe', 'special'] as TransitionCategory[])
        : [filter];
    return cats.map((cat) => ({ category: cat, items: groups[cat] }));
  }, [filter, groups]);

  const handleSelect = (type: TransitionType) => {
    onSelect?.({ type, duration: 0.5, easing: 'ease-in-out' });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          'flex w-full max-w-[380px] flex-col gap-3 p-0 sm:w-[380px]',
          'bg-card text-foreground',
          'border-l border-border',
        )}
      >
        <SheetHeader className="space-y-1 px-4 pt-4">
          <SheetTitle className="text-sm font-semibold">
            Transições
          </SheetTitle>
          <SheetDescription className="text-[11px] text-muted-foreground">
            Clique para aplicar à seleção, ou arraste para a junção entre dois clips.
          </SheetDescription>
        </SheetHeader>

        {/* Filtro por categoria */}
        <div className="flex flex-wrap gap-1 px-4">
          {ALL_CATEGORIES.map((cat) => {
            const active = filter === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setFilter(cat)}
                className={cn(
                  'rounded-sm border px-2 py-0.5 text-[11px] font-medium transition-colors',
                  active
                    ? 'border-[var(--editor-accent)] bg-[var(--editor-accent-soft)] text-foreground'
                    : 'border-border bg-muted text-muted-foreground hover:bg-border',
                )}
                aria-pressed={active}
              >
                {CATEGORY_DISPLAY[cat]}
              </button>
            );
          })}
        </div>

        <ScrollArea className="flex-1">
          <div className="space-y-4 px-4 pb-4">
            {visibleGroups.map(({ category, items }) => (
              <section key={category} className="space-y-2">
                {filter === 'all' && (
                  <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {CATEGORY_LABEL[category]}
                  </h3>
                )}
                <div className="grid grid-cols-3 gap-2">
                  {items.map(({ type, def }) => (
                    <TransitionCard
                      key={type}
                      type={type}
                      definition={def}
                      selected={selectedType === type}
                      onSelect={handleSelect}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
