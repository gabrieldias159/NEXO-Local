'use client';

/**
 * Stat tiles padrão do NEXO. `NexoKpi` opcionalmente conta o valor (NumberTicker,
 * respeita reduced-motion). Grid responsivo em `NexoKpiGrid`.
 */
import { cn } from '@/lib/utils';
import { INSET_NEXO } from './nexo-tokens';
import { NumberTicker } from './nexo-motion';

export function NexoKpiGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-3 sm:grid-cols-4', className)}>{children}</div>;
}

export function NexoKpi({
  rotulo,
  valor,
  sufixo,
  animar = true,
  formato,
  cor = 'text-slate-100',
  icone: Icone,
}: {
  rotulo: string;
  valor: number | string;
  sufixo?: string;
  /** anima a contagem (só quando `valor` é número). */
  animar?: boolean;
  formato?: (n: number) => string;
  cor?: string;
  icone?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className={cn(INSET_NEXO, 'p-3')}>
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-slate-400">
        {Icone && <Icone className="h-3.5 w-3.5" aria-hidden="true" />}
        {rotulo}
      </p>
      <p className={cn('mt-1 font-mono text-2xl font-semibold', cor)}>
        {animar && typeof valor === 'number' ? (
          <NumberTicker valor={valor} formato={formato} />
        ) : typeof valor === 'number' ? (
          (formato ?? ((n: number) => n.toLocaleString('pt-BR')))(valor)
        ) : (
          valor
        )}
        {sufixo && <span className="ml-1 text-sm font-normal text-slate-400">{sufixo}</span>}
      </p>
    </div>
  );
}
