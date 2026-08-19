'use client';

/**
 * Palco de preview.
 *
 * Mantém o aspect ratio do projeto (resolution.width/height) e renderiza:
 *
 * - Em `stageMode === 'single'`: um único `StageSlot` (placeholder visual
 *   quando vazio) + camadas (`VideoLayer`/`ImageLayer`) sobrepostas em
 *   z-index = índice da track (V1 é o fundo).
 * - Em `stageMode === 'split-vertical'`: dois `StageSlot` (top/bottom)
 *   marcam as áreas vazias; os layers são renderizados sobre o palco
 *   inteiro e cortados via `clip-path` segundo o `slot` do clip.
 *
 * Tracks de áudio são ignoradas aqui (mixadas pelo agente B no
 * `useAudioMixer`). Tracks `hidden`/`visible: false` ou clips `hidden`
 * também são pulados.
 *
 * Para cada track, escolhemos o clip "ativo" no playhead atual; se vários
 * clips se sobrepõem, ganha o de `startInTimeline` mais alto (mais recente).
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useEditorStore } from '@/lib/editor/store';
import {
  findActiveClipAt,
  effectiveSlot,
  trackLayerCount,
  clipsInLayer,
} from '@/lib/editor/preview-utils';
import { StageSlot } from './StageSlot';
import { SplitDivider } from './SplitDivider';
import { VideoLayer, ImageLayer } from './layers';
import { CaptionsOverlay } from './CaptionsOverlay';
import { EditorIcons } from '../shared/EditorIcons';
import { useToast } from '@/hooks/use-toast';
import { useIngestFiles, mediaTypeOf } from '@/lib/editor/ingest-files';
import { useFirestore, useMemoFirebase, useDoc, useStorage } from '@/firebase';
import { doc } from 'firebase/firestore';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { cn } from '@/lib/utils';
import type { Clip, MediaAsset, Track } from '@/lib/editor/types';
import { DEFAULT_IDENTITY } from '@/lib/editor/types';
import type { AppearanceConfig } from '@/lib/types';

/** MIME usado pela biblioteca/MediaBin (mesmo da timeline). */
const ASSET_MIME = 'application/vnd.oficioexpresso.asset';

/** Resolve storage path → download URL, ou usa URL direta se já for https. */
function useOverlayUrl(pathOrUrl: string | undefined): string | null {
  const storage = useStorage();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!pathOrUrl) { setUrl(null); return; }
    if (pathOrUrl.startsWith('https://')) { setUrl(pathOrUrl); return; }
    const ref = storageRef(storage, pathOrUrl);
    getDownloadURL(ref).then(setUrl).catch(() => setUrl(pathOrUrl));
  }, [pathOrUrl, storage]);
  return url;
}

interface ResolvedLayer {
  track: Track;
  clip: Clip;
  asset: MediaAsset;
  zIndex: number;
}

/**
 * Overlay que aparece sobre o palco quando algum vídeo dos clips ativos
 * no playhead atual ainda não está pronto pra reproduzir (readyState < 3
 * = HAVE_FUTURE_DATA). Mostra spinner + % de buffer médio.
 */
function StageLoadingOverlay({
  layers,
  playhead: _playhead,
}: {
  layers: ResolvedLayer[];
  playhead: number;
}) {
  const [state, setState] = useState<{ loading: boolean; bufferPct: number }>({
    loading: false,
    bufferPct: 0,
  });

  useEffect(() => {
    const activeIds = new Set(
      layers
        .filter((l) => l.asset.type === 'video')
        .map((l) => l.clip.id),
    );
    if (activeIds.size === 0) {
      setState({ loading: false, bufferPct: 0 });
      return;
    }

    let cancelled = false;
    // Só mostra overlay se buffering por > 1s (evita flash em load rápido).
    let bufferingSince: number | null = null;
    const BUFFERING_DELAY_MS = 1000;

    const tick = () => {
      if (cancelled) return;
      const nodes = document.querySelectorAll<HTMLDivElement>(
        '[data-layer="video"][data-clip-id]',
      );
      // Threshold relaxado: readyState >= 2 (HAVE_CURRENT_DATA) já permite
      // mostrar o frame atual. Antes era 3 (HAVE_FUTURE_DATA), o que travava
      // o overlay quando o vídeo só tinha 1 frame carregado mas era visível.
      let anyBuffering = false;
      let totalPct = 0;
      let count = 0;
      for (const n of Array.from(nodes)) {
        const id = n.dataset.clipId;
        if (!id || !activeIds.has(id)) continue;
        const v = n.querySelector('video');
        if (!v) continue;
        count++;
        if (v.readyState < 2) anyBuffering = true;
        if (v.duration > 0 && v.buffered.length > 0) {
          const end = v.buffered.end(v.buffered.length - 1);
          totalPct += Math.min(1, end / v.duration);
        } else if (v.readyState >= 2) {
          // Tem frame atual mas buffered ainda 0 (vídeo curto / cache)
          totalPct += 1;
        }
      }
      const pct = count > 0 ? Math.round((totalPct / count) * 100) : 0;

      if (anyBuffering) {
        if (bufferingSince == null) bufferingSince = Date.now();
        const elapsed = Date.now() - bufferingSince;
        if (elapsed >= BUFFERING_DELAY_MS) {
          setState({ loading: true, bufferPct: pct });
        }
      } else {
        bufferingSince = null;
        setState({ loading: false, bufferPct: pct });
      }
    };

    tick();
    const interval = window.setInterval(tick, 250);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [layers]);

  if (!state.loading) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-black/40 backdrop-blur-sm">
      <Loader2 className="h-8 w-8 animate-spin text-white" />
      <p className="text-xs font-medium text-white">
        Carregando mídia… {state.bufferPct}%
      </p>
    </div>
  );
}

/**
 * Hook que mede o container pai e devolve o maior retângulo com o
 * `aspectRatio` desejado que cabe dentro — fits-by-height OU
 * fits-by-width conforme as proporções. Atualiza via ResizeObserver.
 */
function useFitToParent(
  parentRef: React.RefObject<HTMLElement>,
  aspectW: number,
  aspectH: number,
): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const parent = parentRef.current;
    if (!parent || aspectW <= 0 || aspectH <= 0) return;
    const ratio = aspectW / aspectH;
    const compute = () => {
      const cw = parent.clientWidth;
      const ch = parent.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      const cr = cw / ch;
      let w: number;
      let h: number;
      if (cr > ratio) {
        h = ch;
        w = h * ratio;
      } else {
        w = cw;
        h = w / ratio;
      }
      setSize((prev) =>
        Math.abs(prev.width - w) < 0.5 && Math.abs(prev.height - h) < 0.5
          ? prev
          : { width: w, height: h },
      );
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [parentRef, aspectW, aspectH]);
  return size;
}

export function PreviewStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const stageMode = useEditorStore((s) => s.project?.stageMode ?? 'single');
  const splitRatio = useEditorStore((s) => s.project?.splitRatio ?? 0.5);
  const resolution = useEditorStore((s) => s.project?.resolution);
  const tracks = useEditorStore((s) => s.project?.tracks);
  const assets = useEditorStore((s) => s.project?.assets);
  const playhead = useEditorStore((s) => s.ui.playhead);
  const isPlaying = useEditorStore((s) => s.ui.isPlaying);
  const duration = useEditorStore((s) => s.project?.duration ?? 0);
  const stageBackground = useEditorStore(
    (s) => s.project?.stageBackground ?? '#000000',
  );
  const overlays = useEditorStore((s) => s.project?.overlays);
  const identity = useEditorStore((s) => s.project?.identity);

  // Duração da vinheta (pós-trim) reportada pelo EndingVideoLayer — usada
  // para o fade final do rodapé no preview.
  const [endingDuration, setEndingDuration] = useState(0);

  // Configs de aparência para os assets de sobreposição
  const firestore = useFirestore();
  const configRef = useMemoFirebase(
    () => (firestore ? doc(firestore, 'configs', 'main') : null),
    [firestore],
  );
  const { data: configData } = useDoc<AppearanceConfig>(configRef);
  const logoUrl = useOverlayUrl(configData?.videoLogoUrl);
  const footerUrl = useOverlayUrl(configData?.videoFooterUrl);
  const endingUrl = useOverlayUrl(configData?.videoEncerramentoUrl);

  const aspectW = resolution?.width ?? 16;
  const aspectH = resolution?.height ?? 9;
  const { width: stageW, height: stageH } = useFitToParent(
    containerRef,
    aspectW,
    aspectH,
  );

  // Resolve quais clips renderizar nesse frame.
  //
  // Dentro de cada track de vídeo pode haver N CAMADAS (subtracks). Cada
  // camada escolhe seu próprio clip ativo no playhead — assim várias mídias
  // empilham na mesma track (base + PiP + overlay). O z-order é um contador
  // global incremental: tracks por `index` ascendente, e dentro de cada track
  // as camadas por índice ascendente (camada 0 = mais embaixo). Track de uma
  // única camada se comporta exatamente como antes (um clip ativo, 1 z-index).
  const layers: ResolvedLayer[] = [];
  if (tracks && assets) {
    // Ordena por index ascendente (V1 fundo → Vn topo).
    const sorted = [...tracks]
      .filter((t) => t.type !== 'audio' && t.visible)
      .sort((a, b) => a.index - b.index);

    let z = 0;
    sorted.forEach((track) => {
      const layerCount = trackLayerCount(track);
      for (let layer = 0; layer < layerCount; layer++) {
        const clip = findActiveClipAt(clipsInLayer(track.clips, layer), playhead);
        // Avança o z mesmo sem clip, pra manter camadas acima sempre por cima.
        const zIndex = z;
        z += 1;
        if (!clip) continue;
        const asset = assets.find((a) => a.id === clip.assetId);
        if (!asset) continue;
        // Imagens com type 'audio' nunca caem aqui (track filtrada acima).
        layers.push({ track, clip, asset, zIndex });
      }
    });
  }

  // Saber se top/bottom têm conteúdo (para placeholder).
  const hasTop =
    stageMode === 'split-vertical' &&
    layers.some(
      (l) => effectiveSlot(l.clip.slot, stageMode) === 'top',
    );
  const hasBottom =
    stageMode === 'split-vertical' &&
    layers.some(
      (l) => effectiveSlot(l.clip.slot, stageMode) === 'bottom',
    );
  const hasFull = stageMode === 'single' && layers.length > 0;

  // Drop de mídia SOBRE o palco já preenchido (substituir/empilhar). Os
  // `StageSlot` cuidam dos slots VAZIOS; este overlay cobre o resto.
  const addClipToSlot = useEditorStore((s) => s.addClipToSlot);
  const ingestFiles = useIngestFiles();
  const { toast } = useToast();
  // Slot sob o cursor durante o drag (null = não está arrastando sobre o palco).
  const [dropSlot, setDropSlot] = useState<'full' | 'top' | 'bottom' | null>(
    null,
  );

  const canAcceptStageDrag = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    return types.includes(ASSET_MIME) || types.includes('Files');
  };

  /** Resolve o slot sob o cursor conforme o modo do palco. */
  const slotAtPointer = (
    e: React.DragEvent<HTMLDivElement>,
  ): 'full' | 'top' | 'bottom' => {
    if (stageMode !== 'split-vertical') return 'full';
    const rect = e.currentTarget.getBoundingClientRect();
    const yRatio = (e.clientY - rect.top) / Math.max(1, rect.height);
    return yRatio <= splitRatio ? 'top' : 'bottom';
  };

  const handleStageDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!canAcceptStageDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const slot = slotAtPointer(e);
    if (dropSlot !== slot) setDropSlot(slot);
  };

  const handleStageDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropSlot(null);
  };

  const handleStageDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    if (!canAcceptStageDrag(e)) return;
    e.preventDefault();
    const slot = slotAtPointer(e);
    setDropSlot(null);

    // 1) Asset da biblioteca.
    const assetData = e.dataTransfer.getData(ASSET_MIME);
    if (assetData) {
      try {
        const payload = JSON.parse(assetData) as { id: string; type?: string };
        if (payload.type === 'audio') {
          toast({
            title: 'Áudio não vai no palco',
            description: 'Arraste áudios para uma track de áudio na timeline.',
            variant: 'destructive',
          });
          return;
        }
        const id = addClipToSlot(payload.id, slot);
        if (!id) {
          toast({
            title: 'Não foi possível adicionar',
            description: 'Verifique se a mídia é compatível com o palco.',
            variant: 'destructive',
          });
        }
      } catch {
        // payload inválido — ignora
      }
      return;
    }

    // 2) Arquivo do SO → ingere e encaixa no slot sob o cursor.
    const file = e.dataTransfer.files[0];
    if (file) {
      const kind = mediaTypeOf(file);
      if (kind !== 'video' && kind !== 'image') {
        toast({
          title: 'Tipo não suportado no palco',
          description: 'Solte um arquivo de vídeo ou imagem.',
          variant: 'destructive',
        });
        return;
      }
      const [asset] = await ingestFiles([file]);
      if (asset) addClipToSlot(asset.id, slot);
    }
  };

  // Só mostramos o overlay de "soltar pra substituir" quando o slot sob o
  // cursor JÁ tem conteúdo (slot vazio é tratado pelo próprio StageSlot).
  const dropSlotHasContent =
    dropSlot === 'full'
      ? hasFull
      : dropSlot === 'top'
        ? hasTop
        : dropSlot === 'bottom'
          ? hasBottom
          : false;

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex h-full min-h-0 w-full min-w-0 items-center justify-center overflow-hidden',
        'bg-background p-2 sm:p-4',
      )}
    >
      <div
        ref={stageRef}
        onDragOver={handleStageDragOver}
        onDragLeave={handleStageDragLeave}
        onDrop={handleStageDrop}
        className={cn(
          'relative overflow-hidden',
          'rounded-[var(--editor-radius-md)] shadow-[var(--editor-shadow-floating)]',
        )}
        style={{
          width: stageW || 0,
          height: stageH || 0,
          backgroundColor: stageBackground,
        }}
      >
        <StageLoadingOverlay layers={layers} playhead={playhead} />
        {/* Slots de placeholder (mostrados quando não há clip no slot). */}
        {stageMode === 'single' ? (
          !hasFull && (
            <StageSlot slot="full" className="absolute inset-0" />
          )
        ) : (
          <>
            {!hasTop && (
              <StageSlot
                slot="top"
                className="absolute left-0 right-0 top-0"
              />
            )}
            {!hasBottom && (
              <StageSlot
                slot="bottom"
                className="absolute bottom-0 left-0 right-0"
              />
            )}
            {/* Alturas dos placeholders refletem o splitRatio. */}
            <style>{`
              [data-slot="top"]   { height: ${splitRatio * 100}%; }
              [data-slot="bottom"]{ height: ${(1 - splitRatio) * 100}%; }
            `}</style>
          </>
        )}

        {/* Camadas de mídia (vídeo / imagem). */}
        {layers.map(({ clip, asset, zIndex }) => {
          const slot = effectiveSlot(clip.slot, stageMode);
          if (asset.type === 'video') {
            return (
              <VideoLayer
                key={clip.id}
                clip={clip}
                asset={asset}
                zIndex={zIndex}
                isInSlot={slot}
                splitRatio={splitRatio}
              />
            );
          }
          if (asset.type === 'image') {
            // Imagem é sempre "ativa" enquanto o playhead estiver no range.
            // Já filtramos via `findActiveClipAt`, então passamos `true`.
            return (
              <ImageLayer
                key={clip.id}
                clip={clip}
                asset={asset}
                isActive
                zIndex={zIndex}
                isInSlot={slot}
                splitRatio={splitRatio}
              />
            );
          }
          // Áudio puro não tem layer visual.
          return null;
        })}

        {/* Legendas (acima das mídias, abaixo do divisor). */}
        <CaptionsOverlay stageMode={stageMode} splitRatio={splitRatio} />

        {/* Sobreposição: Logo (topo-direito, some em fade ANTES da vinheta) */}
        {overlays?.logo && logoUrl && (
          <img
            src={logoUrl}
            alt=""
            className="pointer-events-none absolute z-30"
            style={{
              top: '1.5%',
              right: '2%',
              width: `${identity?.logoWidthPct ?? DEFAULT_IDENTITY.logoWidthPct}%`,
              objectFit: 'contain',
              // fade de 0,4s terminando 0,1s antes do fim do conteúdo —
              // espelha o export (o logo NUNCA aparece sobre a vinheta).
              opacity: logoOpacityAt(playhead, duration),
            }}
          />
        )}

        {/* Sobreposição: Rodapé (atravessa a vinheta; fade só no fim) */}
        {overlays?.footer && footerUrl && (
          <img
            src={footerUrl}
            alt=""
            className="pointer-events-none absolute z-30"
            style={{
              bottom: '1%',
              left: '50%',
              transform: 'translateX(-50%)',
              width: `${identity?.footerWidthPct ?? DEFAULT_IDENTITY.footerWidthPct}%`,
              objectFit: 'contain',
              opacity: footerOpacityAt(
                playhead,
                duration + (overlays?.ending ? endingDuration : 0),
              ),
            }}
          />
        )}

        {/* Vinheta Final: camada de vídeo que aparece após o conteúdo principal */}
        {overlays?.ending && endingUrl && (
          <EndingVideoLayer
            src={endingUrl}
            playhead={playhead}
            projectDuration={duration}
            isPlaying={isPlaying}
            trimStart={identity?.endingTrimStart ?? 0}
            onDurationChange={setEndingDuration}
          />
        )}

        {/* Overlay de "soltar para substituir" — só quando o slot sob o
            cursor já tem conteúdo (slot vazio é tratado pelo StageSlot). */}
        {dropSlot && dropSlotHasContent && (
          <div
            className="pointer-events-none absolute z-40 flex flex-col items-center justify-center gap-1.5 bg-[var(--editor-accent-soft)]/80 backdrop-blur-[2px]"
            style={
              stageMode === 'split-vertical' && dropSlot === 'top'
                ? { left: 0, right: 0, top: 0, height: `${splitRatio * 100}%` }
                : stageMode === 'split-vertical' && dropSlot === 'bottom'
                  ? {
                      left: 0,
                      right: 0,
                      bottom: 0,
                      height: `${(1 - splitRatio) * 100}%`,
                    }
                  : { inset: 0 }
            }
          >
            <div className="rounded-full border-2 border-dashed border-[var(--editor-accent)] p-3">
              <EditorIcons.Image className="h-7 w-7 text-[var(--editor-accent)]" />
            </div>
            <span className="rounded bg-black/50 px-2 py-0.5 text-xs font-medium text-white">
              Soltar para substituir
            </span>
          </div>
        )}

        {/* Divisor (acima de tudo). */}
        {stageMode === 'split-vertical' && (
          <SplitDivider ratio={splitRatio} stageRef={stageRef} />
        )}
      </div>
    </div>
  );
}

/**
 * Camada que reproduz o vídeo de encerramento quando o playhead ultrapassa
 * a duração do conteúdo principal.
 */
function EndingVideoLayer({
  src,
  playhead,
  projectDuration,
  isPlaying,
  trimStart = 0,
  onDurationChange,
}: {
  src: string;
  playhead: number;
  projectDuration: number;
  isPlaying: boolean;
  /** Segundos cortados do INÍCIO da vinheta (tela preta) — identidade. */
  trimStart?: number;
  /** Duração efetiva (pós-trim), reportada quando os metadados chegam. */
  onDurationChange?: (dur: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const isActive = playhead >= projectDuration;
  const timeInEnding = Math.max(0, playhead - projectDuration) + trimStart;

  // Seek ao tempo correto dentro da vinheta (offset do trim incluído)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (Math.abs(video.currentTime - timeInEnding) > 0.15) {
      video.currentTime = timeInEnding;
    }
  }, [timeInEnding]);

  // Play/pause sincronizado com o store
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isActive && isPlaying) {
      video.play().catch(() => {});
    } else {
      video.pause();
      if (!isActive) video.currentTime = trimStart;
    }
  }, [isPlaying, isActive, trimStart]);

  return (
    <video
      ref={videoRef}
      src={src}
      className={cn(
        'pointer-events-none absolute inset-0 z-20 h-full w-full object-cover',
        !isActive && 'hidden',
      )}
      playsInline
      preload="auto"
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d)) {
          onDurationChange?.(Math.max(0.2, d - trimStart));
        }
      }}
    />
  );
}

/**
 * Opacidade do LOGO no preview — espelha o export: fade alpha de 0,4s
 * terminando 0,1s antes do fim do conteúdo principal (antes da vinheta).
 */
function logoOpacityAt(playhead: number, mainDuration: number): number {
  if (mainDuration <= 0) return 1;
  const fadeStart = mainDuration - 0.5;
  if (playhead <= fadeStart) return 1;
  const t = (playhead - fadeStart) / 0.4;
  return Math.max(0, Math.min(1, 1 - t));
}

/**
 * Opacidade do RODAPÉ — fade de 1s terminando 0,1s antes do fim TOTAL
 * (conteúdo + vinheta). Sem vinheta, o fim total é o fim do conteúdo.
 */
function footerOpacityAt(playhead: number, totalDuration: number): number {
  if (totalDuration <= 0) return 1;
  const fadeStart = totalDuration - 1.1;
  if (playhead <= fadeStart) return 1;
  const t = (playhead - fadeStart) / 1.0;
  return Math.max(0, Math.min(1, 1 - t));
}
