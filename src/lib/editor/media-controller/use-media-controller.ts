'use client';

/**
 * Hooks React do Media Controller.
 *
 * `useMediaElement` — registra um `<video>` no controller. O caller passa
 * o ref + asset + storage. O hook constroi o `urlProvider` que sabe re-buscar
 * o downloadURL via `getDownloadURL(storageRef(storage, asset.storagePath))`
 * quando o controller pede refresh (URLs do Storage podem expirar).
 */

import { useEffect } from 'react';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { useStorage } from '@/firebase';
import type { MediaAsset } from '@/lib/editor/types';
import { getMediaController } from './controller';
import type { UrlProvider } from './types';

/**
 * Conecta um `<video>` ao MediaController. Use em conjunto com (nao no lugar de)
 * o registro do useVideoSync — o controller cuida apenas do lifecycle de
 * carregamento; sync de playhead/timeline continua com o agente A.
 *
 * IMPORTANTE: O controller eh quem seta `video.src`. Nao passe `src=...` no
 * JSX do `<video>` — o React iria sobrescrever a cada render. Em vez disso,
 * deixe o atributo omitido e o controller atribuira via `videoEl.src = ...`.
 */
export function useMediaElement(
  asset: MediaAsset | null | undefined,
  videoRef: React.RefObject<HTMLVideoElement>,
  options?: {
    clipId?: string;
    initialUrl?: string | null;
    crossOrigin?: 'anonymous' | 'use-credentials';
  },
): void {
  const storage = useStorage();

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !asset?.id) return;

    const controller = getMediaController();

    // crossOrigin precisa estar no elemento ANTES do controller chamar load()
    // (o atributo so vale na hora do fetch). O hook e a UNICA fonte do atributo
    // — o JSX nao o seta, senao o React poderia reescrever sem reload. Mudar
    // crossOrigin entra nas deps -> re-attach -> load() refetcha com CORS novo.
    el.crossOrigin = options?.crossOrigin ?? null;

    // Constroi o provider de URL. Estrategia:
    //   1. Asset com `storagePath` → getDownloadURL fresca (renovavel).
    //   2. Asset com `downloadUrl` (blob: ou https direto) → usa direto.
    //   3. options.initialUrl como fallback (compat com fluxo antigo).
    //   4. null → controller desiste.
    const urlProvider: UrlProvider = async () => {
      if (asset.storagePath && storage) {
        try {
          const fresh = await getDownloadURL(
            storageRef(storage, asset.storagePath),
          );
          return fresh;
        } catch (err) {
          // Se Storage falhar, cai pro downloadUrl em cache (pode ainda servir).
          console.warn(
            '[media-controller] getDownloadURL falhou — fallback p/ downloadUrl em cache',
            err,
          );
        }
      }
      return asset.downloadUrl ?? options?.initialUrl ?? null;
    };

    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await controller.attach({
        assetId: asset.id,
        clipId: options?.clipId,
        videoEl: el,
        urlProvider,
      });
    })();

    return () => {
      cancelled = true;
      // Detacha pela MESMA chave usada no attach (clipId; fallback assetId
      // apenas se o clipId estiver ausente). Keyar por clipId evita que
      // desmontar um clip detache o slot que o gemeo (mesmo asset) ainda usa.
      controller.detach(options?.clipId ?? asset.id);
    };
    // Reanexa quando o asset.id/storagePath muda (URL diferente) OU quando o
    // crossOrigin muda (chroma ligado/desligado) — pra refetchar com/sem CORS.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.id, asset?.storagePath, asset?.downloadUrl, options?.clipId, options?.crossOrigin]);
}
