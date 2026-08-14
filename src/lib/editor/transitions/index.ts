/**
 * Engine de transições do Suite Editor de Vídeos.
 *
 * Definições matemáticas das 14 transições suportadas (`TransitionType`).
 * Cada transição é descrita por:
 *
 * - `outgoing(progress)`: estado CSS do clip que está SAINDO no instante
 *   `progress` (0 = início da janela de transição, 1 = fim).
 * - `incoming(progress)`: estado CSS do clip que está ENTRANDO no instante
 *   `progress`.
 * - `ffmpegName`: nome do filtro `xfade` correspondente (server-side).
 *   Se não houver equivalente exato, usamos um fallback documentado abaixo.
 * - `label`, `category`, `preview`: metadados para a UI (gallery).
 *
 * Funções de easing são aplicadas pelo CALLER (ex: `useTransitionState`)
 * antes de invocar `outgoing`/`incoming`. Mantemos as definições aqui puras
 * (recebem `progress` linear) para serem testáveis e reutilizáveis em
 * qualquer pipeline.
 *
 * Mapeamento FFmpeg/xfade (filter `xfade=transition=…`):
 * - crossfade / fade → `fade`
 * - slide-left/right/up/down → `slideleft`/`slideright`/`slideup`/`slidedown`
 * - zoom-in → `circleopen` (aproximação visual)
 * - zoom-out → `circleclose` (aproximação visual)
 * - wipe-left/right → `wipeleft`/`wiperight`
 * - push-left/right → `smoothleft`/`smoothright`
 * - circle → `circleopen`
 * - iris → `circleopen` (igual a circle no FFmpeg padrão; visualmente
 *   diferente apenas no preview CSS — iris fecha pelo centro com elipse).
 *
 * Importante: performance.
 * - `useTransitionState` (consumidor principal) só invoca essas funções
 *   quando o playhead está dentro da janela de transição. Fora dela,
 *   nenhuma alocação acontece.
 */

import type { TransitionType } from '../types';

// ============================================================================
// Tipos
// ============================================================================

export interface TransitionState {
  /** Multiplicador de opacidade (0..1). */
  opacity: number;
  /** String CSS `transform` (ex: "translateX(-100%) scale(1.2)"). */
  transform: string;
  /** String CSS `clip-path` opcional. */
  clipPath?: string;
  /** String CSS `filter` opcional (raramente usado). */
  filter?: string;
  /** Z-index relativo ao baseline (somado ao zIndex do layer). */
  zIndex?: number;
}

export type TransitionFn = (progress: number) => TransitionState;

export type TransitionCategory = 'fade' | 'slide' | 'zoom' | 'wipe' | 'special';

export type TransitionPreviewKind =
  | 'fade'
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down'
  | 'zoom-in'
  | 'zoom-out'
  | 'wipe-left'
  | 'wipe-right'
  | 'push-left'
  | 'push-right'
  | 'circle'
  | 'iris';

export interface TransitionDefinition {
  outgoing: TransitionFn;
  incoming: TransitionFn;
  /** Nome do filtro xfade no FFmpeg para render server-side. */
  ffmpegName: string;
  /** Rótulo amigável (PT-BR) para a UI. */
  label: string;
  /** Categoria (para agrupar na gallery). */
  category: TransitionCategory;
  /** Variante visual da animação loop usada no card de preview. */
  preview: TransitionPreviewKind;
}

// ============================================================================
// Easing
// ============================================================================

export type EasingFn = (t: number) => number;

export const easings: Record<
  'linear' | 'ease-in' | 'ease-out' | 'ease-in-out',
  EasingFn
> = {
  linear: (t) => t,
  'ease-in': (t) => t * t,
  'ease-out': (t) => 1 - (1 - t) * (1 - t),
  'ease-in-out': (t) =>
    t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
};

/** Clampa progress para [0, 1] e protege contra NaN. */
export function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  if (progress < 0) return 0;
  if (progress > 1) return 1;
  return progress;
}

// ============================================================================
// Helpers internos
// ============================================================================

/** Retorna estado neutro (sem efeito visível). */
const NEUTRAL: TransitionState = {
  opacity: 1,
  transform: '',
};

/** Helper: opacity-only fade. */
function fadeOut(p: number): TransitionState {
  return { opacity: 1 - p, transform: '' };
}
function fadeIn(p: number): TransitionState {
  return { opacity: p, transform: '' };
}

/** Slide outgoing: o clip que sai vai para fora na direção indicada. */
function slideOutgoing(direction: 'left' | 'right' | 'up' | 'down'): TransitionFn {
  return (p) => {
    const dist = p * 100;
    let transform = '';
    switch (direction) {
      case 'left':
        transform = `translateX(${-dist}%)`;
        break;
      case 'right':
        transform = `translateX(${dist}%)`;
        break;
      case 'up':
        transform = `translateY(${-dist}%)`;
        break;
      case 'down':
        transform = `translateY(${dist}%)`;
        break;
    }
    return { opacity: 1, transform, zIndex: 1 };
  };
}

/**
 * Slide incoming clássico: o clip que entra parte de fora e desliza
 * para a posição final. Ele NÃO empurra o anterior — só sobrepõe.
 */
function slideIncoming(direction: 'left' | 'right' | 'up' | 'down'): TransitionFn {
  return (p) => {
    const dist = (1 - p) * 100;
    let transform = '';
    switch (direction) {
      case 'left':
        transform = `translateX(${dist}%)`;
        break;
      case 'right':
        transform = `translateX(${-dist}%)`;
        break;
      case 'up':
        transform = `translateY(${dist}%)`;
        break;
      case 'down':
        transform = `translateY(${-dist}%)`;
        break;
    }
    return { opacity: 1, transform, zIndex: 2 };
  };
}

/**
 * Push outgoing: igual ao slide outgoing, mas sincronizado com o incoming
 * de modo que pareça que um empurra o outro (z-index igual).
 */
function pushOutgoing(direction: 'left' | 'right'): TransitionFn {
  return (p) => {
    const dist = p * 100;
    const transform =
      direction === 'left'
        ? `translateX(${-dist}%)`
        : `translateX(${dist}%)`;
    return { opacity: 1, transform };
  };
}

function pushIncoming(direction: 'left' | 'right'): TransitionFn {
  return (p) => {
    const dist = (1 - p) * 100;
    const transform =
      direction === 'left'
        ? `translateX(${dist}%)`
        : `translateX(${-dist}%)`;
    return { opacity: 1, transform };
  };
}

/**
 * Wipe outgoing: o clip que sai é "apagado" progressivamente por
 * um inset clip-path que cresce a partir da borda oposta à direção.
 */
function wipeOutgoing(direction: 'left' | 'right'): TransitionFn {
  return (p) => {
    // Wipe-left = revela o novo a partir da direita, então o antigo
    // some pela esquerda primeiro. Na prática, cropamos o antigo.
    const cut = p * 100;
    const clipPath =
      direction === 'left'
        ? `inset(0 0 0 ${cut}%)`
        : `inset(0 ${cut}% 0 0)`;
    return { opacity: 1, transform: '', clipPath };
  };
}

function wipeIncoming(direction: 'left' | 'right'): TransitionFn {
  return (p) => {
    // Wipe-left: revela da esquerda → direita.
    const remaining = (1 - p) * 100;
    const clipPath =
      direction === 'left'
        ? `inset(0 ${remaining}% 0 0)`
        : `inset(0 0 0 ${remaining}%)`;
    return { opacity: 1, transform: '', clipPath, zIndex: 2 };
  };
}

/** Zoom-in: o novo cresce do nada cobrindo o velho (que desaparece em fade). */
function zoomInOutgoing(): TransitionFn {
  return (p) => ({ opacity: 1 - p, transform: `scale(${1 - p * 0.2})` });
}
function zoomInIncoming(): TransitionFn {
  return (p) => ({
    opacity: p,
    transform: `scale(${0.6 + p * 0.4})`,
    zIndex: 2,
  });
}

/** Zoom-out: o velho fica gigante e desaparece, revelando o novo. */
function zoomOutOutgoing(): TransitionFn {
  return (p) => ({
    opacity: 1 - p,
    transform: `scale(${1 + p * 0.6})`,
  });
}
function zoomOutIncoming(): TransitionFn {
  return (p) => ({
    opacity: p,
    transform: `scale(${1 - (1 - p) * 0.05})`,
  });
}

/**
 * Circle (abre): novo aparece através de um círculo crescente no centro.
 */
function circleOutgoing(): TransitionFn {
  return () => ({ opacity: 1, transform: '' });
}
function circleIncoming(): TransitionFn {
  return (p) => {
    // Raio do círculo em vmax (cobre o palco em ~70%).
    const radius = p * 75;
    return {
      opacity: 1,
      transform: '',
      // 50% 50% = centro do palco.
      clipPath: `circle(${radius}% at 50% 50%)`,
      zIndex: 2,
    };
  };
}

/**
 * Iris: como circle, mas usa elipse achatada (efeito mais cinematográfico).
 */
function irisOutgoing(): TransitionFn {
  return () => ({ opacity: 1, transform: '' });
}
function irisIncoming(): TransitionFn {
  return (p) => {
    const rx = p * 90;
    const ry = p * 60;
    return {
      opacity: 1,
      transform: '',
      clipPath: `ellipse(${rx}% ${ry}% at 50% 50%)`,
      zIndex: 2,
    };
  };
}

// ============================================================================
// Mapa principal
// ============================================================================

export const transitions: Record<TransitionType, TransitionDefinition> = {
  fade: {
    outgoing: fadeOut,
    incoming: fadeIn,
    ffmpegName: 'fade',
    label: 'Fade',
    category: 'fade',
    preview: 'fade',
  },
  crossfade: {
    outgoing: fadeOut,
    incoming: fadeIn,
    ffmpegName: 'fade',
    label: 'Crossfade',
    category: 'fade',
    preview: 'fade',
  },

  // Slides — sobrepõem (incoming z-index maior)
  'slide-left': {
    outgoing: slideOutgoing('left'),
    incoming: slideIncoming('left'),
    ffmpegName: 'slideleft',
    label: 'Slide Esquerda',
    category: 'slide',
    preview: 'slide-left',
  },
  'slide-right': {
    outgoing: slideOutgoing('right'),
    incoming: slideIncoming('right'),
    ffmpegName: 'slideright',
    label: 'Slide Direita',
    category: 'slide',
    preview: 'slide-right',
  },
  'slide-up': {
    outgoing: slideOutgoing('up'),
    incoming: slideIncoming('up'),
    ffmpegName: 'slideup',
    label: 'Slide Cima',
    category: 'slide',
    preview: 'slide-up',
  },
  'slide-down': {
    outgoing: slideOutgoing('down'),
    incoming: slideIncoming('down'),
    ffmpegName: 'slidedown',
    label: 'Slide Baixo',
    category: 'slide',
    preview: 'slide-down',
  },

  // Zooms
  'zoom-in': {
    outgoing: zoomInOutgoing(),
    incoming: zoomInIncoming(),
    // FFmpeg não tem "zoom-in" direto; circleopen é a melhor aproximação
    // (o novo aparece a partir do centro). Documentado como fallback.
    ffmpegName: 'circleopen',
    label: 'Zoom In',
    category: 'zoom',
    preview: 'zoom-in',
  },
  'zoom-out': {
    outgoing: zoomOutOutgoing(),
    incoming: zoomOutIncoming(),
    // Fallback: circleclose (o velho some "para dentro").
    ffmpegName: 'circleclose',
    label: 'Zoom Out',
    category: 'zoom',
    preview: 'zoom-out',
  },

  // Wipes
  'wipe-left': {
    outgoing: wipeOutgoing('left'),
    incoming: wipeIncoming('left'),
    ffmpegName: 'wipeleft',
    label: 'Wipe Esquerda',
    category: 'wipe',
    preview: 'wipe-left',
  },
  'wipe-right': {
    outgoing: wipeOutgoing('right'),
    incoming: wipeIncoming('right'),
    ffmpegName: 'wiperight',
    label: 'Wipe Direita',
    category: 'wipe',
    preview: 'wipe-right',
  },

  // Pushes — empurram visualmente
  'push-left': {
    outgoing: pushOutgoing('left'),
    incoming: pushIncoming('left'),
    ffmpegName: 'smoothleft',
    label: 'Push Esquerda',
    category: 'slide',
    preview: 'push-left',
  },
  'push-right': {
    outgoing: pushOutgoing('right'),
    incoming: pushIncoming('right'),
    ffmpegName: 'smoothright',
    label: 'Push Direita',
    category: 'slide',
    preview: 'push-right',
  },

  // Special — iris/circle
  circle: {
    outgoing: circleOutgoing(),
    incoming: circleIncoming(),
    ffmpegName: 'circleopen',
    label: 'Círculo',
    category: 'special',
    preview: 'circle',
  },
  iris: {
    outgoing: irisOutgoing(),
    incoming: irisIncoming(),
    // FFmpeg padrão não tem "iris" — usamos circleopen e o render
    // server-side perde a forma elíptica. Documentado.
    ffmpegName: 'circleopen',
    label: 'Iris',
    category: 'special',
    preview: 'iris',
  },
};

// ============================================================================
// Categorias / agrupamento (para gallery)
// ============================================================================

export const CATEGORY_LABEL: Record<TransitionCategory, string> = {
  fade: 'Fades',
  slide: 'Slides',
  zoom: 'Zooms',
  wipe: 'Wipes',
  special: 'Especiais',
};

/**
 * Agrupa todos os tipos de transição por categoria, preservando ordem
 * estável (a mesma do mapa `transitions`).
 */
export function getTransitionsByCategory(): Record<
  TransitionCategory,
  Array<{ type: TransitionType; def: TransitionDefinition }>
> {
  const groups: Record<
    TransitionCategory,
    Array<{ type: TransitionType; def: TransitionDefinition }>
  > = {
    fade: [],
    slide: [],
    zoom: [],
    wipe: [],
    special: [],
  };
  (Object.keys(transitions) as TransitionType[]).forEach((type) => {
    const def = transitions[type];
    groups[def.category].push({ type, def });
  });
  return groups;
}

// ============================================================================
// Resolver state — utilitário compartilhado
// ============================================================================

/**
 * Combina transform "base" do clip (vindo do `buildTransform`) com o
 * transform da transição. Como ambos usam unidades CSS, basta concatenar
 * com espaço.
 */
export function mergeTransform(base: string, overlay?: string): string {
  if (!overlay) return base;
  return `${base} ${overlay}`.trim();
}

/**
 * MIME types para drag & drop (aplicar transição arrastando o card para
 * uma junção de clips na timeline).
 */
export const TRANSITION_DRAG_MIME =
  'application/vnd.oficioexpresso.transition';
