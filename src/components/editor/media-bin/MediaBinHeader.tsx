'use client';

/**
 * Header do MediaBin: título + busca + filtros simples.
 *
 * Filtro por tipo é local (state) — não precisa estar no store global.
 * Search é controlled e expõe via callback para o `MediaBin` filtrar a lista.
 */

import { Input } from '@/components/ui/input';
import { EditorIcons } from '../shared/EditorIcons';
import { cn } from '@/lib/utils';

export type MediaBinFilter = 'all' | 'video' | 'image' | 'audio';

interface MediaBinHeaderProps {
  search: string;
  onSearchChange: (value: string) => void;
  filter: MediaBinFilter;
  onFilterChange: (filter: MediaBinFilter) => void;
}

const FILTERS: {
  value: MediaBinFilter;
  label: string;
  icon: (typeof EditorIcons)[keyof typeof EditorIcons];
}[] = [
  { value: 'all', label: 'Tudo', icon: EditorIcons.List },
  { value: 'video', label: 'Vídeo', icon: EditorIcons.Video },
  { value: 'image', label: 'Imagem', icon: EditorIcons.Image },
  { value: 'audio', label: 'Áudio', icon: EditorIcons.Audio },
];

export function MediaBinHeader({
  search,
  onSearchChange,
  filter,
  onFilterChange,
}: MediaBinHeaderProps) {
  return (
    <div className="flex shrink-0 flex-col gap-2 px-3 py-3">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <EditorIcons.Video className="h-4 w-4 text-muted-foreground" />
        Mídias
      </h2>

      {/* Search */}
      <div className="relative">
        <EditorIcons.Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Buscar..."
          className="h-8 border-border bg-background pl-7 text-xs"
        />
      </div>

      {/* Filtros */}
      <div className="flex gap-1">
        {FILTERS.map((f) => {
          const Icon = f.icon;
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => onFilterChange(f.value)}
              title={f.label}
              className={cn(
                'flex flex-1 items-center justify-center gap-1 rounded-[var(--editor-radius-sm)] px-1.5 py-1 text-[11px] transition-colors',
                filter === f.value
                  ? 'bg-[var(--editor-accent)] text-white'
                  : 'bg-muted text-muted-foreground hover:bg-border',
              )}
            >
              <Icon className="h-3 w-3 shrink-0" />
              <span className="truncate">{f.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
