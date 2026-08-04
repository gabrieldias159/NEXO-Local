/**
 * GET /api/nexo/risco — PAINEL DE RISCO do NEXO (sala de situação).
 *
 * Lê o RAIO-X consolidado das entidades (`nexo_entidades`, construído pelo cron
 * `onNexoPerfilEntidades`) e devolve um RANKING de fornecedores por POTENCIAL DE
 * RISCO — uma página filtrada/ordenada para a war-room priorizar a apuração.
 *
 * ── O que é "risco" aqui (proxy, NUNCA acusação) ──────────────────────────────
 * Não há juízo de valor: é um realce de INDÍCIO A APURAR. O score combina, em
 * ordem de peso: (1) sancionado pela CGU; (2) nº de flags do perfil
 * (`acima-limite`, `sem-processo`, `doc-invalido`…); (3) volume empenhado. A
 * ordenação default usa esse score; o usuário pode reordenar por
 * totalEmpenhado | nFlags | nVinculos.
 *
 * ── LGPD / qualidade (project_nexo_qualidade_resultados) ──────────────────────
 *  • Mantém SÓ `tipo === 'empresa'` no ranking. Órgãos públicos ('orgao' —
 *    Prefeitura/Câmara/SAAE/IPREMM) ficam de fora (não são fornecedores), e
 *    pessoa física ('pessoa') é minimizada por LGPD: não entra no ranking.
 *  • O CPF nunca trafega aqui (só empresas com CNPJ/raiz). A UI mascara docs.
 *
 * ── Leitura ───────────────────────────────────────────────────────────────────
 * `nexo_entidades` guarda 1 doc por entidade com `_fonte: 'perfil-entidades'` e
 * `_exercicios: [anos]` (ARRAY — não o `_exercicio` escalar das coleções de
 * fato). `lerColecaoNexo` só indexa igualdade em `_exercicio`/`_fonte`/`_cnpj`,
 * então lemos a coleção inteira (filtro vazio — é pequena, 1 doc por entidade)
 * UMA vez, cacheamos ~5 min e filtramos/ordenamos/paginamos em memória. O filtro
 * de exercício (`exercicio` opcional) é aplicado contra o array `_exercicios`.
 *
 * Runtime nodejs. Cache privado (dado gated por sessão de usuário ativo).
 */
import { NextResponse } from 'next/server';
import { lerColecaoNexo, enfileirarRecompute } from '@/lib/nexo/firestore-read';
import {
  avaliarCompute,
  sessaoLeitura,
  lerSnapshotPainel,
} from '@/lib/nexo/compute-guard';

export const runtime = 'nodejs';

const TAMANHO_PADRAO = 50;
const TAMANHO_MAX = 200;
const headersCache = { 'Cache-Control': 'private, max-age=60' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

export type OrdenarRisco = 'risco' | 'totalEmpenhado' | 'nFlags' | 'nVinculos';

/** Item do ranking de risco — projeção enxuta de um doc de `nexo_entidades`. */
export interface FornecedorRisco {
  id: string;
  nome: string;
  /** Doc (CNPJ) já mascarado para exibição — o cru não trafega. */
  doc: string | null;
  /** CNPJ cru (14 díg) — usado SÓ para o entity-chip/deep-link de PJ (dado público). */
  cnpj: string | null;
  totalEmpenhado: number;
  nEmpenhos: number;
  nContratos: number;
  contratosAtivos: number;
  nLicitacoes: number;
  nVinculos: number;
  sancionado: boolean;
  nSancoes: number;
  flags: string[];
  nFlags: number;
  /** Score de risco (proxy, 0+); base da ordenação default. */
  scoreRisco: number;
  exercicios: number[];
}

export interface RiscoAgregados {
  /** Fornecedores (empresas) no recorte filtrado. */
  fornecedores: number;
  /** Quantos estão sancionados. */
  sancionados: number;
  /** Quantos têm ao menos uma flag. */
  comFlags: number;
  /** Soma do total empenhado no recorte. */
  totalEmpenhado: number;
}

export interface RiscoResponse {
  /** Exercício do filtro (0 = todos os exercícios da base). */
  exercicio: number;
  /** Total de fornecedores que casam o filtro (base do "Página X de Y"). */
  total: number;
  pagina: number;
  tamanho: number;
  itens: FornecedorRisco[];
  agregados: RiscoAgregados;
  /** 'pendente' = coleção `nexo_entidades` vazia (perfil ainda não rodou). */
  ingestao: { status: 'ok' | 'pendente' };
  atualizadoEm: string;
  /** Marca o snapshot que materializa o DATASET COMPLETO (recortável na leitura). */
  _completo?: boolean;
  /** Estado transitório: sem snapshot completo ainda; recompondo em background. */
  _compilando?: boolean;
}

// ── Mascaramento de doc (espelha mascararDoc do client, server-side) ──────────
function mascararCnpj(doc: string | null): string | null {
  if (!doc) return null;
  const d = doc.replace(/\D/g, '');
  if (d.length === 14) {
    // 00.***.***/****-00 — guarda raiz parcial + final; oculta o miolo.
    return `${d.slice(0, 2)}.***.***/****-${d.slice(12)}`;
  }
  return doc;
}

/** lowercase + sem acento, p/ busca tolerante. */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function asNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function asStr(v: unknown): string {
  return v == null ? '' : String(v);
}

function asStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x != null).map((x) => String(x));
}

function asNumArr(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asNum(x)).filter((n) => Number.isFinite(n));
}

/**
 * Score de risco (proxy de priorização, jamais acusação). Peso decrescente:
 * sanção domina; depois nº de flags; depois volume (log, para o R$ não esmagar
 * os demais sinais). Determinístico — só para ordenar a worklist.
 */
function calcularScore(p: {
  sancionado: boolean;
  nSancoes: number;
  nFlags: number;
  totalEmpenhado: number;
}): number {
  let s = 0;
  if (p.sancionado) s += 1000 + p.nSancoes * 50;
  s += p.nFlags * 100;
  // Volume em escala log10 (R$1MM ≈ +12). Não deixa o valor bruto dominar.
  if (p.totalEmpenhado > 0) s += Math.log10(p.totalEmpenhado + 1) * 2;
  return s;
}

// ── Cache server-side da coleção normalizada (leitura 1x por ~5 min) ──────────
interface CacheEntidades {
  itens: FornecedorRisco[];
  ts: number;
}
const TTL_MS = 5 * 60 * 1000;
let cache: CacheEntidades | null = null;

/**
 * Lê `nexo_entidades` (SÓ empresas), normaliza para `FornecedorRisco` e cacheia.
 * Filtra órgãos/pessoas físicas aqui — o ranking é exclusivamente de empresas.
 */
async function obterEntidades(idToken: string): Promise<FornecedorRisco[]> {
  const agora = Date.now();
  if (cache && agora - cache.ts < TTL_MS) return cache.itens;

  // Sem filtro de exercício: `nexo_entidades` usa `_exercicios` (array), não o
  // `_exercicio` escalar — e é pequena (1 doc/entidade). Lê tudo 1x.
  const brutos = await lerColecaoNexo('nexo_entidades', {}, idToken);

  const itens: FornecedorRisco[] = [];
  for (const b of brutos) {
    if (asStr(b.tipo) !== 'empresa') continue; // exclui 'orgao' e 'pessoa' (LGPD)
    const flags = asStrArr(b.flags);
    const sancionado = b.sancionado === true;
    const nSancoes = asNum(b.nSancoes);
    const totalEmpenhado = asNum(b.totalEmpenhado);
    const cnpj = (() => {
      const c = asStr(b.cnpj).replace(/\D/g, '');
      if (c.length === 14) return c;
      const d = asStr(b.doc).replace(/\D/g, '');
      return d.length === 14 ? d : null;
    })();
    itens.push({
      id: asStr(b._id) || asStr(b._docId),
      nome: asStr(b.nome),
      doc: mascararCnpj(cnpj),
      cnpj,
      totalEmpenhado,
      nEmpenhos: asNum(b.nEmpenhos),
      nContratos: asNum(b.nContratos),
      contratosAtivos: asNum(b.contratosAtivos),
      nLicitacoes: asNum(b.nLicitacoes),
      nVinculos: asNum(b.nVinculos),
      sancionado,
      nSancoes,
      flags,
      nFlags: flags.length,
      scoreRisco: calcularScore({ sancionado, nSancoes, nFlags: flags.length, totalEmpenhado }),
      exercicios: asNumArr(b._exercicios),
    });
  }

  cache = { itens, ts: agora };
  return itens;
}

/** Parâmetros de recorte do ranking de risco. */
interface ParamsRisco {
  exercicio: number;
  q: string;
  soSancionados: boolean;
  ordenarPor: OrdenarRisco;
  tamanho: number;
  pagina: number;
}

function lerParamsRisco(searchParams: URLSearchParams): ParamsRisco {
  // exercicio = 0 → todos os exercícios da base (default). >0 → filtra o array.
  const exercicio = Math.max(0, Math.trunc(Number(searchParams.get('exercicio'))) || 0);
  const q = (searchParams.get('q') ?? '').trim();
  const soSancionados =
    searchParams.get('soSancionados') === '1' || searchParams.get('soSancionados') === 'true';
  const ordenarPorRaw = searchParams.get('ordenarPor') ?? 'risco';
  const ordenarPor: OrdenarRisco =
    ordenarPorRaw === 'totalEmpenhado' || ordenarPorRaw === 'nFlags' || ordenarPorRaw === 'nVinculos'
      ? ordenarPorRaw
      : 'risco';
  const tamanho = Math.min(
    TAMANHO_MAX,
    Math.max(1, Math.trunc(Number(searchParams.get('tamanho'))) || TAMANHO_PADRAO),
  );
  const pagina = Math.max(0, Math.trunc(Number(searchParams.get('pagina'))) || 0);
  return { exercicio, q, soSancionados, ordenarPor, tamanho, pagina };
}

/**
 * RECORTA em memória uma lista já carregada de fornecedores (do snapshot
 * COMPLETO ou de um cômputo live): filtra (exercicio/sancionado/q) → agregados
 * do recorte → ordena → pagina. Puro, sem I/O. `meta.atualizadoEm` preserva a
 * geração do snapshot quando recortando dele (não usa `new Date`).
 */
function recortarRisco(
  todos: FornecedorRisco[],
  p: ParamsRisco,
  meta?: { atualizadoEm?: string; ingestao?: 'ok' | 'pendente' },
): RiscoResponse {
  if (todos.length === 0) {
    return {
      exercicio: p.exercicio,
      total: 0,
      pagina: 0,
      tamanho: p.tamanho,
      itens: [],
      agregados: { fornecedores: 0, sancionados: 0, comFlags: 0, totalEmpenhado: 0 },
      ingestao: { status: meta?.ingestao ?? 'pendente' },
      atualizadoEm: meta?.atualizadoEm ?? new Date().toISOString(),
    };
  }

  // ── Filtra em memória ──────────────────────────────────────────────────────
  const termo = norm(p.q);
  const termoDigitos = p.q.replace(/\D/g, '');
  let itens = todos.filter((e) => {
    if (p.exercicio > 0 && !e.exercicios.includes(p.exercicio)) return false;
    if (p.soSancionados && !e.sancionado) return false;
    if (termo || termoDigitos) {
      const casaNome = termo && norm(e.nome).includes(termo);
      const casaDoc = termoDigitos.length >= 2 && (e.cnpj ?? '').includes(termoDigitos);
      if (!casaNome && !casaDoc) return false;
    }
    return true;
  });

  // ── Agregados do recorte (antes de paginar) ────────────────────────────────
  const agregados: RiscoAgregados = {
    fornecedores: itens.length,
    sancionados: itens.reduce((n, e) => n + (e.sancionado ? 1 : 0), 0),
    comFlags: itens.reduce((n, e) => n + (e.nFlags > 0 ? 1 : 0), 0),
    totalEmpenhado: itens.reduce((s, e) => s + e.totalEmpenhado, 0),
  };

  // ── Ordena (desc; desempate por score → total) ─────────────────────────────
  itens = [...itens].sort((a, b) => {
    let cmp = 0;
    if (p.ordenarPor === 'totalEmpenhado') cmp = b.totalEmpenhado - a.totalEmpenhado;
    else if (p.ordenarPor === 'nFlags') cmp = b.nFlags - a.nFlags;
    else if (p.ordenarPor === 'nVinculos') cmp = b.nVinculos - a.nVinculos;
    else cmp = b.scoreRisco - a.scoreRisco;
    if (cmp !== 0) return cmp;
    if (b.scoreRisco !== a.scoreRisco) return b.scoreRisco - a.scoreRisco;
    if (b.totalEmpenhado !== a.totalEmpenhado) return b.totalEmpenhado - a.totalEmpenhado;
    return a.nome.localeCompare(b.nome);
  });

  const total = itens.length;
  const offset = p.pagina * p.tamanho;
  const pagItens = itens.slice(offset, offset + p.tamanho);

  return {
    exercicio: p.exercicio,
    total,
    pagina: p.pagina,
    tamanho: p.tamanho,
    itens: pagItens,
    agregados,
    ingestao: { status: meta?.ingestao ?? 'ok' },
    atualizadoEm: meta?.atualizadoEm ?? new Date().toISOString(),
  };
}

/** Cômputo LIVE (caminho legado/compat de transição) — lê e recorta. */
async function computarRisco(p: ParamsRisco, idToken: string): Promise<RiscoResponse> {
  return recortarRisco(await obterEntidades(idToken), p);
}

/**
 * Materializa o DATASET COMPLETO para o snapshot (modo compute/worker): TODOS os
 * fornecedores ordenados por score, sem paginar, marcados com `_completo`. A
 * leitura recorta filtros/paginação em memória sobre estes itens.
 */
async function computarRiscoCompleto(idToken: string): Promise<RiscoResponse> {
  const r = recortarRisco(await obterEntidades(idToken), {
    exercicio: 0,
    q: '',
    soSancionados: false,
    ordenarPor: 'risco',
    pagina: 0,
    tamanho: Number.MAX_SAFE_INTEGER,
  });
  return { ...r, _completo: true };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const p = lerParamsRisco(searchParams);

  // ── MODO COMPUTE (worker) ────────────────────────────────────────────────────
  const compute = avaliarCompute(req);
  if (compute.modo === 'negado') {
    return NextResponse.json({ erro: compute.erro }, { status: compute.status, headers: headersNoStore });
  }
  if (compute.modo === 'compute') {
    try {
      // O worker materializa a 1ª página com a ordenação default de risco.
      // Materializa o DATASET COMPLETO (todos os fornecedores) — leitura recorta.
      const payload = await computarRiscoCompleto(compute.idToken);
      return NextResponse.json(payload, { headers: headersNoStore });
    } catch (err) {
      return NextResponse.json(
        { erro: err instanceof Error ? err.message : 'erro ao computar risco' },
        { status: 502, headers: headersNoStore },
      );
    }
  }

  // ── MODO LEITURA (usuário) ───────────────────────────────────────────────────
  const sessao = await sessaoLeitura(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json({ erro: 'acesso negado ao NEXO' }, { status: sessao.status, headers: headersNoStore });
  }
  const idToken = sessao.idToken;

  // Snapshot-only: lê SEMPRE o snapshot canônico (exercício 0) — o filtro de ano
  // vira recorte de leitura. lerSnapshotPainel serve stale + enfileira recompute
  // em background quando ausente/vencido. NUNCA computa pesado no GET — salvo o
  // caminho de TRANSIÇÃO (snapshot ANTIGO page-only + recorte filtrado).
  const recorteDefault =
    p.exercicio === 0 &&
    !p.q &&
    !p.soSancionados &&
    p.ordenarPor === 'risco' &&
    p.pagina === 0;

  let snap = null;
  try {
    snap = await lerSnapshotPainel('risco', '', 0, idToken, sessao.uid ?? undefined);
  } catch {
    snap = null;
  }
  const payloadSnap = snap?.payload as RiscoResponse | undefined;
  const itensCompletos =
    payloadSnap?._completo === true && Array.isArray(payloadSnap.itens)
      ? (payloadSnap.itens as FornecedorRisco[])
      : null;

  // Snapshot COMPLETO → recorta em memória (filtros/paginação), nunca live.
  if (itensCompletos) {
    return NextResponse.json(
      recortarRisco(itensCompletos, p, {
        atualizadoEm: payloadSnap?.atualizadoEm,
        ingestao: payloadSnap?.ingestao?.status ?? 'ok',
      }),
      { headers: headersCache },
    );
  }

  // Snapshot ANTIGO (page-only, sem _completo): força o upgrade p/ o formato
  // completo em background e mantém o comportamento atual na transição.
  if (snap) {
    if (sessao.uid) void enfileirarRecompute('risco', '', 0, sessao.uid, idToken);
    if (recorteDefault) return NextResponse.json(snap.payload, { headers: headersCache });
  }

  // Sem snapshot COMPLETO ainda (painel frio OU recorte filtrado na transição):
  // computa LIVE para MOSTRAR DADOS já, enquanto o worker materializa o snapshot
  // completo em background (lerSnapshotPainel já enfileirou). Assim que o
  // `_completo` existir, a leitura passa a recortar do snapshot e nunca mais
  // computa live no GET — sem janela de "Compilando" vazio / perda de dados.
  try {
    return NextResponse.json(await computarRisco(p, idToken), { headers: headersCache });
  } catch (err) {
    return NextResponse.json(
      { erro: err instanceof Error ? err.message : 'erro ao ler nexo_entidades' },
      { status: 502, headers: headersNoStore },
    );
  }
}
