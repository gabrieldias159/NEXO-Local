/**
 * GET /api/nexo/rap — painel RAP dedicado (Restos a Pagar), série ANUAL
 * 2013→atual (§5.3 do spec).
 *
 * Para cada exercício da faixa, apura:
 *   - RAP do SICONFI persistido (`nexo_indicadores_fiscais`): RGF Anexo 05
 *     (maior quadrimestre) + RREO Anexo 07 (maior bimestre) via
 *     `apurarRestosAPagar` → inscritos, processados, não processados,
 *     disponibilidade de caixa, cobertura e situação (ok/atencao/critico).
 *   - Detalhe SMARAPD (`nexo_restos`, módulo `restoapagar`): soma e nº de
 *     registros por fornecedor — a granularidade que o portal tem (2025+).
 *   - Liquidação/pagamento REAIS do TCE-SP (`nexo_tce_despesas_eventos`,
 *     F1b): Σ eventos `liquidado`/`pago` do exercício.
 *
 * REGRA DA HONESTIDADE: ano sem coleta volta com `temDados: false` e valores
 * `null` — a UI mostra "sem dado" e nunca inventa zero. Origem/confiança selam
 * cada ano conforme a fonte (A1). `rapProcessados`/`rapNaoProcessados` são
 * best-effort: quando o SICONFI não publica de forma extraível, voltam `null`
 * (não se força soma de coluna errada).
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import { apurarRestosAPagar, somarLinhas } from '@/lib/nexo/siconfi-fiscal';
import { normalizarRestosAPagar } from '@/lib/nexo/normalizar';

export const runtime = 'nodejs';

const headersCache = { 'Cache-Control': 'private, max-age=120' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

const ANO_MIN = 2013;
const ANO_MAX = new Date().getFullYear() + 1;

export type OrigemRap = 'SICONFI' | 'SMARAPD' | 'TCE-SP' | 'sem-dados';
export type ConfiancaRap = 'alta' | 'media' | null;
export type SituacaoRap = 'ok' | 'atencao' | 'critico' | null;

export interface PontoRapAnual {
  exercicio: number;
  temDados: boolean;
  /** RAP inscritos/saldo do exercício (RGF Anexo 05 / RREO Anexo 07). */
  rapInscritos: number | null;
  /** Restos a pagar processados (best-effort SICONFI). */
  rapProcessados: number | null;
  /** Restos a pagar não processados (best-effort SICONFI). */
  rapNaoProcessados: number | null;
  /** RAP de exercícios anteriores ainda em aberto, quando publicado. */
  rapAnteriores: number | null;
  /** Disponibilidade de caixa líquida (RGF Anexo 05). */
  disponibilidadeCaixa: number | null;
  /** disponibilidadeCaixa ÷ rapInscritos × 100 (null sem um dos lados). */
  coberturaCaixa: number | null;
  situacao: SituacaoRap;
  /** Período apurado na fonte (ex.: "3º quad. 2025"). */
  periodoRef: string | null;
  /** Detalhe SMARAPD — nº de registros do módulo `restoapagar` no ano. */
  restosRegistros: number | null;
  /** Detalhe SMARAPD — soma dos RAP do módulo `restoapagar` no ano. */
  restosTotal: number | null;
  /** Liquidação REAL do TCE-SP (Σ eventos `liquidado`) — null sem TCE. */
  liquidado: number | null;
  /** Pagamento REAL do TCE-SP (Σ eventos `pago`) — null sem TCE. */
  pago: number | null;
  origem: OrigemRap;
  confianca: ConfiancaRap;
}

export interface RestoCredor {
  exercicio: number;
  cpfCnpj: string;
  nome: string;
  valor: number;
  qtde: number;
}

export interface RapResponse {
  de: number;
  ate: number;
  anos: PontoRapAnual[];
  /** Top credores por RAP (SMARAPD), somado na faixa, ordenado por valor. */
  credores: RestoCredor[];
  atualizadoEm: string;
}

interface CacheAnoRap {
  ponto: PontoRapAnual;
  credores: RestoCredor[];
  ts: number;
}

const cacheRap = new Map<string, CacheAnoRap>();
const TTL_MS = 5 * 60 * 1000;

const CAMPOS_SICONFI = ['tipoDemonstrativo', 'periodo', 'itens'] as const;
const CAMPOS_RESTO = [
  'CPFCNPJ', 'CNPJ', 'CpfCnpj',
  'NomeFornecedor', 'Fornecedor',
  'ValorRestoAPagar', 'ValorInscrito', 'SaldoRestoAPagar', 'Valor', 'ValorEmpenhado',
] as const;
const CAMPOS_TCE_EVENTO = ['_evento', 'valorEvento'] as const;

/** Maior período disponível de um demonstrativo (RGF 3→1, RREO 6→1). */
function maiorPeriodo(
  docs: Record<string, unknown>[],
  tipo: string,
): { items: Record<string, unknown>[]; periodo: number } | null {
  let melhor: { items: Record<string, unknown>[]; periodo: number } | null = null;
  for (const d of docs) {
    if (d.tipoDemonstrativo !== tipo) continue;
    const p = Number(d.periodo) || 0;
    if (p > 0 && (!melhor || p > melhor.periodo)) {
      melhor = { items: (d.itens as Record<string, unknown>[]) ?? [], periodo: p };
    }
  }
  return melhor;
}

/** Soma dos valores de um evento TCE num exercício (null se nenhum doc). */
function somarEventoTce(
  docs: Record<string, unknown>[],
  evento: string,
): number | null {
  let total = 0;
  let achou = false;
  for (const d of docs) {
    if (d._evento !== evento) continue;
    const v = Number(d.valorEvento);
    if (!Number.isFinite(v)) continue;
    total += v;
    achou = true;
  }
  return achou ? total : null;
}

function pontoVazio(exercicio: number): PontoRapAnual {
  return {
    exercicio,
    temDados: false,
    rapInscritos: null,
    rapProcessados: null,
    rapNaoProcessados: null,
    rapAnteriores: null,
    disponibilidadeCaixa: null,
    coberturaCaixa: null,
    situacao: null,
    periodoRef: null,
    restosRegistros: null,
    restosTotal: null,
    liquidado: null,
    pago: null,
    origem: 'sem-dados',
    confianca: null,
  };
}

/** Extrai processados/não processados do RGF Anexo 05 (best-effort honesto). */
function extrairRapProcessado(
  rgfItems: Record<string, unknown>[],
): { processados: number | null; naoProcessados: number | null } {
  const processados = somarLinhas(
    rgfItems,
    [/TOTAL.*RECURSOS|TOTAL\b/],
    /RESTOS A PAGAR PROCESSADOS/,
  );
  const naoProcessados = somarLinhas(
    rgfItems,
    [/TOTAL.*RECURSOS|TOTAL\b/],
    /RESTOS A PAGAR N[ÃA]O PROCESSADOS/,
  );
  return { processados, naoProcessados };
}

async function pontoAno(exercicio: number, idToken: string): Promise<CacheAnoRap> {
  const chaveCache = String(exercicio);
  const cache = cacheRap.get(chaveCache);
  if (cache && Date.now() - cache.ts < TTL_MS) return cache;

  const [docsSiconfi, docsRestos, docsTce] = await Promise.all([
    lerColecaoNexo(
      'nexo_indicadores_fiscais',
      { exercicio, fonte: 'siconfi' },
      idToken,
      [...CAMPOS_SICONFI],
    ),
    lerColecaoNexo('nexo_restos', { exercicio, fonte: 'restos' }, idToken, [
      ...CAMPOS_RESTO,
    ]),
    lerColecaoNexo(
      'nexo_tce_despesas_eventos',
      { exercicio },
      idToken,
      [...CAMPOS_TCE_EVENTO],
    ),
  ]);

  const restos = normalizarRestosAPagar(docsRestos, exercicio);
  const restosTotal = restos.reduce((s, r) => s + r.valor, 0);
  const temRestos = restos.length > 0;

  const rgf = maiorPeriodo(docsSiconfi, 'RGF');
  const rreo = maiorPeriodo(docsSiconfi, 'RREO');
  const periodoRef = rgf
    ? `${rgf.periodo}º quad. ${exercicio}`
    : rreo
      ? `${rreo.periodo}º bim. ${exercicio}`
      : null;
  const apuracao = apurarRestosAPagar(
    rgf?.items ?? [],
    rreo?.items ?? [],
    periodoRef,
  );
  const rapProc = rgf ? extrairRapProcessado(rgf.items) : { processados: null, naoProcessados: null };

  const liquidado = somarEventoTce(docsTce, 'liquidado');
  const pago = somarEventoTce(docsTce, 'pago');
  const temTce = liquidado != null || pago != null;

  const temDados = apuracao.rapInscritos != null || temRestos || temTce;
  if (!temDados) {
    const vazio = pontoVazio(exercicio);
    const r: CacheAnoRap = { ponto: vazio, credores: [], ts: Date.now() };
    cacheRap.set(chaveCache, r);
    return r;
  }

  const coberturaCaixa =
    apuracao.rapInscritos != null &&
    apuracao.disponibilidadeCaixa != null &&
    apuracao.rapInscritos > 0
      ? (apuracao.disponibilidadeCaixa / apuracao.rapInscritos) * 100
      : null;
  const situacao: SituacaoRap =
    coberturaCaixa == null
      ? null
      : coberturaCaixa >= 100
        ? 'ok'
        : coberturaCaixa >= 60
          ? 'atencao'
          : 'critico';

  // Origem/confiança (A1): SICONFI para o agregado quando disponível; o
  // detalhe SMARAPD e os pagamentos TCE somam como camadas identificadas.
  const origem: OrigemRap = apuracao.rapInscritos != null ? 'SICONFI' : temRestos ? 'SMARAPD' : 'TCE-SP';

  const credores: RestoCredor[] = restos.map((r) => ({
    exercicio,
    cpfCnpj: r.cpfCnpj,
    nome: r.fornecedorNome,
    valor: r.valor,
    qtde: 1,
  }));

  const ponto: PontoRapAnual = {
    exercicio,
    temDados: true,
    rapInscritos: apuracao.rapInscritos,
    rapProcessados: rapProc.processados,
    rapNaoProcessados: rapProc.naoProcessados,
    rapAnteriores: apuracao.rapAnteriores,
    disponibilidadeCaixa: apuracao.disponibilidadeCaixa,
    coberturaCaixa,
    situacao,
    periodoRef: apuracao.periodo,
    restosRegistros: temRestos ? restos.length : null,
    restosTotal: temRestos ? restosTotal : null,
    liquidado,
    pago,
    origem,
    confianca: origem === 'SICONFI' ? 'alta' : 'media',
  };

  const resultado: CacheAnoRap = { ponto, credores, ts: Date.now() };
  cacheRap.set(chaveCache, resultado);
  return resultado;
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

    const anos: number[] = [];
    for (let a = deClamp; a <= ateClamp; a++) anos.push(a);

    const todos: CacheAnoRap[] = [];
    for (const a of anos) {
      todos.push(await pontoAno(a, sessao.idToken));
    }

    // Top credores da faixa, somando anos repetidos (mesmo CNPJ/nome).
    const porCredor = new Map<string, RestoCredor>();
    for (const c of todos.flatMap((t) => t.credores)) {
      const chave = `${c.exercicio}|${c.cpfCnpj}|${c.nome}`;
      const existente = porCredor.get(chave);
      if (existente) {
        existente.valor += c.valor;
        existente.qtde += c.qtde;
      } else {
        porCredor.set(chave, { ...c });
      }
    }
    const credores = [...porCredor.values()]
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 200);

    const resp: RapResponse = {
      de: deClamp,
      ate: ateClamp,
      anos: todos.map((t) => t.ponto),
      credores,
      atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(resp, { status: 200, headers: headersCache });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro ao processar painel RAP';
    return NextResponse.json({ erro: msg }, { status: 500, headers: headersNoStore });
  }
}
