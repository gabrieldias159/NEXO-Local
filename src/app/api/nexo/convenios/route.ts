/**
 * GET /api/nexo/convenios?exercicio=2026
 *
 * Subsistema CONVÊNIOS E TERCEIRO SETOR do NEXO. Lê o que o cron de ingestão
 * persistiu no Firestore:
 *  - subvenções/repasses a OSC/OSS — coleção `nexo_subvencoes` (fonte 'subvencoes');
 *  - emendas parlamentares — coleção `nexo_emendas` (fonte 'emendas').
 *
 * Roda os detectores TS-01, TS-03, TS-06 e TS-07 e devolve os indícios.
 * Apenas dados públicos — todo alerta é indício a apurar, não acusação.
 *
 * Origem dos dados: `nexo_subvencoes` + `nexo_emendas`. Se AMBAS as coleções
 * estiverem vazias para o exercício (cron não rodou), cai no caminho AO VIVO
 * via `coletarTerceiroSetor` como fallback — o campo `ingestao.origem` informa.
 */
import { NextResponse } from 'next/server';
import {
  coletarTerceiroSetor,
  normalizarSubvencoes,
  normalizarEmendas,
} from '@/lib/nexo/sources/terceiro-setor';
import type { SubvencaoNorm, EmendaNorm } from '@/lib/nexo/sources/terceiro-setor';
import { analisarTerceiroSetor } from '@/lib/nexo/detectores/terceiro-setor-det';
import type { AlertaDetectado } from '@/lib/nexo/detectores/tipos';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';

export const runtime = 'nodejs';
export const revalidate = 1800;
export const maxDuration = 120;

const MAX_PAGINAS = 25;

export interface ConveniosResponse {
  exercicio: number;
  coleta: {
    subvencoesRegistros: number;
    emendasRegistros: number;
    erroSubvencoes: string | null;
    erroEmendas: string | null;
  };
  resumo: {
    totalSubvencoes: number;
    valorSubvencoes: number;
    totalEmendas: number;
    valorEmendasPrevisto: number;
    valorEmendasEmpenhado: number;
    alertas: number;
  };
  alertas: AlertaDetectado[];
  subvencoes: SubvencaoNorm[];
  emendas: EmendaNorm[];
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
  const exercicio =
    Number(searchParams.get('exercicio')) || new Date().getFullYear();

  let subvencoes: SubvencaoNorm[] = [];
  let emendas: EmendaNorm[] = [];
  let erroSubvencoes: string | null = null;
  let erroEmendas: string | null = null;
  let origem: 'firestore' | 'ao-vivo-fallback' = 'firestore';
  let coletadoEm: string | null = null;

  // 1. Origem primária: as coleções `nexo_subvencoes` e `nexo_emendas`
  // ingeridas pelo cron. Cada doc é o registro bruto da fonte — os
  // normalizadores recebem a mesma estrutura que receberiam da API.
  let docsSubv: Record<string, unknown>[] = [];
  let docsEmendas: Record<string, unknown>[] = [];
  try {
    docsSubv = await lerColecaoNexo(
      'nexo_subvencoes',
      { exercicio, fonte: 'subvencoes' },
      idToken,
    );
  } catch (err) {
    erroSubvencoes = err instanceof Error ? err.message : 'erro desconhecido';
  }
  try {
    docsEmendas = await lerColecaoNexo(
      'nexo_emendas',
      { exercicio, fonte: 'emendas' },
      idToken,
    );
  } catch (err) {
    erroEmendas = err instanceof Error ? err.message : 'erro desconhecido';
  }

  if (docsSubv.length > 0) subvencoes = normalizarSubvencoes(docsSubv, exercicio);
  if (docsEmendas.length > 0) emendas = normalizarEmendas(docsEmendas, exercicio);

  if (docsSubv.length > 0 || docsEmendas.length > 0) {
    coletadoEm = maisRecenteColeta([...docsSubv, ...docsEmendas]);
  }

  // 2. Fallback ao vivo: AMBAS as coleções vazias para o exercício — o cron
  // ainda não ingeriu. Coleta direto do SMARAPD.
  if (subvencoes.length === 0 && emendas.length === 0) {
    origem = 'ao-vivo-fallback';
    const coletaVivo = await coletarTerceiroSetor(exercicio, {
      maxPaginas: MAX_PAGINAS,
      delayMs: 100,
    });
    subvencoes = coletaVivo.subvencoes;
    emendas = coletaVivo.emendas;
    erroSubvencoes = coletaVivo.coleta.erroSubvencoes;
    erroEmendas = coletaVivo.coleta.erroEmendas;
  }

  subvencoes.sort((a, b) => b.valor - a.valor);
  emendas.sort((a, b) => b.valorPrevisto - a.valorPrevisto);

  const alertas = analisarTerceiroSetor({ subvencoes, emendas });

  const valorSubvencoes = subvencoes.reduce((s, x) => s + x.valor, 0);
  const valorEmendasPrevisto = emendas.reduce((s, x) => s + x.valorPrevisto, 0);
  const valorEmendasEmpenhado = emendas.reduce((s, x) => s + x.valorEmpenhado, 0);

  const response: ConveniosResponse = {
    exercicio,
    coleta: {
      subvencoesRegistros: subvencoes.length,
      emendasRegistros: emendas.length,
      erroSubvencoes,
      erroEmendas,
    },
    resumo: {
      totalSubvencoes: subvencoes.length,
      valorSubvencoes,
      totalEmendas: emendas.length,
      valorEmendasPrevisto,
      valorEmendasEmpenhado,
      alertas: alertas.length,
    },
    alertas,
    subvencoes: subvencoes.slice(0, 200),
    emendas: emendas.slice(0, 200),
    ingestao: { origem, coletadoEm },
    atualizadoEm: new Date().toISOString(),
  };

  // Falha total de coleta nos dois módulos — não mascarar como "nada encontrado".
  const falhaTotal =
    subvencoes.length === 0 &&
    emendas.length === 0 &&
    (erroSubvencoes !== null || erroEmendas !== null);

  if (falhaTotal) {
    return NextResponse.json(response, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return NextResponse.json(response, {
    headers: { 'Cache-Control': 'private, max-age=900' },
  });
}
