/**
 * GET /api/nexo/diario-busca?termo=dispensa&de=2026-01-01&ate=2026-12-31&pagina=1
 *
 * Busca full-text no Diário Oficial do Município via Querido Diário. Cada
 * ocorrência traz a data, a edição, o link do PDF oficial (a prova) e trechos.
 * Rastreio de documentos públicos por palavra-chave (dispensa, emergencial,
 * inexigibilidade, aditivo…). Rota protegida (sessão NEXO).
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { buscarDiario } from '@/lib/nexo/sources/querido-diario';

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
  const termo = (searchParams.get('termo') ?? '').trim();
  const de = searchParams.get('de') ?? undefined;
  const ate = searchParams.get('ate') ?? undefined;
  const pagina = Number(searchParams.get('pagina')) || 1;

  try {
    const { total, ocorrencias } = await buscarDiario({
      termo: termo || undefined,
      de,
      ate,
      pagina,
      tamanho: 20,
    });
    return NextResponse.json(
      { termo, total, pagina, ocorrencias },
      { headers: { 'Cache-Control': 'private, max-age=300' } },
    );
  } catch (err) {
    return NextResponse.json(
      { erro: err instanceof Error ? err.message : 'erro ao buscar no Diário' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
