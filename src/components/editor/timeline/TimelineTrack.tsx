'use client';

/**
 * Linha de track na timeline.
 *
 * Compõe `TrackHeader` (esquerda fixa) + área de clips (direita scrollável,
 * largura = duration * zoom).
 *
 * Aceita drop de assets (asset MIME) e cria clip via `addClipFromAsset`.
 * Aceita também item do ACERVO e da BIBLIOTECA do gabinete (recurso 16):
 * nesses dois o arquivo ainda não é asset do projeto, então a lane baixa/
 * resolve na hora do drop e só depois encaixa o clip.
 *
 * O `<div>` da área de clips expõe `data-track-id` e `data-track-type` para
 * que `useClipDrag` consiga identificá-la via `document.elementsFromPoint`
 * durante o drag vertical de um clip.
 *
 * Quando `ui.isDragging === true` (algum clip arrastado), aplica um leve
 * highlight para indicar que aquela track aceita drop.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Clip, Track, TransitionConfig, TransitionType } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import { trackLayerCount, clipsInLayer } from '@/lib/editor/preview-utils';
import { TRANSITION_DRAG_MIME } from '@/lib/editor/transitions';
import { useIngestFiles, mediaTypeOf } from '@/lib/editor/ingest-files';
import {
  ACERVO_DRAG_MIME,
  trazerDoAcervo,
  type PedidoAcervo,
} from '@/lib/editor/acervo/cliente';
import {
  BIBLIOTECA_DRAG_MIME,
  assetDaBiblioteca,
  type ItemBiblioteca,
} from '@/lib/editor/acervo/biblioteca';
import { useStorage } from '@/firebase';
import { useToast } from '@/hooks/use-toast';
import { TrackHeader } from './TrackHeader';
import { TimelineClip } from './TimelineClip';
import { TransitionMarker } from '../transitions/TransitionMarker';
import { cn } from '@/lib/utils';

/** MIME usado pela biblioteca/MediaBin. */
const ASSET_MIME = 'application/vnd.oficioexpresso.asset';

interface TimelineTrackProps {
  track: Track;
  zoom: number;
  contentWidth: number;
}

export function TimelineTrack({ track, zoom, contentWidth }: TimelineTrackProps) {
  const selectedTrackId = useEditorStore((s) => s.ui.selectedTrackId);

  // Número de camadas (subtracks) — só vídeo tem > 1. Track de 1 camada
  // renderiza UMA lane, idêntica ao comportamento anterior.
  const layerCount = trackLayerCount(track);

  // As camadas são desenhadas de cima pra baixo: camada de maior índice
  // (mais "por cima" no preview) aparece NO TOPO da track na timeline,
  // espelhando a convenção NLE (Vn em cima). A altura da track é dividida
  // igualmente entre as camadas.
  const laneHeight = Math.max(24, Math.round(track.height / layerCount));
  const layersTopFirst = Array.from({ length: layerCount }, (_, i) =>
    layerCount - 1 - i,
  );

  return (
    <div className="flex shrink-0">
      <TrackHeader track={track} selected={selectedTrackId === track.id} />

      <div
        className="relative shrink-0"
        style={{ width: contentWidth, height: track.height }}
      >
        {layersTopFirst.map((layer) => (
          <TrackLane
            key={layer}
            track={track}
            layer={layer}
            layerCount={layerCount}
            zoom={zoom}
            contentWidth={contentWidth}
            laneHeight={laneHeight}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Lane — uma CAMADA (subtrack) dentro de uma track. Drop target próprio com
// `data-layer`, renderiza só os clips daquela camada.
// ============================================================================

interface TrackLaneProps {
  track: Track;
  layer: number;
  layerCount: number;
  zoom: number;
  contentWidth: number;
  laneHeight: number;
}

function TrackLane({
  track,
  layer,
  layerCount,
  zoom,
  contentWidth,
  laneHeight,
}: TrackLaneProps) {
  const isClipDragging = useEditorStore((s) => s.ui.isDragging);
  const addClipFromAsset = useEditorStore((s) => s.addClipFromAsset);
  const applyTransitionBetween = useEditorStore(
    (s) => s.applyTransitionBetween,
  );
  const setTransition = useEditorStore((s) => s.setTransition);
  const removeTransition = useEditorStore((s) => s.removeTransition);
  const ingest = useIngestFiles();
  const storage = useStorage();
  const addAsset = useEditorStore((s) => s.addAsset);
  const projectId = useEditorStore((s) => s.project?.id ?? null);
  const { toast } = useToast();

  // Clips desta camada.
  const laneClips = useMemo(
    () => clipsInLayer(track.clips, layer),
    [track.clips, layer],
  );

  // Highlight do drag HTML5 (asset da biblioteca / arquivo do SO). Separado
  // do highlight de clip-drag (`ui.isDragging` + `pointerOver`) pra não
  // colidir — esse aqui reage ao drag NATIVO, que não passa por pointer events.
  const [isAssetOver, setIsAssetOver] = useState(false);

  /** Tipos que esta lane aceita via drag HTML5. */
  const canAcceptDrag = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    return (
      types.includes(ASSET_MIME) ||
      types.includes(ACERVO_DRAG_MIME) ||
      types.includes(BIBLIOTECA_DRAG_MIME) ||
      types.includes(TRANSITION_DRAG_MIME) ||
      types.includes('Files')
    );
  };

  // Track recebe drop de asset, arquivo do SO OU transition card.
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (track.locked) return;
    if (!canAcceptDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    // Transição tem seu próprio marker visual; não acendemos a lane inteira.
    if (
      !isAssetOver &&
      !e.dataTransfer.types.includes(TRANSITION_DRAG_MIME)
    ) {
      setIsAssetOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Ignora bolhas de filhos (clips) dentro da própria lane.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsAssetOver(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (track.locked) return;
    setIsAssetOver(false);

    const rect = e.currentTarget.getBoundingClientRect();
    const dropX = e.clientX - rect.left + e.currentTarget.scrollLeft;
    const atTime = Math.max(0, dropX / zoom);

    // 1) Drop de asset → cria clip NA CAMADA desta lane.
    const assetData = e.dataTransfer.getData(ASSET_MIME);
    if (assetData) {
      e.preventDefault();
      try {
        const payload = JSON.parse(assetData) as { id: string };
        addClipFromAsset(payload.id, track.id, atTime, layer);
      } catch {
        // payload inválido — ignora
      }
      return;
    }

    // 1b) Drop de item do ACERVO (som/meme ainda não baixado): baixa só ele
    //     e encaixa o clip no ponto onde foi solto (recurso 16).
    const acervoData = e.dataTransfer.getData(ACERVO_DRAG_MIME);
    if (acervoData) {
      e.preventDefault();
      try {
        const pedido = JSON.parse(acervoData) as PedidoAcervo;
        const querAudio = pedido.tipo === 'som';
        if (querAudio !== (track.type === 'audio')) {
          toast({
            title: 'Track incompatível',
            description: querAudio
              ? 'Som do acervo vai numa track de áudio.'
              : 'Meme/efeito vai numa track de vídeo.',
            variant: 'destructive',
          });
          return;
        }
        if (!projectId) return;
        toast({ title: `Trazendo "${pedido.nome}" do acervo…` });
        void (async () => {
          try {
            const asset = await trazerDoAcervo(projectId, pedido);
            addAsset(asset);
            addClipFromAsset(asset.id, track.id, atTime, layer);
          } catch (err) {
            toast({
              title: 'Não deu para trazer do acervo',
              description: err instanceof Error ? err.message : String(err),
              variant: 'destructive',
            });
          }
        })();
      } catch {
        // payload inválido — ignora
      }
      return;
    }

    // 1c) Drop de item da BIBLIOTECA do gabinete (já no Storage).
    const bibData = e.dataTransfer.getData(BIBLIOTECA_DRAG_MIME);
    if (bibData) {
      e.preventDefault();
      try {
        const item = JSON.parse(bibData) as ItemBiblioteca;
        const querAudio = item.type === 'audio';
        if (querAudio !== (track.type === 'audio')) {
          toast({
            title: 'Track incompatível',
            description: querAudio
              ? 'Áudio da biblioteca vai numa track de áudio.'
              : 'Vídeo/imagem da biblioteca vai numa track de vídeo.',
            variant: 'destructive',
          });
          return;
        }
        if (!storage) return;
        void (async () => {
          try {
            const asset = await assetDaBiblioteca(storage, item);
            addAsset(asset);
            addClipFromAsset(asset.id, track.id, atTime, layer);
          } catch (err) {
            toast({
              title: 'Não deu para usar o item da biblioteca',
              description: err instanceof Error ? err.message : String(err),
              variant: 'destructive',
            });
          }
        })();
      } catch {
        // payload inválido — ignora
      }
      return;
    }

    // 2) Drop de transição → aplica entre o par de clips mais próximo
    //    (dentro desta camada) do ponto onde foi solto.
    const txData = e.dataTransfer.getData(TRANSITION_DRAG_MIME);
    if (txData) {
      e.preventDefault();
      try {
        const payload = JSON.parse(txData) as { type: TransitionType };
        applyTransitionToNearestJunction(laneClips, atTime, payload.type, {
          applyTransitionBetween,
          setTransition,
        });
      } catch {
        // ignora payload inválido
      }
      return;
    }

    // 3) Drop de arquivo do SO → ingere e encaixa nesta track/camada.
    const file = e.dataTransfer.files[0];
    if (file) {
      e.preventDefault();
      const kind = mediaTypeOf(file);
      // Track de áudio só aceita áudio; track de vídeo aceita vídeo/imagem.
      const ok =
        track.type === 'audio' ? kind === 'audio' : kind === 'video' || kind === 'image';
      if (!ok) {
        toast({
          title: 'Tipo incompatível com a track',
          description:
            track.type === 'audio'
              ? 'Solte um arquivo de áudio nesta track.'
              : 'Solte um vídeo ou imagem nesta track.',
          variant: 'destructive',
        });
        return;
      }
      void (async () => {
        const [asset] = await ingest([file]);
        if (asset) addClipFromAsset(asset.id, track.id, atTime, layer);
      })();
    }
  };

  // Highlight visual: enquanto outro clip está sendo arrastado, mostra
  // bordinha sutil (drop target). Cor depende se o pointer está sobre.
  const [pointerOver, setPointerOver] = useState(false);

  const handlePointerEnter = () => {
    if (isClipDragging) setPointerOver(true);
  };
  const handlePointerLeave = () => setPointerOver(false);

  // Reset quando drag global terminar.
  useEffect(() => {
    if (!isClipDragging && pointerOver) {
      setPointerOver(false);
    }
  }, [isClipDragging, pointerOver]);

  // Markers de transição (só os pares desta camada).
  const markers = useMemo(() => computeMarkers(laneClips), [laneClips]);

  // Só desenha separador entre lanes (não na de baixo).
  const isBottomLane = layer === 0;

  return (
    <div
      data-track-id={track.id}
      data-track-type={track.type}
      data-layer={layer}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      className={cn(
        'relative shrink-0 border-border bg-background',
        isBottomLane ? 'border-b' : 'border-b border-dashed',
        // Drop target highlight enquanto algum clip está sendo arrastado.
        isClipDragging && !track.locked && 'bg-card',
        isClipDragging &&
          pointerOver &&
          !track.locked &&
          'ring-1 ring-inset ring-[var(--editor-accent-strong,hsl(var(--editor-accent)))]',
        // Highlight ao arrastar mídia da biblioteca / arquivo do SO (drag HTML5).
        isAssetOver &&
          !track.locked &&
          'bg-[var(--editor-accent-soft)] ring-1 ring-inset ring-[var(--editor-accent-strong,hsl(var(--editor-accent)))]',
      )}
      style={{ width: contentWidth, height: laneHeight }}
    >
      {/* Badge da camada (só quando há mais de uma). */}
      {layerCount > 1 && (
        <span className="pointer-events-none absolute left-1 top-0.5 z-20 rounded bg-black/40 px-1 text-[8px] font-medium uppercase leading-tight text-white/80">
          C{layer + 1}
        </span>
      )}

      {laneClips.map((clip) => (
        <TimelineClip
          key={clip.id}
          clip={clip}
          track={track}
          zoom={zoom}
          laneHeight={laneHeight}
        />
      ))}

      {/* Markers de transição (renderizados acima dos clips). */}
      {markers.map((m) => {
        const maxDur =
          Math.min(
            m.fromClip.endInTimeline - m.fromClip.startInTimeline,
            m.toClip.endInTimeline - m.toClip.startInTimeline,
          ) / 2;
        return (
          <TransitionMarker
            key={`${m.fromClip.id}->${m.toClip.id}`}
            fromClipId={m.fromClip.id}
            toClipId={m.toClip.id}
            transition={m.transition}
            position={m.position}
            zoom={zoom}
            trackHeight={laneHeight}
            maxDuration={Math.max(0.1, maxDur)}
            onUpdate={(patch) => {
              // Aplica em ambos os lados (A.out e B.in) para manter
              // a transição "geminada" e o marker estável.
              const next: TransitionConfig = { ...m.transition, ...patch };
              setTransition(m.fromClip.id, 'out', next);
              setTransition(m.toClip.id, 'in', next);
            }}
            onRemove={() => {
              removeTransition(m.fromClip.id, 'out');
              removeTransition(m.toClip.id, 'in');
            }}
          />
        );
      })}
    </div>
  );
}

// ============================================================================
// Helpers — markers de transição
// ============================================================================

interface MarkerInfo {
  fromClip: Clip;
  toClip: Clip;
  /** Tempo (s) do CENTRO da janela de transição. */
  position: number;
  transition: TransitionConfig;
}

/**
 * Encontra todas as junções de clips com transição configurada.
 *
 * Estratégia:
 * - Ordena clips por `startInTimeline`.
 * - Para cada par adjacente (A, B), se houver `A.transitionOut` ou
 *   `B.transitionIn`, gera um marker no ponto médio da janela.
 * - O ponto médio é calculado a partir do tempo da junção:
 *     - Se clipos tocam (A.end == B.start), `position = A.end`.
 *     - Se há overlap (A.end > B.start), `position = (A.end + B.start) / 2`.
 *     - Se há gap (A.end < B.start), `position = (A.end + B.start) / 2`
 *       (raro — usuário deveria ter sobreposto).
 */
function computeMarkers(clips: Clip[]): MarkerInfo[] {
  if (clips.length < 2) return [];
  const sorted = [...clips].sort(
    (a, b) => a.startInTimeline - b.startInTimeline,
  );
  const out: MarkerInfo[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    // Privilegia a transição de A.out (espelho de B.in via applyTransitionBetween).
    const transition = a.transitionOut ?? b.transitionIn;
    if (!transition) continue;
    const position = (a.endInTimeline + b.startInTimeline) / 2;
    out.push({ fromClip: a, toClip: b, position, transition });
  }
  return out;
}

/**
 * Aplica uma transição arrastada para a "junção mais próxima" do ponto
 * onde foi solta na timeline. Critérios:
 *
 * - Se `atTime` está dentro de 1s de uma junção entre dois clips
 *   adjacentes, aplica via `applyTransitionBetween`.
 * - Se `atTime` está dentro do primeiro clip (próximo do começo), aplica
 *   como transitionIn (fade-in inicial).
 * - Se `atTime` está perto do final do último clip, aplica como
 *   transitionOut (fade-out final).
 */
function applyTransitionToNearestJunction(
  clips: Clip[],
  atTime: number,
  type: TransitionType,
  store: {
    applyTransitionBetween: (
      a: string,
      b: string,
      type: TransitionType,
      duration?: number,
    ) => void;
    setTransition: (
      id: string,
      side: 'in' | 'out',
      config: TransitionConfig | null,
    ) => void;
  },
): void {
  if (clips.length === 0) return;
  const sorted = [...clips].sort(
    (a, b) => a.startInTimeline - b.startInTimeline,
  );

  // Encontra a junção mais próxima.
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < sorted.length - 1; i++) {
    const junction =
      (sorted[i].endInTimeline + sorted[i + 1].startInTimeline) / 2;
    const dist = Math.abs(atTime - junction);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  // Tolerância para "encaixar" na junção: 1 segundo.
  const SNAP = 1.0;
  if (bestIdx >= 0 && bestDist <= SNAP) {
    store.applyTransitionBetween(
      sorted[bestIdx].id,
      sorted[bestIdx + 1].id,
      type,
      0.5,
    );
    return;
  }

  // Fallback: aplica em fade-in/out do clip mais próximo do ponto solto.
  let nearestClip: Clip = sorted[0];
  let nearestDist = Infinity;
  for (const c of sorted) {
    const center = (c.startInTimeline + c.endInTimeline) / 2;
    const d = Math.abs(atTime - center);
    if (d < nearestDist) {
      nearestDist = d;
      nearestClip = c;
    }
  }

  const cfg: TransitionConfig = {
    type,
    duration: 0.5,
    easing: 'ease-in-out',
  };

  // Decide se é "in" ou "out" baseado em qual extremidade está mais perto.
  const distToStart = Math.abs(atTime - nearestClip.startInTimeline);
  const distToEnd = Math.abs(atTime - nearestClip.endInTimeline);
  if (distToStart <= distToEnd) {
    store.setTransition(nearestClip.id, 'in', cfg);
  } else {
    store.setTransition(nearestClip.id, 'out', cfg);
  }
}
