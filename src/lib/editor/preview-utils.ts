/**
 * Utilidades de preview (puro / sem React).
 *
 * Inclui helpers para split-screen, resolução de URL de asset (com cleanup
 * de blob), e cálculo de transforms / filtros CSS a partir do modelo de
 * dados do editor.
 *
 * Mantemos este módulo livre de side-effects para poder ser usado em
 * SSR/testes.
 */

import type { Clip, ClipFilters, ClipTransform, MediaAsset, Track } from './types';

/**
 * Número efetivo de camadas (subtracks) de uma track de vídeo.
 *
 * É o máximo entre o `layerCount` declarado (default 1) e
 * `maxClipLayer + 1`, garantindo que nenhum clip com `layer` alto fique
 * fora da contagem (mesmo em projetos antigos sem `layerCount`).
 *
 * Tracks de áudio sempre retornam 1 (camadas não se aplicam a áudio).
 */
export function trackLayerCount(track: Track): number {
  if (track.type === 'audio') return 1;
  let maxLayer = 0;
  for (const c of track.clips) {
    const l = c.layer ?? 0;
    if (l > maxLayer) maxLayer = l;
  }
  return Math.max(track.layerCount ?? 1, maxLayer + 1);
}

/**
 * Filtra os clips de uma camada específica (`layer`). Clips sem `layer`
 * definido são tratados como camada 0.
 */
export function clipsInLayer(clips: Clip[], layer: number): Clip[] {
  return clips.filter((c) => (c.layer ?? 0) === layer);
}

/**
 * Calcula `clip-path` CSS para que um layer ocupe apenas a metade
 * superior/inferior do palco em modo split-vertical.
 *
 * Retorna string vazia (sem clip) quando slot é `'full'` ou indefinido.
 *
 * - `slot === 'top'`: corta a parte de baixo, deixando apenas (`splitRatio`).
 * - `slot === 'bottom'`: corta a parte de cima, deixando o restante.
 *
 * @param slot Slot vertical do clip (`'full' | 'top' | 'bottom'`).
 * @param splitRatio Razão do split (0..1). Default 0.5.
 */
export function clipPathForSlot(
  slot: 'full' | 'top' | 'bottom' | undefined,
  splitRatio = 0.5,
): string {
  if (!slot || slot === 'full') return '';
  const safe = Math.max(0.05, Math.min(0.95, splitRatio));
  const pct = safe * 100;
  if (slot === 'top') return `inset(0 0 ${100 - pct}% 0)`;
  if (slot === 'bottom') return `inset(${pct}% 0 0 0)`;
  return '';
}

/**
 * Calcula o `scale` + deslocamento `y` que "encaixam" um clip `object-contain`
 * (que por padrão preenche o palco inteiro) DENTRO da banda do slot top/bottom
 * em modo split-vertical, centralizado naquela banda.
 *
 * O layer é renderizado `absolute inset-0` sobre o palco inteiro e depois
 * recortado por `clipPathForSlot`. Sem ajuste, só apareceria a metade do
 * vídeo que cai na banda. Com este transform, o conteúdo é reduzido para a
 * altura da banda e transladado para o centro dela — assim o vídeo inteiro
 * cabe na camada (top ou bottom), respeitando o `splitRatio`.
 *
 * Matemática (origin de transform no centro do layer = centro do palco):
 * - Altura da banda top    = `splitRatio` da altura do palco → scale = splitRatio.
 * - Altura da banda bottom = `1 - splitRatio`                → scale = 1 - splitRatio.
 * - `translate(y * 100%)` usa a altura do layer (= palco) como 100%, então:
 *     top    → y = (splitRatio - 1) / 2   (sobe até o centro da banda superior)
 *     bottom → y = splitRatio / 2          (desce até o centro da banda inferior)
 *
 * Para `slot === 'full'` retorna o transform identidade (`scale: 1, y: 0`).
 *
 * @param slot Slot vertical do clip.
 * @param splitRatio Razão do split (0..1). Default 0.5.
 */
export function slotFitTransform(
  slot: 'full' | 'top' | 'bottom',
  splitRatio = 0.5,
): { scale: number; y: number } {
  const safe = Math.max(0.05, Math.min(0.95, splitRatio));
  if (slot === 'top') return { scale: safe, y: (safe - 1) / 2 };
  if (slot === 'bottom') return { scale: 1 - safe, y: safe / 2 };
  return { scale: 1, y: 0 };
}

/**
 * Caixa (viewport) que um clip ocupa no palco conforme o slot, em
 * porcentagens CSS prontas para `style`. O layer é posicionado/dimensionado
 * NESTA caixa e a mídia é encaixada dentro dela via `object-fit`
 * (`contain`/`cover`).
 *
 * Substitui o antigo esquema "layer no palco inteiro + `scale(splitRatio)` +
 * `clip-path`", que reduzia o vídeo uniformemente (largura E altura) e o
 * deixava pequeno/deslocado no meio da banda — o "encaixa errado". Agora a
 * banda É a caixa de layout e o `object-fit` faz o trabalho corretamente,
 * preenchendo a largura inteira da banda.
 *
 * - `'full'` (ou indefinido) → palco inteiro (`top 0`, `height 100%`).
 * - `'top'`    → faixa superior (altura = `splitRatio`).
 * - `'bottom'` → faixa inferior (altura = `1 - splitRatio`).
 */
export function slotBox(
  slot: 'full' | 'top' | 'bottom' | undefined,
  splitRatio = 0.5,
): { top: string; height: string } {
  if (!slot || slot === 'full') return { top: '0%', height: '100%' };
  const safe = Math.max(0.05, Math.min(0.95, splitRatio));
  if (slot === 'top') return { top: '0%', height: `${safe * 100}%` };
  return { top: `${safe * 100}%`, height: `${(1 - safe) * 100}%` };
}

/**
 * Resolve a URL para playback de um asset.
 *
 * Comportamento:
 * - Se `downloadUrl` existir, retorna `{ url, isObjectUrl: false }`.
 * - Senão, se houver `(asset as any).file` (File local sem upload), cria
 *   `URL.createObjectURL` e marca `isObjectUrl: true` para que o caller
 *   chame `URL.revokeObjectURL` no cleanup.
 * - Caso contrário, retorna `null`.
 *
 * O componente `VideoLayer`/`ImageLayer` é quem decide quando revogar
 * (ver `useEffect` cleanup).
 */
export function resolveAssetUrl(
  asset: MediaAsset,
): { url: string; isObjectUrl: boolean } | null {
  if (asset.downloadUrl) {
    return { url: asset.downloadUrl, isObjectUrl: false };
  }
  // Asset local sem upload: tenta `file` (não está na interface tipada,
  // mas pode existir em runtime no protótipo).
  const maybeFile = (asset as MediaAsset & { file?: File }).file;
  if (maybeFile instanceof File) {
    return { url: URL.createObjectURL(maybeFile), isObjectUrl: true };
  }
  return null;
}

/**
 * Constrói a string CSS `transform` a partir do `ClipTransform`.
 *
 * Layout:
 * - translate(x, y) — `x` e `y` são frações (-1..1) do slot.
 * - scale(scale)
 * - rotate(rotation deg)
 * - flipH/flipV via `scaleX/scaleY(-1)`.
 */
export function buildTransform(t: ClipTransform): string {
  const flipX = t.flipH ? -1 : 1;
  const flipY = t.flipV ? -1 : 1;
  return [
    `translate(${t.x * 100}%, ${t.y * 100}%)`,
    `scale(${t.scale})`,
    `rotate(${t.rotation}deg)`,
    `scaleX(${flipX})`,
    `scaleY(${flipY})`,
  ].join(' ');
}

/**
 * Constrói a string CSS `filter` a partir do `ClipFilters`.
 *
 * Defaults seguros para filtros opcionais (`hue`, `blur`, `grayscale`).
 */
export function buildFilter(f: ClipFilters): string {
  return [
    `brightness(${f.brightness})`,
    `contrast(${f.contrast})`,
    `saturate(${f.saturation})`,
    `hue-rotate(${f.hue ?? 0}deg)`,
    `blur(${f.blur ?? 0}px)`,
    `grayscale(${f.grayscale ?? 0})`,
  ].join(' ');
}

/**
 * Encontra o clip ativo (não escondido) na track que cobre `playheadSec`.
 *
 * Em caso de sobreposição, prioriza o clip cujo `startInTimeline` é maior
 * (mais recente) — comportamento NLE comum.
 */
export function findActiveClipAt(
  clips: Clip[],
  playheadSec: number,
): Clip | undefined {
  let best: Clip | undefined;
  for (const c of clips) {
    if (c.hidden) continue;
    if (
      playheadSec >= c.startInTimeline &&
      playheadSec < c.endInTimeline &&
      (!best || c.startInTimeline > best.startInTimeline)
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * Resolve o slot efetivo levando em conta o modo do palco.
 *
 * Em `stageMode === 'single'`, qualquer slot é tratado como `'full'`.
 */
export function effectiveSlot(
  clipSlot: 'full' | 'top' | 'bottom',
  stageMode: 'single' | 'split-vertical',
): 'full' | 'top' | 'bottom' {
  if (stageMode === 'single') return 'full';
  return clipSlot;
}
