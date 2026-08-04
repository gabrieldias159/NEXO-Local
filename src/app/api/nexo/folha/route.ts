/**
 * GET /api/nexo/folha?exercicio=2026
 *
 * Lê a folha de pagamento já ingerida pelo cron na coleção `nexo_pagamentos`
 * do Firestore (módulo `pagamentos` do SMARAPD), deduplica por matrícula
 * mantendo o mês mais recente, roda os detectores de folha e devolve o resumo.
 * Nomes são mascarados na resposta (LGPD).
 *
 * Origem dos dados: `nexo_pagamentos` (persistido pelo cron de ingestão). Se a
 * coleção ainda estiver vazia para o exercício (cron não rodou), cai no caminho
 * AO VIVO via SMARAPD como fallback — o campo `ingestao.origem` informa qual.
 */
import { NextResponse } from 'next/server';
import { filterModuloAllPages } from '@/lib/nexo/sources/smarapd';
import { normalizarFolha, mascararNome, type ServidorNorm } from '@/lib/nexo/normalizar';
import { analisarFolha } from '@/lib/nexo/detectores/folha';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import type { AlertaDetectado } from '@/lib/nexo/detectores';

export const runtime = 'nodejs';
// `revalidate` é INERTE aqui (P2-15): `verificarSessao` lê o header Authorization
// → handler dinâmico, então o ISR nunca cacheia. O que vale é o `Cache-Control`
// por resposta (abaixo). Removido para não enganar.
export const maxDuration = 120;

/**
 * Campos projetados de `nexo_pagamentos` (`select` do `:runQuery`) — só os que
 * `normalizarFolha` consome. A folha anual tem ~23 mil docs × dezenas de campos;
 * projetar os ~15 usados corta o payload/parse em ordem de grandeza, sem
 * truncar a coleção (a folha é análise do exercício INTEIRO — `limit` viraria
 * amostra e mentiria nos agregados, então NÃO se aplica limit aqui).
 */
const CAMPOS_FOLHA = [
  'Matricula', 'NumeroMatricula', 'NomeServidor', 'Nome', 'NomeFornecedor',
  'CargoFuncao', 'Cargo', 'Funcao', 'Lotacao', 'Secretaria', 'Mes',
  'DataAdmissao', 'TotalVencimentos', 'Vencimentos', 'TotalDescontos',
  'Descontos', 'SalarioLiquido', 'TotalLiquido', 'Liquido', '_coletadoEm',
];

export interface ServidorPublico {
  matricula: string;
  nome: string;
  cargo: string;
  lotacao: string;
  vencimentos: number;
  liquido: number;
}

export interface FolhaResponse {
  exercicio: number;
  coleta: { registros: number; servidores: number; erro: string | null };
  resumo: { totalServidores: number; folhaBruta: number; alertas: number };
  topRemuneracoes: ServidorPublico[];
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

  let registros: ServidorNorm[] = [];
  let erro: string | null = null;
  let origem: 'firestore' | 'ao-vivo-fallback' = 'firestore';
  let coletadoEm: string | null = null;

  // 1. Origem primária: a coleção `nexo_pagamentos` ingerida pelo cron.
  try {
    const docs = await lerColecaoNexo(
      'nexo_pagamentos',
      { exercicio, fonte: 'pagamentos' },
      idToken,
      CAMPOS_FOLHA,
    );
    if (docs.length > 0) {
      registros = normalizarFolha(docs);
      coletadoEm = maisRecenteColeta(docs);
    }
  } catch (err) {
    erro = err instanceof Error ? err.message : 'erro desconhecido';
  }

  // 2. Fallback ao vivo: a coleção ainda não foi ingerida para este exercício.
  if (registros.length === 0) {
    origem = 'ao-vivo-fallback';
    try {
      const brutos = await filterModuloAllPages(
        {
          chaveModulo: 'pagamentos',
          nomeVisao: 'pagamentoaservidores',
          exercicio,
          periodicidade: 'ANUAL',
          quantidadeRegistros: 500,
        },
        // A folha anual tem ~23 mil registros (doc da API SMARAPD: 23.327/ano).
        // 60 páginas × 500 cobrem o exercício inteiro sem truncar a coleta.
        { maxPaginas: 60, delayMs: 100 },
      );
      registros = normalizarFolha(brutos);
      erro = null;
    } catch (err) {
      erro = err instanceof Error ? err.message : 'erro desconhecido';
    }
  }

  // Deduplica por matrícula, mantendo o mês mais recente.
  // Deduplica por matrícula. Registros sem matrícula são descartados — usar o
  // nome como chave colapsaria pessoas distintas homônimas.
  const porMatricula = new Map<string, ServidorNorm>();
  for (const s of registros) {
    if (!s.matricula) continue;
    const ex = porMatricula.get(s.matricula);
    if (!ex || s.mes > ex.mes) porMatricula.set(s.matricula, s);
  }
  const atuais = [...porMatricula.values()];

  const alertas = analisarFolha(atuais);
  const folhaBruta = atuais.reduce((s, x) => s + x.vencimentos, 0);

  const topRemuneracoes: ServidorPublico[] = atuais
    .slice()
    .sort((a, b) => b.vencimentos - a.vencimentos)
    .slice(0, 30)
    .map((s) => ({
      matricula: s.matricula,
      nome: mascararNome(s.nome),
      cargo: s.cargo,
      lotacao: s.lotacao,
      vencimentos: s.vencimentos,
      liquido: s.liquido,
    }));

  const response: FolhaResponse = {
    exercicio,
    coleta: { registros: registros.length, servidores: atuais.length, erro },
    resumo: { totalServidores: atuais.length, folhaBruta, alertas: alertas.length },
    topRemuneracoes,
    alertas,
    ingestao: { origem, coletadoEm },
    atualizadoEm: new Date().toISOString(),
  };

  if (registros.length === 0 && erro) {
    return NextResponse.json(response, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return NextResponse.json(response, {
    headers: { 'Cache-Control': 'private, max-age=900' },
  });
}
