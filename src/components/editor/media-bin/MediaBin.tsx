'use client';

/**
 * Painel MediaBin (esquerda).
 *
 * Composição:
 * - `MediaBinHeader`  → busca + filtros (estado local).
 * - `AssetUploader`   → import.
 * - `AssetItem[]`     → lista filtrada via selector do store.
 *
 * Larga 280px no layout padrão (definido pelo `EditorLayout`).
 */

import { useMemo, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { useEditorStore } from '@/lib/editor/store';
import { useIngestFiles } from '@/lib/editor/ingest-files';
import { MediaBinHeader, type MediaBinFilter } from './MediaBinHeader';
import { AssetUploader } from './AssetUploader';
import { AssetItem } from './AssetItem';
import { ImportUrlDialog } from './ImportUrlDialog';
import { AiStageGenerator } from '../ai/AiStageGenerator';
import { EditorIcons } from '../shared/EditorIcons';
import { cn } from '@/lib/utils';

export function MediaBin() {
  const assets = useEditorStore((s) => s.project?.assets ?? []);
  const stageMode = useEditorStore((s) => s.project?.stageMode ?? 'single');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<MediaBinFilter>('all');
  const [aiOpen, setAiOpen] = useState(false);
  const [urlOpen, setUrlOpen] = useState(false);
  const [isFileOver, setIsFileOver] = useState(false);
  const ingest = useIngestFiles();

  // A área da LISTA também aceita arquivos do SO (a mensagem do empty state
  // promete "arraste arquivos" — agora a área inteira cumpre isso, não só o
  // dropzone do AssetUploader).
  const handleListDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isFileOver) setIsFileOver(true);
  };
  const handleListDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsFileOver(false);
  };
  const handleListDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setIsFileOver(false);
    if (e.dataTransfer.files.length > 0) void ingest(e.dataTransfer.files);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return assets.filter((a) => {
      if (filter !== 'all' && a.type !== filter) return false;
      if (q && !a.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [assets, search, filter]);

  return (
    <aside
      className={cn(
        'flex h-full min-h-0 w-full flex-col',
        'border-r border-border',
        'bg-card',
      )}
    >
      <MediaBinHeader
        search={search}
        onSearchChange={setSearch}
        filter={filter}
        onFilterChange={setFilter}
      />

      <div className="space-y-2 px-3">
        <AssetUploader />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={() => setUrlOpen(true)}
        >
          <EditorIcons.Link className="h-4 w-4" />
          Importar de URL
        </Button>
        <Button
          type="button"
          variant={stageMode === 'split-vertical' ? 'default' : 'outline'}
          size="sm"
          className="w-full gap-2"
          onClick={() => setAiOpen(true)}
        >
          <EditorIcons.AI className="h-4 w-4" />
          Gerar com IA
          {stageMode === 'split-vertical' && (
            <span className="ml-auto text-[10px] opacity-80">palco 2</span>
          )}
        </Button>
      </div>
      <ImportUrlDialog open={urlOpen} onOpenChange={setUrlOpen} />
      <AiStageGenerator open={aiOpen} onOpenChange={setAiOpen} />

      <div
        onDragOver={handleListDragOver}
        onDragLeave={handleListDragLeave}
        onDrop={handleListDrop}
        className={cn(
          'mt-2 min-h-0 flex-1 transition-colors',
          isFileOver &&
            'rounded-[var(--editor-radius-md)] bg-[var(--editor-accent-soft)] ring-1 ring-inset ring-[var(--editor-accent)]',
        )}
      >
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-1.5 px-3 pb-3">
            {filtered.length === 0 ? (
              <EmptyMediaState hasAnyAsset={assets.length > 0} hasFilter={filter !== 'all' || search.length > 0} />
            ) : (
              filtered.map((asset) => <AssetItem key={asset.id} asset={asset} />)
            )}
          </div>
        </ScrollArea>
      </div>
    </aside>
  );
}

function EmptyMediaState({
  hasAnyAsset,
  hasFilter,
}: {
  hasAnyAsset: boolean;
  hasFilter: boolean;
}) {
  if (hasAnyAsset && hasFilter) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-8 text-center">
        <EditorIcons.Search className="h-6 w-6 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Nenhuma mídia encontrada com este filtro.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <EditorIcons.Video className="h-8 w-8 text-muted-foreground" />
      <p className="text-xs text-muted-foreground">
        Nenhuma mídia importada ainda.
      </p>
      <p className="text-[10px] text-muted-foreground">
        Use o botão acima ou arraste arquivos.
      </p>
    </div>
  );
}
