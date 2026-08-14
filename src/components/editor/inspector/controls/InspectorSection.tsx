'use client';

/**
 * Section heading dentro de uma tab do Inspector.
 *
 * Usado para agrupar controles relacionados (ex: "Position", "Anchor",
 * "Flip"). Visualmente: pequena label uppercase + separador opcional.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InspectorSectionProps {
  title: string;
  /** Conteúdo a renderizar à direita do título (ex: botão de reset). */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function InspectorSection({
  title,
  action,
  children,
  className,
}: InspectorSectionProps) {
  return (
    <section className={cn('space-y-2', className)}>
      <header className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {action}
      </header>
      <div className="space-y-2">{children}</div>
    </section>
  );
}
