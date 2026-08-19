/**
 * Utilidades puras (sem React) para manipulação de cues de legendas.
 *
 * Inclui:
 * - `findActiveCue`: cue cujo intervalo cobre `timeSec`.
 * - `detectOverlaps`: pares (a, b) cujos intervalos se intersectam.
 * - `splitCueAt`: divide um cue em dois no `timeSec` (mesmo texto duplicado).
 * - `mergeCues`: concatena dois cues adjacentes (texto com `\n`, intervalo
 *   estendido).
 * - `formatTimecode` / `parseTimecode`: serialização `HH:MM:SS.mmm`.
 *
 * Mantemos puro pra poder reutilizar em SSR / Node / Workers (export FFmpeg).
 */

import type { CaptionCue } from '../types';

// ============================================================================
// Quebra por palavras (fluxo do gabinete)
// ============================================================================

/**
 * Reparte um cue em pedaços de até `maxWords` palavras, com tempos
 * PROPORCIONAIS à contagem de palavras de cada pedaço (algoritmo do
 * `_legendas.py` da produção real). Quebra por espaço; quebras de linha viram espaço.
 *
 * Devolve 1..N cues SEM id (caller cria ids). Cue vazio devolve [cue].
 */
export function splitCueByWords(
  cue: CaptionCue,
  maxWords = 5,
): Array<Omit<CaptionCue, 'id'>> {
  const words = cue.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const base = {
    slot: cue.slot,
    style: { ...cue.style },
  };
  if (words.length <= maxWords) {
    return [
      {
        ...base,
        startTime: cue.startTime,
        endTime: cue.endTime,
        text: cue.text,
      },
    ];
  }
  const chunks: string[][] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords));
  }
  const total = words.length;
  const span = Math.max(0.05, cue.endTime - cue.startTime);
  const out: Array<Omit<CaptionCue, 'id'>> = [];
  let t = cue.startTime;
  for (const chunk of chunks) {
    const d = span * (chunk.length / total);
    out.push({
      ...base,
      style: { ...cue.style },
      startTime: Number(t.toFixed(3)),
      endTime: Number(Math.min(t + d, cue.endTime).toFixed(3)),
      text: chunk.join(' '),
    });
    t += d;
  }
  return out;
}

// ============================================================================
// Active cue
// ============================================================================

/**
 * Encontra o primeiro cue cujo intervalo `[startTime, endTime)` contém
 * `timeSec`. Em caso de sobreposição, devolve o cue de `startTime` mais
 * recente (último a entrar).
 *
 * @returns o cue ativo, ou `null` se nenhum cobre o tempo.
 */
export function findActiveCue(
  cues: CaptionCue[],
  timeSec: number,
): CaptionCue | null {
  let best: CaptionCue | null = null;
  for (const c of cues) {
    if (timeSec < c.startTime || timeSec >= c.endTime) continue;
    if (!best || c.startTime > best.startTime) {
      best = c;
    }
  }
  return best;
}

/**
 * Versão multi: devolve TODOS os cues ativos no instante `timeSec`.
 * Útil quando há sobreposição intencional (lower third + nome, p.ex.).
 */
export function findActiveCues(
  cues: CaptionCue[],
  timeSec: number,
): CaptionCue[] {
  return cues.filter((c) => timeSec >= c.startTime && timeSec < c.endTime);
}

// ============================================================================
// Overlap detection
// ============================================================================

/**
 * Detecta pares de cues sobrepostos (a.endTime > b.startTime).
 *
 * Pré-condição: cues já estão ordenados por `startTime` (o store mantém).
 * Sem esse pressuposto a função ainda funciona, mas é O(n²).
 */
export function detectOverlaps(
  cues: CaptionCue[],
): Array<[CaptionCue, CaptionCue]> {
  const sorted = [...cues].sort((a, b) => a.startTime - b.startTime);
  const out: Array<[CaptionCue, CaptionCue]> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (b.startTime >= a.endTime) break; // cues ordenados → sem mais overlap
      out.push([a, b]);
    }
  }
  return out;
}

/**
 * Cue inválido: `endTime <= startTime`. Útil para destacar em vermelho na UI.
 */
export function isInvalidCue(cue: CaptionCue): boolean {
  return cue.endTime <= cue.startTime;
}

// ============================================================================
// Split / merge
// ============================================================================

/**
 * Divide um cue em dois no instante `timeSec`. Texto é duplicado para os dois
 * lados (operador edita depois).
 *
 * Se `timeSec` está fora do intervalo (ou colado nas bordas), retorna o cue
 * original duplicado (no-op seguro).
 *
 * **Não** atribui `id` aos clones — caller deve gerar (`genId('cue')`).
 */
export function splitCueAt(
  cue: CaptionCue,
  timeSec: number,
): [CaptionCue, CaptionCue] {
  const MIN = 0.05;
  const safeTime =
    timeSec <= cue.startTime + MIN
      ? cue.startTime + MIN
      : timeSec >= cue.endTime - MIN
        ? cue.endTime - MIN
        : timeSec;
  const left: CaptionCue = {
    ...cue,
    startTime: cue.startTime,
    endTime: safeTime,
    text: cue.text,
    style: { ...cue.style },
  };
  const right: CaptionCue = {
    ...cue,
    startTime: safeTime,
    endTime: cue.endTime,
    text: cue.text,
    style: { ...cue.style },
  };
  return [left, right];
}

/**
 * Funde dois cues. Mantém o `id` do primeiro, concatena texto com `\n` e
 * estende o intervalo até `max(endTime)`.
 *
 * O cue resultante adota o `style` e `slot` de `cueA`.
 */
export function mergeCues(cueA: CaptionCue, cueB: CaptionCue): CaptionCue {
  const startTime = Math.min(cueA.startTime, cueB.startTime);
  const endTime = Math.max(cueA.endTime, cueB.endTime);
  const order = cueA.startTime <= cueB.startTime ? [cueA, cueB] : [cueB, cueA];
  const text = `${order[0].text.trim()}\n${order[1].text.trim()}`;
  return {
    ...cueA,
    startTime,
    endTime,
    text,
  };
}

// ============================================================================
// Timecode (HH:MM:SS.mmm)
// ============================================================================

const PAD = (n: number, len = 2) => String(Math.max(0, n)).padStart(len, '0');

/**
 * Formata `sec` como `HH:MM:SS.mmm` (separador ponto).
 *
 * `sec` < 0 é tratado como 0. NaN/infinito → `00:00:00.000`.
 */
export function formatTimecode(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '00:00:00.000';
  const total = sec;
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000) % 1000;
  return `${PAD(hh)}:${PAD(mm)}:${PAD(ss)}.${PAD(ms, 3)}`;
}

/**
 * Parse de timecode flexível. Aceita:
 * - `HH:MM:SS.mmm`
 * - `HH:MM:SS,mmm` (vírgula ao estilo .srt)
 * - `MM:SS.mmm`
 * - `MM:SS`
 * - `SS.mmm` ou `SS`
 *
 * @returns segundos como número, ou `null` se o input não bater.
 */
export function parseTimecode(input: string): number | null {
  if (!input) return null;
  const txt = input.trim().replace(',', '.');
  if (!txt) return null;

  // Aceita só dígitos / `:` / `.`.
  if (!/^[\d:.]+$/.test(txt)) return null;

  const parts = txt.split(':');
  if (parts.length > 3) return null;

  const last = parts[parts.length - 1];
  const lastNum = parseFloat(last);
  if (Number.isNaN(lastNum)) return null;

  if (parts.length === 1) {
    return lastNum >= 0 ? lastNum : null;
  }
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    if (Number.isNaN(m) || m < 0) return null;
    return m * 60 + lastNum;
  }
  // hh:mm:ss(.mmm)
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || m < 0) return null;
  return h * 3600 + m * 60 + lastNum;
}

// ============================================================================
// Helpers diversos
// ============================================================================

/**
 * Retorna o cue logicamente "depois" (próximo `startTime > current.endTime`).
 * Usado por atalho `Tab`.
 */
export function findNextCue(
  cues: CaptionCue[],
  current: CaptionCue,
): CaptionCue | null {
  const sorted = [...cues].sort((a, b) => a.startTime - b.startTime);
  const idx = sorted.findIndex((c) => c.id === current.id);
  if (idx < 0) return null;
  return sorted[idx + 1] ?? null;
}

/** Inverso de `findNextCue`. */
export function findPrevCue(
  cues: CaptionCue[],
  current: CaptionCue,
): CaptionCue | null {
  const sorted = [...cues].sort((a, b) => a.startTime - b.startTime);
  const idx = sorted.findIndex((c) => c.id === current.id);
  if (idx <= 0) return null;
  return sorted[idx - 1] ?? null;
}
