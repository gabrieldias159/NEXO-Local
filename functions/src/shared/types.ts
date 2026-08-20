/**
 * Tipos compartilhados das Cloud Functions de vídeo.
 *
 * Espelha (de forma simplificada) os tipos do front em
 * `src/lib/editor/types.ts`. Não importamos diretamente porque o ambiente
 * de Cloud Functions roda em Node sem o path alias `@/...` e sem o tipo
 * `Timestamp` do firebase/firestore client SDK.
 *
 * Apenas campos consumidos pelo render server estão presentes — campos UI
 * (zoom, isPlaying, selection) são intencionalmente omitidos.
 */

// ============================================================================
// Compression / Quick Edit (legados que estavam no monolito)
// ============================================================================

export type CompressionQuality = "low" | "medium" | "high";

export type CompressionTier = "small" | "medium" | "large";

export type CompressionJob = {
  videoId?: string;
  folderId?: string;
  videoFilePath?: string;
  status?: "pending" | "compressing" | "complete" | "error" | "cancelled";
  quality?: CompressionQuality;
  /** Tier de recursos da função (default 'large' p/ retrocompat). */
  tier?: CompressionTier;
  /** Tamanho do arquivo de origem em bytes (usado pra selecionar tier). */
  sourceSize?: number;
};

export type QuickEditSaveMode = "download" | "new-copy" | "replace";

export type QuickEditSettings = {
  trimStart: string;
  trimEnd: string;
  addLogo: boolean;
  addFooter: boolean;
  addEnding: boolean;
  aspectRatio: "9:16" | "4:5";
  scaleMode?: "fit" | "fill";
  /** Destino do vídeo editado. Default: 'replace' (retrocompat). */
  saveMode?: QuickEditSaveMode;
  /** Nome customizado pro novo doc (modo new-copy). */
  customName?: string;
};

export type QuickEditJob = {
  videoId?: string;
  folderId?: string;
  videoFilePath?: string;
  status?: "pending" | "processing" | "complete" | "error";
  settings?: QuickEditSettings;
  requestedByUid?: string;
  outputUrl?: string;
  outputPath?: string;
  savedVideoId?: string;
};

export type AppearanceConfig = {
  brasaoUrl?: string;
  videoLogoUrl?: string;
  videoFooterUrl?: string;
  videoEncerramentoUrl?: string;
};

// ============================================================================
// Editor de Vídeos — VideoProject
// ============================================================================

export type ResolutionLabel =
  | "1080p Landscape"
  | "1080p Portrait"
  | "720p Landscape"
  | "720p Portrait"
  | "Square 1:1";

export interface ResolutionPreset {
  width: number;
  height: number;
  label: ResolutionLabel | string;
}

export interface MediaAsset {
  id: string;
  name: string;
  type: "video" | "image" | "audio";
  source: "firebase" | "local-blob";
  storagePath?: string;
  downloadUrl: string;
  size: number;
  duration?: number;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  status: "uploading" | "ready" | "error";
}

export interface ClipTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  anchorX: number;
  anchorY: number;
  flipH: boolean;
  flipV: boolean;
}

export interface ClipFilters {
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
  hue: number;
  grayscale: number;
}

export interface ClipAudio {
  volume: number;
  muted: boolean;
  fadeInDuration: number;
  fadeOutDuration: number;
  pan: number;
}

export type TransitionType =
  | "fade"
  | "crossfade"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "zoom-in"
  | "zoom-out"
  | "wipe-left"
  | "wipe-right"
  | "push-left"
  | "push-right"
  | "circle"
  | "iris";

export interface TransitionConfig {
  type: TransitionType;
  duration: number;
  easing: "linear" | "ease-in" | "ease-out" | "ease-in-out";
}

export interface Clip {
  id: string;
  assetId: string;
  trackId: string;
  startInTimeline: number;
  endInTimeline: number;
  startInAsset: number;
  endInAsset: number;
  slot: "full" | "top" | "bottom";
  /**
   * Camada (subtrack) dentro da track de vídeo, 0 = base / mais embaixo.
   * Camadas maiores são sobrepostas por cima no render. Ausente = 0.
   */
  layer?: number;
  playbackRate: number;
  transform: ClipTransform;
  filters: ClipFilters;
  audio: ClipAudio;
  transitionIn?: TransitionConfig;
  transitionOut?: TransitionConfig;
  locked: boolean;
  hidden: boolean;
  /** Janelas de blur de fundo (s da timeline) — boxblur=10 + brilho −6%. */
  blurWindows?: Array<{ start: number; end: number }>;
  /** Chroma key (remoção de fundo) — espelha src/lib/editor/types.ts. */
  chromaKey?: {
    enabled: boolean;
    color: string;
    similarity: number;
    smoothness: number;
    spillSuppression: number;
    mode?: "chroma" | "luma";
    lumaThreshold?: number;
    lumaTolerance?: number;
    lumaSoftness?: number;
    engine?: string;
  };
}

export interface Track {
  id: string;
  type: "video" | "audio";
  name: string;
  index: number;
  muted: boolean;
  locked: boolean;
  visible: boolean;
  solo: boolean;
  height: number;
  clips: Clip[];
  /** Número de camadas (subtracks) — só tracks de vídeo. Ausente = 1. */
  layerCount?: number;
  /** Volume da TRACK em % (100 = neutro) — multiplica o volume dos clips. */
  gainPct?: number;
  /** Nivelar dinâmica no export (dynaudnorm f=200:g=15:p=0.85). */
  audioLeveling?: boolean;
  /** Fades automáticos no export (in 1,2s / out 2,5s por clip). */
  autoFade?: boolean;
  /** Abre espaço pra voz: highpass 130 Hz + dip de -3,5 dB em 2,8 kHz. */
  voiceEq?: boolean;
  /** Duck por sidechain: a trilha abaixa quando a voz (track base) fala. */
  voiceDuck?: boolean;
}

// ---- Captions ---------------------------------------------------------------

export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: 400 | 500 | 600 | 700;
  color: string;
  backgroundColor: string;
  align: "left" | "center" | "right";
  position: "top" | "center" | "bottom";
  /** Ajuste fino vertical em % da altura do palco (-50 a +50), sobre `position`. */
  offsetY?: number;
  paddingX: number;
  paddingY: number;
  borderRadius: number;
  outlineColor?: string;
  outlineWidth?: number;
  shadowColor?: string;
  shadowBlur?: number;
  // Campos aditivos dos presets de legenda (espelham src/lib/editor/types.ts —
  // opcionais p/ retrocompat com cues antigos no Firestore).
  textTransform?: "none" | "uppercase";
  letterSpacing?: number;
  lineHeight?: number;
  maxWidthPct?: number;
  /** Animação de entrada do cue: none | fade (fad 100/60) | pop. */
  animation?: "none" | "fade" | "pop";
}

export interface CaptionCue {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  slot: "full" | "top" | "bottom";
  style: CaptionStyle;
}

export interface CaptionTrack {
  id: string;
  name: string;
  index: number;
  visible: boolean;
  locked: boolean;
  language?: string;
  cues: CaptionCue[];
  /** Origem (espelha o tipo do front). */
  source?: "manual" | "imported" | "ai";
  /** ID do `CaptionGenerationJob` que gerou esta track. */
  aiJobId?: string;
}

// ---- Stage / Project --------------------------------------------------------

export interface VideoProject {
  id: string;
  name: string;
  ownerUid: string;
  resolution: ResolutionPreset;
  frameRate: 24 | 30 | 60;
  duration: number;
  stageMode: "single" | "split-vertical";
  splitRatio: number;
  assets: MediaAsset[];
  tracks: Track[];
  captionTracks: CaptionTrack[];
  audioMaster: { volume: number; muted: boolean };
  /** Parâmetros da identidade visual (logo/rodapé/vinheta) — opcional. */
  identity?: ProjectIdentity;
  /** Fator acumulado de velocidade global (informativo). */
  speechRate?: number;
}

/**
 * Parâmetros da identidade do gabinete (espelha src/lib/editor/types.ts).
 * O render usa estes valores em `applyOverlays`; ausência cai nos defaults.
 */
export interface ProjectIdentity {
  logoWidthPct?: number;
  footerWidthPct?: number;
  endingTrimStart?: number;
  endingAudioFadeIn?: number;
}

export const DEFAULT_IDENTITY: Required<ProjectIdentity> = {
  logoWidthPct: 44,
  footerWidthPct: 97,
  endingTrimStart: 0,
  endingAudioFadeIn: 0.6,
};

// ---- Render -----------------------------------------------------------------

export interface ExportSettings {
  resolution: "1080p" | "720p" | "480p";
  format: "mp4" | "webm";
  bitrate?: number;
  quality: "low" | "medium" | "high";
  burnCaptions: boolean;
  includeLogo?: boolean;
  includeFooter?: boolean;
  includeEnding?: boolean;
  /** Prévia de trecho: renderiza só este intervalo (s da timeline). */
  trecho?: { start: number; end: number };
}

export type RenderTier = "low" | "medium" | "high";

export interface RenderJob {
  id: string;
  projectId: string;
  ownerUid: string;
  engine: "ffmpeg-wasm" | "cloud-ffmpeg";
  tier?: RenderTier;
  status: "pending" | "rendering" | "complete" | "error" | "cancelled";
  progress: number;
  exportSettings: ExportSettings;
  outputPath?: string;
  outputUrl?: string;
  /** Path da CAPA no Storage (`renders/{uid}/{jobId}-thumb.jpg`). */
  thumbnailPath?: string;
  /** URL pública (token) da capa — usada como thumbnail na lista. */
  thumbnailUrl?: string;
  savedVideoId?: string;
  error?: string;
  /** Modo "nova cópia": cria um novo doc em recortes/{folderId}/videos. */
  destinationFolderId?: string;
  /** Modo "substituir": atualiza o filePath/size do videoId existente. */
  replaceVideoId?: string;
  /** Pasta do vídeo a substituir. */
  replaceFolderId?: string;
}

// ============================================================================
// Caption Generation Job (IA)
// ============================================================================

export type CaptionJobStatus =
  | "pending"
  | "mixing"
  | "transcribing"
  | "aligning"
  | "complete"
  | "error"
  | "cancelled";

export interface CaptionGenerationJob {
  id: string;
  projectId: string;
  ownerUid: string;
  status: CaptionJobStatus;
  language: string;
  model: "gemini-2.5-flash" | "gemini-2.5-pro";
  needsServerMix: boolean;
  mixedAudioPath?: string;
  captionTrackId?: string;
  srtStoragePath?: string;
  progress: number;
  error?: string;
  /** Timestamp ISO ou Date — Cloud Functions usa admin.firestore.Timestamp. */
  createdAt?: unknown;
  completedAt?: unknown;
}
