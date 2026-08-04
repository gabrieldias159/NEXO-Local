/**
 * Client do Querido Diário (Open Knowledge Brasil) — busca FULL-TEXT no Diário
 * Oficial do Município, indexado por território (código IBGE).
 *
 * Fonte primária de INDÍCIOS por palavra-chave: "dispensa", "emergencial",
 * "inexigibilidade", "aditivo", "ratifico" etc., com data, edição, link do PDF
 * oficial e trechos (excerpts). Cada ocorrência já carrega a prova documental.
 *
 * API pública, sem autenticação. Uso server-side. Marília = IBGE 3529005.
 * Endpoint confirmado: GET {base}/gazettes?territory_ids=3529005&querystring=...
 */
import { FONTES, MARILIA } from '../constants';

const BASE = FONTES.queridoDiario;
const TIMEOUT_MS = 20_000;
const HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

/** Uma ocorrência de edição do DOM que casou a busca. */
export interface DiarioOcorrencia {
  /** Data da edição (YYYY-MM-DD). */
  data: string;
  /** Número da edição, quando disponível. */
  edicao: string | null;
  edicaoExtra: boolean;
  /** URL do PDF oficial da edição (a prova). */
  url: string;
  /** URL do texto extraído (.txt), quando disponível. */
  txtUrl: string | null;
  /** Trechos com o termo destacado. */
  excertos: string[];
}

export interface BuscaDiarioParams {
  /** Termo de busca full-text (ex.: 'dispensa'). Vazio = todas as edições. */
  termo?: string;
  /** Data inicial de publicação (YYYY-MM-DD). */
  de?: string;
  /** Data final de publicação (YYYY-MM-DD). */
  ate?: string;
  /** Tamanho da página (default 20). */
  tamanho?: number;
  /** Página 1-based (default 1). */
  pagina?: number;
}

interface QdResposta {
  total_gazettes?: number;
  gazettes?: Array<{
    date?: string;
    edition?: string | number;
    is_extra_edition?: boolean;
    url?: string;
    txt_url?: string;
    excerpts?: unknown;
  }>;
}

/**
 * Busca edições do DOM de Marília que casam o termo/período.
 * Degrada com erro honesto (nunca inventa); a chamada decide o fallback.
 */
export async function buscarDiario(
  p: BuscaDiarioParams,
): Promise<{ total: number; ocorrencias: DiarioOcorrencia[] }> {
  const tamanho = p.tamanho && p.tamanho > 0 ? Math.min(p.tamanho, 100) : 20;
  const pagina = p.pagina && p.pagina > 0 ? p.pagina : 1;

  const url = new URL(`${BASE}/gazettes`);
  url.searchParams.set('territory_ids', MARILIA.ibge);
  if (p.termo) url.searchParams.set('querystring', p.termo);
  if (p.de) url.searchParams.set('published_since', p.de);
  if (p.ate) url.searchParams.set('published_until', p.ate);
  url.searchParams.set('size', String(tamanho));
  url.searchParams.set('offset', String((pagina - 1) * tamanho));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers: HEADERS,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Querido Diário HTTP ${res.status}`);
    const json = (await res.json()) as QdResposta;
    const ocorrencias: DiarioOcorrencia[] = (json.gazettes ?? []).map((g) => ({
      data: String(g.date ?? ''),
      edicao: g.edition != null && g.edition !== '' ? String(g.edition) : null,
      edicaoExtra: g.is_extra_edition === true,
      url: String(g.url ?? ''),
      txtUrl: g.txt_url ? String(g.txt_url) : null,
      excertos: Array.isArray(g.excerpts) ? g.excerpts.map((e) => String(e)) : [],
    }));
    return { total: Number(json.total_gazettes ?? ocorrencias.length), ocorrencias };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Querido Diário — timeout após ${TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
