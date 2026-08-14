/**
 * Helpers puros para interações na timeline (drag, trim, snap, blade).
 *
 * Sem dependências de React, store ou DOM. Toda lógica matemática de
 * conversão px↔segundos e snap está aqui — testável e reutilizável.
 */

import type { VideoProject } from './types';

/**
 * Converte coordenada X em pixels (relativa ao início da área de clips, sem
 * considerar o header da track) para segundos absolutos da timeline.
 *
 * @param px coordenada X em pixels (>= 0)
 * @param zoom px por segundo
 * @returns tempo em segundos (>= 0)
 */
export function timelineXToSec(px: number, zoom: number): number {
  if (zoom <= 0) return 0;
  return Math.max(0, px / zoom);
}

/**
 * Converte segundos para coordenada X em pixels.
 *
 * @param sec tempo em segundos
 * @param zoom px por segundo
 * @returns coordenada X em pixels
 */
export function secToTimelineX(sec: number, zoom: number): number {
  return Math.max(0, sec) * zoom;
}

/**
 * Tenta snapar `value` a um candidato dentro da janela de `thresholdSec`.
 *
 * Retorna o candidato mais próximo se a distância for <= threshold,
 * caso contrário retorna `value` original.
 *
 * O parâmetro `magnetSnapStrength` (0-1) controla a "força" do snap quando
 * dentro da janela:
 * - `1` (default): snap brusco — encaixa exatamente no candidato (comportamento
 *   clássico).
 * - `0`: efetivamente desativa o snap (mantém valor original).
 * - intermediário: o resultado é uma interpolação linear entre `value` e o
 *   candidato (`value + (target - value) * magnetSnapStrength`), produzindo
 *   um efeito de "ímã" mais suave/visco-elástico. Útil para futuros toggles
 *   de UX onde o usuário queira sentir o "puxão" sem encaixar 100%.
 *
 * @param value valor (em segundos) que se deseja snapar
 * @param candidates lista de candidatos (em segundos)
 * @param thresholdSec janela de snap em segundos
 * @param magnetSnapStrength (default 1) — força do snap, 0..1
 */
export function snapToCandidates(
  value: number,
  candidates: number[],
  thresholdSec: number,
  magnetSnapStrength = 1,
): number {
  if (thresholdSec <= 0 || candidates.length === 0) return value;
  let bestDelta = thresholdSec;
  let bestValue = value;
  for (const c of candidates) {
    const delta = Math.abs(c - value);
    if (delta <= bestDelta) {
      bestDelta = delta;
      bestValue = c;
    }
  }
  if (bestValue === value) return value;
  // Aplica força do magnet (lerp entre value e target).
  const strength = Math.max(0, Math.min(1, magnetSnapStrength));
  if (strength >= 1) return bestValue;
  return value + (bestValue - value) * strength;
}

/**
 * Variante de `snapToCandidates` que também retorna o candidato encontrado
 * (para feedback visual — `<SnapGuides />` destaca o alvo do snap atual).
 *
 * @returns `{ value, target }` onde `target` é o candidato encaixado (ou null).
 */
export function snapToCandidatesWithTarget(
  value: number,
  candidates: number[],
  thresholdSec: number,
  magnetSnapStrength = 1,
): { value: number; target: number | null } {
  if (thresholdSec <= 0 || candidates.length === 0) {
    return { value, target: null };
  }
  let bestDelta = thresholdSec;
  let bestValue = value;
  let bestTarget: number | null = null;
  for (const c of candidates) {
    const delta = Math.abs(c - value);
    if (delta <= bestDelta) {
      bestDelta = delta;
      bestValue = c;
      bestTarget = c;
    }
  }
  if (bestTarget === null) return { value, target: null };
  const strength = Math.max(0, Math.min(1, magnetSnapStrength));
  const finalValue =
    strength >= 1 ? bestValue : value + (bestValue - value) * strength;
  return { value: finalValue, target: bestTarget };
}

/**
 * Retorna candidatos para snap: bordas de todos os clips (exceto `excludeClipId`)
 * de todas as tracks + posição do playhead + zero.
 *
 * @param project projeto atual
 * @param excludeClipId clip que está sendo movido/redimensionado (ignora suas próprias bordas)
 * @param playheadSec tempo atual do playhead
 */
export function getSnapCandidates(
  project: VideoProject,
  excludeClipId: string,
  playheadSec: number,
): number[] {
  const out: number[] = [0, playheadSec];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      out.push(clip.startInTimeline);
      out.push(clip.endInTimeline);
    }
  }
  return out;
}

/**
 * Formata tempo em segundos como timecode esperto com FRAMES:
 *  - <60s   → `SS:FF`
 *  - <60min → `MM:SS:FF`
 *  - ≥60min → `HH:MM:SS:FF`
 *
 * Usado nos HUDs de drag/trim de clips (Suite Editor) — frame-perfect
 * pra usuário ver exatamente onde está cortando.
 */
export function formatTimeHud(seconds: number, fps: number = 30): string {
  const total = Math.max(0, seconds);
  const safeFps = Math.max(1, Math.round(fps));
  const totalFrames = Math.floor(total * safeFps);
  const ff = totalFrames % safeFps;
  const totalSec = Math.floor(totalFrames / safeFps);
  const ss = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const mm = totalMin % 60;
  const hh = Math.floor(totalMin / 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hh > 0) return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  if (mm > 0) return `${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  return `${pad(ss)}:${pad(ff)}`;
}
