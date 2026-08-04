/**
 * GET /api/nexo/contrato/[id] — FICHA DE EXECUÇÃO de UM contrato ("TUDO LINKADO").
 *
 * Dado o `id` de um contrato em `nexo_contratos_municipais` (o docId do
 * Firestore, ex.: `2026-100`), devolve a CADEIA cruzada da contratação:
 *   • identificação do contrato (objeto, contratada, valor, vigência);
 *   • ORIGEM — edital/licitação/dispensa de mesmo nº de processo (nexo_licitacoes);
 *   • EXECUÇÃO FINANCEIRA — TODOS os empenhos do mesmo processo (nexo_empenhos),
 *     com soma de empenhado/liquidado-pago e % do valor contratado;
 *   • ADITIVOS — NÃO coletados na base atual (ver §DATA-BLOCKED);
 *   • MEDIÇÕES físicas — NÃO publicadas por Marília (ver §DATA-BLOCKED);
 *   • VÍNCULOS do grafo `nexo_links` que tocam este contrato.
 *
 * ── CHAVE DE CASAMENTO (empírico, jun/2026) ──────────────────────────────────
 * O `numeroProcesso` do contrato (Dados Abertos) é o NÚMERO PURO do processo, SEM
 * ano (ex.: "47", "002", "90045"). O processo do empenho (SMARAPD) vem como
 * "NUM / ANO" (ex.: "32 / 2018", às vezes só "/ 2026"). Por isso casamos por
 * (número-do-processo + ano==exercício do contrato) — `chaveProcExercicio`.
 *
 * ── HONESTIDADE RADICAL (regra do dono) ──────────────────────────────────────
 * Esse `numeroProcesso` é de BAIXA CARDINALIDADE: vários contratos distintos
 * compartilham o mesmo número de processo num exercício, e ele NÃO é um protocolo
 * único. Logo o casamento contrato↔empenho é INDÍCIO A APURAR, podendo SUPER-
 * COLETAR empenhos que pertencem a outro contrato do mesmo processo. A resposta
 * sinaliza isso (`execucao.ambiguo`, `execucao.confianca`) — nunca afirma certeza.
 * Cada seção degrada sozinha; nada é inventado.
 *
 * Runtime nodejs. Rota protegida (sessão NEXO). Cache privado curto.
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo, lerDocNexo } from '@/lib/nexo/firestore-read';
import { parseValorBR, parseDataISO, soDigitos } from '@/lib/nexo/normalizar';

export const runtime = 'nodejs';

const headersCache = { 'Cache-Control': 'private, max-age=60' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

// ── Tipos da resposta (exportados p/ a página tipar o consumo) ────────────────

export interface ContratoIdent {
  id: string;
  numeroContrato: string;
  numeroProcesso: string;
  exercicio: number;
  objeto: string | null;
  fornecedorNome: string | null;
  /** CNPJ (14) ou CPF (11) só-dígitos, quando o contrato foi enriquecido. */
  fornecedorDoc: string | null;
  valor: number | null;
  vigenciaInicio: string | null;
  vigenciaFim: string | null;
  /** true=vigente / false=encerrado / null=sem datas. */
  ativo: boolean | null;
  fonte: string;
  /** PDF do contrato, quando o enriquecimento SMARAPD o resolveu. */
  pdfUrl: string | null;
}

/** Resumo de uma licitação/edital/dispensa de origem (mesmo nº de processo). */
export interface OrigemLicitacao {
  id: string;
  numeroEdital: string;
  numeroProcesso: string;
  modalidade: string;
  tipoLicitacao: string;
  objeto: string | null;
  situacao: string | null;
  dataAbertura: string | null;
  valorEstimado: number | null;
}

/** Um empenho do processo (resumo p/ a ficha de execução). */
export interface EmpenhoExec {
  id: string;
  numeroEmpenho: string;
  data: string | null;
  fornecedorNome: string | null;
  cnpj: string | null;
  valorEmpenhado: number;
  valorPago: number;
  temLiquidacao: boolean;
  processo: string;
}

/** Bloco de execução financeira (somatórios + % do valor contratado). */
export interface ExecucaoFinanceira {
  /** false quando não foi possível ler nexo_empenhos do exercício. */
  disponivel: boolean;
  motivo: string | null;
  /** Empenhos casados por (nº de processo + ano). */
  empenhos: EmpenhoExec[];
  totalEmpenhos: number;
  somaEmpenhado: number;
  somaPago: number;
  /** Valor contratado (do próprio contrato), p/ comparar. */
  valorContratado: number | null;
  /** somaEmpenhado / valorContratado * 100 (null se sem valor). */
  percentualEmpenhado: number | null;
  /** somaPago / valorContratado * 100 (null se sem valor). */
  percentualPago: number | null;
  /** Empenhado excede o contratado (indício de estouro/aditivo não capturado). */
  estouro: boolean;
  /** O nº de processo casa MAIS DE UM contrato no exercício (super-coleta). */
  ambiguo: boolean;
  /** 'media' por padrão (casa por processo+ano); 'fraca' quando ambíguo. */
  confianca: 'media' | 'fraca' | 'nenhuma';
}

export interface VinculoContrato {
  id: string;
  colecao: string;
  tipo: string;
  confianca: string;
  chave: string;
}

/** Seção que existe na fonte mas ainda não é coletada / ou é data-blocked. */
export interface SecaoIndisponivel {
  disponivel: false;
  motivo: string;
}

export interface ContratoFichaResponse {
  encontrado: boolean;
  motivo: string | null;
  contrato: ContratoIdent | null;
  origem: OrigemLicitacao[];
  execucao: ExecucaoFinanceira;
  aditivos: SecaoIndisponivel;
  medicoes: SecaoIndisponivel;
  vinculos: VinculoContrato[];
  atualizadoEm: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Chave de processo do CONTRATO: número puro (sem ano, sem zeros à esquerda) +
 * exercício. Ex.: contrato proc "047" no exercício 2026 → "47|2026".
 */
function chaveContratoProc(numeroProcesso: unknown, exercicio: number): string {
  const num = soDigitos(numeroProcesso).replace(/^0+/, '');
  return num ? `${num}|${exercicio}` : '';
}

/**
 * Chaves de processo do EMPENHO: extrai (número, ano) dos campos de processo
 * "NUM / ANO" do SMARAPD. Quando o ano não vem no campo, usa o exercício do
 * empenho. Devolve as chaves "num|ano" para casar com `chaveContratoProc`.
 */
function chavesEmpenhoProc(rec: Record<string, unknown>, exercicioEmp: number): string[] {
  const campos = [
    rec.NroProcessoAdminEmpenho,
    rec.NroProcessoAdmin,
    rec.ProcessoAdministrativo,
    rec.ProcessoLicitatorio,
    rec.NroLicitacao,
  ];
  const chaves = new Set<string>();
  for (const raw of campos) {
    const s = str(raw).replace(/\s+/g, '');
    if (!s) continue;
    // "32/2018", "/2026", "12.345/2026"
    const m = s.match(/^(\d*)\/?(\d{4})?$/) ?? s.match(/(\d+)\D+(\d{4})/);
    if (!m) continue;
    const num = (m[1] ?? '').replace(/\D/g, '').replace(/^0+/, '');
    if (!num) continue;
    const ano = m[2] ?? String(exercicioEmp);
    chaves.add(`${num}|${ano}`);
  }
  return [...chaves];
}

function inferirAtivo(inicio: string | null, fim: string | null): boolean | null {
  if (!fim) return inicio ? true : null;
  const hoje = new Date().toISOString().slice(0, 10);
  if (inicio && hoje < inicio) return true;
  return hoje <= fim;
}

function ref(v: unknown): { colecao: string; id: string } | null {
  if (v == null || typeof v !== 'object') return null;
  const r = v as { colecao?: unknown; id?: unknown };
  const colecao = str(r.colecao);
  const id = str(r.id);
  if (!colecao || !id) return null;
  return { colecao, id };
}

/** Projeção dos empenhos — só o necessário p/ a ficha. */
const CAMPOS_EMPENHO = [
  'NroEmpenho', 'NumeroEmpenho', 'NumEmpenho',
  'NroProcessoAdminEmpenho', 'NroProcessoAdmin', 'ProcessoAdministrativo',
  'ProcessoLicitatorio', 'NroLicitacao',
  'ValorEmpenho', 'ValorEmpenhado', 'ValorLiquidoPago', 'ValorPago',
  'NroLiquidacao', 'NumeroLiquidacao',
  'NomeFornecedor', 'Fornecedor', '_fornecedor',
  'CPFCNPJ', 'CNPJ', 'CpfCnpj', '_cnpj',
  'DataMovimentoEmpenho', 'DataEmp', 'DataMovEmp', 'Data',
  'ExercEmpenho', 'Exercicio',
];

const CAMPOS_LICITACAO = [
  'numeroEdital', 'numeroProcesso', 'modalidade', 'tipo', 'objeto',
  'situacao', 'dataAbertura', 'valorEstimado',
];

const CAMPOS_CONTRATO_PROC = ['numeroProcesso', '_numeroProcesso'];

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
      { erro: 'id do contrato ausente' },
      { status: 400, headers: headersNoStore },
    );
  }

  // 1. Lê o contrato por docId. 404 → resposta honesta `encontrado:false`.
  let docContrato: Record<string, unknown> | null;
  try {
    docContrato = await lerDocNexo(
      `nexo_contratos_municipais/${encodeURIComponent(id)}`,
      idToken,
    );
  } catch (err) {
    return NextResponse.json(
      { erro: err instanceof Error ? err.message : 'erro ao ler o contrato' },
      { status: 502, headers: headersNoStore },
    );
  }

  const aditivosBlocked: SecaoIndisponivel = {
    disponivel: false,
    motivo:
      'Aditivos são publicados na página de detalhe do contrato no portal SMARAPD ' +
      '(/portal/contrato/{id}: número, ano, data de assinatura, vigência e PDF — sem ' +
      'valor itemizado por aditivo), mas ainda NÃO são coletados pela base do NEXO. ' +
      'Requer um coletor dedicado (ver relatório).',
  };
  const medicoesBlocked: SecaoIndisponivel = {
    disponivel: false,
    motivo:
      'Medições físicas (boletins/atestos/percentual de execução física) NÃO são ' +
      'publicadas por Marília em nenhuma fonte aberta verificada (Dados Abertos, ' +
      'página de detalhe do contrato, portal de obras). A execução aqui é a ' +
      'FINANCEIRA (empenho → liquidação → pago), que é real e disponível.',
  };

  if (!docContrato) {
    const naoEncontrado: ContratoFichaResponse = {
      encontrado: false,
      motivo:
        'Contrato não localizado em nexo_contratos_municipais. O identificador pode ' +
        'estar incorreto, ou pertence a um exercício ainda não ingerido.',
      contrato: null,
      origem: [],
      execucao: {
        disponivel: false,
        motivo: null,
        empenhos: [],
        totalEmpenhos: 0,
        somaEmpenhado: 0,
        somaPago: 0,
        valorContratado: null,
        percentualEmpenhado: null,
        percentualPago: null,
        estouro: false,
        ambiguo: false,
        confianca: 'nenhuma',
      },
      aditivos: aditivosBlocked,
      medicoes: medicoesBlocked,
      vinculos: [],
      atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(naoEncontrado, { status: 404, headers: headersNoStore });
  }

  const exercicio =
    Math.trunc(Number(docContrato._exercicio)) ||
    Number(String(id).match(/^(\d{4})/)?.[1]) ||
    new Date().getFullYear();

  const numeroProcesso = str(docContrato.numeroProcesso ?? docContrato._numeroProcesso);
  const vigInicio = parseDataISO(docContrato.vigenciaInicio);
  const vigFim = parseDataISO(docContrato.vigenciaFim);
  const valorContrato = numOrNull(docContrato.valor ?? docContrato._valor);

  const contrato: ContratoIdent = {
    id,
    numeroContrato: str(docContrato.numeroContrato),
    numeroProcesso,
    exercicio,
    objeto: strOrNull(docContrato.objeto),
    fornecedorNome: strOrNull(docContrato.nomeContratada ?? docContrato._fornecedor),
    fornecedorDoc: strOrNull(soDigitos(docContrato.cnpjContratada ?? docContrato._cnpj)),
    valor: valorContrato,
    vigenciaInicio: vigInicio,
    vigenciaFim: vigFim,
    ativo: inferirAtivo(vigInicio, vigFim),
    fonte: str(docContrato._fonte) || 'dados-abertos',
    pdfUrl: strOrNull(docContrato.pdfContratoUrl),
  };

  const chaveProc = chaveContratoProc(numeroProcesso, exercicio);

  // 2./3./4. Em paralelo: empenhos do exercício, licitações do exercício e o
  //    grafo de vínculos. Cada um degrada sozinho.
  const [empenhosRes, licitacoesRes, linksRes, contratosProcRes] = await Promise.allSettled([
    lerColecaoNexo('nexo_empenhos', { exercicio }, idToken, CAMPOS_EMPENHO),
    lerColecaoNexo('nexo_licitacoes', { exercicio }, idToken, CAMPOS_LICITACAO),
    lerColecaoNexo('nexo_links', { exercicio }, idToken, ['_de', '_para', 'tipo', 'confianca', 'chave']),
    // Para detectar ambiguidade: quantos contratos do exercício têm o MESMO processo.
    lerColecaoNexo('nexo_contratos_municipais', { exercicio }, idToken, CAMPOS_CONTRATO_PROC),
  ]);

  // ── Execução financeira (empenhos por processo+ano) ────────────────────────
  const execucao: ExecucaoFinanceira = {
    disponivel: false,
    motivo: null,
    empenhos: [],
    totalEmpenhos: 0,
    somaEmpenhado: 0,
    somaPago: 0,
    valorContratado: valorContrato,
    percentualEmpenhado: null,
    percentualPago: null,
    estouro: false,
    ambiguo: false,
    confianca: 'nenhuma',
  };

  // Ambiguidade: o mesmo nº de processo aparece em mais de um contrato?
  if (chaveProc && contratosProcRes.status === 'fulfilled') {
    let mesmaChave = 0;
    for (const c of contratosProcRes.value) {
      const k = chaveContratoProc(c.numeroProcesso ?? c._numeroProcesso, exercicio);
      if (k && k === chaveProc) mesmaChave++;
    }
    execucao.ambiguo = mesmaChave > 1;
  }

  if (!chaveProc) {
    execucao.motivo =
      'O contrato não traz número de processo — sem chave para casar empenhos.';
  } else if (empenhosRes.status !== 'fulfilled') {
    execucao.motivo =
      'Não foi possível ler nexo_empenhos deste exercício. A execução financeira ' +
      'fica indisponível nesta carga.';
  } else {
    execucao.disponivel = true;
    const empenhos: EmpenhoExec[] = [];
    let somaEmp = 0;
    let somaPago = 0;
    for (const e of empenhosRes.value) {
      const exercicioEmp =
        Math.trunc(Number(e._exercicio)) ||
        Math.trunc(Number(e.ExercEmpenho ?? e.Exercicio)) ||
        exercicio;
      const chaves = chavesEmpenhoProc(e, exercicioEmp);
      if (!chaves.includes(chaveProc)) continue;
      const valorEmpenhado = parseValorBR(e.ValorEmpenho ?? e.ValorEmpenhado);
      const valorPago = parseValorBR(e.ValorLiquidoPago ?? e.ValorPago);
      somaEmp += valorEmpenhado;
      somaPago += valorPago;
      empenhos.push({
        id: str(e._docId),
        numeroEmpenho: str(e.NroEmpenho ?? e.NumeroEmpenho ?? e.NumEmpenho),
        data: parseDataISO(e.DataMovimentoEmpenho ?? e.DataEmp ?? e.DataMovEmp ?? e.Data),
        fornecedorNome: strOrNull(e.NomeFornecedor ?? e.Fornecedor ?? e._fornecedor),
        cnpj: strOrNull(soDigitos(e.CPFCNPJ ?? e.CNPJ ?? e.CpfCnpj ?? e._cnpj)),
        valorEmpenhado,
        valorPago,
        temLiquidacao: !!str(e.NroLiquidacao ?? e.NumeroLiquidacao),
        processo: str(e.NroProcessoAdminEmpenho ?? e.ProcessoLicitatorio),
      });
    }
    // Empenhos mais recentes/maiores primeiro.
    empenhos.sort(
      (a, b) =>
        (b.data ?? '').localeCompare(a.data ?? '') || b.valorEmpenhado - a.valorEmpenhado,
    );
    execucao.empenhos = empenhos;
    execucao.totalEmpenhos = empenhos.length;
    execucao.somaEmpenhado = somaEmp;
    execucao.somaPago = somaPago;
    if (valorContrato != null && valorContrato > 0) {
      execucao.percentualEmpenhado = (somaEmp / valorContrato) * 100;
      execucao.percentualPago = (somaPago / valorContrato) * 100;
      execucao.estouro = somaEmp > valorContrato;
    }
    execucao.confianca = empenhos.length === 0 ? 'nenhuma' : execucao.ambiguo ? 'fraca' : 'media';
    if (empenhos.length === 0) {
      execucao.motivo =
        'Nenhum empenho do exercício casou o número de processo deste contrato. ' +
        'Pode não haver execução ainda, ou o processo divergir entre as fontes.';
    }
  }

  // ── Origem: licitações/dispensas de mesmo nº de processo ───────────────────
  const origem: OrigemLicitacao[] = [];
  if (chaveProc && licitacoesRes.status === 'fulfilled') {
    for (const l of licitacoesRes.value) {
      const k = chaveContratoProc(l.numeroProcesso ?? l._numeroProcesso, exercicio);
      if (k !== chaveProc) continue;
      origem.push({
        id: str(l._docId),
        numeroEdital: str(l.numeroEdital),
        numeroProcesso: str(l.numeroProcesso),
        modalidade: str(l.modalidade),
        tipoLicitacao: str(l.tipo),
        objeto: strOrNull(l.objeto),
        situacao: strOrNull(l.situacao),
        dataAbertura: parseDataISO(l.dataAbertura),
        valorEstimado: numOrNull(l.valorEstimado),
      });
    }
  }

  // ── Vínculos do grafo que tocam ESTE contrato ──────────────────────────────
  const vinculos: VinculoContrato[] = [];
  if (linksRes.status === 'fulfilled') {
    for (const lk of linksRes.value) {
      const de = ref(lk._de);
      const para = ref(lk._para);
      if (!de || !para) continue;
      const deEh = de.colecao === 'nexo_contratos_municipais' && de.id === id;
      const paraEh = para.colecao === 'nexo_contratos_municipais' && para.id === id;
      if (!deEh && !paraEh) continue;
      const alvo = deEh ? para : de;
      if (alvo.colecao === 'nexo_contratos_municipais') continue;
      vinculos.push({
        id: alvo.id,
        colecao: alvo.colecao,
        tipo: str(lk.tipo),
        confianca: str(lk.confianca),
        chave: str(lk.chave),
      });
    }
  }

  const resposta: ContratoFichaResponse = {
    encontrado: true,
    motivo: null,
    contrato,
    origem,
    execucao,
    aditivos: aditivosBlocked,
    medicoes: medicoesBlocked,
    vinculos,
    atualizadoEm: new Date().toISOString(),
  };
  return NextResponse.json(resposta, { headers: headersCache });
}
