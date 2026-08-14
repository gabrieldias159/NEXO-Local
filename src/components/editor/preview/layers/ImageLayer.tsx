'use client';

/**
 * Layer de preview para clips de imagem.
 *
 * Idêntico em estrutura ao `VideoLayer`, mas:
 * - Não cria `<video>` nem registra no `useVideoSync` / `useAudioMixer`.
 * - O "ativo" é determinado puramente pelo playhead vs. start/end do clip
 *   — passado via prop `isActive` (resolvido em `PreviewStage`).
 *
 * Aplica os mesmos transforms, filtros e `clip-path` para split-screen.
 */

import { useEffect, useMemo } from 'react';
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

interface ImageLayerProps {
  clip: Clip;
  asset: MediaAsset;
  /** Se o playhead atual está dentro do clip. */
  isActive: boolean;
  /** Z-index do layer (track index). */
  zIndex: number;
  /** Slot efetivo (`full | top | bottom`). */
  isInSlot?: 'full' | 'top' | 'bottom';
  /** Razão do split (0..1). */
  splitRatio?: number;
  className?: string;
}

export function ImageLayer({
  clip,
  asset,
  isActive,
  zIndex,
  isInSlot = 'full',
  splitRatio = 0.5,
  className,
}: ImageLayerProps) {
  const resolved = useMemo(() => resolveAssetUrl(asset), [asset]);

  // Cleanup blob: URL se for object URL temporária.
  useEffect(() => {
    return () => {
      if (resolved?.isObjectUrl) {
        URL.revokeObjectURL(resolved.url);
      }
    };
  }, [resolved]);

  const playheadSec = useEditorStore((s) => s.ui.playhead);
  const transitionState = useTransitionState(clip, playheadSec);

  // Ver VideoLayer: outer = caixa da banda (viewport, overflow:hidden, zIndex);
  // inner = transform/filtros/opacidade do usuário; a `<img>` encaixa via
  // `object-fit` (`clip.fit`).
  const { outerStyle, innerStyle } = useMemo(() => {
    const t = clip.transform;
    const baseTransform = buildTransform(t);

    const finalTransform = transitionState
      ? mergeTransform(baseTransform, transitionState.transform)
      : baseTransform;
    const finalOpacity =
      (isActive ? t.opacity : 0) * (transitionState?.opacity ?? 1);

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
      clipPath: transitionState?.clipPath,
      willChange: 'transform, opacity, filter',
    };
    return { outerStyle: outer, innerStyle: inner };
  }, [
    clip.transform,
    clip.filters,
    zIndex,
    isActive,
    isInSlot,
    splitRatio,
    transitionState,
  ]);

  if (!resolved) return null;

  const objectFit = clip.fit ?? 'contain';

  return (
    <div
      className={className}
      style={outerStyle}
      data-layer="image"
      data-clip-id={clip.id}
    >
      <div className="absolute inset-0" style={innerStyle}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={resolved.url}
          alt={asset.name}
          draggable={false}
          className="h-full w-full"
          style={{ objectFit }}
        />
      </div>
    </div>
  );
}
