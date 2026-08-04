import Link from 'next/link';
import { Hammer } from 'lucide-react';

/**
 * Placeholder padrão dos subsistemas do NEXO ainda não implementados.
 * Mantém a navegação coerente e comunica o que cada subsistema fará.
 */
export interface NexoStubProps {
  titulo: string;
  descricao: string;
  fase: string;
  icon: React.ComponentType<{ className?: string }>;
  detalhes?: string[];
}

export function NexoStub({ titulo, descricao, fase, icon: Icon, detalhes }: NexoStubProps) {
  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-amber-400" />
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">{titulo}</h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">{descricao}</p>
      </div>

      <div className="rounded-lg border border-dashed border-amber-500/20 bg-nexo-surface p-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-amber-500/10 text-amber-400">
            <Hammer className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-200">Subsistema em construção</p>
            <p className="text-xs text-slate-500">
              Previsto para a {fase} do roadmap do NEXO.
            </p>
          </div>
        </div>
        {detalhes && detalhes.length > 0 && (
          <ul className="mt-5 space-y-2 border-t border-white/5 pt-5">
            {detalhes.map((d) => (
              <li key={d} className="flex gap-2 text-sm text-slate-400">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-amber-500" />
                {d}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Link
        href="/nexo"
        className="inline-flex items-center gap-1 text-xs text-slate-500 transition-colors hover:text-amber-400"
      >
        ← Voltar ao Painel de Situação
      </Link>
    </div>
  );
}
