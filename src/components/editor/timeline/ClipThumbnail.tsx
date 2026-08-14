'use client';

/**
 * Thumbnail visual dentro de clips de vídeo/imagem.
 *
 * Comportamento:
 * - **Imagem**: usa `asset.downloadUrl` direto (`<img>`). Sem custo extra de
 *   geração.
 * - **Vídeo**:
 *   - Se o asset já tem `thumbnailUrl` definido, usa-o.
 *   - Caso contrário, gera lazy via `<video>` invisível + `<canvas>`:
 *     1. Cria `<video>` com `crossOrigin="anonymous"`, atribui src.
 *     2. Quando `loadeddata` dispara, seek para 1s (ou metade da duração se
 *        for menor que 1s).
 *     3. Após `seeked`, desenha o frame em canvas (160px de largura,
 *        proporção mantida) e gera `dataURL` via `canvas.toDataURL('image/jpeg', 0.7)`.
 *     4. Resolve a Promise. Cache em memória (Map<assetId, dataUrl>) para
 *        reutilizar entre renders e instâncias.
 * - **Áudio**: nunca renderiza thumbnail (waveform é separado, em `<ClipWaveform />`).
 *
 * Renderiza a thumb como background-image com `repeat-x` quando o clip é
 * largo o suficiente — efeito barato para sugerir "fita de filme". Pode ser
 * refinado para sprite real no futuro.
 *
 * Lazy: a geração só dispara quando o componente é montado, e cada asset é
 * processado uma única vez (cache é módulo-singleton).
 */

import { useEffect, useState } from 'react';
import type { Clip, MediaAsset } from '@/lib/editor/types';

interface ClipThumbnailProps {
  clip: Clip;
  asset: MediaAsset;
  /** Largura (px) total do clip na timeline. */
  width: number;
  /** Altura (px) da track. */
  height: number;
}

// ---- Cache de thumbnails geradas em memória --------------------------------

/** assetId -> dataURL (jpeg) ou null se geração falhou. */
const thumbCache = new Map<string, string | null>();

/** Promises em voo, para deduplicar geração concorrente. */
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Gera thumbnail JPEG (dataURL) a partir de um vídeo, capturando frame em ~1s.
 *
 * Usa apenas APIs do browser (HTMLVideoElement + Canvas2D). Nunca lança.
 */
async function generateVideoThumb(asset: MediaAsset): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  if (asset.type !== 'video') return null;

  return new Promise<string | null>((resolve) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    // Para blobs locais, crossOrigin é irrelevante; para Storage URLs, alguns
    // setups exigem CORS configurado. Em qualquer caso, falhamos silenciosamente.
    let settled = false;
    const cleanup = () => {
      try {
        video.src = '';
        video.load();
      } catch {
        /* noop */
      }
    };
    const finish = (data: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };

    video.addEventListener('error', () => finish(null), { once: true });
    video.addEventListener(
      'loadeddata',
      () => {
        try {
          const dur = isFinite(video.duration) ? video.duration : 1;
          const targetTime = Math.min(1, Math.max(0, dur / 2));
          video.currentTime = targetTime;
        } catch {
          finish(null);
        }
      },
      { once: true },
    );
    video.addEventListener(
      'seeked',
      () => {
        try {
          const w = 160;
          const ratio =
            video.videoWidth && video.videoHeight
              ? video.videoHeight / video.videoWidth
              : 0.5625; // 16:9 fallback
          const h = Math.max(40, Math.round(w * ratio));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return finish(null);
          ctx.drawImage(video, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          finish(dataUrl);
        } catch {
          finish(null);
        }
      },
      { once: true },
    );

    // Timeout defensivo: se em 5s nada acontecer, desiste.
    setTimeout(() => finish(null), 5000);

    try {
      video.src = asset.downloadUrl;
    } catch {
      finish(null);
    }
  });
}

/**
 * Resolve a thumbnail "definitiva" para um asset.
 *
 * Ordem de preferência:
 * 1. cache em memória (já gerada anteriormente);
 * 2. `asset.thumbnailUrl` (vinda do upload pipeline);
 * 3. para imagens: o próprio `downloadUrl`;
 * 4. para vídeo: gerada lazy via `<video>+canvas`.
 */
async function resolveThumb(asset: MediaAsset): Promise<string | null> {
  if (asset.type === 'audio') return null;

  if (thumbCache.has(asset.id)) {
    return thumbCache.get(asset.id) ?? null;
  }
  if (asset.thumbnailUrl) {
    thumbCache.set(asset.id, asset.thumbnailUrl);
    return asset.thumbnailUrl;
  }
  if (asset.type === 'image') {
    thumbCache.set(asset.id, asset.downloadUrl);
    return asset.downloadUrl;
  }
  // video → gera (deduplica via inFlight).
  const existing = inFlight.get(asset.id);
  if (existing) return existing;
  const p = generateVideoThumb(asset).then((data) => {
    thumbCache.set(asset.id, data);
    inFlight.delete(asset.id);
    return data;
  });
  inFlight.set(asset.id, p);
  return p;
}

export function ClipThumbnail({ clip, asset, width, height }: ClipThumbnailProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(() => {
    // Se já tá em cache, evita um render "vazio".
    if (asset.type === 'audio') return null;
    if (thumbCache.has(asset.id)) return thumbCache.get(asset.id) ?? null;
    if (asset.thumbnailUrl) return asset.thumbnailUrl;
    if (asset.type === 'image') return asset.downloadUrl;
    return null;
  });

  useEffect(() => {
    if (asset.type === 'audio') return;
    if (thumbUrl) return;

    let cancelled = false;
    void resolveThumb(asset).then((data) => {
      if (cancelled) return;
      setThumbUrl(data);
    });
    return () => {
      cancelled = true;
    };
  }, [asset, thumbUrl]);

  if (asset.type === 'audio') return null;
  if (!thumbUrl) {
    // Placeholder discreto enquanto carrega.
    return (
      <div
        aria-hidden
        className="absolute inset-0 -z-0 opacity-30"
        style={{
          background:
            'repeating-linear-gradient(135deg, hsl(var(--muted)) 0 6px, hsl(var(--card)) 6px 12px)',
        }}
      />
    );
  }

  // Para clips largos, repete a thumb horizontalmente (efeito "sprite simples").
  // Largura aproximada de cada tile = altura da track * 16/9 (proporção 16:9
  // padrão). Para imagens, mantém uma única imagem fitted (cover).
  const tileWidth = Math.max(40, Math.round(height * (16 / 9)));
  const useRepeat = asset.type === 'video' && width > tileWidth * 1.5;

  return (
    <div
      aria-hidden
      className="absolute inset-0 -z-0 overflow-hidden opacity-70"
      style={{
        backgroundImage: `url(${thumbUrl})`,
        backgroundRepeat: useRepeat ? 'repeat-x' : 'no-repeat',
        backgroundSize: useRepeat ? `${tileWidth}px 100%` : 'cover',
        backgroundPosition: 'left center',
      }}
      // Inclui o clipId no DOM apenas para debug/devtools.
      data-clip-id={clip.id}
    />
  );
}
