/**
 * Enriquecimento de CNPJ via BrasilAPI + checagem de inidôneos (CEIS/CNEP).
 *
 * BrasilAPI é gratuita e sem chave. A consulta de sanções no Portal da
 * Transparência Federal exige um token gratuito em `PORTAL_TRANSPARENCIA_TOKEN`
 * — sem ele, a checagem de inidôneos é marcada como não verificada.
 *
 * Uso server-side.
 */
const BRASILAPI = 'https://brasilapi.com.br/api/cnpj/v1';
const MINHARECEITA = 'https://minhareceita.org';
const PORTAL_FEDERAL = 'https://api.portaldatransparencia.gov.br/api-de-dados';
const TIMEOUT_MS = 15_000;
// IP de datacenter (Cloud Run) costuma tomar 403 da BrasilAPI sem User-Agent.
const UA = 'OficioExpresso-NEXO/1.0 (fiscalizacao de dados publicos)';

export interface CnpjSocio {
  nome: string;
  qualificacao: string;
}

export interface CnpjInfo {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia: string | null;
  situacaoCadastral: string;
  /** Data de início de atividade (ISO). */
  dataAbertura: string | null;
  uf: string | null;
  municipio: string | null;
  cnaePrincipal: string | null;
  cnaeDescricao: string | null;
  capitalSocial: number | null;
  socios: CnpjSocio[];
}

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA },
      cache: 'no-store',
    });
    const json = res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
}

/** BrasilAPI → CnpjInfo (flat). */
function deBrasilApi(cnpj: string, d: Record<string, unknown>): CnpjInfo {
  const capital = Number(d.capital_social);
  return {
    cnpj,
    razaoSocial: String(d.razao_social ?? ''),
    nomeFantasia: (d.nome_fantasia as string) || null,
    situacaoCadastral: String(d.descricao_situacao_cadastral ?? ''),
    dataAbertura: (d.data_inicio_atividade as string) || null,
    uf: (d.uf as string) || null,
    municipio: (d.municipio as string) || null,
    cnaePrincipal: d.cnae_fiscal != null ? String(d.cnae_fiscal) : null,
    cnaeDescricao: (d.cnae_fiscal_descricao as string) || null,
    capitalSocial: Number.isFinite(capital) ? capital : null,
    socios: Array.isArray(d.qsa)
      ? (d.qsa as Record<string, unknown>[]).map((s) => ({
          nome: String(s.nome_socio ?? s.nome ?? ''),
          qualificacao: String(s.qualificacao_socio ?? s.codigo_qualificacao_socio ?? ''),
        }))
      : [],
  };
}

/** minhareceita.org → CnpjInfo (estabelecimento aninhado). Fallback da BrasilAPI. */
function deMinhaReceita(cnpj: string, d: Record<string, unknown>): CnpjInfo {
  const est = (d.estabelecimento as Record<string, unknown>) ?? {};
  const estado = (est.estado as Record<string, unknown>) ?? {};
  const cidade = (est.cidade as Record<string, unknown>) ?? {};
  const ativ = (est.atividade_principal as Record<string, unknown>) ?? {};
  const capital = Number(d.capital_social);
  return {
    cnpj,
    razaoSocial: String(d.razao_social ?? ''),
    nomeFantasia: (est.nome_fantasia as string) || null,
    situacaoCadastral: String(est.situacao_cadastral ?? ''),
    dataAbertura: (est.data_inicio_atividade as string) || null,
    uf: (estado.sigla as string) || null,
    municipio: (cidade.nome as string) || null,
    cnaePrincipal: ativ.id != null ? String(ativ.id) : null,
    cnaeDescricao: (ativ.descricao as string) || null,
    capitalSocial: Number.isFinite(capital) ? capital : null,
    socios: Array.isArray(d.qsa)
      ? (d.qsa as Record<string, unknown>[]).map((s) => ({
          nome: String(s.nome_socio ?? s.nome ?? ''),
          qualificacao: String(s.qualificacao_socio ?? s.qualificacao ?? ''),
        }))
      : [],
  };
}

/**
 * Consulta dados cadastrais de um CNPJ. Tenta a BrasilAPI (com User-Agent — sem
 * ele, IP de datacenter toma 403) e, em QUALQUER falha (403/429/timeout/5xx),
 * cai para o espelho `minhareceita.org`. NUNCA lança: devolve null se ambas as
 * fontes falharem ou o CNPJ não existir — a rota degrada honesto, sem 502.
 */
export async function getCnpj(cnpjRaw: string): Promise<CnpjInfo | null> {
  const cnpj = String(cnpjRaw ?? '').replace(/\D/g, '');
  if (cnpj.length !== 14) return null;

  const brasil = await fetchJson(`${BRASILAPI}/${cnpj}`);
  if (brasil.ok && brasil.json) return deBrasilApi(cnpj, brasil.json);

  // Fallback: minhareceita.org (mesma base aberta da Receita).
  const minha = await fetchJson(`${MINHARECEITA}/${cnpj}`);
  if (minha.ok && minha.json) return deMinhaReceita(cnpj, minha.json);

  return null; // ambas indisponíveis ou CNPJ inexistente — degrada sem lançar
}

export interface SancaoInfo {
  /** false quando não há token configurado ou a consulta falhou. */
  verificado: boolean;
  ceis: number;
  cnep: number;
  erro: string | null;
}

/** Checa se o CNPJ consta nos cadastros CEIS e CNEP (inidôneos). */
export async function getSancoes(cnpjRaw: string): Promise<SancaoInfo> {
  const cnpj = String(cnpjRaw ?? '').replace(/\D/g, '');
  const token = process.env.PORTAL_TRANSPARENCIA_TOKEN;
  if (!token || cnpj.length !== 14) {
    return { verificado: false, ceis: 0, cnep: 0, erro: token ? null : 'token ausente' };
  }

  const headers = { Accept: 'application/json', 'chave-api-dados': token };
  try {
    const [ceisRes, cnepRes] = await Promise.all([
      fetch(`${PORTAL_FEDERAL}/ceis?cnpjSancionado=${cnpj}&pagina=1`, { headers, cache: 'no-store' }),
      fetch(`${PORTAL_FEDERAL}/cnep?cnpjSancionado=${cnpj}&pagina=1`, { headers, cache: 'no-store' }),
    ]);
    // HTTP não-2xx não é "zero sanções" — é falha de consulta. Tratar como
    // "não verificado" evita um falso negativo de inidoneidade.
    if (!ceisRes.ok || !cnepRes.ok) {
      const status = !ceisRes.ok ? ceisRes.status : cnepRes.status;
      return {
        verificado: false,
        ceis: 0,
        cnep: 0,
        erro: `Portal da Transparência respondeu HTTP ${status}`,
      };
    }
    const ceis = ((await ceisRes.json()) as unknown[]).length;
    const cnep = ((await cnepRes.json()) as unknown[]).length;
    return { verificado: true, ceis, cnep, erro: null };
  } catch (err) {
    return {
      verificado: false,
      ceis: 0,
      cnep: 0,
      erro: err instanceof Error ? err.message : 'erro desconhecido',
    };
  }
}
