'use client';

/**
 * Layer de preview para clips de vídeo.
 *
 * Renderiza um `<video>` (muted por padrão — áudio é roteado pelo
 * `useAudioMixer`) absolutamente posicionado dentro do palco. Aplica:
 *
 * - `transform`: translate / scale / rotate / flip H/V (espaço do slot).
 * - `filter`: brightness / contrast / saturate / hue / blur / grayscale.
 * - `opacity`: respeita `transform.opacity` quando ativo, 0 quando inativo.
 * - `clip-path`: usado em `stageMode === 'split-vertical'` para que o
 *   clip ocupe apenas top/bottom conforme `slot`.
 *
 * Sincronização:
 * - Registra-se no `useVideoSync` (agente A) para play/pause/seek vindos
 *   do engine de transporte.
 * - Registra-se no `useAudioMixer` (agente B) para mixagem de áudio Web
 *   Audio (volume / pan / fade).
 */

import { useEffect, useMemo, useRef } from 'react';
import { useVideoSync, useAudioMixer } from '@/lib/editor/playback';
import {
  buildFilter,
  buildTransform,
  slotBox,
  resolveAssetUrl,
} from '@/lib/editor/preview-utils';
import { mergeTransform } from '@/lib/editor/transitions';
import type { Clip, MediaAsset } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import { useTransitionState } from '../use-transition-state';
import { ChromaKeyWebGL, ChromaKeyCanvas2D } from './ChromaKeyEngine';
import { useMediaElement } from '@/lib/editor/media-controller/use-media-controller';

interface VideoLayerProps {
  clip: Clip;
  asset: MediaAsset;
  /** Z-index do layer (track index, V1=0, V2=1, …). */
  zIndex: number;
  /**
   * Slot efetivo: `'full'` em `stageMode === 'single'`, ou `'top'`/`'bottom'`
   * em split. Usado para calcular o `clip-path`.
   */
  isInSlot?: 'full' | 'top' | 'bottom';
  /**
   * Razão do split (0..1). Apenas usado quando `isInSlot !== 'full'`.
   * Default 0.5.
   */
  splitRatio?: number;
  className?: string;
}

export function VideoLayer({
  clip,
  asset,
  zIndex,
  isInSlot = 'full',
  splitRatio = 0.5,
  className,
}: VideoLayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { registerVideo, updateClip, unregisterVideo, isClipActive } =
    useVideoSync();
  const { registerSource, unregisterSource } = useAudioMixer();

  // Resolve URL — pode ser blob: temporário (asset.file). Cleanup garantido.
  const resolved = useMemo(() => resolveAssetUrl(asset), [asset]);

  useEffect(() => {
    return () => {
      if (resolved?.isObjectUrl) {
        URL.revokeObjectURL(resolved.url);
      }
    };
  }, [resolved]);

  // Detecta se o asset é cross-origin (Firebase Storage) e o `<video>` não
  // tem `crossOrigin="anonymous"` setado. Nesse caso, `createMediaElementSource`
  // captura o áudio mas devolve SILÊNCIO no grafo Web Audio (CORS taint).
  // Fallback: pula o Web Audio mixer e deixa o vídeo tocar o áudio nativamente.
  // Volume/mute do clip são aplicados direto no element (`video.volume`/`video.muted`).
  const isCrossOriginAudio = useMemo(() => {
    if (!resolved || resolved.isObjectUrl) return false;
    try {
      const u = new URL(resolved.url, window.location.href);
      return u.origin !== window.location.origin;
    } catch {
      return false;
    }
  }, [resolved]);

  // Registro: video-sync sempre. Audio mixer só pra blob/same-origin.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    registerVideo(clip.id, el, clip);
    if (!isCrossOriginAudio) {
      registerSource(clip.id, clip.trackId, el, clip.audio);
    }
    return () => {
      unregisterVideo(clip.id);
      if (!isCrossOriginAudio) unregisterSource(clip.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, isCrossOriginAudio]);

  // O engine guarda um SNAPSHOT do clip no registro (deps acima não incluem
  // velocidade/trim). Quando a velocidade ou os pontos de corte mudam, empurra
  // o snapshot novo SEM re-anexar o <video> — assim o preview reflete a nova
  // velocidade (`video.playbackRate`) e o tempo esperado no asset.
  useEffect(() => {
    updateClip(clip.id, clip);
  }, [
    updateClip,
    clip,
    clip.id,
    clip.playbackRate,
    clip.startInAsset,
    clip.endInAsset,
    clip.startInTimeline,
    clip.endInTimeline,
  ]);

  // Registro no MediaController: cuida do lifecycle de carregamento,
  // retry com backoff e refresh do URL do Storage. O controller eh quem
  // seta `video.src` (por isso o JSX abaixo NAO usa o atributo `src`).
  // CORS so e necessario quando o chroma key le pixels do <video> (texImage2D/
  // getImageData). O hook aplica o atributo ANTES do load e refetcha ao mudar.
  const needsCors =
    clip.chromaKey?.enabled === true && !(resolved?.isObjectUrl ?? false);
  useMediaElement(asset, videoRef, {
    clipId: clip.id,
    initialUrl: resolved?.url ?? null,
    crossOrigin: needsCors ? 'anonymous' : undefined,
  });

  // Quando usamos áudio nativo (cross-origin), sync clip.audio direto no element.
  useEffect(() => {
    if (!isCrossOriginAudio) return;
    const el = videoRef.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, clip.audio.volume));
    el.muted = clip.audio.muted;
  }, [
    isCrossOriginAudio,
    clip.audio.volume,
    clip.audio.muted,
  ]);

  const active = isClipActive(clip.id);

  // Estado de transição (incoming/outgoing) para o instante atual do
  // playhead. Retorna `null` quando o clip não está em janela de transição.
  const playheadSec = useEditorStore((s) => s.ui.playhead);
  const transitionState = useTransitionState(clip, playheadSec);

  // Dois níveis de style:
  //  - `outerStyle`: a CAIXA da banda do slot (top/height via `slotBox`) com
  //    `overflow:hidden` — é o viewport que recorta o slot. Carrega o zIndex.
  //  - `innerStyle`: o transform do usuário (translate/scale/rotate), filtros,
  //    opacidade e clip-path de transição — aplicados DENTRO da banda.
  // A mídia (`<video>`) usa `object-fit` (`clip.fit`) para encaixar na caixa.
  const { outerStyle, innerStyle } = useMemo(() => {
    const t = clip.transform;
    const baseTransform = buildTransform(t);

    // Quando há transição ativa: combina overlay com base.
    const finalTransform = transitionState
      ? mergeTransform(baseTransform, transitionState.transform)
      : baseTransform;
    const finalOpacity =
      (active ? t.opacity : 0) * (transitionState?.opacity ?? 1);

    const box = slotBox(isInSlot, splitRatio);
    const outer: React.CSSProperties = {
      position: 'absolute',
      left: 0,
      right: 0,
      top: box.top,
      height: box.height,
      zIndex: zIndex + (transitionState?.zIndex ?? 0),
      overflow: 'hidden',
      pointerEvents: 'none',
    };
    const inner: React.CSSProperties = {
      opacity: finalOpacity,
      transform: finalTransform,
      transformOrigin: `${t.anchorX * 100}% ${t.anchorY * 100}%`,
      filter: buildFilter(clip.filters),
      // clipPath: só transição (wipe/circle). O recorte do slot é a própria
      // caixa da banda (outer + overflow:hidden), não mais um clip-path.
      clipPath: transitionState?.clipPath,
      // Garante composição em GPU para evitar repaints durante playback.
      willChange: 'transform, opacity, filter',
    };
    return { outerStyle: outer, innerStyle: inner };
  }, [
    clip.transform,
    clip.filters,
    zIndex,
    active,
    isInSlot,
    splitRatio,
    transitionState,
  ]);

  if (!resolved) {
    // Asset sem URL nem File local — não há o que renderizar.
    return null;
  }

  const chromaActive = clip.chromaKey?.enabled === true;
  const chromaEngine = clip.chromaKey?.engine ?? 'webgl';
  // Encaixe da mídia na caixa: 'cover' preenche (corta excesso), 'contain'
  // mostra o vídeo inteiro (barras). Default 'contain' (nunca corta).
  const objectFit = clip.fit ?? 'contain';

  return (
    <div
      className={className}
      style={outerStyle}
      data-layer="video"
      data-clip-id={clip.id}
    >
      <div className="absolute inset-0" style={innerStyle}>
        <video
          ref={videoRef}
          // src eh setado pelo MediaController (via useMediaElement) — NAO
          // usar atributo `src` aqui pra evitar conflito com refresh de URL.
          playsInline
          // NÃO mutado — quando o Web Audio mixer consegue ligar via
          // createMediaElementSource, ele redireciona o áudio (spec); caso
          // a integração falhe (CORS/policy), o áudio toca nativamente pelo
          // elemento. Em ambos casos o usuário escuta som.
          // crossOrigin (pra texImage2D/getImageData do chroma) e aplicado pelo
          // useMediaElement ANTES do load — NAO no JSX, senao mudaria sem reload.
          preload="auto"
          className="h-full w-full"
          style={{ objectFit, visibility: chromaActive ? 'hidden' : 'visible' }}
        />
        {chromaActive && clip.chromaKey && chromaEngine === 'canvas2d' && (
          <ChromaKeyCanvas2D videoRef={videoRef} chromaKey={clip.chromaKey} />
        )}
        {chromaActive && clip.chromaKey && chromaEngine !== 'canvas2d' && (
          <ChromaKeyWebGL videoRef={videoRef} chromaKey={clip.chromaKey} />
        )}
      </div>
    </div>
  );
}

