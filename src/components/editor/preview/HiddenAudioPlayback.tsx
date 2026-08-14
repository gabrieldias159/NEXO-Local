'use client';

/**
 * Reprodução invisível de clips em tracks de áudio.
 *
 * O `PreviewStage` só renderiza tracks de vídeo (porque é o palco visual).
 * Como os clips das tracks de áudio também precisam ter um elemento de mídia
 * para o `useVideoSync` (engine de sincronização) + `useAudioMixer` (Web
 * Audio) atuarem em cima, renderizamos aqui `<video>` ocultos
 * (`display:none`) para cada clip de áudio. O elemento ainda emite áudio
 * normalmente (seja via mixer Web Audio, seja nativamente caso a CORS
 * falhe na ligação).
 */

import { useEffect, useMemo, useRef } from 'react';
import { useVideoSync, useAudioMixer } from '@/lib/editor/playback';
import { resolveAssetUrl } from '@/lib/editor/preview-utils';
import { useEditorStore } from '@/lib/editor/store';
import type { Clip, MediaAsset } from '@/lib/editor/types';

function AudioPlaybackElement({ clip, asset }: { clip: Clip; asset: MediaAsset }) {
  const elRef = useRef<HTMLVideoElement>(null);
  const { registerVideo, updateClip, unregisterVideo } = useVideoSync();
  const { registerSource, unregisterSource } = useAudioMixer();

  const resolved = useMemo(() => resolveAssetUrl(asset), [asset]);

  // Cross-origin sem crossOrigin="anonymous" → Web Audio mute, usar nativo.
  const isCrossOriginAudio = useMemo(() => {
    if (!resolved || resolved.isObjectUrl) return false;
    try {
      const u = new URL(resolved.url, window.location.href);
      return u.origin !== window.location.origin;
    } catch {
      return false;
    }
  }, [resolved]);

  useEffect(() => {
    return () => {
      if (resolved?.isObjectUrl) URL.revokeObjectURL(resolved.url);
    };
  }, [resolved]);

  useEffect(() => {
    const el = elRef.current;
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

  // Mantém o snapshot do engine fresco quando velocidade/trim mudam, sem
  // re-anexar o elemento — assim o áudio reflete a nova velocidade no preview.
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

  useEffect(() => {
    if (!isCrossOriginAudio) return;
    const el = elRef.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, clip.audio.volume));
    el.muted = clip.audio.muted;
  }, [isCrossOriginAudio, clip.audio.volume, clip.audio.muted]);

  if (!resolved) return null;
  return (
    <video
      ref={elRef}
      src={resolved.url}
      preload="auto"
      playsInline
      style={{ width: 0, height: 0, position: 'absolute' }}
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}

export function HiddenAudioPlayback() {
  const tracks = useEditorStore((s) => s.project?.tracks ?? []);
  const assets = useEditorStore((s) => s.project?.assets ?? []);

  const items = useMemo(() => {
    const out: Array<{ clip: Clip; asset: MediaAsset }> = [];
    for (const t of tracks) {
      if (t.type !== 'audio') continue;
      if (t.muted) continue;
      for (const c of t.clips) {
        if (c.hidden) continue;
        const a = assets.find((x) => x.id === c.assetId);
        if (a) out.push({ clip: c, asset: a });
      }
    }
    return out;
  }, [tracks, assets]);

  if (items.length === 0) return null;
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        width: 0,
        height: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {items.map(({ clip, asset }) => (
        <AudioPlaybackElement key={clip.id} clip={clip} asset={asset} />
      ))}
    </div>
  );
}
