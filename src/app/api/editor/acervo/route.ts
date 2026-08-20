/**
 * ACERVO DO GABINETE — catálogo (recursos 13 e 14).
 *
 *   GET /api/editor/acervo?tipo=sons
 *   GET /api/editor/acervo?tipo=memes
 *
 * Devolve só METADADOS: nome, momento de uso, tags, risco editorial, licença
 * e de onde vem o arquivo. Nada é baixado aqui — o download é unitário, em
 * `POST /api/editor/projects/{id}/acervo`, e só do item que o usuário
 * escolher (padrão catálogo-first do acervo).
 *
 * Chamada pelo NAVEGADOR (painel do MediaBin), então não usa o token interno
 * de automação. A proteção é o emulador: a rota lê uma pasta local da máquina
 * do dono e só existe no NEXO-Local.
 */
import { NextResponse } from 'next/server';

import { assertEmulador } from '@/lib/editor/api/firestore-rest';
import {
  lerCatalogoMemes,
  lerCatalogoSons,
  pastaAcervo,
} from '@/lib/editor/acervo/servidor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    assertEmulador();
    const tipo = new URL(req.url).searchParams.get('tipo') ?? 'sons';
    if (tipo === 'sons') {
      return NextResponse.json({
        ok: true,
        pasta: pastaAcervo(),
        sons: await lerCatalogoSons(),
      });
    }
    if (tipo === 'memes') {
      return NextResponse.json({
        ok: true,
        pasta: pastaAcervo(),
        memes: await lerCatalogoMemes(),
      });
    }
    return NextResponse.json(
      { ok: false, erro: "`tipo` deve ser 'sons' ou 'memes'" },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, pasta: pastaAcervo(), erro: (e as Error).message },
      { status: 500 },
    );
  }
}
