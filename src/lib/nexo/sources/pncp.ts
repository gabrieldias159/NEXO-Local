/**
 * Client da API de Consulta do PNCP — Portal Nacional de Contratações
 * Públicas (Lei 14.133/2021). Fonte de licitações, contratos e aditivos.
 *
 * Sempre filtrado ao órgão Prefeitura de Marília (cnpjOrgao). Uso server-side.
 *
 * ⚠ O PNCP responde 403 para IPs fora do Brasil — os jobs/rotas precisam
 * rodar em região brasileira (App Hosting / Cloud Run `southamerica-east1`).
 * Fora do Brasil (ex.: ambiente de dev) o fetch ao vivo VAI FALHAR: isso é
 * esperado e tratado — o conector degrada com erro honesto, nunca inventa
 * dado nem mascara a falha como "nenhum contrato".
 */
import { FONTES, MARILIA } from '../constants';
import { parseValorBR, parseDataISO, soDigitos } from '../normalizar';

const BASE = FONTES.pncp;
// 30s: via proxy regional há o hop extra (proxy aguarda o PNCP por até 25s);
// 25s no client abortava junto com o upstream, mascarando a resposta.
const TIMEOUT_MS = 30_000;

/**
 * User-Agent de browser. O PNCP às vezes recusa clients sem UA reconhecível;
 * um UA de navegador real reduz bloqueios artificiais (o geo-bloqueio por IP,
 * porém, não tem contorno aqui).
 */
const HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
};

/**
 * Proxy regional opcional (Cloud Function `onPncpProxy`, southamerica-east1).
 * O App Hosting roda em us-central1 e o PNCP geo-bloqueia IP estrangeiro —
 * SEM o proxy, toda chamada ao vivo de prod falha (403/timeout). Com
 * `PNCP_PROXY_URL` configurada (apphosting.yaml), a chamada sai por São Paulo.
 * O segredo é o mesmo das rotas de cômputo (fallback DIARIO_BACKFILL_SECRET).
 */
const PROXY_URL = (process.env.PNCP_PROXY_URL ?? '').replace(/\/+$/, '');
const PROXY_SECRET = (
  process.env.NEXO_DETECTAR_SECRET ?? process.env.DIARIO_BACKFILL_SECRET ?? ''
).trim();

async function pncpGet(
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  const viaProxy = Boolean(PROXY_URL && PROXY_SECRET);
  let url: URL;
  const headers: Record<string, string> = { ...HEADERS };
  if (viaProxy) {
    url = new URL(PROXY_URL);
    url.searchParams.set('path', path);
    headers['x-nexo-secret'] = PROXY_SECRET;
  } else {
    url = new URL(`${BASE}${path}`);
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers,
      cache: 'no-store',
    });
    if (res.status === 403) {
      throw new Error(
        'PNCP HTTP 403 — acesso bloqueado (geo-restrição: o PNCP recusa ' +
          'IPs fora do Brasil)',
      );
    }
    if (res.status === 204) return { data: [] };
    if (!res.ok) throw new Error(`PNCP ${path} HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`PNCP ${path} — timeout após ${TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface PncpContratosQuery {
  /** CNPJ do órgão (só dígitos). */
  cnpjOrgao: string;
  /** Data inicial de publicação, formato `yyyyMMdd`. */
  dataInicial: string;
  /** Data final de publicação, formato `yyyyMMdd`. */
  dataFinal: string;
  pagina?: number;
}

interface PncpRespostaPagina {
  data?: Record<string, unknown>[];
  totalPaginas?: number;
  totalRegistros?: number;
}

export interface PncpPagina {
  data: Record<string, unknown>[];
  totalPaginas: number;
  totalRegistros: number;
}

/** Consulta uma página de contratos por data de publicação. */
export async function getContratos(q: PncpContratosQuery): Promise<PncpPagina> {
  const json = (await pncpGet('/v1/contratos', {
    dataInicial: q.dataInicial,
    dataFinal: q.dataFinal,
    cnpjOrgao: q.cnpjOrgao,
    pagina: String(q.pagina ?? 1),
  })) as PncpRespostaPagina;
  return {
    data: json.data ?? [],
    totalPaginas: json.totalPaginas ?? 1,
    totalRegistros: json.totalRegistros ?? json.data?.length ?? 0,
  };
}

/** Varre todas as páginas de contratos (limitado por `maxPaginas`). */
export async function getContratosAllPages(
  q: Omit<PncpContratosQuery, 'pagina'>,
  opts: { maxPaginas?: number; delayMs?: number } = {},
): Promise<{ contratos: Record<string, unknown>[]; totalPaginas: number }> {
  const { maxPaginas = 20, delayMs = 150 } = opts;
  const primeira = await getContratos({ ...q, pagina: 1 });
  const contratos = [...primeira.data];
  const ate = Math.min(primeira.totalPaginas || 1, maxPaginas);
  for (let p = 2; p <= ate; p++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const resp = await getContratos({ ...q, pagina: p });
    contratos.push(...resp.data);
  }
  return { contratos, totalPaginas: primeira.totalPaginas || 1 };
}

export interface PncpStatus {
  conectado: boolean;
  erro: string | null;
  verificadoEm: string;
}

/** Teste de conectividade do PNCP. */
export async function probePncp(
  cnpjOrgao: string,
  exercicio: number,
): Promise<PncpStatus> {
  const verificadoEm = new Date().toISOString();
  try {
    await getContratos({
      cnpjOrgao,
      dataInicial: `${exercicio}0101`,
      dataFinal: `${exercicio}1231`,
      pagina: 1,
    });
    return { conectado: true, erro: null, verificadoEm };
  } catch (err) {
    return {
      conectado: false,
      erro: err instanceof Error ? err.message : 'erro desconhecido',
      verificadoEm,
    };
  }
}

// ── Modelo normalizado de contrato (edital → contrato → vigência → aditivo) ──

/**
 * Termo aditivo normalizado de um contrato. O PNCP expõe os aditivos no campo
 * `valorAcumulado`/`valorGlobal` e — quando disponível — numa lista de
 * alterações. Aqui guardamos o essencial para os detectores LC-19/LC-20.
 */
export interface AditivoPNCP {
  /** Sequencial/identificação do termo aditivo. */
  numero: string;
  /** Tipo do aditivo (acréscimo, supressão, prazo, repactuação…). */
  tipo: string;
  /** Acréscimo de valor trazido por este aditivo (R$), 0 se for só de prazo. */
  valor: number;
  /** Nova data-fim de vigência decorrente do aditivo, ISO ou null. */
  novaVigenciaFim: string | null;
  /** Data do termo aditivo, ISO ou null. */
  data: string | null;
}

/**
 * Contrato do PNCP normalizado. Cobre o elo que a API municipal (SMARAPD)
 * não tem: edital → contrato → vigência → aditivo.
 */
export interface ContratoPNCP {
  /** Número de controle PNCP (identificador único nacional). */
  id: string;
  /** Número do contrato/empenho no órgão. */
  numeroContrato: string;
  /** Objeto do contrato. */
  objeto: string;
  /** Razão social do fornecedor contratado. */
  fornecedorNome: string;
  /** CNPJ/CPF do fornecedor — apenas dígitos. */
  fornecedorDoc: string;
  /** Valor inicial do contrato (R$). */
  valorInicial: number;
  /** Valor global/atualizado — reflete aditivos acumulados (R$). */
  valorGlobal: number;
  /** Data de assinatura, ISO `yyyy-MM-dd` ou null. */
  dataAssinatura: string | null;
  /** Início da vigência, ISO `yyyy-MM-dd` ou null. */
  dataVigenciaInicio: string | null;
  /** Fim da vigência (atual, já considerando aditivos de prazo), ISO ou null. */
  dataVigenciaFim: string | null;
  /** Termos aditivos do contrato. */
  aditivos: AditivoPNCP[];
  /** Modalidade de contratação (pregão, dispensa, inexigibilidade…). */
  modalidade: string;
  /** Órgão/entidade contratante. */
  orgaoNome: string;
}

function pick(rec: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (rec[k] != null && rec[k] !== '') return rec[k];
  }
  return undefined;
}

function pickStr(rec: Record<string, unknown>, ...keys: string[]): string {
  const v = pick(rec, ...keys);
  return v == null ? '' : String(v).trim();
}

/**
 * Extrai a lista de termos aditivos de um registro de contrato do PNCP.
 * O PNCP expõe os aditivos de formas variadas conforme a versão da API;
 * a leitura é defensiva e nunca lança em registro malformado.
 */
function extrairAditivos(rec: Record<string, unknown>): AditivoPNCP[] {
  const bruto =
    pick(rec, 'termosAditivos', 'aditivos', 'alteracoes', 'historico') ?? [];
  if (!Array.isArray(bruto)) return [];
  return bruto
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((a, idx) => ({
      numero: pickStr(a, 'numeroAditivo', 'numero', 'sequencial') || String(idx + 1),
      tipo: pickStr(a, 'tipoTermoContrato', 'tipo', 'tipoAditivo', 'natureza'),
      valor: parseValorBR(
        pick(a, 'valorAcrescido', 'valorAditivo', 'valor', 'valorAcrescimo'),
      ),
      novaVigenciaFim: parseDataISO(
        pick(a, 'novaDataVigenciaFim', 'dataVigenciaFim', 'novaVigenciaFim'),
      ),
      data: parseDataISO(pick(a, 'dataAssinatura', 'data', 'dataPublicacao')),
    }));
}

/** Normaliza um registro cru de contrato do PNCP para `ContratoPNCP`. */
export function normalizarContratoPNCP(
  rec: Record<string, unknown>,
  idx: number,
): ContratoPNCP {
  const orgaoObj = (pick(rec, 'orgaoEntidade', 'orgao') ?? {}) as Record<
    string,
    unknown
  >;
  const modalidadeObj = pick(rec, 'tipoContrato', 'modalidade');
  const modalidade =
    typeof modalidadeObj === 'object' && modalidadeObj
      ? pickStr(modalidadeObj as Record<string, unknown>, 'nome', 'descricao')
      : pickStr(rec, 'modalidadeNome', 'modalidadeContratacaoNome', 'modalidade');

  const valorInicial = parseValorBR(pick(rec, 'valorInicial', 'valorContrato'));
  const valorGlobal =
    parseValorBR(
      pick(rec, 'valorGlobal', 'valorAtualizado', 'valorAcumulado'),
    ) || valorInicial;

  return {
    id: String(
      pick(
        rec,
        'numeroControlePncpCompra',
        'numeroControlePNCP',
        'numeroControlePncp',
        'id',
      ) ?? `contrato-pncp-${idx}`,
    ),
    numeroContrato: pickStr(rec, 'numeroContratoEmpenho', 'numeroContrato'),
    objeto: pickStr(rec, 'objetoContrato', 'objeto'),
    fornecedorNome: pickStr(
      rec,
      'nomeRazaoSocialFornecedor',
      'nomeFornecedor',
      'razaoSocialFornecedor',
    ),
    fornecedorDoc: soDigitos(pick(rec, 'niFornecedor', 'cnpjCpfFornecedor')),
    valorInicial,
    valorGlobal,
    dataAssinatura: parseDataISO(pick(rec, 'dataAssinatura')),
    dataVigenciaInicio: parseDataISO(
      pick(rec, 'dataVigenciaInicio', 'vigenciaInicio'),
    ),
    dataVigenciaFim: parseDataISO(pick(rec, 'dataVigenciaFim', 'vigenciaFim')),
    aditivos: extrairAditivos(rec),
    modalidade,
    orgaoNome: String(
      pick(orgaoObj, 'razaoSocial', 'nome') ?? pickStr(rec, 'orgaoNome'),
    ),
  };
}

export interface ColetaContratosPNCP {
  contratos: ContratoPNCP[];
  /** CNPJ do órgão usado na consulta (vazio se não configurado). */
  cnpjOrgao: string;
  coleta: {
    registros: number;
    totalPaginas: number;
    /** Mensagem de erro honesta do upstream, ou null se a coleta funcionou. */
    erro: string | null;
    /** true quando o CNPJ da Prefeitura não está configurado em constants. */
    cnpjAusente: boolean;
  };
}

/**
 * Coleta os contratos da Prefeitura de Marília no PNCP para o exercício
 * informado, varrendo todas as páginas e normalizando cada registro.
 *
 * Degrada graciosamente:
 *  - sem CNPJ configurado → `cnpjAusente: true`, lista vazia, sem fetch;
 *  - upstream indisponível (403 geo-bloqueio, timeout, 5xx) → `erro` preenchido,
 *    lista vazia. NUNCA mascara falha como "nenhum contrato".
 */
export async function coletarContratosPNCP(
  exercicio: number,
  opts: { cnpjOrgao?: string; maxPaginas?: number; delayMs?: number } = {},
): Promise<ColetaContratosPNCP> {
  const cnpjConfigurado = (MARILIA as { cnpjPrefeitura?: string })
    .cnpjPrefeitura;
  const cnpjOrgao = soDigitos(opts.cnpjOrgao ?? cnpjConfigurado ?? '');

  // Degradação honesta: sem CNPJ não há o que consultar.
  if (cnpjOrgao.length !== 14) {
    return {
      contratos: [],
      cnpjOrgao,
      coleta: {
        registros: 0,
        totalPaginas: 0,
        erro: null,
        cnpjAusente: true,
      },
    };
  }

  const { maxPaginas = 20, delayMs = 150 } = opts;

  try {
    const { contratos: brutos, totalPaginas } = await getContratosAllPages(
      {
        cnpjOrgao,
        dataInicial: `${exercicio}0101`,
        dataFinal: `${exercicio}1231`,
      },
      { maxPaginas, delayMs },
    );
    const contratos = brutos.map((rec, idx) => normalizarContratoPNCP(rec, idx));
    return {
      contratos,
      cnpjOrgao,
      coleta: {
        registros: contratos.length,
        totalPaginas,
        erro: null,
        cnpjAusente: false,
      },
    };
  } catch (err) {
    return {
      contratos: [],
      cnpjOrgao,
      coleta: {
        registros: 0,
        totalPaginas: 0,
        erro: err instanceof Error ? err.message : 'erro desconhecido',
        cnpjAusente: false,
      },
    };
  }
}
