'use client';

/**
 * Gerador de PNG para CLIPS DE TEXTO (asset sintético).
 *
 * O texto vira um PNG transparente desenhado em canvas (client-side) com a
 * largura do palco — assim o pipeline inteiro (preview via `ImageLayer`,
 * render server-side via overlay de imagem) funciona sem NENHUM caminho novo:
 * o clip de texto É um clip de imagem cujo arquivo sabemos regenerar a partir
 * do `TextAssetSpec` guardado no asset.
 *
 * Estilo do gabinete (caso de uso: IPTU / CONTA DE LUZ / ITBI empilhando com
 * som de erro): Arial Black, contorno grosso, sombra dura, tamanho automático
 * para caber em até `maxWidthPct`% da largura.
 */

import type { TextAssetSpec } from './types';

export const DEFAULT_TEXT_SPEC: TextAssetSpec = {
  content: '',
  fontFamily: 'Arial Black',
  color: '#FFFFFF',
  strokeColor: '#000000',
  strokePct: 12,
  shadow: true,
  maxWidthPct: 94,
};

/** Fator de super-amostragem (nitidez no render final). */
const OVERSAMPLE = 2;
/** Altura de linha em múltiplos do tamanho da fonte. */
const LINE_HEIGHT = 1.16;

export interface GeneratedTextPng {
  file: File;
  width: number;
  height: number;
}

/**
 * Desenha o `spec` num canvas com `stageWidth` px de largura (multiplicado
 * pelo oversample) e devolve um `File` PNG pronto para o `ingest`.
 *
 * O tamanho da fonte é AUTOMÁTICO: o maior que faz a linha mais larga caber
 * em `maxWidthPct`% da largura (limitado a 4%–30% da largura), a menos que
 * `fontSizePct` esteja definido.
 */
export async function generateTextPngFile(
  spec: TextAssetSpec,
  stageWidth: number,
): Promise<GeneratedTextPng> {
  const W = Math.max(64, Math.round(stageWidth)) * OVERSAMPLE;
  const lines = spec.content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error('Texto vazio — nada para desenhar.');
  }

  const family = spec.fontFamily || 'Arial Black';
  const fontOf = (px: number) => `${Math.round(px)}px "${family}", Arial, sans-serif`;

  // Mede a linha mais larga numa fonte de referência e escala.
  const probe = document.createElement('canvas');
  probe.width = 10;
  probe.height = 10;
  const pctx = probe.getContext('2d');
  if (!pctx) throw new Error('Canvas 2D indisponível.');
  const REF = 100;
  pctx.font = fontOf(REF);
  const widest = Math.max(...lines.map((l) => pctx.measureText(l).width), 1);

  const maxTextW = (W * Math.min(100, Math.max(10, spec.maxWidthPct))) / 100;
  let fontPx: number;
  if (spec.fontSizePct && spec.fontSizePct > 0) {
    fontPx = (W * spec.fontSizePct) / 100;
  } else {
    fontPx = (maxTextW / widest) * REF;
  }
  // Limites de sanidade (4%–30% da largura do palco).
  fontPx = Math.max(W * 0.04, Math.min(W * 0.3, fontPx));
  // Mesmo com tamanho manual, nunca estoura a largura máxima.
  if ((widest / REF) * fontPx > maxTextW) {
    fontPx = (maxTextW / widest) * REF;
  }

  const strokeW = (Math.max(0, spec.strokePct) / 100) * fontPx;
  const shadowOff = spec.shadow ? fontPx * 0.06 : 0;
  const lineH = fontPx * LINE_HEIGHT;
  const padY = Math.ceil(strokeW + shadowOff + fontPx * 0.18);
  const H = Math.ceil(lines.length * lineH + padY * 2);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D indisponível.');

  ctx.clearRect(0, 0, W, H);
  ctx.font = fontOf(fontPx);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  lines.forEach((line, i) => {
    const cx = W / 2;
    const cy = padY + lineH * i + lineH / 2;
    // Sombra dura (cópia deslocada, estilo cartaz).
    if (spec.shadow) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#000000';
      if (strokeW > 0) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = strokeW;
        ctx.strokeText(line, cx + shadowOff, cy + shadowOff);
      }
      ctx.fillText(line, cx + shadowOff, cy + shadowOff);
      ctx.restore();
    }
    if (strokeW > 0) {
      ctx.strokeStyle = spec.strokeColor;
      ctx.lineWidth = strokeW;
      ctx.strokeText(line, cx, cy);
    }
    ctx.fillStyle = spec.color;
    ctx.fillText(line, cx, cy);
  });

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob falhou.'))),
      'image/png',
    );
  });

  const shortName = lines[0].slice(0, 24) || 'texto';
  const file = new File([blob], `TXT ${shortName}.png`, { type: 'image/png' });
  return { file, width: W, height: H };
}
