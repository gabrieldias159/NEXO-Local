/**
 * GET /api/nexo/status
 *
 * Reporta a saúde da INGESTÃO do NEXO. Em vez de sondar o SMARAPD ao vivo, lê
 * os documentos de `nexo_sync_state` gravados pelo cron de coleta
 * (`functions/src/nexo/coleta.ts`) — cada doc registra, por fonte/exercício:
 * última coleta, nº de registros, hash, se mudou, se a coleta foi parcial e o
 * erro (quando houver).
 *
 * O estado da fonte SMARAPD (`fontes.smarapd`) é DERIVADO de `nexo_sync_state`:
 * a fonte é considerada "conectada" quando há ao menos uma ingestão SMARAPD
 * recente e sem erro. SICONFI e PNCP NÃO são cobertos pelo cron de ingestão
 * (ele só coleta módulos SMARAPD) — para essas duas a sondagem ao vivo
 * permanece, pois não há `nexo_sync_state` a consultar.
 *
 * O campo `ingestao` traz o detalhamento por fonte/exercício direto do
 * `nexo_sync_state` (última coleta, registros, erro, parcial) — é a saúde da
 * ingestão propriamente dita, usada pelo Painel de Coleta.
 */
import { NextResponse } from 'next/server';
import { probeSiconfi } from '@/lib/nexo/sources/siconfi';
import { probePncp } from '@/lib/nexo/sources/pncp';
import type { SmarapdStatus } from '@/lib/nexo/sources/smarapd';
import { MARILIA } from '@/lib/nexo/constants';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';

export const runtime = 'nodejs';
// Cache curto: o estado da ingestão muda no máximo uma vez por dia (cron 04h15)
// — o cache evita amplificar leituras do Firestore a cada acesso da página.
export const revalidate = 300;

/** Saúde da ingestão de uma fonte num exercício (derivada de `nexo_sync_state`). */
export interface FonteSyncStatus {
  fonte: string;
  exercicio: number;
  colecao: string | null;
  registros: number;
  /** true se a última coleta foi parcial (alguma página falhou). */
  parcial: boolean;
  /** true se o último snapshot mudou em relação ao anterior. */
  mudou: boolean;
  /** Mensagem de erro da última coleta, ou null se íntegra. */
  erro: string | null;
  /** Timestamp ISO da última coleta da fonte, ou null. */
  coletadoEm: string | null;
}

export interface NexoStatusResponse {
  verificadoEm: string;
  exercicioReferencia: number;
  fontes: {
    /** Saúde do SMARAPD — DERIVADA de `nexo_sync_state` (não mais probe ao vivo). */
    smarapd: SmarapdStatus;
    siconfi: Awaited<ReturnType<typeof probeSiconfi>>;
    pncp: Awaited<ReturnType<typeof probePncp>>;
  };
  /** Saúde detalhada da ingestão (cron) por fonte/exercício, de `nexo_sync_state`. */
  ingestao: {
    /** Total de pares fonte/exercício registrados em `nexo_sync_state`. */
    fontes: number;
    comErro: number;
    parciais: number;
    /** Total de registros somados de todas as fontes. */
    registros: number;
    /** Coleta mais recente entre todas as fontes (ISO), ou null. */
    ultimaColeta: string | null;
    detalhe: FonteSyncStatus[];
  };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Janela em que uma ingestão ainda é considerada "fresca" — 36h cobre uma falha de 1 dia do cron. */
const FRESCOR_MS = 36 * 60 * 60 * 1000;

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const idToken = sessao.idToken;

  const exercicioAtual = new Date().getFullYear();

  // Lê o estado da ingestão (cron) e sonda SICONFI/PNCP em paralelo — essas
  // duas fontes não são cobertas pelo cron, então a sondagem ao vivo continua.
  const [syncDocs, siconfi, pncp] = await Promise.all([
    lerColecaoNexo('nexo_sync_state', {}, idToken),
    probeSiconfi(exercicioAtual),
    probePncp(MARILIA.cnpjPrefeitura, exercicioAtual),
  ]);

  const detalhe: FonteSyncStatus[] = syncDocs
    .map((d) => ({
      fonte: asString(d.fonte) ?? '',
      exercicio: asNumber(d.exercicio),
      colecao: asString(d.colecao),
      registros: asNumber(d.registros),
      parcial: d.parcial === true,
      mudou: d.mudou === true,
      erro: asString(d.erro),
      coletadoEm: asString(d.coletadoEm),
    }))
    .sort((a, b) => b.exercicio - a.exercicio || a.fonte.localeCompare(b.fonte));

  const ultimaColeta = detalhe.reduce<string | null>((acc, f) => {
    if (f.coletadoEm && (acc === null || f.coletadoEm > acc)) return f.coletadoEm;
    return acc;
  }, null);

  // Saúde do SMARAPD DERIVADA da ingestão: a fonte está "conectada" quando há
  // ao menos uma ingestão SMARAPD sem erro e recente (o cron coleta só SMARAPD,
  // então qualquer doc de `nexo_sync_state` é uma fonte SMARAPD).
  const ingestoesOk = detalhe.filter((f) => f.erro === null && !f.parcial);
  const recente =
    ultimaColeta !== null &&
    Date.now() - new Date(ultimaColeta).getTime() < FRESCOR_MS;
  const erroSmarapd =
    detalhe.length === 0
      ? 'ingestão ainda não executada — nenhum registro em nexo_sync_state'
      : !recente
        ? `última coleta há mais de 36h (${ultimaColeta})`
        : detalhe.every((f) => f.erro !== null)
          ? (detalhe.find((f) => f.erro)?.erro ?? 'todas as ingestões com erro')
          : null;
  const smarapd: SmarapdStatus = {
    conectado: detalhe.length > 0 && recente && ingestoesOk.length > 0,
    status: detalhe.length > 0 ? 200 : null,
    modulos: new Set(detalhe.map((f) => f.fonte).filter(Boolean)).size || null,
    erro: erroSmarapd,
    verificadoEm: new Date().toISOString(),
  };

  const response: NexoStatusResponse = {
    verificadoEm: new Date().toISOString(),
    exercicioReferencia: exercicioAtual,
    fontes: { smarapd, siconfi, pncp },
    ingestao: {
      fontes: detalhe.length,
      comErro: detalhe.filter((f) => f.erro !== null).length,
      parciais: detalhe.filter((f) => f.parcial).length,
      registros: detalhe.reduce((s, f) => s + f.registros, 0),
      ultimaColeta,
      detalhe,
    },
  };

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'private, max-age=120',
    },
  });
}
