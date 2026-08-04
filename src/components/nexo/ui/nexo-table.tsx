'use client';

/**
 * Primitivas de tabela do NEXO com acessibilidade e mobile embutidos:
 *  - `NexoTableWrap`: envelope com `overflow-x-auto` (corrige o `overflow-hidden`
 *    do cluster eleições que cortava colunas no celular) + thead `nexo-chrome`.
 *  - `NexoThOrdenavel`: cabeçalho com `aria-sort` e botão interno acessível.
 *  - `NexoTrExpansivel`: linha que expande por clique OU teclado (Enter/Espaço),
 *    com `aria-expanded` — substitui o `<tr onClick>` só-mouse (ex.: doadores).
 */
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';
import { FOCO_NEXO } from './nexo-tokens';

export function NexoTableWrap({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto rounded-lg border border-white/10', className)}>
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

export function NexoThead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="bg-nexo-chrome text-[11px] uppercase tracking-wide text-slate-400">
      {children}
    </thead>
  );
}

type Ordem = 'asc' | 'desc' | null;

/** `<th>` ordenável com `aria-sort` e botão interno (teclado + leitor de tela). */
export function NexoThOrdenavel({
  children,
  ordem,
  aoOrdenar,
  className,
  align = 'left',
}: {
  children: React.ReactNode;
  ordem: Ordem;
  aoOrdenar: () => void;
  className?: string;
  align?: 'left' | 'right' | 'center';
}) {
  const ariaSort = ordem === 'asc' ? 'ascending' : ordem === 'desc' ? 'descending' : 'none';
  return (
    <th
      aria-sort={ariaSort}
      className={cn('px-3 py-2', align === 'right' && 'text-right', align === 'center' && 'text-center', align === 'left' && 'text-left', className)}
    >
      <button
        type="button"
        onClick={aoOrdenar}
        className={cn('inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-slate-200', FOCO_NEXO)}
      >
        {children}
        <span aria-hidden="true" className="text-slate-500">
          {ordem === 'asc' ? '▲' : ordem === 'desc' ? '▼' : '↕'}
        </span>
      </button>
    </th>
  );
}

/**
 * Linha expansível acessível. Renderiza a `<tr>` clicável (role=button na 1ª
 * célula via chevron) + a `<tr>` de detalhe quando `aberto`. O consumidor passa
 * as células da linha (`children`) e o conteúdo expandido (`detalhe`).
 */
export function NexoTrExpansivel({
  aberto,
  aoAlternar,
  children,
  detalhe,
  colSpan,
  idDetalhe,
}: {
  aberto: boolean;
  aoAlternar: () => void;
  children: React.ReactNode;
  detalhe: React.ReactNode;
  colSpan: number;
  idDetalhe: string;
}) {
  return (
    <>
      <tr
        onClick={aoAlternar}
        className="cursor-pointer bg-nexo-inset transition-colors hover:bg-white/[0.04]"
      >
        <td className="w-8 px-2 py-2 align-top">
          <button
            type="button"
            aria-expanded={aberto}
            aria-controls={idDetalhe}
            onClick={(e) => {
              e.stopPropagation();
              aoAlternar();
            }}
            className={cn('rounded text-slate-500 hover:text-slate-200', FOCO_NEXO)}
          >
            <ChevronRight className={cn('h-4 w-4 transition-transform', aberto && 'rotate-90')} />
            <span className="sr-only">{aberto ? 'Recolher' : 'Expandir'} detalhes</span>
          </button>
        </td>
        {children}
      </tr>
      {aberto && (
        <tr id={idDetalhe} className="bg-nexo-chrome">
          <td colSpan={colSpan} className="px-4 py-3">
            {detalhe}
          </td>
        </tr>
      )}
    </>
  );
}
