/**
 * Verifica se um projeto pode ser renderizado client-side via FFmpeg.wasm.
 *
 * Estratégia "client-first" (docs/editor/03_DEPLOY_STRATEGY.md):
 * - Vídeos curtos/leves rodam no browser (zero custo Cloud).
 * - Vídeos pesados caem para a Cloud Function (já existente).
 *
 * Limites do path client-side:
 *  - Duração total ≤ 5 minutos
 *  - Tamanho total dos assets ≤ 500 MB
 *  - Resolução ≤ 1080p
 *  - ≤ 2 tracks de vídeo + ≤ 2 tracks de áudio
 *  - Sem captions queimadas (libass não está em FFmpeg.wasm padrão)
 *  - Browser suporta `SharedArrayBuffer`
 */

import type { ExportSettings, RenderTier, VideoProject } from '@/lib/editor/types';

// ============================================================================
// Limites
// ============================================================================

export const CLIENT_RENDER_LIMITS = {
  maxDurationSec: 5 * 60, // 5 minutos
  maxTotalSizeMB: 500,
  maxVideoTracks: 2,
  maxAudioTracks: 2,
  /** Pixels do lado mais longo. */
  maxLongestSidePx: 1920,
} as const;

// ============================================================================
// Resultados
// ============================================================================

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  estimatedSizeMB: number;
  totalDurationSec: number;
  /** Lista de razões (pode haver mais de uma). */
  exceedsLimits: string[];
}

export interface BrowserSupport {
  supported: boolean;
  reason?: string;
}

// ============================================================================
// Browser support
// ============================================================================

/**
 * Confere capacidades necessárias para FFmpeg.wasm rodar no client.
 *
 * `SharedArrayBuffer` exige headers COOP/COEP (já configurados em
 * `next.config.ts` para `/apps/suite-editor-videos/*`).
 */
export function browserSupportsClientRender(): BrowserSupport {
  if (typeof window === 'undefined') {
    return { supported: false, reason: 'SSR (sem window)' };
  }
  if (typeof SharedArrayBuffer === 'undefined') {
    return {
      supported: false,
      reason:
        'SharedArrayBuffer indisponível (cabeçalhos COOP/COEP ausentes ou browser sem suporte).',
    };
  }
  if (typeof Worker === 'undefined') {
    return { supported: false, reason: 'Web Worker não suportado.' };
  }
  if (typeof WebAssembly === 'undefined') {
    return { supported: false, reason: 'WebAssembly não suportado.' };
  }
  return { supported: true };
}

// ============================================================================
// Eligibility
// ============================================================================

/**
 * Decide se o projeto cabe no path client-side.
 *
 * Calcula:
 *  - duração total (max endInTimeline de todos os clips visíveis)
 *  - tamanho dos assets em uso
 *  - quantidade de tracks visíveis
 *
 * Retorna `eligible=false` com `exceedsLimits[]` apontando o(s) limite(s)
 * estourado(s) — o caller mostra a razão na UI.
 */
export function checkClientRenderEligibility(
  project: VideoProject,
  exportSettings: ExportSettings,
): EligibilityResult {
  const exceedsLimits: string[] = [];

  // 1. Duração
  const totalDurationSec = computeProjectDuration(project);
  if (totalDurationSec > CLIENT_RENDER_LIMITS.maxDurationSec) {
    const mins = (totalDurationSec / 60).toFixed(1);
    exceedsLimits.push(
      `Duração ${mins}min > ${CLIENT_RENDER_LIMITS.maxDurationSec / 60}min`,
    );
  }

  // 2. Tamanho dos assets em uso
  const usedAssetIds = collectUsedAssetIds(project);
  const totalBytes = project.assets
    .filter((a) => usedAssetIds.has(a.id))
    .reduce((acc, a) => acc + (a.size ?? 0), 0);
  const estimatedSizeMB = totalBytes / (1024 * 1024);
  if (estimatedSizeMB > CLIENT_RENDER_LIMITS.maxTotalSizeMB) {
    exceedsLimits.push(
      `Assets ${estimatedSizeMB.toFixed(0)}MB > ${CLIENT_RENDER_LIMITS.maxTotalSizeMB}MB`,
    );
  }

  // 3. Tracks visíveis
  const visibleVideoTracks = project.tracks.filter(
    (t) => t.type === 'video' && t.visible && t.clips.some((c) => !c.hidden),
  ).length;
  const visibleAudioTracks = project.tracks.filter(
    (t) => t.type === 'audio' && t.clips.some((c) => !c.hidden && !c.audio.muted),
  ).length;
  if (visibleVideoTracks > CLIENT_RENDER_LIMITS.maxVideoTracks) {
    exceedsLimits.push(
      `${visibleVideoTracks} tracks de vídeo > ${CLIENT_RENDER_LIMITS.maxVideoTracks}`,
    );
  }
  if (visibleAudioTracks > CLIENT_RENDER_LIMITS.maxAudioTracks) {
    exceedsLimits.push(
      `${visibleAudioTracks} tracks de áudio > ${CLIENT_RENDER_LIMITS.maxAudioTracks}`,
    );
  }

  // 4. Resolução
  const longestSide = Math.max(
    project.resolution.width,
    project.resolution.height,
  );
  if (longestSide > CLIENT_RENDER_LIMITS.maxLongestSidePx) {
    exceedsLimits.push(
      `Resolução ${project.resolution.width}x${project.resolution.height} > ${CLIENT_RENDER_LIMITS.maxLongestSidePx}p`,
    );
  }

  // 5. Captions queimadas — FFmpeg.wasm padrão não tem libass habilitado.
  if (exportSettings.burnCaptions) {
    const hasCaptions = project.captionTracks.some(
      (t) => t.visible && t.cues.length > 0,
    );
    if (hasCaptions) {
      exceedsLimits.push(
        'Legendas queimadas (libass) só são suportadas no render Cloud',
      );
    }
  }

  // 6. Assets locais (blob:) — Cloud não consegue baixá-los, logo são
  //    apenas elegíveis para client. Aqui não bloqueia, só observa.

  const eligible = exceedsLimits.length === 0;
  return {
    eligible,
    reason: eligible ? undefined : exceedsLimits[0],
    estimatedSizeMB,
    totalDurationSec,
    exceedsLimits,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function computeProjectDuration(project: VideoProject): number {
  let max = project.duration ?? 0;
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.hidden) continue;
      if (c.endInTimeline > max) max = c.endInTimeline;
    }
  }
  return Math.max(0, max);
}

function collectUsedAssetIds(project: VideoProject): Set<string> {
  const ids = new Set<string>();
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.hidden) continue;
      ids.add(c.assetId);
    }
  }
  return ids;
}

// ============================================================================
// Tier Selection (Cloud Function resource allocation)
// ============================================================================

/**
 * Limites de cada tier de Cloud Function. Espelha exatamente a configuração
 * em `functions/src/video/render.ts` — manter sincronizado!
 */
export const RENDER_TIER_LIMITS = {
  low: {
    maxDurationSec: 30,
    maxAssetsMB: 50,
    maxClips: 3,
    // 1 vCPU / 1GiB / 300s — vídeos curtos simples
  },
  medium: {
    maxDurationSec: 120,
    maxAssetsMB: 200,
    maxClips: 10,
    // 2 vCPU / 2GiB / 540s — médios
  },
  // high = qualquer coisa acima de medium
} as const;

export interface TierSelectionResult {
  tier: RenderTier;
  reason: string;
  durationSec: number;
  assetsSizeMB: number;
  clipCount: number;
}

/**
 * Seleciona o menor tier de Cloud Function suficiente pra o projeto.
 *
 * Estratégia: começa em `low`, escala pra `medium` ou `high` se ultrapassar
 * os limites. Captions queimadas e overlays forçam tier ≥ medium (mais CPU
 * pra libass + overlay pass).
 *
 * Por que não usar sempre o tier mais alto?
 * - Tier high custa ~4x mais por minuto que low (4vCPU vs 1vCPU).
 * - Vídeo de 10s pode renderizar em 30s no tier low (1vCPU é suficiente
 *   pra veryfast). Pagar 4 vCPUs por 30s é desperdício.
 */
export function selectRenderTier(
  project: VideoProject,
  exportSettings: ExportSettings,
): TierSelectionResult {
  const durationSec = computeProjectDuration(project);
  const usedIds = collectUsedAssetIds(project);
  const totalBytes = project.assets
    .filter((a) => usedIds.has(a.id))
    .reduce((acc, a) => acc + (a.size ?? 0), 0);
  const assetsSizeMB = totalBytes / (1024 * 1024);
  const clipCount = project.tracks.reduce(
    (acc, t) => acc + t.clips.filter((c) => !c.hidden).length,
    0,
  );

  const hasComplexFeatures =
    exportSettings.burnCaptions ||
    !!exportSettings.includeLogo ||
    !!exportSettings.includeFooter ||
    !!exportSettings.includeEnding ||
    project.tracks.some((t) =>
      t.clips.some((c) => c.chromaKey?.enabled && c.chromaKey.engine === 'cloud'),
    );

  // Tier HIGH — pesados ou complexos
  if (
    durationSec > RENDER_TIER_LIMITS.medium.maxDurationSec ||
    assetsSizeMB > RENDER_TIER_LIMITS.medium.maxAssetsMB ||
    clipCount > RENDER_TIER_LIMITS.medium.maxClips
  ) {
    return {
      tier: 'high',
      reason: `Projeto pesado: ${durationSec.toFixed(0)}s · ${assetsSizeMB.toFixed(0)}MB · ${clipCount} clips`,
      durationSec,
      assetsSizeMB,
      clipCount,
    };
  }

  // Tier MEDIUM — médios OU recursos complexos
  if (
    hasComplexFeatures ||
    durationSec > RENDER_TIER_LIMITS.low.maxDurationSec ||
    assetsSizeMB > RENDER_TIER_LIMITS.low.maxAssetsMB ||
    clipCount > RENDER_TIER_LIMITS.low.maxClips
  ) {
    return {
      tier: 'medium',
      reason: hasComplexFeatures
        ? 'Captions/overlays/chroma exigem mais CPU'
        : `Projeto médio: ${durationSec.toFixed(0)}s · ${assetsSizeMB.toFixed(0)}MB`,
      durationSec,
      assetsSizeMB,
      clipCount,
    };
  }

  // Tier LOW — vídeos curtos e simples
  return {
    tier: 'low',
    reason: `Vídeo curto/leve: ${durationSec.toFixed(0)}s · ${assetsSizeMB.toFixed(0)}MB · ${clipCount} clips`,
    durationSec,
    assetsSizeMB,
    clipCount,
  };
}

/**
 * Seleciona tier de compressão baseado no tamanho do arquivo de origem.
 *
 * - small (≤ 100MB): 1 vCPU / 1 GiB / 300s
 * - medium (≤ 500MB): 2 vCPU / 2 GiB / 540s
 * - large (> 500MB): 4 vCPU / 4 GiB / 540s
 */
export function selectCompressionTier(sizeBytes: number): 'small' | 'medium' | 'large' {
  const sizeMB = sizeBytes / (1024 * 1024);
  if (sizeMB <= 100) return 'small';
  if (sizeMB <= 500) return 'medium';
  return 'large';
}
