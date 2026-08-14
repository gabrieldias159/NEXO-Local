'use client';

/**
 * Painel direito (Inspector) com tabs.
 *
 * - 320px de largura (definido pelo `EditorLayout`).
 * - Mostra `EmptyInspector` quando nada está selecionado.
 * - Header: nome do clip selecionado + tipo (vídeo/áudio/imagem) + contagem
 *   em multi-seleção.
 * - 5 tabs: Transform, Filters, Audio, Speed, Transitions (a tab "Caption"
 *   virá com o editor de legendas, fora do escopo desta fase).
 *
 * Estado da tab ativa vem de `ui.inspectorTab` no store; é persistido em
 * localStorage (ver `partialize` no store) para preferência entre sessões.
 *
 * Multi-seleção:
 * - Header mostra "N clips selected".
 * - Cada tab passa a lista de clips para os controles, que aplicam a
 *   mudança em todos via `forEach`. Valores divergentes aparecem como
 *   "Mixed" nos inputs (ver `pickCommonValue`).
 *
 * Cue (legenda):
 * - Por enquanto, mostra placeholder. Inspector de cue será uma 5ª tab no
 *   futuro, quando o editor de legendas chegar.
 */

import * as React from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { useEditorStore } from '@/lib/editor/store';
import type { Clip, EditorUIState, VideoProject } from '@/lib/editor/types';
import { EmptyInspector } from './EmptyInspector';
import { TransformTab } from './tabs/TransformTab';
import { FiltersTab } from './tabs/FiltersTab';
import { AudioTab } from './tabs/AudioTab';
import { SpeedTab } from './tabs/SpeedTab';
import { TransitionsTab } from './tabs/TransitionsTab';
import { EditorIcons } from '../shared/EditorIcons';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

type InspectorTab = EditorUIState['inspectorTab'];
type SupportedTab = Exclude<InspectorTab, 'caption'>;

const TABS: Array<{
  value: SupportedTab;
  label: string;
  icon: (typeof EditorIcons)[keyof typeof EditorIcons];
}> = [
  { value: 'transform', label: 'Transformar', icon: EditorIcons.Transform },
  { value: 'filters', label: 'Filtros', icon: EditorIcons.Sliders },
  { value: 'audio', label: 'Áudio', icon: EditorIcons.VolumeOn },
  { value: 'speed', label: 'Velocidade', icon: EditorIcons.Speed },
  { value: 'transitions', label: 'Transições', icon: EditorIcons.Magic },
];

export function Inspector() {
  const project = useEditorStore((s) => s.project);
  const selectedClipIds = useEditorStore((s) => s.ui.selectedClipIds);
  const selectedCueIds = useEditorStore((s) => s.ui.selectedCueIds);
  const inspectorTab = useEditorStore((s) => s.ui.inspectorTab);
  const setInspectorTab = useEditorStore((s) => s.setInspectorTab);
  const copiarAjustes = useEditorStore((s) => s.copiarAjustes);
  const aplicarAjustes = useEditorStore((s) => s.aplicarAjustes);
  const hasAdjustments = useEditorStore((s) => s.adjustmentsClipboard !== null);
  const { toast } = useToast();

  const selectedClips: Clip[] = React.useMemo(() => {
    if (!project) return [];
    if (selectedClipIds.length === 0) return [];
    const all = project.tracks.flatMap((t) => t.clips);
    return selectedClipIds
      .map((id) => all.find((c) => c.id === id))
      .filter((c): c is Clip => Boolean(c));
  }, [project, selectedClipIds]);

  const hasClipSelection = selectedClips.length > 0;
  const hasCueSelection = selectedCueIds.length > 0;
  const hasAnySelection = hasClipSelection || hasCueSelection;

  // Tab ativa — fallback para 'transform' se a persistida for 'caption'
  // mas estamos com clip selecionado.
  const activeTab: SupportedTab =
    inspectorTab === 'caption' ? 'transform' : (inspectorTab as SupportedTab);

  const onTabChange = (value: string) => {
    setInspectorTab(value as InspectorTab);
  };

  const handleCopiarAjustes = () => {
    if (selectedClips.length === 0) return;
    copiarAjustes(selectedClips[0].id);
    toast({ title: 'Ajustes copiados' });
  };

  const handleColarAjustes = () => {
    const n = aplicarAjustes(selectedClipIds);
    toast({
      title: n > 0 ? `Ajustes colados em ${n} clip(s)` : 'Nada para colar',
    });
  };

  return (
    <aside
      className={cn(
        'flex h-full min-h-0 w-full flex-col overflow-hidden',
        'border-l border-border',
        'bg-card',
      )}
    >
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <h2 className="text-sm font-semibold text-foreground">
          Inspetor
        </h2>
        {hasClipSelection && (
          <span className="text-[10px] text-muted-foreground">
            {selectedClips.length === 1
              ? '1 clip'
              : `${selectedClips.length} clips`}
          </span>
        )}
      </header>

      {/* Wrapper de altura fixa para o ScrollArea: garante que o conteúdo
          nunca empurre o tamanho do painel, independente do clip/aba. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full">
        {!hasAnySelection && <EmptyInspector />}

        {hasClipSelection && project && (
          <div className="flex w-full min-w-0 flex-col">
            <SelectionHeader clips={selectedClips} project={project} />

            {/* Barra de "Colar atributos" (estilo Premiere): copia ajustes do
                primeiro clip selecionado e cola em TODOS os selecionados. */}
            <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5">
              <button
                type="button"
                onClick={handleCopiarAjustes}
                disabled={selectedClips.length === 0}
                title="Copiar ajustes (transform, filtros, áudio, encaixe, chroma, velocidade)"
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded-sm border border-border bg-muted px-2',
                  'text-[10px] font-medium text-muted-foreground transition-colors',
                  'hover:bg-border disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                <EditorIcons.Copy className="h-3 w-3" />
                Copiar ajustes
              </button>
              <button
                type="button"
                onClick={handleColarAjustes}
                disabled={!hasAdjustments || selectedClips.length === 0}
                title="Colar ajustes nos clips selecionados"
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded-sm border border-border bg-muted px-2',
                  'text-[10px] font-medium text-muted-foreground transition-colors',
                  'hover:bg-border disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                <EditorIcons.Paste className="h-3 w-3" />
                {selectedClips.length > 1
                  ? `Colar ajustes (${selectedClips.length})`
                  : 'Colar ajustes'}
              </button>
            </div>

            <Tabs
              value={activeTab}
              onValueChange={onTabChange}
              className="flex w-full min-w-0 flex-col"
            >
              <div className="px-3 pt-1">
                <TabsList
                  className={cn(
                    'grid h-auto w-full grid-cols-5 gap-0.5 rounded-sm',
                    'bg-muted p-0.5',
                  )}
                >
                  {TABS.map((t) => {
                    const Icon = t.icon;
                    return (
                      <TabsTrigger
                        key={t.value}
                        value={t.value}
                        title={t.label}
                        className={cn(
                          'flex h-7 flex-col items-center justify-center gap-0.5 rounded-sm px-0.5',
                          'data-[state=active]:bg-background',
                          'data-[state=active]:text-foreground',
                          'data-[state=active]:shadow-none',
                          'text-muted-foreground',
                        )}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="w-full truncate text-center text-[9px] font-medium leading-none">
                          {t.label}
                        </span>
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </div>

              <TabsContent value="transform" className="mt-0 min-w-0 overflow-hidden px-3 py-3">
                <TransformTab clips={selectedClips} project={project} />
              </TabsContent>
              <TabsContent value="filters" className="mt-0 min-w-0 overflow-hidden px-3 py-3">
                <FiltersTab clips={selectedClips} />
              </TabsContent>
              <TabsContent value="audio" className="mt-0 min-w-0 overflow-hidden px-3 py-3">
                <AudioTab clips={selectedClips} assets={project.assets} />
              </TabsContent>
              <TabsContent value="speed" className="mt-0 min-w-0 overflow-hidden px-3 py-3">
                <SpeedTab clips={selectedClips} />
              </TabsContent>
              <TabsContent value="transitions" className="mt-0 min-w-0 overflow-hidden px-3 py-3">
                <TransitionsTab clips={selectedClips} />
              </TabsContent>
            </Tabs>
          </div>
        )}

        {!hasClipSelection && hasCueSelection && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            Inspetor de legenda virá na próxima fase.
          </div>
        )}
        </ScrollArea>
      </div>
    </aside>
  );
}

// ============================================================================
// Sub-componentes
// ============================================================================

function SelectionHeader({
  clips,
  project,
}: {
  clips: Clip[];
  project: VideoProject;
}) {
  if (clips.length > 1) {
    // Multi-seleção: tipos podem divergir. Mostra contagem por tipo.
    const types = new Set(
      clips
        .map((c) => project.assets.find((a) => a.id === c.assetId)?.type)
        .filter(Boolean),
    );
    return (
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-sm bg-muted">
          <EditorIcons.Layers className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">
            {clips.length} clips selecionados
          </p>
          <p className="text-[10px] text-muted-foreground">
            {[...types].join(' · ')}
          </p>
        </div>
      </div>
    );
  }

  const clip = clips[0];
  const asset = project.assets.find((a) => a.id === clip.assetId);
  const Icon =
    asset?.type === 'audio'
      ? EditorIcons.Audio
      : asset?.type === 'image'
        ? EditorIcons.Image
        : EditorIcons.Video;

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
      <div className="flex h-6 w-6 items-center justify-center rounded-sm bg-muted">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">
          {asset?.name ?? 'Clip sem asset'}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {asset?.type ?? '—'} ·{' '}
          {(clip.endInTimeline - clip.startInTimeline).toFixed(2)}s
        </p>
      </div>
    </div>
  );
}
