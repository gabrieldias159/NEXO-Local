'use client';

/**
 * Container principal da timeline.
 *
 * Estrutura visual:
 *   ┌─────────────────────────────────────────────┐
 *   │ TimelineToolbar                             │
 *   ├──────┬──────────────────────────────────────┤
 *   │ (96) │  Ruler (rola horizontal)             │
 *   │      ├──────────────────────────────────────┤
 *   │ Track│  Track 1 clips                       │
 *   │ Headers  Track 2 clips                      │
 *   │ (col)│  ...                                 │
 *   └──────┴──────────────────────────────────────┘
 *
 * O scroll horizontal é compartilhado entre ruler e tracks (mesmo
 * container scrollável vertical/horizontal).
 *
 * Quando não há tracks no projeto, renderiza um botão "Criar primeira
 * track" para permitir começar.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useEditorStore } from '@/lib/editor/store';
import { useIngestFiles, mediaTypeOf } from '@/lib/editor/ingest-files';
import { useToast } from '@/hooks/use-toast';
import { useFirestore, useMemoFirebase, useDoc, useStorage } from '@/firebase';
import { doc } from 'firebase/firestore';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { TimelineToolbar } from './TimelineToolbar';
import { TimelineRuler } from './TimelineRuler';
import { TimelineTrack } from './TimelineTrack';
import { TimelineCaptionTrack } from './TimelineCaptionTrack';
import { PlayheadIndicator } from './PlayheadIndicator';
import { SnapGuides } from './SnapGuides';
import { TimelineScrollbar } from './TimelineScrollbar';
import { EditorIcons } from '../shared/EditorIcons';
import { cn } from '@/lib/utils';
import type { AppearanceConfig } from '@/lib/types';

const TRACK_HEADER_WIDTH = 96; // px (matches w-24 in TrackHeader)

export function Timeline() {
  const tracks = useEditorStore((s) => s.project?.tracks ?? []);
  const captionTracks = useEditorStore(
    (s) => s.project?.captionTracks ?? [],
  );
  const duration = useEditorStore((s) => s.project?.duration ?? 0);
  const zoom = useEditorStore((s) => s.ui.zoom);
  const addTrack = useEditorStore((s) => s.addTrack);
  const stageMode = useEditorStore((s) => s.project?.stageMode ?? 'single');
  const addStageTrack = useEditorStore((s) => s.addStageTrack);
  const clearSelection = useEditorStore((s) => s.clearSelection);
  const overlaysEnding = useEditorStore((s) => s.project?.overlays?.ending ?? false);
  const playhead = useEditorStore((s) => s.ui.playhead);
  const isPlaying = useEditorStore((s) => s.ui.isPlaying);
  const setZoom = useEditorStore((s) => s.setZoom);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Carrega URL da vinheta final para exibir na timeline
  const firestore = useFirestore();
  const storage = useStorage();
  const configRef = useMemoFirebase(
    () => (firestore ? doc(firestore, 'configs', 'main') : null),
    [firestore],
  );
  const { data: configData } = useDoc<AppearanceConfig>(configRef);
  const [endingUrl, setEndingUrl] = useState<string | null>(null);
  const [endingDuration, setEndingDuration] = useState(0);

  useEffect(() => {
    const raw = configData?.videoEncerramentoUrl;
    if (!raw) { setEndingUrl(null); return; }
    const resolve = raw.startsWith('https://')
      ? Promise.resolve(raw)
      : getDownloadURL(storageRef(storage, raw)).catch(() => raw);
    resolve.then((url) => {
      setEndingUrl(url);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.src = url;
      v.onloadedmetadata = () => { setEndingDuration(v.duration); v.src = ''; };
      v.onerror = () => { v.src = ''; };
    });
  }, [configData?.videoEncerramentoUrl, storage]);

  // Garante "espaço extra" no fim da timeline (pelo menos 60s + 20s buffer).
  const minSeconds = Math.max(60, duration + 20);
  const contentWidth = Math.max(200, minSeconds * zoom);

  // Auto-scroll: mantém o playhead visível enquanto reproduz.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isPlaying) return;
    const playheadX = playhead * zoom;
    const visibleRight = el.scrollLeft + el.clientWidth - TRACK_HEADER_WIDTH;
    const margin = 80;
    if (playheadX >= visibleRight - margin) {
      const targetLeft = Math.max(0, playheadX - (el.clientWidth - TRACK_HEADER_WIDTH) * 0.3);
      el.scrollTo({ left: targetLeft, behavior: 'smooth' });
    }
  }, [playhead, zoom, isPlaying]);

  // Soma alturas para SnapGuides cobrir toda a área de tracks (inclui caption tracks).
  const totalTracksHeight =
    tracks.reduce((acc, t) => acc + t.height, 0) +
    captionTracks.reduce((acc) => acc + 56, 0) + // CaptionTrack altura padrão
    (overlaysEnding ? 48 : 0); // Vinheta Final virtual track

  return (
    <section
      className={cn(
        'flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden',
        'border-t border-border bg-background',
      )}
      onClick={() => clearSelection()}
    >
      <TimelineToolbar />

      {tracks.length === 0 ? (
        <EmptyTimeline
          onCreate={() => {
            addTrack('video', 'V1');
          }}
        />
      ) : (
        // Dual-container: outer rola VERTICAL com scrollbar nativa sutil
        // (.editor-scroll-soft), inner rola HORIZONTAL sem scrollbar nativa
        // (.editor-scroll) — a TimelineScrollbar custom é a barra horizontal.
        <div className="editor-scroll-soft min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div ref={scrollRef} className="editor-scroll min-w-0 overflow-x-auto overflow-y-hidden">
          <div
            className="flex flex-col"
            style={{ width: TRACK_HEADER_WIDTH + contentWidth }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Linha do ruler (alinhada com a área dos clips) */}
            <div className="flex">
              <div
                className="shrink-0 border-b border-border bg-card"
                style={{ width: TRACK_HEADER_WIDTH }}
              />
              <div className="relative">
                <TimelineRuler
                  contentWidth={contentWidth}
                  duration={minSeconds}
                  zoom={zoom}
                />
              </div>
            </div>

            {/* Tracks — vídeos em cima (índice desc), áudios embaixo (índice asc) */}
            <div className="relative">
              <div className="flex flex-col">
                {/* Vídeos. Em split-vertical, AGRUPADOS por palco (superior /
                    inferior / tela cheia) com cabeçalho de seção e botão de
                    adicionar track no palco. Em single, lista plana (NLE
                    clássico: maior index no topo). */}
                {stageMode === 'split-vertical' ? (
                  (() => {
                    const vids = tracks.filter((t) => t.type === 'video');
                    const ordenar = (arr: typeof vids) =>
                      arr.slice().sort((a, b) => b.index - a.index);
                    const top = ordenar(vids.filter((t) => t.stageSlot === 'top'));
                    const bottom = ordenar(vids.filter((t) => t.stageSlot === 'bottom'));
                    const full = ordenar(vids.filter((t) => !t.stageSlot));
                    const Grupo = ({
                      titulo,
                      slot,
                      lista,
                      podeAdd,
                    }: {
                      titulo: string;
                      slot?: 'top' | 'bottom';
                      lista: typeof vids;
                      podeAdd: boolean;
                    }) => (
                      <div>
                        <div
                          className="flex items-center gap-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                          style={{ width: TRACK_HEADER_WIDTH + contentWidth }}
                        >
                          <span className="truncate">{titulo}</span>
                          {podeAdd && slot && (
                            <button
                              type="button"
                              onClick={() => addStageTrack(slot)}
                              className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                              title={`Adicionar track no ${titulo.toLowerCase()}`}
                            >
                              + track
                            </button>
                          )}
                        </div>
                        {lista.map((track) => (
                          <TimelineTrack
                            key={track.id}
                            track={track}
                            zoom={zoom}
                            contentWidth={contentWidth}
                          />
                        ))}
                      </div>
                    );
                    return (
                      <>
                        <Grupo titulo="Palco superior" slot="top" lista={top} podeAdd />
                        <Grupo titulo="Palco inferior" slot="bottom" lista={bottom} podeAdd />
                        {full.length > 0 && (
                          <Grupo titulo="Tela cheia" lista={full} podeAdd={false} />
                        )}
                      </>
                    );
                  })()
                ) : (
                  tracks
                    .filter((t) => t.type === 'video')
                    .sort((a, b) => b.index - a.index)
                    .map((track) => (
                      <TimelineTrack
                        key={track.id}
                        track={track}
                        zoom={zoom}
                        contentWidth={contentWidth}
                      />
                    ))
                )}

                {/* Separador visual entre vídeo/áudio quando há ambos */}
                {tracks.some((t) => t.type === 'video') &&
                  tracks.some((t) => t.type === 'audio') && (
                    <div className="ml-24 h-px shrink-0 bg-border" />
                  )}

                {/* Áudios: menor index no topo, novos clicks vão pro fim */}
                {tracks
                  .filter((t) => t.type === 'audio')
                  .sort((a, b) => a.index - b.index)
                  .map((track) => (
                    <TimelineTrack
                      key={track.id}
                      track={track}
                      zoom={zoom}
                      contentWidth={contentWidth}
                    />
                  ))}

                {/* Caption tracks (sempre por baixo) */}
                {captionTracks
                  .slice()
                  .sort((a, b) => a.index - b.index)
                  .map((ct) => (
                    <TimelineCaptionTrack
                      key={ct.id}
                      track={ct}
                      zoom={zoom}
                      contentWidth={contentWidth}
                    />
                  ))}

                {/* Vinheta Final — track virtual bloqueada (não editável) */}
                {overlaysEnding && (
                  <EndingVirtualTrack
                    zoom={zoom}
                    contentWidth={contentWidth}
                    projectDuration={duration}
                    endingUrl={endingUrl}
                    endingDuration={endingDuration}
                  />
                )}
              </div>

              {/* Snap guides — desenhadas SOBRE as tracks, abaixo do playhead. */}
              <div
                className="pointer-events-none absolute top-0 bottom-0"
                style={{ left: TRACK_HEADER_WIDTH, width: contentWidth }}
              >
                <SnapGuides zoom={zoom} height={totalTracksHeight} />
              </div>

              {/* Playhead — posicionado na coluna direita (depois do header column) */}
              <div
                className="pointer-events-none absolute top-0 bottom-0"
                style={{ left: TRACK_HEADER_WIDTH }}
              >
                <PlayheadIndicator zoom={zoom} />
              </div>
            </div>
          </div>
        </div>
        </div>
      )}

      {/* Scrollbar horizontal sempre visível — substitui a scrollbar nativa do OS,
          que era muito sutil mesmo com tema. Inclui minimapa do playhead. */}
      {tracks.length > 0 && (
        <TimelineScrollbar
          scrollRef={scrollRef}
          contentWidth={contentWidth}
          trackHeaderWidth={TRACK_HEADER_WIDTH}
          playhead={playhead}
          zoom={zoom}
          durationSec={minSeconds}
          onZoomChange={setZoom}
        />
      )}
    </section>
  );
}

const ENDING_TRACK_HEIGHT = 48;
const ENDING_TRACK_COLOR = 'var(--editor-accent, #7c3aed)';

function EndingVirtualTrack({
  zoom,
  contentWidth,
  projectDuration,
  endingUrl,
  endingDuration,
}: {
  zoom: number;
  contentWidth: number;
  projectDuration: number;
  endingUrl: string | null;
  endingDuration: number;
}) {
  const clipLeft = projectDuration * zoom;
  const clipWidth = endingDuration > 0 ? endingDuration * zoom : zoom * 5;

  return (
    <div
      className="flex shrink-0 border-t border-border"
      style={{ height: ENDING_TRACK_HEIGHT }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div
        className="flex w-24 shrink-0 items-center gap-1 border-b border-border bg-card px-2"
        style={{ height: ENDING_TRACK_HEIGHT }}
      >
        <div
          className="h-5 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: ENDING_TRACK_COLOR }}
        />
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-muted-foreground">
          Vinheta Final
        </span>
        <EditorIcons.Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
      </div>

      {/* Clip area */}
      <div
        className="relative overflow-hidden border-b border-border bg-muted/20"
        style={{ width: contentWidth, height: ENDING_TRACK_HEIGHT }}
      >
        {clipLeft < contentWidth && (
          <div
            className="absolute top-1 bottom-1 flex items-center overflow-hidden rounded px-2"
            style={{
              left: clipLeft,
              width: Math.min(clipWidth, contentWidth - clipLeft),
              backgroundColor: ENDING_TRACK_COLOR + '33',
              borderLeft: `3px solid ${ENDING_TRACK_COLOR}`,
            }}
          >
            {endingUrl && (
              <video
                src={endingUrl}
                className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-40"
                muted
                preload="metadata"
              />
            )}
            <span className="relative z-10 truncate text-[10px] font-medium" style={{ color: ENDING_TRACK_COLOR }}>
              Vinheta Final {endingDuration > 0 ? `· ${endingDuration.toFixed(1)}s` : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

const ASSET_MIME = 'application/vnd.oficioexpresso.asset';

function EmptyTimeline({ onCreate }: { onCreate: () => void }) {
  const addTrack = useEditorStore((s) => s.addTrack);
  const addClipFromAsset = useEditorStore((s) => s.addClipFromAsset);
  const ingest = useIngestFiles();
  const { toast } = useToast();
  const [isDragOver, setIsDragOver] = useState(false);

  /** Garante uma track do tipo certo e devolve seu id. */
  const ensureTrack = (type: 'video' | 'audio'): string => {
    const latest = useEditorStore.getState().project;
    const existing = latest?.tracks.find((t) => t.type === type);
    if (existing) return existing.id;
    return addTrack(type, type === 'video' ? 'V1' : 'A1');
  };

  const canAccept = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    return types.includes(ASSET_MIME) || types.includes('Files');
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!canAccept(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    if (!canAccept(e)) return;
    e.preventDefault();
    setIsDragOver(false);

    // 1) Asset da biblioteca → cria a 1ª track compatível e insere no início.
    const assetData = e.dataTransfer.getData(ASSET_MIME);
    if (assetData) {
      try {
        const payload = JSON.parse(assetData) as {
          id: string;
          type?: string;
        };
        const trackType = payload.type === 'audio' ? 'audio' : 'video';
        const trackId = ensureTrack(trackType);
        addClipFromAsset(payload.id, trackId, 0);
      } catch {
        // payload inválido — ignora
      }
      return;
    }

    // 2) Arquivo do SO → ingere e encaixa na track recém-criada.
    const file = e.dataTransfer.files[0];
    if (file) {
      const kind = mediaTypeOf(file);
      if (!kind) {
        toast({
          title: 'Tipo não suportado',
          description: 'Solte um vídeo, imagem ou áudio.',
          variant: 'destructive',
        });
        return;
      }
      const trackId = ensureTrack(kind === 'audio' ? 'audio' : 'video');
      const [asset] = await ingest([file]);
      if (asset) addClipFromAsset(asset.id, trackId, 0);
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'm-3 flex flex-1 flex-col items-center justify-center gap-3 rounded-[var(--editor-radius-md)]',
        'border border-dashed p-6 text-center transition-colors',
        isDragOver
          ? 'border-[var(--editor-accent)] bg-[var(--editor-accent-soft)]'
          : 'border-border',
      )}
    >
      <EditorIcons.Layers
        className={cn(
          'h-8 w-8',
          isDragOver
            ? 'text-[var(--editor-accent)]'
            : 'text-muted-foreground',
        )}
      />
      <p className="text-sm text-muted-foreground">
        {isDragOver
          ? 'Solte para começar'
          : 'Arraste uma mídia aqui pra começar.'}
      </p>
      <Button size="sm" variant="outline" onClick={onCreate} className="gap-1.5">
        <EditorIcons.Plus className="h-4 w-4" />
        Criar primeira track
      </Button>
      <p className="text-[10px] text-muted-foreground">
        Ou arraste do MediaBin / do seu computador.
      </p>
    </div>
  );
}
