'use client';

/**
 * Layout padrão de página do NEXO — unifica os "dois sistemas visuais" que
 * conviviam (header `text-2xl`+ícone vs. caixa `h-10`+`text-lg`; full-width vs.
 * `max-w-6xl`+padding próprio). Decisão do plano de reforma:
 *  - largura full-width com `max-w-7xl` interno (prop `largura`);
 *  - SEM padding próprio (o `<main>` do shell já aplica p-5/6/8 — evita inset duplo);
 *  - header = caixa de ícone h-9 + h1 text-xl semibold + subtítulo + slot de ações;
 *  - entrada animada (framer via NexoEntrada, respeita reduced-motion).
 */
import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';
import { NexoEntrada } from './nexo-motion';

export function NexoPage({
  children,
  largura = 'padrao',
  className,
}: {
  children: React.ReactNode;
  /** 'padrao' = max-w-7xl centralizado; 'fluida' = ocupa toda a largura (grafo/mapa). */
  largura?: 'padrao' | 'fluida';
  className?: string;
}) {
  return (
    <NexoEntrada className={cn('w-full', largura === 'padrao' && 'mx-auto max-w-7xl', className)}>
      <div className="space-y-5">{children}</div>
    </NexoEntrada>
  );
}

export function NexoPageHeader({
  icone: Icone,
  titulo,
  subtitulo,
  children,
}: {
  icone: ComponentType<{ className?: string }>;
  titulo: string;
  subtitulo?: React.ReactNode;
  /** Ações à direita: BadgeAtualizado, botão Atualizar/Compilar, etc. */
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-500/10 ring-1 ring-amber-500/30">
        <Icone className="h-5 w-5 text-amber-400" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold text-slate-100">{titulo}</h1>
        {subtitulo && <p className="mt-0.5 text-[13px] text-slate-400">{subtitulo}</p>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}
