/**
 * GET /api/nexo/alertas?exercicio=2026&status=&classificacao=
 *
 * Leitura dos alertas PRÉ-COMPUTADOS do NEXO (Fase 2 do monitoramento). A cron
 * roda os detectores (via `/api/nexo/detectar`) e persiste em `nexo_alertas`;
 * esta rota só LÊ alertas prontos — não computa nada. É o caminho rápido que
 * substitui a análise por-request de `/api/nexo/analise`.
 *
 * Origem: a coleção `nexo_alertas` do Firestore, lida via REST com a sessão do
 * próprio usuário (`lerColecaoNexo`). Filtros de `status`/`classificacao`/`ativo`
 * aplicados no servidor; ordenação por `valorEnvolvido` desc.
 *
 * Degradação honesta: se a coleção estiver vazia para o exercício (o monitor
 * ainda não rodou), responde 200 com lista vazia + `ingestao.status:'pendente'`
 * — a página mostra "rode a coleta" em vez de "nenhum indício".
 */
import { NextResponse } from 'next/server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import {
  avaliarCompute,
  sessaoLeitura,
  lerSnapshotPainel,
} from '@/lib/nexo/compute-guard';
import {
  compararPotencial,
  compararRecente,
  compararValor,
  derivarProbabilidadeEnquadramento,
} from '@/lib/nexo/prioridade';
import { enriquecerProcedencia } from '@/lib/nexo/procedencia';
import { confiancaIndicio, PISO_EXIBICAO_CONFIANCA } from '@/lib/nexo/calibragem';
import type { AlertaDetectado, Classificacao, Procedencia } from '@/lib/nexo/detectores';

export const runtime = 'nodejs';

/** Status de ciclo de vida de um alerta persistido em `nexo_alertas`. */
export type StatusAlerta =
  | 'aberta'
  | 'em_analise'
  | 'virou_investigacao'
  | 'arquivada'
  | 'falso_positivo';

/**
 * Um alerta como vem de `nexo_alertas`: o `AlertaDetectado` original + os
 * campos de pré-computação (chave estável, contadores, ciclo de vida).
 */
export interface AlertaPersistido extends AlertaDetectado {
  chaveDeteccao: string;
  exercicio: number;
  status: StatusAlerta;
  ativo: boolean;
  ocorrencias: number;
  primeiraDeteccaoEm: string | null;
  ultimaDeteccaoEm: string | null;
  resolvidoEm: string | null;
  investigacaoId: string | null;
}

/** Resposta da rota de leitura de alertas pré-computados. */
export interface AlertasResponse {
  exercicio: number;
  /** Total de alertas do recorte filtrado (pode ser > que `alertas.length`). */
  total: number;
  /** Soma de `valorEnvolvido` sobre TODO o recorte (não só os retornados). */
  valorSobAlerta: number;
  /** Alertas RETORNADOS — o topo por potencial (limitado p/ caber no payload). */
  alertas: AlertaPersistido[];
  /** true quando `alertas` foi truncado (total > alertas.length). */
  truncado: boolean;
  /**
   * Quantos alertas do recorte ficaram ABAIXO do piso de confiança (aba "baixa
   * confiança"). Não entram em `alertas`/`total` por padrão — o painel oferece
   * um toggle (?incluirBaixaConfianca=1) para auditá-los. Ver calibragem.ts.
   */
  baixaConfianca: number;
  /**
   * Estado da ingestão. `pendente` = coleção vazia para o exercício (o monitor
   * ainda não rodou); `ok` = há alertas pré-computados.
   */
  ingestao: { status: 'ok' | 'pendente'; ultimaDeteccaoEm: string | null };
  atualizadoEm: string;
}

/**
 * Teto de alertas no payload do painel. A rota devolvia TODOS os alertas do ano
 * (2026 ~= 20,6k docs ~= 33 MB) e estourava o limite de resposta NÃO-streamada
 * do App Hosting/Cloud Run (~32 MB): o cliente recebia JSON truncado e o
 * `JSON.parse` morria com "Bad control character ... position 3312xxxx". O
 * painel só consome os agregados (`total`/`valorSobAlerta`, completos) + o topo
 * por potencial; a materialização definitiva (snapshot) é a Frente F do plano.
 */
const LIMITE_PAINEL = 300;

const CLASSIFICACOES: readonly Classificacao[] = [
  'informativo',
  'atencao',
  'suspeita',
  'critico',
];
const STATUSES: readonly StatusAlerta[] = [
  'aberta',
  'em_analise',
  'virou_investigacao',
  'arquivada',
  'falso_positivo',
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

/**
 * Converte um doc bruto de `nexo_alertas` para `AlertaPersistido`. Tolera o
 * sujeito tanto aninhado (`sujeito.{tipo,id,rotulo}`, formato do schema Zod)
 * quanto achatado (`sujeitoTipo/sujeitoId/sujeitoRotulo`, formato do detector).
 */
function paraAlerta(doc: Record<string, unknown>): AlertaPersistido {
  const sujeito = (doc.sujeito ?? {}) as Record<string, unknown>;
  const sujeitoTipo = texto(
    doc.sujeitoTipo ?? sujeito.tipo,
    'orgao',
  ) as AlertaDetectado['sujeitoTipo'];
  const scores = (doc.scores ?? {}) as Record<string, unknown>;
  const evidenciasBrutas = Array.isArray(doc.evidencias) ? doc.evidencias : [];
  const fundamentoBruto = Array.isArray(doc.fundamentoLegal) ? doc.fundamentoLegal : [];
  const classe = texto(doc.classificacao, 'informativo') as Classificacao;
  const statusBruto = texto(doc.status, 'aberta') as StatusAlerta;

  return {
    detectorId: texto(doc.detectorId),
    detectorNome: texto(doc.detectorNome),
    categoria: texto(doc.categoria),
    titulo: texto(doc.titulo),
    descricao: texto(doc.descricao),
    sujeitoTipo,
    sujeitoId: texto(doc.sujeitoId ?? sujeito.id),
    sujeitoRotulo: texto(doc.sujeitoRotulo ?? sujeito.rotulo),
    classificacao: CLASSIFICACOES.includes(classe) ? classe : 'informativo',
    scores: {
      confiabilidade: numero(scores.confiabilidade),
      probabilidadeIrregularidade: numero(scores.probabilidadeIrregularidade),
      // 3ª perna do score triplo: usa a do detector se houver; senão DERIVA da
      // severidade + fundamento legal (régua jurídica), em vez do flat 50 — o
      // ranking por potencial passa a refletir o enquadramento de verdade.
      probabilidadeEnquadramento:
        scores.probabilidadeEnquadramento != null
          ? numero(scores.probabilidadeEnquadramento)
          : derivarProbabilidadeEnquadramento(
              CLASSIFICACOES.includes(classe) ? classe : 'informativo',
              fundamentoBruto.map((f) => texto(f)).filter(Boolean),
              sujeitoTipo,
            ),
    },
    fundamentoLegal: fundamentoBruto.map((f) => texto(f)).filter(Boolean),
    evidencias: evidenciasBrutas.map((ev) => {
      const e = (ev ?? {}) as Record<string, unknown>;
      const ref = textoOuNulo(e.ref) ?? undefined;
      // Procedência: a do detector se houver; senão deriva do ref + contexto,
      // para alertas antigos ganharem link de prova SEM reprocessar o Firestore.
      const procedencia =
        (e.procedencia as Procedencia | undefined) ??
        enriquecerProcedencia(
          ref,
          texto(doc.categoria),
          sujeitoTipo,
          numero(doc.exercicio ?? doc._exercicio),
        ) ??
        undefined;
      return {
        resumo: texto(e.resumo),
        valor: e.valor != null ? numero(e.valor) : undefined,
        data: textoOuNulo(e.data),
        ref,
        ...(procedencia ? { procedencia } : {}),
      };
    }),
    explicacao: texto(doc.explicacao),
    valorEnvolvido: numero(doc.valorEnvolvido),
    discriminador: textoOuNulo(doc.discriminador) ?? undefined,
    chaveDeteccao: texto(doc.chaveDeteccao ?? doc.id),
    exercicio: numero(doc.exercicio ?? doc._exercicio),
    status: STATUSES.includes(statusBruto) ? statusBruto : 'aberta',
    ativo: doc.ativo !== false,
    ocorrencias: numero(doc.ocorrencias, 1),
    primeiraDeteccaoEm: textoOuNulo(doc.primeiraDeteccaoEm ?? doc.detectadoEm),
    ultimaDeteccaoEm: textoOuNulo(doc.ultimaDeteccaoEm ?? doc.detectadoEm),
    resolvidoEm: textoOuNulo(doc.resolvidoEm),
    investigacaoId: textoOuNulo(doc.investigacaoId),
  };
}

/** Filtros opcionais aplicados ao recorte de alertas. */
interface FiltrosAlertas {
  statusFiltro: string | null;
  classeFiltro: string | null;
  ordem: string;
  /** Inclui os alertas abaixo do piso de confiança (aba "baixa confiança"). */
  incluirBaixaConfianca: boolean;
}

/**
 * NÚCLEO de cômputo — lê `nexo_alertas` do exercício, filtra/ordena e devolve o
 * `AlertasResponse` JÁ CAPADO em LIMITE_PAINEL (preserva o hotfix do payload de
 * 33 MB). Chamado nos DOIS modos: leitura (fallback sem snapshot) e compute (o
 * worker materializa este resultado). Não acessa `Request` — só dados.
 */
async function computar(
  exercicio: number,
  idToken: string,
  filtros: FiltrosAlertas,
): Promise<AlertasResponse> {
  const docs = await lerColecaoNexo('nexo_alertas', { exercicio }, idToken);

  // Coleção vazia para o exercício — o monitor ainda não pré-computou. Não é
  // erro: é estado honesto que a página traduz em "rode a coleta".
  if (docs.length === 0) {
    return {
      exercicio,
      total: 0,
      valorSobAlerta: 0,
      alertas: [],
      truncado: false,
      baixaConfianca: 0,
      ingestao: { status: 'pendente', ultimaDeteccaoEm: null },
      atualizadoEm: new Date().toISOString(),
    };
  }

  let alertas = docs.map(paraAlerta);

  // Filtros server-side. `status`/`classificacao` por querystring; `ativo`
  // padrão = só os ativos (alertas arquivados/resolvidos ficam fora salvo
  // quando o status é pedido explicitamente).
  if (filtros.statusFiltro && STATUSES.includes(filtros.statusFiltro as StatusAlerta)) {
    alertas = alertas.filter((a) => a.status === filtros.statusFiltro);
  } else {
    // Default: só ATIVOS e que não foram triados como falso positivo/arquivados.
    // Antes filtrava só por `ativo` — um alerta marcado falso_positivo que
    // reaparecesse na detecção voltava com ativo:true e ressurgia no painel
    // (A7 do plano de calibragem: a triagem humana tem que suprimir de verdade).
    alertas = alertas.filter(
      (a) => a.ativo && a.status !== 'falso_positivo' && a.status !== 'arquivada',
    );
  }
  if (filtros.classeFiltro && CLASSIFICACOES.includes(filtros.classeFiltro as Classificacao)) {
    alertas = alertas.filter((a) => a.classificacao === filtros.classeFiltro);
  }

  // PISO DE EXIBIÇÃO (calibragem A6): corroboração = nº de detectores DISTINTOS
  // sobre o mesmo sujeito (o mesmo CNPJ acusado por vários detectores é mais
  // crível). Abaixo do piso, o alerta vai para a aba "baixa confiança" (não some).
  const detectoresPorSujeito = new Map<string, Set<string>>();
  for (const a of alertas) {
    (detectoresPorSujeito.get(a.sujeitoId) ?? detectoresPorSujeito.set(a.sujeitoId, new Set()).get(a.sujeitoId)!).add(a.detectorId);
  }
  const abaixoDoPiso = (a: AlertaPersistido): boolean =>
    confiancaIndicio({
      confiabilidade: a.scores?.confiabilidade ?? 50,
      corroboracoes: detectoresPorSujeito.get(a.sujeitoId)?.size ?? 1,
      valorEnvolvido: a.valorEnvolvido || 0,
    }) < PISO_EXIBICAO_CONFIANCA;
  const baixaConfianca = alertas.filter(abaixoDoPiso).length;
  if (!filtros.incluirBaixaConfianca && !filtros.statusFiltro) {
    alertas = alertas.filter((a) => !abaixoDoPiso(a));
  }

  // Ordenação (decisão do dono): default por POTENCIAL (score triplo) desc;
  // ?ordem=recente (cronológico desc) ou ?ordem=valor (R$ desc, legado).
  if (filtros.ordem === 'valor') alertas.sort(compararValor);
  else if (filtros.ordem === 'recente') alertas.sort(compararRecente);
  else alertas.sort(compararPotencial);

  const ultimaDeteccaoEm = alertas.reduce<string | null>((rec, a) => {
    if (a.ultimaDeteccaoEm && (rec === null || a.ultimaDeteccaoEm > rec)) {
      return a.ultimaDeteccaoEm;
    }
    return rec;
  }, null);

  // Agregados sobre TODO o recorte (o painel mostra contagem e valor totais),
  // mas o array vai LIMITADO ao topo por potencial — senão o payload de 33 MB
  // estoura o teto de resposta do App Hosting e o cliente quebra no parse.
  const total = alertas.length;
  const valorSobAlerta = alertas.reduce((s, a) => s + (a.valorEnvolvido || 0), 0);
  const alertasTopo = total > LIMITE_PAINEL ? alertas.slice(0, LIMITE_PAINEL) : alertas;

  return {
    exercicio,
    total,
    valorSobAlerta,
    alertas: alertasTopo,
    truncado: total > LIMITE_PAINEL,
    baixaConfianca,
    ingestao: { status: 'ok', ultimaDeteccaoEm },
    atualizadoEm: new Date().toISOString(),
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const exercicio = Number(searchParams.get('exercicio')) || new Date().getFullYear();
  const filtros: FiltrosAlertas = {
    statusFiltro: searchParams.get('status'),
    classeFiltro: searchParams.get('classificacao'),
    ordem: searchParams.get('ordem') ?? 'potencial',
    incluirBaixaConfianca:
      searchParams.get('incluirBaixaConfianca') === '1' ||
      searchParams.get('incluirBaixaConfianca') === 'true',
  };

  // ── MODO COMPUTE (worker) ────────────────────────────────────────────────────
  const compute = avaliarCompute(req);
  if (compute.modo === 'negado') {
    return NextResponse.json(
      { erro: compute.erro },
      { status: compute.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (compute.modo === 'compute') {
    try {
      const payload = await computar(exercicio, compute.idToken, filtros);
      // Payload PURO (o worker calcula hash/nDocs e persiste). Já capado em 300.
      return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
    } catch (err) {
      return NextResponse.json(
        { erro: err instanceof Error ? err.message : 'erro ao computar alertas' },
        { status: 502, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  // ── MODO LEITURA (usuário) ───────────────────────────────────────────────────
  const sessao = await sessaoLeitura(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const idToken = sessao.idToken;

  // Snapshot-first: se há um snapshot pronto (materializado pelo worker) e os
  // filtros são os DEFAULT (o snapshot é do recorte completo, sem filtro), serve
  // o snapshot — instantâneo. Com filtros específicos, vai pela leitura capada
  // (que já é memory-safe em LIMITE_PAINEL — nunca o payload de 33 MB).
  const semFiltro =
    !filtros.statusFiltro && !filtros.classeFiltro && filtros.ordem === 'potencial';
  if (semFiltro) {
    try {
      const snap = await lerSnapshotPainel('alertas', '', exercicio, idToken, sessao.uid ?? undefined);
      if (snap) {
        return NextResponse.json(snap.payload, {
          headers: { 'Cache-Control': 'private, max-age=120' },
        });
      }
    } catch {
      /* falha ao ler snapshot — cai no fallback de leitura capada abaixo */
    }
  }

  // Fallback: leitura ao vivo JÁ CAPADA em LIMITE_PAINEL (memory-safe). Mantém a
  // página funcional quando ainda não há snapshot e respeita os filtros.
  try {
    const resposta = await computar(exercicio, idToken, filtros);
    return NextResponse.json(resposta, {
      headers: { 'Cache-Control': 'private, max-age=300' },
    });
  } catch (err) {
    return NextResponse.json(
      { erro: err instanceof Error ? err.message : 'erro ao ler nexo_alertas' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
