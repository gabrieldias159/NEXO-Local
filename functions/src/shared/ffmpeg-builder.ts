/**
 * Builder do `filter_complex` do FFmpeg para o render server-side de um
 * `VideoProject` do editor.
 *
 * Pipeline (alto nível):
 *
 *  1. Para cada clip de vídeo (em ordem das tracks por `index` ascendente):
 *     - `trim` + `setpts` (recorte do asset)
 *     - `scale` + `pad` para encaixar no canvas final
 *     - `eq`, `hue`, `boxblur`, `colorchannelmixer` (filtros)
 *     - `rotate` quando aplicável
 *     - Slot vertical (`top`/`bottom`) → `pad` na metade oposta com preto
 *     - `setpts` ajusta o tempo para `startInTimeline`
 *
 *  2. Camada-base preta com `color=size=WxH:duration=D` e overlays
 *     sucessivos: para cada clip, `[base][v_i]overlay=enable='between(t,a,b)'`.
 *     Em pares com `transitionOut`/`transitionIn`, usa `xfade=transition=…`
 *     no ponto de transição (substitui o overlay simples).
 *
 *  3. Áudio: `atrim` + `volume` + `afade` + `pan`, depois `amix=inputs=N`
 *     para mixar todas as tracks de áudio. Se nenhum clip tem áudio,
 *     gera silêncio (`anullsrc`).
 *
 *  4. Captions: se `burnCaptions === true`, adiciona `subtitles=<assPath>`
 *     no final do pipeline de vídeo.
 *
 *  5. Streams de saída: `[v_final]` e `[a_final]`.
 *
 * Trade-offs:
 *
 * - O builder NÃO tenta usar `concat` filter para tracks com múltiplos
 *   clips porque clips podem ter tracks/slots diferentes. Em vez disso,
 *   monta cada clip como um overlay independente sobre uma base preta —
 *   menos eficiente em CPU, mas correto para split-screen e overlays.
 *
 * - `xfade` precisa que os dois clips estejam na MESMA pista lógica
 *   (sem sobreposição). Quando o builder detecta `transitionOut` no
 *   clip A com um clip B subsequente na mesma track, usa `xfade`. Caso
 *   contrário, faz fade-in/fade-out via `fade` filter individualmente.
 */

import type {
  Clip,
  ExportSettings,
  Track,
  TransitionConfig,
  VideoProject,
} from "./types";

// ============================================================================
// Mapeamento de transições (espelha src/lib/editor/transitions/index.ts)
// ============================================================================

const TRANSITION_TO_XFADE: Record<TransitionConfig["type"], string> = {
  fade: "fade",
  crossfade: "fade",
  "slide-left": "slideleft",
  "slide-right": "slideright",
  "slide-up": "slideup",
  "slide-down": "slidedown",
  "zoom-in": "circleopen",
  "zoom-out": "circleclose",
  "wipe-left": "wipeleft",
  "wipe-right": "wiperight",
  "push-left": "smoothleft",
  "push-right": "smoothright",
  circle: "circleopen",
  iris: "circleopen",
};

// ============================================================================
// Tipos
// ============================================================================

export interface BuildFilterComplexInput {
  project: VideoProject;
  inputAssets: { assetId: string; localPath: string; index: number }[];
  exportSettings: ExportSettings;
  /** Resolução final (já calculada via resolutionPresetToWH). */
  outputResolution: { width: number; height: number };
  /** Se definido E `burnCaptions === true`, adiciona subtitles= filter. */
  captionsAssPath?: string;
}

export interface BuildFilterComplexOutput {
  filterComplex: string;
  outputVideoStream: string;
  outputAudioStream: string;
  /** Total de inputs FFmpeg usados (assets + base + silence). */
  totalInputs: number;
  /** Inputs sintéticos extra a anexar via `-f lavfi -i ...`. */
  syntheticInputs: SyntheticInput[];
}

export interface SyntheticInput {
  /** Args para `ffmpeg(...).input(opts.url).inputOptions([opts.options])`. */
  url: string;
  options: string[];
  /** Index FFmpeg do input. */
  index: number;
  kind: "color" | "anullsrc";
}

// ============================================================================
// Helpers
// ============================================================================

function escapeFfmpegPath(p: string): string {
  // No filter graph, ":" e "\" precisam ser escapados.
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
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
  // Sanitiza id para ser válido como label do filter graph.
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

// ============================================================================
// Builder principal
// ============================================================================

export function buildFilterComplex(
  input: BuildFilterComplexInput,
): BuildFilterComplexOutput {
  const { project, inputAssets, outputResolution, captionsAssPath } = input;
  const W = outputResolution.width;
  const H = outputResolution.height;
  const projectDuration = computeProjectDuration(project);

  const assetIndex = new Map<string, number>();
  for (const a of inputAssets) assetIndex.set(a.assetId, a.index);

  // ---- 1. Inputs sintéticos (base preta, silêncio) -------------------------
  const syntheticInputs: SyntheticInput[] = [];

  // base preta sempre presente
  const baseInputIndex = inputAssets.length;
  syntheticInputs.push({
    url: `color=c=black:s=${W}x${H}:r=${project.frameRate}:d=${projectDuration}`,
    options: ["-f", "lavfi"],
    index: baseInputIndex,
    kind: "color",
  });

  // silêncio (usado se nenhum clip de áudio for emitido)
  const silenceInputIndex = inputAssets.length + 1;
  syntheticInputs.push({
    url: `anullsrc=channel_layout=stereo:sample_rate=48000`,
    options: ["-f", "lavfi"],
    index: silenceInputIndex,
    kind: "anullsrc",
  });

  // ---- 2. Pipeline de vídeo ------------------------------------------------
  const lines: string[] = [];

  // Coleta clips de vídeo de todas as tracks (visíveis, não-hidden)
  const videoTracks = project.tracks
    .filter((t) => t.type === "video" && t.visible)
    .sort((a, b) => a.index - b.index);

  const clipNodes: Array<{
    label: string;
    start: number;
    end: number;
    track: Track;
    clip: Clip;
  }> = [];

  // 1º passe: coleta os clips (metadados) na ordem de composição.
  const pending: Array<{
    inputIndex: number;
    clip: Clip;
    track: Track;
    label: string;
    fadeInSuppressed: boolean;
    fadeOutSuppressed: boolean;
  }> = [];
  videoTracks.forEach((track) => {
    // Ordena por CAMADA (subtrack) ascendente: camadas maiores são
    // sobrepostas DEPOIS (ficam por cima). Sort estável → tracks de camada
    // única mantêm a ordem de inserção (comportamento idêntico ao anterior).
    const orderedClips = [...track.clips].sort(
      (a, b) => (a.layer ?? 0) - (b.layer ?? 0),
    );
    orderedClips.forEach((clip, ci) => {
      if (clip.hidden) return;
      const idx = assetIndex.get(clip.assetId);
      if (idx === undefined) {
        // Asset não foi baixado (provavelmente local-blob) — pula.
        return;
      }
      pending.push({
        inputIndex: idx,
        clip,
        track,
        label: `v_${safe(track.id)}_${ci}`,
        fadeInSuppressed: false,
        fadeOutSuppressed: false,
      });
    });
  });

  // Detecta pares xfade ANTES de montar as chains: clips que participam de
  // xfade não recebem alpha-fade individual (o blend do xfade já faz o papel).
  for (let i = 0; i < pending.length; i += 1) {
    const cur = pending[i];
    if (!cur.clip.transitionOut) continue;
    for (let j = i + 1; j < pending.length; j += 1) {
      if (pending[j].track.id !== cur.track.id) continue;
      if (areClipsAdjacent(cur.clip, pending[j].clip)) {
        cur.fadeOutSuppressed = true;
        pending[j].fadeInSuppressed = true;
      }
      break;
    }
  }

  // 2º passe: monta a chain de cada clip.
  pending.forEach((p) => {
    lines.push(
      buildVideoClipChain({
        inputIndex: p.inputIndex,
        clip: p.clip,
        outputResolution: { width: W, height: H },
        stageMode: project.stageMode,
        splitRatio: project.splitRatio,
        outLabel: p.label,
        frameRate: project.frameRate,
        fadeInSuppressed: p.fadeInSuppressed,
        fadeOutSuppressed: p.fadeOutSuppressed,
      }),
    );
    clipNodes.push({
      label: `[${p.label}]`,
      start: p.clip.startInTimeline,
      end: p.clip.endInTimeline,
      track: p.track,
      clip: p.clip,
    });
  });

  // ---- 3. Composição em cima da base preta ---------------------------------
  let videoStream = `[${baseInputIndex}:v]`;

  // Se houver clip "full" cobrindo o canvas completamente, ainda assim
  // overlamos para preservar transparência onde aplicável.
  clipNodes.forEach((node, i) => {
    const inLabel = videoStream;
    const outLabel = `[v_overlay_${i}]`;

    // Tenta detectar par xfade (clipA.transitionOut + próximo clip da mesma track)
    const next = findNextClipInTrack(node, clipNodes, i);
    if (
      next &&
      node.clip.transitionOut &&
      areClipsAdjacent(node.clip, next.clip) &&
      node.track.id === next.track.id
    ) {
      // xfade: substitui overlay simples por blend
      const tDur = Math.max(0.1, node.clip.transitionOut.duration);
      const xfadeName =
        TRANSITION_TO_XFADE[node.clip.transitionOut.type] ?? "fade";
      const xfadeOffset = Math.max(0, node.end - tDur);
      const xfadeLabel = `[v_xfade_${i}]`;
      lines.push(
        `${node.label}${next.label}xfade=transition=${xfadeName}:duration=${tDur.toFixed(3)}:offset=${xfadeOffset.toFixed(3)}${xfadeLabel}`,
      );
      // Overlay do resultado do xfade sobre a base, no intervalo combinado.
      const combinedStart = node.start;
      const combinedEnd = next.end;
      lines.push(
        `${inLabel}${xfadeLabel}overlay=enable='between(t,${combinedStart.toFixed(3)},${combinedEnd.toFixed(3)})'${outLabel}`,
      );
      videoStream = outLabel;
      // Marca o próximo como já consumido pelo xfade (skipNext).
      (next as { _consumed?: boolean })._consumed = true;
      return;
    }

    if ((node as { _consumed?: boolean })._consumed) return;

    lines.push(
      `${inLabel}${node.label}overlay=enable='between(t,${node.start.toFixed(3)},${node.end.toFixed(3)})'${outLabel}`,
    );
    videoStream = outLabel;
  });

  // ---- 4. Captions queimadas -----------------------------------------------
  if (captionsAssPath && input.exportSettings.burnCaptions) {
    const escaped = escapeFfmpegPath(captionsAssPath);
    lines.push(`${videoStream}subtitles='${escaped}'[v_captioned]`);
    videoStream = `[v_captioned]`;
  }

  // ---- 5. Renomeia stream final --------------------------------------------
  lines.push(`${videoStream}null[v_final]`);
  videoStream = `[v_final]`;

  // ---- 6. Áudio ------------------------------------------------------------
  const audioLabels: string[] = [];
  const audioTracks = project.tracks.filter(
    (t) => t.type !== "video" || hasAudibleClip(t),
  );
  // Para tracks de vídeo, usamos o áudio embutido (mesmo input do vídeo).
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
        track,
        outLabel: label,
      });
      if (!built) return;
      lines.push(built);
      audioLabels.push(`[${label}]`);
    });
  });

  let audioStream: string;
  if (audioLabels.length === 0) {
    // Usa silêncio sintético (tem que casar com a duração do vídeo).
    lines.push(
      `[${silenceInputIndex}:a]atrim=duration=${projectDuration.toFixed(3)},asetpts=PTS-STARTPTS[a_final]`,
    );
    audioStream = `[a_final]`;
  } else if (audioLabels.length === 1) {
    lines.push(`${audioLabels[0]}anull[a_final]`);
    audioStream = `[a_final]`;
  } else {
    // normalize=0: a VOZ nunca abaixa quando a trilha entra (o amix padrão
    // atenua cada input por 1/N). O limiter no master só segura picos —
    // não normaliza (preset da produção real do gabinete).
    lines.push(
      `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0[a_mixed]`,
    );
    lines.push(
      `[a_mixed]alimiter=limit=0.97:attack=5:release=50:level=false[a_final]`,
    );
    audioStream = `[a_final]`;
  }

  return {
    filterComplex: lines.join(";"),
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
  stageMode: VideoProject["stageMode"];
  splitRatio: number;
  outLabel: string;
  frameRate: number;
  /** True quando o clip participa de um xfade (o blend substitui o fade). */
  fadeInSuppressed?: boolean;
  fadeOutSuppressed?: boolean;
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
    fadeInSuppressed,
    fadeOutSuppressed,
  } = args;
  const { width: W, height: H } = outputResolution;

  const filters: string[] = [];

  // 1. Trim + reset pts (+ velocidade)
  const dur = Math.max(0.001, clipDurationOnTimeline(clip));
  const rate = clip.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1;
  filters.push(
    `trim=start=${clip.startInAsset.toFixed(3)}:end=${clip.endInAsset.toFixed(3)}`,
  );
  // Velocidade: comprime/estica os PTS do trecho do asset (rate=2 → 2x mais
  // rápido; rate=0.5 → 2x mais lento). Mantém paridade com o builder client.
  if (rate !== 1) {
    filters.push(`setpts=(PTS-STARTPTS)/${rate.toFixed(6)}`);
  } else {
    filters.push("setpts=PTS-STARTPTS");
  }

  // 2. fps normalization (importante para xfade/overlay alinhar timestamps)
  filters.push(`fps=${frameRate}`);

  // 3. Determine target slot dimensions
  let slotW = W;
  let slotH = H;
  let slotX = 0;
  let slotY = 0;
  if (stageMode === "split-vertical") {
    const ratio = Math.min(0.9, Math.max(0.1, splitRatio));
    if (clip.slot === "top") {
      slotH = Math.round(H * ratio);
    } else if (clip.slot === "bottom") {
      slotH = Math.round(H * (1 - ratio));
      slotY = H - slotH;
    }
    // 'full' usa W/H completos.
    slotW = ensureEven(slotW);
    slotH = ensureEven(slotH);
  }

  // 4. Filtros visuais (eq/hue/blur/grayscale)
  const f = clip.filters;
  if (f.brightness !== 1 || f.contrast !== 1 || f.saturation !== 1) {
    const brightness = (f.brightness - 1).toFixed(3); // eq usa offset
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
    // mistura linear entre identidade e luminância padrão BT.709
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

  // 5. Transform (flip + rotação + escala)
  if (clip.transform.flipH) filters.push("hflip");
  if (clip.transform.flipV) filters.push("vflip");
  if (clip.transform.rotation && clip.transform.rotation !== 0) {
    const rad = (clip.transform.rotation * Math.PI) / 180;
    filters.push(`rotate=${rad.toFixed(4)}:c=black@0:ow=rotw(${rad.toFixed(4)}):oh=roth(${rad.toFixed(4)})`);
  }

  // 6. Scale para caber no slot mantendo aspect ratio (decrease) e posiciona
  //    dentro do slot com pad ALARGADO + crop. O pad do ffmpeg não aceita
  //    offset negativo nem mídia maior que a área — o pad direto quebrava o
  //    render com transform.x/y ≠ 0 (mídia deslocada) ou scale > 1. A margem
  //    M absorve deslocamento/estouro e o crop devolve o slot exato (mídia
  //    além da borda é cortada, como no preview com overflow:hidden).
  const scaleFactor = Math.max(0.05, clip.transform.scale);
  const targetW = Math.max(2, ensureEven(Math.round(slotW * scaleFactor)));
  const targetH = Math.max(2, ensureEven(Math.round(slotH * scaleFactor)));
  filters.push(
    `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease`,
  );
  // x/y do transform são relativos (-1..1) ao centro do slot.
  const dx = Math.round((clip.transform.x * slotW) / 2);
  const dy = Math.round((clip.transform.y * slotH) / 2);
  const margin =
    Math.max(
      0,
      Math.ceil((targetW - slotW) / 2),
      Math.ceil((targetH - slotH) / 2),
    ) +
    Math.max(Math.abs(dx), Math.abs(dy)) +
    2;
  filters.push(
    `pad=${slotW + 2 * margin}:${slotH + 2 * margin}:(ow-iw)/2+${dx}:(oh-ih)/2+${dy}:color=black@0`,
  );
  filters.push(`crop=${slotW}:${slotH}:${margin}:${margin}`);

  // 7. Posiciona o slot no canvas inteiro (offset do split, sempre >= 0).
  if (slotW !== W || slotH !== H || slotX !== 0 || slotY !== 0) {
    filters.push(`pad=${W}:${H}:${slotX}:${slotY}:color=black@0`);
  }

  // 8. Opacity (via colorchannelmixer aa) — aplicado depois do pad
  if (clip.transform.opacity !== undefined && clip.transform.opacity < 1) {
    const aa = Math.max(0, Math.min(1, clip.transform.opacity));
    filters.push(`format=rgba,colorchannelmixer=aa=${aa.toFixed(3)}`);
  } else {
    filters.push("format=rgba");
  }

  // 8b. Alpha-fades de transição (entrada/saída) — porta o comportamento do
  // pipeline do gabinete (`fade=...:alpha=1` nos overlays). Clips que
  // participam de xfade não recebem (o blend já faz a transição). O tempo é
  // clip-local (a chain já resetou PTS com trim+setpts). `dur` vem do passo 1.
  if (clip.transitionIn && clip.transitionIn.duration > 0 && !fadeInSuppressed) {
    const d = Math.min(clip.transitionIn.duration, dur);
    filters.push(`fade=t=in:st=0:d=${d.toFixed(3)}:alpha=1`);
  }
  if (
    clip.transitionOut &&
    clip.transitionOut.duration > 0 &&
    !fadeOutSuppressed
  ) {
    const d = Math.min(clip.transitionOut.duration, dur);
    filters.push(
      `fade=t=out:st=${Math.max(0, dur - d).toFixed(3)}:d=${d.toFixed(3)}:alpha=1`,
    );
  }

  // 9. Ajusta PTS para a posição da timeline (offset por overlay enable=)
  // O overlay externo já controla quando aparece; aqui só zeramos pts.
  // Mas precisamos forçar a duração efetiva para evitar frame leak.
  filters.push(`trim=duration=${dur.toFixed(3)}`);
  filters.push("setpts=PTS-STARTPTS");

  return `[${inputIndex}:v]${filters.join(",")}[${outLabel}]`;
}

interface BuildAudioChainArgs {
  inputIndex: number;
  clip: Clip;
  /** Track dona — opções de TRILHA (gainPct/audioLeveling/autoFade). */
  track?: Track;
  outLabel: string;
}

function buildAudioClipChain(args: BuildAudioChainArgs): string | null {
  const { inputIndex, clip, track, outLabel } = args;
  const dur = Math.max(0.001, clipDurationOnTimeline(clip));
  const startTl = Math.max(0, clip.startInTimeline);

  const rate = clip.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1;
  const filters: string[] = [];
  filters.push(
    `atrim=start=${clip.startInAsset.toFixed(3)}:end=${clip.endInAsset.toFixed(3)}`,
  );
  filters.push("asetpts=PTS-STARTPTS");

  // Velocidade do áudio via atempo (0.5..2.0 por estágio; encadeia p/ 0.25..4).
  if (rate !== 1) {
    for (const fAtempo of atempoFactors(rate)) {
      filters.push(`atempo=${fAtempo.toFixed(6)}`);
    }
  }

  // Trilha nivelada (track de música): dynaudnorm ANTES do volume, com o
  // preset da produção real do gabinete.
  if (track?.audioLeveling) {
    filters.push("dynaudnorm=f=200:g=15:p=0.85");
  }

  // Fades automáticos da trilha (in 1,2s / out 2,5s) quando o clip não tem
  // fade próprio configurado.
  const autoIn =
    track?.autoFade && clip.audio.fadeInDuration <= 0 ? Math.min(1.2, dur / 2) : 0;
  const autoOut =
    track?.autoFade && clip.audio.fadeOutDuration <= 0 ? Math.min(2.5, dur / 2) : 0;

  const fadeIn = clip.audio.fadeInDuration > 0 ? clip.audio.fadeInDuration : autoIn;
  const fadeOut =
    clip.audio.fadeOutDuration > 0 ? clip.audio.fadeOutDuration : autoOut;

  if (fadeIn > 0) {
    filters.push(`afade=t=in:st=0:d=${Math.min(fadeIn, dur).toFixed(3)}`);
  }
  if (fadeOut > 0) {
    const start = Math.max(0, dur - fadeOut);
    filters.push(
      `afade=t=out:st=${start.toFixed(3)}:d=${Math.min(fadeOut, dur).toFixed(3)}`,
    );
  }

  // Volume efetivo = volume do clip × gain da track (gainPct, 100 = neutro).
  const trackGain = (track?.gainPct ?? 100) / 100;
  const volumeEfetivo = clip.audio.volume * trackGain;
  if (Math.abs(volumeEfetivo - 1) > 1e-6) {
    filters.push(`volume=${volumeEfetivo.toFixed(3)}`);
  }
  if (clip.audio.pan && clip.audio.pan !== 0) {
    const pan = Math.max(-1, Math.min(1, clip.audio.pan));
    const left = (1 - Math.max(0, pan)).toFixed(3);
    const right = (1 + Math.min(0, pan)).toFixed(3);
    filters.push(
      `pan=stereo|c0=${left}*c0|c1=${right}*c1`,
    );
  }
  // Posiciona no tempo da timeline com adelay
  if (startTl > 0) {
    const ms = Math.round(startTl * 1000);
    filters.push(`adelay=${ms}|${ms}`);
  }

  return `[${inputIndex}:a]${filters.join(",")}[${outLabel}]`;
}

// ============================================================================
// Helpers
// ============================================================================

function ensureEven(n: number): number {
  return n % 2 === 0 ? n : n + 1;
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

function findNextClipInTrack(
  current: { track: Track; clip: Clip; end: number },
  all: Array<{ track: Track; clip: Clip; start: number; end: number; label: string }>,
  fromIndex: number,
): { track: Track; clip: Clip; start: number; end: number; label: string } | null {
  for (let i = fromIndex + 1; i < all.length; i += 1) {
    if (all[i].track.id === current.track.id) return all[i];
  }
  return null;
}

function areClipsAdjacent(a: Clip, b: Clip): boolean {
  // "Adjacente" = sem gap maior que 50ms.
  return Math.abs(a.endInTimeline - b.startInTimeline) < 0.05;
}

function hasAudibleClip(track: Track): boolean {
  return track.clips.some((c) => !c.hidden && !c.audio.muted);
}
