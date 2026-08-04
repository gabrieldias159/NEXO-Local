'use client';

/**
 * Controles de formulário do NEXO com o foco e a superfície padrão embutidos —
 * mata o `focus:outline-none` + borda tênue do cluster eleições e o anel fraco
 * `amber-500/40` do bloco antigo. Um só idioma de input/select/botão.
 */
import { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { INPUT_NEXO, FOCO_NEXO } from './nexo-tokens';

export const NexoInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function NexoInput({ className, ...props }, ref) {
    return <input ref={ref} className={cn(INPUT_NEXO, 'px-3 py-2 text-sm', className)} {...props} />;
  },
);

export const NexoSelect = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function NexoSelect({ className, children, ...props }, ref) {
    return (
      <select ref={ref} className={cn(INPUT_NEXO, 'px-2 py-2 text-sm', className)} {...props}>
        {children}
      </select>
    );
  },
);

export const NexoBotao = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variante?: 'padrao' | 'ativo' }>(
  function NexoBotao({ className, variante = 'padrao', ...props }, ref) {
    return (
      <button
        ref={ref}
        className={cn(
          'rounded-md border px-3 py-2 text-sm transition-colors',
          variante === 'ativo'
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
            : 'border-white/10 text-slate-300 hover:text-slate-100',
          FOCO_NEXO,
          className,
        )}
        {...props}
      />
    );
  },
);
