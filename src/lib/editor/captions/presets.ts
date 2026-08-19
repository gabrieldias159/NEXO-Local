/**
 * Presets de estilo de legenda (estilo "Caption Video" do Adobe Express).
 *
 * Cada preset é um `Partial<CaptionStyle>` aplicado por cima do estilo atual
 * via `onChange` no `CaptionStyleEditor`. Não muda tipos nem pipeline — só
 * combinações prontas de fonte/cor/contorno/fundo/sombra/posição.
 *
 * Todos os campos usados aqui já existem no `CaptionStyle` (incluindo os
 * aditivos opcionais `textTransform`/`letterSpacing`/`lineHeight`/`maxWidthPct`),
 * então presets são 100% retrocompatíveis.
 *
 * Sem IA, sem dependências externas.
 */

import type { CaptionStyle } from '../types';

/**
 * Estilo "Gabinete" — reproduz a legenda aprovada da produção real
 * (ago/2026): Arial bold amarela #FFFF00, contorno preto, sombra leve,
 * MAIÚSCULAS, subida de ~9,5% do rodapé (equivale ao MarginV 112 @ 478x850
 * do ASS aprovado). Valores em px @1080 de altura (semântica do editor).
 */
export const GABINETE_CAPTION_STYLE: Partial<CaptionStyle> = {
  fontFamily: 'Arial',
  fontWeight: 700,
  fontSize: 34,
  color: '#FFFF00',
  backgroundColor: '#00000000',
  outlineColor: '#000000',
  outlineWidth: 4,
  shadowColor: '#00000069',
  shadowBlur: 4,
  align: 'center',
  position: 'bottom',
  offsetY: -9.5,
  paddingX: 0,
  paddingY: 0,
  borderRadius: 0,
  textTransform: 'uppercase',
  letterSpacing: 0,
  maxWidthPct: 96,
};

export interface CaptionPreset {
  /** Identificador estável. */
  id: string;
  /** Rótulo pt-BR exibido no chip. */
  label: string;
  /** Patch aplicado sobre o estilo atual do(s) cue(s). */
  style: Partial<CaptionStyle>;
}

/**
 * Galeria de presets. O primeiro ("Clássico") reproduz o default atual.
 * A ordem aqui é a ordem de exibição na grade de chips.
 */
export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: 'gabinete',
    label: 'Gabinete',
    style: { ...GABINETE_CAPTION_STYLE },
  },
  {
    id: 'classico',
    label: 'Clássico',
    style: {
      fontFamily: 'Inter',
      fontWeight: 600,
      color: '#FFFFFF',
      backgroundColor: '#000000B3',
      outlineColor: undefined,
      outlineWidth: 0,
      shadowColor: undefined,
      shadowBlur: 0,
      borderRadius: 4,
      paddingX: 12,
      paddingY: 4,
      textTransform: 'none',
      letterSpacing: 0,
    },
  },
  {
    id: 'caixa-preta',
    label: 'Caixa preta',
    style: {
      fontFamily: 'Inter',
      fontWeight: 700,
      color: '#FFFFFF',
      backgroundColor: '#000000E6',
      outlineColor: undefined,
      outlineWidth: 0,
      shadowColor: undefined,
      shadowBlur: 0,
      borderRadius: 6,
      paddingX: 16,
      paddingY: 6,
      textTransform: 'none',
    },
  },
  {
    id: 'contorno-forte',
    label: 'Contorno',
    style: {
      fontFamily: 'Inter',
      fontWeight: 700,
      color: '#FFFFFF',
      backgroundColor: '#00000000',
      outlineColor: '#000000',
      outlineWidth: 6,
      shadowColor: undefined,
      shadowBlur: 0,
      paddingX: 0,
      paddingY: 0,
      borderRadius: 0,
      textTransform: 'none',
    },
  },
  {
    id: 'amarelo',
    label: 'Amarelo legenda',
    style: {
      fontFamily: 'Arial',
      fontWeight: 700,
      color: '#FFD400',
      backgroundColor: '#00000000',
      outlineColor: '#000000',
      outlineWidth: 5,
      shadowColor: '#000000',
      shadowBlur: 4,
      paddingX: 0,
      paddingY: 0,
      borderRadius: 0,
      textTransform: 'none',
    },
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    style: {
      fontFamily: 'Arial',
      fontWeight: 700,
      color: '#FFFFFF',
      backgroundColor: '#00000000',
      outlineColor: '#000000',
      outlineWidth: 8,
      shadowColor: '#000000',
      shadowBlur: 6,
      paddingX: 0,
      paddingY: 0,
      borderRadius: 0,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
  },
  {
    id: 'minimal',
    label: 'Minimal',
    style: {
      fontFamily: 'Inter',
      fontWeight: 500,
      color: '#FFFFFF',
      backgroundColor: '#00000000',
      outlineColor: undefined,
      outlineWidth: 0,
      shadowColor: '#000000B3',
      shadowBlur: 8,
      paddingX: 0,
      paddingY: 0,
      borderRadius: 0,
      textTransform: 'none',
    },
  },
  {
    id: 'impacto',
    label: 'Impacto',
    style: {
      fontFamily: 'Impact',
      fontWeight: 700,
      color: '#FFFFFF',
      backgroundColor: '#00000000',
      outlineColor: '#000000',
      outlineWidth: 6,
      shadowColor: '#000000',
      shadowBlur: 2,
      paddingX: 0,
      paddingY: 0,
      borderRadius: 0,
      textTransform: 'uppercase',
      letterSpacing: 1,
    },
  },
  {
    id: 'pastel',
    label: 'Pastel',
    style: {
      fontFamily: 'Georgia',
      fontWeight: 600,
      color: '#1F2937',
      backgroundColor: '#FDE68AE6',
      outlineColor: undefined,
      outlineWidth: 0,
      shadowColor: undefined,
      shadowBlur: 0,
      borderRadius: 12,
      paddingX: 16,
      paddingY: 6,
      textTransform: 'none',
    },
  },
  {
    id: 'neon',
    label: 'Neon',
    style: {
      fontFamily: 'Arial',
      fontWeight: 700,
      color: '#39FF14',
      backgroundColor: '#00000000',
      outlineColor: '#0A2E0A',
      outlineWidth: 2,
      shadowColor: '#39FF14',
      shadowBlur: 16,
      paddingX: 0,
      paddingY: 0,
      borderRadius: 0,
      textTransform: 'uppercase',
    },
  },
];
