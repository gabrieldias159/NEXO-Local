/**
 * GET /api/nexo/orcamento — EXECUÇÃO ORÇAMENTÁRIA do NEXO.
 *
 * Lista a execução do orçamento por RUBRICA (ou agregada por função/órgão):
 * dotação prevista (inicial e autorizada/atualizada com créditos/emendas) vs o
 * que foi USADO (empenhado/liquidado/pago), com % de execução e flag de ESTOURO.
 *
 * Fonte: `nexo_despesa_sintetica` (SMARAPD DespesaSintetica) — snapshots mensais
 * por rubrica; consolidamos o ESTADO ATUAL pegando o maior mês por rubrica
 * (campos "AteMes" são acumulados). Sem LOA-PDF/Gemini: a dotação já vem na fonte.
 *
 * Filtros: exercicio, agruparPor (rubrica|funcao|orgao), q (busca), funcao,
 * orgao, situacao (estourado|alta|media|baixa execução), ordenarPor, dir.
 * Leitura do exercício cacheada ~5 min (projeção de campos leves).
 *
 * Runtime nodejs.
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import {
  normalizarExecucaoSintetica,
  consolidarPorRubrica,
  pctExecucao,
  type ExecucaoRubrica,
} from '@/lib/nexo/orcamento';

export const runtime = 'nodejs';

const TAMANHO_PADRAO = 50;
const TAMANHO_MAX = 300;
const headersCache = { 'Cache-Control': 'private, max-age=60' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

const CAMPOS = [
  'ClassificacaoFuncional', 'DescricaoClassificacaoFuncional',
  'Funcao', 'DescricaoFuncao',
  'UnidadeOrcamentaria', 'DescricaoUnidadeOrcamentaria', 'UnidadeGestora',
  'NaturezaDespesa', 'DescricaoNaturezaDespesa',
  'FonteRecurso', 'DescricaoFonteRecurso',
  'Mes', 'DotacaoInicial', 'DotacaoAutorizada', 'EmpenhadoAteMes', 'LiquidadoaPagar', 'PagoAteMes',
  '_coletadoEm',
];

export type AgruparPor = 'rubrica' | 'funcao' | 'orgao';

export interface ItemOrcamento {
  id: string;
  titulo: string;
  subtitulo: string;
  dotacaoInicial: number;
  dotacaoAutorizada: number;
  empenhado: number;
  liquidado: number;
  pago: number;
  pctExecucao: number;
  estourado: boolean;
  /** nº de rubricas agregadas (só quando agruparPor != 'rubrica'). */
  nRubricas?: number;
  /**
   * nº de UNIDADES/secretarias distintas — só nos itens de ÓRGÃO (nível 1 da
   * hierarquia órgão → unidade → rubrica). A UI mostra "N unidade(s)" quando
   * presente; senão cai em "N rubrica(s)".
   */
  nUnidades?: number;
}

export interface OrcamentoAgregados {
  nRubricas: number;
  dotacaoInicial: number;
  dotacaoAutorizada: number;
  empenhado: number;
  liquidado: number;
  pago: number;
  /** rubricas com empenhado > dotação autorizada. */
  estouradas: number;
  pctExecucaoGlobal: number;
}

export interface OrcamentoResponse {
  exercicio: number;
  agruparPor: AgruparPor;
  total: number;
  pagina: number;
  tamanho: number;
  itens: ItemOrcamento[];
  agregados: OrcamentoAgregados;
  ingestao: { status: 'ok' | 'pendente' };
  atualizadoEm: string;
}

interface CacheAno { itens: ExecucaoRubrica[]; ts: number }
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<number, CacheAno>();

async function obterAno(exercicio: number, idToken: string): Promise<ExecucaoRubrica[]> {
  const c = cache.get(exercicio);
  if (c && Date.now() - c.ts < TTL_MS) return c.itens;
  const brutos = await lerColecaoNexo('nexo_despesa_sintetica', { exercicio, fonte: 'despesa_sintetica' }, idToken, CAMPOS);
  const consolidado = consolidarPorRubrica(normalizarExecucaoSintetica(brutos));
  if (cache.size >= 8) {
    const velho = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (velho) cache.delete(velho[0]);
  }
  cache.set(exercicio, { itens: consolidado, ts: Date.now() });
  return consolidado;
}

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Converte rubrica consolidada em item detalhado. */
function itemDetalhado(r: ExecucaoRubrica): ItemOrcamento {
  return {
    id: r.id,
    titulo: r.descricaoNaturezaDespesa || r.descricaoClassificacao || r.classificacaoFuncional || '—',
    subtitulo: [r.classificacaoFuncional, r.naturezaDespesa, r.funcao].filter(Boolean).join(' · '),
    dotacaoInicial: r.dotacaoInicial,
    dotacaoAutorizada: r.dotacaoAutorizada,
    empenhado: r.empenhado,
    liquidado: r.liquidado,
    pago: r.pago,
    pctExecucao: pctExecucao(r),
    estourado: r.empenhado > r.dotacaoAutorizada && r.dotacaoAutorizada > 0,
  };
}

/** Chave de grupo de uma rubrica conforme o agrupamento (mesma lógica do agregarPor). */
function chaveGrupo(r: ExecucaoRubrica, agruparPor: AgruparPor): string {
  if (agruparPor === 'funcao') return r.funcaoCodigo || r.funcao || '—';
  // Órgão = entidade/poder (XX): consolida as unidades filhas (XX.YY.ZZ) sob o órgão pai.
  if (agruparPor === 'orgao') return r.orgaoCodigo || r.unidadeOrcamentaria || r.unidadeGestora || '—';
  return r.id;
}

/** Agrega rubricas por chave (função ou órgão) somando os valores. */
function agregarPor(rubricas: ExecucaoRubrica[], chaveFn: (r: ExecucaoRubrica) => { id: string; titulo: string; subtitulo: string }): ItemOrcamento[] {
  const grupos = new Map<string, ItemOrcamento>();
  for (const r of rubricas) {
    const { id, titulo, subtitulo } = chaveFn(r);
    let g = grupos.get(id);
    if (!g) {
      g = { id, titulo, subtitulo, dotacaoInicial: 0, dotacaoAutorizada: 0, empenhado: 0, liquidado: 0, pago: 0, pctExecucao: 0, estourado: false, nRubricas: 0 };
      grupos.set(id, g);
    }
    g.dotacaoInicial += r.dotacaoInicial;
    g.dotacaoAutorizada += r.dotacaoAutorizada;
    g.empenhado += r.empenhado;
    g.liquidado += r.liquidado;
    g.pago += r.pago;
    g.nRubricas = (g.nRubricas ?? 0) + 1;
  }
  for (const g of grupos.values()) {
    g.pctExecucao = pctExecucao(g);
    g.estourado = g.empenhado > g.dotacaoAutorizada && g.dotacaoAutorizada > 0;
  }
  return [...grupos.values()];
}

type OrdenarPor = 'autorizada' | 'empenhado' | 'pct' | 'inicial';

/** Valor de ordenação de um item conforme o critério escolhido. */
function chaveOrdValor(i: ItemOrcamento, ordenarPor: OrdenarPor): number {
  return ordenarPor === 'empenhado'
    ? i.empenhado
    : ordenarPor === 'pct'
      ? i.pctExecucao
      : ordenarPor === 'inicial'
        ? i.dotacaoInicial
        : i.dotacaoAutorizada;
}

/** Predicado da faixa de execução (estourado/alta/media/baixa). */
function filtraSituacao(i: ItemOrcamento, situacao: string): boolean {
  if (situacao === 'estourado') return i.estourado;
  if (situacao === 'alta') return !i.estourado && i.pctExecucao >= 80;
  if (situacao === 'media') return i.pctExecucao >= 40 && i.pctExecucao < 80;
  if (situacao === 'baixa') return i.pctExecucao < 40;
  return true;
}

/** Soma os agregados de um conjunto de itens (drill-down). */
function somarAgregados(itens: ItemOrcamento[]): OrcamentoAgregados {
  const a: OrcamentoAgregados = {
    nRubricas: itens.length,
    dotacaoInicial: itens.reduce((s, r) => s + r.dotacaoInicial, 0),
    dotacaoAutorizada: itens.reduce((s, r) => s + r.dotacaoAutorizada, 0),
    empenhado: itens.reduce((s, r) => s + r.empenhado, 0),
    liquidado: itens.reduce((s, r) => s + r.liquidado, 0),
    pago: itens.reduce((s, r) => s + r.pago, 0),
    estouradas: itens.reduce((n, r) => n + (r.estourado ? 1 : 0), 0),
    pctExecucaoGlobal: 0,
  };
  a.pctExecucaoGlobal = a.dotacaoAutorizada > 0 ? (a.empenhado / a.dotacaoAutorizada) * 100 : 0;
  return a;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json({ erro: 'acesso negado ao NEXO' }, { status: sessao.status, headers: headersNoStore });
  }
  const idToken = sessao.idToken;
  const { searchParams } = new URL(req.url);
  const exercicio = Math.trunc(Number(searchParams.get('exercicio'))) || new Date().getFullYear();
  const agruparPor = (['rubrica', 'funcao', 'orgao'].includes(searchParams.get('agruparPor') ?? '') ? searchParams.get('agruparPor') : 'rubrica') as AgruparPor;
  // Drill-down hierárquico. `detalheDe` = id do grupo a expandir; `nivel` diz O
  // QUE listar: 'unidade' (órgão → secretarias) ou 'rubrica' (secretaria/função →
  // rubricas). Nível EXPLÍCITO (não inferido do formato do código) p/ funcionar
  // com qualquer UnidadeOrcamentaria (com ou sem pontos). Ausente = 'rubrica'.
  const detalheDe = (searchParams.get('detalheDe') ?? '').trim();
  const nivel = (searchParams.get('nivel') ?? '').trim(); // '' | 'unidade' | 'rubrica'
  const q = (searchParams.get('q') ?? '').trim();
  const funcao = (searchParams.get('funcao') ?? '').trim();
  const orgao = (searchParams.get('orgao') ?? '').trim();
  const situacao = (searchParams.get('situacao') ?? '').trim(); // estourado | alta | media | baixa
  const ordenarPor = (['autorizada', 'empenhado', 'pct', 'inicial'].includes(searchParams.get('ordenarPor') ?? '') ? searchParams.get('ordenarPor') : 'autorizada') as 'autorizada' | 'empenhado' | 'pct' | 'inicial';
  const dir = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  const tamanho = Math.min(TAMANHO_MAX, Math.max(1, Math.trunc(Number(searchParams.get('tamanho'))) || TAMANHO_PADRAO));
  const pagina = Math.max(0, Math.trunc(Number(searchParams.get('pagina'))) || 0);

  let rubricas: ExecucaoRubrica[];
  try {
    rubricas = await obterAno(exercicio, idToken);
  } catch (err) {
    return NextResponse.json({ erro: err instanceof Error ? err.message : 'erro ao ler nexo_despesa_sintetica' }, { status: 502, headers: headersNoStore });
  }

  if (rubricas.length === 0) {
    const vazio: OrcamentoResponse = {
      exercicio, agruparPor, total: 0, pagina: 0, tamanho, itens: [],
      agregados: { nRubricas: 0, dotacaoInicial: 0, dotacaoAutorizada: 0, empenhado: 0, liquidado: 0, pago: 0, estouradas: 0, pctExecucaoGlobal: 0 },
      ingestao: { status: 'pendente' }, atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(vazio, { headers: headersCache });
  }

  // Filtra rubricas (antes de agregar).
  const termo = norm(q);
  const fRubricas = rubricas.filter((r) => {
    if (funcao && norm(r.funcao).indexOf(norm(funcao)) < 0 && r.funcaoCodigo !== funcao) return false;
    if (orgao && norm(r.descricaoUnidadeOrcamentaria + ' ' + r.unidadeGestora + ' ' + r.unidadeOrcamentaria).indexOf(norm(orgao)) < 0) return false;
    if (termo) {
      const alvo = norm([r.descricaoNaturezaDespesa, r.descricaoClassificacao, r.classificacaoFuncional, r.naturezaDespesa, r.funcao, r.descricaoUnidadeOrcamentaria].join(' '));
      if (alvo.indexOf(termo) < 0) return false;
    }
    return true;
  });

  // Drill-down HIERÁRQUICO (órgão → unidade/secretaria → rubrica). Respeita os
  // mesmos filtros (q/órgão/situação/ordem). Só dispara com `detalheDe` e
  // agrupamento órgão/função (em 'rubrica' não há filhos a expandir).
  if (detalheDe && (agruparPor === 'orgao' || agruparPor === 'funcao')) {
    const sinalF = dir === 'asc' ? 1 : -1;

    // NÍVEL 1 (só por órgão, nivel=unidade): expandir um ÓRGÃO lista suas
    // UNIDADES/secretarias — cada uma, por sua vez, expansível para as rubricas
    // (nível 2, nivel=rubrica). A distinção vem do `nivel` EXPLÍCITO mandado pela
    // UI conforme a profundidade do nó (não do formato do código). Função não
    // tem nível intermediário (sempre cai em rubricas).
    if (agruparPor === 'orgao' && nivel === 'unidade') {
      const doOrgao = fRubricas.filter(
        (r) => (r.orgaoCodigo || r.unidadeOrcamentaria || r.unidadeGestora || '—') === detalheDe,
      );
      let unidades = agregarPor(doOrgao, (r) => ({
        id: r.unidadeOrcamentaria || '—',
        titulo: r.descricaoUnidadeOrcamentaria || r.unidadeOrcamentaria || '—',
        subtitulo: `Unidade ${r.unidadeOrcamentaria}${r.orgaoNome ? ' · ' + r.orgaoNome : ''}`,
      }));
      if (situacao) unidades = unidades.filter((i) => filtraSituacao(i, situacao));
      unidades.sort((a, b) => sinalF * (chaveOrdValor(a, ordenarPor) - chaveOrdValor(b, ordenarPor)) || a.titulo.localeCompare(b.titulo));
      const respostaU: OrcamentoResponse = {
        exercicio, agruparPor, total: unidades.length, pagina: 0, tamanho: unidades.length || 1,
        itens: unidades, agregados: somarAgregados(unidades), ingestao: { status: 'ok' }, atualizadoEm: new Date().toISOString(),
      };
      return NextResponse.json(respostaU, { headers: headersCache });
    }

    // NÍVEL 2: expandir uma UNIDADE (XX.YY.ZZ, no agrupamento por órgão) ou uma
    // FUNÇÃO lista as RUBRICAS detalhadas que a compõem.
    let filhos = fRubricas
      .filter((r) =>
        agruparPor === 'orgao'
          ? (r.unidadeOrcamentaria || '') === detalheDe
          : chaveGrupo(r, 'funcao') === detalheDe,
      )
      .map(itemDetalhado);
    if (situacao) filhos = filhos.filter((i) => filtraSituacao(i, situacao));
    filhos.sort((a, b) => sinalF * (chaveOrdValor(a, ordenarPor) - chaveOrdValor(b, ordenarPor)) || a.titulo.localeCompare(b.titulo));

    const respostaF: OrcamentoResponse = {
      exercicio, agruparPor, total: filhos.length, pagina: 0, tamanho: filhos.length || 1,
      itens: filhos, agregados: somarAgregados(filhos), ingestao: { status: 'ok' }, atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(respostaF, { headers: headersCache });
  }

  // Agregados globais (do recorte filtrado, sempre sobre rubricas).
  const agregados: OrcamentoAgregados = {
    nRubricas: fRubricas.length,
    dotacaoInicial: fRubricas.reduce((s, r) => s + r.dotacaoInicial, 0),
    dotacaoAutorizada: fRubricas.reduce((s, r) => s + r.dotacaoAutorizada, 0),
    empenhado: fRubricas.reduce((s, r) => s + r.empenhado, 0),
    liquidado: fRubricas.reduce((s, r) => s + r.liquidado, 0),
    pago: fRubricas.reduce((s, r) => s + r.pago, 0),
    estouradas: fRubricas.reduce((n, r) => n + (r.empenhado > r.dotacaoAutorizada && r.dotacaoAutorizada > 0 ? 1 : 0), 0),
    pctExecucaoGlobal: 0,
  };
  agregados.pctExecucaoGlobal = agregados.dotacaoAutorizada > 0 ? (agregados.empenhado / agregados.dotacaoAutorizada) * 100 : 0;

  // Monta itens conforme o agrupamento.
  let itens: ItemOrcamento[];
  if (agruparPor === 'funcao') {
    itens = agregarPor(fRubricas, (r) => ({ id: r.funcaoCodigo || r.funcao || '—', titulo: r.funcao || `Função ${r.funcaoCodigo}`, subtitulo: `Função ${r.funcaoCodigo}` }));
  } else if (agruparPor === 'orgao') {
    // Consolida pelo ÓRGÃO PAI (XX): Câmara (01) e Prefeitura (02) somam todas as
    // suas unidades filhas. O título vem da UnidadeGestora (nome da entidade); o
    // subtítulo mostra o código de órgão "XX.00.00". Cada órgão é expansível para
    // suas UNIDADES/secretarias (nível 1 do drill).
    const chaveOrgao = (r: ExecucaoRubrica) =>
      r.orgaoCodigo || r.unidadeOrcamentaria || r.unidadeGestora || '—';
    itens = agregarPor(fRubricas, (r) => ({
      id: chaveOrgao(r),
      titulo: r.orgaoNome || r.descricaoUnidadeOrcamentaria || r.unidadeGestora || '—',
      subtitulo: `Órgão ${r.orgaoCodigo}.00.00`,
    }));
    // Conta UNIDADES distintas por órgão (badge "N unidade(s)" no nível 1).
    const unidadesPorOrgao = new Map<string, Set<string>>();
    for (const r of fRubricas) {
      const k = chaveOrgao(r);
      let s = unidadesPorOrgao.get(k);
      if (!s) { s = new Set(); unidadesPorOrgao.set(k, s); }
      if (r.unidadeOrcamentaria) s.add(r.unidadeOrcamentaria);
    }
    for (const it of itens) {
      it.nUnidades = unidadesPorOrgao.get(it.id)?.size ?? 0;
      delete it.nRubricas; // no nível de órgão o badge é de unidades, não rubricas
    }
  } else {
    itens = fRubricas.map(itemDetalhado);
  }

  // Situação (sobre o item).
  if (situacao) {
    itens = itens.filter((i) => {
      if (situacao === 'estourado') return i.estourado;
      if (situacao === 'alta') return !i.estourado && i.pctExecucao >= 80;
      if (situacao === 'media') return i.pctExecucao >= 40 && i.pctExecucao < 80;
      if (situacao === 'baixa') return i.pctExecucao < 40;
      return true;
    });
  }

  // Ordena.
  const sinal = dir === 'asc' ? 1 : -1;
  const chaveOrd = (i: ItemOrcamento) =>
    ordenarPor === 'empenhado' ? i.empenhado : ordenarPor === 'pct' ? i.pctExecucao : ordenarPor === 'inicial' ? i.dotacaoInicial : i.dotacaoAutorizada;
  itens.sort((a, b) => sinal * (chaveOrd(a) - chaveOrd(b)) || a.titulo.localeCompare(b.titulo));

  const total = itens.length;
  const pag = itens.slice(pagina * tamanho, pagina * tamanho + tamanho);

  const resposta: OrcamentoResponse = {
    exercicio, agruparPor, total, pagina, tamanho, itens: pag, agregados,
    ingestao: { status: 'ok' }, atualizadoEm: new Date().toISOString(),
  };
  return NextResponse.json(resposta, { headers: headersCache });
}
