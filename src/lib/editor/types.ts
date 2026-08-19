/**
 * Tipos do Suite Editor de Vídeos.
 *
 * Especificação: docs/editor/02_PROTOTYPE_SPEC.md
 * (seção "3. Modelo de Dados Completo")
 *
 * Inclui:
 * - VideoProject + ResolutionPreset + Stage (split-screen)
 * - MediaAsset, Track, Clip (com slot, playbackRate, locked, hidden)
 * - ClipTransform (com anchorX/Y, flipH/V)
 * - ClipFilters (com hue, grayscale)
 * - ClipAudio (com fadeIn/fadeOut, pan)
 * - TransitionConfig + TransitionType
 * - Keyframe
 * - CaptionTrack, CaptionCue, CaptionStyle (legendas SEM IA)
 * - RenderJob (engine ffmpeg-wasm | cloud-ffmpeg) + ExportSettings (burnCaptions)
 * - EditorUIState (não vai ao Firestore)
 */

import type { Timestamp } from 'firebase/firestore';

// ============================================================================
// Projeto
// ============================================================================

/**
 * Documento raiz do editor. É o que vai/volta do Firestore.
 *
 * Não confundir com `EditorUIState`, que é estado UI/efêmero (zoom, playhead,
 * seleção) e fica apenas em memória / localStorage.
 */
export interface VideoProject {
  id: string;
  name: string;
  ownerUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;

  resolution: ResolutionPreset;
  frameRate: 24 | 30 | 60;
  /** Duração derivada das tracks, em segundos. */
  duration: number;

  /** Modo do palco: tela única ou split vertical (top/bottom). */
  stageMode: 'single' | 'split-vertical';
  /** Razão da divisão vertical em modo split (0.0 - 1.0, default 0.5). */
  splitRatio: number;
  /**
   * Cor de fundo do palco (área visível atrás dos vídeos / em volta).
   * Hex CSS, default `#000000` (preto). Customizável em Settings.
   */
  stageBackground?: string;

  /** Sobreposições habilitadas no projeto (preview + exportação). */
  overlays?: {
    logo: boolean;
    footer: boolean;
    ending: boolean;
  };

  /**
   * Parâmetros da IDENTIDADE VISUAL do gabinete (aditivo/opcional — projetos
   * antigos sem o campo usam os defaults, ver `DEFAULT_IDENTITY`).
   *
   * Regras que o render aplica quando `overlays` está ligado:
   * - logo no topo-direito, `logoWidthPct`% da largura, some em fade ANTES da
   *   vinheta (fade de 0,4s terminando 0,1s antes do fim do conteúdo);
   * - rodapé embaixo, `footerWidthPct`% da largura, ATRAVESSA a vinheta e some
   *   em fade de 1s apenas no fim do vídeo completo;
   * - vinheta: corta `endingTrimStart`s do início (tela preta) e aplica
   *   fade-in de `endingAudioFadeIn`s no áudio dela (mata riser);
   * - ordem Z: identidade fica ACIMA de tudo (mídia, overlays e legendas).
   */
  identity?: ProjectIdentity;

  /**
   * Fator ACUMULADO de velocidade global aplicado ao projeto (informativo).
   * Ex.: 1.14 = a fala foi acelerada 14% via "Velocidade da fala".
   * A vinheta de encerramento NUNCA acelera com este fator.
   */
  speechRate?: number;

  /** Modelo opcional `Stage` (doc 04 — fallback p/ split arbitrário). */
  stages?: Stage[];

  assets: MediaAsset[];
  tracks: Track[];
  captionTracks: CaptionTrack[];

  audioMaster: {
    volume: number;
    muted: boolean;
  };

  /**
   * Se o projeto foi criado a partir de um vídeo de Recortes, guarda
   * a referência para permitir "Substituir original" no Export.
   */
  originRecorte?: {
    folderId: string;
    videoId: string;
    name?: string;
    /** filePath do vídeo original — usado pra apagar arquivo antigo no replace. */
    originalFilePath?: string;
  };
}

/**
 * Parâmetros da identidade visual (logo/rodapé/vinheta) do projeto.
 * Todos opcionais — ausência cai nos defaults do gabinete.
 */
export interface ProjectIdentity {
  /** Largura do logo em % da largura do vídeo (default 44). */
  logoWidthPct?: number;
  /** Largura do rodapé em % da largura do vídeo (default 97). */
  footerWidthPct?: number;
  /** Segundos cortados do INÍCIO da vinheta (tela preta / riser). Default 0. */
  endingTrimStart?: number;
  /** Fade-in do ÁUDIO da vinheta, em segundos (default 0.6). */
  endingAudioFadeIn?: number;
}

/** Defaults da identidade do gabinete (produção real ago/2026). */
export const DEFAULT_IDENTITY: Required<ProjectIdentity> = {
  logoWidthPct: 44,
  footerWidthPct: 97,
  endingTrimStart: 0,
  endingAudioFadeIn: 0.6,
};

/**
 * Preset de resolução. Mantido como interface aberta para suportar
 * formatos adicionais além dos canônicos (1080p, 720p, 1:1, 9:16, 4:5).
 */
export interface ResolutionPreset {
  width: number;
  height: number;
  label: string;
}

/**
 * Modelo `Stage` para split-screen genérico (doc 04, seção H).
 *
 * Para o protótipo, `stageMode + splitRatio` em VideoProject já cobre o caso
 * vertical. `Stage[]` permite split arbitrário no futuro (PiP, 4-way etc.).
 */
export interface Stage {
  id: string;
  /** Posição relativa (% do canvas final). */
  bounds: {
    xPct: number;
    yPct: number;
    widthPct: number;
    heightPct: number;
  };
  /** Máscara opcional (clip-path CSS). */
  clipPath?: string;
  /** Ordem de empilhamento. */
  zIndex: number;
}

// ============================================================================
// Asset
// ============================================================================

/**
 * Mídia importada (vídeo, áudio ou imagem).
 *
 * No protótipo, `source: 'local-blob'` é aceito (downloadUrl é blob: URL).
 * Em produção, `source: 'firebase'` com storagePath + downloadUrl persistente.
 */
export interface MediaAsset {
  id: string;
  name: string;
  type: 'video' | 'image' | 'audio';
  source: 'firebase' | 'local-blob';
  /** Path no Firebase Storage (apenas se source === 'firebase'). */
  storagePath?: string;
  /** URL para reproduzir no browser. Pode ser blob: URL no protótipo. */
  downloadUrl: string;
  /** Tamanho em bytes. */
  size: number;
  /** Duração em segundos (apenas video/audio). */
  duration?: number;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  status: 'uploading' | 'ready' | 'error';
  /** 0-100 enquanto status === 'uploading'. */
  uploadProgress?: number;
  createdAt: Timestamp;
  /**
   * Presente quando o asset é um CLIP DE TEXTO (asset sintético): o PNG em
   * `downloadUrl`/`storagePath` foi gerado a partir desta especificação
   * (client-side, canvas). Editar o texto = regenerar o PNG e substituir o
   * arquivo. Campo aditivo — assets comuns não o possuem.
   */
  text?: TextAssetSpec;
}

/**
 * Especificação de um clip de TEXTO (palavra empilhável estilo cartaz —
 * "IPTU", "CONTA DE LUZ"... com som de erro acoplado).
 */
export interface TextAssetSpec {
  /** Conteúdo (aceita quebras de linha). */
  content: string;
  /** Fonte (default 'Arial Black'). */
  fontFamily: string;
  /** Cor do texto (hex). */
  color: string;
  /** Cor do contorno (hex). */
  strokeColor: string;
  /** Espessura do contorno em % do tamanho da fonte (0 = sem contorno). */
  strokePct: number;
  /** Sombra dura deslocada (estilo cartaz). */
  shadow: boolean;
  /** Largura máxima do texto em % da largura do palco (auto-ajuste). */
  maxWidthPct: number;
  /** Tamanho manual da fonte em % da largura do palco; ausente = auto. */
  fontSizePct?: number;
}

// ============================================================================
// Track
// ============================================================================

/**
 * Faixa horizontal da timeline. Tracks de vídeo coexistem verticalmente e o
 * z-order é dado por `index` (maior fica por cima).
 *
 * Tracks de áudio têm `solo` separado de `muted` (NLE clássico).
 */
export interface Track {
  id: string;
  type: 'video' | 'audio';
  name: string;
  /** 0 = mais embaixo. Maior z-index = mais em cima. */
  index: number;
  muted: boolean;
  locked: boolean;
  /** Olho liga/desliga o preview (só visual; áudio ainda toca). */
  visible: boolean;
  /** Solo (apenas tracks de áudio respeitam). */
  solo: boolean;
  /** Altura em px na timeline (default 64). */
  height: number;
  clips: Clip[];
  /**
   * Número de CAMADAS (subtracks) dentro desta track de vídeo. Cada camada é
   * uma sub-lane horizontal que empilha clips com z-order próprio dentro da
   * mesma track (ex.: vídeo de base na camada 0 + PiP/overlay nas camadas
   * acima). `clip.layer` indexa a camada (0 = base / mais embaixo).
   *
   * Ausente ou `1` = track tradicional de uma única camada (comportamento
   * 100% idêntico ao anterior). Só relevante para tracks de vídeo; tracks de
   * áudio ignoram (mixagem soma tudo independente de camada).
   *
   * O valor efetivo de camadas é `max(layerCount ?? 1, maxClipLayer + 1)` —
   * assim clips com `layer` alto nunca ficam órfãos, mesmo sem este campo.
   */
  layerCount?: number;

  /**
   * PALCO ao qual esta track de VÍDEO pertence quando o projeto é
   * `stageMode: 'split-vertical'`:
   *   - `'top'`    → palco superior;
   *   - `'bottom'` → palco inferior;
   *   - ausente    → sem palco (modo single, track "tela cheia" que cobre os
   *                  dois palcos, ou tracks de áudio/legenda — compartilhadas).
   *
   * É a FONTE DA VERDADE da posição no palco: em split, `clip.slot` deriva do
   * `stageSlot` da track que contém o clip (track top → clip.slot 'top', etc.).
   * Áudio/legenda NUNCA recebem `stageSlot` (o som/legenda é único pros dois
   * palcos). Aditivo/opcional: projetos antigos sem o campo são normalizados no
   * load (`normalizeSplitTracks`).
   */
  stageSlot?: 'top' | 'bottom';
}

// ============================================================================
// Clip
// ============================================================================

/**
 * Segmento de mídia colocado numa track.
 *
 * Tempo:
 * - `startInTimeline` / `endInTimeline`: posição na timeline do projeto (s).
 * - `startInAsset` / `endInAsset`: trim dentro do asset original (s).
 *
 * Slot controla a posição vertical no palco quando `stageMode === 'split-vertical'`:
 * - `full`: ocupa as duas metades.
 * - `top`: apenas metade superior.
 * - `bottom`: apenas metade inferior.
 *
 * Em `stageMode === 'single'`, slot é preservado mas tratado como `full` no
 * preview.
 */
export interface Clip {
  id: string;
  assetId: string;
  /** Redundante com track.clips, mas útil para drag entre tracks. */
  trackId: string;

  startInTimeline: number;
  endInTimeline: number;
  startInAsset: number;
  endInAsset: number;

  /** Posição vertical no palco (full | top | bottom). */
  slot: 'full' | 'top' | 'bottom';

  /**
   * CAMADA (subtrack) dentro da track de vídeo, 0 = base / mais embaixo.
   * Camadas maiores ficam por cima no preview e no render (overlay
   * empilhado). Ausente = `0` (comportamento tradicional, uma camada só).
   *
   * Só tem efeito em tracks de vídeo. Não afeta tracks de áudio.
   */
  layer?: number;

  /**
   * Como a mídia preenche a sua caixa — o palco em `'full'`, ou a banda do
   * slot em `'top'`/`'bottom'`:
   * - `'contain'` (default): mostra o vídeo INTEIRO; se a proporção diferir
   *   da caixa, sobram barras. NUNCA corta.
   * - `'cover'`: PREENCHE a caixa cortando o excesso (sem barras).
   *
   * Ausente = `'contain'` (retrocompat). Controlado no Inspector (Encaixe).
   */
  fit?: 'contain' | 'cover';

  /** Velocidade de reprodução (0.25 a 4.0, default 1). */
  playbackRate: number;

  transform: ClipTransform;
  filters: ClipFilters;
  audio: ClipAudio;
  /** Chroma key (remoção de fundo por cor). Opcional. */
  chromaKey?: ClipChromaKey;

  transitionIn?: TransitionConfig;
  transitionOut?: TransitionConfig;

  keyframes?: Keyframe[];

  /** Bloqueia edição do clip. */
  locked: boolean;
  /** Esconde do preview e do export. */
  hidden: boolean;
}

/**
 * Transform aplicado ao clip dentro do slot que ele ocupa.
 *
 * `x/y` são relativos ao centro do slot (-1 a 1).
 * `anchorX/Y` em coordenadas relativas do próprio clip (0-1, default 0.5).
 */
export interface ClipTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  /** 0-1. */
  opacity: number;
  /** Anchor point X (0-1, default 0.5). */
  anchorX: number;
  /** Anchor point Y (0-1, default 0.5). */
  anchorY: number;
  /** Espelha horizontalmente. */
  flipH: boolean;
  /** Espelha verticalmente. */
  flipV: boolean;
}

/**
 * Filtros visuais aplicados ao clip.
 *
 * `brightness/contrast/saturation`: 0-2, default 1 (sem efeito).
 * `blur`: pixels.
 * `hue`: graus -180..180.
 * `grayscale`: 0-1 (intensidade do dessaturado).
 */
export interface ClipFilters {
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
  hue: number;
  grayscale: number;
}

/**
 * Configuração de chroma key (remover fundo de cor) por clip.
 *
 * - `color`: cor de fundo a remover (hex, default verde).
 * - `similarity`: 0..1, tolerância da cor (quão "perto" do verde já é removido).
 * - `smoothness`: 0..1, suavização da borda (anti-aliasing).
 * - `spillSuppression`: 0..1, reduz tinta residual de verde nas bordas.
 */
export interface ClipChromaKey {
  enabled: boolean;
  color: string;
  similarity: number;
  smoothness: number;
  spillSuppression: number;
  /**
   * Motor de processamento:
   *  - `webgl`: GPU local em tempo real (default, fluido pra preview).
   *  - `canvas2d`: CPU local (fallback se WebGL indisponível).
   *  - `cloud`: Preview via WebGL, mas durante EXPORT usa ffmpeg
   *    chromakey no servidor (melhor qualidade no render final).
   */
  engine: 'webgl' | 'canvas2d' | 'cloud';
}

export const DEFAULT_CHROMA_KEY: ClipChromaKey = {
  enabled: false,
  color: '#00b140',
  similarity: 0.4,
  smoothness: 0.1,
  spillSuppression: 0.2,
  engine: 'webgl',
};

/**
 * Configuração de áudio do clip.
 *
 * `volume`: 0-2 (>1 amplifica).
 * `pan`: -1 (esquerda) a 1 (direita).
 * `fadeInDuration` / `fadeOutDuration`: segundos.
 */
export interface ClipAudio {
  volume: number;
  muted: boolean;
  fadeInDuration: number;
  fadeOutDuration: number;
  pan: number;
}

/**
 * "Ajustes" de um clip — o conjunto de propriedades de aparência/áudio/velocidade
 * que podem ser copiadas de um clip e coladas em outro(s) (estilo "Colar
 * atributos" do Premiere).
 *
 * Inclui só o que é independente de posição/timing: NÃO entram start/end,
 * assetId, trackId, slot/layer (posicionais), transitions (geminadas por par),
 * keyframes (atrelados ao clip) nem locked/hidden.
 */
export interface ClipAdjustments {
  transform: ClipTransform;
  filters: ClipFilters;
  audio: ClipAudio;
  fit?: 'contain' | 'cover';
  chromaKey?: ClipChromaKey;
  playbackRate: number;
}

// ============================================================================
// Transição
// ============================================================================

export interface TransitionConfig {
  type: TransitionType;
  /** Duração em segundos. Limitada a min(clipA.duration, clipB.duration) / 2. */
  duration: number;
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
}

export type TransitionType =
  | 'fade'
  | 'crossfade'
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down'
  | 'zoom-in'
  | 'zoom-out'
  | 'wipe-left'
  | 'wipe-right'
  | 'push-left'
  | 'push-right'
  | 'circle'
  | 'iris';

// ============================================================================
// Keyframes
// ============================================================================

export interface Keyframe {
  id: string;
  /** Tempo absoluto no projeto (s). */
  time: number;
  property: 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'volume';
  value: number;
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
}

// ============================================================================
// Legendas (SEM IA)
// ============================================================================

export interface CaptionTrack {
  id: string;
  name: string;
  /** Ordem entre caption tracks (0 mais embaixo). */
  index: number;
  visible: boolean;
  locked: boolean;
  /** ISO 639-1, ex: 'pt', 'en', 'pt-BR'. */
  language?: string;
  cues: CaptionCue[];
  /**
   * Origem da track (default `manual` para retrocompat).
   * `imported` = veio de .srt/.vtt; `ai` = gerada pelo Cloud Function via Gemini;
   * `transcribed` = transcrição local (STT no navegador, sem IA paga).
   */
  source?: 'manual' | 'imported' | 'ai' | 'transcribed';
  /** ID do `CaptionGenerationJob` que gerou esta track (apenas se `source === 'ai'`). */
  aiJobId?: string;
}

export interface CaptionCue {
  id: string;
  startTime: number;
  endTime: number;
  /** Pode conter \n para múltiplas linhas. */
  text: string;
  /** Posição vertical conforme stageMode. */
  slot: 'full' | 'top' | 'bottom';
  style: CaptionStyle;
}

/**
 * Estilo visual aplicado a um cue.
 *
 * Tamanhos em px no canvas final (1920×1080). Preview escala por proporção
 * (`fontSize * (stageHeight / 1080)`).
 */
export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: 400 | 500 | 600 | 700;
  /** Cor do texto, hex. */
  color: string;
  /** Cor de fundo, hex com alpha. Ex: '#000000B3'. */
  backgroundColor: string;
  align: 'left' | 'center' | 'right';
  position: 'top' | 'center' | 'bottom';
  /**
   * Ajuste fino de posição vertical em % da altura do palco (-50 a +50).
   * Aplicado SOBRE a `position` base. Default 0 (sem ajuste).
   *
   * Ex: `position: 'bottom'` + `offsetY: -10` = 10% acima do bottom.
   */
  offsetY?: number;
  paddingX: number;
  paddingY: number;
  borderRadius: number;
  /** Outline/contorno opcional. */
  outlineColor?: string;
  outlineWidth?: number;
  /** Sombra opcional. */
  shadowColor?: string;
  shadowBlur?: number;
  // --------------------------------------------------------------------------
  // Campos aditivos (todos OPCIONAIS p/ retrocompat com cues no Firestore).
  // Cues antigos não os possuem — overlay e ASS aplicam fallback.
  // --------------------------------------------------------------------------
  /** Transformação do texto. `uppercase` deixa tudo MAIÚSCULO. Default `none`. */
  textTransform?: 'none' | 'uppercase';
  /** Espaçamento entre letras em px @1080 (escala junto com fontSize). Default 0. */
  letterSpacing?: number;
  /** Altura de linha (multiplicador). Default 1.25. */
  lineHeight?: number;
  /** Largura máxima da caixa de legenda em % da largura do palco (10-100). Default 88. */
  maxWidthPct?: number;
}

// ============================================================================
// Render Job
// ============================================================================

/**
 * Tier de recursos da Cloud Function que processa o render.
 *
 * - `low`: 1 vCPU / 1 GiB / 300s — vídeos curtos (<30s, <50MB).
 * - `medium`: 2 vCPU / 2 GiB / 540s — médios (<2min, <200MB).
 * - `high`: 4 vCPU / 4 GiB / 540s — pesados ou complexos (default).
 *
 * Selecionado pelo client com `selectRenderTier(project, settings)`. Cada
 * tier é uma Cloud Function separada — evita over-provisioning em jobs
 * pequenos (economia de $).
 */
export type RenderTier = 'low' | 'medium' | 'high';

export interface RenderJob {
  id: string;
  projectId: string;
  ownerUid: string;
  /** Engine de render: cliente (wasm) ou servidor (Cloud Function FFmpeg). */
  engine: 'ffmpeg-wasm' | 'cloud-ffmpeg';
  /** Tier de recursos da Cloud Function (apenas cloud). Default: 'high'. */
  tier?: RenderTier;
  status: 'pending' | 'rendering' | 'complete' | 'error' | 'cancelled';
  /** 0-100. */
  progress: number;
  exportSettings: ExportSettings;
  /** Path no Storage (apenas cloud). */
  outputPath?: string;
  /** URL final (download). */
  outputUrl?: string;
  /** Path da CAPA no Storage (`renders/{uid}/{jobId}-thumb.jpg`), gerada pós-render. */
  thumbnailPath?: string;
  /** URL pública (token) da capa — exibida como thumbnail na lista de renders. */
  thumbnailUrl?: string;
  /** ID do vídeo salvo em recortes (apenas se destinationFolderId ou replaceVideoId). */
  savedVideoId?: string;
  error?: string;
  /** ID da pasta de recortes onde salvar o vídeo renderizado (apenas cloud, modo "nova cópia"). */
  destinationFolderId?: string;
  /** ID do vídeo existente a substituir em recortes (modo "substituir original"). */
  replaceVideoId?: string;
  /** ID da pasta do vídeo a substituir (precisa junto com replaceVideoId). */
  replaceFolderId?: string;
  createdAt: Timestamp;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  /**
   * Timestamp para auto-delete via TTL nativo do Firestore (default: now + 14 dias).
   * Quando o doc eh apagado, o trigger `onRenderJobDeleted` remove tambem
   * o arquivo do Storage em `outputPath`.
   */
  expiresAt?: Timestamp;
}

export interface ExportSettings {
  resolution: '1080p' | '720p' | '480p';
  format: 'mp4' | 'webm';
  /** Bitrate em kbps. Se omitido, usa preset baseado em quality. */
  bitrate?: number;
  quality: 'low' | 'medium' | 'high';
  /**
   * Se `true`, queima as legendas no vídeo (subtitles filter).
   * Se `false`, anexa trilha de subtitle separada (mov_text ou .srt).
   */
  burnCaptions: boolean;
  /** Adiciona logo no canto superior direito (usa videoLogoUrl de configs/main). */
  includeLogo?: boolean;
  /** Adiciona rodapé na parte inferior (usa videoFooterUrl de configs/main). */
  includeFooter?: boolean;
  /** Concatena vinheta de encerramento ao final (usa videoEncerramentoUrl de configs/main). */
  includeEnding?: boolean;
}

// ============================================================================
// Estado do editor (UI/ephemeral — NÃO vai ao Firestore)
// ============================================================================

/**
 * Estado UI do editor. Vive apenas em memória (e opcionalmente em
 * localStorage para preferências). NÃO é persistido no Firestore.
 */
export interface EditorUIState {
  selectedClipIds: string[];
  selectedCueIds: string[];
  selectedTrackId: string | null;
  /** Tempo atual em segundos. */
  playhead: number;
  isPlaying: boolean;
  isLooping: boolean;
  loopRange?: { start: number; end: number };
  /** Zoom da timeline em px/segundo. */
  zoom: number;
  tool: 'select' | 'blade' | 'hand';
  snapEnabled: boolean;
  /** Threshold do snap em px (default 5). */
  snapThresholdPx: number;
  inspectorTab:
    | 'transform'
    | 'filters'
    | 'audio'
    | 'speed'
    | 'transitions'
    | 'caption';
  exportDialogOpen: boolean;
  isDragging: boolean;
  /** Última vez que o projeto foi salvo (auto-save). */
  lastSavedAt?: Date | null;
  /** True enquanto o auto-save está em andamento. */
  isSaving?: boolean;
  /** Marca que o último save falhou (offline / permission). */
  saveError?: string | null;
}

// ============================================================================
// Helpers / DTO
// ============================================================================

/**
 * Input para `createProject` no store.
 */
export interface NewProjectInput {
  name: string;
  resolution: ResolutionPreset;
  frameRate: 24 | 30 | 60;
  stageMode?: 'single' | 'split-vertical';
}
