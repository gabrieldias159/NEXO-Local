/**
 * API de automação do Estúdio — coleção de projetos.
 *
 *   GET  /api/editor/projects        lista os projetos (resumo)
 *   POST /api/editor/projects        cria um projeto
 *
 * Auth: header `x-internal-ia-token` (o mesmo INTERNAL_IA_TOKEN do gateway de
 * IA). É uma API de máquina — não usa sessão de navegador.
 */
import { NextResponse } from 'next/server';
import { tokenInternoValido } from '@/lib/ia/auth-interno';
import { gravarDoc, listarColecao, assertEmulador } from '@/lib/editor/api/firestore-rest';
import { novoProjeto, RESOLUCOES } from '@/lib/editor/api/ops';
import { resolverOwnerUid } from '@/lib/editor/api/owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(obj: unknown, status = 200): Response {
  return NextResponse.json(obj, { status });
}

export async function GET(req: Request): Promise<Response> {
  if (!tokenInternoValido(req)) return json({ erro: 'nao autorizado' }, 401);
  try {
    assertEmulador();
    const docs = await listarColecao('videoProjects', 200);
    return json({
      total: docs.length,
      projetos: docs.map((d) => ({
        id: d.id,
        nome: d.name,
        resolucao: d.resolution,
        frameRate: d.frameRate,
        duracao: d.duration,
        tracks: Array.isArray(d.tracks) ? d.tracks.length : 0,
        assets: Array.isArray(d.assets) ? d.assets.length : 0,
        atualizadoEm: d.updatedAt,
        abrirEm: `/apps/suite-editor-videos/${d.id}`,
      })),
    });
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!tokenInternoValido(req)) return json({ erro: 'nao autorizado' }, 401);
  try {
    assertEmulador();
    const body = (await req.json().catch(() => ({}))) as {
      nome?: string;
      resolucao?: string;
      frameRate?: 24 | 30 | 60;
      stageMode?: 'single' | 'split-vertical';
    };
    if (!body.nome) {
      return json({ erro: 'campo `nome` obrigatorio' }, 400);
    }
    if (body.resolucao && !RESOLUCOES[body.resolucao]) {
      return json(
        { erro: `resolucao invalida`, disponiveis: Object.keys(RESOLUCOES) },
        400,
      );
    }

    const ownerUid = await resolverOwnerUid();
    const projeto = novoProjeto({
      name: body.nome,
      ownerUid,
      resolucao: body.resolucao,
      frameRate: body.frameRate,
      stageMode: body.stageMode,
    });

    await gravarDoc(`videoProjects/${projeto.id}`, projeto);
    return json(
      {
        ok: true,
        id: projeto.id,
        nome: projeto.name,
        resolucao: projeto.resolution,
        abrirEm: `/apps/suite-editor-videos/${projeto.id}`,
      },
      201,
    );
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
}
