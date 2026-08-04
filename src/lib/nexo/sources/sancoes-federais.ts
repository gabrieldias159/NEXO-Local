/**
 * Conector dos CADASTROS FEDERAIS DE INIDÔNEOS — NEXO.
 *
 * Consulta a API do Portal da Transparência Federal (CGU) nos três cadastros
 * de sanção que tornam uma empresa inidônea/suspensa para contratar com o
 * poder público:
 *  - CEIS  — Cadastro de Empresas Inidôneas e Suspensas;
 *  - CNEP  — Cadastro Nacional de Empresas Punidas (Lei Anticorrupção);
 *  - CEPIM — Cadastro de Entidades Privadas Sem Fins Lucrativos Impedidas.
 *
 * USO SERVER-SIDE APENAS. Dois motivos:
 *  1. A API exige o header `chave-api-dados` com um token sigiloso — ele NÃO
 *     pode ir para o browser.
 *  2. O browser bloquearia por CORS.
 * Chamar sempre de API routes (`/api/nexo/*`) ou Cloud Functions.
 *
 * ESCOPO: as sanções federais são nacionais, mas neste módulo o uso é SEMPRE
 * cruzar com os fornecedores da Prefeitura Municipal de Marília/SP — dado um
 * CNPJ que contratou com a Prefeitura, verificar se está sancionado. Nenhuma
 * outra finalidade.
 *
 * TOKEN: lido de `process.env.PORTAL_TRANSPARENCIA_TOKEN` (gratuito, obtido
 * em portaldatransparencia.gov.br/api-de-dados/cadastrar-email com login
 * gov.br). Se a variável estiver ausente/vazia, o conector NÃO crasha —
 * devolve um estado honesto `tokenConfigurado: false`.
 *
 * Apenas dados públicos — toda sanção é fato cadastral oficial; o uso analítico
 * é sempre indício a apurar, nunca acusação.
 */
import { soDigitos } from '../normalizar';

const BASE = 'https://api.portaldatransparencia.gov.br/api-de-dados';
const TIMEOUT_MS = 25_000;
/** Pausa suave entre chamadas de lote — respeita o rate-limit da API CGU. */
const DELAY_LOTE_MS = 350;
/** Teto de páginas por cadastro/CNPJ — uma empresa raramente tem tantas. */
const MAX_PAGINAS = 10;

// ── Tipos ────────────────────────────────────────────────────────────────────

/**
 * Cadastros de inidôneos reusados pelo tipo `SancaoFederal`. Os três federais
 * (CEIS/CNEP/CEPIM) vêm da CGU; `TCE-SP-APENADOS` é a Relação de Apenados do
 * TCE-SP (estadual), reusa o MESMO formato via `sancoes-estaduais-det.ts`
 * (detector FR-04E). Widening retrocompatível: o conector federal nunca produz
 * o valor estadual, e nenhum `switch` exaustivo depende deste union.
 */
export type CadastroFederal = 'CEIS' | 'CNEP' | 'CEPIM' | 'TCE-SP-APENADOS';

/** Uma sanção federal normalizada — formato único para os três cadastros. */
export interface SancaoFederal {
  /** Cadastro de origem do registro. */
  cadastro: CadastroFederal;
  /** CNPJ/CPF do sancionado — apenas dígitos. */
  cnpjSancionado: string;
  /** Razão social / nome do sancionado. */
  nomeSancionado: string;
  /** Tipo da sanção (ex.: "Inidoneidade", "Suspensão", "Multa"). */
  tipoSancao: string;
  /** Início da vigência da sanção em ISO `yyyy-MM-dd`, ou null. */
  dataInicio: string | null;
  /** Fim da vigência da sanção em ISO `yyyy-MM-dd`, ou null (sem prazo). */
  dataFim: string | null;
  /** Órgão/entidade que aplicou a sanção. */
  orgaoSancionador: string;
  /** Fundamentação legal da sanção, conforme o cadastro. */
  fundamentacao: string;
}

/** Resultado da consulta de UM CNPJ contra os três cadastros. */
export interface ConsultaSancaoCnpj {
  /** CNPJ consultado — apenas dígitos. */
  cnpj: string;
  /** Sanções encontradas (de qualquer cadastro). */
  sancoes: SancaoFederal[];
  /** false quando `PORTAL_TRANSPARENCIA_TOKEN` não está configurado. */
  tokenConfigurado: boolean;
  /** Mensagem de erro honesta quando a API falhou (token existe). */
  erro: string | null;
}

/** Resultado agregado da consulta de um lote de CNPJs. */
export interface ConsultaSancaoLote {
  /** false quando o token não está configurado — nenhuma consulta foi feita. */
  tokenConfigurado: boolean;
  /** Resultado por CNPJ. */
  resultados: ConsultaSancaoCnpj[];
  /** Mensagem de erro quando a falha foi global (token ausente, etc.). */
  erro: string | null;
}

// ── Reidratação dos docs de `nexo_sancoes` para o detector ────────────────────

/** Coage um cadastro federal cru ao enum (default conservador 'CEIS'). */
function comoCadastro(v: unknown): CadastroFederal {
  const c = String(v ?? '').toUpperCase();
  return c === 'CNEP' || c === 'CEPIM' ? c : 'CEIS';
}

/** Coage uma sanção JÁ normalizada (gravada em `nexo_sancoes`) a SancaoFederal. */
function coagirSancao(v: unknown): SancaoFederal | null {
  if (v == null || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  return {
    cadastro: comoCadastro(r.cadastro),
    cnpjSancionado: soDigitos(r.cnpjSancionado as string),
    nomeSancionado: String(r.nomeSancionado ?? ''),
    tipoSancao: String(r.tipoSancao ?? ''),
    dataInicio: typeof r.dataInicio === 'string' ? r.dataInicio : null,
    dataFim: typeof r.dataFim === 'string' ? r.dataFim : null,
    orgaoSancionador: String(r.orgaoSancionador ?? ''),
    fundamentacao: String(r.fundamentacao ?? ''),
  };
}

/**
 * Converte os docs CRUS de `nexo_sancoes` (um por CNPJ verificado, com o
 * sub-array `sancoes` já normalizado) em `ConsultaSancaoCnpj[]` para alimentar
 * o detector FR-04 — tanto no pipeline persistido (`/api/nexo/detectar`) quanto
 * na análise ao vivo (`/api/nexo/analise`). Descarta CNPJ inválido (≠14 díg.).
 */
export function consultasDeDocsSancoes(
  docs: Record<string, unknown>[],
): ConsultaSancaoCnpj[] {
  const out: ConsultaSancaoCnpj[] = [];
  for (const d of docs) {
    const cnpj = soDigitos((d.cnpj ?? d._cnpj) as string);
    if (cnpj.length !== 14) continue;
    const sancoes = (Array.isArray(d.sancoes) ? d.sancoes : [])
      .map(coagirSancao)
      .filter((s): s is SancaoFederal => s !== null);
    out.push({ cnpj, sancoes, tokenConfigurado: true, erro: null });
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Lê o token do ambiente. Devolve string vazia se ausente/em branco. */
function lerToken(): string {
  return (process.env.PORTAL_TRANSPARENCIA_TOKEN ?? '').trim();
}

/** true quando o token está configurado — exposto para a rota verificar. */
export function tokenConfigurado(): boolean {
  return lerToken().length > 0;
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
 * Resolve um objeto aninhado a partir de uma raiz e uma lista de nomes
 * possíveis (a API CGU aninha dados em `pessoa`, `orgaoSancionador`, etc.).
 */
function pickObj(
  rec: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | null {
  for (const k of keys) {
    const v = rec[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return null;
}

/** Converte data BR (`dd/MM/yyyy`) ou ISO para `yyyy-MM-dd`, ou null. */
function parseData(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

/** Executa um GET na API CGU com timeout, header de token e cache off. */
async function cguFetch(
  endpoint: string,
  params: Record<string, string | number>,
  token: string,
): Promise<Response> {
  const url = new URL(`${BASE}/${endpoint.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url.toString(), {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        'chave-api-dados': token,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Normalização ─────────────────────────────────────────────────────────────

/**
 * Normaliza um registro cru da API CGU para `SancaoFederal`. A estrutura varia
 * entre cadastros — a leitura é defensiva (tenta vários nomes de campo) e
 * nunca lança em registro malformado.
 */
function normalizarSancao(
  rec: Record<string, unknown>,
  cadastro: CadastroFederal,
): SancaoFederal {
  // O sancionado pode vir achatado ou aninhado em `pessoa` / `sancionado`.
  const pessoa =
    pickObj(rec, 'pessoa', 'sancionado', 'pessoaFisica', 'pessoaJuridica') ?? rec;
  const orgao =
    pickObj(rec, 'orgaoSancionador', 'orgao', 'origem') ?? rec;

  const cnpjBruto = pickStr(
    pessoa,
    'cnpjFormatado',
    'cnpj',
    'codigoFormatado',
    'cpfCnpj',
    'cpfFormatado',
  );
  const cnpjFallback = pickStr(
    rec,
    'cnpjSancionado',
    'codigoSancionado',
    'cnpj',
    'cpfCnpjSancionado',
  );

  return {
    cadastro,
    cnpjSancionado: soDigitos(cnpjBruto || cnpjFallback),
    nomeSancionado:
      pickStr(pessoa, 'nome', 'razaoSocial', 'nomeSancionado') ||
      pickStr(rec, 'nomeSancionado', 'nome', 'razaoSocial'),
    tipoSancao:
      pickStr(rec, 'tipoSancao', 'tipo', 'descricaoResumida', 'categoriaSancao') ||
      cadastro,
    dataInicio: parseData(
      pick(rec, 'dataInicioSancao', 'dataPublicacaoSancao', 'dataInicio', 'dataReferencia'),
    ),
    dataFim: parseData(
      pick(rec, 'dataFimSancao', 'dataFinalSancao', 'dataFim'),
    ),
    orgaoSancionador:
      pickStr(orgao, 'nome', 'razaoSocial', 'orgaoSancionador', 'descricao') ||
      pickStr(rec, 'orgaoSancionador'),
    fundamentacao:
      pickStr(
        rec,
        'fundamentacao',
        'textoPublicacao',
        'descricaoFundamentacao',
        'amparoLegal',
      ) ||
      // CNEP/CEIS às vezes trazem a fundamentação como lista de objetos.
      (() => {
        const lista = rec['fundamentacao'];
        if (Array.isArray(lista)) {
          return lista
            .map((f) =>
              f && typeof f === 'object'
                ? pickStr(f as Record<string, unknown>, 'descricao', 'texto')
                : String(f),
            )
            .filter(Boolean)
            .join('; ');
        }
        return '';
      })(),
  };
}

/**
 * Extrai o array de registros de uma resposta da API CGU. A API às vezes
 * devolve o array diretamente, às vezes embrulhado.
 */
function extrairRegistros(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const k of ['content', 'data', 'registros', 'lista']) {
      if (Array.isArray(obj[k])) return obj[k] as Record<string, unknown>[];
    }
  }
  return [];
}

// ── Consulta de um cadastro ──────────────────────────────────────────────────

/**
 * Varre todas as páginas de UM cadastro (CEIS/CNEP/CEPIM) para UM CNPJ.
 * Lança em erro de API — o chamador agrega e reporta de forma honesta.
 */
async function consultarCadastro(
  endpoint: 'ceis' | 'cnep' | 'cepim',
  cadastro: CadastroFederal,
  cnpj: string,
  token: string,
): Promise<SancaoFederal[]> {
  const out: SancaoFederal[] = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const res = await cguFetch(endpoint, { cnpjSancionado: cnpj, pagina }, token);
    if (res.status === 204) break; // sem conteúdo
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Portal da Transparência rejeitou o token (HTTP ${res.status}) — ` +
          'verifique a variável PORTAL_TRANSPARENCIA_TOKEN',
      );
    }
    if (res.status === 429) {
      throw new Error('Portal da Transparência: limite de requisições atingido (HTTP 429)');
    }
    if (!res.ok) {
      throw new Error(`Portal da Transparência ${endpoint} HTTP ${res.status}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      break; // corpo vazio/não-JSON — fim da paginação
    }
    const registros = extrairRegistros(json);
    if (registros.length === 0) break;
    for (const rec of registros) {
      out.push(normalizarSancao(rec, cadastro));
    }
    // Última página costuma vir com menos de 15 registros (padrão da API).
    if (registros.length < 15) break;
    await new Promise((r) => setTimeout(r, DELAY_LOTE_MS));
  }
  return out;
}

// ── API pública do conector ──────────────────────────────────────────────────

/**
 * Consulta um CNPJ nos três cadastros federais (CEIS, CNEP, CEPIM).
 *
 * NÃO crasha quando o token está ausente — devolve `tokenConfigurado: false`.
 * Quando o token existe mas a API falha, devolve `erro` preenchido (honesto).
 */
export async function consultarSancoesPorCnpj(
  cnpj: string,
): Promise<ConsultaSancaoCnpj> {
  const cnpjLimpo = soDigitos(cnpj);
  const token = lerToken();

  if (!token) {
    return { cnpj: cnpjLimpo, sancoes: [], tokenConfigurado: false, erro: null };
  }
  if (!cnpjLimpo) {
    return {
      cnpj: cnpjLimpo,
      sancoes: [],
      tokenConfigurado: true,
      erro: 'CNPJ vazio ou inválido',
    };
  }

  const alvos: { endpoint: 'ceis' | 'cnep' | 'cepim'; cadastro: CadastroFederal }[] = [
    { endpoint: 'ceis', cadastro: 'CEIS' },
    { endpoint: 'cnep', cadastro: 'CNEP' },
    { endpoint: 'cepim', cadastro: 'CEPIM' },
  ];

  const sancoes: SancaoFederal[] = [];
  for (const [i, alvo] of alvos.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, DELAY_LOTE_MS));
    try {
      sancoes.push(
        ...(await consultarCadastro(alvo.endpoint, alvo.cadastro, cnpjLimpo, token)),
      );
    } catch (err) {
      // Falha num cadastro é erro honesto — não mascarar como "nada encontrado".
      return {
        cnpj: cnpjLimpo,
        sancoes,
        tokenConfigurado: true,
        erro: err instanceof Error ? err.message : 'erro desconhecido',
      };
    }
  }

  return { cnpj: cnpjLimpo, sancoes, tokenConfigurado: true, erro: null };
}

/**
 * Consulta um LOTE de CNPJs nos cadastros federais, em série e com pausa suave
 * entre cada CNPJ (rate-limit da API CGU — ~90 req/min sem autenticação extra).
 *
 * Se o token não estiver configurado, retorna imediatamente
 * `tokenConfigurado: false` sem fazer nenhuma chamada de rede.
 */
export async function consultarSancoesLote(
  cnpjs: string[],
): Promise<ConsultaSancaoLote> {
  if (!tokenConfigurado()) {
    return { tokenConfigurado: false, resultados: [], erro: null };
  }

  // Deduplica preservando a ordem e descartando entradas vazias.
  const unicos = Array.from(
    new Set(cnpjs.map(soDigitos).filter((c) => c.length > 0)),
  );

  const resultados: ConsultaSancaoCnpj[] = [];
  let erro: string | null = null;
  for (const [i, cnpj] of unicos.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, DELAY_LOTE_MS));
    const r = await consultarSancoesPorCnpj(cnpj);
    resultados.push(r);
    // Primeiro erro de API vira o erro global do lote, mas seguimos coletando
    // o que der — a falha de um CNPJ não derruba os demais.
    if (r.erro && !erro) erro = r.erro;
  }

  return { tokenConfigurado: true, resultados, erro };
}
