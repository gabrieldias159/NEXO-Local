/**
 * Client da API de Dados Abertos da Prefeitura de Marília.
 *
 * GET {portal}/dados-abertos/{categoria}/{ano} → JSON `{ dados: [...] }`.
 * Sem autenticação. Uso server-side. Categorias confirmadas: contratos,
 * licitacoes, obras, legislacao, diario-oficial (texto integral), compra-direta.
 *
 * Fonte de contratos/licitações/obras com NOME da contratada e nº de processo —
 * casa com PNCP/TCE/DespesaAgrupada por `numeroProcesso`.
 */
import { FONTES } from '../constants';

const BASE = FONTES.portalPrefeitura;
const TIMEOUT_MS = 20_000;
const HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    // Aceita "1.234,56" (pt-BR) ou "1234.56".
    const s = v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v;
    const n = Number(s.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/** GET genérico de uma categoria de dados abertos. Lista vazia em erro/sem dado. */
async function getCategoria(
  categoria: string,
  ano: number,
): Promise<Record<string, unknown>[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/dados-abertos/${categoria}/${ano}`, {
      signal: ctrl.signal,
      headers: HEADERS,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Dados Abertos ${categoria} HTTP ${res.status}`);
    const json = (await res.json()) as { dados?: unknown };
    const dados = Array.isArray(json.dados) ? json.dados : [];
    // Sentinela de "vazio": [["Nenhum registro encontrado."]].
    if (dados.length === 1 && Array.isArray(dados[0])) return [];
    return dados.filter(
      (d): d is Record<string, unknown> => !!d && typeof d === 'object' && !Array.isArray(d),
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Dados Abertos ${categoria} — timeout após ${TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface ContratoMunicipal {
  numeroContrato: string;
  numeroProcesso: string;
  contratada: string;
  tipo: string;
  tipoLicitacao: string;
  situacao: string;
  valor: number;
  dataAssinatura: string | null;
  inicioVigencia: string | null;
  fimVigencia: string | null;
}

export async function getContratos(ano: number): Promise<ContratoMunicipal[]> {
  const dados = await getCategoria('contratos', ano);
  return dados.map((d) => ({
    numeroContrato: str(d.numeroContrato),
    numeroProcesso: str(d.numeroProcesso),
    contratada: str(d.nomeContratada),
    tipo: str(d.tipo),
    tipoLicitacao: str(d.tipoLicitacao),
    situacao: str(d.situacao),
    valor: toNum(d.valorContrato),
    dataAssinatura: d.dataAssinatura ? str(d.dataAssinatura) : null,
    inicioVigencia: d.dataInicioVigencia ? str(d.dataInicioVigencia) : null,
    fimVigencia: d.dataFimVigencia ? str(d.dataFimVigencia) : null,
  }));
}

export interface LicitacaoMunicipal {
  titulo: string;
  numeroEdital: string;
  numeroProcesso: string;
  modalidade: string;
  situacao: string;
  descricao: string;
}

export async function getLicitacoes(ano: number): Promise<LicitacaoMunicipal[]> {
  const dados = await getCategoria('licitacoes', ano);
  return dados.map((d) => ({
    titulo: str(d.titulo),
    numeroEdital: str(d.numeroEdital),
    numeroProcesso: str(d.numeroProcesso),
    modalidade: str(d.modalidade),
    situacao: str(d.situacao),
    descricao: str(d.descricao),
  }));
}

export interface ObraMunicipal {
  titulo: string;
  categoria: string;
  situacao: string;
  valor: number;
  inicio: string | null;
  fim: string | null;
  descricao: string;
}

export async function getObras(ano: number): Promise<ObraMunicipal[]> {
  const dados = await getCategoria('obras', ano);
  return dados.map((d) => ({
    titulo: str(d.titulo),
    categoria: str(d.categoria),
    situacao: str(d.situacao),
    valor: toNum(d.valor),
    inicio: d.dataExecucaoInicio ? str(d.dataExecucaoInicio) : null,
    fim: d.dataExecucaoFim ? str(d.dataExecucaoFim) : null,
    descricao: str(d.descricao),
  }));
}

export interface LegislacaoMunicipal {
  numero: string;
  ementa: string;
  categoria: string;
  situacao: string;
  descricao: string;
}

export async function getLegislacao(ano: number): Promise<LegislacaoMunicipal[]> {
  const dados = await getCategoria('legislacao', ano);
  return dados.map((d) => ({
    numero: str(d.numero),
    ementa: str(d.ementa),
    categoria: str(d.categoria),
    situacao: str(d.situacao),
    descricao: str(d.descricao),
  }));
}

export interface EdicaoDiarioMunicipal {
  edicao: string;
  data: string;
  extra: boolean;
  /** Texto integral da edição (HTML/texto). */
  texto: string;
}

export async function getDiarioOficial(ano: number): Promise<EdicaoDiarioMunicipal[]> {
  const dados = await getCategoria('diario-oficial', ano);
  return dados.map((d) => ({
    edicao: str(d.edicao),
    data: str(d.data),
    extra: d.edicaoExtra === true || str(d.edicaoExtra).toLowerCase() === 'true',
    texto: str(d.descricao),
  }));
}
