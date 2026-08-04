/**
 * GET /api/nexo/orcamento-evolucao — série ANUAL consolidada para o painel
 * "Evolução Orçamentária" (multi-ano, 2013→atual).
 *
 * Para cada exercício da faixa, agrega `nexo_despesa_sintetica` no estado atual
 * (maior mês por rubrica, via `consolidarPorRubrica`) em: dotação inicial,
 * dotação autorizada, empenhado, liquidado (derivado pago + a liquidar) e pago.
 * Quando a receita anual (`nexo_receita`) existe para o ano, soma a arrecadação.
 *
 * REGRA DA HONESTIDADE: ano sem coleta volta com `temDados: false` e valores
 * `null` (a UI mostra "sem dado" e nunca inventa zero). Origem/confiança selam
 * cada ano conforme a fonte dos dados — tudo identificável, como decidido em A1.
 *
 * Agrupamentos: `municipio` (padrão) traz um ponto por ano; `orgao`/`funcao`
 * traz a mesma série por categoria (para o drill comparativo).
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import { normalizarExecucaoSintetica, consolidarPorRubrica } from '@/lib/nexo/orcamento';
import { normalizarReceitas, CAMPOS_RECEITA } from '@/lib/nexo/sources/receita';

export const runtime = 'nodejs';

const headersCache = { 'Cache-Control': 'private, max-age=120' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

const CAMPOS_DESPESA = [
  'ClassificacaoFuncional',
  'DescricaoClassificacaoFuncional',
  'NaturezaDespesa',
  'DescricaoNaturezaDespesa',
  'FonteRecurso',
  'UnidadeOrcamentaria',
  'DescricaoUnidadeOrcamentaria',
  'UnidadeGestora',
  'Funcao',
  'DescricaoFuncao',
  'Mes',
  'DotacaoInicial',
  'DotacaoAutorizada',
  'EmpenhadoAteMes',
  'LiquidadoaPagar',
  'PagoAteMes',
  '_coletadoEm',
];

/** Campos do evento TCE-SP (F1b) usados para liquidação/pagamento reais (§5.4). */
const CAMPOS_TCE_EVENTO: string[] = ['_evento', 'valorEvento'];

/** Origem dos dados de um ano (decisão A1 — sempre identificável). */
export type OrigemEvolucao = 'SMARAPD' | 'SICONFI' | 'TCE-SP' | 'sem-dados';
export type ConfiancaEvolucao = 'alta' | 'media' | null;

export interface PontoEvolucaoAnual {
  exercicio: number;
  temDados: boolean;
  dotacaoInicial: number | null;
  dotacaoAutorizada: number | null;
  empenhado: number | null;
  liquidado: number | null;
  pago: number | null;
  /**
   * Liquidação REAL do TCE-SP (Σ eventos `Valor Liquidado`, 2014+) — §5.4.
   * Null quando o TCE ainda não publicou/coletou o ano.
   */
  liquidadoDireto: number | null;
  /**
   * Origem da liquidação (§5.4): 'tce' (real, prioridade 1) | 'sintese'
   * (derivada `pago + a liquidar` do SMARAPD, fallback) | null sem dados.
   */
  fonteLiquidacao: 'tce' | 'sintese' | null;
  /** empenhado − pago (estoque de obrigações a pagar no fim do ano). */
  restandoAPagar: number | null;
  /** % empenhado sobre a dotação autorizada (null sem dotação). */
  pctExecucao: number | null;
  /** Número de rubricas estouradas (empenhado > autorizada). */
  estouradas: number;
  /** Total arrecadado no ano (receita corrente, do Portal); null se não coletado. */
  arrecadado: number | null;
  origem: OrigemEvolucao;
  confianca: ConfiancaEvolucao;
  /** Último mês observado na fonte (cobertura do ano). */
  ultimoMesObservado: number | null;
}

export type AgrupadorEvolucao = 'municipio' | 'orgao' | 'funcao';

export interface CategoriaEvolucao {
  chave: string;
  titulo: string;
  subtitulo: string;
  anos: PontoEvolucaoAnual[];
}

export interface OrcamentoEvolucaoResponse {
  de: number;
  ate: number;
  agruparPor: AgrupadorEvolucao;
  municipio: PontoEvolucaoAnual[];
  categorias: CategoriaEvolucao[];
  atualizadoEm: string;
}

/** Limite anual mínimo permitido (histórico antes de 2013 não existe no SMARAPD). */
const ANO_MIN = 2013;
const ANO_MAX = new Date().getFullYear() + 1;

interface CacheAnoEv {
  pontos: Map<string, PontoEvolucaoAnual>;
  ts: number;
}

const cacheEv = new Map<string, CacheAnoEv>();
const TTL_MS = 5 * 60 * 1000;

function pontoVazio(exercicio: number): PontoEvolucaoAnual {
  return {
    exercicio,
    temDados: false,
    dotacaoInicial: null,
    dotacaoAutorizada: null,
    empenhado: null,
    liquidado: null,
    pago: null,
    liquidadoDireto: null,
    fonteLiquidacao: null,
    restandoAPagar: null,
    pctExecucao: null,
    estouradas: 0,
    arrecadado: null,
    origem: 'sem-dados',
    confianca: null,
    ultimoMesObservado: null,
  };
}

/**
 * Carrega e consolida UM exercício da `nexo_despesa_sintetica` no estado atual,
 * retornando um ponto anual com origem/confiança (SMARAPD quando há rubricas).
 */
async function pontoAno(exercicio: number, idToken: string): Promise<PontoEvolucaoAnual> {
  const chaveCache = String(exercicio);
  const cache = cacheEv.get(chaveCache);
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.pontos.get('__municipio__')!;

  const [docsDespesa, docsReceita, docsTce] = await Promise.all([
    lerColecaoNexo(
      'nexo_despesa_sintetica',
      { exercicio, fonte: 'despesa_sintetica' },
      idToken,
      CAMPOS_DESPESA,
    ),
    lerColecaoNexo('nexo_receita', { exercicio, fonte: 'receita' }, idToken, CAMPOS_RECEITA),
    lerColecaoNexo(
      'nexo_tce_despesas_eventos',
      { exercicio },
      idToken,
      CAMPOS_TCE_EVENTO,
    ),
  ]);

  const rubricas = consolidarPorRubrica(normalizarExecucaoSintetica(docsDespesa));
  const receitas = normalizarReceitas(docsReceita, exercicio);

  if (rubricas.length === 0) {
    const vazio = pontoVazio(exercicio);
    cacheEv.set(chaveCache, { pontos: new Map([['__municipio__', vazio]]), ts: Date.now() });
    return vazio;
  }

  let dotacaoInicial = 0;
  let dotacaoAutorizada = 0;
  let empenhado = 0;
  let liquidado = 0;
  let pago = 0;
  let estouradas = 0;
  let ultimoMes = 0;
  for (const r of rubricas) {
    dotacaoInicial += r.dotacaoInicial;
    dotacaoAutorizada += r.dotacaoAutorizada;
    empenhado += r.empenhado;
    liquidado += r.liquidado;
    pago += r.pago;
    if (r.empenhado > r.dotacaoAutorizada && r.dotacaoAutorizada > 0) estouradas++;
    if (r.mes > ultimoMes) ultimoMes = r.mes;
  }

  // Receita anual: soma o arrecadado mensal (mes 1–12). Ignora o registro anual
  // (mes 0), que carrega só `previsto` (arrecadado 0) para não inflar o total.
  let arrecadado = 0;
  let receitaObservada = false;
  for (const rec of receitas) {
    if (rec.mes >= 1 && rec.mes <= 12 && rec.arrecadado > 0) {
      arrecadado += rec.arrecadado;
      receitaObservada = true;
    }
  }

  // Liquidação/pagamento REAIS do TCE-SP (F1b) — §5.4: preferir o evento
  // `Valor Liquidado`/`Valor Pago` quando disponível (2014+).
  let liquidadoTce = 0;
  let pagoTce = 0;
  let tceObservado = false;
  for (const d of docsTce) {
    if (d._evento === 'liquidado' && typeof d.valorEvento === 'number') {
      liquidadoTce += d.valorEvento;
      tceObservado = true;
    } else if (d._evento === 'pago' && typeof d.valorEvento === 'number') {
      pagoTce += d.valorEvento;
      tceObservado = true;
    }
  }
  const liquidadoDireto = tceObservado ? liquidadoTce : null;
  const fonteLiquidacao: PontoEvolucaoAnual['fonteLiquidacao'] =
    tceObservado ? 'tce' : 'sintese';
  const liquidadoEfetivo = liquidadoDireto ?? liquidado;
  const pagoEfetivo = tceObservado ? pagoTce : pago;

  const ponto: PontoEvolucaoAnual = {
    exercicio,
    temDados: true,
    dotacaoInicial,
    dotacaoAutorizada,
    empenhado,
    liquidado: liquidadoEfetivo,
    pago: pagoEfetivo,
    liquidadoDireto,
    fonteLiquidacao,
    restandoAPagar: empenhado - pagoEfetivo,
    pctExecucao: dotacaoAutorizada > 0 ? (empenhado / dotacaoAutorizada) * 100 : null,
    estouradas,
    arrecadado: receitaObservada ? arrecadado : null,
    // Despesa consolidada vem do SMARAPD (empenho/dotação). Liquidação e
    // pagamento: TCE-SP real quando o ano tem eventos (F1b), senão a síntese
    // derivada — o selo sinaliza a origem (A1/§5.4).
    origem: tceObservado ? 'TCE-SP' : 'SMARAPD',
    confianca: 'alta',
    ultimoMesObservado: ultimoMes || null,
  };

  cacheEv.set(chaveCache, { pontos: new Map([['__municipio__', ponto]]), ts: Date.now() });
  return ponto;
}

/** Agrupa a série anual por categoria (órgão ou função) reutilizando a consolidação. */
const cacheCat = new Map<string, { cats: CategoriaEvolucao[]; ts: number }>();

async function categoriasAno(
  exercicio: number,
  agruparPor: 'orgao' | 'funcao',
  idToken: string,
): Promise<CategoriaEvolucao[]> {
  const chaveCache = `${exercicio}:${agruparPor}`;
  const cache = cacheCat.get(chaveCache);
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.cats;

  const docs = await lerColecaoNexo(
    'nexo_despesa_sintetica',
    { exercicio, fonte: 'despesa_sintetica' },
    idToken,
    CAMPOS_DESPESA,
  );
  const rubricas = consolidarPorRubrica(normalizarExecucaoSintetica(docs));

  const porCat = new Map<
    string,
    { titulo: string; subtitulo: string; dIni: number; dAut: number; emp: number; liq: number; pag: number; est: number }
  >();
  for (const r of rubricas) {
    let chave = '';
    let titulo = '';
    let subtitulo = '';
    if (agruparPor === 'orgao') {
      chave = r.orgaoCodigo || r.unidadeGestora || '—';
      titulo = r.orgaoNome || r.unidadeGestora || chave;
      subtitulo = r.orgaoCodigo ? `Órgão ${r.orgaoCodigo}` : 'Órgão';
    } else {
      chave = r.funcaoCodigo || r.funcao || '—';
      titulo = r.funcao || r.funcaoCodigo || '—';
      subtitulo = r.funcaoCodigo ? `Função ${r.funcaoCodigo}` : 'Função';
    }
    const g = porCat.get(chave) ?? { titulo, subtitulo, dIni: 0, dAut: 0, emp: 0, liq: 0, pag: 0, est: 0 };
    g.dIni += r.dotacaoInicial;
    g.dAut += r.dotacaoAutorizada;
    g.emp += r.empenhado;
    g.liq += r.liquidado;
    g.pag += r.pago;
    if (r.empenhado > r.dotacaoAutorizada && r.dotacaoAutorizada > 0) g.est++;
    porCat.set(chave, g);
  }

  const cats: CategoriaEvolucao[] = [];
  for (const [chave, g] of porCat) {
    const p: PontoEvolucaoAnual = {
      exercicio,
      temDados: true,
      dotacaoInicial: g.dIni,
      dotacaoAutorizada: g.dAut,
      empenhado: g.emp,
      liquidado: g.liq,
      pago: g.pag,
      // O agregado do TCE é municipal (sem recorte por órgão/função) — a
      // categoria preserva a síntese e sinaliza a origem honesta.
      liquidadoDireto: null,
      fonteLiquidacao: 'sintese',
      restandoAPagar: g.emp - g.pag,
      pctExecucao: g.dAut > 0 ? (g.emp / g.dAut) * 100 : null,
      estouradas: g.est,
      arrecadado: null,
      origem: 'SMARAPD',
      confianca: 'alta',
      ultimoMesObservado: null,
    };
    cats.push({ chave, titulo: g.titulo, subtitulo: g.subtitulo, anos: [p] });
  }

  cats.sort((a, b) => (b.anos[0]?.dotacaoAutorizada ?? 0) - (a.anos[0]?.dotacaoAutorizada ?? 0));
  cacheCat.set(chaveCache, { cats, ts: Date.now() });
  return cats;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json({ erro: 'Acesso negado' }, { status: sessao.status, headers: headersNoStore });
  }

  try {
    const { searchParams } = new URL(req.url);
    const de = Math.trunc(Number(searchParams.get('de'))) || ANO_MIN;
    const ate = Math.trunc(Number(searchParams.get('ate'))) || new Date().getFullYear();
    const deClamp = Math.max(ANO_MIN, Math.min(ANO_MAX, de));
    const ateClamp = Math.max(deClamp, Math.min(ANO_MAX, ate));
    const agParam = searchParams.get('agruparPor');
    const agruparPor: AgrupadorEvolucao =
      agParam === 'orgao' || agParam === 'funcao' ? agParam : 'municipio';

    const anos: number[] = [];
    for (let a = deClamp; a <= ateClamp; a++) anos.push(a);

    const municipio: PontoEvolucaoAnual[] = [];
    for (const a of anos) {
      municipio.push(await pontoAno(a, sessao.idToken));
    }

    let categorias: CategoriaEvolucao[] = [];
    if (agruparPor !== 'municipio') {
      const todas: CategoriaEvolucao[] = [];
      const porCatMap = new Map<string, { titulo: string; subtitulo: string; pontos: Map<number, PontoEvolucaoAnual> }>();
      for (const a of anos) {
        const cats = await categoriasAno(a, agruparPor, sessao.idToken);
        for (const c of cats) {
          let alvo = porCatMap.get(c.chave);
          if (!alvo) {
            alvo = { titulo: c.titulo, subtitulo: c.subtitulo, pontos: new Map() };
            porCatMap.set(c.chave, alvo);
          }
          alvo.pontos.set(a, c.anos[0]);
        }
      }
      for (const [chave, alvo] of porCatMap) {
        const anosSerie: PontoEvolucaoAnual[] = [];
        for (const a of anos) {
          anosSerie.push(alvo.pontos.get(a) ?? pontoVazio(a));
        }
        todas.push({ chave, titulo: alvo.titulo, subtitulo: alvo.subtitulo, anos: anosSerie });
      }
      // Ordena por dotação autorizada do último ano (maiores primeiro).
      todas.sort((a, b) => (b.anos[b.anos.length - 1]?.dotacaoAutorizada ?? 0) - (a.anos[a.anos.length - 1]?.dotacaoAutorizada ?? 0));
      categorias = todas;
    }

    const resp: OrcamentoEvolucaoResponse = {
      de: deClamp,
      ate: ateClamp,
      agruparPor,
      municipio,
      categorias,
      atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(resp, { status: 200, headers: headersCache });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro ao processar evolução orçamentária';
    return NextResponse.json({ erro: msg }, { status: 500, headers: headersNoStore });
  }
}
