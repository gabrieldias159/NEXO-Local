/**
 * GET /api/nexo/receita?exercicio=2026
 *
 * Lê a receita por conta/mês já ingerida pelo cron na coleção `nexo_receita`
 * do Firestore (módulo `balancetereceita` / visão `Arrecadacoes` do SMARAPD),
 * roda os detectores da categoria RC (RC-01, RC-02, RC-05) e devolve resumo +
 * alertas.
 *
 * Origem dos dados: `nexo_receita` (persistido pelo cron). Se a coleção ainda
 * estiver vazia para o exercício (cron não rodou), cai no caminho AO VIVO via
 * `coletarReceita` como fallback — o campo `ingestao.origem` informa qual.
 *
 * O módulo `balancetereceita` foi disponibilizado pelo portal em 2026 —
 * exercícios anteriores retornam vazios. A rota trata isso como "sem dados
 * publicados", não como falha de coleta; só devolve 502 quando a coleta
 * efetivamente erra (`coleta.erro` preenchido).
 */
import { NextResponse } from 'next/server';
import {
  coletarReceita,
  normalizarReceitas,
  somaArrecadado,
  somaPrevisto,
  CAMPOS_RECEITA,
  type ReceitaNorm,
} from '@/lib/nexo/sources/receita';
import { analisarReceita } from '@/lib/nexo/detectores/receita-det';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import type { AlertaDetectado } from '@/lib/nexo/detectores';

export const runtime = 'nodejs';
export const revalidate = 1800;
export const maxDuration = 120;

const MAX_PAGINAS = 40;

export interface ReceitaResponse {
  exercicio: number;
  coleta: {
    registros: number;
    totalBrutos: number;
    erro: string | null;
  };
  resumo: {
    totalRubricas: number;
    totalPrevisto: number;
    totalArrecadado: number;
    /** Arrecadado / previsto, em % — null quando não há previsão. */
    realizacaoPct: number | null;
    alertas: number;
  };
  /** Maiores rubricas por valor arrecadado (para a tabela da página). */
  rubricas: ReceitaNorm[];
  alertas: AlertaDetectado[];
  /** Origem efetiva dos dados: Firestore (ingestão) ou coleta ao vivo (fallback). */
  ingestao: { origem: 'firestore' | 'ao-vivo-fallback'; coletadoEm: string | null };
  atualizadoEm: string;
}

/** Extrai o `_coletadoEm` mais recente de um conjunto de docs `nexo_*`. */
function maisRecenteColeta(docs: Record<string, unknown>[]): string | null {
  let recente: string | null = null;
  for (const d of docs) {
    const c = d._coletadoEm;
    if (typeof c === 'string' && (recente === null || c > recente)) recente = c;
  }
  return recente;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const idToken = sessao.idToken;

  const { searchParams } = new URL(req.url);
  const exercicio = Number(searchParams.get('exercicio')) || new Date().getFullYear();

  let receitas: ReceitaNorm[] = [];
  let totalBrutos = 0;
  let erro: string | null = null;
  let origem: 'firestore' | 'ao-vivo-fallback' = 'firestore';
  let coletadoEm: string | null = null;

  // 1. Origem primária: a coleção `nexo_receita` ingerida pelo cron. O cron
  // persiste o registro bruto de `balancetereceita` — `normalizarReceitas`
  // recebe a MESMA estrutura que receberia da API e o explode em ReceitaNorm.
  try {
    const docs = await lerColecaoNexo(
      'nexo_receita',
      { exercicio, fonte: 'receita' },
      idToken,
      CAMPOS_RECEITA,
    );
    if (docs.length > 0) {
      receitas = normalizarReceitas(docs, exercicio);
      totalBrutos = docs.length;
      coletadoEm = maisRecenteColeta(docs);
    }
  } catch (err) {
    erro = err instanceof Error ? err.message : 'erro desconhecido';
  }

  // 2. Fallback ao vivo: a coleção ainda não foi ingerida para este exercício.
  if (receitas.length === 0) {
    origem = 'ao-vivo-fallback';
    const coleta = await coletarReceita(exercicio, {
      maxPaginas: MAX_PAGINAS,
      delayMs: 120,
    });
    receitas = coleta.registros;
    totalBrutos = coleta.totalBrutos;
    erro = coleta.erro;
  }

  const alertas = analisarReceita(receitas);

  // Agrega por conta para a tabela — soma os meses de cada rubrica.
  const porConta = new Map<string, ReceitaNorm>();
  for (const r of receitas) {
    const chave = r.conta || r.descricao;
    if (!chave) continue;
    const cur = porConta.get(chave);
    if (!cur) {
      porConta.set(chave, { ...r, mes: 0 });
    } else {
      cur.previsto += r.previsto;
      cur.arrecadado += r.arrecadado;
      if (!cur.descricao && r.descricao) cur.descricao = r.descricao;
    }
  }
  const rubricasAgregadas = [...porConta.values()].sort(
    (a, b) => b.arrecadado - a.arrecadado,
  );

  const totalPrevisto = somaPrevisto(rubricasAgregadas);
  const totalArrecadado = somaArrecadado(rubricasAgregadas);

  const response: ReceitaResponse = {
    exercicio,
    coleta: {
      registros: receitas.length,
      totalBrutos,
      erro,
    },
    resumo: {
      totalRubricas: rubricasAgregadas.length,
      totalPrevisto,
      totalArrecadado,
      realizacaoPct:
        totalPrevisto > 0
          ? Number(((totalArrecadado / totalPrevisto) * 100).toFixed(1))
          : null,
      alertas: alertas.length,
    },
    rubricas: rubricasAgregadas.slice(0, 200),
    alertas,
    ingestao: { origem, coletadoEm },
    atualizadoEm: new Date().toISOString(),
  };

  // Falha total de coleta — não mascarar como "nenhuma receita".
  if (receitas.length === 0 && erro) {
    return NextResponse.json(response, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return NextResponse.json(response, {
    headers: { 'Cache-Control': 'private, max-age=900' },
  });
}
