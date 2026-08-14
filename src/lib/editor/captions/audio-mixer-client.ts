'use client';

/**
 * Mixer de áudio do projeto rodando 100% no browser.
 *
 * Usa `OfflineAudioContext` para renderizar todas as tracks de áudio (e o
 * áudio embutido nas tracks de vídeo) numa pista mono 16 kHz, suficiente
 * para a transcrição via Gemini. O resultado é codificado em WAV PCM
 * 16-bit (zero-dependency) e devolvido como `Blob` pronto para upload.
 *
 * Limites:
 *  - Se a duração total do projeto > 600s (10min), retorna `null`. Esse é
 *    o sinal para o caller cair pro fluxo server-side (Cloud Function
 *    `onCaptionGenerateRequest` com `needsServerMix=true`).
 *  - Se o projeto não tem assets `firebase` (apenas blobs locais), só
 *    funciona enquanto a sessão está aberta. A Cloud Function não tem
 *    acesso a blobs, então prefira o caminho client neste caso.
 *  - Assets em estado `uploading`/`error` são pulados.
 */

import type {
  Clip,
  MediaAsset,
  Track,
  VideoProject,
} from '../types';

export const TARGET_SAMPLE_RATE = 16000;
const MAX_DURATION_SEC = 600;

/**
 * Limite de duração para o caminho de **transcrição LOCAL** (STT no
 * navegador). Não há upload nem custo de API, então podemos ir bem além
 * do limite do fluxo Gemini (10min). 60min é um teto de segurança para
 * não estourar memória do browser (1h @ 16kHz mono ≈ 230 MB de Float32).
 */
const MAX_LOCAL_TRANSCRIBE_SEC = 3600;

/**
 * Núcleo compartilhado: mixa todos os áudios audíveis do projeto e devolve
 * um `Float32Array` mono já reamostrado para {@link TARGET_SAMPLE_RATE}
 * (16 kHz) — exatamente o formato que Whisper/transformers.js consome.
 *
 * Respeita volume/mute/trim/playbackRate dos clips. Funciona com assets
 * `blob:` locais (sessão aberta) e `firebase`/`https` (download).
 *
 * @param project projeto a mixar.
 * @param maxDurationSec teto de duração; acima dele retorna `null`.
 * @returns Float32Array 16 kHz mono, ou `null` se exceder o teto.
 */
async function mixProjectAudioToPcm(
  project: VideoProject,
  maxDurationSec: number,
): Promise<Float32Array | null> {
  const totalDuration = computeProjectDuration(project);
  if (totalDuration <= 0) {
    throw new Error('Projeto sem clips — nada para transcrever.');
  }
  if (totalDuration > maxDurationSec) {
    // Sinaliza pro caller (fluxo IA cai pro servidor; fluxo local mostra erro).
    return null;
  }

  const audibleClips = collectAudibleClips(project);
  if (audibleClips.length === 0) {
    throw new Error('Projeto sem áudio audível — nada para transcrever.');
  }

  const assetMap = new Map<string, MediaAsset>();
  for (const a of project.assets) assetMap.set(a.id, a);

  // Cria contexto offline com sample rate alto o suficiente p/ decodificar
  // sem perda; só fazemos downsample no fim quando enviar pro encoder.
  // Alguns navegadores rejeitam sample rates muito baixos no decode.
  const decodeRate = 48000;
  const lengthSamples = Math.ceil(totalDuration * decodeRate);
  const audioCtx = new OfflineAudioContext(1, lengthSamples, decodeRate);

  let scheduledCount = 0;
  for (const clip of audibleClips) {
    const asset = assetMap.get(clip.assetId);
    if (!asset) continue;
    if (asset.status !== 'ready') continue;
    if (!asset.downloadUrl) continue;

    try {
      const buffer = await fetchAndDecodeAudio(asset.downloadUrl, audioCtx);
      if (!buffer) continue;
      scheduleClip(audioCtx, buffer, clip);
      scheduledCount += 1;
    } catch (e) {
      console.warn(
        `[mixProjectAudio] falha ao decodificar ${asset.name}:`,
        e,
      );
    }
  }

  if (scheduledCount === 0) {
    throw new Error(
      'Nenhum asset com áudio pôde ser decodificado no navegador.',
    );
  }

  const rendered = await audioCtx.startRendering();

  // Downsample para 16 kHz mono (somos sempre mono porque criei o ctx
  // com 1 canal — só precisamos resample da taxa).
  const monoChannel = rendered.getChannelData(0);
  return downsampleMono(monoChannel, rendered.sampleRate, TARGET_SAMPLE_RATE);
}

/**
 * Tenta mixar todos os áudios do projeto no navegador.
 *
 * @returns Blob `audio/wav` com a mixagem, ou `null` se a duração total
 *   ultrapassa o limite do fluxo IA (deve cair pro fluxo server).
 */
export async function mixProjectAudioClient(
  project: VideoProject,
): Promise<Blob | null> {
  const pcm = await mixProjectAudioToPcm(project, MAX_DURATION_SEC);
  if (!pcm) return null;
  // Encoda em WAV PCM16.
  return await encodeMp3(pcm, TARGET_SAMPLE_RATE);
}

/**
 * Variante para a **transcrição LOCAL** (STT no navegador). Devolve o
 * `Float32Array` 16 kHz mono direto, SEM re-encodar em WAV — é a entrada
 * nativa do Whisper via transformers.js, então pulamos o WAV inteiro.
 *
 * Usa um teto de duração maior ({@link MAX_LOCAL_TRANSCRIBE_SEC}) porque
 * não há upload nem custo — só processamento local.
 *
 * @throws se o projeto não tem áudio, ou se a duração excede o teto local.
 */
export async function mixProjectAudioPCM(
  project: VideoProject,
): Promise<Float32Array> {
  const pcm = await mixProjectAudioToPcm(project, MAX_LOCAL_TRANSCRIBE_SEC);
  if (!pcm) {
    const mins = Math.round(MAX_LOCAL_TRANSCRIBE_SEC / 60);
    throw new Error(
      `Projeto longo demais para transcrição local (limite ~${mins} min).`,
    );
  }
  return pcm;
}

// ============================================================================
// Helpers
// ============================================================================

function computeProjectDuration(project: VideoProject): number {
  let max = project.duration ?? 0;
  for (const track of project.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (clip.hidden) continue;
      if (clip.endInTimeline > max) max = clip.endInTimeline;
    }
  }
  return Math.max(0, max);
}

function collectAudibleClips(project: VideoProject): Clip[] {
  const out: Clip[] = [];
  for (const track of project.tracks ?? []) {
    if (!isAudibleTrack(track)) continue;
    if (track.muted) continue;
    for (const clip of track.clips ?? []) {
      if (clip.hidden) continue;
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (!asset) continue;
      if (asset.type === 'image') continue;
      out.push(clip);
    }
  }
  return out;
}

function isAudibleTrack(track: Track): boolean {
  return track.type === 'audio' || track.type === 'video';
}

async function fetchAndDecodeAudio(
  url: string,
  ctx: OfflineAudioContext,
): Promise<AudioBuffer | null> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    console.warn('[mixProjectAudioClient] fetch falhou:', e);
    return null;
  }
  if (!res.ok) {
    console.warn(
      `[mixProjectAudioClient] HTTP ${res.status} ao baixar ${url}`,
    );
    return null;
  }
  const ab = await res.arrayBuffer();
  // `decodeAudioData` aceita ser chamado num OfflineAudioContext.
  return await ctx.decodeAudioData(ab);
}

function scheduleClip(
  ctx: OfflineAudioContext,
  buffer: AudioBuffer,
  clip: Clip,
): void {
  const muted = clip.audio?.muted === true;
  const volume = Math.max(0, Math.min(4, clip.audio?.volume ?? 1));
  if (muted || volume === 0) return;

  const startInTimeline = Math.max(0, clip.startInTimeline ?? 0);
  const startInAsset = Math.max(0, clip.startInAsset ?? 0);
  const clipDur = Math.max(
    0.05,
    (clip.endInTimeline ?? startInTimeline) - startInTimeline,
  );
  const playDur = Math.min(buffer.duration - startInAsset, clipDur);
  if (playDur <= 0) return;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  // Respeita `playbackRate` (afeta a duração — mantemos o mesmo offset
  // mas não corrigimos sub-second drift; é OK para transcrição).
  if (clip.playbackRate && clip.playbackRate > 0) {
    src.playbackRate.value = clip.playbackRate;
  }

  const gain = ctx.createGain();
  gain.gain.value = volume;

  src.connect(gain).connect(ctx.destination);
  src.start(startInTimeline, startInAsset, playDur);
}

/**
 * Downsample linear (mono → mono). Suficiente para transcrição.
 * Fonte: técnica padrão (avg de janelas).
 */
function downsampleMono(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (outputRate >= inputRate) return input.slice();
  const ratio = inputRate / outputRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  let outIdx = 0;
  let inIdxFrac = 0;
  while (outIdx < outLength) {
    const nextInIdx = Math.floor((outIdx + 1) * ratio);
    let acc = 0;
    let count = 0;
    for (
      let i = Math.floor(inIdxFrac);
      i < nextInIdx && i < input.length;
      i++
    ) {
      acc += input[i];
      count += 1;
    }
    out[outIdx] = count > 0 ? acc / count : 0;
    inIdxFrac = nextInIdx;
    outIdx += 1;
  }
  return out;
}

/**
 * Codifica Float32 mono em WAV PCM 16-bit.
 *
 * Substituição do `lamejs` que tinha bug crônico (`MPEGMode is not
 * defined` em strict mode / bundlers modernos). WAV é zero-dependency,
 * sempre funciona, e Gemini aceita WAV pra transcrição.
 *
 * Trade-off: WAV é ~10x maior que MP3 (uncompressed). Pra áudio de
 * transcrição (mono, 16kHz, 1-10 min), payload típico fica em 1-20MB
 * — ok pra upload.
 */
async function encodeMp3(
  samplesF32: Float32Array,
  sampleRate: number,
): Promise<Blob> {
  // Converte Float32 (-1..1) → Int16.
  const numSamples = samplesF32.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true); // file size - 8
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, numSamples * 2, true);

  // PCM samples
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samplesF32[i] ?? 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) {
    view.setUint8(offset + i, s.charCodeAt(i));
  }
}
