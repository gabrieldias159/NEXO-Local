/**
 * GET /api/nexo/contratos-pncp?exercicio=2026[&cnpj=...]
 *
 * Subsistema CONTRATOS (PNCP) do NEXO. Coleta os contratos da Prefeitura de
 * Marília no Portal Nacional de Contratações Públicas (PNCP) e roda os
 * detectores LC-19 (aditivo acima do limite) e LC-20 (aditivo de prazo
 * desproporcional).
 *
 * O `cnpjOrgao` vem de MARILIA.cnpjPrefeitura e pode ser sobrescrito via
 * `?cnpj=`. Sem CNPJ configurado, a rota responde estado honesto — não falha.
 *
 * ⚠ O PNCP bloqueia IPs fora do Brasil (HTTP 403): em ambiente de dev o fetch
 * ao vivo falha. Nesse caso a rota responde 502 com `Cache-Control: no-store`
 * — a falha de upstream NUNCA é mascarada como "nenhum contrato".
 *
 * Apenas dados públicos — todo alerta é indício a apurar, não acusação.
 */
import { NextResponse } from 'next/server';
import { coletarContratosPNCP } from '@/lib/nexo/sources/pncp';
import type { ContratoPNCP } from '@/lib/nexo/sources/pncp';
import { analisarContratosPNCP } from '@/lib/nexo/detectores/contratos-pncp-det';
import type { AlertaDetectado } from '@/lib/nexo/detectores/tipos';
import { verificarSessao } from '@/lib/nexo/auth-server';

export const runtime = 'nodejs';
export const revalidate = 1800;
export const maxDuration = 120;

const MAX_PAGINAS = 20;

export interface ContratosPNCPResponse {
  exercicio: number;
  /** CNPJ do órgão consultado (vazio se não configurado). */
  cnpjOrgao: string;
  coleta: {
    registros: number;
    totalPaginas: number;
    /** Erro honesto do upstream PNCP, ou null. */
    erro: string | null;
    /** true quando o CNPJ da Prefeitura não está configurado. */
    cnpjAusente: boolean;
  };
  resumo: {
    totalContratos: number;
    valorInicialTotal: number;
    valorGlobalTotal: number;
    totalAditivos: number;
    alertas: number;
  };
  alertas: AlertaDetectado[];
  contratos: ContratoPNCP[];
  atualizadoEm: string;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { searchParams } = new URL(req.url);
  const exercicio =
    Number(searchParams.get('exercicio')) || new Date().getFullYear();
  const cnpjOverride = searchParams.get('cnpj')?.replace(/\D/g, '') || undefined;

  const { contratos, cnpjOrgao, coleta } = await coletarContratosPNCP(
    exercicio,
    { cnpjOrgao: cnpjOverride, maxPaginas: MAX_PAGINAS, delayMs: 150 },
  );

  contratos.sort((a, b) => b.valorGlobal - a.valorGlobal);

  const alertas = analisarContratosPNCP(contratos);

  const valorInicialTotal = contratos.reduce((s, c) => s + c.valorInicial, 0);
  const valorGlobalTotal = contratos.reduce((s, c) => s + c.valorGlobal, 0);
  const totalAditivos = contratos.reduce((s, c) => s + c.aditivos.length, 0);

  const response: ContratosPNCPResponse = {
    exercicio,
    cnpjOrgao,
    coleta,
    resumo: {
      totalContratos: contratos.length,
      valorInicialTotal,
      valorGlobalTotal,
      totalAditivos,
      alertas: alertas.length,
    },
    alertas,
    contratos: contratos.slice(0, 200),
    atualizadoEm: new Date().toISOString(),
  };

  // Falha de upstream — não mascarar como "nenhum contrato". O caso de CNPJ
  // ausente NÃO é falha de upstream: é estado de configuração, responde 200.
  if (coleta.erro !== null) {
    return NextResponse.json(response, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return NextResponse.json(response, {
    headers: { 'Cache-Control': 'private, max-age=900' },
  });
}
