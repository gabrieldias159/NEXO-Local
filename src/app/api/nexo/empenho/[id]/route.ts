/**
 * GET /api/nexo/empenho/[id] — RAIO-X de UM empenho ("TUDO LINKADO").
 *
 * Lê um único doc de `nexo_empenhos/{id}` (id = docId do Firestore, o MESMO que
 * `nexo_links._de/_para` referenciam) e devolve TUDO sobre ele + os documentos
 * RELACIONADOS resolvidos a partir do grafo `nexo_links`:
 *   • contrato(s)        ← nexo_contratos_municipais   (aresta empenho-contrato)
 *   • licitação/edital/dispensa ← nexo_licitacoes      (aresta empenho-licitacao)
 *   • edição(ões) do DOM ← nexo_diario_dom             (aresta processo-dom)
 *   • despesa(s) TCE     ← nexo_tce_despesas           (aresta empenho-tce)
 *
 * ── COMO RESOLVE ─────────────────────────────────────────────────────────────
 * 1. Lê o empenho por docId (`lerDocNexo`). 404 → resposta `encontrado:false`.
 * 2. Normaliza (EmpenhoNorm) e descobre o EXERCÍCIO.
 * 3. Lê `nexo_links` do exercício e filtra as arestas cujo `_de` OU `_para`
 *    referencia ESTE empenho (`{colecao:'nexo_empenhos', id}`). Reaproveita o
 *    padrão de leitura do `/api/nexo/grafo`.
 * 4. Agrupa as pontas-alvo por coleção e lê cada coleção UMA vez (projeção),
 *    casando pelo `_docId`, montando um RESUMO por tipo + a confiança da aresta.
 *
 * ── DEGRADAÇÃO HONESTA (regra do dono) ───────────────────────────────────────
 * `nexo_links` vazio/sem aresta para este empenho NÃO é "sem vínculo": pode ser
 * o cron de linkage que não rodou ou não cruzou. Cada seção degrada sozinha
 * (`vinculos.disponivel` distingue "linkage indisponível" de "sem alvo casado").
 * Os processos do próprio empenho (admin/licitatório) vêm sempre — são campos
 * do doc, não dependem do grafo.
 *
 * Runtime nodejs. Rota protegida (sessão NEXO). Cache privado curto.
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo, lerDocNexo } from '@/lib/nexo/firestore-read';
import { filterModulo } from '@/lib/nexo/sources/smarapd';
import {
  normalizarEmpenhosFornecedor,
  parseValorBR,
  parseDataISO,
  soDigitos,
  type EmpenhoNorm,
} from '@/lib/nexo/normalizar';

export const runtime = 'nodejs';

const headersCache = { 'Cache-Control': 'private, max-age=60' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

// ── Contratos da resposta (exportados p/ a página tipar o consumo) ───────────

/** Selo da aresta de `nexo_links` que produziu um vínculo. */
export interface VinculoMeta {
  /** Tipo da aresta (empenho-contrato, empenho-licitacao, processo-dom, …). */
  tipo: string;
  /** Força do vínculo: 'forte' | 'media' | 'fraca' (ou '' se ausente). */
  confianca: string;
  /** Chave que produziu o vínculo (nº de processo/empenho/cnpj). */
  chave: string;
}

/** Resumo de um CONTRATO vinculado (nexo_contratos_municipais). */
export interface ContratoVinculado extends VinculoMeta {
  id: string;
  numeroContrato: string;
  numeroProcesso: string;
  objeto: string | null;
  fornecedorNome: string | null;
  valor: number | null;
  vigenciaInicio: string | null;
  vigenciaFim: string | null;
  /** true=vigente / false=encerrado / null=sem datas para inferir. */
  ativo: boolean | null;
}

/** Resumo de uma LICITAÇÃO/edital/dispensa vinculada (nexo_licitacoes). */
export interface LicitacaoVinculada extends VinculoMeta {
  id: string;
  numeroEdital: string;
  numeroProcesso: string;
  modalidade: string;
  /** 'edital' | 'dispensa' | 'inexigibilidade' | 'adesao' (derivado na coleta). */
  tipoLicitacao: string;
  objeto: string | null;
  situacao: string | null;
  dataAbertura: string | null;
  valorEstimado: number | null;
}

/** Resumo de uma edição do DOM vinculada (nexo_diario_dom). */
export interface DomVinculado extends VinculoMeta {
  id: string;
  titulo: string;
  edicao: string | null;
  data: string | null;
  urlPdf: string | null;
}

/** Resumo de uma despesa declarada ao TCE vinculada (nexo_tce_despesas). */
export interface TceVinculado extends VinculoMeta {
  id: string;
  nrEmpenho: string;
  cnpj: string;
  fornecedorNome: string | null;
  valor: number | null;
  data: string | null;
  unidadeGestora: string | null;
}

/** Processo do próprio empenho (sempre vem; não depende do grafo). */
export interface ProcessoEmpenho {
  numero: string;
  tipo: 'administrativo' | 'licitatorio';
}

/** Bloco de vínculos resolvidos do grafo `nexo_links`. */
export interface VinculosEmpenho {
  /** false quando `nexo_links` do exercício está vazio (linkage inativo). */
  disponivel: boolean;
  /** Explicação honesta quando `disponivel=false` ou sem aresta para o empenho. */
  motivo: string | null;
  /** nº de arestas que tocam ESTE empenho no exercício. */
  totalArestas: number;
  contratos: ContratoVinculado[];
  licitacoes: LicitacaoVinculada[];
  dom: DomVinculado[];
  tce: TceVinculado[];
}

export interface EmpenhoDetalheResponse {
  encontrado: boolean;
  /** Mensagem honesta quando `encontrado=false` (doc inexistente). */
  motivo: string | null;
  empenho: EmpenhoNorm | null;
  processos: ProcessoEmpenho[];
  vinculos: VinculosEmpenho;
  /** Itens do empenho (drill-down SMARAPD) — só presente quando `?itens=1`. */
  itens?: ItensEmpenho;
  atualizadoEm: string;
}

// ── Itens do empenho (drill-down `itensempenho`) ─────────────────────────────

/** Um item analítico do empenho (descrição, quantidade, valores). */
export interface EmpenhoItem {
  id: string;
  descricao: string;
  quantidade: number;
  valorUnitario: number;
  valorTotal: number;
}

/** Bloco de itens resolvidos pelo drill-down SMARAPD. */
export interface ItensEmpenho {
  /** false quando o drill-down não está disponível (sem link/sem itens). */
  disponivel: boolean;
  /** Explicação honesta quando `disponivel=false`. */
  motivo: string | null;
  /** ID da DespesaAgrupada usado no drill-down (`IDDespesa`). */
  idDespesa: string | null;
  itens: EmpenhoItem[];
  total: number;
}

// ── Helpers de leitura tipada (espelham o grafo) ─────────────────────────────

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s || null;
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = parseValorBR(v);
  return Number.isFinite(n) ? n : null;
}

function ref(v: unknown): { colecao: string; id: string } | null {
  if (v == null || typeof v !== 'object') return null;
  const r = v as { colecao?: unknown; id?: unknown };
  const colecao = str(r.colecao);
  const id = str(r.id);
  if (!colecao || !id) return null;
  return { colecao, id };
}

/** Infere vigência a partir das datas (hoje entre início e fim). null = sem base. */
function inferirAtivo(inicio: string | null, fim: string | null): boolean | null {
  if (!fim) return inicio ? true : null; // sem fim: assume vigente se há início
  const hoje = new Date().toISOString().slice(0, 10);
  if (inicio && hoje < inicio) return true; // ainda vai começar
  return hoje <= fim;
}

// ── Resolução dos alvos por coleção (1 leitura por coleção, casa por _docId) ──

/** Projeção lida de cada coleção-alvo — só os campos do resumo. */
const CAMPOS_ALVO: Record<string, string[]> = {
  nexo_contratos_municipais: [
    'numeroContrato', 'numeroProcesso', 'objeto', 'nomeContratada', '_fornecedor',
    'valor', '_valor', 'vigenciaInicio', 'vigenciaFim',
  ],
  nexo_licitacoes: [
    'numeroEdital', 'numeroProcesso', 'modalidade', 'tipo', 'objeto',
    'situacao', 'dataAbertura', 'valorEstimado',
  ],
  nexo_diario_dom: ['edicao', 'data', 'urlPdf', 'edicaoExtra'],
  nexo_tce_despesas: ['nrEmpenho', 'nrEmpenhoBruto', 'cnpj', 'nomeCredor', 'valor', 'data', 'ug'],
};

function mapContrato(d: Record<string, unknown>, m: VinculoMeta): ContratoVinculado {
  const vigInicio = parseDataISO(d.vigenciaInicio);
  const vigFim = parseDataISO(d.vigenciaFim);
  return {
    ...m,
    id: str(d._docId),
    numeroContrato: str(d.numeroContrato),
    numeroProcesso: str(d.numeroProcesso),
    objeto: strOrNull(d.objeto),
    fornecedorNome: strOrNull(d.nomeContratada ?? d._fornecedor),
    valor: numOrNull(d.valor ?? d._valor),
    vigenciaInicio: vigInicio,
    vigenciaFim: vigFim,
    ativo: inferirAtivo(vigInicio, vigFim),
  };
}

function mapLicitacao(d: Record<string, unknown>, m: VinculoMeta): LicitacaoVinculada {
  return {
    ...m,
    id: str(d._docId),
    numeroEdital: str(d.numeroEdital),
    numeroProcesso: str(d.numeroProcesso),
    modalidade: str(d.modalidade),
    tipoLicitacao: str(d.tipo),
    objeto: strOrNull(d.objeto),
    situacao: strOrNull(d.situacao),
    dataAbertura: parseDataISO(d.dataAbertura),
    valorEstimado: numOrNull(d.valorEstimado),
  };
}

function mapDom(d: Record<string, unknown>, m: VinculoMeta): DomVinculado {
  const edicao = strOrNull(d.edicao);
  const data = parseDataISO(d.data);
  const extra = d.edicaoExtra === true ? ' — extra' : '';
  const titulo = `DOM Marília ${edicao ? `nº ${edicao}` : '(s/ número)'}${data ? ` de ${data}` : ''}${extra}`;
  return {
    ...m,
    id: str(d._docId),
    titulo,
    edicao,
    data,
    urlPdf: strOrNull(d.urlPdf),
  };
}

function mapTce(d: Record<string, unknown>, m: VinculoMeta): TceVinculado {
  return {
    ...m,
    id: str(d._docId),
    nrEmpenho: str(d.nrEmpenhoBruto ?? d.nrEmpenho),
    cnpj: soDigitos(d.cnpj),
    fornecedorNome: strOrNull(d.nomeCredor),
    valor: numOrNull(d.valor),
    data: parseDataISO(d.data),
    unidadeGestora: strOrNull(d.ug),
  };
}

/** Campos lidos do empenho — mesma projeção da listagem (normalizador). */
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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: headersNoStore },
    );
  }
  const idToken = sessao.idToken;

  const { id: idBruto } = await params;
  const id = str(idBruto);
  if (!id) {
    return NextResponse.json(
      { erro: 'id do empenho ausente' },
      { status: 400, headers: headersNoStore },
    );
  }

  // 1. Lê o empenho por docId. 404 → resposta honesta `encontrado:false`.
  let docEmpenho: Record<string, unknown> | null;
  try {
    docEmpenho = await lerDocNexo(`nexo_empenhos/${encodeURIComponent(id)}`, idToken);
  } catch (err) {
    return NextResponse.json(
      { erro: err instanceof Error ? err.message : 'erro ao ler o empenho' },
      { status: 502, headers: headersNoStore },
    );
  }

  if (!docEmpenho) {
    const naoEncontrado: EmpenhoDetalheResponse = {
      encontrado: false,
      motivo:
        'Empenho não localizado em nexo_empenhos. O identificador pode estar ' +
        'incorreto, ou o empenho pertence a um exercício ainda não ingerido.',
      empenho: null,
      processos: [],
      vinculos: {
        disponivel: false,
        motivo: null,
        totalArestas: 0,
        contratos: [],
        licitacoes: [],
        dom: [],
        tce: [],
      },
      atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(naoEncontrado, { status: 404, headers: headersNoStore });
  }

  // 2. Normaliza. O exercício sai do próprio doc (campo cru) com fallback ao
  //    `_exercicio` carimbado pelo cron; se nada, ano corrente.
  const exercicioDoc =
    Math.trunc(Number(docEmpenho._exercicio)) ||
    Math.trunc(Number(docEmpenho.ExercEmpenho ?? docEmpenho.Exercicio)) ||
    new Date().getFullYear();
  const [empenho] = normalizarEmpenhosFornecedor([docEmpenho], exercicioDoc);
  // O docId é a identidade real no grafo — força-o como id do empenho.
  empenho.id = id;

  const processos: ProcessoEmpenho[] = [];
  if (empenho.processoAdministrativo) {
    processos.push({ numero: empenho.processoAdministrativo, tipo: 'administrativo' });
  }
  if (
    empenho.processoLicitatorio &&
    empenho.processoLicitatorio !== empenho.processoAdministrativo
  ) {
    processos.push({ numero: empenho.processoLicitatorio, tipo: 'licitatorio' });
  }

  // 3. Lê `nexo_links` do exercício e filtra as arestas que tocam este empenho.
  let links: Record<string, unknown>[];
  try {
    links = await lerColecaoNexo(
      'nexo_links',
      { exercicio: empenho.exercicio },
      idToken,
      ['_de', '_para', 'tipo', 'confianca', 'chave'],
    );
  } catch {
    // Linkage indisponível: degrada honesto, sem derrubar o detalhe do empenho.
    const semGrafo: EmpenhoDetalheResponse = {
      encontrado: true,
      motivo: null,
      empenho,
      processos,
      vinculos: {
        disponivel: false,
        motivo:
          'Não foi possível ler o grafo de vínculos (nexo_links) deste exercício. ' +
          'Os vínculos com contrato/licitação/DOM/TCE ficam indisponíveis nesta carga.',
        totalArestas: 0,
        contratos: [],
        licitacoes: [],
        dom: [],
        tce: [],
      },
      atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(semGrafo, { headers: headersCache });
  }

  // Grafo do exercício vazio → linkage não rodou/não cruzou.
  if (links.length === 0) {
    const grafoVazio: EmpenhoDetalheResponse = {
      encontrado: true,
      motivo: null,
      empenho,
      processos,
      vinculos: {
        disponivel: false,
        motivo:
          'O grafo de vínculos (nexo_links) está vazio para este exercício. O cron ' +
          'de linkage ainda não rodou para o período, ou não encontrou cruzamentos.',
        totalArestas: 0,
        contratos: [],
        licitacoes: [],
        dom: [],
        tce: [],
      },
      atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(grafoVazio, { headers: headersCache });
  }

  // Arestas cujo `_de` OU `_para` referencia ESTE empenho. A ponta-alvo é a
  // OUTRA extremidade (a que não é o empenho). Agrupa por coleção-alvo, e
  // guarda a meta da aresta (tipo/confiança/chave) por docId-alvo.
  const META_VAZIA: VinculoMeta = { tipo: '', confianca: '', chave: '' };
  // colecao → (docId-alvo → meta da aresta).
  const alvosPorColecao = new Map<string, Map<string, VinculoMeta>>();
  let totalArestas = 0;

  const registrarAlvo = (colecao: string, docId: string, meta: VinculoMeta) => {
    let m = alvosPorColecao.get(colecao);
    if (!m) {
      m = new Map();
      alvosPorColecao.set(colecao, m);
    }
    // Mantém a aresta de MAIOR confiança se o mesmo alvo casar mais de uma vez.
    const ordem: Record<string, number> = { forte: 3, media: 2, fraca: 1, '': 0 };
    const existente = m.get(docId);
    if (!existente || (ordem[meta.confianca] ?? 0) > (ordem[existente.confianca] ?? 0)) {
      m.set(docId, meta);
    }
  };

  for (const lk of links) {
    const de = ref(lk._de);
    const para = ref(lk._para);
    if (!de || !para) continue;
    const deEhEmp = de.colecao === 'nexo_empenhos' && de.id === id;
    const paraEhEmp = para.colecao === 'nexo_empenhos' && para.id === id;
    if (!deEhEmp && !paraEhEmp) continue;
    const alvo = deEhEmp ? para : de;
    // Ignora a própria ponta-empenho (e empenho↔empenho, que o linkage não gera).
    if (alvo.colecao === 'nexo_empenhos') continue;
    totalArestas++;
    registrarAlvo(alvo.colecao, alvo.id, {
      tipo: str(lk.tipo),
      confianca: str(lk.confianca),
      chave: str(lk.chave),
    });
  }

  // 4. Resolve os alvos: 1 leitura por coleção (projeção), casa por _docId.
  const contratos: ContratoVinculado[] = [];
  const licitacoes: LicitacaoVinculada[] = [];
  const dom: DomVinculado[] = [];
  const tce: TceVinculado[] = [];

  await Promise.all(
    [...alvosPorColecao.entries()].map(async ([colecao, alvos]) => {
      const campos = CAMPOS_ALVO[colecao];
      if (!campos) return; // coleção-alvo não suportada no resumo
      try {
        // nexo_tce_despesas/contratos/licitacoes carregam `_exercicio`; lê filtrado.
        const docs = await lerColecaoNexo(colecao, { exercicio: empenho.exercicio }, idToken, campos);
        for (const d of docs) {
          const docId = str(d._docId);
          const meta = alvos.get(docId);
          if (!meta) continue;
          if (colecao === 'nexo_contratos_municipais') contratos.push(mapContrato(d, meta));
          else if (colecao === 'nexo_licitacoes') licitacoes.push(mapLicitacao(d, meta));
          else if (colecao === 'nexo_diario_dom') dom.push(mapDom(d, meta));
          else if (colecao === 'nexo_tce_despesas') tce.push(mapTce(d, meta));
        }
      } catch {
        /* coleção-alvo indisponível — essa seção fica vazia (degrada sozinha) */
      }
    }),
  );

  // Ordena cada seção: confiança desc, depois data/numero quando houver.
  const ordemConf: Record<string, number> = { forte: 3, media: 2, fraca: 1, '': 0 };
  const porConf = (a: VinculoMeta, b: VinculoMeta) =>
    (ordemConf[b.confianca] ?? 0) - (ordemConf[a.confianca] ?? 0);
  contratos.sort((a, b) => porConf(a, b) || (b.valor ?? 0) - (a.valor ?? 0));
  licitacoes.sort((a, b) => porConf(a, b) || (b.dataAbertura ?? '').localeCompare(a.dataAbertura ?? ''));
  dom.sort((a, b) => porConf(a, b) || (b.data ?? '').localeCompare(a.data ?? ''));
  tce.sort((a, b) => porConf(a, b) || (b.valor ?? 0) - (a.valor ?? 0));

  const semAresta = totalArestas === 0;
  const resposta: EmpenhoDetalheResponse = {
    encontrado: true,
    motivo: null,
    empenho,
    processos,
    vinculos: {
      disponivel: true,
      motivo: semAresta
        ? 'O grafo existe para este exercício, mas nenhuma aresta cruzou ESTE ' +
          'empenho (sem contrato/licitação/DOM/TCE casado pelas chaves de processo/empenho).'
        : null,
      totalArestas,
      contratos,
      licitacoes,
      dom,
      tce,
    },
    atualizadoEm: new Date().toISOString(),
  };
  return NextResponse.json(resposta, { headers: headersCache });
}
