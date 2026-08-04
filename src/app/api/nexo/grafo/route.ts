/**
 * GET /api/nexo/grafo?no=<id>&exercicio=<ano>&saltos=1
 *
 * GRAFO DE VÍNCULOS do NEXO — a superfície de exploração do tema-mãe "TUDO
 * LINKADO". Lê o grafo persistido em `nexo_links` (1 doc por aresta, montado
 * pelo cron `onNexoLinkage`) e devolve a VIZINHANÇA de um nó-semente até
 * `saltos` saltos (BFS), pronta para uma visualização leve.
 *
 * ── O QUE É UM NÓ ────────────────────────────────────────────────────────────
 * Cada aresta de `nexo_links` referencia dois documentos pelo par
 * `{colecao, id}` em `_de`/`_para` — onde `id` é o docId do Firestore na
 * coleção `nexo_*` (empenho/contrato/licitação/tce/dom/documento). O id de nó
 * deste endpoint é o composto `"<colecao>:<id>"`, estável e auto-descritivo.
 *
 * ── SEM SEMENTE → HUBS ───────────────────────────────────────────────────────
 * Sem `no`, devolve os nós de MAIOR GRAU (hubs) do exercício como pontos de
 * entrada — onde a teia é mais densa (um processo que costura empenho ↔
 * contrato ↔ DOM ↔ documento tende a ser um foco de fiscalização).
 *
 * ── HONESTIDADE (regra do dono) ──────────────────────────────────────────────
 * `nexo_links` vazio para o exercício NÃO é "nenhum vínculo": é o cron de
 * linkage que ainda não rodou (ou não achou cruzamento). A resposta carrega
 * `disponivel=false` + `motivo` honesto para a UI distinguir os casos.
 *
 * ── DESEMPENHO ───────────────────────────────────────────────────────────────
 * `nexo_links` pode ser grande. Lemos o exercício UMA vez (projeção dos campos
 * que importam via `campos` do `lerColecaoNexo`), montamos a lista de adjacência
 * em memória e cacheamos ~5min por exercício. A vizinhança é capada por
 * `MAX_NOS` para limitar o payload e o esforço de resolução de rótulos.
 *
 * Rotulagem dos nós: para os nós da vizinhança (capada), resolvemos um rótulo
 * legível lendo os docs-alvo das coleções `nexo_*` — sob projeção dos poucos
 * campos de exibição. Rótulo ausente degrada para `<colecao>/<id-curto>`.
 *
 * Runtime nodejs. Rota protegida (sessão NEXO). Cache privado curto.
 */
import { NextResponse } from 'next/server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import {
  avaliarCompute,
  sessaoLeitura,
  lerSnapshotPainel,
} from '@/lib/nexo/compute-guard';

export const runtime = 'nodejs';

/** Teto de nós devolvidos na vizinhança — limita payload e esforço de rótulo. */
const MAX_NOS = 150;
/** Teto de saltos a partir da semente. */
const MAX_SALTOS = 2;
/** Quantos hubs devolver quando não há semente. */
const MAX_HUBS = 40;
/** TTL do cache da lista de adjacência por exercício. */
const TTL_MS = 5 * 60 * 1000;
const MAX_ANOS = 8;

const headersCache = { 'Cache-Control': 'private, max-age=60' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

// ── Contratos da resposta (exportados p/ a página tipar o consumo) ───────────

/** Um nó do grafo: id composto `<colecao>:<docId>`, tipo (coleção) e rótulo. */
export interface GrafoNo {
  /** Id composto estável: `"<colecao>:<docId>"`. */
  id: string;
  /** Coleção `nexo_*` do nó (tipo da entidade-documento). */
  tipo: string;
  /** Rótulo legível (resolvido do doc-alvo; cai p/ `<colecao>/<id>` se ausente). */
  rotulo: string;
  /** Grau do nó no exercício inteiro (nº de arestas que o tocam). */
  grau: number;
}

/** Uma aresta do grafo entre dois `GrafoNo.id`. */
export interface GrafoAresta {
  de: string;
  para: string;
  /** Tipo da aresta de `nexo_links` (empenho-contrato, processo-dom, …). */
  tipo: string;
  /** Força do vínculo: 'forte' | 'media' | 'fraca' (ou '' se ausente). */
  confianca: string;
  /** Chave que produziu o vínculo (nº de processo/empenho/cnpj). */
  chave: string;
}

export interface GrafoResponse {
  exercicio: number;
  /** Nó-semente pedido (null quando a resposta é a lista de hubs). */
  no: string | null;
  /** Saltos aplicados (1..MAX_SALTOS) — só relevante com semente. */
  saltos: number;
  /** false quando `nexo_links` está vazio/indisponível para o exercício. */
  disponivel: boolean;
  /** Explicação honesta quando `disponivel=false` (linkage inativo). */
  motivo: string | null;
  /** true quando a vizinhança foi truncada por MAX_NOS. */
  truncado: boolean;
  /** Total de arestas no grafo do exercício (contexto do recorte). */
  totalArestasExercicio: number;
  nodes: GrafoNo[];
  edges: GrafoAresta[];
  atualizadoEm: string;
}

// ── Helpers de leitura tipada ────────────────────────────────────────────────

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function ref(v: unknown): { colecao: string; id: string } | null {
  if (v == null || typeof v !== 'object') return null;
  const r = v as { colecao?: unknown; id?: unknown };
  const colecao = str(r.colecao);
  const id = str(r.id);
  if (!colecao || !id) return null;
  return { colecao, id };
}

/** Id composto estável de um nó a partir de um ref `{colecao, id}`. */
function noId(colecao: string, id: string): string {
  return `${colecao}:${id}`;
}

// ── Grafo do exercício (lista de adjacência) ─────────────────────────────────

interface ArestaInterna {
  de: string;
  para: string;
  tipo: string;
  confianca: string;
  chave: string;
}

interface GrafoExercicio {
  /** Toda aresta do exercício (deduplicada por par+tipo). */
  arestas: ArestaInterna[];
  /** noId → vizinhos (noId das pontas opostas das arestas que o tocam). */
  adjacencia: Map<string, Set<string>>;
  /** noId → grau (nº de arestas que o tocam). */
  grau: Map<string, number>;
  /** noId → tipo (coleção) — derivado do id composto. */
  tipoNo: Map<string, string>;
}

/**
 * Projeção lida de `nexo_links`: só os campos que o grafo usa, para não trafegar
 * `_geradoEm`/etc. desnecessários numa coleção potencialmente grande.
 */
const CAMPOS_LINK = ['_de', '_para', 'tipo', 'confianca', 'chave'];

function montarGrafo(links: Record<string, unknown>[]): GrafoExercicio {
  const arestas: ArestaInterna[] = [];
  const adjacencia = new Map<string, Set<string>>();
  const grau = new Map<string, number>();
  const tipoNo = new Map<string, string>();
  const vistos = new Set<string>();

  const ligar = (a: string, b: string) => {
    let sa = adjacencia.get(a);
    if (!sa) {
      sa = new Set();
      adjacencia.set(a, sa);
    }
    sa.add(b);
  };

  for (const lk of links) {
    const de = ref(lk._de);
    const para = ref(lk._para);
    if (!de || !para) continue;
    const idDe = noId(de.colecao, de.id);
    const idPara = noId(para.colecao, para.id);
    if (idDe === idPara) continue;
    const tipo = str(lk.tipo);
    // Dedup por par-ordenado + tipo (o linkage já canonicaliza a direção, mas
    // garantimos aqui contra eventuais duplicatas legadas).
    const chaveDedup = (idDe <= idPara ? `${idDe}|${idPara}` : `${idPara}|${idDe}`) + `#${tipo}`;
    if (vistos.has(chaveDedup)) continue;
    vistos.add(chaveDedup);

    arestas.push({
      de: idDe,
      para: idPara,
      tipo,
      confianca: str(lk.confianca),
      chave: str(lk.chave),
    });
    ligar(idDe, idPara);
    ligar(idPara, idDe);
    grau.set(idDe, (grau.get(idDe) ?? 0) + 1);
    grau.set(idPara, (grau.get(idPara) ?? 0) + 1);
    tipoNo.set(idDe, de.colecao);
    tipoNo.set(idPara, para.colecao);
  }

  return { arestas, adjacencia, grau, tipoNo };
}

// ── Cache server-side por exercício ──────────────────────────────────────────

interface CacheAno {
  grafo: GrafoExercicio;
  ts: number;
}
const cache = new Map<number, CacheAno>();

async function obterGrafo(
  exercicio: number,
  idToken: string,
): Promise<GrafoExercicio> {
  const agora = Date.now();
  const c = cache.get(exercicio);
  if (c && agora - c.ts < TTL_MS) return c.grafo;
  const links = await lerColecaoNexo(
    'nexo_links',
    { exercicio },
    idToken,
    CAMPOS_LINK,
  );
  const grafo = montarGrafo(links);
  if (cache.size >= MAX_ANOS) {
    const maisAntigo = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (maisAntigo) cache.delete(maisAntigo[0]);
  }
  cache.set(exercicio, { grafo, ts: agora });
  return grafo;
}

// ── Resolução de rótulos (lê os docs-alvo, por coleção, sob projeção) ─────────

/** Campos de exibição por coleção `nexo_*` — projeção mínima p/ o rótulo. */
const CAMPOS_ROTULO: Record<string, string[]> = {
  nexo_empenhos: ['NroEmpenho', 'NumeroEmpenho', '_fornecedor', 'NomeFornecedor', 'Fornecedor'],
  nexo_contratos_municipais: ['numeroContrato', 'numeroProcesso', '_fornecedor', 'nomeContratada', 'objeto'],
  nexo_licitacoes: ['numeroEdital', 'numeroProcesso', 'modalidade', 'objeto'],
  nexo_tce_despesas: ['nrEmpenho', 'nrEmpenhoBruto', '_fornecedor', 'cnpj'],
  nexo_diario_dom: ['titulo', 'numeroEdicao', 'data', '_data'],
  nexo_documentos: ['titulo', 'tipo', 'nome'],
};

/** Texto curto de um nó a partir do doc-alvo (campos tentados por coleção). */
function rotuloDeDoc(colecao: string, doc: Record<string, unknown>): string {
  const campos = CAMPOS_ROTULO[colecao] ?? [];
  const partes: string[] = [];
  for (const k of campos) {
    const v = str(doc[k]);
    if (v) partes.push(v);
    if (partes.length >= 2) break;
  }
  return partes.join(' · ');
}

/** Rótulo de fallback quando o doc não foi resolvido. */
function rotuloFallback(colecao: string, id: string): string {
  const curto = id.length > 10 ? `${id.slice(0, 8)}…` : id;
  return `${colecaoCurta(colecao)}/${curto}`;
}

/** Nome curto e legível da coleção (para tipos/rótulos). */
function colecaoCurta(colecao: string): string {
  return colecao.replace(/^nexo_/, '');
}

/**
 * Resolve rótulos para um conjunto de noIds, agrupando por coleção e lendo cada
 * coleção UMA vez (sob projeção). Em vez de N gets, faz 1 query por coleção e
 * casa pelo `_docId`. Resolver é best-effort: falha de leitura cai no fallback.
 */
async function resolverRotulos(
  ids: string[],
  exercicio: number,
  idToken: string,
): Promise<Map<string, string>> {
  const rotulos = new Map<string, string>();
  // Agrupa ids por coleção.
  const porColecao = new Map<string, Set<string>>();
  for (const composto of ids) {
    const sep = composto.indexOf(':');
    if (sep <= 0) continue;
    const colecao = composto.slice(0, sep);
    const docId = composto.slice(sep + 1);
    let s = porColecao.get(colecao);
    if (!s) {
      s = new Set();
      porColecao.set(colecao, s);
    }
    s.add(docId);
  }

  await Promise.all(
    [...porColecao.entries()].map(async ([colecao, docIds]) => {
      const campos = CAMPOS_ROTULO[colecao];
      try {
        // `nexo_documentos` não carrega `_exercicio` (ver linkage.ts) — lê sem
        // filtro de exercício; as demais coleções filtram por exercício.
        const filtro =
          colecao === 'nexo_documentos' ? {} : { exercicio };
        const docs = await lerColecaoNexo(colecao, filtro, idToken, campos);
        for (const d of docs) {
          const docId = str(d._docId);
          if (!docId || !docIds.has(docId)) continue;
          const r = rotuloDeDoc(colecao, d);
          if (r) rotulos.set(noId(colecao, docId), r);
        }
      } catch {
        /* coleção indisponível — os nós caem no rótulo de fallback */
      }
    }),
  );

  return rotulos;
}

// ── BFS da vizinhança ─────────────────────────────────────────────────────────

/**
 * Coleta os nós alcançáveis a partir da semente em até `saltos` saltos (BFS),
 * capando em MAX_NOS. Devolve o conjunto de noIds visitados + se truncou.
 */
function vizinhanca(
  grafo: GrafoExercicio,
  semente: string,
  saltos: number,
): { nos: Set<string>; truncado: boolean } {
  const nos = new Set<string>([semente]);
  let fronteira = [semente];
  let truncado = false;

  for (let salto = 0; salto < saltos && fronteira.length > 0; salto++) {
    const proxima: string[] = [];
    for (const atual of fronteira) {
      for (const viz of grafo.adjacencia.get(atual) ?? []) {
        if (nos.has(viz)) continue;
        if (nos.size >= MAX_NOS) {
          truncado = true;
          break;
        }
        nos.add(viz);
        proxima.push(viz);
      }
      if (truncado) break;
    }
    fronteira = proxima;
  }

  return { nos, truncado };
}

// ── Handler ──────────────────────────────────────────────────────────────────

function vazioLinkage(
  exercicio: number,
  no: string | null,
  saltos: number,
): GrafoResponse {
  return {
    exercicio,
    no,
    saltos,
    disponivel: false,
    motivo:
      'O grafo de vínculos (nexo_links) está vazio para este exercício. O cron ' +
      'de linkage (onNexoLinkage) ainda não rodou para o período, ou não ' +
      'encontrou cruzamentos entre as coleções ingeridas. A exploração fica ' +
      'indisponível até o grafo ser construído.',
    truncado: false,
    totalArestasExercicio: 0,
    nodes: [],
    edges: [],
    atualizadoEm: new Date().toISOString(),
  };
}

/**
 * NÚCLEO de cômputo do grafo — monta a `GrafoResponse` (hubs ou vizinhança BFS).
 * Chamado nos DOIS modos: leitura ao vivo (fallback sem snapshot) e compute (o
 * worker materializa a visão de HUBS, `no=null`). Não acessa `Request`.
 */
async function computarGrafo(
  exercicio: number,
  no: string | null,
  saltos: number,
  idToken: string,
): Promise<GrafoResponse> {
  const grafo = await obterGrafo(exercicio, idToken);
  const totalArestasExercicio = grafo.arestas.length;

  // Grafo vazio para o exercício → estado honesto (linkage inativo).
  if (totalArestasExercicio === 0) {
    return vazioLinkage(exercicio, no, saltos);
  }

  // ── SEM SEMENTE → HUBS (maior grau) ──────────────────────────────────────────
  if (!no) {
    const hubs = [...grafo.grau.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_HUBS)
      .map(([id]) => id);

    const rotulos = await resolverRotulos(hubs, exercicio, idToken);
    const nodes: GrafoNo[] = hubs.map((id) => {
      const sep = id.indexOf(':');
      const colecao = id.slice(0, sep);
      const docId = id.slice(sep + 1);
      return {
        id,
        tipo: colecao,
        rotulo: rotulos.get(id) || rotuloFallback(colecao, docId),
        grau: grafo.grau.get(id) ?? 0,
      };
    });

    // Arestas internas APENAS entre hubs (dá uma noção da teia dos focos).
    const setHubs = new Set(hubs);
    const edges: GrafoAresta[] = grafo.arestas
      .filter((a) => setHubs.has(a.de) && setHubs.has(a.para))
      .map((a) => ({ de: a.de, para: a.para, tipo: a.tipo, confianca: a.confianca, chave: a.chave }));

    return {
      exercicio,
      no: null,
      saltos,
      disponivel: true,
      motivo: null,
      truncado: grafo.grau.size > MAX_HUBS,
      totalArestasExercicio,
      nodes,
      edges,
      atualizadoEm: new Date().toISOString(),
    };
  }

  // ── COM SEMENTE → VIZINHANÇA (BFS até `saltos`) ──────────────────────────────
  // Semente fora do grafo: nó isolado/inexistente — honesto, sem arestas.
  if (!grafo.adjacencia.has(no)) {
    const sep = no.indexOf(':');
    const colecao = sep > 0 ? no.slice(0, sep) : no;
    const docId = sep > 0 ? no.slice(sep + 1) : no;
    return {
      exercicio,
      no,
      saltos,
      disponivel: true,
      motivo:
        'A semente informada não tem vínculos no grafo deste exercício. Ela pode ' +
        'estar isolada (sem cruzamento) ou não existir no grafo do período.',
      truncado: false,
      totalArestasExercicio,
      nodes: [
        { id: no, tipo: colecao, rotulo: rotuloFallback(colecao, docId), grau: 0 },
      ],
      edges: [],
      atualizadoEm: new Date().toISOString(),
    };
  }

  const { nos, truncado } = vizinhanca(grafo, no, saltos);

  // Arestas cujas DUAS pontas estão na vizinhança coletada.
  const edges: GrafoAresta[] = grafo.arestas
    .filter((a) => nos.has(a.de) && nos.has(a.para))
    .map((a) => ({ de: a.de, para: a.para, tipo: a.tipo, confianca: a.confianca, chave: a.chave }));

  const ids = [...nos];
  const rotulos = await resolverRotulos(ids, exercicio, idToken);
  const nodes: GrafoNo[] = ids.map((id) => {
    const sep = id.indexOf(':');
    const colecao = id.slice(0, sep);
    const docId = id.slice(sep + 1);
    return {
      id,
      tipo: colecao,
      rotulo: rotulos.get(id) || rotuloFallback(colecao, docId),
      grau: grafo.grau.get(id) ?? 0,
    };
  });

  return {
    exercicio,
    no,
    saltos,
    disponivel: true,
    motivo: null,
    truncado,
    totalArestasExercicio,
    nodes,
    edges,
    atualizadoEm: new Date().toISOString(),
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const exercicio =
    Math.trunc(Number(searchParams.get('exercicio'))) || new Date().getFullYear();
  const no = (searchParams.get('no') ?? '').trim() || null;
  const saltos = Math.min(
    MAX_SALTOS,
    Math.max(1, Math.trunc(Number(searchParams.get('saltos'))) || 1),
  );

  // ── MODO COMPUTE (worker) ────────────────────────────────────────────────────
  const compute = avaliarCompute(req);
  if (compute.modo === 'negado') {
    return NextResponse.json({ erro: compute.erro }, { status: compute.status, headers: headersNoStore });
  }
  if (compute.modo === 'compute') {
    try {
      // O worker materializa a visão GLOBAL (hubs) — `no=null` (ignora semente).
      const payload = await computarGrafo(exercicio, null, saltos, compute.idToken);
      return NextResponse.json(payload, { headers: headersNoStore });
    } catch (err) {
      return NextResponse.json(
        { erro: err instanceof Error ? err.message : 'erro ao computar grafo' },
        { status: 502, headers: headersNoStore },
      );
    }
  }

  // ── MODO LEITURA (usuário) ───────────────────────────────────────────────────
  const sessao = await sessaoLeitura(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: headersNoStore },
    );
  }
  const idToken = sessao.idToken;

  // Snapshot-first APENAS na visão de hubs (sem semente) — é o que o worker
  // materializa. Com semente, a vizinhança é interativa e vai ao vivo (cacheada
  // por exercício na instância).
  if (!no) {
    try {
      const snap = await lerSnapshotPainel('grafo', '', exercicio, idToken, sessao.uid ?? undefined);
      if (snap) {
        return NextResponse.json(snap.payload, { headers: headersCache });
      }
    } catch {
      /* falha ao ler snapshot — cai no cômputo ao vivo abaixo */
    }
  }

  try {
    const resposta = await computarGrafo(exercicio, no, saltos, idToken);
    return NextResponse.json(resposta, { headers: headersCache });
  } catch (err) {
    return NextResponse.json(
      { erro: err instanceof Error ? err.message : 'erro ao ler nexo_links' },
      { status: 502, headers: headersNoStore },
    );
  }
}
