/**
 * Barrel export do módulo "Editor de Legendas".
 *
 * Inclui o fluxo manual + import (parser local) e o fluxo IA
 * (Cloud Function `onCaptionGenerateRequest` + dialog).
 */

export { CaptionsDrawer } from './CaptionsDrawer';
export { CaptionCueCard } from './CaptionCueCard';
export type { CaptionCueCardProps } from './CaptionCueCard';
export { CaptionImportDialog } from './CaptionImportDialog';
export type { ImportMode } from './CaptionImportDialog';
export { CaptionStyleEditor } from './CaptionStyleEditor';
export { useCaptionsDrawer } from './useCaptionsDrawer';
export { CaptionGenerateDialog } from './CaptionGenerateDialog';
export { useCaptionGeneration } from './useCaptionGeneration';
export type { CaptionGenerationState } from './useCaptionGeneration';
