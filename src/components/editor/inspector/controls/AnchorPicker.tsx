'use client';

/**
 * AnchorPicker — seletor visual 3x3 de anchor point.
 *
 * Cada célula corresponde a uma combinação `(anchorX, anchorY)` em `{0, 0.5, 1}`.
 * - Top-left = (0, 0)
 * - Center  = (0.5, 0.5)
 * - Bottom-right = (1, 1)
 *
 * Em multi-seleção com valores divergentes, passe `value={null}` para
 * desativar o highlight.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface AnchorPickerProps {
  value: { x: number; y: number } | null;
  onChange: (anchor: { x: number; y: number }) => void;
  className?: string;
}

const POINTS: Array<{ x: number; y: number; label: string }> = [
  { x: 0, y: 0, label: 'Superior esquerdo' },
  { x: 0.5, y: 0, label: 'Superior centro' },
  { x: 1, y: 0, label: 'Superior direito' },
  { x: 0, y: 0.5, label: 'Meio esquerdo' },
  { x: 0.5, y: 0.5, label: 'Centro' },
  { x: 1, y: 0.5, label: 'Meio direito' },
  { x: 0, y: 1, label: 'Inferior esquerdo' },
  { x: 0.5, y: 1, label: 'Inferior centro' },
  { x: 1, y: 1, label: 'Inferior direito' },
];

function isMatch(a: { x: number; y: number } | null, p: { x: number; y: number }): boolean {
  if (!a) return false;
  return Math.abs(a.x - p.x) < 0.01 && Math.abs(a.y - p.y) < 0.01;
}

export function AnchorPicker({ value, onChange, className }: AnchorPickerProps) {
  return (
    <div
      className={cn(
        'inline-grid grid-cols-3 gap-0.5 rounded-sm border border-border bg-muted p-1',
        className,
      )}
      role="radiogroup"
      aria-label="Ponto de âncora"
    >
      {POINTS.map((p) => {
        const active = isMatch(value, p);
        return (
          <button
            key={`${p.x}-${p.y}`}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={p.label}
            onClick={() => onChange({ x: p.x, y: p.y })}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-sm transition-colors',
              'hover:bg-border',
              'focus:outline-none focus:ring-1 focus:ring-[var(--editor-accent)]',
            )}
          >
            <span
              className={cn(
                'block h-1.5 w-1.5 rounded-full transition-colors',
                active
                  ? 'bg-[var(--editor-accent)] shadow-[0_0_0_2px_var(--editor-accent-soft)]'
                  : 'bg-muted-foreground',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
