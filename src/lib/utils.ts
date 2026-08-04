import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { Timestamp } from "firebase/firestore"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Trunca um nome de arquivo no MEIO mantendo a extensão visível.
 *
 * Ex: `truncateFilename("documento-com-nome-extremamente-longo.pdf", 24)`
 *  → `"documento-com-nom…o.pdf"`
 *
 * Estratégia: preserva os últimos N chars (extensão + sufixo) e os primeiros
 * chars do nome base, separados por `…`. Se já couber, retorna como veio.
 *
 * Use sempre que renderizar `file.name` em listas, cards, badges etc — evita
 * quebra de layout com nomes muito longos.
 *
 * @param name   Nome (com ou sem extensão).
 * @param max    Comprimento máx (default 28).
 * @param tail   Quantos chars reservar pro sufixo+extensão (default 8).
 */
export function truncateFilename(
  name: string | null | undefined,
  max: number = 28,
  tail: number = 8,
): string {
  if (!name) return "";
  if (name.length <= max) return name;
  if (max <= 4) return name.slice(0, max);
  const tailLen = Math.min(tail, max - 3);
  const headLen = Math.max(1, max - tailLen - 1); // -1 pro caractere "…"
  return `${name.slice(0, headLen)}…${name.slice(-tailLen)}`;
}

/**
 * Formata segundos como timecode "esperto" — mostra só as unidades necessárias:
 *  - <60s  → `SS:FF`              (5:23 frames)
 *  - <60m  → `MM:SS:FF`           (12:34:11)
 *  - ≥60m  → `HH:MM:SS:FF`        (1:23:45:08)
 *
 * Sempre inclui frames (FF) com base no `fps` (default 30). Use `forceMax`
 * pra forçar todas as unidades visíveis (útil em inputs/timecodes alinhados).
 *
 * Ex: formatTimecode(3.45, 30)  → "03:13"        (3s + 13 frames)
 *     formatTimecode(75.0, 30)  → "01:15:00"     (1m 15s 0 frames)
 *     formatTimecode(3725.0, 30)→ "01:02:05:00"  (1h 2m 5s)
 */
export function formatTimecode(
  seconds: number,
  fps: number = 30,
  forceMax: 'auto' | 'hms' | 'hmsf' = 'auto',
): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const safeFps = Math.max(1, Math.round(fps));
  const totalFrames = Math.floor(seconds * safeFps);
  const ff = totalFrames % safeFps;
  const totalSec = Math.floor(totalFrames / safeFps);
  const ss = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const mm = totalMin % 60;
  const hh = Math.floor(totalMin / 60);
  const pad = (n: number) => n.toString().padStart(2, '0');

  if (forceMax === 'hmsf' || hh > 0) {
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  }
  if (forceMax === 'hms' || mm > 0) {
    return `${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  }
  return `${pad(ss)}:${pad(ff)}`;
}

/**
 * Parser inverso de `formatTimecode`. Aceita:
 *   - "SS"           → segundos
 *   - "SS:FF"        → segundos:frames
 *   - "MM:SS"        → minutos:segundos
 *   - "MM:SS:FF"     → minutos:segundos:frames
 *   - "HH:MM:SS:FF"  → horas:min:seg:frames
 *
 * Retorna NaN se inválido.
 */
export function parseTimecode(str: string, fps: number = 30): number {
  if (!str) return NaN;
  const parts = str.split(':').map((p) => p.trim());
  if (parts.length < 1 || parts.length > 4) return NaN;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
  const safeFps = Math.max(1, Math.round(fps));
  if (parts.length === 1) return nums[0];
  if (parts.length === 2) {
    // Ambíguo: pode ser MM:SS ou SS:FF. Heurística: se o segundo número
    // é >= 60, deve ser SS:FF (frame count alto não faz sentido em segundos).
    // Default: MM:SS (mais comum).
    if (nums[1] >= 60) return nums[0] + nums[1] / safeFps; // SS:FF
    return nums[0] * 60 + nums[1]; // MM:SS
  }
  if (parts.length === 3) return nums[0] * 60 + nums[1] + nums[2] / safeFps; // MM:SS:FF
  // HH:MM:SS:FF
  return nums[0] * 3600 + nums[1] * 60 + nums[2] + nums[3] / safeFps;
}

/**
 * Narrowing seguro para o union `Date | Timestamp` (muito comum nos docs do
 * Firestore após cache otimista, onde o valor já pode ser um `Date` nativo).
 *
 * - Se já for `Date`, retorna como veio.
 * - Se tiver `.toDate()` (Firestore Timestamp), chama.
 * - Caso contrário (`null`/`undefined`/valor inesperado), retorna `null`.
 *
 * Use em vez de `(v as Timestamp).toDate()` para não lançar `TypeError` quando
 * o valor já é um `Date`. Compartilhado pelas Frentes 8/9/10/13.
 */
export function toDateSafe(
  v: Date | Timestamp | null | undefined
): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof (v as Timestamp).toDate === "function") {
    try {
      return (v as Timestamp).toDate();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Converts a value that might be a Firestore Timestamp, JS Date,
 * string, number, or null/undefined into a JS Date (or null).
 */
export function toJsDate(
  d: Date | Timestamp | string | number | null | undefined
): Date | null {
  if (d == null) return null;
  if (d instanceof Date) return d;
  if (typeof d === "string" || typeof d === "number") {
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? null : dt;
  }
  // Firestore Timestamp duck-typing
  if (typeof (d as any).toDate === "function") {
    try {
      return (d as Timestamp).toDate();
    } catch {
      return null;
    }
  }
  if (
    typeof (d as any).seconds === "number" &&
    typeof (d as any).nanoseconds === "number"
  ) {
    return new Date(
      (d as any).seconds * 1000 + Math.floor((d as any).nanoseconds / 1e6)
    );
  }
  return null;
}
