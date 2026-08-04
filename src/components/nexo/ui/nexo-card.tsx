'use client';

/**
 * Card padrão do NEXO (superfície de leitura `nexo-surface`). Variante `inset`
 * para poços internos. `interativo` adiciona hover-lift em CSS puro (não gasta
 * framer com hover). Substitui os três "pretos" hardcoded (#0f1218/#0c0e13/
 * #0a0b0f) espalhados pelas páginas.
 */
import { cn } from '@/lib/utils';
import { CARD_NEXO, INSET_NEXO, FOCO_NEXO } from './nexo-tokens';

export function NexoCard({
  children,
  className,
  variante = 'surface',
  interativo = false,
}: {
  children: React.ReactNode;
  className?: string;
  variante?: 'surface' | 'inset';
  interativo?: boolean;
}) {
  return (
    <div
      className={cn(
        variante === 'inset' ? INSET_NEXO : CARD_NEXO,
        interativo &&
          'cursor-pointer transition hover:-translate-y-0.5 hover:border-white/20 motion-reduce:transform-none',
        interativo && FOCO_NEXO,
        className,
      )}
    >
      {children}
    </div>
  );
}

export function NexoCardTitulo({
  children,
  className,
  icone: Icone,
}: {
  children: React.ReactNode;
  className?: string;
  icone?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <p className={cn('flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400', className)}>
      {Icone && <Icone className="h-3.5 w-3.5" aria-hidden="true" />}
      {children}
    </p>
  );
}
