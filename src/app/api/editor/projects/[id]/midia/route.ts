/**
 * API de automação do Estúdio — CARREGAR MÍDIA.
 *
 *   POST /api/editor/projects/{id}/midia
 *   { "caminho": "C:/Users/.../video.mp4", "nome": "Base" }
 *
 * Sobe um arquivo DO DISCO para o Storage do emulador e registra o asset no
 * projeto — o equivalente ao botão "Importar" do painel Mídias.
 *
 * É a peça que faltava para um agente montar um vídeo de verdade: as demais
 * operações só aceitam URL, e um agente tem arquivos locais, não URLs.
 *
 * A duração é medida com o ffmpeg (o mesmo binário que as functions usam). Sem
 * ela o `addClip` que omite `fimNaMidia` cairia no default de 5s e o recorte
 * sairia errado sem avisar.
 */
import { NextResponse } from 'next/server';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { tokenInternoValido } from '@/lib/ia/auth-interno';
import { lerDoc, gravarDoc, assertEmulador } from '@/lib/editor/api/firestore-rest';
import { gerarId } from '@/lib/editor/api/ops';
import { firebaseConfig } from '@/firebase/config';

const execFileP = promisify(execFile);

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function json(obj: unknown, status = 200): Response {
  return NextResponse.json(obj, { status });
}

const STORAGE_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';

const EXT_VIDEO = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'];
const EXT_AUDIO = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
const EXT_IMAGEM = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

function tipoPelaExtensao(caminho: string): 'video' | 'audio' | 'image' | null {
  const e = extname(caminho).toLowerCase();
  if (EXT_VIDEO.includes(e)) return 'video';
  if (EXT_AUDIO.includes(e)) return 'audio';
  if (EXT_IMAGEM.includes(e)) return 'image';
  return null;
}

function mime(caminho: string): string {
  const e = extname(caminho).toLowerCase();
  const t: Record<string, string> = {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mkv': 'video/x-matroska', '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  };
  return t[e] ?? 'application/octet-stream';
}

/** Caminho do ffmpeg vendorado nas functions. */
function ffmpegBin(): string {
  return join(
    process.cwd(),
    'functions', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe',
  );
}

/**
 * Mede duração e dimensões. O ffmpeg escreve isso no STDERR e sai com código
 * != 0 quando não há output — por isso a leitura é do erro, não do stdout.
 */
async function medir(
  caminho: string,
): Promise<{ duracao?: number; width?: number; height?: number }> {
  let saida = '';
  try {
    await execFileP(ffmpegBin(), ['-i', caminho], { timeout: 60000 });
  } catch (e) {
    saida = String((e as { stderr?: string }).stderr ?? '');
  }
  const out: { duracao?: number; width?: number; height?: number } = {};
  const d = saida.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (d) {
    out.duracao = Number(
      (Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])).toFixed(3),
    );
  }
  const r = saida.match(/,\s(\d{2,5})x(\d{2,5})[\s,]/);
  if (r) {
    out.width = Number(r[1]);
    out.height = Number(r[2]);
  }
  return out;
}

function nomeSeguro(n: string): string {
  return n.replace(/[^\w.\-]+/g, '_').slice(0, 120);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!tokenInternoValido(req)) return json({ erro: 'nao autorizado' }, 401);
  const { id } = await ctx.params;

  try {
    assertEmulador();

    const body = (await req.json().catch(() => ({}))) as {
      caminho?: string;
      nome?: string;
      tipo?: 'video' | 'audio' | 'image';
    };
    if (!body.caminho) return json({ erro: 'campo `caminho` obrigatorio' }, 400);

    const projeto = await lerDoc(`videoProjects/${id}`);
    if (!projeto) return json({ erro: `projeto '${id}' nao existe` }, 404);

    let info;
    try {
      info = await stat(body.caminho);
    } catch {
      return json({ erro: `arquivo nao encontrado: ${body.caminho}` }, 404);
    }
    if (!info.isFile()) return json({ erro: 'o caminho nao e um arquivo' }, 400);

    const tipo = body.tipo ?? tipoPelaExtensao(body.caminho);
    if (!tipo) {
      return json(
        { erro: `nao reconheci a extensao de '${basename(body.caminho)}'; informe \`tipo\`` },
        400,
      );
    }

    // Sobe para o MESMO caminho que a interface usa, para os dois caminhos de
    // importacao serem indistinguiveis.
    const arquivo = `${gerarId('up')}-${nomeSeguro(basename(body.caminho))}`;
    const storagePath = `videoProjects/${id}/assets/${arquivo}`;
    const bucket = firebaseConfig.storageBucket;

    const bytes = await readFile(body.caminho);
    const up = await fetch(
      `http://${STORAGE_HOST}/v0/b/${bucket}/o?name=${encodeURIComponent(storagePath)}`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer owner', 'Content-Type': mime(body.caminho) },
        body: new Uint8Array(bytes),
      },
    );
    if (!up.ok) {
      return json({ erro: `falha no upload: HTTP ${up.status} ${await up.text()}` }, 502);
    }
    const meta = (await up.json()) as { downloadTokens?: string };

    // URL COM TOKEN: o <video>/<audio> do navegador busca sem cabecalho de
    // auth, entao uma URL que dependa de Bearer nao tocaria.
    const downloadUrl =
      `http://${STORAGE_HOST}/v0/b/${bucket}/o/${encodeURIComponent(storagePath)}` +
      `?alt=media${meta.downloadTokens ? `&token=${meta.downloadTokens}` : ''}`;

    const medidas = tipo === 'image' ? {} : await medir(body.caminho);

    const asset: Record<string, unknown> = {
      id: gerarId('asset'),
      name: body.nome ?? basename(body.caminho),
      type: tipo,
      source: 'firebase',
      storagePath,
      downloadUrl,
      size: info.size,
      status: 'ready',
      createdAt: new Date(),
      ...medidas.duracao !== undefined ? { duration: medidas.duracao } : {},
      ...medidas.width !== undefined ? { width: medidas.width } : {},
      ...medidas.height !== undefined ? { height: medidas.height } : {},
    };

    projeto.assets = [...((projeto.assets ?? []) as unknown[]), asset];
    projeto.updatedAt = new Date();
    await gravarDoc(`videoProjects/${id}`, projeto);

    return json({
      ok: true,
      assetId: asset.id,
      nome: asset.name,
      tipo,
      duracao: medidas.duracao ?? null,
      dimensoes: medidas.width ? `${medidas.width}x${medidas.height}` : null,
      tamanhoMB: Number((info.size / 1048576).toFixed(2)),
      storagePath,
    }, 201);
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
}
