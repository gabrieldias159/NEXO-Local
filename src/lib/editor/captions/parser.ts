/**
 * Parser/serializer wrapper sobre a lib `subtitle` (npm).
 *
 * Mantém o store puro: o componente que importa um `.srt`/`.vtt` chama
 * `parseSrt` / `parseVtt` para produzir um array de `Omit<CaptionCue, 'id'>`
 * e injeta no store via `addCaption(...)` ou `importSrt({ parser })`.
 *
 * Sem IA, sem APIs pagas — `subtitle` é puro JS (~12 KB gzip).
 *
 * Convenções:
 * - Tempos no `CaptionCue` são em **segundos** (a lib `subtitle` usa ms).
 * - Removemos tags HTML (`<i>`, `<b>`, `<font>`, ...) para texto plano.
 * - Estilo default vem de `DEFAULT_CAPTION_STYLE` (no caller / store).
 * - Em caso de SRT mal formado: retorna `[]` (caller mostra toast).
 */

import { parseSync, stringifySync } from 'subtitle';
import type { CaptionCue, CaptionStyle } from '../types';

// ============================================================================
// Estilo default — usado para popular cues importadas (a customização vem do
// `CaptionStyleEditor`).
// ============================================================================

export const DEFAULT_PARSER_STYLE: CaptionStyle = {
  fontFamily: 'Inter',
  fontSize: 36,
  fontWeight: 600,
  color: '#FFFFFF',
  backgroundColor: '#000000B3',
  align: 'center',
  position: 'bottom',
  paddingX: 12,
  paddingY: 4,
  borderRadius: 4,
};

// ============================================================================
// Parse
// ============================================================================

/**
 * Tipo de cue parseada — o id ainda não existe, será gerado pelo store.
 *
 * Note: o `CaptionCue` real tem `id` obrigatório, mas no fluxo de import o id
 * vem do `addCaption(..)`/`importSrt(..)` no `store.ts`. Mantemos o shape
 * compatível com `Omit<CaptionCue, 'id'>` pra encaixar no `importSrt`.
 */
export type ParsedCue = Omit<CaptionCue, 'id'>;

/**
 * Limpa tags HTML e normaliza quebras de linha do texto da legenda.
 *
 * - Remove tags inline (`<i>`, `<b>`, `<font color>`, ...).
 * - Mantém `\n` (multi-linha).
 * - Trim de espaços nas pontas.
 */
function sanitizeCueText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/** Converte node-list da lib para nosso shape (sem id). */
function nodesToCues(
  nodes: ReturnType<typeof parseSync>,
): ParsedCue[] {
  const out: ParsedCue[] = [];
  for (const node of nodes) {
    if (node.type !== 'cue') continue;
    const startMs = node.data.start;
    const endMs = node.data.end;
    if (
      typeof startMs !== 'number' ||
      typeof endMs !== 'number' ||
      Number.isNaN(startMs) ||
      Number.isNaN(endMs)
    ) {
      continue;
    }
    const startTime = Math.max(0, startMs / 1000);
    const endTime = Math.max(startTime + 0.05, endMs / 1000);
    const text = sanitizeCueText(node.data.text ?? '');
    if (!text) continue;
    out.push({
      startTime,
      endTime,
      text,
      slot: 'full',
      style: { ...DEFAULT_PARSER_STYLE },
    });
  }
  return out;
}

/**
 * Parser de `.srt` puro (string). Retorna array vazio se input for vazio
 * ou se o parse falhar.
 */
export function parseSrt(content: string): ParsedCue[] {
  if (!content || !content.trim()) return [];
  try {
    const nodes = parseSync(content);
    return nodesToCues(nodes);
  } catch (err) {
    // Lib `subtitle` é tolerante; raramente lança. Mas garantimos fallback.
    console.warn('[captions/parser] erro parseando .srt:', err);
    return [];
  }
}

/**
 * Parser de `.vtt` (WebVTT). A lib `subtitle` aceita os dois formatos no
 * mesmo `parseSync`, então delegamos.
 */
export function parseVtt(content: string): ParsedCue[] {
  return parseSrt(content);
}

/**
 * Detecta o formato pelo nome do arquivo + conteúdo (heurística simples).
 */
export function detectSubtitleFormat(filename: string, content: string): 'srt' | 'vtt' {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.vtt')) return 'vtt';
  if (lower.endsWith('.srt')) return 'srt';
  // Fallback pelo conteúdo: WebVTT começa com "WEBVTT".
  if (content.trim().toUpperCase().startsWith('WEBVTT')) return 'vtt';
  return 'srt';
}

/**
 * Helper de alto nível: parse a partir de um `File` (browser API).
 *
 * Lê o arquivo como texto e despacha para `parseSrt`/`parseVtt` conforme a
 * extensão / heurística.
 */
export async function parseSubtitleFile(file: File): Promise<ParsedCue[]> {
  const text = await file.text();
  const fmt = detectSubtitleFormat(file.name, text);
  return fmt === 'vtt' ? parseVtt(text) : parseSrt(text);
}

// ============================================================================
// Serializer
// ============================================================================

/** Serializa cues como string `.srt` (compatível com a lib). */
export function exportSrt(cues: CaptionCue[]): string {
  if (cues.length === 0) return '';
  return stringifySync(
    cues.map((c) => ({
      type: 'cue' as const,
      data: {
        start: Math.round(c.startTime * 1000),
        end: Math.round(c.endTime * 1000),
        text: c.text,
      },
    })),
    { format: 'SRT' },
  );
}

/** Serializa cues como string `.vtt` (WebVTT). */
export function exportVtt(cues: CaptionCue[]): string {
  if (cues.length === 0) return 'WEBVTT\n';
  return stringifySync(
    cues.map((c) => ({
      type: 'cue' as const,
      data: {
        start: Math.round(c.startTime * 1000),
        end: Math.round(c.endTime * 1000),
        text: c.text,
      },
    })),
    { format: 'WebVTT' },
  );
}
