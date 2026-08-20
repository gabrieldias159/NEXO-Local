'use client';

/**
 * Seção "Aperto de tela" da tab Transições (recurso 6 do fluxo do gabinete).
 *
 * O rabo de cada bloco gravado no celular termina com a mão apertando a tela.
 * Aqui se decide o corte OLHANDO os últimos instantes do clip: 3 thumbnails
 * (−0,75s / −0,45s / −0,15s do fim), um campo "cortar final (s)" e o botão
 * que corta e PUXA todo o resto da timeline (ripple), mais o botão que aplica
 * xfade de 0,3s em todas as junções da faixa (vídeo + acrossfade de áudio no
 * export; o preview aproxima a emenda com fade).
 */

import * as React from 'react';
import type { Clip } from '@/lib/editor/types';
import { useEditorStore } from '@/lib/editor/store';
import { resolveAssetUrl } from '@/lib/editor/preview-utils';
import { InspectorSection } from '../controls/InspectorSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Scissors, Blend } from 'lucide-react';

/** Offsets (s antes do fim, em tempo de TIMELINE) dos 3 thumbnails. */
const THUMB_OFFSETS = [0.75, 0.45, 0.15];

export function TailTrimSection({ clip }: { clip: Clip }) {
  const { toast } = useToast();
  const asset = useEditorStore((s) =>
    s.project?.assets.find((a) => a.id === clip.assetId),
  );
  const trimClipTail = useEditorStore((s) => s.trimClipTail);
  const applyCrossfadeAtJunctions = useEditorStore(
    (s) => s.applyCrossfadeAtJunctions,
  );

  const [cutSec, setCutSec] = React.useState('0.5');
  const clipDur = clip.endInTimeline - clip.startInTimeline;

  const handleCut = () => {
    const v = Number(cutSec.replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0) return;
    const ok = trimClipTail(clip.id, v);
    toast(
      ok
        ? {
            title: `Cortado ${v.toFixed(2).replace('.', ',')}s do fim`,
            description: 'Todo o resto da timeline foi puxado junto (Ctrl+Z desfaz).',
          }
        : {
            title: 'Corte não coube',
            description: `O clip tem ${clipDur.toFixed(2)}s — o corte precisa ser menor.`,
            variant: 'destructive',
          },
    );
  };

  const handleXfade = () => {
    const n = applyCrossfadeAtJunctions(clip.trackId, 0.3);
    toast(
      n > 0
        ? {
            title: `Xfade 0,3s em ${n} junção(ões)`,
            description:
              'No export vira xfade de vídeo + acrossfade de áudio. No preview a emenda aparece como fade.',
          }
        : {
            title: 'Nenhuma junção adjacente na faixa',
            description:
              'O xfade pega pares de clips consecutivos colados (camada 0).',
          },
    );
  };

  return (
    <InspectorSection title="Aperto de tela (fim do clipe)">
      <div className="space-y-2">
        {asset?.type === 'video' ? (
          <TailThumbs clip={clip} assetUrlKey={asset.downloadUrl} />
        ) : (
          <p className="text-[10px] text-muted-foreground">
            Thumbnails do fim só para clips de vídeo.
          </p>
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Cortar final (s)
            </label>
            <Input
              value={cutSec}
              onChange={(e) => setCutSec(e.target.value)}
              inputMode="decimal"
              className="h-7 text-[11px] tabular-nums"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-[11px]"
            onClick={handleCut}
            disabled={clip.locked}
            title="Tira o rabo do clipe — o apertozinho de tela do fim — e puxa tudo que vem depois, sem deixar buraco."
          >
            <Scissors className="h-3 w-3" />
            Cortar e puxar
          </Button>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 w-full gap-1 text-[11px]"
          onClick={handleXfade}
          title="Emenda os cortes com um dissolve de 0,3 s na imagem e no som — some com o pulo seco entre um trecho e outro."
        >
          <Blend className="h-3 w-3" />
          Xfade 0,3s nas junções da faixa
        </Button>
      </div>
    </InspectorSection>
  );
}

/**
 * 3 thumbnails dos últimos instantes do clip, capturados de um `<video>`
 * oculto (seek sequencial). Regenera quando o fim do clip muda (após um
 * corte, os thumbs mostram o novo fim).
 */
function TailThumbs({
  clip,
  assetUrlKey,
}: {
  clip: Clip;
  assetUrlKey: string;
}) {
  const asset = useEditorStore((s) =>
    s.project?.assets.find((a) => a.id === clip.assetId),
  );
  const canvasRefs = React.useRef<Array<HTMLCanvasElement | null>>([]);
  const [erro, setErro] = React.useState(false);

  const rate = clip.playbackRate || 1;
  const endInAsset = clip.endInAsset;

  React.useEffect(() => {
    if (!asset) return;
    const resolved = resolveAssetUrl(asset);
    if (!resolved) return;
    let cancelled = false;
    setErro(false);

    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.src = resolved.url;

    const seekAndDraw = (assetTime: number, slot: number) =>
      new Promise<void>((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          if (cancelled) return resolve();
          const canvas = canvasRefs.current[slot];
          if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx && video.videoWidth > 0) {
              canvas.width = 160;
              canvas.height = Math.round(
                (video.videoHeight / video.videoWidth) * 160,
              );
              try {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              } catch {
                setErro(true);
              }
            }
          }
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = Math.max(0, assetTime);
      });

    const run = async () => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 15000);
        video.onloadedmetadata = () => {
          clearTimeout(t);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(t);
          reject(new Error('erro no vídeo'));
        };
      });
      for (let i = 0; i < THUMB_OFFSETS.length; i += 1) {
        if (cancelled) return;
        // Offset em tempo de timeline → tempo de asset (velocidade conta).
        const t = endInAsset - THUMB_OFFSETS[i] * rate;
        await seekAndDraw(t, i);
      }
    };

    run().catch(() => {
      if (!cancelled) setErro(true);
    });

    return () => {
      cancelled = true;
      if (resolved.isObjectUrl) URL.revokeObjectURL(resolved.url);
      video.removeAttribute('src');
      video.load();
    };
    // assetUrlKey força regeneração se a URL do asset trocar (upload concluiu).
  }, [asset, endInAsset, rate, assetUrlKey]);

  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        Últimos instantes do clip
      </p>
      <div className="grid grid-cols-3 gap-1">
        {THUMB_OFFSETS.map((off, i) => (
          <figure key={off} className="space-y-0.5">
            <canvas
              ref={(el) => {
                canvasRefs.current[i] = el;
              }}
              className="w-full rounded border border-border bg-black"
            />
            <figcaption className="text-center text-[9px] tabular-nums text-muted-foreground">
              −{off.toFixed(2).replace('.', ',')}s
            </figcaption>
          </figure>
        ))}
      </div>
      {erro && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          Não deu para capturar os frames (mídia ainda subindo?).
        </p>
      )}
    </div>
  );
}
