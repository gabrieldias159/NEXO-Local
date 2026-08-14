'use client';

/**
 * AssetPrefetcher — pré-carrega TODOS os vídeos do projeto em background.
 *
 * Problema que resolve: quando o usuário troca de clip na timeline ou
 * pula entre trechos, o `<video>` do `VideoLayer` precisa baixar/decodar
 * dados do zero, causando lag visível.
 *
 * Como funciona: monta um `<video preload="auto">` invisível por asset
 * de vídeo. O browser baixa e mantém em cache HTTP os bytes, então o
 * `VideoLayer` real reaproveita a mesma URL sem nova requisição (cache
 * hit) e a decodificação inicial é muito mais rápida.
 *
 * Custo: aumenta uso de memória/banda no startup. Pra projetos com
 * muitos assets pesados, considere limitar via prop `maxAssets` (default
 * 12) — assets além disso são pulados (já são raros pra suite editor).
 *
 * NOTA: não toca/exibe nada visível, então não interfere com a UI.
 */

import { useMemo, useEffect, useRef } from 'react';
import { useEditorStore } from '@/lib/editor/store';
import { resolveAssetUrl } from '@/lib/editor/preview-utils';

interface AssetPrefetcherProps {
  /** Máx de assets a pré-carregar (padrão 12). */
  maxAssets?: number;
}

export function AssetPrefetcher({ maxAssets = 12 }: AssetPrefetcherProps) {
  const assets = useEditorStore((s) => s.project?.assets ?? []);

  // Só pré-carrega vídeos com URL resolvível e source remoto (firebase ou http).
  // Blobs locais já estão em RAM, não precisam.
  const toPrefetch = useMemo(() => {
    const items: Array<{ id: string; url: string }> = [];
    for (const asset of assets) {
      if (items.length >= maxAssets) break;
      if (asset.type !== 'video') continue;
      const resolved = resolveAssetUrl(asset);
      if (!resolved || resolved.isObjectUrl) continue; // blob local: skip
      items.push({ id: asset.id, url: resolved.url });
    }
    return items;
  }, [assets, maxAssets]);

  // Guardamos refs para conseguir parar o preload no unmount sem
  // criar memory leaks de network requests pendentes.
  const refs = useRef<Map<string, HTMLVideoElement>>(new Map());

  useEffect(() => {
    return () => {
      // No unmount: cancela carregamentos pendentes liberando src.
      refs.current.forEach((el) => {
        try {
          el.src = '';
          el.removeAttribute('src');
          el.load();
        } catch {
          /* noop */
        }
      });
      refs.current.clear();
    };
  }, []);

  if (toPrefetch.length === 0) return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: -9999,
        top: -9999,
        width: 1,
        height: 1,
        overflow: 'hidden',
        opacity: 0,
        pointerEvents: 'none',
      }}
    >
      {toPrefetch.map((item) => (
        <video
          key={item.id}
          ref={(el) => {
            if (el) refs.current.set(item.id, el);
            else refs.current.delete(item.id);
          }}
          src={item.url}
          preload="auto"
          muted
          playsInline
          // Importante: NÃO autoplay. Só preload pra esquentar o cache.
        />
      ))}
    </div>
  );
}
