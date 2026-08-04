/**
 * GET /api/nexo/emendas — EMENDAS PARLAMENTARES IMPOSITIVAS de Marília.
 *
 * Lista as emendas impositivas municipais por exercício (2023–2026) com AUTORIA
 * (vereador + partido), VETO e o CICLO DE EXECUÇÃO de cada uma: empenhado →
 * liquidado → pago, status derivado e eventual atraso de exercício.
 *
 * ── FONTE (dataset consolidado, versionado no repo) ──────────────────────────
 * Lê `src/data/nexo/emendas-impositivas.json`, que cruza DUAS fontes públicas:
 *   • AUTORIA + VETO  → SAGL da Câmara de Marília (emendas da matéria da LOA).
 *   • EXECUÇÃO        → Portal da Transparência de Marília (SMARAPD).
 * O link emenda↔empenho é por beneficiário + valor exato + janela de exercício
 * (ano..ano+2) — por isso emendas pagas em parcelas / múltiplos empenhos podem
 * aparecer como `SEM_EMPENHO` (ver `_meta.ressalva`). NÃO há mais leitura do
 * Firestore aqui: a autoria por vereador DEIXOU de ser data-blocked.
 *
 * ── Filtros (todos opcionais, combináveis) ───────────────────────────────────
 *  • exercicio  → 2023..2026 (default: corrente).
 *  • q          → busca por beneficiário / autor / finalidade (sem acento/caixa).
 *  • autor      → substring do vereador autor.
 *  • execucao / status → 'pago' | 'liquidado' | 'empenhado' | 'vetada' |
 *                 'sem_empenho' | 'retirada', ou o enum cru (PAGA, …).
 *  • valorMin/valorMax → faixa do valor proposto da emenda.
 *  • ordenarPor → 'valor' (default, desc) | 'numero' | 'autor'; dir → 'desc'|'asc'.
 *
 * Resposta: itens paginados + agregados do recorte + ranking por BENEFICIÁRIO e
 * por AUTOR (vereador) + veto do ano + meta da LOA. Gated por `verificarSessao`.
 * Cache server-side por ano (normalização 1×). Runtime node. Indício, não acusação.
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import datasetRaw from '@/data/nexo/emendas-impositivas.json';

export const runtime = 'nodejs';

const TAMANHO_PADRAO = 50;
const TAMANHO_MAX = 200;
const headersCache = { 'Cache-Control': 'private, max-age=60' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

/** Estado de execução de uma emenda (enum da fonte). */
export type ExecucaoEmenda =
  | 'PAGA'
  | 'PAGA_PARCIAL'
  | 'LIQUIDADA_NAO_PAGA'
  | 'EMPENHADA_NAO_LIQ'
  | 'SEM_EMPENHO'
  | 'VETADA'
  | 'RETIRADA';

/**
 * Status derivado do ciclo de execução (compat com a assinatura antiga: a coluna
 * de status da página usa `execucao`, mais rica).
 * @deprecated preferir `ExecucaoEmenda` / campo `execucao`.
 */
export type StatusEmenda = 'pago' | 'liquidado' | 'empenhado';

/** Uma emenda parlamentar impositiva com autoria, veto e ciclo de execução. */
export interface EmendaItem {
  /** Identidade estável: `${anoOrcamento}-${numero}`. */
  id: string;
  /** Nº da emenda dentro do exercício. */
  numero: number;
  /** Exercício do orçamento a que a emenda pertence. */
  anoOrcamento: number;
  /** Vereador autor (como consta no SAGL; pode conter o sufixo do partido). */
  autor: string;
  /** Sigla do partido do autor ('' quando não identificado — ex.: Mesa). */
  partido: string;
  /** Beneficiário / destino do recurso. */
  beneficiario: string;
  /** Finalidade declarada ('' quando a fonte não separa da descrição). */
  finalidade: string;
  /** Valor proposto/destinado pela emenda (0 quando não monetária). */
  valor: number;
  /** Status legislativo cru (APROVADA, VETADA, RETIRADA PELO AUTOR, …). */
  statusEmenda: string;
  /** Detalhe legislativo do status (texto para tooltip). */
  statusDetalhe: string;
  /** true quando a emenda foi vetada (execucao === 'VETADA'). */
  vetada: boolean;
  /** Estado de execução derivado. */
  execucao: ExecucaoEmenda;

  // ── Empenho (achatado; null/0 quando não houve empenho no acervo) ───────────
  /** Nº do empenho que executou a emenda, ou null. */
  numeroEmpenho: string | null;
  /** Exercício em que o empenho foi emitido (pode ser > anoOrcamento). */
  exercEmpenho: number | null;
  /** Data do empenho no formato cru "dd/MM/yyyy HH:mm", ou null. */
  dataEmpenho: string | null;
  /** Data da liquidação no formato cru "dd/MM/yyyy HH:mm", ou null. */
  dataLiquidacao: string | null;
  /** Valor empenhado. */
  valorEmpenhado: number;
  /** Valor liquidado. */
  valorLiquidado: number;
  /** Valor pago. */
  valorPago: number;
  /** Vínculo/fonte orçamentária do empenho, ou null. */
  vinculo: string | null;
  /** CNPJ/CPF do beneficiário do empenho (formatado), ou null. */
  cnpj: string | null;
  /** URL externa do empenho no Portal da Transparência, ou null. */
  linkEmpenho: string | null;
  /** URL externa da liquidação no Portal da Transparência, ou null. */
  linkLiquidacao: string | null;
  /** Anos entre o exercício da emenda e o do empenho (>0 = executada atrasada). */
  atrasoAnos: number | null;
  /** URL do PDF da emenda no SAPL/SAGL da Câmara. */
  urlEmenda: string;
}

/** Linha do ranking por beneficiário (destino × pago). */
export interface RankingDestinatario {
  beneficiario: string;
  /** CNPJ/CPF do beneficiário (formatado), quando algum empenho o traz. */
  cnpj: string | null;
  /** Quantidade de emendas para este beneficiário. */
  qtd: number;
  /** Soma do valor proposto. */
  valorProposto: number;
  /** Soma do valor pago. */
  valorPago: number;
  /** % pago sobre o proposto (0–100+). */
  pctPago: number;
}

/** Linha do ranking por autor (vereador) — concentração do recurso. */
export interface RankingAutor {
  autor: string;
  partido: string;
  /** Quantidade de emendas do autor. */
  qtd: number;
  /** Soma do valor proposto pelo autor. */
  valorProposto: number;
  /** Soma do valor efetivamente pago. */
  valorPago: number;
  /** Quantas emendas do autor foram vetadas. */
  vetadas: number;
  /** % pago sobre o proposto (0–100+). */
  pctPago: number;
}

export interface EmendasAgregados {
  count: number;
  /** Soma do valor proposto (destinado) no recorte. */
  valorProposto: number;
  valorEmpenhado: number;
  valorLiquidado: number;
  valorPago: number;
  /** PAGA + PAGA_PARCIAL. */
  pagas: number;
  vetadas: number;
  retiradas: number;
  /** SEM_EMPENHO (sem empenho localizado no exercício). */
  semEmpenho: number;
  liquidadasNaoPagas: number;
  empenhadasNaoLiq: number;
}

/** Veto do exercício (itemizado), ou null quando não há veto identificável. */
export interface VetoAno {
  /** Matéria do veto no SAGL (ex.: "Veto 5/2023"). */
  materia: string;
  codMateria: number | null;
  /** Disposição/desfecho do veto (aprovado, mantido, …). */
  disposicao: string | null;
  /** Números das emendas vetadas. */
  emendasVetadas: number[];
  /** Nota explicativa do veto. */
  nota: string;
}

/** Metadados da LOA do exercício. */
export interface LoaMeta {
  anoOrcamento: number;
  orcamento: number;
  loaPl: string;
  lei: string;
  ementa: string;
}

/** Proveniência do dataset. */
export interface FonteMeta {
  fonteEmendas: string;
  fonteExecucao: string;
  metodoLink: string;
  ressalva: string;
  geradoEm: string;
}

export interface EmendasResponse {
  exercicio: number;
  total: number;
  pagina: number;
  tamanho: number;
  itens: EmendaItem[];
  agregados: EmendasAgregados;
  /** Ranking por beneficiário (recorte, desc por valor proposto). */
  ranking: RankingDestinatario[];
  /** Ranking por autor/vereador (recorte, desc por valor proposto). */
  rankingAutor: RankingAutor[];
  /** Veto do exercício, ou null. */
  veto: VetoAno | null;
  /** Metadados da LOA do exercício. */
  loa: LoaMeta | null;
  /** Proveniência do dataset. */
  fonte: FonteMeta;
  /** Autoria por vereador agora disponível (via SAGL). */
  autoria: 'ok';
  /** Todos os exercícios têm dado; mantido por compat. */
  ingestao: { status: 'ok' };
  atualizadoEm: string;
}

// ── Tipos internos da fonte (JSON versionado) ────────────────────────────────

interface FonteEmpenho {
  numero: string;
  exercicio: number;
  data_empenho: string;
  data_liquidacao: string;
  valor_empenhado: number;
  valor_liquidado: number;
  valor_pago: number;
  vinculo: string;
  cnpj: string;
  link_empenho: string;
  link_liquidacao: string;
  atraso_anos: number;
}

interface FonteEmenda {
  numero: number;
  autor: string;
  partido: string | null;
  beneficiario: string;
  finalidade: string | null;
  valor: number | null;
  status_emenda: string;
  status_detalhe: string;
  vetada: boolean;
  execucao: ExecucaoEmenda;
  empenho: FonteEmpenho | null;
  url_emenda: string;
}

interface FonteVeto {
  veto_materia: string | null;
  veto_cod_materia: number | null;
  disposicao_veto: string | null;
  emendas_vetadas: number[];
  nota_veto: string;
}

interface FonteAno {
  orcamento: number;
  loa_pl: string;
  lei: string;
  ementa_loa: string;
  veto: FonteVeto | null;
  emendas: FonteEmenda[];
}

interface FonteDataset {
  _meta: {
    gerado_em: string;
    fonte_emendas: string;
    fonte_execucao: string;
    metodo_link: string;
    ressalva: string;
  };
  anos: Record<string, FonteAno>;
}

// Cast único: evita o TS comparar estruturalmente o literal gigante do JSON.
const dataset = datasetRaw as unknown as FonteDataset;

const ANOS_DISPONIVEIS = Object.keys(dataset.anos)
  .map(Number)
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);

// ── Normalização (achatamento) com cache por ano ─────────────────────────────

const cacheAno = new Map<number, EmendaItem[]>();

function normalizarAno(ano: number): EmendaItem[] {
  const memo = cacheAno.get(ano);
  if (memo) return memo;

  const fonte = dataset.anos[String(ano)];
  const itens: EmendaItem[] = (fonte?.emendas ?? []).map((e) => {
    const emp = e.empenho;
    return {
      id: `${ano}-${e.numero}`,
      numero: e.numero,
      anoOrcamento: ano,
      autor: e.autor ?? '',
      partido: e.partido ?? '',
      beneficiario: e.beneficiario ?? '',
      finalidade: e.finalidade ?? '',
      valor: e.valor ?? 0,
      statusEmenda: e.status_emenda ?? '',
      statusDetalhe: e.status_detalhe ?? '',
      vetada: !!e.vetada,
      execucao: e.execucao,
      numeroEmpenho: emp?.numero ?? null,
      exercEmpenho: emp?.exercicio ?? null,
      dataEmpenho: emp?.data_empenho ?? null,
      dataLiquidacao: emp?.data_liquidacao ?? null,
      valorEmpenhado: emp?.valor_empenhado ?? 0,
      valorLiquidado: emp?.valor_liquidado ?? 0,
      valorPago: emp?.valor_pago ?? 0,
      vinculo: emp?.vinculo ?? null,
      cnpj: emp?.cnpj ?? null,
      linkEmpenho: emp?.link_empenho ?? null,
      linkLiquidacao: emp?.link_liquidacao ?? null,
      atrasoAnos: emp?.atraso_anos ?? null,
      urlEmenda: e.url_emenda ?? '',
    };
  });

  cacheAno.set(ano, itens);
  return itens;
}

function mapVeto(v: FonteVeto | null | undefined): VetoAno | null {
  // Só materializa quando há veto identificável (matéria no SAGL). O veto parcial
  // de 2023 não é itemizável pela fonte (ver `_meta.ressalva`) → null.
  if (!v || !v.veto_materia) return null;
  return {
    materia: v.veto_materia,
    codMateria: v.veto_cod_materia ?? null,
    disposicao: v.disposicao_veto ?? null,
    emendasVetadas: Array.isArray(v.emendas_vetadas) ? v.emendas_vetadas : [],
    nota: v.nota_veto ?? '',
  };
}

// ── Filtro de execução: aceita apelidos amigáveis e o enum cru ───────────────

const ALIAS_EXEC: Record<string, ExecucaoEmenda[]> = {
  pago: ['PAGA', 'PAGA_PARCIAL'],
  paga: ['PAGA', 'PAGA_PARCIAL'],
  liquidado: ['LIQUIDADA_NAO_PAGA'],
  liquidada: ['LIQUIDADA_NAO_PAGA'],
  empenhado: ['EMPENHADA_NAO_LIQ'],
  empenhada: ['EMPENHADA_NAO_LIQ'],
  vetada: ['VETADA'],
  veto: ['VETADA'],
  sem_empenho: ['SEM_EMPENHO'],
  retirada: ['RETIRADA'],
};

const EXEC_VALIDAS = new Set<ExecucaoEmenda>([
  'PAGA',
  'PAGA_PARCIAL',
  'LIQUIDADA_NAO_PAGA',
  'EMPENHADA_NAO_LIQ',
  'SEM_EMPENHO',
  'VETADA',
  'RETIRADA',
]);

function filtroExecucao(param: string): Set<ExecucaoEmenda> | null {
  const p = param.trim().toLowerCase();
  if (!p || p === 'todas' || p === 'todos') return null;
  if (ALIAS_EXEC[p]) return new Set(ALIAS_EXEC[p]);
  const up = param.trim().toUpperCase() as ExecucaoEmenda;
  if (EXEC_VALIDAS.has(up)) return new Set([up]);
  return null;
}

/** lowercase + sem acento + colapsa espaços — busca tolerante. */
function norm(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function num(v: string | null): number | null {
  if (v == null || v.trim() === '') return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function agregar(itens: EmendaItem[]): EmendasAgregados {
  const a: EmendasAgregados = {
    count: itens.length,
    valorProposto: 0,
    valorEmpenhado: 0,
    valorLiquidado: 0,
    valorPago: 0,
    pagas: 0,
    vetadas: 0,
    retiradas: 0,
    semEmpenho: 0,
    liquidadasNaoPagas: 0,
    empenhadasNaoLiq: 0,
  };
  for (const e of itens) {
    a.valorProposto += e.valor;
    a.valorEmpenhado += e.valorEmpenhado;
    a.valorLiquidado += e.valorLiquidado;
    a.valorPago += e.valorPago;
    switch (e.execucao) {
      case 'PAGA':
      case 'PAGA_PARCIAL':
        a.pagas += 1;
        break;
      case 'VETADA':
        a.vetadas += 1;
        break;
      case 'RETIRADA':
        a.retiradas += 1;
        break;
      case 'SEM_EMPENHO':
        a.semEmpenho += 1;
        break;
      case 'LIQUIDADA_NAO_PAGA':
        a.liquidadasNaoPagas += 1;
        break;
      case 'EMPENHADA_NAO_LIQ':
        a.empenhadasNaoLiq += 1;
        break;
    }
  }
  return a;
}

function pct(pago: number, base: number): number {
  return base > 0 ? Math.round((pago / base) * 1000) / 10 : 0;
}

function montarRankingDestinatario(itens: EmendaItem[]): RankingDestinatario[] {
  const por = new Map<string, RankingDestinatario>();
  for (const e of itens) {
    const chave = e.beneficiario || '(sem beneficiário)';
    const acc =
      por.get(chave) ??
      { beneficiario: chave, cnpj: null, qtd: 0, valorProposto: 0, valorPago: 0, pctPago: 0 };
    acc.qtd += 1;
    acc.valorProposto += e.valor;
    acc.valorPago += e.valorPago;
    if (!acc.cnpj && e.cnpj) acc.cnpj = e.cnpj;
    por.set(chave, acc);
  }
  const lista = [...por.values()];
  for (const r of lista) r.pctPago = pct(r.valorPago, r.valorProposto);
  return lista.sort(
    (a, b) =>
      b.valorProposto - a.valorProposto ||
      b.valorPago - a.valorPago ||
      a.beneficiario.localeCompare(b.beneficiario, 'pt-BR'),
  );
}

function montarRankingAutor(itens: EmendaItem[]): RankingAutor[] {
  const por = new Map<string, RankingAutor>();
  for (const e of itens) {
    const chave = e.autor || '(sem autor)';
    const acc =
      por.get(chave) ??
      { autor: chave, partido: e.partido, qtd: 0, valorProposto: 0, valorPago: 0, vetadas: 0, pctPago: 0 };
    acc.qtd += 1;
    acc.valorProposto += e.valor;
    acc.valorPago += e.valorPago;
    if (e.vetada) acc.vetadas += 1;
    if (!acc.partido && e.partido) acc.partido = e.partido;
    por.set(chave, acc);
  }
  const lista = [...por.values()];
  for (const r of lista) r.pctPago = pct(r.valorPago, r.valorProposto);
  return lista.sort(
    (a, b) =>
      b.valorProposto - a.valorProposto ||
      b.qtd - a.qtd ||
      a.autor.localeCompare(b.autor, 'pt-BR'),
  );
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: headersNoStore },
    );
  }

  const { searchParams } = new URL(req.url);
  let exercicio = Math.trunc(Number(searchParams.get('exercicio'))) || new Date().getFullYear();
  // Se o exercício pedido não existe no dataset, cai no mais recente disponível.
  if (!dataset.anos[String(exercicio)] && ANOS_DISPONIVEIS.length > 0) {
    exercicio = ANOS_DISPONIVEIS[ANOS_DISPONIVEIS.length - 1];
  }

  const q = (searchParams.get('q') ?? '').trim();
  const autorQ = (searchParams.get('autor') ?? '').trim();
  const execParam = (searchParams.get('execucao') ?? searchParams.get('status') ?? '').trim();
  const valorMin = num(searchParams.get('valorMin'));
  const valorMax = num(searchParams.get('valorMax'));
  const ordParam = searchParams.get('ordenarPor');
  const ordenarPor: 'valor' | 'numero' | 'autor' =
    ordParam === 'numero' ? 'numero' : ordParam === 'autor' ? 'autor' : 'valor';
  const dir = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  const tamanho = Math.min(
    TAMANHO_MAX,
    Math.max(1, Math.trunc(Number(searchParams.get('tamanho'))) || TAMANHO_PADRAO),
  );
  const pagina = Math.max(0, Math.trunc(Number(searchParams.get('pagina'))) || 0);

  const fonteAno = dataset.anos[String(exercicio)];
  const base = normalizarAno(exercicio);

  // ── Filtra em memória ──────────────────────────────────────────────────────
  const termo = norm(q);
  const termoAutor = norm(autorQ);
  const execSet = filtroExecucao(execParam);
  const itensFiltrados = base.filter((e) => {
    if (termo) {
      const alvo = norm(`${e.beneficiario} ${e.autor} ${e.finalidade}`);
      if (!alvo.includes(termo)) return false;
    }
    if (termoAutor && !norm(e.autor).includes(termoAutor)) return false;
    if (execSet && !execSet.has(e.execucao)) return false;
    if (valorMin != null && e.valor < valorMin) return false;
    if (valorMax != null && e.valor > valorMax) return false;
    return true;
  });

  const agregados = agregar(itensFiltrados);
  const ranking = montarRankingDestinatario(itensFiltrados);
  const rankingAutor = montarRankingAutor(itensFiltrados);

  // ── Ordena (estável: desempate determinístico por número) ──────────────────
  const sinal = dir === 'asc' ? 1 : -1;
  const ordenados = [...itensFiltrados].sort((a, b) => {
    let d = 0;
    if (ordenarPor === 'valor') d = a.valor - b.valor;
    else if (ordenarPor === 'numero') d = a.numero - b.numero;
    else d = a.autor.localeCompare(b.autor, 'pt-BR');
    if (d !== 0) return sinal * d;
    return a.numero - b.numero;
  });

  const total = ordenados.length;
  const offset = pagina * tamanho;
  const itens = ordenados.slice(offset, offset + tamanho);

  const resposta: EmendasResponse = {
    exercicio,
    total,
    pagina,
    tamanho,
    itens,
    agregados,
    ranking: ranking.slice(0, 60),
    rankingAutor: rankingAutor.slice(0, 60),
    veto: mapVeto(fonteAno?.veto),
    loa: fonteAno
      ? {
          anoOrcamento: exercicio,
          orcamento: fonteAno.orcamento,
          loaPl: fonteAno.loa_pl,
          lei: fonteAno.lei,
          ementa: fonteAno.ementa_loa,
        }
      : null,
    fonte: {
      fonteEmendas: dataset._meta.fonte_emendas,
      fonteExecucao: dataset._meta.fonte_execucao,
      metodoLink: dataset._meta.metodo_link,
      ressalva: dataset._meta.ressalva,
      geradoEm: dataset._meta.gerado_em,
    },
    autoria: 'ok',
    ingestao: { status: 'ok' },
    atualizadoEm: dataset._meta.gerado_em,
  };
  return NextResponse.json(resposta, { headers: headersCache });
}
