'use client';

/**
 * HUD flutuante usado durante drag/trim de clips.
 *
 * Renderiza um pequeno chip no canto superior-esquerdo da viewport
 * (position fixed) mostrando uma label + um valor (ex: tempo `mm:ss.cs`,
 * duração final etc.).
 *
 * Não usa portal — `position: fixed` já é suficiente para "flutuar"
 * acima de qualquer container scrollável.
 */

import { cn } from '@/lib/utils';

interface HudOverlayProps {
  /** Se false, não renderiza nada. */
  visible: boolean;
  /** Linha principal — ex: "00:12.34". */
  label: string;
  /** Linha secundária opcional — ex: "Δ +1.20s". */
  sublabel?: string;
}

export function HudOverlay({ visible, label, sublabel }: HudOverlayProps) {
  if (!visible) return null;
  return (
    <div
      className={cn(
        'pointer-events-none fixed left-4 top-4 z-50 select-none',
        'rounded-[var(--editor-radius-sm)] border border-border',
        'bg-card px-3 py-1.5 shadow-md',
        'font-mono text-[11px] text-foreground',
      )}
    >
      <div>{label}</div>
      {sublabel && (
        <div className="text-[10px] text-muted-foreground">
          {sublabel}
        </div>
      )}
    </div>
  );
}
