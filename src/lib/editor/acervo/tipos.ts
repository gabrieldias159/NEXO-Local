/**
 * Tipos do ACERVO DO GABINETE (recursos 13 e 14) — catálogo de sons do
 * myinstants e de memes/efeitos em vídeo.
 *
 * Padrão CATÁLOGO-FIRST: a interface mostra os METADADOS do acervo inteiro
 * (nome, momento de uso, risco editorial, licença) e só baixa o item que o
 * usuário escolher. Nunca download em massa.
 *
 * Arquivo puro (sem `node:`) — o componente do MediaBin importa daqui.
 */

/** Nível de risco editorial de um item, já normalizado para a UI. */
export type NivelRisco = 'baixo' | 'medio' | 'alto';

export interface ItemSom {
  /** Chave estável (usada no React e no download). */
  id: string;
  nome: string;
  /** Página do myinstants (fonte da verdade do mp3). */
  urlPagina?: string;
  /** MP3 direto, quando o catálogo já traz. */
  urlMp3?: string;
  tags: string[];
  /** Em que momento do vídeo esse som entra. */
  momento?: string;
  risco: NivelRisco;
  motivoRisco?: string;
  /**
   * Caminho no disco quando o som JÁ está baixado (pastas `sons/cc0` e
   * `sons/myinstants`). Nesse caso "trazer pro projeto" não baixa nada da
   * internet, só copia do acervo local.
   */
  arquivoLocal?: string;
  /** De onde veio: catálogo online ou já em disco. */
  origem: 'catalogo' | 'disco';
}

export interface ItemMeme {
  id: string;
  nome: string;
  /** Mixkit, Pexels, Archive.org, Tenor… ou "Acervo local". */
  fonte: string;
  /** Página/arquivo online. */
  url?: string;
  licenca?: string;
  risco: NivelRisco;
  /** Texto original do risco (traz o motivo por extenso). */
  riscoDetalhe?: string;
  /** Como usar no vídeo. */
  uso?: string;
  arquivoLocal?: string;
  origem: 'catalogo' | 'disco';
  /**
   * `true` para Tenor/GIPHY: conteúdo de terceiros via API, que a regra do
   * gabinete só libera em post ORGÂNICO — nunca em conteúdo impulsionado.
   */
  usoOrganico: boolean;
  /** `true` quando não dá para baixar direto (busca que exige chave). */
  somenteBusca: boolean;
}

/** Resposta de `GET /api/editor/acervo`. */
export interface RespostaAcervo {
  ok: boolean;
  pasta: string;
  sons?: ItemSom[];
  memes?: ItemMeme[];
  erro?: string;
}

/** Asset devolvido por `POST /api/editor/projects/{id}/acervo`. */
export interface AssetBaixado {
  id: string;
  name: string;
  type: 'video' | 'audio' | 'image';
  storagePath: string;
  downloadUrl: string;
  size: number;
  duration?: number;
  width?: number;
  height?: number;
}

/** Rótulo pt-BR do risco, para o chip da interface. */
export const RISCO_LABEL: Record<NivelRisco, string> = {
  baixo: 'risco baixo',
  medio: 'risco médio',
  alto: 'risco alto',
};
