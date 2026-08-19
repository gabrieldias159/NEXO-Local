/**
 * API de automação do Estúdio — um projeto.
 *
 *   GET    /api/editor/projects/{id}   estado completo (ou ?resumo=1)
 *   DELETE /api/editor/projects/{id}   apaga o projeto
 */
import { NextResponse } from 'next/server';
import { tokenInternoValido } from '@/lib/ia/auth-interno';
import { lerDoc, apagarDoc, assertEmulador } from '@/lib/editor/api/firestore-rest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(obj: unknown, status = 200): Response {
  return NextResponse.json(obj, { status });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!tokenInternoValido(req)) return json({ erro: 'nao autorizado' }, 401);
  const { id } = await ctx.params;
  try {
    assertEmulador();
    const p = await lerDoc(`videoProjects/${id}`);
    if (!p) return json({ erro: `projeto '${id}' nao existe` }, 404);

    // O documento inteiro fica grande com muitos clips; `?resumo=1` devolve o
    // mapa da timeline, que costuma ser o suficiente para decidir a proxima
    // operacao sem trafegar o projeto todo.
    if (new URL(req.url).searchParams.get('resumo') === '1') {
      const tracks = (p.tracks ?? []) as Array<Record<string, unknown>>;
      return json({
        id: p.id,
        nome: p.name,
        resolucao: p.resolution,
        frameRate: p.frameRate,
        duracao: p.duration,
        assets: ((p.assets ?? []) as Array<Record<string, unknown>>).map((a) => ({
          id: a.id, nome: a.name, tipo: a.type, duracao: a.duration,
        })),
        tracks: tracks.map((t) => ({
          id: t.id,
          tipo: t.type,
          nome: t.name,
          clips: ((t.clips ?? []) as Array<Record<string, unknown>>).map((c) => ({
            id: c.id,
            assetId: c.assetId,
            naTimeline: [c.startInTimeline, c.endInTimeline],
            naMidia: [c.startInAsset, c.endInAsset],
          })),
        })),
        legendas: ((p.captionTracks ?? []) as Array<Record<string, unknown>>).map((t) => ({
          id: t.id, nome: t.name, falas: ((t.cues ?? []) as unknown[]).length,
        })),
      });
    }
    return json(p);
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!tokenInternoValido(req)) return json({ erro: 'nao autorizado' }, 401);
  const { id } = await ctx.params;
  try {
    assertEmulador();
    await apagarDoc(`videoProjects/${id}`);
    return json({ ok: true, id });
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
}
