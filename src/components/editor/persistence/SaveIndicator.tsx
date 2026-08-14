'use client';

/**
 * Indicador de status de auto-save no header do editor.
 *
 * Estados:
 * - `isSaving === true` → "Salvando..." com spinner.
 * - `saveError !== null` → "Salvo offline" com cloud-off.
 * - `lastSavedAt !== null` → "Salvo às HH:MM" com checkmark.
 * - default → "Não salvo" (cinza).
 *
 * O hook `useAutoSave` precisa estar montado em algum ascendente
 * (`SuiteVideoEditor`) para alimentar o `ui.lastSavedAt` no store.
 */

import { CheckCircle2, CloudOff, Loader2 } from 'lucide-react';
import { useEditorStore } from '@/lib/editor/store';
import { cn } from '@/lib/utils';

function formatTime(date: Date): string {
  return date.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SaveIndicator({ className }: { className?: string }) {
  const isSaving = useEditorStore((s) => s.ui.isSaving ?? false);
  const lastSavedAt = useEditorStore((s) => s.ui.lastSavedAt ?? null);
  const saveError = useEditorStore((s) => s.ui.saveError ?? null);

  let content: React.ReactNode;
  let tone: 'muted' | 'ok' | 'warn' = 'muted';

  if (isSaving) {
    tone = 'muted';
    content = (
      <>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Salvando...</span>
      </>
    );
  } else if (saveError) {
    tone = 'warn';
    content = (
      <>
        <CloudOff className="h-3.5 w-3.5" />
        <span>Salvo offline</span>
      </>
    );
  } else if (lastSavedAt) {
    tone = 'ok';
    content = (
      <>
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span>Salvo às {formatTime(lastSavedAt)}</span>
      </>
    );
  } else {
    content = <span>Não salvo</span>;
  }

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-[11px]',
        tone === 'ok' && 'text-muted-foreground',
        tone === 'warn' && 'text-amber-500',
        tone === 'muted' && 'text-muted-foreground',
        className,
      )}
      aria-live="polite"
    >
      {content}
    </div>
  );
}
