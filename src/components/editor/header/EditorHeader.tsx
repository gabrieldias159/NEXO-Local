'use client';

/**
 * Header do editor (48px de altura).
 *
 * Layout:
 * [logo/nome do projeto] ............ [save-status] [undo/redo] [save] [export]
 *
 * Conexões com o store:
 * - `ProjectNameInput` lê/escreve `project.name`.
 * - Botões de undo/redo chamam `undo()`/`redo()` do store.
 * - "Salvar" prefere `forceSave()` do `AutoSaveProvider` (auto-save real
 *   no Firestore). Fallback: `saveProject()` placeholder do store.
 * - "Exportar" abre `ui.exportDialogOpen` via `setExportDialogOpen(true)`.
 */

import { Button } from '@/components/ui/button';
import { ProjectNameInput } from './ProjectNameInput';
import { EditorIcons } from '../shared/EditorIcons';
import { useEditorStore } from '@/lib/editor/store';
import { cn } from '@/lib/utils';
import { SaveIndicator } from '../persistence/SaveIndicator';
import { useAutoSaveContext } from '../persistence/AutoSaveProvider';
import { useEditorLayout } from '../layout-context';
import { PanelLeft, PanelRight } from 'lucide-react';
import { RenderJobsPanel } from './RenderJobsPanel';

export function EditorHeader() {
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const saveProject = useEditorStore((s) => s.saveProject);
  const setExportDialogOpen = useEditorStore((s) => s.setExportDialogOpen);
  const autoSave = useAutoSaveContext();
  const layout = useEditorLayout();

  // Resolução: derivada do projeto (default ao "1080p" enquanto não
  // houver projeto carregado).
  const resolutionLabel = useEditorStore(
    (s) => s.project?.resolution.label ?? '1080p Landscape',
  );
  const frameRate = useEditorStore((s) => s.project?.frameRate ?? 30);

  const handleSave = () => {
    if (autoSave) {
      void autoSave.forceSave();
    } else {
      void saveProject();
    }
  };

  return (
    <header
      className={cn(
        'flex h-12 shrink-0 items-center justify-between gap-4 px-4',
        'border-b border-border',
        'bg-background',
      )}
    >
      {/* Esquerda: nome do projeto + toggle MediaBin (mobile) */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div
          className="flex h-7 w-7 items-center justify-center rounded-[var(--editor-radius-sm)]"
          style={{ backgroundColor: 'var(--editor-accent)' }}
        >
          <EditorIcons.Layers className="h-4 w-4 text-white" />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 lg:hidden"
          onClick={() => layout?.toggleMediaBin()}
          title="Abrir biblioteca de mídia"
          aria-label="Abrir biblioteca de mídia"
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
        <ProjectNameInput className="max-w-[260px]" />
      </div>

      {/* Centro: meta-info do projeto (resolução, fps) */}
      <div className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
        <span className="font-mono">{frameRate} fps</span>
        <span className="opacity-50">·</span>
        <span>{resolutionLabel}</span>
      </div>

      {/* Direita: ações */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 lg:hidden"
          onClick={() => layout?.toggleInspector()}
          title="Abrir inspetor"
          aria-label="Abrir inspetor"
        >
          <PanelRight className="h-4 w-4" />
        </Button>

        <SaveIndicator className="mr-2 hidden md:flex" />

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => undo()}
          title="Desfazer (Ctrl+Z)"
        >
          <EditorIcons.Undo className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => redo()}
          title="Refazer (Ctrl+Shift+Z)"
        >
          <EditorIcons.Redo className="h-4 w-4" />
        </Button>

        <div className="mx-1 h-5 w-px bg-border" />

        {/* Painel de processamentos (renders em andamento + concluídos). */}
        <RenderJobsPanel />

        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5"
          onClick={handleSave}
          title="Salvar"
          disabled={autoSave?.isSaving}
        >
          <EditorIcons.Save className="h-4 w-4" />
          <span className="hidden sm:inline">Salvar</span>
        </Button>

        <Button
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => setExportDialogOpen(true)}
          title="Exportar"
        >
          <EditorIcons.Export className="h-4 w-4" />
          <span className="hidden sm:inline">Exportar</span>
        </Button>
      </div>
    </header>
  );
}
