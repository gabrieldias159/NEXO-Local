'use client';

/**
 * Util para multi-seleção do Inspector.
 *
 * Dada uma lista de objetos e um seletor que extrai um valor primitivo,
 * retorna o valor único se todos forem iguais, ou `null` se divergem.
 *
 * Numerical comparison usa pequena tolerância (epsilon) para floats.
 */

export function pickCommonValue<T, V extends number | string | boolean>(
  items: T[],
  selector: (item: T) => V,
  epsilon = 1e-6,
): V | null {
  if (items.length === 0) return null;
  const first = selector(items[0]);
  for (let i = 1; i < items.length; i++) {
    const v = selector(items[i]);
    if (typeof first === 'number' && typeof v === 'number') {
      if (Math.abs(first - v) > epsilon) return null;
    } else if (first !== v) {
      return null;
    }
  }
  return first;
}

export function pickCommonAnchor<T>(
  items: T[],
  getX: (item: T) => number,
  getY: (item: T) => number,
): { x: number; y: number } | null {
  if (items.length === 0) return null;
  const x = pickCommonValue(items, getX);
  const y = pickCommonValue(items, getY);
  if (x === null || y === null) return null;
  return { x, y };
}
