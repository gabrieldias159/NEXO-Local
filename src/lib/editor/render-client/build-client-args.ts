/**
 * Constrói os argumentos do FFmpeg para render client-side.
 *
 * Espelha (de forma adaptada) o `buildFilterComplex` de
 * `functions/src/shared/ffmpeg-builder.ts`, mas:
 *  - Trabalha com inputs por índice (não há `localPath`).
 *  - Output sempre é `output.mp4` no FS virtual do FFmpeg.wasm.
 *  - Não suporta `subtitles=` (libass não está em FFmpeg.wasm padrão —
 *    a eligibility já exige `burnCaptions=false`).
 *
 * Mantém a paridade visual com o builder server: mesma fórmula de
 * trim/scale/pad/overlay/xfade/audio mix.
 */

import type {
  Clip,
  ExportSettings,
  Track,
  TransitionConfig,
  VideoProject,
} from '@/lib/editor/types';

// ============================================================================
// Mapeamento transição → xfade (espelha o server)
// ============================================================================

const TRANSITION_TO_XFADE: Record<TransitionConfig['type'], string> = {
  fade: 'fade',
  crossfade: 'fade',
  'slide-left': 'slideleft',
  'slide-right': 'slideright',
  'slide-up': 'slideup',
  'slide-down': 'slidedown',
  'zoom-in': 'circleopen',
  'zoom-out': 'circleclose',
  'wipe-left': 'wipeleft',
  'wipe-right': 'wiperight',
  'push-left': 'smoothleft',
  'push-right': 'smoothright',
  circle: 'circleopen',
  iris: 'circleopen',
};

// ============================================================================
// Tipos públicos
// ============================================================================

export interface BuildClientArgsInput {
  project: VideoProject;
  /**
   * Blobs já carregados dos assets, em ordem de índice (0, 1, 2...).
   * O `index` corresponde à ordem dos `-i input{index}` na linha de comando.
   */
  assetBlobs: { assetId: string; blob: Blob; index: number }[];
  exportSettings: ExportSettings;
}

export interface ClientRenderInput {
  /**
   * Arquivos a serem escritos no FS virtual do FFmpeg.wasm via `writeFile`.
   * O nome bate com o que `args` referencia (ex: `input0.mp4`, `input1.mp3`).
   */
  inputFiles: { name: string; data: Uint8Array }[];
  /** Args completos para `ffmpeg.exec(args)`. */
  args: string[];
  /** Nome do arquivo de saída no FS virtual (sempre output.mp4 ou .webm). */
  outputName: string;
  /** Mime type do output (para o Blob final). */
  outputMime: string;
}

// ============================================================================
// Função pública
// ============================================================================

export async function buildClientRenderInput(
  input: BuildClientArgsInput,
): Promise<ClientRenderInput> {
  const { project, assetBlobs, exportSettings } = input;

  // 1. Resolve resolução final
  const outRes = resolutionPresetToWH(
    exportSettings.resolution,
    {
      width: project.resolution.width,
      height: project.resolution.height,
    },
  );

  // 2. Lê blobs como Uint8Array para escrita posterior
  const inputFiles: { name: string; data: Uint8Array }[] = [];
  for (const a of assetBlobs) {
    const buf = new Uint8Array(await a.blob.arrayBuffer());
    const ext = guessExt(a.blob.type);
    inputFiles.push({ name: `input${a.index}.${ext}`, data: buf });
  }

  // 3. Monta filter_complex
  // No filter_graph o FFmpeg referencia inputs pelo índice posicional
  // (`[idx:v]` / `[idx:a]`), então o nome do arquivo no FS virtual é
  // irrelevante para a montagem.
  const fc = buildFilterComplex({
    project,
    inputAssets: assetBlobs.map((a) => ({
      assetId: a.assetId,
      index: a.index,
    })),
    outputResolution: outRes,
    exportSettings,
  });

  // 4. Monta os `-i` na ordem dos índices
  const sortedAssets = [...assetBlobs].sort((a, b) => a.index - b.index);

  const args: string[] = [];
  for (const a of sortedAssets) {
    const ext = guessExt(a.blob.type);
    args.push('-i', `input${a.index}.${ext}`);
  }
  // Inputs sintéticos (lavfi) — vêm depois dos reais, índice já calculado.
  for (const s of fc.syntheticInputs) {
    args.push(...s.options, '-i', s.url);
  }

  // 5. filter_complex + map streams
  args.push('-filter_complex', fc.filterComplex);
  args.push('-map', fc.outputVideoStream);
  args.push('-map', fc.outputAudioStream);

  // 6. Encoding params
  const isWebm = exportSettings.format === 'webm';
  if (isWebm) {
    args.push('-c:v', 'libvpx');
    args.push('-b:v', `${qualityToBitrateKbps(exportSettings.quality)}k`);
    args.push('-c:a', 'libvorbis');
  } else {
    args.push('-c:v', 'libx264');
    args.push('-preset', 'ultrafast'); // wasm é CPU-bound, ultrafast prioriza velocidade
    args.push('-crf', String(qualityToCRF(exportSettings.quality)));
    args.push('-pix_fmt', 'yuv420p');
    args.push('-c:a', 'aac');
    args.push('-b:a', '128k');
    args.push('-movflags', '+faststart');
  }

  args.push('-r', String(project.frameRate));

  const outputName = isWebm ? 'output.webm' : 'output.mp4';
  const outputMime = isWebm ? 'video/webm' : 'video/mp4';
  args.push(outputName);

  return { inputFiles, args, outputName, outputMime };
}

// ============================================================================
// Filter complex builder (adaptado do server)
// ============================================================================

interface BuildFilterComplexInput {
  project: VideoProject;
  inputAssets: {
    assetId: string;
    index: number;
  }[];
  exportSettings: ExportSettings;
  outputResolution: { width: number; height: number };
}

interface BuildFilterComplexOutput {
  filterComplex: string;
  outputVideoStream: string;
  outputAudioStream: string;
  totalInputs: number;
  syntheticInputs: SyntheticInput[];
}

interface SyntheticInput {
  url: string;
  options: string[];
  index: number;
  kind: 'color' | 'anullsrc';
}

function buildFilterComplex(
  input: BuildFilterComplexInput,
): BuildFilterComplexOutput {
  const { project, inputAssets, outputResolution } = input;
  const W = outputResolution.width;
  const H = outputResolution.height;
  const projectDuration = computeProjectDuration(project);

  const assetIndex = new Map<string, number>();
  for (const a of inputAssets) assetIndex.set(a.assetId, a.index);

  // ---- 1. Inputs sintéticos -----------------------------------------------
  const syntheticInputs: SyntheticInput[] = [];

  const baseInputIndex = inputAssets.length;
  syntheticInputs.push({
    url: `color=c=black:s=${W}x${H}:r=${project.frameRate}:d=${projectDuration}`,
    options: ['-f', 'lavfi'],
    index: baseInputIndex,
    kind: 'color',
  });

  const silenceInputIndex = inputAssets.length + 1;
  syntheticInputs.push({
    url: 'anullsrc=channel_layout=stereo:sample_rate=48000',
    options: ['-f', 'lavfi'],
    index: silenceInputIndex,
    kind: 'anullsrc',
  });

  // ---- 2. Pipeline de vídeo -----------------------------------------------
  const lines: string[] = [];

  const videoTracks = project.tracks
    .filter((t) => t.type === 'video' && t.visible)
    .sort((a, b) => a.index - b.index);

  const clipNodes: Array<{
    label: string;
    start: number;
    end: number;
    track: Track;
    clip: Clip;
    _consumed?: boolean;
  }> = [];

  videoTracks.forEach((track) => {
    // Camadas (subtracks) maiores ficam por cima → sobrepostas por último.
    // Sort estável mantém a ordem de inserção para clips na mesma camada.
    const orderedClips = [...track.clips].sort(
      (a, b) => (a.layer ?? 0) - (b.layer ?? 0),
    );
    orderedClips.forEach((clip, ci) => {
      if (clip.hidden) return;
      const idx = assetIndex.get(clip.assetId);
      if (idx === undefined) return;
      const label = `v_${safe(track.id)}_${ci}`;
      lines.push(
        buildVideoClipChain({
          inputIndex: idx,
          clip,
          outputResolution: { width: W, height: H },
          stageMode: project.stageMode,
          splitRatio: project.splitRatio,
          outLabel: label,
          frameRate: project.frameRate,
        }),
      );
      clipNodes.push({
        label: `[${label}]`,
        start: clip.startInTimeline,
        end: clip.endInTimeline,
        track,
        clip,
      });
    });
  });

  // ---- 3. Composição em cima da base preta --------------------------------
  let videoStream = `[${baseInputIndex}:v]`;

  clipNodes.forEach((node, i) => {
    if (node._consumed) return;
    const inLabel = videoStream;
    const outLabel = `[v_overlay_${i}]`;

    const next = findNextClipInTrack(node, clipNodes, i);
    if (
      next &&
      node.clip.transitionOut &&
      areClipsAdjacent(node.clip, next.clip) &&
      node.track.id === next.track.id
    ) {
      const tDur = Math.max(0.1, node.clip.transitionOut.duration);
      const xfadeName =
        TRANSITION_TO_XFADE[node.clip.transitionOut.type] ?? 'fade';
      const xfadeOffset = Math.max(0, node.end - tDur);
      const xfadeLabel = `[v_xfade_${i}]`;
      lines.push(
        `${node.label}${next.label}xfade=transition=${xfadeName}:duration=${tDur.toFixed(3)}:offset=${xfadeOffset.toFixed(3)}${xfadeLabel}`,
      );
      const combinedStart = node.start;
      const combinedEnd = next.end;
      lines.push(
        `${inLabel}${xfadeLabel}overlay=enable='between(t,${combinedStart.toFixed(3)},${combinedEnd.toFixed(3)})'${outLabel}`,
      );
      videoStream = outLabel;
      next._consumed = true;
      return;
    }

    lines.push(
      `${inLabel}${node.label}overlay=enable='between(t,${node.start.toFixed(3)},${node.end.toFixed(3)})'${outLabel}`,
    );
    videoStream = outLabel;
  });

  // ---- 4. Captions queimadas ----------------------------------------------
  // CLIENT-SIDE: NÃO suportado (eligibility já bloqueia). Skip.

  // ---- 5. Renomeia stream final -------------------------------------------
  lines.push(`${videoStream}null[v_final]`);
  videoStream = '[v_final]';

  // ---- 6. Áudio -----------------------------------------------------------
  const audioLabels: string[] = [];
  const audioTracks = project.tracks.filter(
    (t) => t.type !== 'video' || hasAudibleClip(t),
  );
  audioTracks.forEach((track) => {
    if (track.muted) return;
    track.clips.forEach((clip, ci) => {
      if (clip.hidden || clip.audio.muted) return;
      const idx = assetIndex.get(clip.assetId);
      if (idx === undefined) return;
      const label = `a_${safe(track.id)}_${ci}`;
      const built = buildAudioClipChain({
        inputIndex: idx,
        clip,
        outLabel: label,
      });
      if (!built) return;
      lines.push(built);
      audioLabels.push(`[${label}]`);
    });
  });

  let audioStream: string;
  if (audioLabels.length === 0) {
    lines.push(
      `[${silenceInputIndex}:a]atrim=duration=${projectDuration.toFixed(3)},asetpts=PTS-STARTPTS[a_final]`,
    );
    audioStream = '[a_final]';
  } else if (audioLabels.length === 1) {
    lines.push(`${audioLabels[0]}anull[a_final]`);
    audioStream = '[a_final]';
  } else {
    lines.push(
      `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0[a_final]`,
    );
    audioStream = '[a_final]';
  }

  return {
    filterComplex: lines.join(';'),
    outputVideoStream: videoStream,
    outputAudioStream: audioStream,
    totalInputs: inputAssets.length + syntheticInputs.length,
    syntheticInputs,
  };
}

// ============================================================================
// Builders internos
// ============================================================================

interface BuildVideoChainArgs {
  inputIndex: number;
  clip: Clip;
  outputResolution: { width: number; height: number };
  stageMode: VideoProject['stageMode'];
  splitRatio: number;
  outLabel: string;
  frameRate: number;
}

function buildVideoClipChain(args: BuildVideoChainArgs): string {
  const {
    inputIndex,
    clip,
    outputResolution,
    stageMode,
    splitRatio,
    outLabel,
    frameRate,
  } = args;
  const { width: W, height: H } = outputResolution;

  const filters: string[] = [];

  const dur = Math.max(0.001, clipDurationOnTimeline(clip));
  const rate = clip.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1;
  filters.push(
    `trim=start=${clip.startInAsset.toFixed(3)}:end=${clip.endInAsset.toFixed(3)}`,
  );
  // Velocidade: comprime/estica os PTS do trecho do asset. Com rate=2 o
  // material toca em metade do tempo (rápido); com rate=0.5, no dobro (lento).
  //
  // E DESLOCA para a posicao do clip na TIMELINE (`+start/TB`).
  //
  // Sem esse deslocamento o clip ficava com PTS a partir de 0 enquanto o
  // `overlay` so o exibia entre `startInTimeline` e `endInTimeline` — ou seja,
  // quando a exibicao comecava, o material do clip JA TINHA ACABADO e o FFmpeg
  // segurava o ultimo quadro. So o primeiro clip (que comeca em 0) saia certo;
  // do segundo em diante a imagem congelava/trocava de ordem enquanto o audio,
  // esse sim posicionado via `adelay`, tocava o trecho correto. Era a causa do
  // "inverteu a ordem dos videos" e do som fora de sincronia.
  const offTl = Math.max(0, clip.startInTimeline);
  const desloca = offTl > 0 ? `+${offTl.toFixed(3)}/TB` : '';
  if (rate !== 1) {
    filters.push(`setpts=(PTS-STARTPTS)/${rate.toFixed(6)}${desloca}`);
  } else {
    filters.push(`setpts=PTS-STARTPTS${desloca}`);
  }

  filters.push(`fps=${frameRate}`);

  let slotW = W;
  let slotH = H;
  let slotX = 0;
  let slotY = 0;
  if (stageMode === 'split-vertical') {
    const ratio = Math.min(0.9, Math.max(0.1, splitRatio));
    if (clip.slot === 'top') {
      slotH = Math.round(H * ratio);
    } else if (clip.slot === 'bottom') {
      slotH = Math.round(H * (1 - ratio));
      slotY = H - slotH;
    }
    slotW = ensureEven(slotW);
    slotH = ensureEven(slotH);
  }

  const f = clip.filters;
  if (f.brightness !== 1 || f.contrast !== 1 || f.saturation !== 1) {
    const brightness = (f.brightness - 1).toFixed(3);
    filters.push(
      `eq=brightness=${brightness}:contrast=${f.contrast.toFixed(3)}:saturation=${f.saturation.toFixed(3)}`,
    );
  }
  if (f.hue && f.hue !== 0) {
    filters.push(`hue=h=${f.hue.toFixed(2)}`);
  }
  if (f.blur && f.blur > 0) {
    const luma = Math.max(1, Math.round(f.blur));
    filters.push(`boxblur=luma_radius=${luma}:luma_power=1`);
  }
  if (f.grayscale && f.grayscale > 0) {
    const g = Math.min(1, f.grayscale);
    const k = 1 - g;
    const rr = (k + g * 0.299).toFixed(3);
    const rg = (g * 0.587).toFixed(3);
    const rb = (g * 0.114).toFixed(3);
    const gr = (g * 0.299).toFixed(3);
    const gg = (k + g * 0.587).toFixed(3);
    const gb = (g * 0.114).toFixed(3);
    const br = (g * 0.299).toFixed(3);
    const bg = (g * 0.587).toFixed(3);
    const bb = (k + g * 0.114).toFixed(3);
    filters.push(
      `colorchannelmixer=rr=${rr}:rg=${rg}:rb=${rb}:gr=${gr}:gg=${gg}:gb=${gb}:br=${br}:bg=${bg}:bb=${bb}`,
    );
  }

  if (clip.transform.flipH) filters.push('hflip');
  if (clip.transform.flipV) filters.push('vflip');
  if (clip.transform.rotation && clip.transform.rotation !== 0) {
    const rad = (clip.transform.rotation * Math.PI) / 180;
    filters.push(
      `rotate=${rad.toFixed(4)}:c=black@0:ow=rotw(${rad.toFixed(4)}):oh=roth(${rad.toFixed(4)})`,
    );
  }

  const scaleFactor = Math.max(0.05, clip.transform.scale);
  const targetW = Math.max(2, ensureEven(Math.round(slotW * scaleFactor)));
  const targetH = Math.max(2, ensureEven(Math.round(slotH * scaleFactor)));
  filters.push(
    `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease`,
  );
  filters.push(
    `pad=${slotW}:${slotH}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
  );

  const offsetX = Math.round(slotX + (clip.transform.x * slotW) / 2);
  const offsetY = Math.round(slotY + (clip.transform.y * slotH) / 2);
  filters.push(`pad=${W}:${H}:${offsetX}:${offsetY}:color=black@0`);

  if (clip.transform.opacity !== undefined && clip.transform.opacity < 1) {
    const aa = Math.max(0, Math.min(1, clip.transform.opacity));
    filters.push(`format=rgba,colorchannelmixer=aa=${aa.toFixed(3)}`);
  } else {
    filters.push('format=rgba');
  }

  filters.push(`trim=duration=${dur.toFixed(3)}`);
  filters.push('setpts=PTS-STARTPTS');

  return `[${inputIndex}:v]${filters.join(',')}[${outLabel}]`;
}

interface BuildAudioChainArgs {
  inputIndex: number;
  clip: Clip;
  outLabel: string;
}

function buildAudioClipChain(args: BuildAudioChainArgs): string | null {
  const { inputIndex, clip, outLabel } = args;
  const dur = Math.max(0.001, clipDurationOnTimeline(clip));
  const startTl = Math.max(0, clip.startInTimeline);

  const rate = clip.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1;
  const filters: string[] = [];
  filters.push(
    `atrim=start=${clip.startInAsset.toFixed(3)}:end=${clip.endInAsset.toFixed(3)}`,
  );
  filters.push('asetpts=PTS-STARTPTS');

  // Velocidade do áudio via atempo (preserva pitch dentro do razoável). Como
  // atempo aceita só 0.5..2.0, encadeamos fatores para cobrir 0.25..4.
  if (rate !== 1) {
    for (const f of atempoFactors(rate)) {
      filters.push(`atempo=${f.toFixed(6)}`);
    }
  }

  if (clip.audio.fadeInDuration > 0) {
    filters.push(
      `afade=t=in:st=0:d=${Math.min(clip.audio.fadeInDuration, dur).toFixed(3)}`,
    );
  }
  if (clip.audio.fadeOutDuration > 0) {
    const start = Math.max(0, dur - clip.audio.fadeOutDuration);
    filters.push(
      `afade=t=out:st=${start.toFixed(3)}:d=${Math.min(clip.audio.fadeOutDuration, dur).toFixed(3)}`,
    );
  }
  if (clip.audio.volume !== 1) {
    filters.push(`volume=${clip.audio.volume.toFixed(3)}`);
  }
  if (clip.audio.pan && clip.audio.pan !== 0) {
    const pan = Math.max(-1, Math.min(1, clip.audio.pan));
    const left = (1 - Math.max(0, pan)).toFixed(3);
    const right = (1 + Math.min(0, pan)).toFixed(3);
    filters.push(`pan=stereo|c0=${left}*c0|c1=${right}*c1`);
  }
  if (startTl > 0) {
    const ms = Math.round(startTl * 1000);
    filters.push(`adelay=${ms}|${ms}`);
  }

  return `[${inputIndex}:a]${filters.join(',')}[${outLabel}]`;
}

// ============================================================================
// Helpers
// ============================================================================

function ensureEven(n: number): number {
  return n % 2 === 0 ? n : n + 1;
}

function clipDurationOnTimeline(clip: Clip): number {
  return Math.max(0, clip.endInTimeline - clip.startInTimeline);
}

/**
 * Decompõe um fator de velocidade em uma cadeia de `atempo` válidos (cada um
 * em 0.5..2.0). Ex.: 4 → [2, 2]; 0.25 → [0.5, 0.5]; 3 → [2, 1.5].
 */
function atempoFactors(rate: number): number[] {
  const factors: number[] = [];
  let remaining = rate;
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-6) {
    factors.push(remaining);
  }
  return factors;
}

function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function computeProjectDuration(project: VideoProject): number {
  let max = project.duration ?? 0;
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (c.hidden) continue;
      if (c.endInTimeline > max) max = c.endInTimeline;
    }
  }
  return Math.max(0.1, max);
}

function findNextClipInTrack<
  T extends { track: Track; clip: Clip; start: number; end: number; label: string },
>(current: T, all: T[], fromIndex: number): T | null {
  for (let i = fromIndex + 1; i < all.length; i += 1) {
    if (all[i].track.id === current.track.id) return all[i];
  }
  return null;
}

function areClipsAdjacent(a: Clip, b: Clip): boolean {
  return Math.abs(a.endInTimeline - b.startInTimeline) < 0.05;
}

function hasAudibleClip(track: Track): boolean {
  return track.clips.some((c) => !c.hidden && !c.audio.muted);
}

function resolutionPresetToWH(
  preset: ExportSettings['resolution'],
  projectResolution: { width: number; height: number },
): { width: number; height: number } {
  const isPortrait = projectResolution.height > projectResolution.width;
  const longSide = preset === '1080p' ? 1080 : preset === '720p' ? 720 : 480;
  const aspect = isPortrait
    ? projectResolution.height / projectResolution.width
    : projectResolution.width / projectResolution.height;
  if (isPortrait) {
    const height = Math.round(longSide * aspect);
    return ensureEvenSize({ width: longSide, height });
  }
  const width = Math.round(longSide * aspect);
  return ensureEvenSize({ width, height: longSide });
}

function ensureEvenSize(d: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return {
    width: d.width % 2 === 0 ? d.width : d.width + 1,
    height: d.height % 2 === 0 ? d.height : d.height + 1,
  };
}

function qualityToCRF(q: ExportSettings['quality']): number {
  if (q === 'low') return 28;
  if (q === 'high') return 20;
  return 23;
}

function qualityToBitrateKbps(q: ExportSettings['quality']): number {
  if (q === 'low') return 1500;
  if (q === 'high') return 6000;
  return 3000;
}

/**
 * Detecta a extensão a partir do mime type. FFmpeg.wasm é flexível mas usar
 * extensão coerente ajuda na detecção do demuxer.
 */
function guessExt(mime: string): string {
  if (!mime) return 'bin';
  if (mime.startsWith('video/mp4')) return 'mp4';
  if (mime.startsWith('video/webm')) return 'webm';
  if (mime.startsWith('video/quicktime')) return 'mov';
  if (mime.startsWith('video/')) return 'mp4';
  if (mime.startsWith('audio/mpeg')) return 'mp3';
  if (mime.startsWith('audio/wav') || mime === 'audio/x-wav') return 'wav';
  if (mime.startsWith('audio/ogg')) return 'ogg';
  if (mime.startsWith('audio/aac')) return 'aac';
  if (mime.startsWith('audio/')) return 'mp3';
  if (mime.startsWith('image/jpeg')) return 'jpg';
  if (mime.startsWith('image/png')) return 'png';
  if (mime.startsWith('image/webp')) return 'webp';
  if (mime.startsWith('image/')) return 'png';
  return 'bin';
}
