'use client';

/**
 * Mini-waveform exibido dentro de clips em tracks de áudio.
 *
 * Estratégia:
 * - **Lazy mount via IntersectionObserver**: o waveform só é instanciado
 *   quando o clip entra no viewport da timeline. Isso evita travar a UI
 *   quando há muitos clips de áudio.
 * - **Lazy import de wavesurfer.js**: `await import('wavesurfer.js')` para
 *   não inflar o bundle inicial.
 * - **Cache de peaks em IndexedDB**: a primeira vez que processamos um
 *   asset, salvamos o array de peaks decodificados (Float32Array). Próximas
 *   instâncias reutilizam — render é instantâneo e não toca a rede.
 *
 * Visual:
 * - Cor do waveform: `--editor-track-a1` ou `--editor-accent-soft` (token de
 *   audio track). Altura limitada a `height` (passada pelo pai).
 * - Barras finas (`barWidth=1`, `barGap=1`) para parecer um waveform clássico.
 *
 * Cleanup:
 * - Em unmount, chama `wavesurfer.destroy()` para liberar AudioContext e
 *   listeners.
 */

import { useEffect, useRef, useState } from 'react';
import type { Clip, MediaAsset } from '@/lib/editor/types';

interface ClipWaveformProps {
  clip: Clip;
  asset: MediaAsset;
  /** Largura (px) total do clip. */
  width: number;
  /** Altura (px) que o waveform deve ocupar. */
  height: number;
}

// ---- Cache de peaks em IndexedDB -------------------------------------------

const DB_NAME = 'oe-editor-waveforms';
const DB_VERSION = 1;
const STORE = 'peaks';

/** Abre/cria o IndexedDB com store `peaks` (chave: assetId). */
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => resolve(null);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

async function getCachedPeaks(assetId: string): Promise<number[] | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.get(assetId);
      req.onsuccess = () => {
        const value = req.result as number[] | undefined;
        resolve(value ?? null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function setCachedPeaks(assetId: string, peaks: number[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.put(peaks, assetId);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// ---- Componente ------------------------------------------------------------

export function ClipWaveform({ clip, asset, width, height }: ClipWaveformProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Apenas para silenciar lint quando "clip" não for usado em runtime
  // (mantemos o prop pra futura customização — ex: highlight de range trim).
  void clip;

  const [inView, setInView] = useState(false);

  // Observa quando o container entra no viewport horizontal/vertical.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      // Fallback: assume in-view.
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            io.disconnect();
            return;
          }
        }
      },
      { threshold: 0.01 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, []);

  // Inicializa wavesurfer quando in-view e há src.
  useEffect(() => {
    if (!inView) return;
    const el = containerRef.current;
    if (!el) return;
    if (!asset.downloadUrl) return;

    let destroyed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ws: any = null;

    (async () => {
      try {
        // Lazy import — separa em chunk próprio.
        const mod = await import('wavesurfer.js');
        if (destroyed) return;
        const WaveSurfer = mod.default;

        const cached = await getCachedPeaks(asset.id);
        if (destroyed) return;

        ws = WaveSurfer.create({
          container: el,
          url: asset.downloadUrl,
          waveColor: 'var(--editor-track-a1, hsl(var(--editor-accent)))',
          progressColor: 'var(--editor-accent, hsl(var(--editor-accent)))',
          cursorWidth: 0,
          height: Math.max(8, Math.min(32, height)),
          barWidth: 1,
          barGap: 1,
          barRadius: 0.5,
          interact: false,
          normalize: true,
          ...(cached ? { peaks: [cached] } : {}),
        });

        // Quando decodificar pela primeira vez, persiste peaks em IDB.
        if (!cached) {
          ws.on('decode', () => {
            try {
              const peaks = ws.exportPeaks?.({ maxLength: 8000 });
              if (peaks && peaks.length > 0) {
                const arr = peaks[0];
                if (arr && arr.length > 0) {
                  void setCachedPeaks(asset.id, Array.from(arr));
                }
              }
            } catch {
              /* best-effort */
            }
          });
        }
      } catch {
        // Falha silenciosa: sem waveform, mantém placeholder.
      }
    })();

    return () => {
      destroyed = true;
      if (ws) {
        try {
          ws.destroy();
        } catch {
          /* noop */
        }
      }
    };
  }, [inView, asset.id, asset.downloadUrl, height]);

  return (
    <div
      ref={containerRef}
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0"
      style={{
        height: Math.max(8, Math.min(32, height)),
        width,
        opacity: 0.85,
      }}
    />
  );
}
