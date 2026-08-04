/**
 * Client do Portal da Transparência de Marília — plataforma SMARAPD
 * ("pai-webapp"). Substitui o antigo `src/lib/transparencia/smarapd-client.ts`,
 * que sondava URLs erradas e não enviava o header `User-Agent`.
 *
 * USO SERVER-SIDE APENAS. Dois motivos:
 *  1. A API exige o header `User-Agent` — sem ele responde HTTP 400.
 *  2. O browser bloquearia por CORS.
 * Chamar sempre de API routes (`/api/nexo/*`) ou Cloud Functions.
 *
 * Contrato confirmado em docs/transparencia-api-reference.md e
 * docs/nexo/01-fontes-de-dados.md.
 */
import { FONTES } from '../constants';

const BASE = FONTES.smarapd;
const TIMEOUT_MS = 25_000;

/**
 * Sem `User-Agent` a API SMARAPD responde 400. Usamos um UA de browser real
 * porque o WAF do portal rejeita clientes não-browser.
 */
const COMMON_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: 'https://transparencia.marilia.sp.gov.br/',
  Accept: 'application/json, text/plain, */*',
};

async function smarapdFetch(path: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${BASE}/${path.replace(/^\//, '')}`, {
      ...init,
      signal: ctrl.signal,
      headers: { ...COMMON_HEADERS, ...(init?.headers as Record<string, string>) },
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Tipos ────────────────────────────────────────────────────────────────────

export type Periodicidade =
  | 'ANUAL'
  | 'SEMESTRAL'
  | 'QUADRIMESTRAL'
  | 'TRIMESTRAL'
  | 'BIMESTRAL'
  | 'MENSAL';

export interface FiltroRedireciona {
  campo: string;
  valor: string;
  tipoValor: string;
}

export interface ModuloVisaoQuery {
  chaveModulo: string;
  nomeVisao: string;
  exercicio: number;
  periodicidade?: Periodicidade | '';
  periodo?: string | null;
  pagina?: number;
  quantidadeRegistros?: number;
  filtroRedireciona?: FiltroRedireciona | null;
}

export interface ModuloVisaoResponse<T = Record<string, unknown>> {
  QuantidadePaginas: number;
  QuantidadeRegistros: number;
  Valores: T[];
}

/** Um módulo do catálogo do portal. */
export interface SmarapdModulo {
  chaveModulo: string;
  nomeVisao: string;
  nome: string;
}

/**
 * Catálogo dos 17 módulos confirmados da API SMARAPD.
 * Ver docs/transparencia-api-reference.md §3.
 */
export const SMARAPD_MODULOS: readonly SmarapdModulo[] = [
  { chaveModulo: 'folha_pagamento_detalhes', nomeVisao: 'ReceitaAnalitica', nome: 'Receita Analítica' },
  { chaveModulo: 'balancetereceita', nomeVisao: 'Arrecadacoes', nome: 'Receitas por conta/mês' },
  { chaveModulo: 'despesa_sintetica', nomeVisao: 'DespesaSintetica', nome: 'Despesas Sintéticas' },
  { chaveModulo: 'DespesaAgrupada', nomeVisao: 'DespesaseInvestimentos', nome: 'Despesas Orçamentárias' },
  { chaveModulo: 'despesa_viagem', nomeVisao: 'passagenslocomocao', nome: 'Passagens e Locomoção' },
  { chaveModulo: 'despesas_subvencoes', nomeVisao: 'subvencoes', nome: 'Despesas com Subvenções' },
  { chaveModulo: 'despesa_covid', nomeVisao: 'despesacovid', nome: 'Empenhos COVID-19' },
  { chaveModulo: 'restoapagar', nomeVisao: 'restoapagar', nome: 'Restos a Pagar' },
  { chaveModulo: 'fornecedor', nomeVisao: 'fornecedoranalitico', nome: 'Empenho Analítico' },
  { chaveModulo: 'quadro_de_renda_local', nomeVisao: 'EmpenhoModalidade', nome: 'Empenho por Modalidade' },
  { chaveModulo: 'despesas_sinteticas', nomeVisao: 'MovimentoEmpenho', nome: 'Movimento de Empenho' },
  { chaveModulo: 'despesas_de_pagamentos', nomeVisao: 'publicidade', nome: 'Publicidade e Propaganda' },
  { chaveModulo: 'seguranca', nomeVisao: 'publicidadedigital', nome: 'Publicidade Digital' },
  { chaveModulo: 'diarias', nomeVisao: 'diarias', nome: 'Despesas com Diárias' },
  { chaveModulo: 'patrimonio_mobiliario', nomeVisao: 'patrimonio', nome: 'Patrimônio Mobiliário' },
  { chaveModulo: 'emendas_parlamentares', nomeVisao: 'EmendasParlamentares', nome: 'Emendas Parlamentares' },
  { chaveModulo: 'pagamentos', nomeVisao: 'pagamentoaservidores', nome: 'Pagamentos a Servidores' },
];

// ── Endpoints ────────────────────────────────────────────────────────────────

/** Endpoint central — consulta um módulo dinâmico (uma página). */
export async function filterModulo<T = Record<string, unknown>>(
  q: ModuloVisaoQuery,
): Promise<ModuloVisaoResponse<T>> {
  const body = {
    ChaveModulo: q.chaveModulo,
    NomeVisao: q.nomeVisao,
    Exercicio: q.exercicio,
    Periodicidade: q.periodicidade ?? 'ANUAL',
    Periodo: q.periodo ?? null,
    Filtros: [],
    Ordenacao: [],
    Pagina: q.pagina ?? 1,
    QuantidadeRegistros: q.quantidadeRegistros ?? 100,
    FiltroRedirecionaVisao: q.filtroRedireciona
      ? {
          Campo: q.filtroRedireciona.campo,
          Valor: q.filtroRedireciona.valor,
          TipoValor: q.filtroRedireciona.tipoValor,
        }
      : { Campo: null, Valor: null, TipoValor: null },
    UrlExportacao: '',
  };
  const res = await smarapdFetch('modulovisao/filter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`SMARAPD modulovisao/filter HTTP ${res.status}`);
  return (await res.json()) as ModuloVisaoResponse<T>;
}

/**
 * Varre TODAS as páginas de um módulo. O filtro server-side da API retorna
 * 400 — por isso a varredura completa é necessária. Inclui um pequeno atraso
 * entre páginas para respeitar o portal.
 */
export async function filterModuloAllPages<T = Record<string, unknown>>(
  q: ModuloVisaoQuery,
  opts: { maxPaginas?: number; delayMs?: number } = {},
): Promise<T[]> {
  const { maxPaginas = 500, delayMs = 250 } = opts;
  const primeira = await filterModulo<T>({ ...q, pagina: 1 });
  const total = Math.min(primeira.QuantidadePaginas || 1, maxPaginas);
  const valores = [...primeira.Valores];
  for (let pagina = 2; pagina <= total; pagina++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await filterModulo<T>({ ...q, pagina });
      valores.push(...res.Valores);
    } catch (err) {
      // Falha numa página intermediária — devolve o que já foi coletado em
      // vez de perder o lote inteiro. NÃO é silencioso: registra em log para
      // que a coleta parcial seja rastreável (Codex review — achado ALTO).
      console.warn(
        `[smarapd] ${q.chaveModulo}/${q.nomeVisao} exercício ${q.exercicio}: ` +
          `falha na página ${pagina}/${total} — coleta parcial com ` +
          `${valores.length} registros. ${err instanceof Error ? err.message : err}`,
      );
      break;
    }
  }
  return valores;
}

/** Catálogo de módulos do portal, com metadados de sincronização. */
export async function getDadosAbertos(): Promise<Record<string, unknown>> {
  const res = await smarapdFetch('DadosAbertos');
  if (!res.ok) throw new Error(`SMARAPD DadosAbertos HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Árvore de menus do portal. */
export async function getMenuPortal(): Promise<unknown[]> {
  const res = await smarapdFetch('MenuPortal');
  if (!res.ok) throw new Error(`SMARAPD MenuPortal HTTP ${res.status}`);
  return (await res.json()) as unknown[];
}

/** Visão fixa (relatórios LRF, empresas punidas, etc.). */
export async function getVisaoFixa(
  chaveModulo: string,
  nomeVisao: string,
): Promise<Record<string, unknown>> {
  const res = await smarapdFetch(`modulovisao/fixo/${chaveModulo}/${nomeVisao}`);
  if (!res.ok) throw new Error(`SMARAPD visao fixa HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export interface SmarapdStatus {
  conectado: boolean;
  status: number | null;
  modulos: number | null;
  erro: string | null;
  verificadoEm: string;
}

/** Teste de conectividade — usado pelo Painel de Coleta. */
export async function probeSmarapd(): Promise<SmarapdStatus> {
  const verificadoEm = new Date().toISOString();
  try {
    const dados = await getDadosAbertos();
    const modulos = Array.isArray((dados as { Modulos?: unknown[] }).Modulos)
      ? (dados as { Modulos: unknown[] }).Modulos.length
      : null;
    return { conectado: true, status: 200, modulos, erro: null, verificadoEm };
  } catch (err) {
    return {
      conectado: false,
      status: null,
      modulos: null,
      erro: err instanceof Error ? err.message : 'erro desconhecido',
      verificadoEm,
    };
  }
}
