'use client';

/**
 * Toolbar acima da timeline.
 *
 * Componentes:
 * - Tools (select / blade / hand) → seta `ui.tool` no store.
 * - Undo / Redo → store.
 * - Snap toggle → store.
 * - Zoom -/+ → store.
 *
 * Esta versão (refactor) é só estrutural. Botões de "Add caption",
 * "Import SRT" virão depois.
 */

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { useEditorStore } from '@/lib/editor/store';
import { EditorIcons } from '../shared/EditorIcons';
import { GlobalSpeedDialog } from './GlobalSpeedDialog';
import { TransitionPicker } from '../transitions/TransitionPicker';
import type { TransitionConfig } from '@/lib/editor/types';
import { useCaptionsDrawer } from '../captions/useCaptionsDrawer';
import { cn } from '@/lib/utils';

interface ToolDef {
  value: 'select' | 'blade' | 'hand';
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}

const TOOLS: ToolDef[] = [
  { value: 'select', icon: EditorIcons.Select, title: 'Selecionar (V)' },
  { value: 'blade', icon: EditorIcons.Blade, title: 'Cortar (C)' },
  { value: 'hand', icon: EditorIcons.Hand, title: 'Mão (H)' },
];

export function TimelineToolbar() {
  const tool = useEditorStore((s) => s.ui.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const snap = useEditorStore((s) => s.ui.snapEnabled);
  const setSnap = useEditorStore((s) => s.setSnapEnabled);
  const zoom = useEditorStore((s) => s.ui.zoom);
  const setZoom = useEditorStore((s) => s.setZoom);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const addTrack = useEditorStore((s) => s.addTrack);
  const selectedClipIds = useEditorStore((s) => s.ui.selectedClipIds);
  const project = useEditorStore((s) => s.project);
  const applyTransitionBetween = useEditorStore(
    (s) => s.applyTransitionBetween,
  );
  const setTransition = useEditorStore((s) => s.setTransition);
  const toggleCaptions = useCaptionsDrawer((s) => s.toggle);
  const captionsOpen = useCaptionsDrawer((s) => s.open);

  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [speedOpen, setSpeedOpen] = React.useState(false);

  /**
   * Aplica a transição escolhida no picker. Estratégia:
   * - Se há 2+ clips adjacentes selecionados na MESMA track, aplica
   *   via `applyTransitionBetween`.
   * - Se há 1 clip selecionado, aplica como `transitionIn` (fade-in
   *   simples). Útil quando não há clip adjacente.
   * - Caso contrário, apenas fecha o picker (nada para aplicar).
   */
  const handleSelectTransition = (config: TransitionConfig) => {
    if (!project || selectedClipIds.length === 0) {
      setPickerOpen(false);
      return;
    }
    if (selectedClipIds.length >= 2) {
      const allClips = project.tracks.flatMap((t) =>
        t.clips.map((c) => ({ trackId: t.id, clip: c })),
      );
      const selected = allClips.filter((x) =>
        selectedClipIds.includes(x.clip.id),
      );
      const byTrack = new Map<string, typeof selected>();
      for (const s of selected) {
        const arr = byTrack.get(s.trackId) ?? [];
        arr.push(s);
        byTrack.set(s.trackId, arr);
      }
      let applied = false;
      for (const arr of byTrack.values()) {
        arr.sort((a, b) => a.clip.startInTimeline - b.clip.startInTimeline);
        for (let i = 0; i < arr.length - 1; i++) {
          applyTransitionBetween(
            arr[i].clip.id,
            arr[i + 1].clip.id,
            config.type,
            config.duration,
          );
          applied = true;
        }
      }
      if (!applied) {
        selectedClipIds.forEach((id) =>
          setTransition(id, 'in', { ...config }),
        );
      }
    } else {
      setTransition(selectedClipIds[0], 'in', { ...config });
    }
    setPickerOpen(false);
  };

  return (
    <div
      className={cn(
        'flex h-9 shrink-0 items-center gap-1 border-b border-border px-2',
        'bg-background',
      )}
    >
      {/* Tools */}
      <div className="flex items-center gap-0.5">
        {TOOLS.map(({ value, icon: Icon, title }) => {
          const active = tool === value;
          return (
            <Button
              key={value}
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                'h-7 w-7',
                active &&
                  'bg-[var(--editor-accent-soft)] text-[var(--editor-accent-strong)]',
              )}
              onClick={() => setTool(value)}
              title={title}
            >
              <Icon className="h-3.5 w-3.5" />
            </Button>
          );
        })}
      </div>

      <Separator />

      {/* Undo / redo */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => undo()}
        title="Desfazer"
      >
        <EditorIcons.Undo className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => redo()}
        title="Refazer"
      >
        <EditorIcons.Redo className="h-3.5 w-3.5" />
      </Button>

      <Separator />

      {/* Adicionar tracks — um ícone só por botão (o "+" fica implícito no
          rótulo/title) pra não ficar visualmente carregado. */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-1.5 text-[11px]"
        onClick={() => addTrack('video')}
        title="Adicionar track de vídeo"
      >
        <EditorIcons.Video className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Vídeo</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-1.5 text-[11px]"
        onClick={() => addTrack('audio')}
        title="Adicionar track de áudio"
      >
        <EditorIcons.AudioWave className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Áudio</span>
      </Button>

      <Separator />

      {/* Snap */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn('h-7 w-7', snap && 'text-[var(--editor-accent-strong)]')}
        onClick={() => setSnap(!snap)}
        title={`Snap: ${snap ? 'ativado' : 'desativado'}`}
      >
        <EditorIcons.Snap className="h-3.5 w-3.5" />
      </Button>

      <Separator />

      {/* Transições — abre gallery */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        onClick={() => setPickerOpen(true)}
        title="Abrir galeria de transições"
      >
        <EditorIcons.Magic className="h-3.5 w-3.5" />
        <span>Transições</span>
      </Button>

      <TransitionPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={handleSelectTransition}
      />

      {/* Velocidade global do projeto (remap automatico) */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-[11px]"
        onClick={() => setSpeedOpen(true)}
        title="Velocidade da fala: acelera a base e remapeia a timeline inteira"
      >
        <EditorIcons.Speed className="h-3.5 w-3.5" />
        <span>Velocidade</span>
      </Button>

      <GlobalSpeedDialog open={speedOpen} onOpenChange={setSpeedOpen} />

      {/* Legendas — abre o drawer */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          'h-7 gap-1 px-2 text-[11px]',
          captionsOpen &&
            'bg-[var(--editor-accent-soft)] text-[var(--editor-accent-strong)]',
        )}
        onClick={toggleCaptions}
        title="Editor de Legendas (Shift+L)"
      >
        <EditorIcons.Caption
          className="h-3.5 w-3.5"
          style={{ color: 'var(--editor-track-cc)' }}
        />
        <span>Legendas</span>
      </Button>

      <div className="ml-auto flex items-center gap-1">
        {/* Zoom */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setZoom(zoom * 0.8)}
          title="Diminuir zoom"
        >
          <EditorIcons.ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="min-w-[3.5rem] text-center font-mono text-[10px] text-muted-foreground">
          {Math.round(zoom)}px/s
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setZoom(zoom * 1.25)}
          title="Aumentar zoom"
        >
          <EditorIcons.ZoomIn className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function Separator() {
  return <div className="mx-1 h-4 w-px bg-border" />;
}
