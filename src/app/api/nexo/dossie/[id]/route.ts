/**
 * GET /api/nexo/dossie/{id} — DOSSIÊ "TUDO LINKADO" (case file COMPREENSIVO) de
 * uma entidade/documento.
 *
 * Esta é a página-destino do entity-chip: ao clicar num CNPJ ou CPF, o usuário
 * cai aqui e vê TUDO o que a base do NEXO sabe sobre aquele documento/nome —
 * cruza tudo, lista tudo, encontra tudo, sempre como INDÍCIO A APURAR. Consolida
 * num único documento citável:
 *   1. Identificação      — `nexo_entidades` (raio-x consolidado);
 *   2. Cadastrais (PJ)    — `getCnpj` (BrasilAPI/minhareceita: razão social,
 *                           situação, CNAE, capital, abertura, QSA cadastral);
 *   3. Score de risco     — `nexo_scores` (com fatores explicáveis);
 *   4. Sanções            — `nexo_sancoes` (CEIS/CNEP/CEPIM federal) +
 *                           `nexo_sancoes_estaduais` (TCE-SP apenados) +
 *                           `nexo_leniencia` (CGU) +
 *                           `nexo_contas_irregulares` (TCE Ficha Limpa, por NOME);
 *   5. Sócios/vinculados  — `nexo_socios` (QSA p/ CNPJ; REVERSE p/ CPF: em quais
 *                           CNPJs o cpfHash aparece — grupo econômico da pessoa);
 *   6. Doações eleitorais — `nexo_doacoes_tse` (por docHashDoador), TODOS os anos
 *                           — GUARDRAIL: doação é lícita; "vínculo a apurar";
 *   7. Vínculos           — `nexo_links` (empenho/contrato/licitação/DOM/TCE);
 *   8. Alertas/indícios   — `nexo_alertas` da entidade.
 *
 * ── O `id` ────────────────────────────────────────────────────────────────────
 *   • 14 dígitos válidos (Módulo 11) → CNPJ. Dado PÚBLICO de PJ: trafega na URL.
 *     A entidade é resolvida pela RAIZ (8 díg) — `nexo_entidades._id`.
 *   • 64 hex ([0-9a-f]) → HASH irreversível de CPF/CNPJ (de `hashDoc`). É como o
 *     CPF chega aqui: o NÚMERO NUNCA entra na URL (LGPD). O servidor casa o hash
 *     contra `hashDoc(e.doc)` de cada perfil para descobrir QUAL entidade é —
 *     e, achando-a, recupera o doc cru DELA (que está em `nexo_entidades`, já
 *     ingerido) para poder cruzar as demais coleções e exibir o doc completo na
 *     tela (decisão do dono p/ este sistema interno de fiscalização/LAI). O hash
 *     NUNCA é re-hasheado.
 *   • caso contrário → id canônico de entidade (rótulo do nome).
 *   • 11 dígitos (CPF cru) → 400 (CPF cru NUNCA na URL).
 *
 * ── HONESTIDADE POR SEÇÃO (degradação graciosa) ──────────────────────────────
 * Cada coleção pode estar VAZIA ou ESPARSA (o cron correspondente ainda não
 * rodou; doações_tse só tem anos eleitorais de backfill; sanções podem estar em
 * recoleta). Cada seção carrega seu próprio `disponivel`/`motivo` — o dossiê
 * nunca mente "nada encontrado" quando o que faltou foi o pipeline. Falha de
 * leitura de uma seção AUXILIAR degrada essa seção (não derruba o dossiê); só a
 * falha de `nexo_entidades` (a identificação) é fatal (502).
 *
 * ── PRINCÍPIO LGPD/JURÍDICO ───────────────────────────────────────────────────
 * Tudo aqui é INDÍCIO A APURAR, NUNCA acusação. CPF cru fora da URL (só o hash);
 * CNPJ (PJ) é público. Doação eleitoral é LÍCITA e PÚBLICA — classificada no
 * máximo como "atenção", nunca acusação. Cada seção cita sua fonte.
 *
 * Runtime nodejs. Cache privado ~5 min (dado gated por sessão de usuário ativo).
 */
import { NextResponse } from 'next/server';
import { cnpj as cnpjValidator } from 'cpf-cnpj-validator';
import {
  avaliarCompute,
  sessaoLeitura,
  lerSnapshotPainel,
} from '@/lib/nexo/compute-guard';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import { mascararDoc } from '@/lib/nexo/normalizar';
import { hashDoc } from '@/lib/nexo/pii';
import { cnpjRaiz, rotuloCanonico } from '@/lib/nexo/entidades';
import { getCnpj, type CnpjInfo } from '@/lib/nexo/sources/cnpj';
import type { Procedencia } from '@/lib/nexo/detectores/tipos';

export const runtime = 'nodejs';

const headersCache = { 'Cache-Control': 'private, max-age=300' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;
const TTL_MS = 5 * 60 * 1000;
/** Tetos de itens devolvidos — limita o payload do dossiê em coleções grandes. */
const MAX_ALERTAS = 60;
const MAX_VINCULOS = 120;
const MAX_SANCOES_ITENS = 40;
const MAX_SOCIOS = 60;
const MAX_DOACOES = 80;
const MAX_CONTAS = 20;

// ── Contratos da resposta (exportados p/ a página tipar o consumo) ───────────

/** Como o `id` foi interpretado. */
export type TipoIdDossie = 'cnpj' | 'hash' | 'entidade';

/** Seção IDENTIFICAÇÃO — o raio-x de `nexo_entidades`. */
export interface DossieIdentificacao {
  disponivel: boolean;
  /** Explicação honesta quando `disponivel=false` (entidade não perfilada). */
  motivo: string | null;
  /** Id canônico da entidade (`_id` de `nexo_entidades`) — base dos vínculos. */
  entidadeId: string | null;
  nome: string | null;
  tipo: 'empresa' | 'pessoa' | 'orgao' | null;
  /** Doc por extenso p/ EXIBIÇÃO (CNPJ e — fisc. interna/LAI — CPF completos). */
  docExibicao: string | null;
  /** Doc mascarado (fallback de exibição / quando não há doc cru). */
  docMascarado: string | null;
  /** CNPJ cru (14 díg) quando houver — só PJ (dado público); null p/ pessoa. */
  cnpj: string | null;
  /** true quando a entidade é pessoa física (cruzamento por hash/QSA reverso). */
  pessoaFisica: boolean;
  totalEmpenhado: number;
  nEmpenhos: number;
  nContratos: number;
  contratosAtivos: number;
  nLicitacoes: number;
  nVinculos: number;
  sancionado: boolean;
  nSancoes: number;
  flags: string[];
  objetos: string[];
  secretarias: string[];
  primeiroVisto: string | null;
  ultimoVisto: string | null;
  exercicios: number[];
}

/** Seção CADASTRAIS (só CNPJ) — enriquecimento da Receita via BrasilAPI. */
export interface DossieCadastrais {
  disponivel: boolean;
  motivo: string | null;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  situacaoCadastral: string | null;
  dataAbertura: string | null;
  uf: string | null;
  municipio: string | null;
  cnaePrincipal: string | null;
  cnaeDescricao: string | null;
  capitalSocial: number | null;
  /** QSA cadastral (Receita) — nome + qualificação (sem CPF). */
  socios: { nome: string; qualificacao: string }[];
}

/** Um fator explicável do score (espelha `nexo_scores.fatores`). */
export interface DossieFator {
  id: string;
  rotulo: string;
  peso: number;
  valorBruto: number;
  contribuicao: number;
  evidencia: string;
}

/** Seção SCORE — de `nexo_scores` (pode estar pendente até o cron rodar). */
export interface DossieScore {
  disponivel: boolean;
  /** 'pendente' quando o doc de score não existe; 'ok' quando há. */
  motivo: string | null;
  score: number | null;
  nivel: 'baixo' | 'medio' | 'alto' | 'critico' | null;
  fatores: DossieFator[];
  nAlertas: number | null;
  ultimaDeteccaoEm: string | null;
  /** Disclaimer canônico embutido pelo cron (índice de priorização). */
  disclaimer: string | null;
  versaoPesos: number | null;
  atualizadoEm: string | null;
}

/** Uma sanção/apenação/acordo detalhado (shape unificado das fontes). */
export interface DossieSancaoItem {
  /** Esfera/fonte: 'federal' (CEIS/CNEP/CEPIM), 'estadual' (TCE-SP), 'leniencia'. */
  esfera: 'federal' | 'estadual' | 'leniencia';
  /** Cadastro/origem (CEIS, CNEP, CEPIM, TCE-SP-APENADOS, CGU…). */
  cadastro: string;
  tipoSancao: string;
  orgaoSancionador: string;
  dataInicio: string | null;
  dataFim: string | null;
  fundamentacao: string;
  /** Situação (só leniência: "Acordo em vigência", etc.). */
  situacao: string | null;
}

/** Um registro de "contas julgadas irregulares" (TCE-SP, por NOME). */
export interface DossieContaIrregular {
  nome: string;
  cpfMasc: string;
  processoTC: string;
  exercicio: number | null;
  origem: string;
  materia: string;
  transitoJulgado: string;
}

/** Seção SANÇÕES — federal + estadual + leniência + contas irregulares. */
export interface DossieSancoes {
  disponivel: boolean;
  motivo: string | null;
  /** Consolidação: tem ALGUMA sanção/apenação/acordo? */
  sancionado: boolean;
  /** true quando o casamento de CNPJ foi por raiz (8 díg), não exato. */
  porRaiz: boolean;
  nFederal: number;
  nEstadual: number;
  nLeniencia: number;
  itens: DossieSancaoItem[];
  /** Contas julgadas irregulares (TCE-SP) casadas por NOME — vínculo a apurar. */
  contasIrregulares: DossieContaIrregular[];
  /** Honestidade por sub-fonte (degrada independente). */
  fontes: {
    federal: { disponivel: boolean; motivo: string | null };
    estadual: { disponivel: boolean; motivo: string | null };
    leniencia: { disponivel: boolean; motivo: string | null };
    contasIrregulares: { disponivel: boolean; motivo: string | null };
  };
}

/** Um sócio/pessoa vinculada (QSA direto, ou CNPJ do grupo no reverse). */
export interface DossieSocio {
  /** Para QSA: nome do sócio. Para reverse: razão social do CNPJ-sócio-de. */
  nome: string;
  qualificacao: string;
  /** Máscara do doc do sócio (QSA) — nunca o CPF cru. */
  cpfMasc: string | null;
  /** Reverse (CPF): o CNPJ em que a pessoa é sócia (deep-link p/ dossiê do CNPJ). */
  cnpjVinculado: string | null;
}

/** Seção SÓCIOS / pessoas vinculadas. */
export interface DossieSocios {
  disponivel: boolean;
  motivo: string | null;
  /** 'qsa' (CNPJ → seus sócios) | 'reverse' (CPF → CNPJs onde é sócio). */
  modo: 'qsa' | 'reverse' | null;
  total: number;
  truncado: boolean;
  itens: DossieSocio[];
}

/** Uma doação eleitoral (TSE) — dado público, vínculo a apurar. */
export interface DossieDoacao {
  ano: number;
  candidato: string;
  cargo: string;
  partido: string;
  municipio: string;
  uf: string;
  valor: number;
}

/** Seção DOAÇÕES eleitorais — de `nexo_doacoes_tse` por docHashDoador. */
export interface DossieDoacoes {
  disponivel: boolean;
  motivo: string | null;
  total: number;
  truncado: boolean;
  valorTotal: number;
  /** Anos eleitorais em que há doação (ordenado desc). */
  anos: number[];
  itens: DossieDoacao[];
}

/** Um alerta/indício associado à entidade (projeção de `nexo_alertas`). */
export interface DossieAlerta {
  detectorId: string;
  detectorNome: string;
  categoria: string;
  titulo: string;
  classificacao: 'informativo' | 'atencao' | 'suspeita' | 'critico';
  valorEnvolvido: number;
  explicacao: string;
  fundamentoLegal: string[];
  status: string;
  ultimaDeteccaoEm: string | null;
}

/** Seção ALERTAS — indícios ativos da entidade. */
export interface DossieAlertas {
  disponivel: boolean;
  motivo: string | null;
  total: number;
  /** Contagem por severidade (do recorte total, antes do teto MAX_ALERTAS). */
  porClassificacao: Record<'informativo' | 'atencao' | 'suspeita' | 'critico', number>;
  itens: DossieAlerta[];
}

/** Um vínculo do grafo — o doc-alvo (a outra ponta) + metadados da aresta. */
export interface DossieVinculo {
  /** Id composto `<colecao>:<docId>` do nó-alvo (deep-link p/ o grafo). */
  no: string;
  /** Coleção `nexo_*` do alvo (empenho/contrato/licitacao/dom/tce/documento). */
  colecao: string;
  /** Tipo da aresta (empenho-contrato, processo-dom, doc…). */
  tipo: string;
  confianca: string;
  /** Chave que produziu o vínculo (nº de processo/empenho/cnpj). */
  chave: string;
}

/** Seção VÍNCULOS — a vizinhança no grafo TUDO-LINKADO. */
export interface DossieVinculos {
  disponivel: boolean;
  motivo: string | null;
  /** Nó-semente usado (id composto), null quando não há semente resolvível. */
  semente: string | null;
  total: number;
  /** true quando a lista foi truncada por MAX_VINCULOS. */
  truncado: boolean;
  /** Contagem de arestas por tipo (do recorte total). */
  porTipo: Record<string, number>;
  itens: DossieVinculo[];
}

/** Uma fonte citada do dossiê (proveniência por seção). */
export interface DossieFonte {
  /** Seção que a fonte sustenta. */
  secao: string;
  /** Coleção `nexo_*` de onde o dado saiu. */
  colecao: string;
  /** Texto curto da proveniência (auditável). */
  descricao: string;
  /** Link/proveniência clicável quando aplicável (deep-link do raio-x). */
  procedencia?: Procedencia;
}

export interface DossieResponse {
  /** O `id` recebido (cru). */
  id: string;
  /** Como foi interpretado. */
  tipoId: TipoIdDossie;
  /** CNPJ resolvido (14 díg) quando aplicável. */
  cnpj: string | null;
  identificacao: DossieIdentificacao;
  cadastrais: DossieCadastrais;
  score: DossieScore;
  sancoes: DossieSancoes;
  socios: DossieSocios;
  doacoes: DossieDoacoes;
  alertas: DossieAlertas;
  vinculos: DossieVinculos;
  fontes: DossieFonte[];
  /** Disclaimer canônico do dossiê — indício a apurar, nunca acusação. */
  disclaimer: string;
  atualizadoEm: string;
}

const DISCLAIMER =
  'Este dossiê reúne dados públicos já ingeridos pelo NEXO e os CRUZA num só ' +
  'lugar. É um indício a apurar — NUNCA uma acusação, prova de irregularidade ' +
  'ou de improbidade. Doações eleitorais são lícitas e públicas (vínculo a ' +
  'apurar, jamais acusação). A apuração cabe a TCE-SP / Ministério Público / ' +
  'Controladoria. Convém verificar abrangência, vigência e eventual suspensão ' +
  'judicial de cada dado citado.';

// ── Helpers de leitura tipada ────────────────────────────────────────────────

function asStr(v: unknown): string {
  return v == null ? '' : String(v);
}
function asStrOuNulo(v: unknown): string | null {
  const s = asStr(v).trim();
  return s ? s : null;
}
function asNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function asStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x != null).map((x) => String(x)).filter(Boolean);
}
function asNumArr(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asNum(x)).filter((n) => Number.isFinite(n));
}
function soDigitos(v: unknown): string {
  return asStr(v).replace(/\D/g, '');
}
/** CPF/CNPJ por extenso (sem máscara) — exibição interna (fisc. LAI). */
function docPorExtenso(d: string): string {
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  return d;
}

// ── Cache server-side de `nexo_entidades` (coleção pequena, lê 1x/~5min) ──────
interface CacheEntidades {
  itens: Record<string, unknown>[];
  ts: number;
}
let cacheEntidades: CacheEntidades | null = null;

async function obterEntidades(idToken: string): Promise<Record<string, unknown>[]> {
  const agora = Date.now();
  if (cacheEntidades && agora - cacheEntidades.ts < TTL_MS) return cacheEntidades.itens;
  // `nexo_entidades` é pequena (1 doc/entidade). Lê tudo 1x e resolve em memória.
  const itens = await lerColecaoNexo('nexo_entidades', {}, idToken);
  cacheEntidades = { itens, ts: agora };
  return itens;
}

/**
 * Resolve a entidade alvo a partir do `id`. Para CNPJ, casa por raiz (`_id` da
 * entidade é a raiz) OU pelo campo `cnpj`/`doc` cru. Para HASH, casa contra
 * `hashDoc(e.doc/cnpj/cpf)` de cada perfil. Para id de entidade, casa pelo
 * `_docId`/`_id` exato e, como fallback, pelo rótulo canônico.
 */
function acharEntidade(
  entidades: Record<string, unknown>[],
  tipoId: TipoIdDossie,
  cnpjResolvido: string | null,
  hashAlvo: string | null,
  idCru: string,
): Record<string, unknown> | null {
  if (tipoId === 'cnpj' && cnpjResolvido) {
    const raiz = cnpjRaiz(cnpjResolvido);
    for (const e of entidades) {
      const docId = asStr(e._docId) || asStr(e._id);
      if (docId === raiz) return e; // _id canônico é a raiz
      const cn = soDigitos(e.cnpj ?? e.doc);
      if (cn === cnpjResolvido) return e;
      if (cn.length === 14 && cn.slice(0, 8) === raiz) return e;
    }
    return null;
  }
  if (tipoId === 'hash' && hashAlvo) {
    for (const e of entidades) {
      const d = soDigitos(e.doc ?? e.cnpj ?? e.cpf);
      if (d && hashDoc(d) === hashAlvo) return e;
    }
    return null;
  }
  // id de entidade (rótulo canônico do nome / id arbitrário).
  const alvo = idCru.trim();
  const alvoCanon = rotuloCanonico(idCru);
  for (const e of entidades) {
    const docId = asStr(e._docId) || asStr(e._id);
    if (docId === alvo) return e;
  }
  for (const e of entidades) {
    if (rotuloCanonico(asStr(e.nome)) === alvoCanon && alvoCanon) return e;
  }
  return null;
}

/** Monta a seção de identificação a partir do doc de `nexo_entidades`. */
function montarIdentificacao(e: Record<string, unknown>): DossieIdentificacao {
  const tipoBruto = asStr(e.tipo);
  const tipo =
    tipoBruto === 'empresa' || tipoBruto === 'pessoa' || tipoBruto === 'orgao'
      ? tipoBruto
      : null;
  const docCru = soDigitos(e.cnpj ?? e.doc ?? e.cpf);
  const cnpj = docCru.length === 14 ? docCru : null;
  const pessoaFisica = docCru.length === 11 || tipo === 'pessoa';
  // Fiscalização INTERNA (LAI) sobre dado público: exibe o doc COMPLETO na tela
  // (decisão do dono). O CPF cru continua FORA da URL — só o hash trafega. Aqui
  // o doc cru é recuperado de `nexo_entidades` (já ingerido), não da URL.
  const docExibicao = docCru ? docPorExtenso(docCru) : null;
  return {
    disponivel: true,
    motivo: null,
    entidadeId: asStr(e._docId) || asStr(e._id) || null,
    nome: asStrOuNulo(e.nome),
    tipo,
    docExibicao,
    docMascarado: docCru ? mascararDoc(docCru) : asStrOuNulo(e.doc),
    cnpj,
    pessoaFisica,
    totalEmpenhado: asNum(e.totalEmpenhado),
    nEmpenhos: asNum(e.nEmpenhos),
    nContratos: asNum(e.nContratos),
    contratosAtivos: asNum(e.contratosAtivos),
    nLicitacoes: asNum(e.nLicitacoes),
    nVinculos: asNum(e.nVinculos),
    sancionado: e.sancionado === true,
    nSancoes: asNum(e.nSancoes),
    flags: asStrArr(e.flags),
    objetos: asStrArr(e.objetos),
    secretarias: asStrArr(e.secretarias),
    primeiroVisto: asStrOuNulo(e.primeiroVisto),
    ultimoVisto: asStrOuNulo(e.ultimoVisto),
    exercicios: asNumArr(e._exercicios),
  };
}

/** Identificação vazia (entidade não perfilada) — estado honesto. */
function identificacaoVazia(
  tipoId: TipoIdDossie,
  cnpjResolvido: string | null,
): DossieIdentificacao {
  const cnpj = tipoId === 'cnpj' ? cnpjResolvido : null;
  return {
    disponivel: false,
    motivo:
      tipoId === 'hash'
        ? 'Nenhuma entidade ingerida casa este documento (o hash não bateu com ' +
          'nenhum perfil de nexo_entidades). Pode ser que a coleta ainda não ' +
          'tenha processado a entidade, ou que ela não tenha movimentação na ' +
          'base da Prefeitura. O dossiê fica vazio até o raio-x ser construído.'
        : 'Esta entidade ainda não foi perfilada em nexo_entidades. O cron de ' +
          'perfil (onNexoPerfilEntidades) não a consolidou — ou o CNPJ/id não ' +
          'aparece nas coleções ingeridas (empenhos/contratos/licitações). O ' +
          'dossiê fica parcial até o raio-x ser construído.',
    entidadeId: null,
    nome: null,
    tipo: null,
    docExibicao: cnpj ? docPorExtenso(cnpj) : null,
    docMascarado: cnpj ? mascararDoc(cnpj) : null,
    cnpj,
    pessoaFisica: false,
    totalEmpenhado: 0,
    nEmpenhos: 0,
    nContratos: 0,
    contratosAtivos: 0,
    nLicitacoes: 0,
    nVinculos: 0,
    sancionado: false,
    nSancoes: 0,
    flags: [],
    objetos: [],
    secretarias: [],
    primeiroVisto: null,
    ultimoVisto: null,
    exercicios: [],
  };
}

// ── Seção 2: CADASTRAIS (só CNPJ) — enriquecimento da Receita ─────────────────

function cadastraisVazia(motivo: string): DossieCadastrais {
  return {
    disponivel: false,
    motivo,
    razaoSocial: null,
    nomeFantasia: null,
    situacaoCadastral: null,
    dataAbertura: null,
    uf: null,
    municipio: null,
    cnaePrincipal: null,
    cnaeDescricao: null,
    capitalSocial: null,
    socios: [],
  };
}

async function montarCadastrais(cnpj: string | null): Promise<DossieCadastrais> {
  if (!cnpj || cnpj.length !== 14) {
    return cadastraisVazia(
      'Dados cadastrais da Receita só existem para pessoa jurídica (CNPJ). ' +
        'Pessoa física/órgão sem CNPJ não tem ficha cadastral aqui.',
    );
  }
  let info: CnpjInfo | null = null;
  try {
    info = await getCnpj(cnpj);
  } catch {
    info = null;
  }
  if (!info) {
    return cadastraisVazia(
      'Não foi possível consultar os dados cadastrais (BrasilAPI/minhareceita ' +
        'indisponíveis ou CNPJ inexistente na base aberta). Sem dado inventado.',
    );
  }
  return {
    disponivel: true,
    motivo: null,
    razaoSocial: info.razaoSocial || null,
    nomeFantasia: info.nomeFantasia,
    situacaoCadastral: info.situacaoCadastral || null,
    dataAbertura: info.dataAbertura,
    uf: info.uf,
    municipio: info.municipio,
    cnaePrincipal: info.cnaePrincipal,
    cnaeDescricao: info.cnaeDescricao,
    capitalSocial: info.capitalSocial,
    socios: info.socios.slice(0, MAX_SOCIOS),
  };
}

// ── Seção 3: SCORE de risco ───────────────────────────────────────────────────

async function montarScore(
  entidadeId: string | null,
  idToken: string,
): Promise<DossieScore> {
  const vazio = (motivo: string): DossieScore => ({
    disponivel: false,
    motivo,
    score: null,
    nivel: null,
    fatores: [],
    nAlertas: null,
    ultimaDeteccaoEm: null,
    disclaimer: null,
    versaoPesos: null,
    atualizadoEm: null,
  });
  if (!entidadeId) return vazio('Sem entidade resolvida — score não aplicável.');
  let docs: Record<string, unknown>[];
  try {
    // Projeção: só os campos que esta seção lê (corta o payload da coleção de
    // scores; `_docId` continua exposto pelo `name`).
    docs = await lerColecaoNexo('nexo_scores', {}, idToken, [
      'entidadeId', 'nivel', 'fatores', 'score', 'nAlertas',
      'ultimaDeteccaoEm', '_disclaimer', '_versaoPesos', 'atualizadoEm',
    ]);
  } catch {
    return vazio(
      'Não foi possível ler nexo_scores (coleção indisponível). O score de ' +
        'risco fica omitido nesta janela; as demais seções não são afetadas.',
    );
  }
  const doc = docs.find(
    (d) => asStr(d._docId) === entidadeId || asStr(d.entidadeId) === entidadeId,
  );
  if (!doc) {
    return vazio(
      'Score ainda não materializado para esta entidade. O cron de score ' +
        '(onNexoScoreEntidades) roda diariamente e pontua apenas tipo=empresa — ' +
        'órgãos e pessoas físicas ficam fora do ranking de risco de fornecedor.',
    );
  }
  const nivelBruto = asStr(doc.nivel);
  const nivel =
    nivelBruto === 'baixo' || nivelBruto === 'medio' || nivelBruto === 'alto' || nivelBruto === 'critico'
      ? nivelBruto
      : null;
  const fatores: DossieFator[] = Array.isArray(doc.fatores)
    ? (doc.fatores as Record<string, unknown>[]).map((f) => ({
        id: asStr(f.id),
        rotulo: asStr(f.rotulo),
        peso: asNum(f.peso),
        valorBruto: asNum(f.valorBruto),
        contribuicao: asNum(f.contribuicao),
        evidencia: asStr(f.evidencia),
      }))
    : [];
  return {
    disponivel: true,
    motivo: null,
    score: asNum(doc.score),
    nivel,
    fatores,
    nAlertas: asNum(doc.nAlertas),
    ultimaDeteccaoEm: asStrOuNulo(doc.ultimaDeteccaoEm),
    disclaimer: asStrOuNulo(doc._disclaimer),
    versaoPesos: doc._versaoPesos != null ? asNum(doc._versaoPesos) : null,
    atualizadoEm: asStrOuNulo(doc.atualizadoEm),
  };
}

// ── Seção 4: SANÇÕES (federal + estadual + leniência + contas irregulares) ────

/** Extrai os itens `sancoes[]` de um doc por CNPJ casado por exato/raiz. */
function lerSancoesDoc(
  docs: Record<string, unknown>[],
  cnpj: string,
  esfera: 'federal' | 'estadual',
): { itens: DossieSancaoItem[]; porRaiz: boolean } {
  const raiz = cnpj.slice(0, 8);
  // Prefere o doc com CNPJ exato; senão, o primeiro por raiz (sancionado).
  let exato: Record<string, unknown> | null = null;
  let porRaizHit: Record<string, unknown> | null = null;
  for (const d of docs) {
    const c = soDigitos(d._cnpj ?? d.cnpj ?? d._docId);
    if (c.length !== 14) continue;
    if (c === cnpj) exato = d;
    else if (c.slice(0, 8) === raiz && !porRaizHit) porRaizHit = d;
  }
  const doc = exato ?? porRaizHit;
  if (!doc) return { itens: [], porRaiz: false };
  const sancoes = Array.isArray(doc.sancoes) ? (doc.sancoes as Record<string, unknown>[]) : [];
  const itens: DossieSancaoItem[] = sancoes.map((s) => ({
    esfera,
    cadastro: asStr(s.cadastro) || (esfera === 'estadual' ? 'TCE-SP-APENADOS' : 'CGU'),
    tipoSancao: asStr(s.tipoSancao),
    orgaoSancionador: asStr(s.orgaoSancionador),
    dataInicio: asStrOuNulo(s.dataInicio),
    dataFim: asStrOuNulo(s.dataFim),
    fundamentacao: asStr(s.fundamentacao),
    situacao: null,
  }));
  return { itens, porRaiz: exato == null };
}

async function montarSancoes(
  ident: DossieIdentificacao,
  idToken: string,
): Promise<DossieSancoes> {
  const cnpj = ident.cnpj;
  const fontes: DossieSancoes['fontes'] = {
    federal: { disponivel: false, motivo: null },
    estadual: { disponivel: false, motivo: null },
    leniencia: { disponivel: false, motivo: null },
    contasIrregulares: { disponivel: false, motivo: null },
  };
  const itens: DossieSancaoItem[] = [];
  const contas: DossieContaIrregular[] = [];
  let porRaiz = false;
  let nFederal = 0;
  let nEstadual = 0;
  let nLeniencia = 0;

  // ── Sanções por CNPJ (federal / estadual / leniência) ──────────────────────
  if (cnpj && cnpj.length === 14) {
    // Federal — nexo_sancoes
    try {
      const fed = await lerColecaoNexo('nexo_sancoes', {}, idToken, [
        '_cnpj', 'cnpj', 'sancionado', 'sancoes',
      ]);
      const r = lerSancoesDoc(fed, cnpj, 'federal');
      itens.push(...r.itens);
      nFederal = r.itens.length;
      porRaiz = porRaiz || r.porRaiz;
      fontes.federal = { disponivel: true, motivo: null };
    } catch {
      fontes.federal = {
        disponivel: false,
        motivo: 'Não foi possível ler nexo_sancoes (CEIS/CNEP/CEPIM) nesta janela.',
      };
    }
    // Estadual — nexo_sancoes_estaduais
    try {
      const est = await lerColecaoNexo('nexo_sancoes_estaduais', {}, idToken, [
        '_cnpj', 'cnpj', 'sancionado', 'sancoes',
      ]);
      const r = lerSancoesDoc(est, cnpj, 'estadual');
      itens.push(...r.itens);
      nEstadual = r.itens.length;
      porRaiz = porRaiz || r.porRaiz;
      fontes.estadual = { disponivel: true, motivo: null };
    } catch {
      fontes.estadual = {
        disponivel: false,
        motivo: 'Não foi possível ler nexo_sancoes_estaduais (TCE-SP apenados) nesta janela.',
      };
    }
    // Leniência — nexo_leniencia
    try {
      const len = await lerColecaoNexo('nexo_leniencia', {}, idToken, [
        '_cnpj', 'cnpj', 'comAcordo', 'acordos',
      ]);
      const raiz = cnpj.slice(0, 8);
      const doc =
        len.find((d) => soDigitos(d._cnpj ?? d.cnpj ?? d._docId) === cnpj) ??
        len.find((d) => {
          const c = soDigitos(d._cnpj ?? d.cnpj ?? d._docId);
          return c.length === 14 && c.slice(0, 8) === raiz;
        });
      if (doc) {
        const acordos = Array.isArray(doc.acordos) ? (doc.acordos as Record<string, unknown>[]) : [];
        for (const a of acordos) {
          itens.push({
            esfera: 'leniencia',
            cadastro: 'CGU — Acordo de Leniência',
            tipoSancao: 'Acordo de Leniência (Lei 12.846/2013)',
            orgaoSancionador: asStr(a.orgaoResponsavel),
            dataInicio: asStrOuNulo(a.dataInicio),
            dataFim: asStrOuNulo(a.dataFim),
            fundamentacao: asStr(a.razaoSocial),
            situacao: asStrOuNulo(a.situacaoAcordo),
          });
          nLeniencia++;
        }
      }
      fontes.leniencia = { disponivel: true, motivo: null };
    } catch {
      fontes.leniencia = {
        disponivel: false,
        motivo: 'Não foi possível ler nexo_leniencia (acordos CGU) nesta janela.',
      };
    }
  } else {
    const motivoSemCnpj =
      'Sanções federais/estaduais e leniência cruzam por CNPJ de pessoa ' +
      'jurídica; sem CNPJ resolvido não há como cruzar essas fontes.';
    fontes.federal = { disponivel: false, motivo: motivoSemCnpj };
    fontes.estadual = { disponivel: false, motivo: motivoSemCnpj };
    fontes.leniencia = { disponivel: false, motivo: motivoSemCnpj };
  }

  // ── Contas julgadas irregulares (TCE-SP) — casamento por NOME ──────────────
  // O TCE anonimiza o CPF (hash da impressão digital parcial, não do CPF cru),
  // então NÃO há como casar por hashDoc(CPF). O detector XS-14 casa por NOME
  // (com aviso de homonímia). Replicamos: casa nomeNorm contra o nome da entidade.
  const nomeAlvoNorm = ident.nome
    ? ident.nome
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim()
    : '';
  if (nomeAlvoNorm && nomeAlvoNorm.length >= 6) {
    try {
      const ci = await lerColecaoNexo('nexo_contas_irregulares', {}, idToken, [
        'nome', 'nomeNorm', 'cpfMasc', 'processoTC', 'exercicio', 'origem',
        'materia', 'transitoJulgado',
      ]);
      for (const d of ci) {
        const nn = asStr(d.nomeNorm);
        if (!nn) continue;
        if (nn === nomeAlvoNorm) {
          contas.push({
            nome: asStr(d.nome),
            cpfMasc: asStr(d.cpfMasc),
            processoTC: asStr(d.processoTC),
            exercicio: d.exercicio != null ? asNum(d.exercicio) : null,
            origem: asStr(d.origem),
            materia: asStr(d.materia),
            transitoJulgado: asStr(d.transitoJulgado),
          });
        }
        if (contas.length >= MAX_CONTAS) break;
      }
      fontes.contasIrregulares = { disponivel: true, motivo: null };
    } catch {
      fontes.contasIrregulares = {
        disponivel: false,
        motivo: 'Não foi possível ler nexo_contas_irregulares (TCE Ficha Limpa) nesta janela.',
      };
    }
  } else {
    fontes.contasIrregulares = {
      disponivel: false,
      motivo:
        'Contas julgadas irregulares (TCE-SP) são casadas por NOME (CPF é ' +
        'anonimizado na fonte). Sem um nome de entidade suficiente, o cruzamento ' +
        'não é feito (evita falso positivo por homonímia).',
    };
  }

  // Ordena os itens por dataInicio desc (mais recente primeiro).
  itens.sort((a, b) => (b.dataInicio ?? '').localeCompare(a.dataInicio ?? ''));

  const algumaFonteDisponivel =
    fontes.federal.disponivel ||
    fontes.estadual.disponivel ||
    fontes.leniencia.disponivel ||
    fontes.contasIrregulares.disponivel;
  const sancionado = itens.length > 0;
  const motivo = algumaFonteDisponivel
    ? itens.length === 0 && contas.length === 0
      ? 'Nenhuma sanção, apenação, acordo de leniência ou conta irregular casou ' +
        'esta entidade nas fontes consultadas (indício de regularidade, não ' +
        'garantia — fontes podem estar em recoleta).'
      : null
    : 'Nenhuma fonte de sanção pôde ser consultada nesta janela.';

  return {
    disponivel: algumaFonteDisponivel,
    motivo,
    sancionado,
    porRaiz,
    nFederal,
    nEstadual,
    nLeniencia,
    itens: itens.slice(0, MAX_SANCOES_ITENS),
    contasIrregulares: contas,
    fontes,
  };
}

// ── Seção 5: SÓCIOS / pessoas vinculadas ──────────────────────────────────────

async function montarSocios(
  ident: DossieIdentificacao,
  hashAlvo: string | null,
  idToken: string,
): Promise<DossieSocios> {
  const vazio = (motivo: string, modo: 'qsa' | 'reverse' | null = null): DossieSocios => ({
    disponivel: false,
    motivo,
    modo,
    total: 0,
    truncado: false,
    itens: [],
  });

  // CNPJ → QSA (sócios da empresa).
  if (ident.cnpj && ident.cnpj.length === 14) {
    let docs: Record<string, unknown>[];
    try {
      docs = await lerColecaoNexo('nexo_socios', {}, idToken, [
        '_cnpj', 'cnpjRaiz', 'socios', 'temQsa', 'razaoSocial',
      ]);
    } catch {
      return vazio(
        'Não foi possível ler nexo_socios (grafo societário) nesta janela.',
        'qsa',
      );
    }
    const raiz = ident.cnpj.slice(0, 8);
    const doc =
      docs.find((d) => soDigitos(d._cnpj ?? d._docId) === ident.cnpj) ??
      docs.find((d) => soDigitos(d.cnpjRaiz) === raiz);
    if (!doc) {
      return vazio(
        'QSA deste CNPJ ainda não coletado (nexo_socios). O cron de sócios ' +
          '(onNexoColetaSocios) cobre os fornecedores por valor, em lotes com ' +
          'TTL ~30d — pode ainda não ter alcançado este CNPJ.',
        'qsa',
      );
    }
    const socios = Array.isArray(doc.socios) ? (doc.socios as Record<string, unknown>[]) : [];
    const itens: DossieSocio[] = socios.map((s) => ({
      nome: asStr(s.nome),
      qualificacao: asStr(s.qualificacao),
      cpfMasc: asStrOuNulo(s.cpfMasc),
      cnpjVinculado: null,
    }));
    return {
      disponivel: true,
      motivo:
        itens.length === 0
          ? 'Sem quadro societário (ME/MEI normalmente não declaram QSA, ou o ' +
            'CNPJ não tem cobertura na base aberta). Não é falha.'
          : null,
      modo: 'qsa',
      total: itens.length,
      truncado: itens.length > MAX_SOCIOS,
      itens: itens.slice(0, MAX_SOCIOS),
    };
  }

  // CPF (hash) → REVERSE: em quais CNPJs esta pessoa é sócia (grupo econômico).
  if (hashAlvo) {
    let docs: Record<string, unknown>[];
    try {
      docs = await lerColecaoNexo('nexo_socios', {}, idToken, [
        '_cnpj', 'socios', 'razaoSocial',
      ]);
    } catch {
      return vazio(
        'Não foi possível ler nexo_socios (grafo societário) nesta janela.',
        'reverse',
      );
    }
    const itens: DossieSocio[] = [];
    for (const d of docs) {
      const socios = Array.isArray(d.socios) ? (d.socios as Record<string, unknown>[]) : [];
      for (const s of socios) {
        if (asStr(s.cpfHash) === hashAlvo) {
          itens.push({
            nome: asStr(d.razaoSocial) || soDigitos(d._cnpj ?? d._docId),
            qualificacao: asStr(s.qualificacao),
            cpfMasc: asStrOuNulo(s.cpfMasc),
            cnpjVinculado: soDigitos(d._cnpj ?? d._docId) || null,
          });
          break; // um vínculo por CNPJ
        }
      }
      if (itens.length >= MAX_SOCIOS) break;
    }
    return {
      disponivel: true,
      motivo:
        itens.length === 0
          ? 'Esta pessoa não aparece como sócia em nenhum CNPJ já coletado em ' +
            'nexo_socios (cobertura parcial: o cron de QSA varre os fornecedores ' +
            'por valor com TTL). Ausência aqui não significa que não seja sócia.'
          : null,
      modo: 'reverse',
      total: itens.length,
      truncado: itens.length > MAX_SOCIOS,
      itens: itens.slice(0, MAX_SOCIOS),
    };
  }

  return vazio(
    'Sem CNPJ nem hash de documento resolvido — não há como montar a teia ' +
      'societária (QSA por CNPJ ou reverse por CPF).',
  );
}

// ── Seção 6: DOAÇÕES eleitorais (TSE) — por docHashDoador ─────────────────────

async function montarDoacoes(
  ident: DossieIdentificacao,
  hashAlvo: string | null,
  idToken: string,
): Promise<DossieDoacoes> {
  const vazio = (motivo: string): DossieDoacoes => ({
    disponivel: false,
    motivo,
    total: 0,
    truncado: false,
    valorTotal: 0,
    anos: [],
    itens: [],
  });
  // O hash do doador é hashDoc(dígitos). Para CNPJ, computamos do próprio CNPJ;
  // para CPF, usamos o hash que chegou na URL (que JÁ É hashDoc(CPF)).
  const hashDoador = ident.cnpj ? hashDoc(ident.cnpj) : hashAlvo;
  if (!hashDoador) {
    return vazio(
      'Sem CNPJ nem hash de documento para cruzar com as receitas eleitorais.',
    );
  }
  let docs: Record<string, unknown>[];
  try {
    docs = await lerColecaoNexo('nexo_doacoes_tse', {}, idToken, [
      'docHashDoador', 'candidato', 'cargo', 'partido', 'ano', 'uf',
      'municipio', 'valor',
    ]);
  } catch {
    return vazio(
      'Não foi possível ler nexo_doacoes_tse nesta janela (coleção indisponível).',
    );
  }
  const itens: DossieDoacao[] = [];
  let valorTotal = 0;
  const anos = new Set<number>();
  for (const d of docs) {
    if (asStr(d.docHashDoador) !== hashDoador) continue;
    const valor = asNum(d.valor);
    const ano = asNum(d.ano);
    valorTotal += valor;
    if (ano) anos.add(ano);
    itens.push({
      ano,
      candidato: asStr(d.candidato),
      cargo: asStr(d.cargo),
      partido: asStr(d.partido),
      municipio: asStr(d.municipio),
      uf: asStr(d.uf),
      valor,
    });
  }
  if (itens.length === 0) {
    return vazio(
      'Nenhuma doação eleitoral casou este documento. A base de doações TSE só ' +
        'tem os anos eleitorais já carregados por backfill (ex.: 2024, 2020) e ' +
        'apenas SP — pode haver anos não ingeridos. Ausência aqui não é prova ' +
        'de nada. Lembre: doação é lícita e pública.',
    );
  }
  // Ordena por ano desc e valor desc.
  itens.sort((a, b) => b.ano - a.ano || b.valor - a.valor);
  return {
    disponivel: true,
    motivo: null,
    total: itens.length,
    truncado: itens.length > MAX_DOACOES,
    valorTotal,
    anos: [...anos].sort((a, b) => b - a),
    itens: itens.slice(0, MAX_DOACOES),
  };
}

// ── Seção 8: ALERTAS / indícios ───────────────────────────────────────────────

async function montarAlertas(
  ident: DossieIdentificacao,
  idToken: string,
): Promise<DossieAlertas> {
  const raizAlvo = ident.cnpj ? cnpjRaiz(ident.cnpj) : '';
  const nomeAlvo = ident.nome ? rotuloCanonico(ident.nome) : rotuloCanonico(ident.entidadeId ?? '');
  if (!raizAlvo && !nomeAlvo) {
    return {
      disponivel: false,
      motivo: 'Sem chave de entidade para associar alertas.',
      total: 0,
      porClassificacao: { informativo: 0, atencao: 0, suspeita: 0, critico: 0 },
      itens: [],
    };
  }
  const anoAtual = new Date().getFullYear();
  const anos = [anoAtual, anoAtual - 1, anoAtual - 2];
  let docs: Record<string, unknown>[] = [];
  try {
    const lotes = await Promise.all(
      anos.map((ano) =>
        // Projeção: só os campos que esta seção lê. `nexo_alertas` é grande
        // (dezenas de milhares de docs/ano — ver o hotfix de 33 MB em /alertas);
        // sem projeção, ler 3 anos crus era o pior caso de payload do dossiê.
        lerColecaoNexo('nexo_alertas', { exercicio: ano }, idToken, [
          'ativo', 'sujeito', 'sujeitoId', 'sujeitoRotulo', 'nome',
          'classificacao', 'detectorId', 'detectorNome', 'categoria', 'titulo',
          'valorEnvolvido', 'explicacao', 'fundamentoLegal', 'status',
          'ultimaDeteccaoEm', 'detectadoEm',
        ]),
      ),
    );
    docs = lotes.flat();
  } catch {
    return {
      disponivel: false,
      motivo:
        'Não foi possível ler nexo_alertas nesta janela (coleção indisponível). ' +
        'Os indícios ficam omitidos; as demais seções não são afetadas.',
      total: 0,
      porClassificacao: { informativo: 0, atencao: 0, suspeita: 0, critico: 0 },
      itens: [],
    };
  }
  const porClassificacao = { informativo: 0, atencao: 0, suspeita: 0, critico: 0 };
  const meus: DossieAlerta[] = [];
  for (const d of docs) {
    if (d.ativo === false) continue; // só ativos
    const sujeito = (d.sujeito ?? {}) as Record<string, unknown>;
    const sujeitoId = asStr(d.sujeitoId ?? sujeito.id);
    const sujeitoRotulo = asStr(d.sujeitoRotulo ?? sujeito.rotulo ?? d.nome);
    const raizSuj = cnpjRaiz(sujeitoId);
    const nomeSuj = rotuloCanonico(sujeitoRotulo);
    const casa =
      (raizAlvo && raizSuj && raizSuj === raizAlvo) ||
      (nomeAlvo && nomeSuj && nomeSuj === nomeAlvo);
    if (!casa) continue;
    const classeBruta = asStr(d.classificacao);
    const classificacao =
      classeBruta === 'atencao' || classeBruta === 'suspeita' || classeBruta === 'critico'
        ? classeBruta
        : 'informativo';
    porClassificacao[classificacao]++;
    meus.push({
      detectorId: asStr(d.detectorId),
      detectorNome: asStr(d.detectorNome),
      categoria: asStr(d.categoria),
      titulo: asStr(d.titulo),
      classificacao,
      valorEnvolvido: asNum(d.valorEnvolvido),
      explicacao: asStr(d.explicacao),
      fundamentoLegal: asStrArr(d.fundamentoLegal),
      status: asStr(d.status) || 'aberta',
      ultimaDeteccaoEm: asStrOuNulo(d.ultimaDeteccaoEm ?? d.detectadoEm),
    });
  }
  const peso: Record<string, number> = { critico: 3, suspeita: 2, atencao: 1, informativo: 0 };
  meus.sort(
    (a, b) =>
      (peso[b.classificacao] - peso[a.classificacao]) ||
      (b.valorEnvolvido - a.valorEnvolvido),
  );
  const total = meus.length;
  return {
    disponivel: true,
    motivo:
      total === 0
        ? 'Nenhum alerta ativo associado a esta entidade nos exercícios cobertos. ' +
          'Pode ser ausência de indício OU o monitor de detecção ainda não rodou.'
        : null,
    total,
    porClassificacao,
    itens: meus.slice(0, MAX_ALERTAS),
  };
}

// ── Seção 7: VÍNCULOS (grafo nexo_links por CNPJ) ─────────────────────────────

async function montarVinculos(
  ident: DossieIdentificacao,
  idToken: string,
): Promise<DossieVinculos> {
  const cnpj = ident.cnpj;
  if (!cnpj) {
    return {
      disponivel: false,
      motivo:
        'Sem CNPJ resolvido para semear o grafo. Os vínculos por CNPJ do tema ' +
        'TUDO LINKADO partem do CNPJ; pessoa física aparece na teia societária ' +
        '(seção Sócios), não diretamente aqui.',
      semente: null,
      total: 0,
      truncado: false,
      porTipo: {},
      itens: [],
    };
  }
  const anoAtual = new Date().getFullYear();
  const anos = [anoAtual, anoAtual - 1];
  let links: Record<string, unknown>[] = [];
  try {
    const lotes = await Promise.all(
      anos.map((ano) =>
        lerColecaoNexo('nexo_links', { exercicio: ano }, idToken, [
          // `_cnpjRaiz` é a CHAVE de entity-resolution da aresta (carimbada pelo
          // linkage quando há CNPJ): liga a aresta ao GRUPO do fornecedor sem
          // reabrir as pontas. Projetamos para casar por ENTIDADE, não por
          // soDigitos(chave) (que dava falso-positivo — ver fix abaixo).
          '_de', '_para', 'tipo', 'confianca', 'chave', '_cnpjRaiz',
        ]),
      ),
    );
    links = lotes.flat();
  } catch {
    return {
      disponivel: false,
      motivo:
        'Não foi possível ler nexo_links nesta janela (coleção indisponível). ' +
        'A teia de vínculos fica omitida; as demais seções não são afetadas.',
      semente: null,
      total: 0,
      truncado: false,
      porTipo: {},
      itens: [],
    };
  }
  if (links.length === 0) {
    return {
      disponivel: false,
      motivo:
        'O grafo de vínculos (nexo_links) está vazio para o período. O cron de ' +
        'linkage (onNexoLinkage) ainda não rodou ou não achou cruzamentos.',
      semente: null,
      total: 0,
      truncado: false,
      porTipo: {},
      itens: [],
    };
  }
  const raiz = cnpjRaiz(cnpj);
  const refToNo = (v: unknown): { no: string; colecao: string } | null => {
    if (v == null || typeof v !== 'object') return null;
    const r = v as { colecao?: unknown; id?: unknown };
    const colecao = asStr(r.colecao).trim();
    const id = asStr(r.id).trim();
    if (!colecao || !id) return null;
    return { no: `${colecao}:${id}`, colecao };
  };
  const porTipo: Record<string, number> = {};
  const itens: DossieVinculo[] = [];
  const vistos = new Set<string>();
  for (const lk of links) {
    // FIX (plano §1.1): casar por ENTIDADE real (`_cnpjRaiz` da aresta), NÃO por
    // soDigitos(chave). A `chave` da aresta é um nº de processo/empenho
    // (`EMP-0000000259-2026` → 14 dígitos passava por "CNPJ" por acidente;
    // `21/2022` nunca casava), gerando teia de ruído ou falso-positivo. O
    // linkage carimba `_cnpjRaiz` (raiz do CNPJ do empenho-lado) exatamente para
    // ancorar a aresta ao fornecedor — é a chave de entity-resolution do §2.1.
    const raizAresta = soDigitos(lk._cnpjRaiz);
    const casaCnpj = raizAresta.length >= 8 && raizAresta.slice(0, 8) === raiz;
    if (!casaCnpj) continue;
    for (const lado of [lk._de, lk._para]) {
      const alvo = refToNo(lado);
      if (!alvo) continue;
      const tipo = asStr(lk.tipo);
      const chaveDedup = `${alvo.no}#${tipo}`;
      if (vistos.has(chaveDedup)) continue;
      vistos.add(chaveDedup);
      porTipo[tipo] = (porTipo[tipo] ?? 0) + 1;
      itens.push({
        no: alvo.no,
        colecao: alvo.colecao,
        tipo,
        confianca: asStr(lk.confianca),
        chave: asStr(lk.chave),
      });
    }
  }
  const total = itens.length;
  if (total === 0) {
    return {
      disponivel: true,
      motivo:
        'O grafo existe, mas nenhuma aresta ancorada nesta entidade (por _cnpjRaiz) ' +
        'foi encontrada. As arestas só carregam _cnpjRaiz quando o linkage casa um ' +
        'empenho com CNPJ ao processo/contrato — depende do cron de linkage ' +
        '(onNexoLinkage) ter rodado e do lado-empenho ter CNPJ. Cruzamento pode ser parcial.',
      semente: `cnpj:${cnpj}`,
      total: 0,
      truncado: false,
      porTipo: {},
      itens: [],
    };
  }
  return {
    disponivel: true,
    motivo: null,
    semente: `cnpj:${cnpj}`,
    total,
    truncado: total > MAX_VINCULOS,
    porTipo,
    itens: itens.slice(0, MAX_VINCULOS),
  };
}

// ── Fontes / proveniência ─────────────────────────────────────────────────────

function montarFontes(
  ident: DossieIdentificacao,
  cadastrais: DossieCadastrais,
  score: DossieScore,
  sancoes: DossieSancoes,
  socios: DossieSocios,
  doacoes: DossieDoacoes,
  alertas: DossieAlertas,
  vinculos: DossieVinculos,
): DossieFonte[] {
  const fontes: DossieFonte[] = [];
  fontes.push({
    secao: 'Identificação',
    colecao: 'nexo_entidades',
    descricao: ident.disponivel
      ? `Raio-x consolidado pelo cron onNexoPerfilEntidades (id ${ident.entidadeId}).`
      : 'Raio-x de entidades — entidade ainda não perfilada nesta coleção.',
  });
  if (ident.cnpj) {
    fontes.push({
      secao: 'Dados cadastrais',
      colecao: 'BrasilAPI / minhareceita',
      descricao: cadastrais.disponivel
        ? 'Cadastro da Receita Federal (razão social, situação, CNAE, capital, QSA).'
        : 'Cadastro da Receita — indisponível nesta janela.',
      procedencia: {
        fonte: 'PORTAL-MARILIA',
        label: 'Abrir raio-x do fornecedor',
        url: `/nexo/fornecedores/${ident.cnpj}`,
        tipoDoc: 'pagina',
        podePreview: false,
        refColecao: 'nexo_entidades',
        refId: ident.entidadeId ?? undefined,
      },
    });
  }
  fontes.push({
    secao: 'Score de risco',
    colecao: 'nexo_scores',
    descricao: score.disponivel
      ? `Score materializado pelo cron onNexoScoreEntidades (versão de pesos ${score.versaoPesos ?? '—'}).`
      : 'Score de risco — ainda não materializado para esta entidade.',
  });
  fontes.push({
    secao: 'Sanções federais (CEIS/CNEP/CEPIM)',
    colecao: 'nexo_sancoes',
    descricao: `Cadastros federais de inidôneos da CGU — ${sancoes.nFederal} registro(s) por CNPJ/raiz.`,
  });
  fontes.push({
    secao: 'Sanções estaduais (TCE-SP)',
    colecao: 'nexo_sancoes_estaduais',
    descricao: `Relação de Apenados do TCE-SP — ${sancoes.nEstadual} apenação(ões) por CNPJ.`,
  });
  fontes.push({
    secao: 'Acordos de leniência (CGU)',
    colecao: 'nexo_leniencia',
    descricao: `Acordos de leniência (Lei 12.846/2013) — ${sancoes.nLeniencia} acordo(s) por CNPJ.`,
  });
  fontes.push({
    secao: 'Contas julgadas irregulares (TCE-SP)',
    colecao: 'nexo_contas_irregulares',
    descricao:
      `Relação Ficha Limpa (LC 64/90) — ${sancoes.contasIrregulares.length} registro(s) ` +
      'por NOME (CPF anonimizado na fonte; vínculo a apurar, NÃO é inelegibilidade).',
  });
  fontes.push({
    secao: 'Sócios / pessoas vinculadas',
    colecao: 'nexo_socios',
    descricao:
      socios.modo === 'reverse'
        ? `Grafo societário (QSA) — ${socios.total} CNPJ(s) onde esta pessoa é sócia.`
        : `Quadro de Sócios e Administradores (Receita) — ${socios.total} sócio(s).`,
  });
  fontes.push({
    secao: 'Doações eleitorais',
    colecao: 'nexo_doacoes_tse',
    descricao:
      `Receitas eleitorais do TSE (dados abertos) — ${doacoes.total} doação(ões). ` +
      'Doação é LÍCITA e pública; vínculo a apurar, nunca acusação.',
  });
  fontes.push({
    secao: 'Alertas / indícios',
    colecao: 'nexo_alertas',
    descricao: alertas.disponivel
      ? `${alertas.total} alerta(s) ativo(s) pré-computado(s) pelos detectores do NEXO.`
      : 'Alertas dos detectores — coleção indisponível ou sem indício nesta janela.',
  });
  fontes.push({
    secao: 'Vínculos (TUDO LINKADO)',
    colecao: 'nexo_links',
    descricao: vinculos.disponivel
      ? `${vinculos.total} vínculo(s) no grafo montado pelo cron onNexoLinkage.`
      : 'Grafo de vínculos — indisponível ou sem cruzamento por CNPJ.',
    procedencia: ident.cnpj
      ? {
          fonte: 'PORTAL-MARILIA',
          label: 'Explorar no Grafo de Vínculos',
          url: `/nexo/grafo`,
          tipoDoc: 'pagina',
          podePreview: false,
          refColecao: 'nexo_links',
        }
      : undefined,
  });
  return fontes;
}

// ── Handler ──────────────────────────────────────────────────────────────────

/** Resultado de `computarDossie`: a resposta OU um erro HTTP honesto. */
export type ResultadoDossie =
  | { ok: true; dossie: DossieResponse }
  | { ok: false; status: number; erro: string };

/**
 * NÚCLEO de cômputo do dossiê — interpreta o `id`, lê `nexo_entidades` e monta
 * todas as seções. Compartilhado entre o GET por path (usuário) e o
 * `/api/nexo/dossie/route.ts` (compute do worker, com `alvo` na querystring).
 * Não acessa `Request`.
 */
export async function computarDossie(
  idCru: string,
  idToken: string,
): Promise<ResultadoDossie> {
  // ── Interpretação do `id` ────────────────────────────────────────────────────
  let tipoId: TipoIdDossie;
  let cnpjResolvido: string | null = null;
  let hashAlvo: string | null = null;

  const digits = idCru.replace(/\D/g, '');
  const ehHash = /^[0-9a-f]{64}$/i.test(idCru);

  if (ehHash) {
    // HASH irreversível de CPF/CNPJ (de hashDoc) — é como o CPF chega aqui sem
    // expor o número na URL. NÃO re-hasheia.
    tipoId = 'hash';
    hashAlvo = idCru.toLowerCase();
  } else if (/^\d[\d.\-/]*\d$/.test(idCru) && (digits.length === 14 || digits.length === 11)) {
    // Parece um documento. Só CNPJ (14 díg, Módulo 11) é aceito — dado público
    // de PJ. CPF cru (11 díg) e CNPJ inválido → 400 (CPF cru nunca na URL).
    if (digits.length === 14 && cnpjValidator.isValid(digits)) {
      tipoId = 'cnpj';
      cnpjResolvido = digits;
    } else {
      return {
        ok: false,
        status: 400,
        erro:
          digits.length === 11
            ? 'CPF cru não é aceito como id de dossiê (LGPD: o número nunca ' +
              'trafega na URL). Acesse o CPF pelo HASH irreversível (clique no ' +
              'entity-chip), nunca pelo número.'
            : 'CNPJ inválido (falha na verificação Módulo 11). Informe um CNPJ ' +
              'válido (14 dígitos), o hash de um documento, ou um id de entidade.',
      };
    }
  } else {
    // Id de entidade (rótulo canônico do nome / id arbitrário não-numérico).
    tipoId = 'entidade';
  }

  // ── IDENTIFICAÇÃO (fatal se falhar a leitura de nexo_entidades) ──────────────
  let entidades: Record<string, unknown>[];
  try {
    entidades = await obterEntidades(idToken);
  } catch (err) {
    return {
      ok: false,
      status: 502,
      erro: err instanceof Error ? err.message : 'erro ao ler nexo_entidades',
    };
  }

  const ent = acharEntidade(entidades, tipoId, cnpjResolvido, hashAlvo, idCru);
  const identificacao = ent
    ? montarIdentificacao(ent)
    : identificacaoVazia(tipoId, cnpjResolvido);

  // CNPJ final: o resolvido (CNPJ na URL) OU o da entidade achada por hash/id.
  const cnpjFinal = identificacao.cnpj ?? cnpjResolvido;
  const identComCnpj: DossieIdentificacao = { ...identificacao, cnpj: cnpjFinal };

  // ── Seções auxiliares (degradam independentemente; nunca derrubam o dossiê) ──
  const [cadastrais, score, sancoes, socios, doacoes, alertas, vinculos] =
    await Promise.all([
      montarCadastrais(cnpjFinal),
      montarScore(identComCnpj.entidadeId, idToken),
      montarSancoes(identComCnpj, idToken),
      montarSocios(identComCnpj, hashAlvo, idToken),
      montarDoacoes(identComCnpj, hashAlvo, idToken),
      montarAlertas(identComCnpj, idToken),
      montarVinculos(identComCnpj, idToken),
    ]);

  const fontes = montarFontes(
    identComCnpj, cadastrais, score, sancoes, socios, doacoes, alertas, vinculos,
  );

  const resposta: DossieResponse = {
    id: idCru,
    tipoId,
    cnpj: cnpjFinal,
    identificacao: identComCnpj,
    cadastrais,
    score,
    sancoes,
    socios,
    doacoes,
    alertas,
    vinculos,
    fontes,
    disclaimer: DISCLAIMER,
    atualizadoEm: new Date().toISOString(),
  };

  return { ok: true, dossie: resposta };
}

// ── Handler GET (por path /api/nexo/dossie/{id}) ──────────────────────────────

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idParam } = await params;
  const idCru = decodeURIComponent(String(idParam ?? '')).trim();
  if (!idCru) {
    return NextResponse.json(
      { erro: 'id de dossiê ausente' },
      { status: 400, headers: headersNoStore },
    );
  }
  // ── MODO COMPUTE (worker) ────────────────────────────────────────────────────
  // O worker chama `/api/nexo/dossie?...&alvo=<id>` (sem segmento de path); essa
  // forma é tratada por `src/app/api/nexo/dossie/route.ts`. Aqui (path) também
  // aceitamos compute para robustez/testes diretos.
  const compute = avaliarCompute(req);
  if (compute.modo === 'negado') {
    return NextResponse.json({ erro: compute.erro }, { status: compute.status, headers: headersNoStore });
  }
  if (compute.modo === 'compute') {
    const r = await computarDossie(idCru, compute.idToken);
    if (!r.ok) {
      return NextResponse.json({ erro: r.erro }, { status: r.status, headers: headersNoStore });
    }
    return NextResponse.json(r.dossie, { headers: headersNoStore });
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

  // Snapshot-first. CHAVE canônica do dossiê = `dossie:<idCru>:0` — o dossiê
  // agrega TODOS os anos (computarDossie ignora exercício) e o botão Compilar/o
  // worker gravam sob exercício 0. Ler com o ano corrente (bug antigo) nunca
  // casava a chave → computava live a cada abertura.
  try {
    const snap = await lerSnapshotPainel('dossie', idCru, 0, idToken, sessao.uid ?? undefined);
    if (snap) return NextResponse.json(snap.payload, { headers: headersCache });
  } catch {
    /* falha ao ler snapshot — cai no cômputo ao vivo abaixo */
  }

  const r = await computarDossie(idCru, idToken);
  if (!r.ok) {
    return NextResponse.json({ erro: r.erro }, { status: r.status, headers: headersNoStore });
  }
  return NextResponse.json(r.dossie, { headers: headersCache });
}
