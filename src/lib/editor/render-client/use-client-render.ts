/**
 * Hook React que orquestra o render client-side.
 *
 * Fluxo:
 *  1. Coleta assets em uso pelo projeto.
 *  2. Faz fetch dos blobs (suporta `local-blob` URLs e `firebase` downloads).
 *  3. Inicializa o Worker (lazy), monta args via `buildClientRenderInput`.
 *  4. Roda `client.render(...)` e retorna um Blob.
 *  5. Atualiza `progress` em tempo real e expõe `cancel()` para abortar.
 *
 * O hook NÃO faz download nem upload — quem chama é responsável por persistir
 * o Blob (ex: criar `URL.createObjectURL` e disparar `<a download>`).
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExportSettings, VideoProject } from '@/lib/editor/types';
import {
  buildClientRenderInput,
  type ClientRenderInput,
} from './build-client-args';
import {
  createFFmpegRenderClient,
  type FFmpegRenderClient,
} from './ffmpeg-worker-client';

// ============================================================================
// Tipos
// ============================================================================

export interface UseClientRenderResult {
  render: (project: VideoProject, settings: ExportSettings) => Promise<Blob>;
  isRendering: boolean;
  progress: number;
  /** Última mensagem de erro (limpa quando um novo render começa). */
  error: string | null;
  /** Aborta o render atual destruindo o worker. */
  cancel: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useClientRender(): UseClientRenderResult {
  const clientRef = useRef<FFmpegRenderClient | null>(null);
  const cancelledRef = useRef(false);

  const [isRendering, setIsRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Limpa o worker ao desmontar
  useEffect(() => {
    return () => {
      if (clientRef.current) {
        clientRef.current.destroy();
        clientRef.current = null;
      }
    };
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (clientRef.current) {
      clientRef.current.destroy();
      clientRef.current = null;
    }
    setIsRendering(false);
    setProgress(0);
  }, []);

  const render = useCallback(
    async (project: VideoProject, settings: ExportSettings): Promise<Blob> => {
      cancelledRef.current = false;
      setError(null);
      setProgress(0);
      setIsRendering(true);

      try {
        // 1. Coleta assets usados (em ordem determinística para ter index estável)
        const usedAssets = collectUsedAssets(project);

        // 2. Faz download/leitura de cada blob
        const assetBlobs = await Promise.all(
          usedAssets.map(async (a, i) => {
            if (cancelledRef.current) {
              throw new Error('Render cancelado');
            }
            const blob = await fetchAssetBlob(a.downloadUrl);
            return { assetId: a.id, blob, index: i };
          }),
        );

        if (cancelledRef.current) throw new Error('Render cancelado');

        // 3. Constroi os args do FFmpeg
        const renderInput: ClientRenderInput = await buildClientRenderInput({
          project,
          assetBlobs,
          exportSettings: settings,
        });

        // 4. Inicializa o worker (lazy) e dispara render
        if (!clientRef.current) {
          clientRef.current = createFFmpegRenderClient();
        }
        const client = clientRef.current;
        await client.init();

        if (cancelledRef.current) throw new Error('Render cancelado');

        const blob = await client.render(
          { ...renderInput, outputMime: renderInput.outputMime },
          (pct) => {
            if (!cancelledRef.current) setProgress(pct);
          },
        );

        setProgress(100);
        return blob;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setIsRendering(false);
      }
    },
    [],
  );

  return { render, isRendering, progress, error, cancel };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Coleta assets usados pelos clips visíveis (em ordem determinística).
 */
function collectUsedAssets(
  project: VideoProject,
): VideoProject['assets'] {
  const idsInUse = new Set<string>();
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.hidden) continue;
      idsInUse.add(c.assetId);
    }
  }
  // Mantém a ordem original dos assets (estável entre renders).
  return project.assets.filter((a) => idsInUse.has(a.id));
}

/**
 * Faz fetch de um asset.
 *
 * - `blob:` URL → fetch direto (cria do próprio browser).
 * - `https://` URL (Firebase Storage com token) → fetch + arrayBuffer.
 *
 * NOTA: para Firebase Storage, depende de CORS configurado em `cors.json`.
 */
async function fetchAssetBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Falha ao baixar asset (${res.status} ${res.statusText})`);
  }
  return res.blob();
}
