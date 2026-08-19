/**
 * API de automação do Estúdio — RENDER (exportar/gerar o vídeo).
 *
 *   POST /api/editor/projects/{id}/render   enfileira o render
 *   GET  /api/editor/projects/{id}/render   estado dos renders do projeto
 *
 * O render NÃO acontece aqui: gravamos um doc em `renderJobs/{jobId}` e a Cloud
 * Function `onRenderRequest{Low,Medium,High}` reage ao trigger e roda o ffmpeg.
 * Local, no emulador de functions — o mesmo caminho que o botão Exportar usa.
 */
import { NextResponse } from 'next/server';
import { tokenInternoValido } from '@/lib/ia/auth-interno';
import { lerDoc, gravarDoc, listarColecao, assertEmulador } from '@/lib/editor/api/firestore-rest';
import { gerarId } from '@/lib/editor/api/ops';
import { resolverOwnerUid } from '@/lib/editor/api/owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(obj: unknown, status = 200): Response {
  return NextResponse.json(obj, { status });
}

/** 14 dias — mesmo TTL que a interface usa (o trigger de delete limpa o Storage). */
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!tokenInternoValido(req)) return json({ erro: 'nao autorizado' }, 401);
  const { id } = await ctx.params;

  try {
    assertEmulador();

    const projeto = await lerDoc(`videoProjects/${id}`);
    if (!projeto) return json({ erro: `projeto '${id}' nao existe` }, 404);

    const temClip = ((projeto.tracks ?? []) as Array<{ clips?: unknown[] }>).some(
      (t) => (t.clips ?? []).length > 0,
    );
    if (!temClip) {
      return json(
        { erro: 'projeto sem nenhum clip na timeline — nao ha o que renderizar' },
        422,
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      resolucao?: '1080p' | '720p' | '480p';
      formato?: 'mp4' | 'webm';
      qualidade?: 'low' | 'medium' | 'high';
      queimarLegendas?: boolean;
      incluirLogo?: boolean;
      incluirRodape?: boolean;
      incluirEncerramento?: boolean;
      tier?: 'low' | 'medium' | 'high';
    };

    const jobId = gerarId('render');
    const agora = new Date();
    const job = {
      id: jobId,
      projectId: id,
      ownerUid: await resolverOwnerUid(),
      // Sempre cloud-ffmpeg: o caminho wasm roda NO NAVEGADOR, e aqui não há
      // navegador. Localmente "cloud" é o emulador de functions da propria
      // maquina, entao continua custo zero.
      engine: 'cloud-ffmpeg',
      tier: body.tier ?? 'high',
      status: 'pending',
      progress: 0,
      exportSettings: {
        resolution: body.resolucao ?? '720p',
        format: body.formato ?? 'mp4',
        quality: body.qualidade ?? 'high',
        burnCaptions: body.queimarLegendas ?? true,
        includeLogo: body.incluirLogo ?? false,
        includeFooter: body.incluirRodape ?? false,
        includeEnding: body.incluirEncerramento ?? false,
      },
      createdAt: agora,
      expiresAt: new Date(Date.now() + TTL_MS),
    };

    await gravarDoc(`renderJobs/${jobId}`, job);

    return json(
      {
        ok: true,
        jobId,
        status: 'pending',
        acompanharEm: `/api/editor/projects/${id}/render`,
        aviso:
          'o render roda no emulador de functions; acompanhe o status ate complete',
      },
      202,
    );
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!tokenInternoValido(req)) return json({ erro: 'nao autorizado' }, 401);
  const { id } = await ctx.params;
  try {
    assertEmulador();
    const todos = await listarColecao('renderJobs', 100);
    const meus = todos
      .filter((j) => j.projectId === id)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return json({
      total: meus.length,
      jobs: meus.map((j) => ({
        jobId: j.id,
        status: j.status,
        progresso: j.progress,
        tier: j.tier,
        erro: j.error,
        urlSaida: j.outputUrl,
        criadoEm: j.createdAt,
        concluidoEm: j.completedAt,
      })),
    });
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
}
