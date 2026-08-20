/**
 * Store Zustand do Suite Editor de Vídeos.
 *
 * Especificação: docs/editor/02_PROTOTYPE_SPEC.md (seção "5. Actions do store").
 * Stack: docs/editor/04_TECH_STACK.md (seção G — zustand + immer + zundo).
 *
 * Estrutura:
 * - Slice `project: VideoProject | null` — documento (vai ao Firestore).
 * - Slice `ui: EditorUIState` — efêmero, NÃO entra no histórico.
 * - Slice `renderJobs: RenderJob[]` — exports em andamento.
 *
 * Middlewares:
 * - `immer`: mutações imutáveis com sintaxe direta.
 * - `temporal` (zundo): undo/redo com `partialize` para limitar ao `project`.
 * - `persist` opcional: preferências UI (zoom, tool, snap).
 *
 * Convenções:
 * - Actions marcadas `(no-history)` no spec → usam `pause/resume` do zundo
 *   ou simplesmente alteram apenas `ui` (que está fora do partialize).
 * - Crud de clip/track/asset/caption: alteram `project` → entram no histórico.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { temporal } from 'zundo';
import type { TemporalState } from 'zundo';

import { GABINETE_CAPTION_STYLE } from './captions/presets';
import { resolveCueCollisions, splitCueByWords } from './captions/utils';
import type {
  VideoProject,
  ProjectIdentity,
  EditorUIState,
  MediaAsset,
  Track,
  Clip,
  ClipTransform,
  ClipFilters,
  ClipAudio,
  ClipChromaKey,
  ClipAdjustments,
  TransitionConfig,
  TransitionType,
  Keyframe,
  CaptionTrack,
  CaptionCue,
  CaptionStyle,
  RenderJob,
  ResolutionPreset,
  ExportSettings,
  NewProjectInput,
} from './types';
// (o "encaixe na banda" agora é resolvido no layout/`object-fit` do layer —
//  ver `slotBox` em preview-utils e `clip.fit`; não bakeamos mais transform.)

// ============================================================================
// Util: id gen / clamp / find helpers
// ============================================================================

/** Gera id curto (suficiente p/ runtime; ids canônicos vêm do Firestore). */
function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Primeiro início >= `desejado` em que um clip de duração `duracao` NÃO
 * sobrepõe nenhum dos `outros` (clips da MESMA track+camada, exceto o próprio).
 * Em conflito, empurra para logo após o clip conflitante e repete — assim dois
 * clips nunca ocupam o mesmo tempo na mesma camada, e ao adicionar/mover sobre
 * uma área ocupada o clip encaixa EM SEQUÊNCIA (um após o outro), em vez de
 * empilhar no mesmo tempo.
 */
function inicioSemSobreposicao(
  outros: { startInTimeline: number; endInTimeline: number }[],
  desejado: number,
  duracao: number,
): number {
  let start = Math.max(0, desejado);
  // `start` só cresce (até o fim do último conflito), então converge; o teto
  // de iterações é só salvaguarda contra dados inconsistentes.
  for (let i = 0; i < 500; i++) {
    const conflito = outros.find(
      (c) => start < c.endInTimeline && start + duracao > c.startInTimeline,
    );
    if (!conflito) break;
    start = conflito.endInTimeline;
  }
  return start;
}

/** Encontra clip + track owner em qualquer track do projeto. */
function findClip(
  project: VideoProject,
  clipId: string,
): { track: Track; clip: Clip } | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

/** Encontra cue + caption-track owner. */
function findCue(
  project: VideoProject,
  cueId: string,
): { track: CaptionTrack; cue: CaptionCue } | null {
  for (const track of project.captionTracks) {
    const cue = track.cues.find((c) => c.id === cueId);
    if (cue) return { track, cue };
  }
  return null;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_TRANSFORM: ClipTransform = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
  anchorX: 0.5,
  anchorY: 0.5,
  flipH: false,
  flipV: false,
};

const DEFAULT_FILTERS: ClipFilters = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  blur: 0,
  hue: 0,
  grayscale: 0,
};

const DEFAULT_AUDIO: ClipAudio = {
  volume: 1,
  muted: false,
  fadeInDuration: 0,
  fadeOutDuration: 0,
  pan: 0,
};

const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'Inter',
  fontSize: 36,
  fontWeight: 600,
  color: '#FFFFFF',
  backgroundColor: '#000000B3',
  align: 'center',
  position: 'bottom',
  paddingX: 12,
  paddingY: 4,
  borderRadius: 4,
};

const DEFAULT_UI_STATE: EditorUIState = {
  selectedClipIds: [],
  selectedCueIds: [],
  selectedTrackId: null,
  playhead: 0,
  isPlaying: false,
  isLooping: false,
  loopRange: undefined,
  zoom: 80,
  tool: 'select',
  snapEnabled: true,
  snapThresholdPx: 5,
  inspectorTab: 'transform',
  exportDialogOpen: false,
  isDragging: false,
  lastSavedAt: null,
  isSaving: false,
  saveError: null,
};

// ============================================================================
// State e Actions
// ============================================================================

interface State {
  /** Documento do projeto (null antes de loadProject). */
  project: VideoProject | null;
  /** Estado UI/efêmero (NÃO entra no histórico de undo). */
  ui: EditorUIState;
  /** Jobs de export ativos. */
  renderJobs: RenderJob[];
  /**
   * Clipboard interno do editor (copy/paste de clip via Ctrl+C/V).
   * Guarda o snapshot do clip "fonte"; o paste cria um clip novo a partir
   * dele. Vive fora do `project` (não vai pro Firestore nem pro histórico).
   */
  clipboard: { clip: Clip } | null;
  /**
   * Clipboard de "ajustes" (estilo "Colar atributos" do Premiere): guarda um
   * snapshot por valor de transform/filters/audio/fit/chromaKey/playbackRate
   * de um clip, para colar em outro(s) clip(s) já existentes. Vive fora do
   * `project` (não vai pro Firestore nem pro histórico).
   */
  adjustmentsClipboard: ClipAdjustments | null;
}

interface Actions {
  // ---- 5.1 Projeto -------------------------------------------------------
  /** Hidrata o store com um projeto já carregado (no-history). */
  loadProject: (project: VideoProject) => void;
  /** Cria um projeto novo em memória (no-history; persistência é externa). */
  createProject: (input: NewProjectInput, ownerUid: string) => string;
  /** Hook para persistir no Firestore. Implementação fica no caller. */
  saveProject: () => Promise<void>;
  setProjectName: (name: string) => void;
  setResolution: (preset: ResolutionPreset) => void;
  setFrameRate: (fps: 24 | 30 | 60) => void;
  setStageMode: (mode: 'single' | 'split-vertical') => void;
  setStageBackground: (color: string) => void;
  /** Clamp 0.1 - 0.9. */
  setSplitRatio: (ratio: number) => void;
  setOverlays: (patch: Partial<NonNullable<VideoProject['overlays']>>) => void;
  /** Patch parcial dos parâmetros de identidade (logo/rodapé/vinheta). */
  setIdentity: (patch: Partial<ProjectIdentity>) => void;
  /**
   * Preset "Identidade do Gabinete" em 1 clique: liga logo+rodapé+vinheta e
   * aplica os parâmetros padrão do gabinete (logo 44%, rodapé 97%, fade de
   * áudio 0,6s na vinheta). Não sobrescreve trim já configurado.
   */
  applyGabineteIdentity: () => void;
  /**
   * VELOCIDADE GLOBAL do projeto (velocidade da fala): re-encoda a base
   * (playbackRate) e REMAPEIA a timeline inteira — port do algoritmo do
   * `_prep_xfade.py` da produção real:
   * - clips da track BASE (vídeo de menor index, camada 0): rate *= F e
   *   tempos comprimidos por F;
   * - imagens (qualquer camada): início/fim divididos por F (acompanham a
   *   fala);
   * - vídeos/áudios sobrepostos: só o INÍCIO desloca (/F); duração natural
   *   preservada (não re-aceleram);
   * - trilha (áudio cobrindo >=85% do projeto): comprime junto;
   * - legendas e keyframes: tempos divididos por F.
   * A vinheta de encerramento NUNCA acelera (é aplicada no export).
   * Devolve false se não há projeto/base. F aceito: 0.5–2.0.
   */
  applyGlobalSpeed: (factor: number) => boolean;

  // ---- 5.2 Assets --------------------------------------------------------
  /** Adiciona um asset já-pronto (upload/parse de arquivo é externo). */
  addAsset: (asset: MediaAsset) => void;
  /** Remove se nenhum clip o referencia; senão noop (caller checa antes). */
  removeAsset: (assetId: string) => void;
  /** Patch parcial de um asset (rename, thumbnail definitivo, status). */
  updateAsset: (assetId: string, patch: Partial<MediaAsset>) => void;
  setAssetUploadProgress: (assetId: string, progress: number) => void;

  // ---- 5.3 Tracks --------------------------------------------------------
  addTrack: (type: 'video' | 'audio', name?: string) => string;
  /**
   * Adiciona OUTRA track de vídeo dentro de um palco (split-vertical). A nova
   * track herda o `stageSlot` do palco; clips nela nascem com aquele slot.
   * Retorna o id. Noop fora de split.
   */
  addStageTrack: (slot: 'top' | 'bottom') => string | null;
  removeTrack: (trackId: string) => void;
  renameTrack: (trackId: string, name: string) => void;
  reorderTracks: (trackId: string, newIndex: number) => void;
  toggleTrackMute: (trackId: string) => void;
  setTrackMuted: (trackId: string, muted: boolean) => void;
  setTrackLocked: (trackId: string, locked: boolean) => void;
  setTrackVisible: (trackId: string, visible: boolean) => void;
  setTrackSolo: (trackId: string, solo: boolean) => void;
  setTrackHeight: (trackId: string, px: number) => void;
  /**
   * Opções de TRILHA de uma track de áudio: volume em % (gainPct),
   * nivelamento de dinâmica (audioLeveling, export), fades automáticos
   * (autoFade, export) e a mixagem VOZ-PRIMEIRO (voiceEq / voiceDuck,
   * export). Patch parcial.
   */
  setTrackAudioOptions: (
    trackId: string,
    patch: Partial<
      Pick<
        Track,
        'gainPct' | 'audioLeveling' | 'autoFade' | 'voiceEq' | 'voiceDuck'
      >
    >,
  ) => void;

  // ---- 5.3b Subtracks / Camadas (só tracks de vídeo) ---------------------
  /**
   * Adiciona uma CAMADA (subtrack) vazia no TOPO da track de vídeo. Cada
   * camada empilha clips com z-order próprio dentro da mesma track. Retorna
   * o índice da nova camada (0 = base). Noop em track de áudio/locked.
   */
  addSubtrack: (trackId: string) => number | null;
  /**
   * Remove a camada `layer` da track: apaga os clips dessa camada e
   * "rebaixa" as camadas acima (layer-1). Não permite remover a última
   * camada (uma track sempre tem ao menos a camada 0).
   */
  removeSubtrack: (trackId: string, layer: number) => void;
  /** Move um clip para outra camada DENTRO da mesma track. */
  moveClipToLayer: (clipId: string, layer: number) => void;

  // ---- 5.4 Clips ---------------------------------------------------------
  /** Adiciona um Clip já-pronto a uma track (mais flexível). */
  addClip: (trackId: string, clip: Clip) => void;
  /**
   * Adiciona clip a partir de assetId + tempo (cria o clip default).
   * `layer` opcional define a CAMADA (subtrack) de destino (default 0).
   */
  addClipFromAsset: (
    assetId: string,
    trackId: string,
    atTime: number,
    layer?: number,
  ) => string | null;
  /**
   * Adiciona um clip de mídia diretamente num SLOT do palco (top/bottom/full),
   * usado pelo drag-drop nos `StageSlot` do preview.
   *
   * Comportamento:
   * - `slot === 'top' | 'bottom'` força `stageMode === 'split-vertical'` (para
   *   que as duas bandas existam) e garante DUAS tracks de vídeo dedicadas
   *   (superior e inferior), criando-as se não existirem.
   * - `slot === 'full'` usa/garante uma track de vídeo comum.
   * - Cria o clip default na track do slot, marca `clip.slot` e define
   *   `clip.fit` (`'cover'` em top/bottom — preenche a banda; `'contain'` em
   *   full). O encaixe é resolvido no layout do layer (caixa da banda +
   *   `object-fit`), não mais por transform bakeado.
   *
   * Retorna o id do clip criado, ou null se o asset for incompatível
   * (ex.: áudio puro não tem camada visual) / não existir.
   */
  addClipToSlot: (
    assetId: string,
    slot: 'full' | 'top' | 'bottom',
    atTime?: number,
  ) => string | null;
  removeClip: (clipId: string) => void;
  /** Move clip horizontal (newStart) e/ou vertical (newTrackId). */
  moveClip: (
    clipId: string,
    newStart: number,
    newTrackId?: string,
  ) => void;
  /** Trim de uma das pontas. */
  trimClip: (
    clipId: string,
    side: 'left' | 'right',
    newTime: number,
  ) => void;
  /** Split em `atTime`. Retorna [idA, idB] ou null se inválido. */
  splitClip: (clipId: string, atTime: number) => [string, string] | null;
  /**
   * "Remover aperto de tela": corta `seconds` do FIM do clip e PUXA tudo
   * que vem depois (todas as tracks + legendas) para trás — ripple delete
   * do rabo. É o corte de junção do fluxo do gabinete (sempre depois da
   * última palavra do bloco). Devolve false se o corte não couber.
   */
  trimClipTail: (clipId: string, seconds: number) => boolean;
  /**
   * Aplica XFADE nas JUNÇÕES da track: para cada par de clips consecutivos
   * (camada 0), sobrepõe o par em `duration`s (puxando tudo que vem depois)
   * e marca transitionOut/In como crossfade — no export vira xfade de vídeo
   * + acrossfade de áudio, como na base do corte aprovado. Devolve o nº de
   * junções tratadas.
   */
  applyCrossfadeAtJunctions: (trackId: string, duration?: number) => number;
  duplicateClip: (clipId: string) => string | null;
  /**
   * Copia o clip atualmente selecionado (primeiro de `selectedClipIds`)
   * para o clipboard interno. Retorna `true` se houve algo para copiar.
   * (no-history)
   */
  copySelectedClip: () => boolean;
  /**
   * Cola o último clip copiado em uma track no tempo desejado. Se
   * `trackId` ou `atTime` não forem informados, usa a track do clip
   * original (ou primeira compatível) e o playhead atual.
   * Retorna o id do novo clip ou null.
   */
  pasteClip: (trackId?: string, atTime?: number) => string | null;
  /** Remove todos os clips atualmente selecionados. (no-history p/ seleção) */
  removeSelectedClip: () => void;
  /**
   * Copia os "ajustes" (transform/filters/audio/fit/chromaKey/playbackRate) de
   * um clip para o `adjustmentsClipboard`. Se `clipId` omitido, usa o primeiro
   * de `selectedClipIds`. Retorna `true` se houve algo para copiar.
   * (no-history — clipboard é UI-só.)
   */
  copiarAjustes: (clipId?: string) => boolean;
  /**
   * Aplica os ajustes do `adjustmentsClipboard` em clips existentes. Se
   * `clipIds` omitido, usa `selectedClipIds`. Pula clips travados (e em tracks
   * travadas). Retorna a contagem de clips efetivamente afetados. Entra no
   * histórico (mexe em `project`) como UMA única entrada de undo.
   */
  aplicarAjustes: (clipIds?: string[]) => number;
  setClipSlot: (clipId: string, slot: 'full' | 'top' | 'bottom') => void;
  /**
   * Define como a mídia preenche a caixa do clip:
   * - `'cover'`: preenche o palco/banda, cortando o excesso ("Preencher").
   * - `'contain'`: mostra o vídeo inteiro com barras ("Mostrar tudo").
   */
  setClipFit: (clipId: string, fit: 'contain' | 'cover') => void;
  setClipTransform: (clipId: string, partial: Partial<ClipTransform>) => void;
  setClipFilters: (clipId: string, partial: Partial<ClipFilters>) => void;
  setClipAudio: (clipId: string, partial: Partial<ClipAudio>) => void;
  /** Aplica/atualiza chroma key do clip. */
  setClipChromaKey: (clipId: string, partial: Partial<ClipChromaKey>) => void;
  /**
   * Substitui as janelas de BLUR DE FUNDO do clip (s da timeline, dentro
   * do intervalo do clip). Lista vazia remove o efeito.
   */
  setClipBlurWindows: (
    clipId: string,
    windows: Array<{ start: number; end: number }>,
  ) => void;
  /**
   * Separa o áudio de um clip de vídeo. Cria uma cópia "virtual" do asset
   * marcada como audio, garante existir uma track de áudio, adiciona um
   * clip novo nessa track (mesmo timing) e silencia o áudio do clip de
   * vídeo original. Como Adobe Rush "Detach Audio".
   * Retorna o id do clip de áudio criado, ou null se não aplicável.
   */
  splitAudioFromVideoClip: (clipId: string) => string | null;
  setClipPlaybackRate: (clipId: string, rate: number) => void;
  setClipLocked: (clipId: string, locked: boolean) => void;
  setClipHidden: (clipId: string, hidden: boolean) => void;

  // ---- 5.5 Transições ----------------------------------------------------
  setTransition: (
    clipId: string,
    side: 'in' | 'out',
    config: TransitionConfig | null,
  ) => void;
  applyTransitionBetween: (
    clipAId: string,
    clipBId: string,
    type: TransitionType,
    duration?: number,
  ) => void;
  removeTransition: (clipId: string, side: 'in' | 'out') => void;

  // ---- 5.6 Keyframes -----------------------------------------------------
  addKeyframe: (clipId: string, kf: Omit<Keyframe, 'id'>) => string | null;
  updateKeyframe: (
    clipId: string,
    kfId: string,
    partial: Partial<Keyframe>,
  ) => void;
  removeKeyframe: (clipId: string, kfId: string) => void;

  // ---- 5.7 Legendas ------------------------------------------------------
  addCaptionTrack: (name?: string, language?: string) => string;
  removeCaptionTrack: (trackId: string) => void;
  renameCaptionTrack: (trackId: string, name: string) => void;
  setCaptionTrackVisible: (trackId: string, visible: boolean) => void;
  setCaptionTrackLocked: (trackId: string, locked: boolean) => void;
  /** Marca a origem da track (rótulo na UI: manual/imported/ai/transcribed). */
  setCaptionTrackSource: (
    trackId: string,
    source: CaptionTrack['source'],
  ) => void;
  /** Adiciona cue. Se trackId omitido, usa primeiro caption track existente. */
  addCaption: (
    trackId: string | undefined,
    cue: Omit<CaptionCue, 'id'>,
  ) => string | null;
  updateCaption: (cueId: string, partial: Partial<CaptionCue>) => void;
  moveCaption: (cueId: string, newStart: number) => void;
  resizeCaption: (
    cueId: string,
    side: 'left' | 'right',
    newTime: number,
  ) => void;
  removeCaption: (cueId: string) => void;
  setCaptionStyle: (cueId: string, partial: Partial<CaptionStyle>) => void;
  /**
   * Preset "Gabinete" na track inteira: aplica o estilo aprovado (amarelo
   * Arial bold, contorno preto, MAIÚSCULAS) e REPARTE cada cue em pedaços
   * de até `maxWords` palavras com tempos proporcionais por contagem.
   * Devolve o número de cues resultante (0 = track não encontrada/vazia).
   */
  applyGabineteCaptions: (trackId: string, maxWords?: number) => number;
  /**
   * ANTICOLISÃO (recurso 12): garante que duas legendas nunca dividam o mesmo
   * milissegundo — encurta a anterior deixando 30 ms de folga e, quando não
   * couber, empurra a seguinte. Devolve quantos cues tiveram tempo mexido.
   */
  resolverColisoesLegendas: (trackId: string) => number;
  setCaptionSlot: (cueId: string, slot: 'full' | 'top' | 'bottom') => void;
  /** Importa .srt — parser injetado pelo caller (mantém store puro). */
  importSrt: (
    file: File,
    options?: {
      language?: string;
      trackName?: string;
      /** Parser injetado: file -> array de cues sem id. */
      parser?: (file: File) => Promise<Array<Omit<CaptionCue, 'id'>>>;
    },
  ) => Promise<string | null>;
  /** Exporta uma caption track como Blob .srt. */
  exportSrt: (trackId: string) => Promise<Blob | null>;

  // ---- 5.8 UI / Playback (no-history) -----------------------------------
  /**
   * Atualiza o playhead.
   *
   * @param time tempo em segundos (clamp em 0).
   * @param opts.fromPlayback marca a atualização como vinda do loop de
   *   reprodução (rAF do Video Sync Engine). Componentes que reagem a mudanças
   *   externas do playhead (scrubbing) podem ignorar updates com essa flag,
   *   evitando loops feedback. Não altera comportamento do store em si.
   */
  setPlayhead: (time: number, opts?: { fromPlayback?: boolean }) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setLoopRange: (range: { start: number; end: number } | null) => void;
  setZoom: (pxPerSecond: number) => void;
  setTool: (tool: 'select' | 'blade' | 'hand') => void;
  setSnapEnabled: (enabled: boolean) => void;
  selectClip: (clipId: string | null, multi?: boolean) => void;
  selectCue: (cueId: string | null, multi?: boolean) => void;
  selectTrack: (trackId: string | null) => void;
  setInspectorTab: (tab: EditorUIState['inspectorTab']) => void;
  setExportDialogOpen: (open: boolean) => void;
  setIsDragging: (dragging: boolean) => void;
  clearSelection: () => void;
  /** (no-history) Marca início/fim do auto-save. */
  setSavingState: (saving: boolean) => void;
  /** (no-history) Atualiza timestamp do último save bem-sucedido. */
  setLastSavedAt: (date: Date | null) => void;
  /** (no-history) Registra erro de save (null limpa). */
  setSaveError: (err: string | null) => void;

  // ---- 5.9 Histórico -----------------------------------------------------
  /** Atalhos pra `useEditorStore.temporal.getState()` — ver `editorTemporal`. */
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // ---- 5.10 Export -------------------------------------------------------
  /** Cria entrada de RenderJob localmente (Firestore sync é externo). */
  createRenderJob: (
    settings: ExportSettings,
    engine: RenderJob['engine'],
    ownerUid: string,
  ) => RenderJob | null;
  updateRenderJob: (jobId: string, patch: Partial<RenderJob>) => void;
  cancelRenderJob: (jobId: string) => void;
  removeRenderJob: (jobId: string) => void;
}

type EditorStore = State & Actions;

// ============================================================================
// Store
// ============================================================================

/** Cria uma track de vídeo vazia para um palco (ou tela-cheia se sem slot). */
function novaTrackPalco(
  index: number,
  name: string,
  stageSlot?: 'top' | 'bottom',
): Track {
  return {
    id: genId('track'),
    type: 'video',
    name,
    index,
    muted: false,
    locked: false,
    visible: true,
    solo: false,
    height: 64,
    clips: [],
    stageSlot,
  };
}

/** Slot majoritário dos clips de uma track (null se nenhum top/bottom). */
function inferirSlotDosClips(track: Track): 'top' | 'bottom' | null {
  let top = 0;
  let bottom = 0;
  for (const c of track.clips) {
    if (c.slot === 'top') top++;
    else if (c.slot === 'bottom') bottom++;
  }
  if (top === 0 && bottom === 0) return null;
  return top >= bottom ? 'top' : 'bottom';
}

/**
 * Garante a ESTRUTURA de palco quando `stageMode === 'split-vertical'`:
 *   - migra projetos antigos (sem `stageSlot`): convenção de nome
 *     "Superior"/"Inferior" → top/bottom; senão infere pelo slot majoritário
 *     dos clips; sem pista vira tela-cheia (stageSlot undefined);
 *   - garante ao menos 1 track de vídeo por palco (cria vazias se faltar);
 *   - sincroniza `clip.slot` ao `stageSlot` da track que o contém (a track é a
 *     fonte da verdade da posição); tela-cheia → `full`.
 * Idempotente. Mutates o draft (immer). Em `single`, limpa stageSlot e zera os
 * clips para `full`.
 */
function normalizeSplitTracks(project: VideoProject): void {
  if (project.stageMode !== 'split-vertical') {
    // Single: tracks de vídeo não pertencem a palco; clips são tela-cheia.
    for (const t of project.tracks) {
      if (t.type === 'video') {
        t.stageSlot = undefined;
        for (const c of t.clips) c.slot = 'full';
      }
    }
    return;
  }

  const vids = project.tracks.filter((t) => t.type === 'video');
  const algumComSlot = vids.some((t) => t.stageSlot);
  if (!algumComSlot) {
    for (const t of vids) {
      const nm = t.name.toLowerCase();
      if (nm.includes('superior')) t.stageSlot = 'top';
      else if (nm.includes('inferior')) t.stageSlot = 'bottom';
      else {
        const inf = inferirSlotDosClips(t);
        if (inf) t.stageSlot = inf; // senão segue tela-cheia (undefined)
      }
    }
  }

  // Garante 1 track por palco.
  if (!project.tracks.some((t) => t.type === 'video' && t.stageSlot === 'top')) {
    project.tracks.push(novaTrackPalco(project.tracks.length, 'Palco superior', 'top'));
  }
  if (!project.tracks.some((t) => t.type === 'video' && t.stageSlot === 'bottom')) {
    project.tracks.push(novaTrackPalco(project.tracks.length, 'Palco inferior', 'bottom'));
  }

  // Sincroniza clip.slot ao stageSlot da track (track = fonte da verdade).
  for (const t of project.tracks) {
    if (t.type !== 'video') continue;
    const querido: 'top' | 'bottom' | 'full' = t.stageSlot ?? 'full';
    for (const c of t.clips) c.slot = querido;
  }

  project.tracks.forEach((t, i) => {
    t.index = i;
  });
}

export const useEditorStore = create<EditorStore>()(
  temporal(
    persist(
      immer<EditorStore>((set, get) => ({
        // ----- state ------------------------------------------------------
        project: null,
        ui: { ...DEFAULT_UI_STATE },
        renderJobs: [],
        clipboard: null,
        adjustmentsClipboard: null,

        // ===== 5.1 Projeto ================================================
        loadProject: (project) =>
          set((s) => {
            s.project = project;
            // Normaliza a estrutura de palco (migra projetos antigos, garante
            // 1 track/palco, sincroniza clip.slot). Idempotente.
            normalizeSplitTracks(s.project);
            // Reset UI state ao carregar projeto novo.
            s.ui = { ...DEFAULT_UI_STATE };
          }),

        createProject: (input, ownerUid) => {
          const id = genId('proj');
          // Note: Timestamp do Firestore é cliente-side complicado de mockar;
          // o caller pode sobrescrever createdAt/updatedAt com serverTimestamp().
          const now = { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 } as unknown as VideoProject['createdAt'];
          const project: VideoProject = {
            id,
            name: input.name,
            ownerUid,
            createdAt: now,
            updatedAt: now,
            resolution: input.resolution,
            frameRate: input.frameRate,
            duration: 0,
            stageMode: input.stageMode ?? 'single',
            splitRatio: 0.5,
            assets: [],
            tracks: [],
            captionTracks: [],
            audioMaster: { volume: 1, muted: false },
          };
          set((s) => {
            s.project = project;
            // Split nasce com a estrutura de palco (cria as tracks fixas).
            normalizeSplitTracks(s.project);
            s.ui = { ...DEFAULT_UI_STATE };
          });
          return id;
        },

        saveProject: async () => {
          // Hook — implementação real (Firestore) fica em outro módulo.
          // Mantemos a action no store para que componentes a chamem
          // sem precisar conhecer a infra.
          return Promise.resolve();
        },

        setProjectName: (name) =>
          set((s) => {
            if (s.project) s.project.name = name;
          }),

        setResolution: (preset) =>
          set((s) => {
            if (s.project) s.project.resolution = preset;
          }),

        setFrameRate: (fps) =>
          set((s) => {
            if (s.project) s.project.frameRate = fps;
          }),

        setStageMode: (mode) =>
          set((s) => {
            if (!s.project) return;
            s.project.stageMode = mode;
            // Reorganiza as tracks pro novo modo: split garante os 2 palcos e
            // realoca clips por slot; single limpa stageSlot e zera p/ full.
            normalizeSplitTracks(s.project);
          }),

        setSplitRatio: (ratio) =>
          set((s) => {
            if (s.project) s.project.splitRatio = clamp(ratio, 0.1, 0.9);
          }),

        setStageBackground: (color) =>
          set((s) => {
            if (s.project) s.project.stageBackground = color;
          }),

        setOverlays: (patch) =>
          set((s) => {
            if (!s.project) return;
            s.project.overlays = {
              logo: false,
              footer: false,
              ending: false,
              ...s.project.overlays,
              ...patch,
            };
          }),

        setIdentity: (patch) =>
          set((s) => {
            if (!s.project) return;
            s.project.identity = { ...s.project.identity, ...patch };
          }),

        applyGabineteIdentity: () =>
          set((s) => {
            if (!s.project) return;
            s.project.overlays = { logo: true, footer: true, ending: true };
            s.project.identity = {
              logoWidthPct: 44,
              footerWidthPct: 97,
              endingAudioFadeIn: 0.6,
              // trim é do arquivo da vinheta em uso — preserva o já medido.
              endingTrimStart: s.project.identity?.endingTrimStart ?? 0,
            };
          }),

        applyGlobalSpeed: (factor) => {
          let ok = false;
          const F = Number(factor);
          if (!Number.isFinite(F) || F < 0.5 || F > 2 || Math.abs(F - 1) < 1e-6) {
            return false;
          }
          set((s) => {
            const p = s.project;
            if (!p) return;
            // Track BASE: a track de vídeo de MENOR index com clips.
            const base = [...p.tracks]
              .filter((t) => t.type === 'video' && t.clips.length > 0)
              .sort((a, b) => a.index - b.index)[0];
            if (!base) return;

            const oldDuration =
              p.duration ||
              Math.max(
                0,
                ...p.tracks.flatMap((t) => t.clips.map((c) => c.endInTimeline)),
              );
            const assetTypeOf = (assetId: string) =>
              p.assets.find((a) => a.id === assetId)?.type;
            const r3 = (n: number) => Number(n.toFixed(3));

            // Passo 1: remapeia a BASE (a fala). O fim dela trava tudo —
            // nada pode alongar o vídeo além da fala (regra dura do dono).
            let newBaseEnd = 0;
            for (const clip of base.clips) {
              if ((clip.layer ?? 0) !== 0) continue;
              clip.playbackRate = r3((clip.playbackRate || 1) * F);
              clip.startInTimeline = r3(clip.startInTimeline / F);
              clip.endInTimeline = r3(
                clip.startInTimeline +
                  (clip.endInAsset - clip.startInAsset) / clip.playbackRate,
              );
              if (clip.endInTimeline > newBaseEnd) {
                newBaseEnd = clip.endInTimeline;
              }
              if (clip.keyframes && clip.keyframes.length > 0) {
                for (const kf of clip.keyframes) {
                  kf.time = r3(kf.time / F);
                }
              }
              if (clip.blurWindows) {
                for (const w of clip.blurWindows) {
                  w.start = r3(w.start / F);
                  w.end = r3(w.end / F);
                }
              }
            }

            // Passo 2: remapeia o resto.
            for (const track of p.tracks) {
              for (const clip of track.clips) {
                const isBase =
                  track.id === base.id &&
                  (clip.layer ?? 0) === 0 &&
                  track.type === 'video';
                if (isBase) continue; // já remapeado no passo 1
                const tipo = assetTypeOf(clip.assetId);
                const oldStart = clip.startInTimeline;
                const oldDur = clip.endInTimeline - clip.startInTimeline;

                if (tipo === 'image') {
                  // Imagem acompanha a fala: as duas pontas comprimem.
                  clip.startInTimeline = r3(oldStart / F);
                  clip.endInTimeline = r3((oldStart + oldDur) / F);
                } else {
                  // Vídeo/áudio sobreposto: desloca o início; mantém a
                  // duração natural (meme/efeito não re-acelera). Exceção:
                  // trilha (cobre quase o projeto todo) comprime junto.
                  const ehTrilha =
                    track.type === 'audio' &&
                    oldDuration > 0 &&
                    oldDur >= oldDuration * 0.85;
                  clip.startInTimeline = r3(oldStart / F);
                  clip.endInTimeline = ehTrilha
                    ? r3((oldStart + oldDur) / F)
                    : r3(clip.startInTimeline + oldDur);
                  // Trava no fim da fala (nada alonga o vídeo).
                  if (newBaseEnd > 0 && clip.endInTimeline > newBaseEnd) {
                    clip.endInTimeline = r3(
                      Math.max(clip.startInTimeline + 0.1, newBaseEnd),
                    );
                  }
                }

                if (clip.keyframes && clip.keyframes.length > 0) {
                  for (const kf of clip.keyframes) {
                    kf.time = r3(kf.time / F);
                  }
                }
                if (clip.blurWindows) {
                  for (const w of clip.blurWindows) {
                    w.start = r3(w.start / F);
                    w.end = r3(w.end / F);
                  }
                }
              }
              // Reordena por início (o remap preserva a ordem, mas garante).
              track.clips.sort((a, b) => a.startInTimeline - b.startInTimeline);
            }

            for (const ct of p.captionTracks) {
              for (const cue of ct.cues) {
                cue.startTime = r3(cue.startTime / F);
                cue.endTime = r3(cue.endTime / F);
              }
            }

            p.duration = computeProjectDuration(p);
            p.speechRate = r3((p.speechRate ?? 1) * F);
            ok = true;
          });
          return ok;
        },

        // ===== 5.2 Assets =================================================
        addAsset: (asset) =>
          set((s) => {
            if (!s.project) return;
            s.project.assets.push(asset);
          }),

        removeAsset: (assetId) =>
          set((s) => {
            if (!s.project) return;
            // Bloqueia remoção se algum clip referencia.
            const used = s.project.tracks.some((t) =>
              t.clips.some((c) => c.assetId === assetId),
            );
            if (used) return;
            const target = s.project.assets.find((a) => a.id === assetId);
            // Cleanup blob URL se for local-blob.
            if (
              target &&
              target.source === 'local-blob' &&
              target.downloadUrl.startsWith('blob:')
            ) {
              try {
                URL.revokeObjectURL(target.downloadUrl);
              } catch {
                // best-effort
              }
            }
            s.project.assets = s.project.assets.filter((a) => a.id !== assetId);
          }),

        updateAsset: (assetId, patch) =>
          set((s) => {
            if (!s.project) return;
            const asset = s.project.assets.find((a) => a.id === assetId);
            if (asset) Object.assign(asset, patch);
          }),

        setAssetUploadProgress: (assetId, progress) => {
          // (no-history): pause antes de aplicar para não criar entry de undo.
          const temporal = (useEditorStore as unknown as TemporalCarrier).temporal;
          temporal?.getState().pause();
          set((s) => {
            if (!s.project) return;
            const asset = s.project.assets.find((a) => a.id === assetId);
            if (asset) asset.uploadProgress = clamp(progress, 0, 100);
          });
          temporal?.getState().resume();
        },

        // ===== 5.3 Tracks =================================================
        addTrack: (type, name) => {
          const id = genId('track');
          set((s) => {
            if (!s.project) return;
            const index = s.project.tracks.length;
            const track: Track = {
              id,
              type,
              name: name ?? `${type === 'video' ? 'V' : 'A'}${index + 1}`,
              index,
              muted: false,
              locked: false,
              visible: true,
              solo: false,
              height: 64,
              clips: [],
            };
            s.project.tracks.push(track);
          });
          return id;
        },

        addStageTrack: (slot) => {
          let id: string | null = null;
          set((s) => {
            if (!s.project || s.project.stageMode !== 'split-vertical') return;
            const nome = slot === 'top' ? 'Palco superior' : 'Palco inferior';
            // Numera a nova track dentro do palco (ex.: "Palco superior 2").
            const noPalco = s.project.tracks.filter(
              (t) => t.type === 'video' && t.stageSlot === slot,
            ).length;
            id = genId('track');
            const track: Track = {
              id,
              type: 'video',
              name: noPalco > 0 ? `${nome} ${noPalco + 1}` : nome,
              index: s.project.tracks.length,
              muted: false,
              locked: false,
              visible: true,
              solo: false,
              height: 64,
              clips: [],
              stageSlot: slot,
            };
            // Insere logo após a última track do mesmo palco (mantém o grupo
            // contíguo); reindexar no fim.
            const ultimaDoPalco = [...s.project.tracks]
              .map((t, i) => ({ t, i }))
              .filter(({ t }) => t.type === 'video' && t.stageSlot === slot)
              .pop();
            if (ultimaDoPalco) {
              s.project.tracks.splice(ultimaDoPalco.i + 1, 0, track);
            } else {
              s.project.tracks.push(track);
            }
            s.project.tracks.forEach((t, i) => {
              t.index = i;
            });
          });
          return id;
        },

        removeTrack: (trackId) =>
          set((s) => {
            if (!s.project) return;
            const alvo = s.project.tracks.find((t) => t.id === trackId);
            if (!alvo) return;
            // Guarda da estrutura de palco: em split, não deixa remover a ÚLTIMA
            // track de vídeo de um palco (mínimo 1 por palco superior/inferior).
            if (
              s.project.stageMode === 'split-vertical' &&
              alvo.type === 'video' &&
              (alvo.stageSlot === 'top' || alvo.stageSlot === 'bottom')
            ) {
              const irmas = s.project.tracks.filter(
                (t) => t.type === 'video' && t.stageSlot === alvo.stageSlot,
              );
              if (irmas.length <= 1) return; // é a última do palco → não remove
            }
            s.project.tracks = s.project.tracks.filter((t) => t.id !== trackId);
            // Re-index para manter contiguidade.
            s.project.tracks.forEach((t, i) => {
              t.index = i;
            });
          }),

        renameTrack: (trackId, name) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (track) track.name = name;
          }),

        reorderTracks: (trackId, newIndex) =>
          set((s) => {
            if (!s.project) return;
            const tracks = s.project.tracks;
            const fromIndex = tracks.findIndex((t) => t.id === trackId);
            if (fromIndex < 0) return;
            const target = clamp(newIndex, 0, tracks.length - 1);
            const [moved] = tracks.splice(fromIndex, 1);
            tracks.splice(target, 0, moved);
            tracks.forEach((t, i) => {
              t.index = i;
            });
          }),

        toggleTrackMute: (trackId) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (track) track.muted = !track.muted;
          }),

        setTrackMuted: (trackId, muted) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (track) track.muted = muted;
          }),

        setTrackLocked: (trackId, locked) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (track) track.locked = locked;
          }),

        setTrackVisible: (trackId, visible) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (track) track.visible = visible;
          }),

        setTrackSolo: (trackId, solo) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (track) track.solo = solo;
          }),

        setTrackAudioOptions: (trackId, patch) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (!track || track.type !== 'audio') return;
            if (patch.gainPct !== undefined) {
              track.gainPct = clamp(patch.gainPct, 0, 200);
            }
            if (patch.audioLeveling !== undefined) {
              track.audioLeveling = patch.audioLeveling;
            }
            if (patch.autoFade !== undefined) {
              track.autoFade = patch.autoFade;
            }
            if (patch.voiceEq !== undefined) {
              track.voiceEq = patch.voiceEq;
            }
            if (patch.voiceDuck !== undefined) {
              track.voiceDuck = patch.voiceDuck;
            }
          }),

        setTrackHeight: (trackId, px) => {
          // (no-history)
          const temporal = (useEditorStore as unknown as TemporalCarrier).temporal;
          temporal?.getState().pause();
          set((s) => {
            if (!s.project) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (track) track.height = clamp(px, 24, 240);
          });
          temporal?.getState().resume();
        },

        // ===== 5.3b Subtracks / Camadas ===================================
        addSubtrack: (trackId) => {
          let newLayer: number | null = null;
          set((s) => {
            if (!s.project) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (!track || track.type !== 'video' || track.locked) return;
            const current = effectiveLayerCount(track);
            track.layerCount = current + 1;
            newLayer = current; // índice da camada recém-criada (topo)
          });
          return newLayer;
        },

        removeSubtrack: (trackId, layer) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (!track || track.type !== 'video') return;
            const count = effectiveLayerCount(track);
            // Sempre mantém ao menos uma camada (a base).
            if (count <= 1) return;
            const target = clamp(Math.round(layer), 0, count - 1);
            // Remove clips da camada alvo e rebaixa as camadas acima.
            track.clips = track.clips.filter((c) => (c.layer ?? 0) !== target);
            for (const c of track.clips) {
              const l = c.layer ?? 0;
              if (l > target) c.layer = l - 1;
            }
            track.layerCount = count - 1;
            s.project.duration = computeProjectDuration(s.project);
          }),

        moveClipToLayer: (clipId, layer) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found || found.track.type !== 'video') return;
            const count = effectiveLayerCount(found.track);
            const target = clamp(Math.round(layer), 0, Math.max(0, count - 1));
            found.clip.layer = target;
          }),

        // ===== 5.4 Clips ==================================================
        addClip: (trackId, clip) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (!track) return;
            // Garante consistência do trackId no clip.
            clip.trackId = trackId;
            track.clips.push(clip);
            // Recalcula duração do projeto.
            s.project.duration = computeProjectDuration(s.project);
          }),

        addClipFromAsset: (assetId, trackId, atTime, layer) => {
          let newId: string | null = null;
          set((s) => {
            if (!s.project) return;
            const asset = s.project.assets.find((a) => a.id === assetId);
            if (!asset) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (!track) return;
            // Tipo de asset compatível com track?
            if (track.type === 'video' && asset.type === 'audio') return;
            if (track.type === 'audio' && asset.type !== 'audio') return;

            // Camada de destino (só vídeo). Garante que a track tem ao menos
            // tantas camadas quanto a pedida.
            const targetLayer =
              track.type === 'video' ? Math.max(0, layer ?? 0) : 0;
            if (track.type === 'video' && targetLayer + 1 > (track.layerCount ?? 1)) {
              track.layerCount = targetLayer + 1;
            }

            const assetDuration = asset.duration ?? 5; // imagem: default 5s
            // Encaixa EM SEQUÊNCIA sem sobrepor: se `atTime` cair sobre um clip
            // da mesma camada, joga para logo após o último — clipes nunca se
            // empilham no mesmo tempo na mesma track/camada.
            const at = inicioSemSobreposicao(
              track.clips.filter((c) => (c.layer ?? 0) === targetLayer),
              atTime,
              assetDuration,
            );
            // Slot DERIVA da track: em split, a track do palco define o slot
            // do clip (top/bottom) e o encaixe preenche a banda (cover); track
            // sem palco / single → full (contain).
            const slotDaTrack: 'full' | 'top' | 'bottom' =
              s.project.stageMode === 'split-vertical' && track.type === 'video'
                ? track.stageSlot ?? 'full'
                : 'full';
            newId = genId('clip');
            const clip: Clip = {
              id: newId,
              assetId,
              trackId,
              startInTimeline: at,
              endInTimeline: at + assetDuration,
              startInAsset: 0,
              endInAsset: assetDuration,
              slot: slotDaTrack,
              fit: slotDaTrack === 'full' ? 'contain' : 'cover',
              layer: targetLayer,
              playbackRate: 1,
              transform: { ...DEFAULT_TRANSFORM },
              filters: { ...DEFAULT_FILTERS },
              audio: { ...DEFAULT_AUDIO },
              keyframes: [],
              locked: false,
              hidden: false,
            };
            track.clips.push(clip);
            s.project.duration = computeProjectDuration(s.project);
          });
          return newId;
        },

        addClipToSlot: (assetId, slot, atTime) => {
          let newId: string | null = null;
          set((s) => {
            if (!s.project) return;
            const asset = s.project.assets.find((a) => a.id === assetId);
            if (!asset) return;
            // Áudio puro não tem camada visual — não cabe num slot do palco.
            if (asset.type === 'audio') return;

            // 1) Slots top/bottom só fazem sentido em split-vertical.
            //    Liga o modo (idempotente) para que as bandas existam.
            if (slot !== 'full' && s.project.stageMode !== 'split-vertical') {
              s.project.stageMode = 'split-vertical';
            }

            // 2) Garante a track de vídeo do slot pela ESTRUTURA DE PALCO
            //    (`stageSlot`), não mais por convenção de nome. As tracks de
            //    palco já existem (estrutura fixa); se faltar, cria com o
            //    stageSlot certo. Determinístico e idempotente (sem duplicar).
            const proj = s.project;
            const ensurePalco = (sl: 'top' | 'bottom'): Track => {
              const existing = proj.tracks.find(
                (t) => t.type === 'video' && t.stageSlot === sl,
              );
              if (existing) return existing;
              const created: Track = {
                id: genId('track'),
                type: 'video',
                name: sl === 'top' ? 'Palco superior' : 'Palco inferior',
                index: proj.tracks.length,
                muted: false,
                locked: false,
                visible: true,
                solo: false,
                height: 64,
                clips: [],
                stageSlot: sl,
              };
              proj.tracks.push(created);
              return created;
            };

            let track: Track;
            if (slot === 'top' || slot === 'bottom') {
              // Garante AMBOS os palcos (estrutura completa) e escolhe o do slot.
              ensurePalco('top');
              ensurePalco('bottom');
              track = ensurePalco(slot);
            } else {
              // slot 'full' → track de vídeo SEM palco (tela cheia); cria se faltar.
              track =
                proj.tracks.find((t) => t.type === 'video' && !t.stageSlot) ??
                (() => {
                  const created: Track = {
                    id: genId('track'),
                    type: 'video',
                    name: `V${proj.tracks.filter((t) => t.type === 'video').length + 1}`,
                    index: proj.tracks.length,
                    muted: false,
                    locked: false,
                    visible: true,
                    solo: false,
                    height: 64,
                    clips: [],
                  };
                  proj.tracks.push(created);
                  return created;
                })();
            }

            if (track.locked) return;

            // 3) Cria o clip no tempo desejado (default: playhead), encaixado
            //    EM SEQUÊNCIA sem sobrepor outro clip da mesma camada (0) da
            //    track do slot — clipes não se empilham no mesmo tempo.
            const assetDuration = asset.duration ?? 5; // imagem: default 5s
            const at = inicioSemSobreposicao(
              track.clips.filter((c) => (c.layer ?? 0) === 0),
              atTime ?? s.ui.playhead,
              assetDuration,
            );

            newId = genId('clip');
            const clip: Clip = {
              id: newId,
              assetId,
              trackId: track.id,
              startInTimeline: at,
              endInTimeline: at + assetDuration,
              startInAsset: 0,
              endInAsset: assetDuration,
              slot,
              // 4) Encaixe na banda: top/bottom PREENCHEM a banda (cover);
              //    full mostra o vídeo inteiro (contain). O layout (caixa da
              //    banda em `slotBox` + `object-fit`) faz o ajuste — sem mais
              //    transform bakeado. O usuário troca depois em Encaixe.
              fit: slot === 'full' ? 'contain' : 'cover',
              playbackRate: 1,
              transform: { ...DEFAULT_TRANSFORM },
              filters: { ...DEFAULT_FILTERS },
              audio: { ...DEFAULT_AUDIO },
              keyframes: [],
              locked: false,
              hidden: false,
            };
            track.clips.push(clip);
            s.project.duration = computeProjectDuration(s.project);
          });
          return newId;
        },

        removeClip: (clipId) =>
          set((s) => {
            if (!s.project) return;
            for (const track of s.project.tracks) {
              const idx = track.clips.findIndex((c) => c.id === clipId);
              if (idx >= 0) {
                track.clips.splice(idx, 1);
                break;
              }
            }
            s.project.duration = computeProjectDuration(s.project);
          }),

        moveClip: (clipId, newStart, newTrackId) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found) return;
            const { track: oldTrack, clip } = found;
            const duration = clip.endInTimeline - clip.startInTimeline;

            // Track de destino (mesma ou nova).
            const targetTrack =
              newTrackId && newTrackId !== oldTrack.id
                ? s.project.tracks.find((t) => t.id === newTrackId)
                : oldTrack;
            if (!targetTrack) return;

            // Sem sobreposição na MESMA camada da track de destino (exclui o
            // próprio clip): se a posição cair sobre outro, encaixa logo após —
            // dois clips nunca ocupam o mesmo tempo na mesma track/camada.
            const safeStart = inicioSemSobreposicao(
              targetTrack.clips.filter(
                (c) => c.id !== clipId && (c.layer ?? 0) === (clip.layer ?? 0),
              ),
              newStart,
              duration,
            );
            clip.startInTimeline = safeStart;
            clip.endInTimeline = safeStart + duration;

            if (targetTrack.id !== oldTrack.id) {
              oldTrack.clips = oldTrack.clips.filter((c) => c.id !== clipId);
              clip.trackId = targetTrack.id;
              targetTrack.clips.push(clip);
              // Em split, mudar de track pode mudar de PALCO: o clip adota o
              // slot da track de destino (track = fonte da verdade da posição).
              if (
                s.project.stageMode === 'split-vertical' &&
                targetTrack.type === 'video'
              ) {
                const novoSlot: 'full' | 'top' | 'bottom' =
                  targetTrack.stageSlot ?? 'full';
                if (clip.slot !== novoSlot) {
                  clip.slot = novoSlot;
                  clip.fit = novoSlot === 'full' ? 'contain' : 'cover';
                }
              }
            }
            s.project.duration = computeProjectDuration(s.project);
          }),

        trimClip: (clipId, side, newTime) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found) return;
            const { clip } = found;
            const MIN_DURATION = 0.1;

            // O delta é em tempo de TIMELINE; o asset avança `delta * rate`
            // (mesmo mapeamento já usado em splitClip).
            const rate = clip.playbackRate || 1;
            if (side === 'left') {
              const maxStart = clip.endInTimeline - MIN_DURATION;
              const target = clamp(newTime, 0, maxStart);
              const delta = target - clip.startInTimeline;
              clip.startInTimeline = target;
              clip.startInAsset = Math.max(0, clip.startInAsset + delta * rate);
            } else {
              const minEnd = clip.startInTimeline + MIN_DURATION;
              const target = Math.max(minEnd, newTime);
              const delta = target - clip.endInTimeline;
              clip.endInTimeline = target;
              clip.endInAsset = clip.endInAsset + delta * rate;
            }
            s.project.duration = computeProjectDuration(s.project);
          }),

        splitClip: (clipId, atTime) => {
          let result: [string, string] | null = null;
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found) return;
            const { track, clip } = found;
            // Precisa estar dentro do clip e não muito perto das bordas.
            if (
              atTime <= clip.startInTimeline + 0.05 ||
              atTime >= clip.endInTimeline - 0.05
            ) {
              return;
            }
            const splitOffset = atTime - clip.startInTimeline;
            const splitInAsset = clip.startInAsset + splitOffset * clip.playbackRate;

            const newId = genId('clip');
            const clipB: Clip = {
              ...clip,
              id: newId,
              startInTimeline: atTime,
              startInAsset: splitInAsset,
              keyframes: clip.keyframes ? [...clip.keyframes] : [],
              transform: { ...clip.transform },
              filters: { ...clip.filters },
              audio: { ...clip.audio },
              // Split anula transitions cruzando o ponto.
              transitionIn: undefined,
              transitionOut: clip.transitionOut,
            };

            // Atualiza A.
            clip.endInTimeline = atTime;
            clip.endInAsset = splitInAsset;
            clip.transitionOut = undefined;

            // Insere B depois de A na track.
            const idx = track.clips.findIndex((c) => c.id === clipId);
            track.clips.splice(idx + 1, 0, clipB);
            result = [clip.id, newId];
          });
          return result;
        },

        trimClipTail: (clipId, seconds) => {
          let ok = false;
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found || found.clip.locked || found.track.locked) return;
            const { clip } = found;
            const cut = Number(seconds);
            const durAtual = clip.endInTimeline - clip.startInTimeline;
            if (!Number.isFinite(cut) || cut <= 0 || cut >= durAtual - 0.1) {
              return;
            }
            const oldEnd = clip.endInTimeline;
            const newEnd = oldEnd - cut;
            const rate = clip.playbackRate || 1;

            clip.endInTimeline = Number(newEnd.toFixed(3));
            clip.endInAsset = Number(
              (clip.endInAsset - cut * rate).toFixed(3),
            );

            // Ripple por REMAP DE TEMPO: o intervalo [newEnd, oldEnd) deixa
            // de existir. Cada ponta (início E fim) de clip/cue mapeia
            // independente — quem atravessava o trecho removido encurta, em
            // vez de ganhar sobreposição com o vizinho.
            const mapT = (t: number): number =>
              t <= newEnd ? t : t >= oldEnd ? t - cut : newEnd;
            for (const track of s.project.tracks) {
              for (const c of track.clips) {
                if (c.id === clip.id) continue;
                const ns = Number(mapT(c.startInTimeline).toFixed(3));
                const ne = Number(
                  Math.max(mapT(c.endInTimeline), ns + 0.1).toFixed(3),
                );
                c.startInTimeline = ns;
                c.endInTimeline = ne;
                if (c.blurWindows) {
                  for (const w of c.blurWindows) {
                    w.start = Number(mapT(w.start).toFixed(3));
                    w.end = Number(mapT(w.end).toFixed(3));
                  }
                }
              }
              track.clips.sort((a, b) => a.startInTimeline - b.startInTimeline);
            }
            for (const ct of s.project.captionTracks) {
              for (const cue of ct.cues) {
                const ns = Number(mapT(cue.startTime).toFixed(3));
                const ne = Number(
                  Math.max(mapT(cue.endTime), ns + 0.1).toFixed(3),
                );
                cue.startTime = ns;
                cue.endTime = ne;
              }
            }
            s.project.duration = computeProjectDuration(s.project);
            ok = true;
          });
          return ok;
        },

        applyCrossfadeAtJunctions: (trackId, duration = 0.3) => {
          let count = 0;
          set((s) => {
            if (!s.project) return;
            const track = s.project.tracks.find((t) => t.id === trackId);
            if (!track || track.type !== 'video' || track.locked) return;
            const xf = clamp(duration, 0.1, 1);
            const eps = 0.05;

            // Junções: pares consecutivos ADJACENTES da camada 0.
            const base = track.clips
              .filter((c) => (c.layer ?? 0) === 0 && !c.hidden)
              .sort((a, b) => a.startInTimeline - b.startInTimeline);

            for (let i = 0; i + 1 < base.length; i += 1) {
              const a = base[i];
              const b = base[i + 1];
              const durA = a.endInTimeline - a.startInTimeline;
              const durB = b.endInTimeline - b.startInTimeline;
              // Já sobrepostos (xfade aplicado antes) → só garante a marca.
              const jaSobrepoe =
                a.endInTimeline - b.startInTimeline > eps &&
                a.endInTimeline - b.startInTimeline <= 1 + eps;
              const adjacente =
                Math.abs(a.endInTimeline - b.startInTimeline) < eps;
              if (!adjacente && !jaSobrepoe) continue;
              if (durA < xf * 2 || durB < xf * 2) continue;

              if (adjacente) {
                // Sobrepõe o par: tudo que fica a partir da junção (em todas
                // as tracks + legendas) puxa `xf` para trás. Pontas que
                // CRUZAM a junção também encurtam (senão ganhavam overlap
                // com o vizinho — ex.: legendas duplas na emenda).
                const pivot = b.startInTimeline;
                const mapT = (t: number): number =>
                  t < pivot - 1e-3 ? t : Math.max(pivot - xf, t - xf);
                for (const t2 of s.project.tracks) {
                  for (const c of t2.clips) {
                    if (c.id === a.id) continue;
                    const ns = Number(mapT(c.startInTimeline).toFixed(3));
                    const ne = Number(
                      Math.max(mapT(c.endInTimeline), ns + 0.1).toFixed(3),
                    );
                    c.startInTimeline = ns;
                    c.endInTimeline = ne;
                  }
                }
                for (const ct of s.project.captionTracks) {
                  for (const cue of ct.cues) {
                    const ns = Number(mapT(cue.startTime).toFixed(3));
                    const ne = Number(
                      Math.max(mapT(cue.endTime), ns + 0.1).toFixed(3),
                    );
                    cue.startTime = ns;
                    cue.endTime = ne;
                  }
                }
              }

              const overlap = Number(
                (a.endInTimeline - b.startInTimeline).toFixed(3),
              );
              const cfg: TransitionConfig = {
                type: 'crossfade',
                duration: overlap > 0 ? overlap : xf,
                easing: 'linear',
              };
              a.transitionOut = { ...cfg };
              b.transitionIn = { ...cfg };
              count += 1;
            }

            for (const t2 of s.project.tracks) {
              t2.clips.sort((x, y) => x.startInTimeline - y.startInTimeline);
            }
            s.project.duration = computeProjectDuration(s.project);
          });
          return count;
        },

        duplicateClip: (clipId) => {
          let newId: string | null = null;
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found) return;
            const { track, clip } = found;
            const duration = clip.endInTimeline - clip.startInTimeline;
            newId = genId('clip');
            const dup: Clip = {
              ...clip,
              id: newId,
              startInTimeline: clip.endInTimeline,
              endInTimeline: clip.endInTimeline + duration,
              transform: { ...clip.transform },
              filters: { ...clip.filters },
              audio: { ...clip.audio },
              keyframes: clip.keyframes ? [...clip.keyframes] : [],
            };
            track.clips.push(dup);
            s.project.duration = computeProjectDuration(s.project);
          });
          return newId;
        },

        // ===== Clipboard (Ctrl+C / Ctrl+V) ================================
        copySelectedClip: () => {
          const state = get();
          if (!state.project) return false;
          const id = state.ui.selectedClipIds[0];
          if (!id) return false;
          const found = findClip(state.project, id);
          if (!found) return false;
          // Snapshot por valor — o paste cria um clip novo a partir disso.
          const snapshot: Clip = {
            ...found.clip,
            transform: { ...found.clip.transform },
            filters: { ...found.clip.filters },
            audio: { ...found.clip.audio },
            keyframes: found.clip.keyframes
              ? found.clip.keyframes.map((k) => ({ ...k }))
              : [],
          };
          // (no-history) — clipboard é UI-só.
          const t = (useEditorStore as unknown as TemporalCarrier).temporal;
          t?.getState().pause();
          set((s) => {
            s.clipboard = { clip: snapshot };
          });
          t?.getState().resume();
          return true;
        },

        pasteClip: (trackId, atTime) => {
          let newId: string | null = null;
          set((s) => {
            if (!s.project) return;
            if (!s.clipboard) return;
            const src = s.clipboard.clip;

            // Resolve track destino: explicito → original do source →
            // primeira track compatível com o asset.
            let target = trackId
              ? s.project.tracks.find((t) => t.id === trackId)
              : s.project.tracks.find((t) => t.id === src.trackId);
            if (!target) {
              // Fallback: tipo compatível com o asset (se ainda existir).
              const asset = s.project.assets.find((a) => a.id === src.assetId);
              if (asset) {
                target = s.project.tracks.find((t) =>
                  asset.type === 'audio'
                    ? t.type === 'audio'
                    : t.type === 'video',
                );
              }
            }
            if (!target) return;

            const start = atTime ?? s.ui.playhead;
            const duration = src.endInTimeline - src.startInTimeline;
            newId = genId('clip');
            const clone: Clip = {
              ...src,
              id: newId,
              trackId: target.id,
              startInTimeline: Math.max(0, start),
              endInTimeline: Math.max(0, start) + duration,
              transform: { ...src.transform },
              filters: { ...src.filters },
              audio: { ...src.audio },
              keyframes: src.keyframes ? src.keyframes.map((k) => ({ ...k })) : [],
              // Transitions são "geminadas" por par — não faz sentido
              // copiar para um clip órfão.
              transitionIn: undefined,
              transitionOut: undefined,
            };
            target.clips.push(clone);
            s.project.duration = computeProjectDuration(s.project);
          });
          return newId;
        },

        removeSelectedClip: () => {
          const state = get();
          if (!state.project) return;
          const ids = [...state.ui.selectedClipIds];
          if (ids.length === 0) return;
          set((s) => {
            if (!s.project) return;
            for (const id of ids) {
              for (const track of s.project.tracks) {
                const idx = track.clips.findIndex((c) => c.id === id);
                if (idx >= 0) {
                  track.clips.splice(idx, 1);
                  break;
                }
              }
            }
            s.project.duration = computeProjectDuration(s.project);
            s.ui.selectedClipIds = [];
          });
        },

        // ===== Clipboard de ajustes ("Colar atributos") ==================
        copiarAjustes: (clipId) => {
          const state = get();
          if (!state.project) return false;
          const id = clipId ?? state.ui.selectedClipIds[0];
          if (!id) return false;
          const found = findClip(state.project, id);
          if (!found) return false;
          const c = found.clip;
          // Snapshot por VALOR — independente do clip fonte daqui pra frente.
          const snapshot: ClipAdjustments = {
            transform: { ...c.transform },
            filters: { ...c.filters },
            audio: { ...c.audio },
            // `fit` ausente = 'contain'; normaliza para evitar `undefined` ambíguo.
            fit: c.fit ?? 'contain',
            chromaKey: c.chromaKey ? { ...c.chromaKey } : undefined,
            playbackRate: c.playbackRate,
          };
          // (no-history) — clipboard é UI-só.
          const t = (useEditorStore as unknown as TemporalCarrier).temporal;
          t?.getState().pause();
          set((s) => {
            s.adjustmentsClipboard = snapshot;
          });
          t?.getState().resume();
          return true;
        },

        aplicarAjustes: (clipIds) => {
          const state = get();
          if (!state.project) return 0;
          const adj = state.adjustmentsClipboard;
          if (!adj) return 0;
          const ids = clipIds ?? state.ui.selectedClipIds;
          if (ids.length === 0) return 0;

          let applied = 0;
          // UM único `set` → uma única entrada de undo no histórico.
          set((s) => {
            if (!s.project) return;
            for (const id of ids) {
              const found = findClip(s.project, id);
              if (!found) continue;
              // Pula clips travados ou em track travada (coerente com os menus).
              if (found.clip.locked || found.track.locked) continue;
              const clip = found.clip;
              Object.assign(clip.transform, adj.transform);
              Object.assign(clip.filters, adj.filters);
              Object.assign(clip.audio, adj.audio);
              if (adj.fit !== undefined) clip.fit = adj.fit;
              // chromaKey: se a fonte tem, sobrescreve; se não tem, preserva o
              // do destino (menos destrutivo).
              if (adj.chromaKey) clip.chromaKey = { ...adj.chromaKey };
              clip.playbackRate = clamp(adj.playbackRate, 0.25, 4);
              // Velocidade muda a duração do clip na timeline (ancora a esquerda).
              applyPlaybackRateToTimeline(clip);
              applied += 1;
            }
            if (applied > 0) {
              s.project.duration = computeProjectDuration(s.project);
            }
          });
          return applied;
        },

        setClipSlot: (clipId, slot) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (found) found.clip.slot = slot;
          }),

        setClipFit: (clipId, fit) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (found) found.clip.fit = fit;
          }),

        setClipTransform: (clipId, partial) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (found) Object.assign(found.clip.transform, partial);
          }),

        setClipFilters: (clipId, partial) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (found) Object.assign(found.clip.filters, partial);
          }),

        setClipAudio: (clipId, partial) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (found) Object.assign(found.clip.audio, partial);
          }),

        setClipChromaKey: (clipId, partial) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found) return;
            const current: ClipChromaKey = found.clip.chromaKey ?? {
              enabled: false,
              color: '#00b140',
              similarity: 0.4,
              smoothness: 0.1,
              spillSuppression: 0.2,
              engine: 'webgl',
            };
            found.clip.chromaKey = { ...current, ...partial };
          }),

        setClipBlurWindows: (clipId, windows) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found) return;
            const { clip } = found;
            const limpas = windows
              .map((w) => ({
                start: Number(
                  clamp(
                    Math.min(w.start, w.end),
                    clip.startInTimeline,
                    clip.endInTimeline,
                  ).toFixed(3),
                ),
                end: Number(
                  clamp(
                    Math.max(w.start, w.end),
                    clip.startInTimeline,
                    clip.endInTimeline,
                  ).toFixed(3),
                ),
              }))
              .filter((w) => w.end - w.start > 0.05);
            clip.blurWindows = limpas.length > 0 ? limpas : undefined;
          }),

        splitAudioFromVideoClip: (clipId) => {
          let createdId: string | null = null;
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found) return;
            if (found.track.type !== 'video') return;
            const asset = s.project.assets.find((a) => a.id === found.clip.assetId);
            if (!asset || asset.type !== 'video') return;

            // 1) Asset "virtual" tipo audio apontando pra mesma URL.
            const audioAssetId = genId('asset');
            s.project.assets.push({
              ...asset,
              id: audioAssetId,
              name: `${asset.name} (áudio)`,
              type: 'audio',
            });

            // 2) Garante uma track de áudio (cria se não houver).
            let audioTrack = s.project.tracks.find((t) => t.type === 'audio');
            if (!audioTrack) {
              const audioCount = s.project.tracks.filter((t) => t.type === 'audio').length;
              audioTrack = {
                id: genId('track'),
                type: 'audio',
                name: `A${audioCount + 1}`,
                index: s.project.tracks.length,
                muted: false,
                locked: false,
                visible: true,
                solo: false,
                height: 64,
                clips: [],
              };
              s.project.tracks.push(audioTrack);
            }

            // 3) Cria clip de áudio espelhando timing do original.
            const newClipId = genId('clip');
            createdId = newClipId;
            audioTrack.clips.push({
              ...found.clip,
              id: newClipId,
              assetId: audioAssetId,
              trackId: audioTrack.id,
              slot: 'full',
              transitionIn: undefined,
              transitionOut: undefined,
              audio: { ...found.clip.audio, muted: false },
            });

            // 4) Silencia áudio do clip de vídeo original.
            found.clip.audio.muted = true;
          });
          return createdId;
        },

        setClipPlaybackRate: (clipId, rate) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found) return;
            found.clip.playbackRate = clamp(rate, 0.25, 4);
            // A velocidade encolhe/estica a duração do clip na timeline
            // (âncora à esquerda). Recalcula a duração do projeto.
            applyPlaybackRateToTimeline(found.clip);
            s.project.duration = computeProjectDuration(s.project);
          }),

        setClipLocked: (clipId, locked) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (found) found.clip.locked = locked;
          }),

        setClipHidden: (clipId, hidden) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (found) found.clip.hidden = hidden;
          }),

        // ===== 5.5 Transições =============================================
        setTransition: (clipId, side, config) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found) return;
            if (side === 'in') {
              found.clip.transitionIn = config ?? undefined;
            } else {
              found.clip.transitionOut = config ?? undefined;
            }
          }),

        applyTransitionBetween: (clipAId, clipBId, type, duration = 0.5) =>
          set((s) => {
            if (!s.project) return;
            const a = findClip(s.project, clipAId);
            const b = findClip(s.project, clipBId);
            if (!a || !b) return;

            // Limita duração.
            const maxDuration =
              Math.min(
                a.clip.endInTimeline - a.clip.startInTimeline,
                b.clip.endInTimeline - b.clip.startInTimeline,
              ) / 2;
            const safeDuration = clamp(duration, 0.05, maxDuration);

            const config: TransitionConfig = {
              type,
              duration: safeDuration,
              easing: 'ease-in-out',
            };
            a.clip.transitionOut = { ...config };
            b.clip.transitionIn = { ...config };
          }),

        removeTransition: (clipId, side) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found) return;
            if (side === 'in') found.clip.transitionIn = undefined;
            else found.clip.transitionOut = undefined;
          }),

        // ===== 5.6 Keyframes ==============================================
        addKeyframe: (clipId, kf) => {
          let newId: string | null = null;
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found) return;
            newId = genId('kf');
            const keyframe: Keyframe = { ...kf, id: newId };
            if (!found.clip.keyframes) found.clip.keyframes = [];
            found.clip.keyframes.push(keyframe);
            // Mantém ordenado por tempo.
            found.clip.keyframes.sort((x, y) => x.time - y.time);
          });
          return newId;
        },

        updateKeyframe: (clipId, kfId, partial) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found || !found.clip.keyframes) return;
            const kf = found.clip.keyframes.find((k) => k.id === kfId);
            if (kf) {
              Object.assign(kf, partial);
              found.clip.keyframes.sort((x, y) => x.time - y.time);
            }
          }),

        removeKeyframe: (clipId, kfId) =>
          set((s) => {
            if (!s.project) return;
            const found = findClip(s.project, clipId);
            if (!found || !found.clip.keyframes) return;
            found.clip.keyframes = found.clip.keyframes.filter(
              (k) => k.id !== kfId,
            );
          }),

        // ===== 5.7 Legendas ===============================================
        addCaptionTrack: (name, language) => {
          const id = genId('captrk');
          set((s) => {
            if (!s.project) return;
            const index = s.project.captionTracks.length;
            const track: CaptionTrack = {
              id,
              name: name ?? `Legendas ${index + 1}`,
              index,
              visible: true,
              locked: false,
              language,
              cues: [],
            };
            s.project.captionTracks.push(track);
          });
          return id;
        },

        removeCaptionTrack: (trackId) =>
          set((s) => {
            if (!s.project) return;
            s.project.captionTracks = s.project.captionTracks.filter(
              (t) => t.id !== trackId,
            );
            s.project.captionTracks.forEach((t, i) => {
              t.index = i;
            });
          }),

        renameCaptionTrack: (trackId, name) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.captionTracks.find((t) => t.id === trackId);
            if (track) track.name = name;
          }),

        setCaptionTrackVisible: (trackId, visible) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.captionTracks.find((t) => t.id === trackId);
            if (track) track.visible = visible;
          }),

        setCaptionTrackLocked: (trackId, locked) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.captionTracks.find((t) => t.id === trackId);
            if (track) track.locked = locked;
          }),

        setCaptionTrackSource: (trackId, source) =>
          set((s) => {
            if (!s.project) return;
            const track = s.project.captionTracks.find((t) => t.id === trackId);
            if (track) track.source = source;
          }),

        addCaption: (trackId, cue) => {
          let newId: string | null = null;
          set((s) => {
            if (!s.project) return;
            // Se trackId omitido, usa primeiro track ou cria um.
            let track = trackId
              ? s.project.captionTracks.find((t) => t.id === trackId)
              : s.project.captionTracks[0];
            if (!track) {
              const id = genId('captrk');
              track = {
                id,
                name: 'Legendas',
                index: 0,
                visible: true,
                locked: false,
                cues: [],
              };
              s.project.captionTracks.push(track);
            }
            // Validação básica.
            const safeEnd =
              cue.endTime <= cue.startTime
                ? cue.startTime + 0.1
                : cue.endTime;
            newId = genId('cue');
            const fullCue: CaptionCue = {
              id: newId,
              startTime: cue.startTime,
              endTime: safeEnd,
              text: cue.text,
              slot: cue.slot ?? 'full',
              style: { ...DEFAULT_CAPTION_STYLE, ...cue.style },
            };
            track.cues.push(fullCue);
            track.cues.sort((a, b) => a.startTime - b.startTime);
          });
          return newId;
        },

        updateCaption: (cueId, partial) =>
          set((s) => {
            if (!s.project) return;
            const found = findCue(s.project, cueId);
            if (!found) return;
            // Patch raso (style faz merge separado).
            const { style, ...rest } = partial;
            Object.assign(found.cue, rest);
            if (style) Object.assign(found.cue.style, style);
            // Re-valida tempo.
            if (found.cue.endTime <= found.cue.startTime) {
              found.cue.endTime = found.cue.startTime + 0.1;
            }
            found.track.cues.sort((a, b) => a.startTime - b.startTime);
          }),

        moveCaption: (cueId, newStart) =>
          set((s) => {
            if (!s.project) return;
            const found = findCue(s.project, cueId);
            if (!found) return;
            const duration = found.cue.endTime - found.cue.startTime;
            const safeStart = Math.max(0, newStart);
            found.cue.startTime = safeStart;
            found.cue.endTime = safeStart + duration;
            found.track.cues.sort((a, b) => a.startTime - b.startTime);
          }),

        resizeCaption: (cueId, side, newTime) =>
          set((s) => {
            if (!s.project) return;
            const found = findCue(s.project, cueId);
            if (!found) return;
            const MIN = 0.1;
            if (side === 'left') {
              const maxStart = found.cue.endTime - MIN;
              found.cue.startTime = clamp(newTime, 0, maxStart);
            } else {
              const minEnd = found.cue.startTime + MIN;
              found.cue.endTime = Math.max(minEnd, newTime);
            }
            found.track.cues.sort((a, b) => a.startTime - b.startTime);
          }),

        removeCaption: (cueId) =>
          set((s) => {
            if (!s.project) return;
            for (const track of s.project.captionTracks) {
              const idx = track.cues.findIndex((c) => c.id === cueId);
              if (idx >= 0) {
                track.cues.splice(idx, 1);
                break;
              }
            }
          }),

        setCaptionStyle: (cueId, partial) =>
          set((s) => {
            if (!s.project) return;
            const found = findCue(s.project, cueId);
            if (found) Object.assign(found.cue.style, partial);
          }),

        applyGabineteCaptions: (trackId, maxWords = 5) => {
          let count = 0;
          set((s) => {
            if (!s.project) return;
            const track = s.project.captionTracks.find((t) => t.id === trackId);
            if (!track || track.cues.length === 0) return;
            const novos: CaptionCue[] = [];
            for (const cue of [...track.cues].sort(
              (a, b) => a.startTime - b.startTime,
            )) {
              const estilizado: CaptionCue = {
                ...cue,
                style: { ...cue.style, ...GABINETE_CAPTION_STYLE },
              };
              for (const parte of splitCueByWords(estilizado, maxWords)) {
                novos.push({ id: genId('cue'), ...parte });
              }
            }
            // O corte em pedaços cria cues encostados (fim == início do
            // próximo). O `legendas.py` roda a anticolisão logo depois — aqui
            // também, senão o preset já nasceria com colisão.
            track.cues = resolveCueCollisions(novos).cues;
            // A faixa passa a ter o estilo do gabinete como PADRÃO: cue novo
            // criado depois já nasce amarelo, sem repetir o preset.
            track.defaultStyle = {
              ...(track.cues[0]?.style ?? ({} as CaptionStyle)),
            };
            count = track.cues.length;
          });
          return count;
        },

        resolverColisoesLegendas: (trackId) => {
          let ajustados = 0;
          set((s) => {
            if (!s.project) return;
            const track = s.project.captionTracks.find((t) => t.id === trackId);
            if (!track || track.cues.length < 2) return;
            const r = resolveCueCollisions(track.cues);
            track.cues = r.cues;
            ajustados = r.ajustados;
          });
          return ajustados;
        },

        setCaptionSlot: (cueId, slot) =>
          set((s) => {
            if (!s.project) return;
            const found = findCue(s.project, cueId);
            if (found) found.cue.slot = slot;
          }),

        importSrt: async (file, options) => {
          const parser = options?.parser;
          if (!parser) {
            // Sem parser injetado: caller (componente) deve ter usado lib `subtitle`.
            // Mantemos store puro sem dependência do parser para rodar em SSR.
            console.warn(
              '[editor/store] importSrt chamado sem parser. Injete um parser via options.parser.',
            );
            return null;
          }
          let cues: Array<Omit<CaptionCue, 'id'>>;
          try {
            cues = await parser(file);
          } catch (err) {
            console.error('[editor/store] erro parseando SRT:', err);
            return null;
          }
          // Cria track e popula com cues.
          const trackId = get().addCaptionTrack(
            options?.trackName ?? file.name.replace(/\.srt$/i, ''),
            options?.language,
          );
          for (const cue of cues) {
            get().addCaption(trackId, cue);
          }
          return trackId;
        },

        exportSrt: async (trackId) => {
          const project = get().project;
          if (!project) return null;
          const track = project.captionTracks.find((t) => t.id === trackId);
          if (!track) return null;
          // Gera SRT inline (sem dependência da lib `subtitle` no store).
          const srt = track.cues
            .map((cue, i) => {
              const start = formatSrtTime(cue.startTime);
              const end = formatSrtTime(cue.endTime);
              return `${i + 1}\n${start} --> ${end}\n${cue.text}\n`;
            })
            .join('\n');
          return new Blob([srt], { type: 'application/x-subrip' });
        },

        // ===== 5.8 UI / Playback (no-history) =============================
        setPlayhead: (time, _opts) =>
          set((s) => {
            // `_opts.fromPlayback` é puramente informativo — consumidores que
            // se inscrevem ao store via `subscribe` podem usá-lo para decidir
            // se reagem (evitar loop com o engine de sync). O store em si
            // não distingue.
            s.ui.playhead = Math.max(0, time);
          }),

        play: () =>
          set((s) => {
            // Se o playhead já está no fim (ou além), recomeça do início —
            // assim apertar Play no fim "toca de novo" em vez de travar.
            const dur = s.project?.duration ?? 0;
            if (dur > 0 && s.ui.playhead >= dur && !s.ui.isLooping) {
              s.ui.playhead = 0;
            }
            s.ui.isPlaying = true;
          }),

        pause: () =>
          set((s) => {
            s.ui.isPlaying = false;
          }),

        togglePlay: () =>
          set((s) => {
            const next = !s.ui.isPlaying;
            if (next) {
              // Mesmo reset-no-fim do `play()` ao retomar via toggle.
              const dur = s.project?.duration ?? 0;
              if (dur > 0 && s.ui.playhead >= dur && !s.ui.isLooping) {
                s.ui.playhead = 0;
              }
            }
            s.ui.isPlaying = next;
          }),

        setLoopRange: (range) =>
          set((s) => {
            s.ui.loopRange = range ?? undefined;
            s.ui.isLooping = range !== null;
          }),

        setZoom: (pxPerSecond) =>
          set((s) => {
            s.ui.zoom = clamp(pxPerSecond, 5, 1000);
          }),

        setTool: (tool) =>
          set((s) => {
            s.ui.tool = tool;
          }),

        setSnapEnabled: (enabled) =>
          set((s) => {
            s.ui.snapEnabled = enabled;
          }),

        selectClip: (clipId, multi) =>
          set((s) => {
            if (clipId === null) {
              s.ui.selectedClipIds = [];
              return;
            }
            if (multi) {
              if (s.ui.selectedClipIds.includes(clipId)) {
                s.ui.selectedClipIds = s.ui.selectedClipIds.filter(
                  (id) => id !== clipId,
                );
              } else {
                s.ui.selectedClipIds.push(clipId);
              }
            } else {
              s.ui.selectedClipIds = [clipId];
              s.ui.selectedCueIds = [];
            }
          }),

        selectCue: (cueId, multi) =>
          set((s) => {
            if (cueId === null) {
              s.ui.selectedCueIds = [];
              return;
            }
            if (multi) {
              if (s.ui.selectedCueIds.includes(cueId)) {
                s.ui.selectedCueIds = s.ui.selectedCueIds.filter(
                  (id) => id !== cueId,
                );
              } else {
                s.ui.selectedCueIds.push(cueId);
              }
            } else {
              s.ui.selectedCueIds = [cueId];
              s.ui.selectedClipIds = [];
            }
          }),

        selectTrack: (trackId) =>
          set((s) => {
            s.ui.selectedTrackId = trackId;
          }),

        setInspectorTab: (tab) =>
          set((s) => {
            s.ui.inspectorTab = tab;
          }),

        setExportDialogOpen: (open) =>
          set((s) => {
            s.ui.exportDialogOpen = open;
          }),

        setIsDragging: (dragging) =>
          set((s) => {
            s.ui.isDragging = dragging;
          }),

        clearSelection: () =>
          set((s) => {
            s.ui.selectedClipIds = [];
            s.ui.selectedCueIds = [];
            s.ui.selectedTrackId = null;
          }),

        setSavingState: (saving) => {
          // (no-history)
          const t = (useEditorStore as unknown as TemporalCarrier).temporal;
          t?.getState().pause();
          set((s) => {
            s.ui.isSaving = saving;
          });
          t?.getState().resume();
        },

        setLastSavedAt: (date) => {
          // (no-history)
          const t = (useEditorStore as unknown as TemporalCarrier).temporal;
          t?.getState().pause();
          set((s) => {
            s.ui.lastSavedAt = date;
            s.ui.saveError = null;
          });
          t?.getState().resume();
        },

        setSaveError: (err) => {
          // (no-history)
          const t = (useEditorStore as unknown as TemporalCarrier).temporal;
          t?.getState().pause();
          set((s) => {
            s.ui.saveError = err;
          });
          t?.getState().resume();
        },

        // ===== 5.9 Histórico ==============================================
        undo: (): void => {
          const t = (useEditorStore as unknown as TemporalCarrier).temporal;
          t?.getState().undo();
        },
        redo: (): void => {
          const t = (useEditorStore as unknown as TemporalCarrier).temporal;
          t?.getState().redo();
        },
        canUndo: (): boolean => {
          const t = (useEditorStore as unknown as TemporalCarrier).temporal;
          return (t?.getState().pastStates.length ?? 0) > 0;
        },
        canRedo: (): boolean => {
          const t = (useEditorStore as unknown as TemporalCarrier).temporal;
          return (t?.getState().futureStates.length ?? 0) > 0;
        },

        // ===== 5.10 Export ================================================
        createRenderJob: (settings, engine, ownerUid) => {
          const project = get().project;
          if (!project) return null;
          const id = genId('job');
          const now = { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 } as unknown as RenderJob['createdAt'];
          const job: RenderJob = {
            id,
            projectId: project.id,
            ownerUid,
            engine,
            status: 'pending',
            progress: 0,
            exportSettings: settings,
            createdAt: now,
          };
          // (no-history) — render jobs não fazem parte do project.
          set((s) => {
            s.renderJobs.push(job);
            s.ui.exportDialogOpen = false;
          });
          return job;
        },

        updateRenderJob: (jobId, patch) =>
          set((s) => {
            const job = s.renderJobs.find((j) => j.id === jobId);
            if (job) Object.assign(job, patch);
          }),

        cancelRenderJob: (jobId) =>
          set((s) => {
            const job = s.renderJobs.find((j) => j.id === jobId);
            if (job && (job.status === 'pending' || job.status === 'rendering')) {
              job.status = 'cancelled';
            }
          }),

        removeRenderJob: (jobId) =>
          set((s) => {
            s.renderJobs = s.renderJobs.filter((j) => j.id !== jobId);
          }),
      })),
      {
        // Persist apenas preferências leves de UI.
        // O `project` NÃO entra (vem do Firestore via loadProject).
        name: 'editor-ui-prefs',
        partialize: (state) => ({
          ui: {
            zoom: state.ui.zoom,
            tool: state.ui.tool,
            snapEnabled: state.ui.snapEnabled,
            snapThresholdPx: state.ui.snapThresholdPx,
            inspectorTab: state.ui.inspectorTab,
          },
        }),
        // Merge raso para não sobrescrever defaults com `undefined`.
        merge: (persisted, current) => {
          const p = persisted as Partial<{ ui: Partial<EditorUIState> }> | undefined;
          return {
            ...current,
            ui: {
              ...current.ui,
              ...(p?.ui ?? {}),
            },
          };
        },
      },
    ),
    {
      // Limite de 50 frames de undo (spec: "limita 50 frames").
      limit: 50,
      // Apenas o `project` faz parte do histórico — UI e renderJobs ficam fora.
      partialize: (state) => ({ project: state.project }),
      // Equality para evitar entries triviais (mudanças apenas em UI).
      equality: (a, b) => a.project === b.project,
    },
  ),
);

// ============================================================================
// Acesso ao histórico (zundo expõe via `useEditorStore.temporal`).
// ============================================================================

/**
 * Carrier type para acessar o estado temporal do zundo.
 *
 * O middleware `temporal` enriquece o store com `.temporal` (StoreApi de
 * `TemporalState`). Exportamos um helper tipado para uso fora deste arquivo.
 */
interface TemporalCarrier {
  temporal: {
    getState: () => TemporalState<{ project: VideoProject | null }>;
    subscribe: (
      listener: (state: TemporalState<{ project: VideoProject | null }>) => void,
    ) => () => void;
  };
}

export const editorTemporal = (useEditorStore as unknown as TemporalCarrier)
  .temporal;

// ============================================================================
// Helpers privados
// ============================================================================

/**
 * Número efetivo de camadas (subtracks) de uma track de vídeo: o máximo entre
 * `layerCount` declarado e a maior `layer` em uso + 1. Mantém clips com layer
 * alto sempre dentro da contagem. (Espelha `trackLayerCount` de preview-utils,
 * duplicado aqui para manter o store sem dependência da camada de preview.)
 */
function effectiveLayerCount(track: Track): number {
  let maxLayer = 0;
  for (const c of track.clips) {
    const l = c.layer ?? 0;
    if (l > maxLayer) maxLayer = l;
  }
  return Math.max(track.layerCount ?? 1, maxLayer + 1);
}

/**
 * Duração que um clip ocupa na TIMELINE, considerando a velocidade: um clip a
 * 2x ocupa metade do tempo do trecho do asset; a 0.5x, o dobro. Fonte única da
 * invariante `(endInAsset - startInAsset) / playbackRate`.
 */
function timelineDurationOf(clip: Clip): number {
  const rate = clip.playbackRate || 1;
  return Math.max(0, (clip.endInAsset - clip.startInAsset) / rate);
}

/**
 * Reposiciona `endInTimeline` para refletir a velocidade atual do clip,
 * mantendo `startInTimeline` como âncora (esquerda fixa). Mutação in-place
 * usada por mudanças de `playbackRate` (não faz ripple nos clips vizinhos —
 * decisão de UX: aceita gap/overlap, igual ao resto das edições de clip).
 */
function applyPlaybackRateToTimeline(clip: Clip): void {
  clip.endInTimeline = clip.startInTimeline + timelineDurationOf(clip);
}

/** Calcula duração total do projeto a partir do clip mais distante. */
function computeProjectDuration(project: VideoProject): number {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.endInTimeline > max) max = clip.endInTimeline;
    }
  }
  return max;
}

/** Formata segundos como `HH:MM:SS,mmm` (formato SRT). */
function formatSrtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(ms, 3)}`;
}
