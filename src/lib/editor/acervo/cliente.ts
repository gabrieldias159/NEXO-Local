/**
 * Ponte CLIENTE do acervo do gabinete (recursos 13, 14 e 16).
 *
 * Um lugar só para: montar a URL de pré-escuta, pedir o download unitário e
 * transformar a resposta num `MediaAsset` do editor. Usado pelos painéis do
 * MediaBin e pelo drop de item do acervo direto na timeline.
 */

import type { Timestamp } from 'firebase/firestore';

import type { AssetBaixado } from './tipos';
import type { MediaAsset } from '../types';

/** MIME do drag&drop de um item do ACERVO (ainda não é asset do projeto). */
export const ACERVO_DRAG_MIME = 'application/vnd.gabinete.acervo';

/** O que a interface manda para baixar um item — vira o corpo do POST. */
export interface PedidoAcervo {
  tipo: 'som' | 'meme';
  nome: string;
  arquivoLocal?: string;
  urlPagina?: string;
  url?: string;
}

/** URL que toca/mostra um arquivo do acervo direto do disco (pré-escuta). */
export function urlPreviewAcervo(caminho: string): string {
  return `/api/editor/acervo/arquivo?caminho=${encodeURIComponent(caminho)}`;
}

/**
 * Baixa UM item do acervo para o Storage do projeto e devolve o asset pronto
 * para `addAsset`. Lança `Error` com a mensagem do servidor em caso de falha.
 */
export async function trazerDoAcervo(
  projectId: string,
  pedido: PedidoAcervo,
): Promise<MediaAsset> {
  const res = await fetch(`/api/editor/projects/${projectId}/acervo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pedido),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    asset?: AssetBaixado;
    erro?: string;
  };
  if (!res.ok || !json.ok || !json.asset) {
    throw new Error(json.erro ?? `HTTP ${res.status}`);
  }
  const a = json.asset;
  const now = {
    seconds: Math.floor(Date.now() / 1000),
    nanoseconds: 0,
  } as unknown as Timestamp;
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    source: 'firebase',
    storagePath: a.storagePath,
    downloadUrl: a.downloadUrl,
    size: a.size,
    duration: a.duration,
    width: a.width,
    height: a.height,
    status: 'ready',
    createdAt: now,
  };
}
