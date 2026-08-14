'use client';

/**
 * Linhas verticais que aparecem durante drag/trim quando o snap está ativo.
 *
 * São desenhadas absolutamente sobre as tracks, sem capturar pointer events
 * (pointer-events-none), do topo ao fim da área de tracks.
 *
 * Visual:
 * - 1px de largura, cor `--editor-accent`.
 * - Linha "highlighted" (alvo atual do snap) tem opacidade 100% + glow leve.
 * - Demais linhas (candidatos próximos) ficam em 35% opacidade — referência
 *   visual sutil.
 * - Fade-in/out em 100ms quando o conjunto de guides aparece/some.
 *
 * O componente lê seu próprio store (`useSnapGuidesStore`) para evitar
 * "prop drilling" através de `Timeline -> Track -> Clip -> hooks`.
 */

import { useSnapGuidesStore } from './hooks/snap-guides-store';

interface SnapGuidesProps {
  /** px/s. */
  zoom: number;
  /** Altura total (px) da área de tracks (cobre todas as tracks). */
  height: number;
}

export function SnapGuides({ zoom, height }: SnapGuidesProps) {
  const active = useSnapGuidesStore((s) => s.active);
  const positions = useSnapGuidesStore((s) => s.positions);
  const highlighted = useSnapGuidesStore((s) => s.highlighted);

  if (!active || positions.length === 0) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        height,
        // Fade-in/out via CSS.
        opacity: active ? 1 : 0,
        transition: 'opacity 100ms ease-out',
      }}
    >
      {positions.map((sec, idx) => {
        const isHighlight = highlighted !== null && Math.abs(sec - highlighted) < 0.001;
        const left = sec * zoom;
        return (
          <div
            key={`${sec}-${idx}`}
            className="absolute top-0 bottom-0 w-px"
            style={{
              left,
              height,
              backgroundColor: isHighlight
                ? 'var(--editor-accent)'
                : 'var(--editor-accent-soft, hsl(var(--editor-accent) / 0.5))',
              opacity: isHighlight ? 0.95 : 0.35,
              boxShadow: isHighlight
                ? '0 0 6px 1px var(--editor-accent), 0 0 1px var(--editor-accent)'
                : 'none',
            }}
          />
        );
      })}
    </div>
  );
}
