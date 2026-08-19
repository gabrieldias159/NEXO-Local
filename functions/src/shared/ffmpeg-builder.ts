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

  // Detecta RUNS de xfade ANTES de montar as chains: sequências de clips da
  // MESMA track/camada em que cada clip tem `transitionOut` e SOBREPÕE o
  // próximo (overlap de até 1,5s — é o que `applyCrossfadeAtJunctions` cria).
  // Um run vira UMA cadeia de xfades encadeados (algoritmo do `_prep_xfade.py`
  // da produção real) + acrossfade no áudio. Clips de um run não recebem
  // alpha-fade individual (o blend do xfade já faz o papel).
  const XFADE_MAX_OVERLAP = 1.5;
  const runOf: number[] = new Array(pending.length).fill(-1);
  const runs: number[][] = [];
  for (let i = 0; i < pending.length; i += 1) {
    if (runOf[i] >= 0) continue;
    const run = [i];
    let k = i;
    for (let j = k + 1; j < pending.length; j += 1) {
      const a = pending[k];
      const b = pending[j];
      if (b.track.id !== a.track.id) break;
      if ((b.clip.layer ?? 0) !== (a.clip.layer ?? 0)) break;
      const overlap = a.clip.endInTimeline - b.clip.startInTimeline;
      const encadeia =
        a.clip.transitionOut !== undefined &&
        overlap > 0.05 &&
        overlap <= XFADE_MAX_OVERLAP;
      if (!encadeia) break;
      run.push(j);
      k = j;
    }
    if (run.length > 1) {
      const runIdx = runs.length;
      runs.push(run);
      run.forEach((idx, pos) => {
        runOf[idx] = runIdx;
        if (pos < run.length - 1) pending[idx].fadeOutSuppressed = true;
        if (pos > 0) pending[idx].fadeInSuppressed = true;
      });
    }
  }

  // 2º passe: monta a chain de cada clip. Clips FORA de run recebem o
  // deslocamento de PTS para a posição na timeline (o overlay sincroniza por
  // timestamp — sem isso, clip que não começa em 0s exibia o último frame
  // congelado). Membros de run ficam com PTS a partir de 0 (o xfade exige) e
  // o deslocamento é aplicado no RESULTADO do run.
  pending.forEach((p, i) => {
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
        ptsOffset: runOf[i] >= 0 ? 0 : p.clip.startInTimeline,
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

  const OVERLAY_OPTS = ":eof_action=pass:repeatlast=0";
  const emitted = new Set<number>();

  for (let i = 0; i < clipNodes.length; i += 1) {
    if (emitted.has(i)) continue;
    const node = clipNodes[i];
    const inLabel = videoStream;
    const outLabel = `[v_overlay_${i}]`;

    const runIdx = runOf[i];
    if (runIdx >= 0 && runs[runIdx][0] === i) {
      // RUN de xfades encadeados: [c0][c1]xfade..[x1]; [x1][c2]xfade..[x2]…
      // offset de cada junção = início do clip seguinte relativo ao início
      // do run; duration = o overlap real do par.
      const idxs = runs[runIdx];
      const runStart = clipNodes[idxs[0]].start;
      let acc = clipNodes[idxs[0]].label;
      for (let m = 1; m < idxs.length; m += 1) {
        const prev = clipNodes[idxs[m - 1]];
        const cur = clipNodes[idxs[m]];
        const overlap = Math.max(0.05, prev.end - cur.start);
        const xfadeName =
          TRANSITION_TO_XFADE[prev.clip.transitionOut?.type ?? "crossfade"] ??
          "fade";
        const outX = `[v_xr_${runIdx}_${m}]`;
        lines.push(
          `${acc}${cur.label}xfade=transition=${xfadeName}:duration=${overlap.toFixed(3)}:offset=${(cur.start - runStart).toFixed(3)}${outX}`,
        );
        acc = outX;
      }
      // Alinha o resultado do run à posição na timeline.
      const shifted = `[v_xs_${runIdx}]`;
      lines.push(`${acc}setpts=PTS+${runStart.toFixed(3)}/TB${shifted}`);
      const runEnd = clipNodes[idxs[idxs.length - 1]].end;
      lines.push(
        `${inLabel}${shifted}overlay=enable='between(t,${runStart.toFixed(3)},${runEnd.toFixed(3)})'${OVERLAY_OPTS}${outLabel}`,
      );
      videoStream = outLabel;
      idxs.forEach((x) => emitted.add(x));
      continue;
    }

    lines.push(
      `${inLabel}${node.label}overlay=enable='between(t,${node.start.toFixed(3)},${node.end.toFixed(3)})'${OVERLAY_OPTS}${outLabel}`,
    );
    videoStream = outLabel;
    emitted.add(i);
  }

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

  // Runs de xfade com TODOS os membros audíveis viram acrossfade (áudio
  // emenda com o mesmo dissolve do vídeo — junção do fluxo do gabinete).
  const audioConsumed = new Set<string>();
  runs.forEach((idxs, runIdx) => {
    const track = pending[idxs[0]].track;
    if (track.muted) return;
    const members = idxs.map((i) => pending[i]);
    const todosAudiveis = members.every(
      (m) => !m.clip.hidden && !m.clip.audio.muted,
    );
    if (!todosAudiveis) return;

    const memberLabels: string[] = [];
    for (let m = 0; m < members.length; m += 1) {
      const label = `a_xr_${runIdx}_${m}`;
      const built = buildAudioClipChain({
        inputIndex: members[m].inputIndex,
        clip: members[m].clip,
        track,
        outLabel: label,
        omitDelay: true,
      });
      if (!built) return; // sem áudio em algum membro → cai no caminho normal
      lines.push(built);
      memberLabels.push(`[${label}]`);
    }

    let acc = memberLabels[0];
    for (let m = 1; m < members.length; m += 1) {
      const prev = members[m - 1].clip;
      const cur = members[m].clip;
      const overlap = Math.max(
        0.05,
        Math.min(
          prev.endInTimeline - cur.startInTimeline,
          (prev.endInTimeline - prev.startInTimeline) / 2,
          (cur.endInTimeline - cur.startInTimeline) / 2,
        ),
      );
      const outX = `[a_xx_${runIdx}_${m}]`;
      lines.push(
        `${acc}${memberLabels[m]}acrossfade=d=${overlap.toFixed(3)}:c1=tri:c2=tri${outX}`,
      );
      acc = outX;
    }

    const runStart = members[0].clip.startInTimeline;
    let finalLabel = acc;
    if (runStart > 0) {
      const ms = Math.round(runStart * 1000);
      const delayed = `[a_xd_${runIdx}]`;
      lines.push(`${acc}adelay=${ms}|${ms}${delayed}`);
      finalLabel = delayed;
    }
    audioLabels.push(finalLabel);
    members.forEach((m) => audioConsumed.add(m.clip.id));
  });

  // Para tracks de vídeo, usamos o áudio embutido (mesmo input do vídeo).
  audioTracks.forEach((track) => {
    if (track.muted) return;
    track.clips.forEach((clip, ci) => {
      if (clip.hidden || clip.audio.muted) return;
      if (audioConsumed.has(clip.id)) return; // já entrou via acrossfade
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
  /**
   * Deslocamento final de PTS (s) — posição do clip na timeline. O overlay
   * sincroniza por timestamp; membros de run de xfade usam 0 (o run inteiro
   * é deslocado depois).
   */
  ptsOffset?: number;
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
    ptsOffset,
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

  // 9. Trava a duração efetiva (evita frame leak) e ANCORA o PTS na posição
  // da timeline — igual ao `setpts=PTS-STARTPTS+ini/TB` do pipeline real.
  // Sem a âncora, o overlay (que sincroniza por timestamp) consumia os
  // frames antes da janela `enable` e exibia o último frame congelado.
  filters.push(`trim=duration=${dur.toFixed(3)}`);
  const off = ptsOffset ?? 0;
  filters.push(
    off > 0
      ? `setpts=PTS-STARTPTS+${off.toFixed(3)}/TB`
      : "setpts=PTS-STARTPTS",
  );

  return `[${inputIndex}:v]${filters.join(",")}[${outLabel}]`;
}

interface BuildAudioChainArgs {
  inputIndex: number;
  clip: Clip;
  /** Track dona — opções de TRILHA (gainPct/audioLeveling/autoFade). */
  track?: Track;
  outLabel: string;
  /** True em membros de run de acrossfade (o adelay é aplicado no run). */
  omitDelay?: boolean;
}

function buildAudioClipChain(args: BuildAudioChainArgs): string | null {
  const { inputIndex, clip, track, outLabel, omitDelay } = args;
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
  if (startTl > 0 && !omitDelay) {
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

function hasAudibleClip(track: Track): boolean {
  return track.clips.some((c) => !c.hidden && !c.audio.muted);
}
