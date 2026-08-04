/**
 * GET /api/nexo/vinculo-vivo?quadrante=&ordem=
 *
 * EIXO CENTRAL do NEXO (pedido 3) — leitura O(1) do cruzamento materializado
 * SANÇÃO FEDERAL × VÍNCULO VIVO com a Prefeitura. O cron `onNexoMatVinculoVivo`
 * cruza `nexo_sancoes` × `nexo_empenhos`/`nexo_contratos_municipais` e persiste
 * `nexo_vinculo_vivo` (1 doc por CNPJ-raiz sancionado); esta rota SÓ LÊ os docs
 * prontos — não cruza nada (o caminho rápido que dispensa varrer a base por
 * request).
 *
 * Cards "sancionado AINDA contratando": o quadrante `vivo-sancao-vigente` é o
 * crítico máximo ("está punido AGORA e ainda contrata, com esta prova").
 *
 * Origem: a coleção `nexo_vinculo_vivo` do Firestore, lida via REST com a sessão
 * do próprio usuário (`lerColecaoNexo`, gated por `verificarSessao` como as
 * demais rotas `nexo`).
 *
 * Degradação honesta: se `nexo_vinculo_vivo` estiver vazia (o cron ainda não
 * rodou OU `nexo_sancoes` está vazio — token CGU pendente), responde 200 com
 * lista vazia + `ingestao.status:'pendente'`. NUNCA inventa sanção/vínculo.
 *
 * Apenas dados públicos cruzados — todo card é indício a apurar, não acusação
 * (disclaimer carimbado por doc no cron).
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';

export const runtime = 'nodejs';

/** Quadrantes do cruzamento (espelham `mat-vinculo-vivo.ts`). */
export type QuadranteVinculo =
  | 'vivo-sancao-vigente'
  | 'vivo-sancao-encerrada'
  | 'sem-vinculo-sancionado'
  | 'sancao-removida';

export type ClassificacaoVinculo = 'critico' | 'atencao' | 'informativo';

/** Uma referência de prova (doc de origem do empenho/contrato). */
export interface RefProvaVinculo {
  colecao: string;
  id: string;
  valor: number;
  data: string;
}

/** Um item do cruzamento — 1 CNPJ-raiz sancionado, como vem materializado. */
export interface VinculoVivoItem {
  cnpjRaiz: string;
  /** CNPJ-raiz mascarado p/ exibição (raiz pública + ordem mascarada). */
  cnpjMasc: string;
  nome: string;
  quadrante: QuadranteVinculo;
  classificacao: ClassificacaoVinculo;
  vinculoVivo: boolean;
  sancaoFederalVigente: boolean;
  sancaoFederalEncerrada: boolean;
  cadastros: string[];
  qtdSancoes: number;
  dataInicioSancao: string | null;
  dataFimSancao: string | null;
  /** Empenho APÓS a data de início da sanção (a apurar). */
  valorEmpenhadoPosSancao: number;
  nEmpenhosPosSancao: number;
  /** Empenho ANTES da sanção (contratação prévia, regular). */
  valorEmpenhadoPreSancao: number;
  nEmpenhosPreSancao: number;
  contratosAtivos: number;
  valorContratosAtivos: number;
  provas: { empenhos: RefProvaVinculo[]; contratos: RefProvaVinculo[] };
  disclaimer: string;
}

/** Resposta da rota — exportada p/ a página importar com `import type`. */
export interface VinculoVivoResponse {
  total: number;
  /** Itens do quadrante crítico (sancionado AINDA contratando) — atalho do card. */
  totalCritico: number;
  itens: VinculoVivoItem[];
  resumo: {
    vivoSancaoVigente: number;
    vivoSancaoEncerrada: number;
    semVinculo: number;
    /** Soma do empenhado PÓS-sanção entre os itens VIVO+VIGENTE (R$ a apurar). */
    valorEmpenhadoPosSancaoCritico: number;
  };
  /**
   * Estado da ingestão. `pendente` = coleção vazia (cron ainda não rodou OU
   * `nexo_sancoes` vazio — token CGU pendente); `ok` = há cruzamento materializado.
   */
  ingestao: { status: 'ok' | 'pendente'; ultimaMaterializacaoEm: string | null };
  /** Esferas integradas e pendentes — degradação honesta (§6.5). */
  esferas: { integradas: string[]; pendentes: string[] };
  atualizadoEm: string;
}

const QUADRANTES: readonly QuadranteVinculo[] = [
  'vivo-sancao-vigente',
  'vivo-sancao-encerrada',
  'sem-vinculo-sancionado',
  'sancao-removida',
];
const CLASSIFICACOES: readonly ClassificacaoVinculo[] = [
  'critico',
  'atencao',
  'informativo',
];

function texto(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function numero(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function textoOuNulo(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function listaTexto(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => texto(x)).filter(Boolean) : [];
}

/** Converte um array bruto de refs de prova em `RefProvaVinculo[]`. */
function paraProvas(v: unknown): RefProvaVinculo[] {
  if (!Array.isArray(v)) return [];
  return v.map((p) => {
    const r = (p ?? {}) as Record<string, unknown>;
    return {
      colecao: texto(r.colecao),
      id: texto(r.id),
      valor: numero(r.valor),
      data: texto(r.data),
    };
  });
}

/** Converte um doc bruto de `nexo_vinculo_vivo` para `VinculoVivoItem`. */
function paraItem(doc: Record<string, unknown>): VinculoVivoItem {
  const provas = (doc.provas ?? {}) as Record<string, unknown>;
  const quadrante = texto(doc.quadrante, 'sem-vinculo-sancionado') as QuadranteVinculo;
  const classe = texto(doc.classificacao, 'informativo') as ClassificacaoVinculo;
  return {
    cnpjRaiz: texto(doc.cnpjRaiz ?? doc._cnpj ?? doc._id),
    cnpjMasc: texto(doc.cnpjMasc),
    nome: texto(doc.nome),
    quadrante: QUADRANTES.includes(quadrante) ? quadrante : 'sem-vinculo-sancionado',
    classificacao: CLASSIFICACOES.includes(classe) ? classe : 'informativo',
    vinculoVivo: doc.vinculoVivo === true,
    sancaoFederalVigente: doc.sancaoFederalVigente === true,
    sancaoFederalEncerrada: doc.sancaoFederalEncerrada === true,
    cadastros: listaTexto(doc.cadastros),
    qtdSancoes: numero(doc.qtdSancoes),
    dataInicioSancao: textoOuNulo(doc.dataInicioSancao),
    dataFimSancao: textoOuNulo(doc.dataFimSancao),
    valorEmpenhadoPosSancao: numero(doc.valorEmpenhadoPosSancao),
    nEmpenhosPosSancao: numero(doc.nEmpenhosPosSancao),
    valorEmpenhadoPreSancao: numero(doc.valorEmpenhadoPreSancao),
    nEmpenhosPreSancao: numero(doc.nEmpenhosPreSancao),
    contratosAtivos: numero(doc.contratosAtivos),
    valorContratosAtivos: numero(doc.valorContratosAtivos),
    provas: {
      empenhos: paraProvas(provas.empenhos),
      contratos: paraProvas(provas.contratos),
    },
    disclaimer: texto(doc.disclaimer),
  };
}

/**
 * Peso do quadrante p/ ordenação default ("o pior primeiro"): crítico (vivo +
 * sanção vigente) no topo, depois atenção (vivo + encerrada), depois cadastro.
 */
function pesoQuadrante(q: QuadranteVinculo): number {
  switch (q) {
    case 'vivo-sancao-vigente':
      return 3;
    case 'vivo-sancao-encerrada':
      return 2;
    case 'sem-vinculo-sancionado':
      return 1;
    default:
      return 0; // sancao-removida (expurgado)
  }
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { searchParams } = new URL(req.url);
  const quadranteFiltro = searchParams.get('quadrante');
  const ordem = searchParams.get('ordem') ?? 'critico';

  const esferas = { integradas: ['federal'], pendentes: ['estadual', 'municipal'] };

  let docs: Record<string, unknown>[];
  try {
    // Filtra por `_fonte` (todo doc carrega `_fonte: 'vinculo-vivo'`) — escopa a
    // leitura à materialização deste módulo. Filtro de campo único servido pelo
    // índice single-field automático; nenhum índice composto necessário.
    docs = await lerColecaoNexo(
      'nexo_vinculo_vivo',
      { fonte: 'vinculo-vivo' },
      sessao.idToken,
    );
  } catch (err) {
    return NextResponse.json(
      { erro: err instanceof Error ? err.message : 'erro ao ler nexo_vinculo_vivo' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Coleção vazia — o cron ainda não materializou OU `nexo_sancoes` está vazio
  // (token CGU pendente). Não é erro: estado honesto que a página traduz em
  // "aguardando coleta de sanções", NUNCA "nenhuma empresa sancionada".
  if (docs.length === 0) {
    const resposta: VinculoVivoResponse = {
      total: 0,
      totalCritico: 0,
      itens: [],
      resumo: {
        vivoSancaoVigente: 0,
        vivoSancaoEncerrada: 0,
        semVinculo: 0,
        valorEmpenhadoPosSancaoCritico: 0,
      },
      ingestao: { status: 'pendente', ultimaMaterializacaoEm: null },
      esferas,
      atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(resposta, {
      headers: { 'Cache-Control': 'private, max-age=120' },
    });
  }

  let itens = docs
    .map(paraItem)
    // Os expurgados (sanção removida da fonte) saem da listagem padrão.
    .filter((i) => i.quadrante !== 'sancao-removida');

  // Filtro de quadrante por querystring (ex.: ?quadrante=vivo-sancao-vigente
  // para os cards "sancionado AINDA contratando").
  if (
    quadranteFiltro &&
    QUADRANTES.includes(quadranteFiltro as QuadranteVinculo)
  ) {
    itens = itens.filter((i) => i.quadrante === quadranteFiltro);
  }

  // Ordenação: default por GRAVIDADE do quadrante (crítico primeiro), desempate
  // pelo R$ empenhado PÓS-sanção desc (mais a apurar primeiro). ?ordem=valor =
  // só por R$ pós-sanção desc; ?ordem=recente = por início da sanção desc.
  if (ordem === 'valor') {
    itens.sort((a, b) => b.valorEmpenhadoPosSancao - a.valorEmpenhadoPosSancao);
  } else if (ordem === 'recente') {
    itens.sort((a, b) =>
      (b.dataInicioSancao ?? '').localeCompare(a.dataInicioSancao ?? ''),
    );
  } else {
    itens.sort((a, b) => {
      const pq = pesoQuadrante(b.quadrante) - pesoQuadrante(a.quadrante);
      if (pq !== 0) return pq;
      return b.valorEmpenhadoPosSancao - a.valorEmpenhadoPosSancao;
    });
  }

  // Carimbo da materialização mais recente — `_atualizadoEm` (serverTimestamp do
  // cron) decodifica como string ISO em `firestore-read`. Pega o maior entre os
  // docs (honesto: "última vez que o cruzamento foi reconstruído").
  let ultimaMaterializacaoEm: string | null = null;
  for (const d of docs) {
    const ts = typeof d._atualizadoEm === 'string' ? d._atualizadoEm : null;
    if (ts && (!ultimaMaterializacaoEm || ts > ultimaMaterializacaoEm)) {
      ultimaMaterializacaoEm = ts;
    }
  }

  // Resumo sobre TODOS os docs (não só os filtrados) — o painel mostra o panorama.
  const todos = docs.map(paraItem).filter((i) => i.quadrante !== 'sancao-removida');
  const vivoVigente = todos.filter((i) => i.quadrante === 'vivo-sancao-vigente');
  const vivoEncerrada = todos.filter((i) => i.quadrante === 'vivo-sancao-encerrada');
  const semVinculo = todos.filter((i) => i.quadrante === 'sem-vinculo-sancionado');
  const valorPosCritico = vivoVigente.reduce(
    (s, i) => s + i.valorEmpenhadoPosSancao,
    0,
  );

  const resposta: VinculoVivoResponse = {
    total: itens.length,
    totalCritico: vivoVigente.length,
    itens,
    resumo: {
      vivoSancaoVigente: vivoVigente.length,
      vivoSancaoEncerrada: vivoEncerrada.length,
      semVinculo: semVinculo.length,
      valorEmpenhadoPosSancaoCritico: Math.round(valorPosCritico * 100) / 100,
    },
    ingestao: { status: 'ok', ultimaMaterializacaoEm },
    esferas,
    atualizadoEm: new Date().toISOString(),
  };

  return NextResponse.json(resposta, {
    headers: { 'Cache-Control': 'private, max-age=300' },
  });
}
