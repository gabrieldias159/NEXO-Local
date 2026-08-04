/**
 * GET /api/nexo/contratos-municipais?exercicio=2026
 *
 * Contratos publicados na API de Dados Abertos da Prefeitura (com NOME da
 * contratada e nº de processo). Segunda fonte de contratações, cruzável com
 * PNCP/TCE/DespesaAgrupada por `numeroProcesso`. Rota protegida (sessão NEXO).
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { getContratos } from '@/lib/nexo/sources/dados-abertos';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { searchParams } = new URL(req.url);
  const exercicio = Number(searchParams.get('exercicio')) || new Date().getFullYear();

  try {
    const contratos = await getContratos(exercicio);
    // Ranking por valor desc (sem entes públicos — a fonte é a contratada).
    contratos.sort((a, b) => b.valor - a.valor);
    return NextResponse.json(
      { exercicio, total: contratos.length, contratos },
      { headers: { 'Cache-Control': 'private, max-age=600' } },
    );
  } catch (err) {
    return NextResponse.json(
      { erro: err instanceof Error ? err.message : 'erro ao buscar contratos municipais' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
