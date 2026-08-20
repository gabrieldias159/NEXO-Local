'use client';

/**
 * Chip de RISCO EDITORIAL de um item do acervo (recursos 13 e 14).
 *
 * O risco vem do catálogo curado: `baixo` é efeito genérico sem dono
 * identificável; `médio` costuma ser voz de meme conhecido, crédito
 * obrigatório ou conteúdo de terceiros. O motivo vai no tooltip para a
 * decisão ser tomada com o porquê à vista.
 */

import type { NivelRisco } from '@/lib/editor/acervo/tipos';
import { cn } from '@/lib/utils';

const CORES: Record<NivelRisco, string> = {
  baixo: 'border-emerald-600/50 text-emerald-400',
  medio: 'border-amber-500/60 text-amber-400',
  alto: 'border-red-500/60 text-red-400',
};

const LABEL: Record<NivelRisco, string> = {
  baixo: 'risco baixo',
  medio: 'risco médio',
  alto: 'risco alto',
};

export function ChipRisco({
  risco,
  motivo,
}: {
  risco: NivelRisco;
  motivo?: string;
}) {
  return (
    <span
      title={motivo ? `${LABEL[risco]} — ${motivo}` : LABEL[risco]}
      className={cn(
        'rounded border px-1 text-[8px] uppercase tracking-wide',
        CORES[risco],
      )}
    >
      {LABEL[risco]}
    </span>
  );
}
