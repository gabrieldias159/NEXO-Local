/**
 * BIBLIOTECA DO GABINETE (pasta `biblioteca/` no Storage) — ponte cliente.
 *
 * Compartilhada pelo painel do MediaBin e pelo drop direto na timeline
 * (recurso 16): os dois precisam transformar um item da biblioteca num
 * `MediaAsset` do projeto, e a regra tem que ser a mesma nos dois caminhos.
 *
 * O asset aponta DIRETO para o arquivo da biblioteca (sem copiar bytes) —
 * a pasta é só de leitura para o editor.
 */

import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import type { FirebaseStorage } from 'firebase/storage';
import type { Timestamp } from 'firebase/firestore';

import { getMediaDuration } from '../ingest-files';
import type { MediaAsset } from '../types';

/** MIME do drag&drop de um item da BIBLIOTECA (ainda não é asset). */
export const BIBLIOTECA_DRAG_MIME = 'application/vnd.gabinete.biblioteca';

export interface ItemBiblioteca {
  fullPath: string;
  name: string;
  categoria: string;
  type: MediaAsset['type'];
}

const MIME: Record<MediaAsset['type'], string> = {
  video: 'video/mp4',
  audio: 'audio/mpeg',
  image: 'image/png',
};

/** Tipo de mídia pelo nome do arquivo. */
export function tipoPeloNome(name: string): MediaAsset['type'] {
  if (/\.(mp4|webm|mov)$/i.test(name)) return 'video';
  if (/\.(mp3|wav|m4a|ogg)$/i.test(name)) return 'audio';
  return 'image';
}

/** Item da biblioteca → `MediaAsset` pronto para `addAsset`. */
export async function assetDaBiblioteca(
  storage: FirebaseStorage,
  item: ItemBiblioteca,
): Promise<MediaAsset> {
  const url = await getDownloadURL(storageRef(storage, item.fullPath));
  const duration = await getMediaDuration({ url, type: MIME[item.type] });
  const now = {
    seconds: Math.floor(Date.now() / 1000),
    nanoseconds: 0,
  } as unknown as Timestamp;
  return {
    id: `asset_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`,
    name: item.name,
    type: item.type,
    source: 'firebase',
    storagePath: item.fullPath,
    downloadUrl: url,
    size: 0,
    duration,
    status: 'ready',
    createdAt: now,
  };
}
