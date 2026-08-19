/**
 * Serializer/deserializer entre `VideoProject` (in-memory) e
 * documento Firestore.
 *
 * Cuidados:
 * - `Timestamp.now()` para `updatedAt` ao salvar.
 * - `MediaAsset.file` (Blob local) NÃO vai ao Firestore — apenas
 *   `storagePath`/`downloadUrl`.
 * - Limpa campos `undefined` recursivamente (Firestore não aceita).
 * - Assets com `source === 'local-blob'` que ainda não fizeram upload são
 *   filtrados (não persistimos blobs efêmeros).
 */

import { Timestamp, type DocumentData } from 'firebase/firestore';
import type {
  VideoProject,
  MediaAsset,
  Track,
  Clip,
  CaptionTrack,
} from '../types';

/**
 * Remove recursivamente campos `undefined` de um objeto/array.
 * Mantém `null` (Firestore aceita). Não recursa em Timestamps/Dates.
 */
function stripUndefined<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as unknown as T;
  }
  if (value instanceof Timestamp || value instanceof Date) return value;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** Garante Timestamp ao salvar (aceita objetos brutos vindos do store). */
function toTimestamp(value: unknown): Timestamp {
  if (value instanceof Timestamp) return value;
  if (value && typeof value === 'object' && 'seconds' in value) {
    const seconds = Number((value as { seconds: number }).seconds) || 0;
    const nanoseconds =
      Number((value as { nanoseconds?: number }).nanoseconds) || 0;
    return new Timestamp(seconds, nanoseconds);
  }
  if (value instanceof Date) {
    return Timestamp.fromDate(value);
  }
  return Timestamp.now();
}

/**
 * Sanitiza asset para persistência. Remove blobs locais — apenas
 * `storagePath`/`downloadUrl` persistido.
 */
function serializeAsset(asset: MediaAsset): DocumentData | null {
  // Asset puramente local (blob) que não terminou upload — não persistir.
  if (asset.source === 'local-blob' && !asset.storagePath) {
    return null;
  }
  const out: DocumentData = {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    source: asset.source,
    downloadUrl: asset.downloadUrl,
    size: asset.size,
    status: asset.status === 'uploading' ? 'ready' : asset.status,
    createdAt: toTimestamp(asset.createdAt),
  };
  if (asset.storagePath !== undefined) out.storagePath = asset.storagePath;
  if (asset.duration !== undefined) out.duration = asset.duration;
  if (asset.width !== undefined) out.width = asset.width;
  if (asset.height !== undefined) out.height = asset.height;
  if (asset.thumbnailUrl !== undefined) out.thumbnailUrl = asset.thumbnailUrl;
  return out;
}

function serializeClip(clip: Clip): DocumentData {
  return stripUndefined({
    id: clip.id,
    assetId: clip.assetId,
    trackId: clip.trackId,
    startInTimeline: clip.startInTimeline,
    endInTimeline: clip.endInTimeline,
    startInAsset: clip.startInAsset,
    endInAsset: clip.endInAsset,
    slot: clip.slot,
    layer: clip.layer ?? 0,
    // `fit` e `chromaKey` são aditivos — sem eles o save descartava o encaixe
    // e o chroma key configurados (bug de retrocompat corrigido).
    fit: clip.fit,
    chromaKey: clip.chromaKey ? { ...clip.chromaKey } : undefined,
    playbackRate: clip.playbackRate,
    transform: { ...clip.transform },
    filters: { ...clip.filters },
    audio: { ...clip.audio },
    transitionIn: clip.transitionIn ?? null,
    transitionOut: clip.transitionOut ?? null,
    keyframes: clip.keyframes ?? [],
    locked: clip.locked,
    hidden: clip.hidden,
  });
}

function serializeTrack(track: Track): DocumentData {
  return stripUndefined({
    id: track.id,
    type: track.type,
    name: track.name,
    index: track.index,
    muted: track.muted,
    locked: track.locked,
    visible: track.visible,
    solo: track.solo,
    height: track.height,
    layerCount: track.layerCount ?? 1,
    // stageSlot só existe em tracks de vídeo de palco; stripUndefined o omite
    // quando ausente (tracks tela-cheia/áudio/single).
    stageSlot: track.stageSlot,
    clips: track.clips.map(serializeClip),
  });
}

function serializeCaptionTrack(track: CaptionTrack): DocumentData {
  return stripUndefined({
    id: track.id,
    name: track.name,
    index: track.index,
    visible: track.visible,
    locked: track.locked,
    language: track.language ?? null,
    source: track.source,
    cues: track.cues.map((c) => ({
      id: c.id,
      startTime: c.startTime,
      endTime: c.endTime,
      text: c.text,
      slot: c.slot,
      style: { ...c.style },
    })),
  });
}

/**
 * Serializa um `VideoProject` para `DocumentData` pronto para gravar
 * com `setDoc`.
 *
 * - `updatedAt` é sobrescrito com `Timestamp.now()`.
 * - `createdAt` é preservado se já existir (no formato Timestamp); caso
 *   contrário, usa o agora.
 * - Assets com `source === 'local-blob'` sem `storagePath` são **omitidos**.
 */
export function serializeProjectForFirestore(
  project: VideoProject,
): DocumentData {
  const assets = project.assets
    .map(serializeAsset)
    .filter((a): a is DocumentData => a !== null);

  const data: DocumentData = {
    id: project.id,
    name: project.name,
    ownerUid: project.ownerUid,
    createdAt: toTimestamp(project.createdAt),
    updatedAt: Timestamp.now(),
    resolution: { ...project.resolution },
    frameRate: project.frameRate,
    duration: project.duration,
    stageMode: project.stageMode,
    splitRatio: project.splitRatio,
    assets,
    tracks: project.tracks.map(serializeTrack),
    captionTracks: project.captionTracks.map(serializeCaptionTrack),
    audioMaster: { ...project.audioMaster },
  };
  if (project.stages !== undefined) {
    data.stages = project.stages.map((s) => ({ ...s }));
  }
  if (project.stageBackground !== undefined) {
    data.stageBackground = project.stageBackground;
  }
  if (project.overlays !== undefined) {
    data.overlays = { ...project.overlays };
  }
  if (project.identity !== undefined) {
    data.identity = { ...project.identity };
  }
  if (project.speechRate !== undefined) {
    data.speechRate = project.speechRate;
  }
  if (project.originRecorte !== undefined) {
    data.originRecorte = { ...project.originRecorte };
  }
  return stripUndefined(data);
}

/**
 * Reconstrói um `VideoProject` a partir do documento Firestore.
 *
 * Aceita Timestamps já no formato Firestore SDK ou objetos brutos
 * `{ seconds, nanoseconds }`.
 */
export function deserializeProjectFromFirestore(
  id: string,
  data: DocumentData,
): VideoProject {
  // Helpers de fallback.
  const safeArray = <T>(arr: unknown, mapper: (item: unknown) => T): T[] => {
    if (!Array.isArray(arr)) return [];
    return arr.map(mapper);
  };

  const project: VideoProject = {
    id,
    name: typeof data.name === 'string' ? data.name : 'Sem título',
    ownerUid: typeof data.ownerUid === 'string' ? data.ownerUid : '',
    createdAt: toTimestamp(data.createdAt),
    updatedAt: toTimestamp(data.updatedAt),
    resolution: data.resolution,
    frameRate: data.frameRate ?? 30,
    duration: typeof data.duration === 'number' ? data.duration : 0,
    stageMode: data.stageMode === 'split-vertical' ? 'split-vertical' : 'single',
    splitRatio: typeof data.splitRatio === 'number' ? data.splitRatio : 0.5,
    stages: Array.isArray(data.stages) ? (data.stages as VideoProject['stages']) : undefined,
    assets: safeArray(data.assets, (a) => {
      const asset = a as Partial<MediaAsset> & DocumentData;
      return {
        id: asset.id ?? `asset_${Math.random().toString(36).slice(2, 10)}`,
        name: asset.name ?? 'asset',
        type: (asset.type as MediaAsset['type']) ?? 'video',
        source: (asset.source as MediaAsset['source']) ?? 'firebase',
        storagePath: asset.storagePath,
        downloadUrl: asset.downloadUrl ?? '',
        size: typeof asset.size === 'number' ? asset.size : 0,
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
        thumbnailUrl: asset.thumbnailUrl,
        status: (asset.status as MediaAsset['status']) ?? 'ready',
        uploadProgress: asset.uploadProgress,
        createdAt: toTimestamp(asset.createdAt),
      } as MediaAsset;
    }),
    tracks: safeArray(data.tracks, (t) => {
      const tr = t as Partial<Track> & DocumentData;
      return {
        id: tr.id ?? `track_${Math.random().toString(36).slice(2, 10)}`,
        type: (tr.type as Track['type']) ?? 'video',
        name: tr.name ?? 'Track',
        index: typeof tr.index === 'number' ? tr.index : 0,
        muted: !!tr.muted,
        locked: !!tr.locked,
        visible: tr.visible !== false,
        solo: !!tr.solo,
        height: typeof tr.height === 'number' ? tr.height : 64,
        layerCount:
          typeof tr.layerCount === 'number' && tr.layerCount >= 1
            ? tr.layerCount
            : undefined,
        stageSlot:
          tr.stageSlot === 'top' || tr.stageSlot === 'bottom'
            ? tr.stageSlot
            : undefined,
        clips: Array.isArray(tr.clips)
          ? (tr.clips as DocumentData[]).map((c) => {
              return {
                ...c,
                transitionIn: c.transitionIn ?? undefined,
                transitionOut: c.transitionOut ?? undefined,
                keyframes: Array.isArray(c.keyframes) ? c.keyframes : [],
              } as Clip;
            })
          : [],
      } as Track;
    }),
    captionTracks: safeArray(data.captionTracks, (t) => {
      const tr = t as Partial<CaptionTrack> & DocumentData;
      return {
        id: tr.id ?? `captrk_${Math.random().toString(36).slice(2, 10)}`,
        name: tr.name ?? 'Legendas',
        index: typeof tr.index === 'number' ? tr.index : 0,
        visible: tr.visible !== false,
        locked: !!tr.locked,
        language: tr.language ?? undefined,
        source: tr.source ?? undefined,
        cues: Array.isArray(tr.cues) ? (tr.cues as CaptionTrack['cues']) : [],
      };
    }),
    audioMaster: data.audioMaster ?? { volume: 1, muted: false },
  };

  if (data.stageBackground && typeof data.stageBackground === 'string') {
    project.stageBackground = data.stageBackground;
  }
  if (data.overlays && typeof data.overlays === 'object') {
    project.overlays = data.overlays as VideoProject['overlays'];
  }
  if (data.identity && typeof data.identity === 'object') {
    project.identity = data.identity as VideoProject['identity'];
  }
  if (typeof data.speechRate === 'number' && data.speechRate > 0) {
    project.speechRate = data.speechRate;
  }
  if (data.originRecorte && typeof data.originRecorte === 'object') {
    project.originRecorte = data.originRecorte as VideoProject['originRecorte'];
  }

  return project;
}
