'use client';

/**
 * Bloco visual + interativo do clip na timeline.
 *
 * Comportamentos:
 * - Drag horizontal/vertical via `useClipDrag`.
 * - Trim das duas pontas via `useClipTrim` (handles invisíveis 8px nas bordas).
 * - Blade: quando `ui.tool === 'blade'`, click chama `splitClip(clipId, atTime)`
 *   onde `atTime` é calculado do clientX relativo à área de clips.
 * - Em modo select, click sem drag dispara `selectClip`.
 *
 * Visual:
 * - opacity reduzida e glow accent durante drag.
 * - cursor `grab` em select, `crosshair` em blade.
 * - Renderiza um HUD flutuante mostrando tempo `mm:ss.cs` e Δ durante
 *   drag/trim.
 */

import { useRef } from 'react';
import type { Clip, Track } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import { cn, truncateFilename } from '@/lib/utils';
import { useClipDrag } from './hooks/useClipDrag';
import { useClipTrim } from './hooks/useClipTrim';
import { HudOverlay } from './HudOverlay';
import { ClipThumbnail } from './ClipThumbnail';
import { ClipWaveform } from './ClipWaveform';
import { formatTimeHud } from '@/lib/editor/timeline-interactions';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useStorage } from '@/firebase';
import { useToast } from '@/hooks/use-toast';
import { getDownloadURL, ref as storageRef, FirebaseStorage } from 'firebase/storage';
import { Download, Trash2, Lock, Unlock, Eye, EyeOff, Scissors, Copy, ClipboardPaste } from 'lucide-react';

interface TimelineClipProps {
  clip: Clip;
  track: Track;
  zoom: number;
  /**
   * Altura da LANE (camada/subtrack) que contém este clip, em px. Quando a
   * track tem múltiplas camadas, cada lane mede `track.height / nLayers`.
   * Default = `track.height` (track de camada única — comportamento antigo).
   */
  laneHeight?: number;
}

function trackAccent(track: Track): string {
  if (track.type === 'video') {
    if (track.index === 0) return 'var(--editor-track-v1)';
    if (track.index === 1) return 'var(--editor-track-v2)';
    return 'var(--editor-track-v3)';
  }
  if (track.index === 0) return 'var(--editor-track-a1)';
  if (track.index === 1) return 'var(--editor-track-a2)';
  return 'var(--editor-track-a3)';
}

/**
 * Cor accent semântica por tipo de track. Diferente de `trackAccent` (CSS
 * vars indexados por posição), esta retorna um hex sólido usado para
 * preencher o corpo do clip via `color-mix`.
 *
 * Prioriza `track.accentColor` (custom) se o tipo for estendido no futuro.
 */
function getTrackAccentColor(track: Track): string {
  const custom = (track as Track & { accentColor?: string }).accentColor;
  if (custom) return custom;
  // `kind` é o nome usado no spec; `type` é o nome atual do schema.
  // Mapeia ambos pra ser compatível.
  const k =
    (track as Track & { kind?: 'video' | 'audio' | 'caption' }).kind ??
    track.type;
  if (k === 'video') return '#3B82F6'; // blue-500
  if (k === 'audio') return '#10B981'; // emerald-500
  if (k === 'caption') return '#A78BFA'; // violet-400
  return '#3B82F6';
}

export function TimelineClip({
  clip,
  track,
  zoom,
  laneHeight,
}: TimelineClipProps) {
  const clipHeight = laneHeight ?? track.height;
  const selectClip = useEditorStore((s) => s.selectClip);
  const splitClip = useEditorStore((s) => s.splitClip);
  const selectedClipIds = useEditorStore((s) => s.ui.selectedClipIds);
  const tool = useEditorStore((s) => s.ui.tool);
  const playhead = useEditorStore((s) => s.ui.playhead);
  const frameRate = useEditorStore((s) => s.project?.frameRate ?? 30);
  const assets = useEditorStore((s) => s.project?.assets ?? []);
  const removeClip = useEditorStore((s) => s.removeClip);
  const setClipLocked = useEditorStore((s) => s.setClipLocked);
  const setClipHidden = useEditorStore((s) => s.setClipHidden);
  const copiarAjustes = useEditorStore((s) => s.copiarAjustes);
  const aplicarAjustes = useEditorStore((s) => s.aplicarAjustes);
  const hasAdjustments = useEditorStore((s) => s.adjustmentsClipboard !== null);

  const storage = useStorage();
  const { toast } = useToast();

  const drag = useClipDrag(clip.id);
  const trim = useClipTrim(clip.id);

  const elRef = useRef<HTMLDivElement>(null);

  const asset = assets.find((a) => a.id === clip.assetId);
  const selected = selectedClipIds.includes(clip.id);

  // Posicionamento base.
  const baseLeft = clip.startInTimeline * zoom;
  const baseWidth = Math.max(2, (clip.endInTimeline - clip.startInTimeline) * zoom);

  // Durante drag, posição preview vem de `drag.previewStart`.
  // Durante trim left/right, ajustamos left/width visualmente.
  let left = baseLeft;
  let width = baseWidth;

  if (drag.isDragging && drag.previewStart !== null) {
    left = drag.previewStart * zoom;
  }
  if (trim.isTrimming === 'left' && trim.previewTime !== null) {
    const newLeft = trim.previewTime * zoom;
    width = clip.endInTimeline * zoom - newLeft;
    left = newLeft;
  } else if (trim.isTrimming === 'right' && trim.previewTime !== null) {
    width = trim.previewTime * zoom - clip.startInTimeline * zoom;
  }
  width = Math.max(2, width);

  // Esconde clip na track original se está sendo arrastado para outra.
  const isGhostInOriginal =
    drag.isDragging && drag.hoverTrackId !== null && drag.hoverTrackId !== track.id;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Se acabou de fazer drag, ignora click (pointerup já cuidou).
    if (drag.isDragging) return;

    if (tool === 'blade') {
      // Calcula atTime a partir do clientX e da área da track.
      const trackArea = elRef.current?.parentElement;
      if (!trackArea) return;
      const rect = trackArea.getBoundingClientRect();
      const x = e.clientX - rect.left + trackArea.scrollLeft;
      const atTime = Math.max(0, x / zoom);
      splitClip(clip.id, atTime);
      return;
    }

    selectClip(clip.id, e.shiftKey);
  };

  // HUD: mostra durante drag ou trim.
  let hudLabel: string | null = null;
  let hudSub: string | undefined;
  if (drag.isDragging && drag.previewStart !== null) {
    hudLabel = formatTimeHud(drag.previewStart, frameRate);
    const delta = drag.previewStart - clip.startInTimeline;
    hudSub = `Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}s`;
  } else if (trim.isTrimming && trim.previewTime !== null) {
    hudLabel = formatTimeHud(trim.previewTime, frameRate);
    const newDuration =
      trim.isTrimming === 'left'
        ? clip.endInTimeline - trim.previewTime
        : trim.previewTime - clip.startInTimeline;
    hudSub = `dur ${newDuration.toFixed(2)}s`;
  }

  const cursorClass =
    tool === 'blade' ? 'cursor-crosshair' : drag.isDragging ? 'cursor-grabbing' : 'cursor-grab';

  /**
   * Baixa o asset original (mp4/mp3) do clip clicado.
   * Resolve a URL do Storage e dispara `<a download>` invisível.
   */
  const handleDownload = async () => {
    if (!asset) return;
    try {
      let url = asset.downloadUrl;
      if (!url && asset.storagePath && storage) {
        url = await getDownloadURL(storageRef(storage as FirebaseStorage, asset.storagePath));
      }
      if (!url) {
        toast({ title: 'Sem URL pra baixar', description: 'Asset não tem URL resolvível.', variant: 'destructive' });
        return;
      }
      const ext =
        asset.type === 'audio' ? 'mp3' : asset.type === 'image' ? 'jpg' : 'mp4';
      const baseName = (asset.name ?? 'asset').replace(/\.[^.]+$/, '');
      const filename = `${baseName}.${ext}`;
      // Fetch + blob para forçar download (alguns browsers ignoram `download` em URLs cross-origin).
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      toast({ title: 'Download iniciado', description: filename });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: 'Erro no download', description: msg, variant: 'destructive' });
    }
  };

  const handleSplitAtPlayhead = () => {
    if (playhead > clip.startInTimeline && playhead < clip.endInTimeline) {
      splitClip(clip.id, playhead);
    } else {
      toast({
        title: 'Playhead fora do clip',
        description: 'Posicione o playhead dentro do clip pra dividir.',
        variant: 'destructive',
      });
    }
  };

  const handleCopiarAjustes = () => {
    copiarAjustes(clip.id);
    toast({ title: 'Ajustes copiados' });
  };

  const handleColarAjustes = () => {
    // Se o clip clicado está na seleção atual, aplica em toda a seleção;
    // senão, aplica só no alvo clicado (padrão de menus de NLE).
    const targets = selectedClipIds.includes(clip.id)
      ? selectedClipIds
      : [clip.id];
    const n = aplicarAjustes(targets);
    toast({
      title: n > 0 ? `Ajustes colados em ${n} clip(s)` : 'Nada para colar',
    });
  };

  const downloadLabel =
    asset?.type === 'audio'
      ? 'Baixar áudio (.mp3)'
      : asset?.type === 'image'
        ? 'Baixar imagem'
        : 'Baixar vídeo (.mp4)';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
      <div
        ref={elRef}
        onPointerDown={drag.onPointerDown}
        onClick={handleClick}
        className={cn(
          'absolute top-1 bottom-1 overflow-hidden rounded-[var(--editor-radius-xs)]',
          'select-none',
          cursorClass,
          'border-l-[3px]',
          clip.locked && 'opacity-60',
          clip.hidden && 'opacity-30',
          drag.isDragging && 'opacity-60',
          isGhostInOriginal && 'opacity-30',
        )}
        style={{
          left,
          width,
          // Border esquerda: cor accent saturada (100%).
          borderLeftColor: getTrackAccentColor(track),
          // Body: mistura 30% do accent com a cor de fundo do editor.
          // `color-mix(in oklab, ...)` é suportado em todos os browsers
          // modernos (Chrome 111+, Safari 16.2+, Firefox 113+).
          background: `color-mix(in oklab, ${getTrackAccentColor(track)} 30%, hsl(var(--card)))`,
          boxShadow:
            drag.isDragging || trim.isTrimming
              ? 'var(--editor-glow-accent, 0 0 0 1px hsl(var(--editor-accent)))'
              : selected
                ? 'var(--editor-glow-selected)'
                : undefined,
          touchAction: 'none',
        }}
        title={asset?.name ?? clip.id}
      >
        {/* Thumbnail (vídeo/imagem) — fundo do clip. */}
        {asset && (asset.type === 'video' || asset.type === 'image') && (
          <ClipThumbnail
            clip={clip}
            asset={asset}
            width={width}
            height={clipHeight}
          />
        )}

        {/* Waveform (áudio). */}
        {asset && asset.type === 'audio' && track.type === 'audio' && (
          <ClipWaveform
            clip={clip}
            asset={asset}
            width={width}
            height={Math.min(32, clipHeight - 16)}
          />
        )}

        {/* Label do clip — sobreposto ao fundo (thumbnail/waveform). */}
        <div className="relative z-10 flex h-full flex-col justify-center px-2">
          <span
            className="truncate text-[10px] font-medium text-foreground"
            style={{
              textShadow:
                asset && (asset.type === 'video' || asset.type === 'image')
                  ? '0 1px 2px rgba(0,0,0,0.7)'
                  : undefined,
            }}
          >
            {asset?.name ?? '—'}
          </span>
          {clip.slot !== 'full' && (
            <span className="text-[9px] uppercase text-muted-foreground">
              {clip.slot}
            </span>
          )}
        </div>

        {/* Handle ESQUERDO (trim left). Visual 8px (w-2); hitbox expandida
            via pseudo-elemento ::before (-inset-x-3 = +24px clicáveis no
            total) para uso confortável em touch/mouse. */}
        {tool !== 'blade' && !clip.locked && !track.locked && (
          <div
            data-clip-handle="left"
            onPointerDown={trim.onLeftPointerDown}
            className={cn(
              'absolute left-0 top-0 bottom-0 w-2',
              'cursor-ew-resize',
              'hover:bg-[var(--editor-accent-soft,rgba(255,255,255,0.15))]',
              "before:absolute before:-inset-x-3 before:inset-y-0 before:content-['']",
            )}
            style={{ touchAction: 'none' }}
          />
        )}

        {/* Handle DIREITO (trim right). Visual 8px com hitbox de 24px. */}
        {tool !== 'blade' && !clip.locked && !track.locked && (
          <div
            data-clip-handle="right"
            onPointerDown={trim.onRightPointerDown}
            className={cn(
              'absolute right-0 top-0 bottom-0 w-2',
              'cursor-ew-resize',
              'hover:bg-[var(--editor-accent-soft,rgba(255,255,255,0.15))]',
              "before:absolute before:-inset-x-3 before:inset-y-0 before:content-['']",
            )}
            style={{ touchAction: 'none' }}
          />
        )}
      </div>

      </ContextMenuTrigger>

      <ContextMenuContent className="w-56">
        <ContextMenuLabel className="truncate" title={asset?.name}>
          {truncateFilename(asset?.name ?? 'Clip', 32, 8)}
        </ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleDownload} disabled={!asset}>
          <Download className="mr-2 h-4 w-4" />
          {downloadLabel}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleSplitAtPlayhead} disabled={clip.locked || track.locked}>
          <Scissors className="mr-2 h-4 w-4" />
          Dividir no playhead
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleCopiarAjustes}>
          <Copy className="mr-2 h-4 w-4" />
          Copiar ajustes
        </ContextMenuItem>
        <ContextMenuItem
          onClick={handleColarAjustes}
          disabled={!hasAdjustments || clip.locked || track.locked}
        >
          <ClipboardPaste className="mr-2 h-4 w-4" />
          Colar ajustes
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => setClipLocked(clip.id, !clip.locked)}>
          {clip.locked ? (
            <>
              <Unlock className="mr-2 h-4 w-4" />
              Destravar
            </>
          ) : (
            <>
              <Lock className="mr-2 h-4 w-4" />
              Travar
            </>
          )}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => setClipHidden(clip.id, !clip.hidden)}>
          {clip.hidden ? (
            <>
              <Eye className="mr-2 h-4 w-4" />
              Mostrar
            </>
          ) : (
            <>
              <EyeOff className="mr-2 h-4 w-4" />
              Esconder
            </>
          )}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => removeClip(clip.id)}
          disabled={clip.locked || track.locked}
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Remover clip
        </ContextMenuItem>
      </ContextMenuContent>

      {/* HUD durante drag/trim. */}
      <HudOverlay
        visible={hudLabel !== null}
        label={hudLabel ?? ''}
        sublabel={hudSub}
      />
    </ContextMenu>
  );
}
