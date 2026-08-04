/**
 * Client da API SICONFI/STN (Tesouro Nacional) — fonte do monitor de Metas
 * Fiscais & Orçamentárias. Fornece RREO, RGF e DCA com histórico plurianual.
 *
 * Sempre filtrado ao município de Marília (IBGE 3529005) — nenhuma outra
 * prefeitura é consultada.
 *
 * API pública, sem autenticação. Uso server-side (chamar de API routes).
 * Docs: https://apidatalake.tesouro.gov.br/docs/siconfi
 */
import { FONTES, MARILIA } from '../constants';

const BASE = FONTES.siconfi;
const TIMEOUT_MS = 25_000;

interface SiconfiPage {
  items?: Record<string, unknown>[];
  hasMore?: boolean;
}

/** Busca todas as páginas de um endpoint SICONFI (paginação por offset). */
async function siconfiGetAll(
  endpoint: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let offset = 0;

  for (let guard = 0; guard < 60; guard++) {
    const url = new URL(`${BASE}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (offset) url.searchParams.set('offset', String(offset));

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let json: SiconfiPage;
    try {
      const res = await fetch(url.toString(), {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`SICONFI ${endpoint} HTTP ${res.status}`);
      json = (await res.json()) as SiconfiPage;
    } finally {
      clearTimeout(timer);
    }

    const items = json.items ?? [];
    out.push(...items);
    if (!json.hasMore || items.length === 0) break;
    offset += items.length;
  }
  return out;
}

// ── RREO — Relatório Resumido de Execução Orçamentária (bimestral) ───────────

export interface RREOQuery {
  exercicio: number;
  /** Bimestre 1–6. */
  periodo: number;
  /** 'RREO' (completo) ou 'RREO Simplificado'. */
  tipoDemonstrativo?: string;
  /** Anexo específico, ex.: 'RREO-Anexo 02'. Omitir traz todos. */
  anexo?: string;
}

export async function getRREO(q: RREOQuery): Promise<Record<string, unknown>[]> {
  const params: Record<string, string> = {
    an_exercicio: String(q.exercicio),
    nr_periodo: String(q.periodo),
    co_tipo_demonstrativo: q.tipoDemonstrativo ?? 'RREO',
    co_esfera: 'M',
    id_ente: MARILIA.ibge,
  };
  if (q.anexo) params.no_anexo = q.anexo;
  return siconfiGetAll('rreo', params);
}

// ── RGF — Relatório de Gestão Fiscal (quadrimestral/semestral) ───────────────

export interface RGFQuery {
  exercicio: number;
  /** Período 1–3 (quadrimestral) ou 1–2 (semestral). */
  periodo: number;
  /** 'Q' quadrimestral ou 'S' semestral. */
  periodicidade?: 'Q' | 'S';
  /** Poder: 'E' Executivo, 'L' Legislativo. */
  poder?: 'E' | 'L';
  tipoDemonstrativo?: string;
  anexo?: string;
}

export async function getRGF(q: RGFQuery): Promise<Record<string, unknown>[]> {
  const params: Record<string, string> = {
    an_exercicio: String(q.exercicio),
    nr_periodo: String(q.periodo),
    in_periodicidade: q.periodicidade ?? 'Q',
    co_tipo_demonstrativo: q.tipoDemonstrativo ?? 'RGF',
    co_esfera: 'M',
    co_poder: q.poder ?? 'E',
    id_ente: MARILIA.ibge,
  };
  if (q.anexo) params.no_anexo = q.anexo;
  return siconfiGetAll('rgf', params);
}

// ── DCA — Declaração de Contas Anuais ────────────────────────────────────────

export async function getDCA(exercicio: number, anexo?: string): Promise<Record<string, unknown>[]> {
  const params: Record<string, string> = {
    an_exercicio: String(exercicio),
    id_ente: MARILIA.ibge,
  };
  if (anexo) params.no_anexo = anexo;
  return siconfiGetAll('dca', params);
}

export interface SiconfiStatus {
  conectado: boolean;
  erro: string | null;
  verificadoEm: string;
}

/** Teste de conectividade do SICONFI. */
export async function probeSiconfi(exercicioReferencia: number): Promise<SiconfiStatus> {
  const verificadoEm = new Date().toISOString();
  try {
    await getRREO({ exercicio: exercicioReferencia, periodo: 1 });
    return { conectado: true, erro: null, verificadoEm };
  } catch (err) {
    return {
      conectado: false,
      erro: err instanceof Error ? err.message : 'erro desconhecido',
      verificadoEm,
    };
  }
}
