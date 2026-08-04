/**
 * GET /api/nexo/empenhos — LISTAGEM do módulo FINANCEIRO do NEXO.
 *
 * Lê os empenhos do exercício (coleção `nexo_empenhos`, ingerida do SMARAPD pelo
 * cron) e devolve uma página filtrada/ordenada. Como o NEXO guarda 1 doc por
 * empenho analítico (com `valorPago`/`temLiquidacao`), aqui cobrimos empenho +
 * liquidação + pagamento na mesma linha.
 *
 * ── Abertura ─────────────────────────────────────────────────────────────────
 * Sem filtros: lista o exercício corrente em ORDEM CRONOLÓGICA DECRESCENTE
 * (mais recente primeiro), paginada.
 *
 * ── Filtros (todos opcionais, combináveis) ───────────────────────────────────
 *  • exercicio  → ano (default: ano corrente).
 *  • q          → destinatário: casa por NOME (sem acento/caixa) OU por dígitos
 *                 do CNPJ/CPF.
 *  • dataIni/dataFim → período (ISO yyyy-MM-dd) sobre a data do empenho.
 *  • valorMin/valorMax → faixa do valor empenhado.
 *  • orgao      → unidade gestora (substring, sem acento/caixa).
 *  • processo   → processo adm./licitatório (substring, só dígitos/texto livre).
 *  • situacao   → 'liquidado' | 'sem_liquidacao' | 'sancionado'.
 *  • ordenarPor → 'data' (default) | 'valor'; dir → 'desc' (default) | 'asc'.
 *
 * ── Enriquecimento sancionado (indício, nunca acusação) ──────────────────────
 * Lê `nexo_sancoes` UMA vez (cache próprio) e carimba cada empenho com
 * `sancionado`/`nSancoes` quando o CNPJ do fornecedor casa um sancionado — por
 * 14 dígitos (match exato) ou, conservadoramente, pela RAIZ (8 dígitos), já que
 * a CGU costuma sancionar por raiz. É só um realce de indício a apurar.
 *
 * Substring/range não são indexáveis de forma combinável no Firestore, então a
 * rota lê o exercício inteiro (filtros de igualdade `_exercicio`+`_fonte` —
 * servidos por índice de campo único) UMA vez, cacheia a lista normalizada por
 * ~5 min e filtra/ordena/pagina em memória. Resposta com agregados do recorte.
 *
 * Runtime nodejs. Cache privado (dado gated por sessão de usuário ativo).
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import { normalizarEmpenhosFornecedor, type EmpenhoNorm } from '@/lib/nexo/normalizar';

export const runtime = 'nodejs';

const TAMANHO_PADRAO = 50;
const TAMANHO_MAX = 200;
const headersCache = { 'Cache-Control': 'private, max-age=60' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

export interface EmpenhosAgregados {
  count: number;
  totalEmpenhado: number;
  totalPago: number;
  comLiquidacao: number;
  /** Quantos empenhos do recorte têm fornecedor sancionado (indício a apurar). */
  sancionados: number;
}

export interface MensalEmpenho {
  mes: number;
  empenhado: number;
  pago: number;
  count: number;
  comLiquidacao: number;
}

/**
 * Item da resposta: o `EmpenhoNorm` normalizado + carimbo de sanção (indício).
 * `sancionado`/`nSancoes` vêm do cruzamento com `nexo_sancoes` (CEIS/CNEP),
 * por CNPJ exato (14) ou por raiz (8). Nunca é acusação — é indício a apurar.
 */
export interface EmpenhoItem extends EmpenhoNorm {
  sancionado: boolean;
  nSancoes: number;
}

export interface EmpenhosResponse {
  exercicio: number;
  /** Total de empenhos que casam o filtro (base do "Página X de Y"). */
  total: number;
  pagina: number;
  tamanho: number;
  itens: EmpenhoItem[];
  /** Agregados do recorte filtrado (não só da página). */
  agregados: EmpenhosAgregados;
  /** Agregados mensais do exercício completo (sem filtro) para o comparativo mês a mês. */
  porMes: MensalEmpenho[];
  /** 'pendente' = coleção do exercício vazia (ingestão ainda não rodou). */
  ingestao: { status: 'ok' | 'pendente' };
  atualizadoEm: string;
}

/**
 * Campos lidos do SMARAPD (todos os apelidos que o normalizador tenta) — usados
 * como projeção `select` p/ não trafegar as dezenas de campos pesados (URLs,
 * Itens, Documentos…) de cada um dos ~40k empenhos/ano.
 */
const CAMPOS_EMPENHO = [
  'ID', 'Id',
  'CPFCNPJ', 'CpfCnpj', 'CNPJ', 'CpfCnpjFornecedor',
  'NomeFornecedor', 'Fornecedor',
  'NroEmpenho', 'NumeroEmpenho', 'NumEmpenho',
  'ExercEmpenho', 'Exercicio',
  'DataMovimentoEmpenho', 'DataEmp', 'DataMovEmp', 'Data',
  'ValorEmpenho', 'ValorEmpenhado',
  'ValorLiquidoPago', 'ValorPago',
  'NroLiquidacao', 'NumeroLiquidacao',
  'NroProcessoAdminEmpenho', 'NroProcessoAdmin', 'ProcessoAdministrativo',
  'ProcessoLicitatorio', 'NroLicitacao',
  'UG', 'UnidadeGestora',
];

// ── Cache server-side da lista normalizada por exercício (leitura pesada 1x) ──
interface CacheAno {
  itens: EmpenhoNorm[];
  ts: number;
}
const TTL_MS = 5 * 60 * 1000;
const MAX_ANOS = 8;
const cache = new Map<number, CacheAno>();
// Leituras cold em voo por exercício — coalesce concorrentes numa única query.
const emVoo = new Map<number, Promise<EmpenhoNorm[]>>();

async function obterAno(exercicio: number, idToken: string): Promise<EmpenhoNorm[]> {
  const agora = Date.now();
  const c = cache.get(exercicio);
  if (c && agora - c.ts < TTL_MS) return c.itens;

  // De-dup de leituras em voo: sem isto, N requests simultâneos do mesmo
  // exercício (abertura + busca deep-link + cada tecla da busca com debounce,
  // ANTES do cache esquentar) disparam N `:runQuery` de ~40k docs em paralelo.
  // O Firestore fast-falha as duplicatas (~1.3s) e a rota devolve 502. Enquanto
  // uma leitura roda, as demais aguardam a MESMA promise; quando cacheia, todas
  // ficam instantâneas. Corta a rajada e reduz reads (custo).
  const jaEmVoo = emVoo.get(exercicio);
  if (jaEmVoo) return jaEmVoo;

  const p = (async () => {
    const brutos = await lerColecaoNexo('nexo_empenhos', { exercicio, fonte: 'empenhos' }, idToken, CAMPOS_EMPENHO);
    const itens = normalizarEmpenhosFornecedor(brutos, exercicio);
    if (cache.size >= MAX_ANOS) {
      const maisAntigo = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (maisAntigo) cache.delete(maisAntigo[0]);
    }
    cache.set(exercicio, { itens, ts: Date.now() });
    return itens;
  })();
  emVoo.set(exercicio, p);
  try {
    return await p;
  } finally {
    emVoo.delete(exercicio);
  }
}

// ── Cache do conjunto de sancionados (CEIS/CNEP) — leitura única, TTL próprio ─
// `nexo_sancoes`: 1 doc por CNPJ (14 dígitos), com `sancionado`/`qtdSancoes`.
// Guardamos um Map CNPJ(14)→nSancoes só dos docs `sancionado===true`, mais o
// conjunto das RAÍZES (8 dígitos) dessas empresas, para o match conservador.
interface MapaSancoes {
  /** CNPJ completo (14 dígitos) → qtd de sanções. */
  porCnpj: Map<string, number>;
  /** Raiz (8 dígitos) → qtd de sanções (1ª sanção vista por raiz). */
  porRaiz: Map<string, number>;
}
interface CacheSancoes {
  mapa: MapaSancoes;
  ts: number;
}
let cacheSancoes: CacheSancoes | null = null;
let emVooSancoes: Promise<MapaSancoes> | null = null;

async function obterSancoes(idToken: string): Promise<MapaSancoes> {
  const agora = Date.now();
  if (cacheSancoes && agora - cacheSancoes.ts < TTL_MS) return cacheSancoes.mapa;
  // Mesma coalescência do obterAno: concorrentes compartilham 1 leitura de
  // nexo_sancoes em vez de cada request abrir a sua (corta rajada/custo).
  if (emVooSancoes) return emVooSancoes;

  const p = (async (): Promise<MapaSancoes> => {
  const porCnpj = new Map<string, number>();
  const porRaiz = new Map<string, number>();
  try {
    const docs = await lerColecaoNexo(
      'nexo_sancoes',
      {},
      idToken,
      ['_cnpj', 'cnpj', 'sancionado', 'qtdSancoes'],
    );
    for (const d of docs) {
      if (d.sancionado !== true) continue;
      const cnpj = String(d._cnpj ?? d.cnpj ?? '').replace(/\D/g, '');
      if (cnpj.length !== 14) continue;
      const n = Number(d.qtdSancoes) || 0;
      porCnpj.set(cnpj, n);
      const raiz = cnpj.slice(0, 8);
      if (!porRaiz.has(raiz)) porRaiz.set(raiz, n);
    }
  } catch {
    // Falha na leitura de sanções não derruba a listagem: degrada para "sem
    // carimbo" (mapa vazio). Não cacheamos o vazio de erro (ts não atualiza só
    // com sucesso? — atualizamos abaixo; em erro o mapa fica vazio nesta janela).
  }

  const mapa: MapaSancoes = { porCnpj, porRaiz };
    cacheSancoes = { mapa, ts: Date.now() };
    return mapa;
  })();
  emVooSancoes = p;
  try {
    return await p;
  } finally {
    emVooSancoes = null;
  }
}

/** Resolve o carimbo de sanção de um CNPJ: 14 dígitos exato → senão raiz (8). */
function carimboSancao(
  cpfCnpj: string,
  s: MapaSancoes,
): { sancionado: boolean; nSancoes: number } {
  if (cpfCnpj.length !== 14) return { sancionado: false, nSancoes: 0 }; // CPF/pessoa física não cruza CEIS por CNPJ
  const exato = s.porCnpj.get(cpfCnpj);
  if (exato != null) return { sancionado: true, nSancoes: exato };
  const porRaiz = s.porRaiz.get(cpfCnpj.slice(0, 8));
  if (porRaiz != null) return { sancionado: true, nSancoes: porRaiz };
  return { sancionado: false, nSancoes: 0 };
}

/** lowercase + sem acento, p/ busca tolerante. */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function num(v: string | null): number | null {
  if (v == null || v.trim() === '') return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json({ erro: 'acesso negado ao NEXO' }, { status: sessao.status, headers: headersNoStore });
  }
  const idToken = sessao.idToken;

  const { searchParams } = new URL(req.url);
  const exercicio = Math.trunc(Number(searchParams.get('exercicio'))) || new Date().getFullYear();
  const q = (searchParams.get('q') ?? '').trim();
  const dataIni = (searchParams.get('dataIni') ?? '').trim();
  const dataFim = (searchParams.get('dataFim') ?? '').trim();
  const valorMin = num(searchParams.get('valorMin'));
  const valorMax = num(searchParams.get('valorMax'));
  const orgao = (searchParams.get('orgao') ?? '').trim();
  const processo = (searchParams.get('processo') ?? '').trim();
  const situacao = (searchParams.get('situacao') ?? '').trim(); // 'liquidado' | 'sem_liquidacao' | 'sancionado' | ''
  const ordenarPor = searchParams.get('ordenarPor') === 'valor' ? 'valor' : 'data';
  const dir = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  const tamanho = Math.min(TAMANHO_MAX, Math.max(1, Math.trunc(Number(searchParams.get('tamanho'))) || TAMANHO_PADRAO));
  const pagina = Math.max(0, Math.trunc(Number(searchParams.get('pagina'))) || 0);

  let baseNorm: EmpenhoNorm[];
  let mapaSancoes: MapaSancoes;
  try {
    [baseNorm, mapaSancoes] = await Promise.all([
      obterAno(exercicio, idToken),
      obterSancoes(idToken),
    ]);
  } catch (err) {
    // Log explícito: o 502 antes era silencioso (catch engolia o erro no JSON),
    // o que escondeu a rajada de leituras concorrentes. Mantém rastro no server.
    console.error('[nexo/empenhos] falha ao ler', { exercicio, erro: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { erro: err instanceof Error ? err.message : 'erro ao ler nexo_empenhos' },
      { status: 502, headers: headersNoStore },
    );
  }

  if (baseNorm.length === 0) {
    const vazio: EmpenhosResponse = {
      exercicio,
      total: 0,
      pagina: 0,
      tamanho,
      itens: [],
      agregados: { count: 0, totalEmpenhado: 0, totalPago: 0, comLiquidacao: 0, sancionados: 0 },
      porMes: [],
      ingestao: { status: 'pendente' },
      atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(vazio, { headers: headersCache });
  }

  // Carimbo de sanção (indício) sobre cada empenho normalizado.
  const todos: EmpenhoItem[] = baseNorm.map((e) => ({
    ...e,
    ...carimboSancao(e.cpfCnpj, mapaSancoes),
  }));

  // ── Agregados mensais do exercício (sempre do total, sem filtro) ──────────
  const porMes = (() => {
    const acc = new Map<number, MensalEmpenho>();
    for (const e of todos) {
      if (!e.data) continue;
      const m = /^(\d{4})-(\d{2})/.exec(e.data);
      if (!m) continue;
      const mes = Number(m[2]);
      const cur = acc.get(mes) ?? { mes, empenhado: 0, pago: 0, count: 0, comLiquidacao: 0 };
      cur.empenhado += e.valorEmpenhado;
      cur.pago += e.valorPago;
      cur.count += 1;
      if (e.temLiquidacao) cur.comLiquidacao += 1;
      acc.set(mes, cur);
    }
    return [...acc.values()].sort((a, b) => a.mes - b.mes);
  })();

  // ── Filtra em memória ──────────────────────────────────────────────────────
  const termo = norm(q);
  const termoDigitos = q.replace(/\D/g, '');
  let itens = todos.filter((e) => {
    if (termo || termoDigitos) {
      const casaNome = termo && norm(e.fornecedorNome).includes(termo);
      const casaDoc = termoDigitos.length >= 2 && e.cpfCnpj.includes(termoDigitos);
      if (!casaNome && !casaDoc) return false;
    }
    if (dataIni && (!e.data || e.data < dataIni)) return false;
    if (dataFim && (!e.data || e.data > dataFim)) return false;
    if (valorMin != null && e.valorEmpenhado < valorMin) return false;
    if (valorMax != null && e.valorEmpenhado > valorMax) return false;
    if (orgao && !norm(e.unidadeGestora).includes(norm(orgao))) return false;
    if (processo) {
      const alvo = norm(`${e.processoAdministrativo ?? ''} ${e.processoLicitatorio ?? ''}`);
      if (!alvo.includes(norm(processo))) return false;
    }
    if (situacao === 'liquidado' && !e.temLiquidacao) return false;
    if (situacao === 'sem_liquidacao' && e.temLiquidacao) return false;
    if (situacao === 'sancionado' && !e.sancionado) return false;
    return true;
  });

  // ── Agregados do recorte (antes de paginar) ────────────────────────────────
  const agregados: EmpenhosAgregados = {
    count: itens.length,
    totalEmpenhado: itens.reduce((s, e) => s + e.valorEmpenhado, 0),
    totalPago: itens.reduce((s, e) => s + e.valorPago, 0),
    comLiquidacao: itens.reduce((n, e) => n + (e.temLiquidacao ? 1 : 0), 0),
    sancionados: itens.reduce((n, e) => n + (e.sancionado ? 1 : 0), 0),
  };

  // ── Ordena ─────────────────────────────────────────────────────────────────
  const sinal = dir === 'asc' ? 1 : -1;
  itens = [...itens].sort((a, b) => {
    if (ordenarPor === 'valor') {
      return sinal * (a.valorEmpenhado - b.valorEmpenhado || (a.data ?? '').localeCompare(b.data ?? ''));
    }
    // data: null vai para o fim independente da direção
    if (a.data === b.data) return (a.numeroEmpenho || '').localeCompare(b.numeroEmpenho || '') * sinal;
    if (!a.data) return 1;
    if (!b.data) return -1;
    return sinal * a.data.localeCompare(b.data);
  });

  const total = itens.length;
  const offset = pagina * tamanho;
  const pagItens = itens.slice(offset, offset + tamanho);

  const resposta: EmpenhosResponse = {
    exercicio,
    total,
    pagina,
    tamanho,
    itens: pagItens,
    agregados,
    porMes,
    ingestao: { status: 'ok' },
    atualizadoEm: new Date().toISOString(),
  };
  return NextResponse.json(resposta, { headers: headersCache });
}
