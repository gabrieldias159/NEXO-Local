/**
 * GET /api/nexo/dossie?compute=1&exercicio=<n>&alvo=<id> — endpoint de COMPUTE
 * do dossiê para o WORKER (Frente E/F).
 *
 * O worker (`functions/src/nexo/jobs-worker.ts`) monta a URL como
 * `${APP}/api/nexo/<tipo>?...&alvo=<id>` — para `tipo='dossie'` isso bate AQUI
 * (sem segmento de path `[id]`), com o `id` do dossiê na querystring `alvo`.
 * Esta rota só atende o modo COMPUTE: computa o dossiê (reusando `computarDossie`
 * de `[id]/route.ts`, sem duplicar a lógica de montagem) e devolve o payload
 * puro, que o worker persiste em `nexo_snapshots`.
 *
 * Para USUÁRIO (leitura snapshot-first por path), use `/api/nexo/dossie/{id}`.
 */
import { NextResponse } from 'next/server';
import { avaliarCompute } from '@/lib/nexo/compute-guard';
import { computarDossie } from './[id]/route';

export const runtime = 'nodejs';

const headersNoStore = { 'Cache-Control': 'no-store' } as const;

export async function GET(req: Request) {
  const compute = avaliarCompute(req);
  if (compute.modo === 'negado') {
    return NextResponse.json(
      { erro: compute.erro },
      { status: compute.status, headers: headersNoStore },
    );
  }
  if (compute.modo !== 'compute') {
    // Leitura de usuário sem id de dossiê — orienta ao caminho correto (por path).
    return NextResponse.json(
      {
        erro:
          'Informe o id do dossiê no caminho: /api/nexo/dossie/{id} ' +
          '(CNPJ, hash de documento ou id de entidade).',
      },
      { status: 400, headers: headersNoStore },
    );
  }

  const { searchParams } = new URL(req.url);
  const alvo = decodeURIComponent((searchParams.get('alvo') ?? '').trim());
  if (!alvo) {
    return NextResponse.json(
      { erro: 'parâmetro `alvo` (id do dossiê) ausente no compute' },
      { status: 400, headers: headersNoStore },
    );
  }

  const r = await computarDossie(alvo, compute.idToken);
  if (!r.ok) {
    return NextResponse.json({ erro: r.erro }, { status: r.status, headers: headersNoStore });
  }
  return NextResponse.json(r.dossie, { headers: headersNoStore });
}
