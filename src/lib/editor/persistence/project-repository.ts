/**
 * Repositório de I/O do `VideoProject` no Firestore.
 *
 * Path: `videoProjects/{projectId}`.
 * Subcollection opcional: `videoProjects/{id}/renders/{jobId}` (gerenciado
 * por outro módulo).
 *
 * Convenções:
 * - `setDoc` com merge:false (substitui o documento inteiro). Auto-save
 *   sempre envia o estado atual completo do projeto.
 * - Listagem ordenada por `updatedAt desc`.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  Timestamp,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import {
  deleteObject,
  listAll,
  ref as storageRef,
  type FirebaseStorage,
  type StorageReference,
} from 'firebase/storage';

import type {
  CaptionStyle,
  ResolutionPreset,
  Track,
  VideoProject,
} from '../types';
import { DEFAULT_IDENTITY } from '../types';
import { GABINETE_CAPTION_STYLE } from '../captions/presets';
import {
  deserializeProjectFromFirestore,
  serializeProjectForFirestore,
} from './project-serializer';

const COLLECTION = 'videoProjects';

/** Persiste o projeto inteiro (cria/atualiza). */
export async function saveProject(
  firestore: Firestore,
  project: VideoProject,
): Promise<void> {
  const ref = doc(firestore, COLLECTION, project.id);
  const data = serializeProjectForFirestore(project);
  await setDoc(ref, data);
}

/** Carrega um projeto por id. Lança erro se não existir. */
export async function loadProject(
  firestore: Firestore,
  projectId: string,
): Promise<VideoProject> {
  const ref = doc(firestore, COLLECTION, projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    throw new Error(`Projeto não encontrado: ${projectId}`);
  }
  return deserializeProjectFromFirestore(snap.id, snap.data());
}

/**
 * Lista todos os projetos do usuário, ordenados por `updatedAt desc`.
 * Cliente deve filtrar via security rules (apenas docs do próprio user).
 */
export async function listUserProjects(
  firestore: Firestore,
  ownerUid: string,
): Promise<VideoProject[]> {
  const col = collection(firestore, COLLECTION);
  const q = query(
    col,
    where('ownerUid', '==', ownerUid),
    orderBy('updatedAt', 'desc'),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) =>
    deserializeProjectFromFirestore(d.id, d.data()),
  );
}

/** Apaga recursivamente TODOS os objetos do Storage sob um prefixo (best-effort). */
async function apagarPrefixoStorage(prefixo: StorageReference): Promise<void> {
  const listagem = await listAll(prefixo);
  await Promise.all(listagem.items.map((item) => deleteObject(item).catch(() => {})));
  await Promise.all(listagem.prefixes.map((sub) => apagarPrefixoStorage(sub)));
}

/**
 * Apaga um projeto POR INTEIRO (sem deixar órfãos):
 *   1) todos os assets do Storage sob `videoProjects/{id}/` (uploads em
 *      `.../assets/...`) — varredura recursiva, best-effort;
 *   2) os docs da subcoleção `videoProjects/{id}/renders` (jobs de render);
 *   3) o doc do projeto.
 *
 * `storage` é opcional só por compatibilidade de assinatura; quando ausente, os
 * assets NÃO são limpos (ficam órfãos) — a UI sempre deve passá-lo.
 */
export async function deleteProject(
  firestore: Firestore,
  projectId: string,
  storage?: FirebaseStorage,
): Promise<void> {
  // 1) Storage: assets do projeto. Varre `videoProjects/{id}/assets` (prefixo
  //    EXATO da regra de Storage — listar o root do projeto não é coberto pela
  //    regra e seria negado). Uploads vão para `.../assets/...` (ver uploadAsset).
  if (storage) {
    try {
      await apagarPrefixoStorage(storageRef(storage, `${COLLECTION}/${projectId}/assets`));
    } catch {
      /* best-effort — não impede a exclusão do projeto no Firestore */
    }
  }

  // 2) Firestore: subcoleção `renders` (em lotes de até 400).
  try {
    const rendersSnap = await getDocs(collection(firestore, `${COLLECTION}/${projectId}/renders`));
    const docs = rendersSnap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const lote = writeBatch(firestore);
      for (const d of docs.slice(i, i + 400)) lote.delete(d.ref);
      await lote.commit();
    }
  } catch {
    /* segue p/ apagar o doc do projeto mesmo se renders falhar */
  }

  // 3) Doc do projeto.
  const ref = doc(firestore, COLLECTION, projectId);
  await deleteDoc(ref);
}

/** Gera id curto cliente-side. */
function genProjectId(): string {
  return `proj_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

/**
 * Cria um projeto no Firestore com defaults sensatos. Retorna o
 * `VideoProject` já serializado/deserializado (com Timestamp real).
 */
export async function createNewProject(
  firestore: Firestore,
  ownerUid: string,
  name: string,
  resolution: ResolutionPreset,
  stageMode: 'single' | 'split-vertical' = 'single',
): Promise<VideoProject> {
  const id = genProjectId();
  const now = Timestamp.now();
  // Projeto split nasce com a ESTRUTURA fixa de palcos: 1 track de vídeo por
  // palco (superior + inferior) + 1 de áudio compartilhada. Single nasce vazio
  // (tracks são criadas sob demanda, comportamento histórico).
  const tracks: Track[] =
    stageMode === 'split-vertical' ? criarTracksDePalco() : [];
  const project: VideoProject = {
    id,
    name,
    ownerUid,
    createdAt: now,
    updatedAt: now,
    resolution,
    frameRate: 30,
    duration: 0,
    stageMode,
    splitRatio: 0.5,
    assets: [],
    tracks,
    captionTracks: [],
    audioMaster: { volume: 1, muted: false },
  };
  await saveProject(firestore, project);
  return project;
}

/**
 * ASSISTENTE "Novo vídeo do gabinete" (recurso 15).
 *
 * Cria o projeto já pronto pro fluxo do gabinete — zero cliques de setup:
 *  - 9:16 1080x1920 a 30 fps (Reels/Shorts/TikTok);
 *  - identidade LIGADA (logo + rodapé + vinheta) com os parâmetros aprovados;
 *  - as cinco faixas nomeadas do fluxo: V1 Féfin (a fala, base), V2 Criativos,
 *    V3 Memes, A1 Efeitos e A2 Trilha;
 *  - A2 já com o preset de trilha: 16% de volume, dinâmica nivelada, fades
 *    automáticos, EQ que abre espaço pra voz e duck pela voz;
 *  - faixa de legendas "Locução" com o estilo Gabinete como PADRÃO — toda
 *    legenda criada depois nasce amarela, em caixa alta, no lugar certo.
 */
export async function createGabineteProject(
  firestore: Firestore,
  ownerUid: string,
  name = 'Vídeo do gabinete',
): Promise<VideoProject> {
  const id = genProjectId();
  const now = Timestamp.now();
  const project: VideoProject = {
    id,
    name,
    ownerUid,
    createdAt: now,
    updatedAt: now,
    resolution: { width: 1080, height: 1920, label: 'Vertical 9:16 · 1080p' },
    frameRate: 30,
    duration: 0,
    stageMode: 'single',
    splitRatio: 0.5,
    overlays: { logo: true, footer: true, ending: true },
    identity: { ...DEFAULT_IDENTITY },
    assets: [],
    tracks: criarTracksDoGabinete(),
    captionTracks: [
      {
        id: `captrk_${Math.random().toString(36).slice(2, 10)}`,
        name: 'Locução',
        index: 0,
        visible: true,
        locked: false,
        language: 'pt-BR',
        source: 'manual',
        cues: [],
        defaultStyle: {
          ...DEFAULT_CAPTION_STYLE,
          ...GABINETE_CAPTION_STYLE,
        } as CaptionStyle,
      },
    ],
    audioMaster: { volume: 1, muted: false },
  };
  await saveProject(firestore, project);
  return project;
}

/**
 * As faixas do fluxo do gabinete. Índice maior = mais em cima no palco, então
 * a fala (V1) fica embaixo e memes (V3) por cima de tudo.
 */
function criarTracksDoGabinete(): Track[] {
  return [
    novaTrack({ type: 'video', name: 'V1 Féfin', index: 0 }),
    novaTrack({ type: 'video', name: 'V2 Criativos', index: 1 }),
    novaTrack({ type: 'video', name: 'V3 Memes', index: 2 }),
    novaTrack({ type: 'audio', name: 'A1 Efeitos', index: 3 }),
    novaTrack({
      type: 'audio',
      name: 'A2 Trilha',
      index: 4,
      gainPct: 16,
      audioLeveling: true,
      autoFade: true,
      voiceEq: true,
      voiceDuck: true,
    }),
  ];
}

/** Estilo base de legenda (mesmos campos obrigatórios do store). */
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

/** Cria um id curto de track (mesmo formato do store). */
function genTrackId(): string {
  return `track_${Math.random().toString(36).slice(2, 10)}`;
}

/** Track de vídeo/áudio com defaults sensatos. */
function novaTrack(over: Partial<Track> & Pick<Track, 'type' | 'name' | 'index'>): Track {
  return {
    id: genTrackId(),
    muted: false,
    locked: false,
    visible: true,
    solo: false,
    height: 64,
    clips: [],
    ...over,
  };
}

/**
 * Estrutura fixa do palco dividido: palco SUPERIOR (top) e INFERIOR (bottom),
 * cada um com sua track de vídeo, mais uma track de áudio compartilhada. O
 * índice maior fica por cima no z-order; superior antes do inferior espelha a
 * convenção do preview (top desenhado na banda de cima). Exportado p/ o store
 * reusar na normalização/troca de modo.
 */
export function criarTracksDePalco(): Track[] {
  return [
    novaTrack({ type: 'video', name: 'Palco superior', index: 0, stageSlot: 'top' }),
    novaTrack({ type: 'video', name: 'Palco inferior', index: 1, stageSlot: 'bottom' }),
    novaTrack({ type: 'audio', name: 'A1', index: 2 }),
  ];
}
