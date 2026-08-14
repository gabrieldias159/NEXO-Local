'use client';

/**
 * Drawer lateral de edição de legendas.
 *
 * Estrutura:
 * - Header: dropdown com tracks de legenda + botão "Nova track" + nome
 *   editável da track ativa.
 * - Toolbar: importar `.srt`, exportar `.srt`, novo cue, estilo padrão,
 *   fechar.
 * - Lista de cards de cue (scroll vertical).
 * - Footer: contagem de cues + duração total da track.
 *
 * Aberto via `useCaptionsDrawer().open` (atalho `Shift+L` ou botão na
 * `TimelineToolbar`).
 *
 * **Sem IA** — fluxo manual + import.
 */

import * as React from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { useEditorStore } from '@/lib/editor/store';
import {
  formatTimecode,
  findActiveCue,
  mergeCues,
  splitCueAt,
  findNextCue,
  findPrevCue,
} from '@/lib/editor/captions/utils';
import {
  parseSubtitleFile,
  exportSrt as serializeSrt,
} from '@/lib/editor/captions/parser';
import type { CaptionCue, CaptionStyle, CaptionTrack } from '@/lib/editor/types';

import { useCaptionsDrawer } from './useCaptionsDrawer';
import { CaptionCueCard } from './CaptionCueCard';
import { CaptionImportDialog, type ImportMode } from './CaptionImportDialog';
import { CaptionStyleEditor } from './CaptionStyleEditor';
import { CaptionGenerateDialog } from './CaptionGenerateDialog';
import { CaptionTranscribeDialog } from './CaptionTranscribeDialog';
import { useToast } from '@/hooks/use-toast';
import {
  Plus,
  Trash2,
  Download,
  Upload,
  Type as TypeIcon,
  X,
  Sparkles,
  Captions,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ============================================================================
// Drawer
// ============================================================================

export function CaptionsDrawer() {
  const open = useCaptionsDrawer((s) => s.open);
  const setOpen = useCaptionsDrawer((s) => s.setOpen);
  const focusCueId = useCaptionsDrawer((s) => s.focusCueId);
  const { toast } = useToast();

  const captionTracks = useEditorStore(
    (s) => s.project?.captionTracks ?? [],
  );
  const playhead = useEditorStore((s) => s.ui.playhead);
  const selectedCueIds = useEditorStore((s) => s.ui.selectedCueIds);

  const addCaptionTrack = useEditorStore((s) => s.addCaptionTrack);
  const removeCaptionTrack = useEditorStore((s) => s.removeCaptionTrack);
  const renameCaptionTrack = useEditorStore((s) => s.renameCaptionTrack);
  const addCaption = useEditorStore((s) => s.addCaption);
  const updateCaption = useEditorStore((s) => s.updateCaption);
  const removeCaption = useEditorStore((s) => s.removeCaption);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const selectCue = useEditorStore((s) => s.selectCue);

  // Track ativo: o primeiro existente, ou null.
  const [activeTrackId, setActiveTrackId] = React.useState<string | null>(
    null,
  );
  React.useEffect(() => {
    // Mantém a track ativa válida; senão escolhe a primeira.
    if (
      activeTrackId &&
      captionTracks.find((t) => t.id === activeTrackId)
    ) {
      return;
    }
    setActiveTrackId(captionTracks[0]?.id ?? null);
  }, [captionTracks, activeTrackId]);

  const activeTrack: CaptionTrack | null = React.useMemo(
    () => captionTracks.find((t) => t.id === activeTrackId) ?? null,
    [captionTracks, activeTrackId],
  );

  const activeCue =
    activeTrack && findActiveCue(activeTrack.cues, playhead);

  const [importOpen, setImportOpen] = React.useState(false);
  const [styleEditorOpen, setStyleEditorOpen] = React.useState(false);
  const [generateOpen, setGenerateOpen] = React.useState(false);
  const [transcribeOpen, setTranscribeOpen] = React.useState(false);

  // Scroll para o cue focado quando o drawer abrir.
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open || !focusCueId) return;
    const el = listRef.current?.querySelector(
      `[data-cue-id="${focusCueId}"]`,
    );
    if (el) {
      (el as HTMLElement).scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      });
    }
  }, [open, focusCueId, activeTrack]);

  // ----- handlers -----------------------------------------------------------

  const handleNewTrack = () => {
    const id = addCaptionTrack();
    setActiveTrackId(id);
  };

  const handleDeleteTrack = () => {
    if (!activeTrack) return;
    if (
      !window.confirm(
        `Excluir a track "${activeTrack.name}" e suas ${activeTrack.cues.length} cues?`,
      )
    ) {
      return;
    }
    removeCaptionTrack(activeTrack.id);
    setActiveTrackId(null);
  };

  const handleRename = (name: string) => {
    if (!activeTrack) return;
    renameCaptionTrack(activeTrack.id, name || 'Legendas');
  };

  const handleNewCueAtPlayhead = () => {
    let trackId = activeTrack?.id;
    if (!trackId) {
      trackId = addCaptionTrack();
      setActiveTrackId(trackId);
    }
    addCaption(trackId, {
      startTime: playhead,
      endTime: playhead + 4,
      text: '',
      slot: 'full',
      style: defaultStyle(),
    });
  };

  const handleImportConfirm = (
    parsed: Array<Omit<CaptionCue, 'id'>>,
    mode: ImportMode,
    filename: string,
  ) => {
    let trackId = activeTrack?.id;
    if (mode === 'replace' && trackId) {
      // Remove cues existentes (uma a uma).
      const ids = activeTrack ? activeTrack.cues.map((c) => c.id) : [];
      ids.forEach((id) => removeCaption(id));
    } else if (!trackId) {
      // Cria nova track.
      trackId = addCaptionTrack(filename.replace(/\.(srt|vtt)$/i, ''));
      setActiveTrackId(trackId);
    }
    for (const cue of parsed) {
      addCaption(trackId, cue);
    }
    toast({
      title: `Importadas ${parsed.length} legendas`,
      description: filename,
    });
  };

  const handleExport = async () => {
    if (!activeTrack || activeTrack.cues.length === 0) {
      toast({
        title: 'Nada para exportar',
        description: 'A track não tem cues.',
      });
      return;
    }
    const srt = serializeSrt(activeTrack.cues);
    const blob = new Blob([srt], { type: 'application/x-subrip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTrack.name || 'legendas'}.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleSelectCue = (cue: CaptionCue) => {
    selectCue(cue.id);
    setPlayhead(cue.startTime);
  };

  const handleSplit = (cue: CaptionCue, atTime: number) => {
    if (!activeTrack) return;
    const [a, b] = splitCueAt(cue, atTime);
    // Atualiza o cue original (parte A)
    updateCaption(cue.id, {
      startTime: a.startTime,
      endTime: a.endTime,
      text: a.text,
    });
    // Cria novo cue (parte B)
    addCaption(activeTrack.id, {
      startTime: b.startTime,
      endTime: b.endTime,
      text: b.text,
      slot: b.slot,
      style: { ...b.style },
    });
  };

  const handleMergeNext = (cue: CaptionCue) => {
    if (!activeTrack) return;
    const next = findNextCue(activeTrack.cues, cue);
    if (!next) {
      toast({ title: 'Sem próximo cue para fundir' });
      return;
    }
    const merged = mergeCues(cue, next);
    updateCaption(cue.id, {
      startTime: merged.startTime,
      endTime: merged.endTime,
      text: merged.text,
    });
    removeCaption(next.id);
  };

  const handleNudge = (
    cue: CaptionCue,
    field: 'startTime' | 'endTime',
    delta: number,
  ) => {
    const next = cue[field] + delta;
    updateCaption(cue.id, { [field]: Math.max(0, next) });
  };

  // Focus next/prev card
  const handleFocusSibling = (
    cue: CaptionCue,
    direction: 'next' | 'prev',
  ) => {
    if (!activeTrack) return;
    const target =
      direction === 'next'
        ? findNextCue(activeTrack.cues, cue)
        : findPrevCue(activeTrack.cues, cue);
    if (!target) return;
    selectCue(target.id);
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector(
        `[data-cue-id="${target.id}"] textarea`,
      );
      if (el) (el as HTMLTextAreaElement).focus();
    });
  };

  // ----- render -------------------------------------------------------------

  const totalDuration =
    activeTrack && activeTrack.cues.length > 0
      ? Math.max(...activeTrack.cues.map((c) => c.endTime))
      : 0;

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className={cn(
            'flex w-full max-w-[480px] flex-col gap-0 overflow-hidden p-0 sm:w-[480px]',
            'bg-card text-foreground',
          )}
          style={{ borderLeftColor: 'var(--editor-track-cc)', borderLeftWidth: 2 }}
        >
          {/* Header */}
          <SheetHeader className="space-y-2 border-b border-border p-3 text-left">
            <SheetTitle className="flex items-center gap-2 text-sm font-semibold">
              <TypeIcon className="h-4 w-4" style={{ color: 'var(--editor-track-cc)' }} />
              Editor de Legendas
              <span className="ml-1 text-[9px] font-normal uppercase tracking-wider text-muted-foreground">
                sem IA
              </span>
            </SheetTitle>

            <div className="flex items-center gap-2">
              <Select
                value={activeTrackId ?? '__none'}
                onValueChange={(v) =>
                  setActiveTrackId(v === '__none' ? null : v)
                }
                disabled={captionTracks.length === 0}
              >
                <SelectTrigger className="h-7 flex-1 text-[11px]">
                  <SelectValue
                    placeholder={
                      captionTracks.length === 0
                        ? 'Nenhuma track'
                        : 'Selecione…'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {captionTracks.map((t) => (
                    <SelectItem
                      key={t.id}
                      value={t.id}
                      className="text-[11px]"
                    >
                      {t.name} · {t.cues.length} cue(s)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={handleNewTrack}
              >
                <Plus className="h-3 w-3" /> Nova
              </Button>
            </div>

            {activeTrack && (
              <div className="flex items-center gap-2">
                <Input
                  value={activeTrack.name}
                  onChange={(e) => handleRename(e.target.value)}
                  className="h-7 text-[11px]"
                  placeholder="Nome da track"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 hover:text-[var(--editor-danger)]"
                  onClick={handleDeleteTrack}
                  title="Excluir track"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </SheetHeader>

          {/* Toolbar */}
          <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
            <ToolbarBtn
              icon={<Captions className="h-3.5 w-3.5" />}
              label="Gerar legenda do áudio"
              onClick={() => setTranscribeOpen(true)}
              accent
            />
            <ToolbarBtn
              icon={<Sparkles className="h-3.5 w-3.5" />}
              label="Gerar com IA"
              onClick={() => setGenerateOpen(true)}
            />
            <ToolbarBtn
              icon={<Upload className="h-3.5 w-3.5" />}
              label="Importar .srt"
              onClick={() => setImportOpen(true)}
            />
            <ToolbarBtn
              icon={<Download className="h-3.5 w-3.5" />}
              label="Exportar .srt"
              onClick={handleExport}
              disabled={!activeTrack || activeTrack.cues.length === 0}
            />
            <Separator />
            <ToolbarBtn
              icon={<Plus className="h-3.5 w-3.5" />}
              label="Novo cue"
              onClick={handleNewCueAtPlayhead}
            />
            <ToolbarBtn
              icon={<TypeIcon className="h-3.5 w-3.5" />}
              label="Estilo padrão"
              onClick={() => setStyleEditorOpen(true)}
              disabled={!activeTrack}
            />

            <div className="ml-auto">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setOpen(false)}
                title="Fechar (Shift+L)"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {/* Lista */}
          <div
            ref={listRef}
            className="flex-1 overflow-y-auto bg-background"
          >
            {!activeTrack || activeTrack.cues.length === 0 ? (
              <EmptyState
                hasTrack={!!activeTrack}
                onNewCue={handleNewCueAtPlayhead}
                onImport={() => setImportOpen(true)}
              />
            ) : (
              <div className="flex flex-col gap-1 p-2">
                {[...activeTrack.cues]
                  .sort((a, b) => a.startTime - b.startTime)
                  .map((cue) => (
                    <CaptionCueCard
                      key={cue.id}
                      cue={cue}
                      isActive={activeCue?.id === cue.id}
                      isSelected={selectedCueIds.includes(cue.id)}
                      onSelect={() => handleSelectCue(cue)}
                      onUpdate={(patch) => updateCaption(cue.id, patch)}
                      onSplit={(atTime) => handleSplit(cue, atTime)}
                      onDelete={() => removeCaption(cue.id)}
                      onMergeNext={() => handleMergeNext(cue)}
                      onFocusNext={() => handleFocusSibling(cue, 'next')}
                      onFocusPrev={() => handleFocusSibling(cue, 'prev')}
                      onNudgeStart={(d) => handleNudge(cue, 'startTime', d)}
                      onNudgeEnd={(d) => handleNudge(cue, 'endTime', d)}
                    />
                  ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
            <span>
              {activeTrack ? `${activeTrack.cues.length} cue(s)` : 'Sem track'}
            </span>
            <span className="font-mono tabular-nums">
              total {formatTimecode(totalDuration)}
            </span>
          </div>
        </SheetContent>
      </Sheet>

      {/* Sub-dialogs */}
      <CaptionImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        hasExistingCues={(activeTrack?.cues.length ?? 0) > 0}
        onConfirm={(parsed, mode, filename) =>
          handleImportConfirm(parsed, mode, filename)
        }
      />

      <CaptionGenerateDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
      />

      <CaptionTranscribeDialog
        open={transcribeOpen}
        onOpenChange={setTranscribeOpen}
        onTrackCreated={(id) => setActiveTrackId(id)}
      />

      {activeTrack && (
        <Dialog open={styleEditorOpen} onOpenChange={setStyleEditorOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Estilo padrão da track</DialogTitle>
            </DialogHeader>
            <DefaultStyleSection
              activeTrack={activeTrack}
              onApply={(patch) => {
                // Aplica patch a TODOS os cues da track.
                const setCueStyle = useEditorStore.getState().setCaptionStyle;
                for (const cue of activeTrack.cues) {
                  setCueStyle(cue.id, patch);
                }
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function EmptyState({
  hasTrack,
  onNewCue,
  onImport,
}: {
  hasTrack: boolean;
  onNewCue: () => void;
  onImport: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <TypeIcon
        className="h-10 w-10"
        style={{ color: 'var(--editor-track-cc)' }}
      />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {hasTrack ? 'Track vazia' : 'Sem track de legendas'}
        </p>
        <p className="text-[10px] text-muted-foreground">
          Importe um arquivo `.srt`/`.vtt` ou crie cues manualmente.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onImport}
          className="gap-1.5"
        >
          <Upload className="h-3.5 w-3.5" /> Importar `.srt`/`.vtt`
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onNewCue}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" /> Criar primeiro cue
        </Button>
      </div>
    </div>
  );
}

function ToolbarBtn({
  icon,
  label,
  onClick,
  disabled,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={accent ? 'outline' : 'ghost'}
      size="sm"
      className={cn(
        'h-7 gap-1 px-2 text-[10px]',
        accent &&
          'border-[var(--editor-accent-strong,theme(colors.violet.500))] text-[var(--editor-accent-strong,theme(colors.violet.500))] hover:bg-[var(--editor-accent-soft,theme(colors.violet.500))]/10',
      )}
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

function Separator() {
  return <div className="mx-1 h-4 w-px bg-border" />;
}

function DefaultStyleSection({
  activeTrack,
  onApply,
}: {
  activeTrack: CaptionTrack;
  onApply: (patch: Partial<CaptionStyle>) => void;
}) {
  // Toma o estilo do primeiro cue como base, ou um default.
  const baseStyle: CaptionStyle =
    activeTrack.cues[0]?.style ?? defaultStyle();
  const [draft, setDraft] = React.useState<CaptionStyle>(baseStyle);

  React.useEffect(() => {
    setDraft(activeTrack.cues[0]?.style ?? defaultStyle());
  }, [activeTrack.id, activeTrack.cues]);

  const handleChange = (patch: Partial<CaptionStyle>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const apply = () => {
    onApply(draft);
  };

  return (
    <div className="flex flex-col gap-3">
      <CaptionStyleEditor style={draft} onChange={handleChange} />
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" onClick={apply}>
          Aplicar a todos os {activeTrack.cues.length} cue(s)
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Defaults
// ============================================================================

function defaultStyle(): CaptionStyle {
  return {
    fontFamily: 'Inter',
    fontSize: 36,
    fontWeight: 600,
    color: '#FFFFFF',
    backgroundColor: '#000000B3',
    align: 'center',
    position: 'bottom',
    paddingX: 12,
    paddingY: 4,
    borderRadius: 4,
  };
}

