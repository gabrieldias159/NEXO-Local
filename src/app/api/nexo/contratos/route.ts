/**
 * GET /api/nexo/contratos?exercicio=2026[&cnpj=...]
 *
 * Coleta os contratos da Prefeitura de Marília no PNCP (Portal Nacional de
 * Contratações Públicas) e roda o detector de aditivos acima do limite legal.
 *
 * O `cnpjOrgao` vem de MARILIA.cnpjPrefeitura e pode ser sobrescrito via
 * `?cnpj=`. Sem CNPJ válido configurado, a rota responde estado honesto
 * (`cnpjAusente: true`) — não consulta o PNCP nem inventa contratos. O PNCP
 * bloqueia IPs fora do Brasil — em produção a rota roda em região brasileira.
 */
import { NextResponse } from 'next/server';
import { getContratosAllPages } from '@/lib/nexo/sources/pncp';
import {
  normalizarContratosPNCP,
  soDigitos,
  type ContratoNorm,
} from '@/lib/nexo/normalizar';
import { analisarContratos } from '@/lib/nexo/detectores/contratos';
import { MARILIA } from '@/lib/nexo/constants';
import type { AlertaDetectado } from '@/lib/nexo/detectores';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';

export const runtime = 'nodejs';
export const revalidate = 1800;
export const maxDuration = 120;

const MAX_PAGINAS = 20;

export interface ContratosResponse {
  exercicio: number;
  cnpjOrgao: string;
  coleta: {
    registros: number;
    totalPaginas: number;
    amostra: boolean;
    erro: string | null;
    /** true quando o CNPJ da Prefeitura não está configurado/é inválido. */
    cnpjAusente: boolean;
    /** Origem dos dados: `materializado` (Firestore, coletado pelo cron) ou
     *  `pncp-live` (consulta ao vivo — fallback quando o ano não foi coletado). */
    fonte?: 'materializado' | 'pncp-live';
  };
  resumo: {
    totalContratos: number;
    valorTotal: number;
    alertas: number;
  };
  contratos: ContratoNorm[];
  alertas: AlertaDetectado[];
  atualizadoEm: string;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok) {
    return NextResponse.json({ erro: 'acesso negado ao NEXO' }, { status: sessao.status });
  }

  const { searchParams } = new URL(req.url);
  const exercicio = Number(searchParams.get('exercicio')) || new Date().getFullYear();
  const cnpjOrgao = soDigitos(searchParams.get('cnpj') || MARILIA.cnpjPrefeitura);

  // Degradação honesta: sem CNPJ válido não há o que consultar no PNCP.
  if (cnpjOrgao.length !== 14) {
    const vazio: ContratosResponse = {
      exercicio,
      cnpjOrgao,
      coleta: {
        registros: 0,
        totalPaginas: 0,
        amostra: false,
        erro: null,
        cnpjAusente: true,
      },
      resumo: { totalContratos: 0, valorTotal: 0, alertas: 0 },
      contratos: [],
      alertas: [],
      atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(vazio, { headers: { 'Cache-Control': 'no-store' } });
  }

  let brutos: Record<string, unknown>[] = [];
  let totalPaginas = 1;
  let erro: string | null = null;
  let fonte: 'materializado' | 'pncp-live' = 'materializado';

  // SNAPSHOT-FIRST: lê os contratos já coletados pelo cron onNexoSyncPncp em
  // `nexo_contratos` (docs = registro PNCP cru + metadados). O PNCP geo-bloqueia
  // IP fora do Brasil e o App Hosting roda em us-central1: consultar AO VIVO no
  // request (mesmo via proxy BR) frequentemente estoura o timeout. Servir o
  // materializado elimina a dependência do PNCP no carregamento da página.
  try {
    const docs = await lerColecaoNexo(
      'nexo_contratos',
      { exercicio, fonte: 'pncp' },
      sessao.idToken!,
    );
    // filtra ao órgão pedido (o cron coleta a Prefeitura; garante coerência)
    brutos = docs.filter((d) => {
      const c = soDigitos((d._cnpjOrgao ?? d.orgaoEntidade ?? d.cnpjOrgao ?? '') as string);
      return !c || c === cnpjOrgao || cnpjOrgao === MARILIA.cnpjPrefeitura;
    });
  } catch {
    brutos = [];
  }

  // Fallback AO VIVO (via proxy BR) só se o materializado ainda não tem o ano.
  if (brutos.length === 0) {
    fonte = 'pncp-live';
    try {
      const r = await getContratosAllPages(
        {
          cnpjOrgao,
          dataInicial: `${exercicio}0101`,
          dataFinal: `${exercicio}1231`,
        },
        { maxPaginas: MAX_PAGINAS, delayMs: 150 },
      );
      brutos = r.contratos;
      totalPaginas = r.totalPaginas;
    } catch (err) {
      erro = err instanceof Error ? err.message : 'erro desconhecido';
    }
  }

  const contratos = normalizarContratosPNCP(brutos).sort(
    (a, b) => b.valorGlobal - a.valorGlobal,
  );
  const alertas = analisarContratos(contratos);
  const valorTotal = contratos.reduce((s, c) => s + c.valorGlobal, 0);

  const response: ContratosResponse = {
    exercicio,
    cnpjOrgao,
    coleta: {
      registros: contratos.length,
      totalPaginas,
      amostra: totalPaginas > MAX_PAGINAS,
      erro,
      cnpjAusente: false,
      fonte,
    },
    resumo: {
      totalContratos: contratos.length,
      valorTotal,
      alertas: alertas.length,
    },
    contratos: contratos.slice(0, 200),
    alertas,
    atualizadoEm: new Date().toISOString(),
  };

  // Falha total de coleta — não mascarar como "nenhum contrato".
  if (brutos.length === 0 && erro) {
    return NextResponse.json(response, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'private, max-age=900',
    },
  });
}
