/**
 * GET /api/nexo/emendas/parcerias — PARCERIAS DE EMENDA PARLAMENTAR (Lei 13.019/2014).
 *
 * Lista os convênios/termos de colaboração com OSCs cuja origem é uma emenda
 * parlamentar municipal — QUALQUER vereador. Complementa `/api/nexo/emendas`
 * (a emenda como peça orçamentária: SAGL + execução SICONFI/SMARAPD) com o
 * lado da PARCERIA CIVIL: entidade beneficiária, CNPJ, objeto e quanto já foi
 * efetivamente PRESTADO em despesas pela OSC (comprovação, não só repasse).
 *
 * Fonte: `nexo_emendas_parcerias`, materializada pelo cron quinzenal
 * `onNexoSyncLei13019` (portal lei13019.com.br, órgão Prefeitura de Marília).
 *
 * Filtros: q (busca livre em entidade/autor/objeto/unidade), autor (substring
 * — mesmo campo que a UI de `/nexo/emendas` já usa, para os dois painéis
 * responderem ao mesmo termo), ano (anoListagem), ordenarPor (valor|pct),
 * dir, pagina, tamanho.
 *
 * Runtime nodejs. Leitura cacheada 5 min (a coleção é pequena e muda devagar).
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';

export const runtime = 'nodejs';

const TAMANHO_PADRAO = 25;
const TAMANHO_MAX = 100;
const headersCache = { 'Cache-Control': 'private, max-age=60' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;
const PORTAL_BASE = 'https://www.lei13019.com.br';

export interface ParceriaItem {
  id: string;
  proposta: string;
  instrumento: string;
  numeroInstrumento: string;
  anoInstrumento: number | null;
  autor: string;
  emendaRaw: string;
  anoListagem: number;
  unidadeGestora: string;
  valor: number;
  vigenciaInicio: string | null;
  vigenciaTermino: string | null;
  entidade: string;
  cnpj: string;
  objeto: string;
  despesasTotal: number;
  despesasCount: number;
  despesasPorSituacao: Record<string, number>;
  pctPrestado: number;
  urlDetalhe: string | null;
}

export interface ParceriasAgregados {
  count: number;
  valorTotal: number;
  despesasTotal: number;
  pctPrestadoGlobal: number;
}

export interface ParceriasResponse {
  total: number;
  pagina: number;
  tamanho: number;
  itens: ParceriaItem[];
  agregados: ParceriasAgregados;
  ingestao: { status: 'ok' | 'pendente' };
  atualizadoEm: string;
}

function norm(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function itemDeDoc(rec: Record<string, unknown>): ParceriaItem {
  const valor = num(rec.valor);
  const despesasTotal = num(rec.despesasTotal);
  const hrefDetalhe = str(rec.hrefDetalhe);
  const porSituacao =
    rec.despesasPorSituacao && typeof rec.despesasPorSituacao === 'object'
      ? (rec.despesasPorSituacao as Record<string, number>)
      : {};
  return {
    id: str(rec._docId) || str(rec.id),
    proposta: str(rec.proposta),
    instrumento: str(rec.instrumento),
    numeroInstrumento: str(rec.numeroInstrumento),
    anoInstrumento: typeof rec.anoInstrumento === 'number' ? rec.anoInstrumento : null,
    autor: str(rec.autor),
    emendaRaw: str(rec.emendaRaw),
    anoListagem: num(rec.anoListagem),
    unidadeGestora: str(rec.unidadeGestora),
    valor,
    vigenciaInicio: typeof rec.vigenciaInicio === 'string' ? rec.vigenciaInicio : null,
    vigenciaTermino: typeof rec.vigenciaTermino === 'string' ? rec.vigenciaTermino : null,
    entidade: str(rec.entidade),
    cnpj: str(rec.cnpj),
    objeto: str(rec.objeto),
    despesasTotal,
    despesasCount: num(rec.despesasCount),
    despesasPorSituacao: porSituacao,
    pctPrestado: valor > 0 ? Math.round((despesasTotal / valor) * 1000) / 10 : 0,
    urlDetalhe: hrefDetalhe ? `${PORTAL_BASE}/${hrefDetalhe}` : null,
  };
}

interface CacheEntrada { itens: ParceriaItem[]; ts: number }
const TTL_MS = 5 * 60 * 1000;
let cache: CacheEntrada | null = null;

async function obterParcerias(idToken: string): Promise<ParceriaItem[]> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.itens;
  // Coleção pequena (~150 docs, muda a cada 15 dias) — lê inteira e filtra em
  // memória, igual ao padrão de `/api/nexo/emendas` sobre o JSON estático.
  const brutos = await lerColecaoNexo('nexo_emendas_parcerias', {}, idToken);
  const itens = brutos.map(itemDeDoc);
  cache = { itens, ts: Date.now() };
  return itens;
}

type OrdenarPor = 'valor' | 'pct' | 'entidade';

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json({ erro: 'acesso negado ao NEXO' }, { status: sessao.status, headers: headersNoStore });
  }
  const idToken = sessao.idToken;
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') ?? '').trim();
  const autorQ = (searchParams.get('autor') ?? '').trim();
  const anoParam = searchParams.get('ano');
  const ano = anoParam ? Math.trunc(Number(anoParam)) : null;
  const ordenarPor = (['valor', 'pct', 'entidade'].includes(searchParams.get('ordenarPor') ?? '')
    ? searchParams.get('ordenarPor')
    : 'valor') as OrdenarPor;
  const dir = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  const tamanho = Math.min(TAMANHO_MAX, Math.max(1, Math.trunc(Number(searchParams.get('tamanho'))) || TAMANHO_PADRAO));
  const pagina = Math.max(0, Math.trunc(Number(searchParams.get('pagina'))) || 0);

  let todas: ParceriaItem[];
  try {
    todas = await obterParcerias(idToken);
  } catch (err) {
    return NextResponse.json(
      { erro: err instanceof Error ? err.message : 'erro ao ler nexo_emendas_parcerias' },
      { status: 502, headers: headersNoStore },
    );
  }

  if (todas.length === 0) {
    const vazio: ParceriasResponse = {
      total: 0, pagina: 0, tamanho, itens: [],
      agregados: { count: 0, valorTotal: 0, despesasTotal: 0, pctPrestadoGlobal: 0 },
      ingestao: { status: 'pendente' }, atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(vazio, { headers: headersCache });
  }

  const termo = norm(q);
  const termoAutor = norm(autorQ);
  const filtradas = todas.filter((p) => {
    if (ano != null && p.anoListagem !== ano) return false;
    if (termoAutor && !norm(p.autor).includes(termoAutor)) return false;
    if (termo) {
      const alvo = norm(`${p.entidade} ${p.autor} ${p.objeto} ${p.unidadeGestora}`);
      if (!alvo.includes(termo)) return false;
    }
    return true;
  });

  const agregados: ParceriasAgregados = {
    count: filtradas.length,
    valorTotal: filtradas.reduce((s, p) => s + p.valor, 0),
    despesasTotal: filtradas.reduce((s, p) => s + p.despesasTotal, 0),
    pctPrestadoGlobal: 0,
  };
  agregados.pctPrestadoGlobal =
    agregados.valorTotal > 0 ? Math.round((agregados.despesasTotal / agregados.valorTotal) * 1000) / 10 : 0;

  const sinal = dir === 'asc' ? 1 : -1;
  const ordenadas = [...filtradas].sort((a, b) => {
    let d = 0;
    if (ordenarPor === 'pct') d = a.pctPrestado - b.pctPrestado;
    else if (ordenarPor === 'entidade') d = a.entidade.localeCompare(b.entidade, 'pt-BR');
    else d = a.valor - b.valor;
    if (d !== 0) return sinal * d;
    return b.valor - a.valor;
  });

  const total = ordenadas.length;
  const offset = pagina * tamanho;
  const itens = ordenadas.slice(offset, offset + tamanho);

  const resposta: ParceriasResponse = {
    total, pagina, tamanho, itens, agregados,
    ingestao: { status: 'ok' }, atualizadoEm: new Date().toISOString(),
  };
  return NextResponse.json(resposta, { headers: headersCache });
}
