'use client';

/**
 * Container principal do Suite Editor de Vídeos.
 *
 * Esta é a **raiz** da árvore de componentes do editor (substitui o
 * antigo monólito em `src/components/apps/suite-video-editor.tsx`).
 *
 * Responsabilidades desta camada:
 * - Inicializar um projeto local em memória se ainda não houver um
 *   projeto carregado no store. (Persistência Firestore vem em outra
 *   fase via `loadProject` injetado no caller.)
 * - Montar o `EditorHeader` (top), `EditorLayout` (grid principal) e
 *   o `KeyboardShortcuts` (efeito invisível).
 * - Envolver com `AutoSaveProvider` para auto-save do projeto no
 *   Firestore.
 *
 * **Não** contém lógica de upload/playback/render — cada subpainel cuida
 * do seu domínio via store Zustand.
 */

import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '@/lib/editor/store';
import { useIngestFiles } from '@/lib/editor/ingest-files';
import type { ResolutionPreset } from '@/lib/editor/types';

import { EditorHeader } from './header/EditorHeader';
import { EditorLayout } from './EditorLayout';
import { MediaBin } from './media-bin/MediaBin';
import { PreviewPanel } from './preview/PreviewPanel';
import { Timeline } from './timeline/Timeline';
import { Inspector } from './inspector/Inspector';
import { KeyboardShortcuts } from './shared/KeyboardShortcuts';
import { CaptionsDrawer } from './captions/CaptionsDrawer';
import { AutoSaveProvider } from './persistence/AutoSaveProvider';
import { ExportDialog } from './export/ExportDialog';
import { HiddenAudioPlayback } from './preview/HiddenAudioPlayback';
import { AssetPrefetcher } from './preview/AssetPrefetcher';
import { EditorIcons } from './shared/EditorIcons';
import { cn } from '@/lib/utils';

const DEFAULT_RESOLUTION: ResolutionPreset = {
  width: 1920,
  height: 1080,
  label: 'Horizontal 16:9 · 1080p',
};

interface SuiteVideoEditorProps {
  /**
   * Identificador opcional do projeto. Quando omitido, o componente
   * cria um projeto local em memória (apenas para protótipo / demo).
   * Em produção, o caller deve carregar via `loadProject(...)` antes
   * de montar este componente.
   */
  projectId?: string;
  /**
   * Quando `true`, NÃO faz bootstrap de projeto local — assume que o
   * caller já carregou (ex.: rota `/[projectId]`).
   */
  skipBootstrap?: boolean;
}

export function SuiteVideoEditor({ skipBootstrap }: SuiteVideoEditorProps) {
  const project = useEditorStore((s) => s.project);
  const createProject = useEditorStore((s) => s.createProject);
  const ingest = useIngestFiles();

  // Drop global de ARQUIVO do SO em qualquer lugar do editor → importa pra
  // biblioteca. Só ativa quando o arrasto traz `Files`. Targets específicos
  // (timeline / palco / mediabin) chamam `preventDefault` no próprio drop, e
  // o handler global ignora drops já tratados (`defaultPrevented`) — assim
  // não há importação dupla. O overlay é `pointer-events-none`, então nunca
  // bloqueia os alvos mais específicos.
  const [isFileDragging, setIsFileDragging] = useState(false);
  const dragDepth = useRef(0);

  const hasFiles = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('Files');

  const handleRootDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    dragDepth.current += 1;
    if (!isFileDragging) setIsFileDragging(true);
  };
  const handleRootDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    // preventDefault aqui (no nível raiz) impede que o browser ABRA o arquivo
    // numa nova aba caso o usuário solte fora de um alvo específico.
    e.preventDefault();
  };
  const handleRootDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsFileDragging(false);
  };
  const handleRootDrop = (e: React.DragEvent<HTMLDivElement>) => {
    dragDepth.current = 0;
    setIsFileDragging(false);
    // Já tratado por um alvo específico (timeline/palco/mediabin)? Não duplica.
    if (e.defaultPrevented) return;
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) void ingest(e.dataTransfer.files);
  };

  // Bootstrap: cria um projeto em memória se não há nenhum carregado.
  // Em produção, o caller substitui esse comportamento com loadProject().
  useEffect(() => {
    if (skipBootstrap) return;
    if (!project) {
      createProject(
        {
          name: 'Novo projeto',
          resolution: DEFAULT_RESOLUTION,
          frameRate: 30,
          stageMode: 'single',
        },
        // OwnerUid: placeholder enquanto não há auth integrada nesta fase.
        'local',
      );
    }
  }, [project, createProject, skipBootstrap]);

  return (
    <AutoSaveProvider>
      <div
        onDragEnter={handleRootDragEnter}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
        className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-background"
      >
        <KeyboardShortcuts />
        <EditorHeader />
        <div className="min-h-0 flex-1">
          <EditorLayout
            mediaBin={<MediaBin />}
            preview={<PreviewPanel />}
            timeline={<Timeline />}
            inspector={<Inspector />}
          />
        </div>
        <CaptionsDrawer />
        <ExportDialog />
        {/* Elementos invisíveis para tocar clips de tracks de áudio. */}
        <HiddenAudioPlayback />
        {/* Pre-fetch dos assets de vídeo (warm cache → playback fluido). */}
        <AssetPrefetcher />

        {/* Overlay global ao arrastar arquivo do SO. `pointer-events-none`
            pra não bloquear os alvos específicos (timeline/palco/mediabin),
            que mostram o próprio highlight por cima deste. */}
        {isFileDragging && (
          <div
            className={cn(
              'pointer-events-none absolute inset-2 z-[60] flex flex-col items-center justify-center gap-2',
              'rounded-[var(--editor-radius-lg,12px)] border-2 border-dashed border-[var(--editor-accent)]',
              'bg-background/70 backdrop-blur-[1px]',
            )}
          >
            <EditorIcons.Upload className="h-9 w-9 text-[var(--editor-accent)]" />
            <p className="text-sm font-medium text-foreground">
              Solte para importar
            </p>
            <p className="text-xs text-muted-foreground">
              Vídeos, imagens e áudios entram na biblioteca
            </p>
          </div>
        )}
      </div>
    </AutoSaveProvider>
  );
}
