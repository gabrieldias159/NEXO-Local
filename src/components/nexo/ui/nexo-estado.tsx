'use client';

/**
 * Estados unificados do NEXO — encerra os "dois idiomas" (Skeleton × spinner-card)
 * que conviviam. Quatro situações, um contrato:
 *  - NexoCarregando: SÓ skeleton (spinner fica restrito a botões em voo);
 *  - NexoErro: card com retry — o cluster estático (eleições/pessoa/doadores),
 *    que hoje engole a falha e mostra "vazio", passa a distinguir erro de ausência;
 *  - NexoVazio: ausência real de dado (distinta de erro e de "coleta inativa");
 *  - NexoCompilando: barra de progresso — DETERMINADA quando há `progresso`,
 *    indeterminada (stripe) caso contrário.
 */
import { Skeleton } from '@/components/ui/skeleton';
import { TriangleAlert, Inbox, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CARD_NEXO, FOCO_NEXO } from './nexo-tokens';

export function NexoCarregando({
  variante = 'blocos',
  linhas = 6,
}: {
  variante?: 'kpis' | 'tabela' | 'blocos' | 'detalhe';
  linhas?: number;
}) {
  if (variante === 'kpis') {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (variante === 'tabela') {
    return (
      <div className="space-y-2">
        {Array.from({ length: linhas }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    );
  }
  if (variante === 'detalhe') {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {Array.from({ length: linhas }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full" />
      ))}
    </div>
  );
}

export function NexoErro({
  titulo = 'Não foi possível carregar',
  detalhe,
  aoTentarNovamente,
}: {
  titulo?: string;
  detalhe?: string;
  aoTentarNovamente?: () => void;
}) {
  return (
    <div
      role="alert"
      className={cn(CARD_NEXO, 'flex flex-col items-center gap-3 px-6 py-10 text-center')}
    >
      <TriangleAlert className="h-8 w-8 text-red-400" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-slate-200">{titulo}</p>
        {detalhe && <p className="mt-1 text-xs text-slate-400">{detalhe}</p>}
      </div>
      {aoTentarNovamente && (
        <button
          type="button"
          onClick={aoTentarNovamente}
          className={cn(
            'rounded-md border border-white/10 bg-nexo-chrome px-3 py-1.5 text-xs text-slate-200 hover:border-amber-500/40 hover:text-amber-300',
            FOCO_NEXO,
          )}
        >
          Tentar novamente
        </button>
      )}
    </div>
  );
}

export function NexoVazio({
  titulo,
  dica,
  icone: Icone = Inbox,
}: {
  titulo: string;
  dica?: string;
  icone?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className={cn(CARD_NEXO, 'flex flex-col items-center gap-2 px-6 py-10 text-center')}>
      <Icone className="h-7 w-7 text-slate-500" aria-hidden="true" />
      <p className="text-sm text-slate-300">{titulo}</p>
      {dica && <p className="text-xs text-slate-500">{dica}</p>}
    </div>
  );
}

export function NexoCompilando({
  progresso,
  mensagem = 'Compilando…',
}: {
  /** 0–100. Ausente → barra indeterminada. */
  progresso?: number;
  mensagem?: string;
}) {
  const determinada = typeof progresso === 'number' && progresso >= 0;
  const pct = determinada ? Math.max(2, Math.min(100, progresso!)) : 40;
  return (
    <div className={cn(CARD_NEXO, 'flex flex-col items-center gap-3 px-6 py-10 text-center')}>
      <Loader2 className="h-6 w-6 animate-spin text-amber-400 motion-reduce:animate-none" aria-hidden="true" />
      <p className="text-sm text-slate-300">{mensagem}</p>
      <div className="h-1.5 w-56 overflow-hidden rounded-full bg-white/10">
        <div
          className={cn('h-full rounded-full bg-amber-500 transition-[width] duration-500', !determinada && 'animate-pulse')}
          style={{ width: `${pct}%` }}
        />
      </div>
      {determinada && <p className="text-[11px] text-slate-500">{Math.round(progresso!)}%</p>}
    </div>
  );
}
