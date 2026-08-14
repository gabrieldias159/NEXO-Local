'use client';

/**
 * Card de cue individual no `CaptionsDrawer`.
 *
 * UX:
 * - Timecode mono à esquerda (start / end), editável inline.
 * - Textarea com texto da legenda (auto-resize).
 * - Hover/selected: botões split / merge / delete na lateral direita.
 * - Click em qualquer área do card → seleciona o cue + move o playhead para
 *   `cue.startTime`.
 * - Selected state: borda accent.
 *
 * O card é "controlado" pelo pai via callbacks. Estado local apenas para o
 * texto durante edição (commit no blur).
 */

import * as React from 'react';
import type { CaptionCue } from '@/lib/editor/types';
import { Button } from '@/components/ui/button';
import { Trash2, Combine, Split as SplitIcon } from 'lucide-react';
import {
  formatTimecode,
  parseTimecode,
  isInvalidCue,
} from '@/lib/editor/captions/utils';
import { cn } from '@/lib/utils';

export interface CaptionCueCardProps {
  cue: CaptionCue;
  /** Playhead está dentro do cue. */
  isActive: boolean;
  /** Cue está em `selectedCueIds`. */
  isSelected: boolean;
  /** Pode ser usada como prop de fallback se o parent precisar disable. */
  disabled?: boolean;
  onSelect: () => void;
  onUpdate: (patch: Partial<CaptionCue>) => void;
  onSplit: (atTime: number) => void;
  onDelete: () => void;
  onMergeNext: () => void;
  /** Callback opcional de "next cue" para atalho Tab/Shift+Tab. */
  onFocusNext?: () => void;
  onFocusPrev?: () => void;
  /** Adjust startTime/endTime (callback do pai, evita redundância). */
  onNudgeStart?: (deltaSec: number) => void;
  onNudgeEnd?: (deltaSec: number) => void;
}

export function CaptionCueCard({
  cue,
  isActive,
  isSelected,
  disabled,
  onSelect,
  onUpdate,
  onSplit,
  onDelete,
  onMergeNext,
  onFocusNext,
  onFocusPrev,
  onNudgeStart,
  onNudgeEnd,
}: CaptionCueCardProps) {
  const invalid = isInvalidCue(cue);

  const [draftText, setDraftText] = React.useState(cue.text);
  React.useEffect(() => {
    setDraftText(cue.text);
  }, [cue.id, cue.text]);

  // Auto-resize do textarea.
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draftText]);

  const commitText = React.useCallback(() => {
    if (draftText !== cue.text) {
      onUpdate({ text: draftText });
    }
  }, [draftText, cue.text, onUpdate]);

  const handleStartCommit = (raw: string) => {
    const parsed = parseTimecode(raw);
    if (parsed === null) return;
    onUpdate({ startTime: parsed });
  };
  const handleEndCommit = (raw: string) => {
    const parsed = parseTimecode(raw);
    if (parsed === null) return;
    onUpdate({ endTime: parsed });
  };

  const handleTextareaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const meta = e.ctrlKey || e.metaKey;

    // Tab / Shift+Tab: navega entre cues.
    if (e.key === 'Tab') {
      e.preventDefault();
      commitText();
      if (e.shiftKey) onFocusPrev?.();
      else onFocusNext?.();
      return;
    }

    // Enter sem modificador: split no centro do cue.
    if (e.key === 'Enter' && !e.shiftKey && !meta) {
      e.preventDefault();
      const center = (cue.startTime + cue.endTime) / 2;
      onSplit(center);
      return;
    }

    // Cmd/Ctrl + ↑/↓ → ajustar startTime ±0.1s.
    if (meta && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const delta = e.key === 'ArrowUp' ? -0.1 : 0.1;
      onNudgeStart?.(delta);
      return;
    }

    // Cmd+Shift + ↑/↓ → ajustar endTime ±0.1s.
    if (meta && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const delta = e.key === 'ArrowUp' ? -0.1 : 0.1;
      onNudgeEnd?.(delta);
      return;
    }
  };

  return (
    <div
      data-cue-id={cue.id}
      onClick={onSelect}
      className={cn(
        'group relative flex gap-2 rounded-[var(--editor-radius-md)] border px-2 py-2 transition-colors',
        'cursor-pointer select-none',
        isSelected
          ? 'border-[var(--editor-accent-strong)] bg-muted'
          : invalid
            ? 'border-[var(--editor-danger)] bg-card'
            : isActive
              ? 'border-[var(--editor-track-cc)] bg-card'
              : 'border-border bg-card hover:border-muted-foreground',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      {/* Coluna: timecodes */}
      <div className="flex min-w-[120px] flex-col gap-1">
        <TimecodeInput
          value={cue.startTime}
          onCommit={handleStartCommit}
          label="início"
        />
        <TimecodeInput
          value={cue.endTime}
          onCommit={handleEndCommit}
          label="fim"
          isError={invalid}
        />
        <span className="font-mono text-[9px] text-muted-foreground">
          dur {(cue.endTime - cue.startTime).toFixed(2)}s
        </span>
      </div>

      {/* Coluna: texto */}
      <div className="flex min-w-0 flex-1 flex-col">
        <textarea
          ref={textareaRef}
          value={draftText}
          rows={1}
          onChange={(e) => setDraftText(e.target.value)}
          onBlur={commitText}
          onKeyDown={handleTextareaKey}
          onClick={(e) => e.stopPropagation()}
          placeholder="Texto da legenda…"
          className={cn(
            'w-full resize-none border-0 bg-transparent text-[12px] leading-snug',
            'text-foreground outline-none',
            'placeholder:text-muted-foreground',
          )}
          style={{ overflow: 'hidden' }}
        />
        {invalid && (
          <span className="mt-1 text-[10px] text-[var(--editor-danger)]">
            Tempo inválido (fim ≤ início)
          </span>
        )}
      </div>

      {/* Coluna: ações (visíveis no hover ou selected) */}
      <div
        className={cn(
          'flex flex-col gap-0.5 opacity-0 transition-opacity duration-[var(--editor-motion-fast)]',
          'group-hover:opacity-100',
          isSelected && 'opacity-100',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => onSplit((cue.startTime + cue.endTime) / 2)}
          title="Dividir cue (Enter)"
        >
          <SplitIcon className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => onMergeNext()}
          title="Fundir com próximo"
        >
          <Combine className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 hover:text-[var(--editor-danger)]"
          onClick={() => onDelete()}
          title="Excluir cue"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      {/* Indicador "active" (faixa lateral cc-color) */}
      {isActive && (
        <div
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-[var(--editor-radius-md)]"
          style={{ backgroundColor: 'var(--editor-track-cc)' }}
        />
      )}
    </div>
  );
}

// ============================================================================
// TimecodeInput
// ============================================================================

function TimecodeInput({
  value,
  onCommit,
  label,
  isError,
}: {
  value: number;
  onCommit: (raw: string) => void;
  label: string;
  isError?: boolean;
}) {
  const [draft, setDraft] = React.useState(formatTimecode(value));

  // Sincroniza com props se mudou de fora.
  React.useEffect(() => {
    setDraft(formatTimecode(value));
  }, [value]);

  return (
    <div className="flex items-center gap-1">
      <span className="w-7 text-[9px] uppercase text-muted-foreground">
        {label}
      </span>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => {
          onCommit(e.target.value);
          // Reformata mesmo que parse falhe (devolve formatado válido).
          setDraft(formatTimecode(value));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={cn(
          'w-[100px] rounded-[var(--editor-radius-sm)] border px-1 py-0.5',
          'bg-background font-mono text-[10px] tabular-nums',
          'text-foreground outline-none',
          isError
            ? 'border-[var(--editor-danger)]'
            : 'border-border focus:border-[var(--editor-accent-strong)]',
        )}
        spellCheck={false}
      />
    </div>
  );
}

