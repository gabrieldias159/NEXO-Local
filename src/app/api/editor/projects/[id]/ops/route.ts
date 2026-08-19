/**
 * API de automação do Estúdio — OPERAÇÕES em lote.
 *
 *   POST /api/editor/projects/{id}/ops
 *   { "ops": [ {...}, {...} ] }
 *
 * Este é o endpoint principal. Lê o projeto, aplica todas as operações na
 * ordem e grava uma vez só. Se qualquer operação falhar, NADA é gravado — o
 * projeto não fica meio-editado.
 *
 * `GET` no mesmo caminho devolve o catálogo de operações (útil para o agente
 * descobrir a gramática sem consultar a documentação).
 */
import { NextResponse } from 'next/server';
import { tokenInternoValido } from '@/lib/ia/auth-interno';
import { lerDoc, gravarDoc, assertEmulador } from '@/lib/editor/api/firestore-rest';
import {
  aplicarOperacoes,
  OPS_DISPONIVEIS,
  type Operacao,
} from '@/lib/editor/api/ops';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

function json(obj: unknown, status = 200): Response {
  return NextResponse.json(obj, { status });
}

export async function GET(req: Request): Promise<Response> {
  if (!tokenInternoValido(req)) return json({ erro: 'nao autorizado' }, 401);
  return json({ operacoes: OPS_DISPONIVEIS });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!tokenInternoValido(req)) return json({ erro: 'nao autorizado' }, 401);
  const { id } = await ctx.params;

  try {
    assertEmulador();

    const body = (await req.json().catch(() => null)) as { ops?: Operacao[] } | null;
    if (!body || !Array.isArray(body.ops) || body.ops.length === 0) {
      return json(
        { erro: 'corpo precisa ser { "ops": [...] } com pelo menos uma operacao', operacoes: OPS_DISPONIVEIS },
        400,
      );
    }

    const projeto = await lerDoc(`videoProjects/${id}`);
    if (!projeto) return json({ erro: `projeto '${id}' nao existe` }, 404);

    let resultados;
    try {
      resultados = aplicarOperacoes(projeto, body.ops);
    } catch (e) {
      // Erro de VALIDAÇÃO: nada foi gravado. 422 para o agente distinguir de
      // uma falha de infraestrutura (500) e poder corrigir o payload.
      return json({ erro: (e as Error).message, gravado: false }, 422);
    }

    await gravarDoc(`videoProjects/${id}`, projeto);

    return json({
      ok: true,
      id,
      aplicadas: resultados.length,
      resultados,
      duracao: projeto.duration,
      abrirEm: `/apps/suite-editor-videos/${id}`,
    });
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
}
