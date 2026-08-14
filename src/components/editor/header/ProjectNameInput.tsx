'use client';

/**
 * Input inline para o nome do projeto.
 *
 * Comportamento:
 * - Mostra o nome como texto. Ao clicar, vira `<input>` editável.
 * - Salva no `Enter` ou `blur`. Cancela com `Escape`.
 * - Valor lido do store (`project.name`); update via `setProjectName`.
 *
 * Estilizado para caber na barra de header de 48px.
 */

import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '@/lib/editor/store';
import { cn } from '@/lib/utils';

interface ProjectNameInputProps {
  className?: string;
}

export function ProjectNameInput({ className }: ProjectNameInputProps) {
  const name = useEditorStore((s) => s.project?.name ?? 'Novo projeto');
  const setProjectName = useEditorStore((s) => s.setProjectName);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(name);
      // Foca no próximo tick para garantir que o input já está montado.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, name]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) {
      setProjectName(trimmed);
    }
    setEditing(false);
  };

  const cancel = () => {
    setDraft(name);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          'truncate rounded-[var(--editor-radius-sm)] px-2 py-1 text-sm font-semibold',
          'text-foreground',
          'hover:bg-muted',
          'transition-colors duration-[var(--editor-motion-fast)]',
          className,
        )}
        title="Clique para renomear"
      >
        {name}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') cancel();
      }}
      className={cn(
        'rounded-[var(--editor-radius-sm)] border border-border',
        'bg-card px-2 py-1 text-sm font-semibold',
        'text-foreground',
        'outline-none focus:border-[var(--editor-accent)]',
        className,
      )}
    />
  );
}
