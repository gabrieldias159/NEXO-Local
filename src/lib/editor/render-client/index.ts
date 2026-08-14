/**
 * Barrel export do módulo de render client-side.
 *
 * Estratégia "client-first" do editor de vídeos: vídeos curtos rodam no
 * browser via FFmpeg.wasm; vídeos pesados caem para Cloud Function.
 *
 * Uso típico (no `ExportDialog`):
 *
 *   import {
 *     checkClientRenderEligibility,
 *     browserSupportsClientRender,
 *     useClientRender,
 *   } from '@/lib/editor/render-client';
 *
 *   const eligibility = checkClientRenderEligibility(project, settings);
 *   const browser = browserSupportsClientRender();
 *   const { render, progress } = useClientRender();
 *
 *   if (eligibility.eligible && browser.supported) {
 *     const blob = await render(project, settings);
 *     downloadBlob(blob);
 *   } else {
 *     // fallback Cloud Function
 *   }
 */

export {
  CLIENT_RENDER_LIMITS,
  RENDER_TIER_LIMITS,
  browserSupportsClientRender,
  checkClientRenderEligibility,
  selectRenderTier,
  selectCompressionTier,
} from './eligibility';
export type { BrowserSupport, EligibilityResult, TierSelectionResult } from './eligibility';

export {
  buildClientRenderInput,
} from './build-client-args';
export type {
  BuildClientArgsInput,
  ClientRenderInput,
} from './build-client-args';

export { createFFmpegRenderClient } from './ffmpeg-worker-client';
export type { FFmpegRenderClient, RenderInput } from './ffmpeg-worker-client';

export { useClientRender } from './use-client-render';
export type { UseClientRenderResult } from './use-client-render';
