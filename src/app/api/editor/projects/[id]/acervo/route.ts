/**
 * ACERVO DO GABINETE — trazer UM item pro projeto (recursos 13 e 14).
 *
 *   POST /api/editor/projects/{id}/acervo
 *   { "tipo": "som" | "meme",
 *     "nome": "AM034 moedas",
 *     "arquivoLocal": "C:/…/AM034_moedas_dinheiro.mp3",   // já em disco
 *     "urlPagina":    "https://www.myinstants.com/…/",     // som online
 *     "url":          "https://mixkit.co/…/" }             // vídeo online
 *
 * Baixa/copia SÓ esse item, sobe pro Storage do emulador na pasta do projeto
 * e devolve o `MediaAsset` pronto. **Não grava no documento do projeto** — a
 * interface adiciona o asset ao store, que salva junto com o resto (evita
 * dois donos escrevendo o mesmo doc ao mesmo tempo).
 *
 * Só baixa de hosts do acervo curado (`HOSTS_PERMITIDOS`): a rota não é um
 * proxy de download genérico.
 */
import { NextResponse } from 'next/server';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { writeFile, unlink } from 'node:fs/promises';

import { assertEmulador, lerDoc } from '@/lib/editor/api/firestore-rest';
import { gerarId } from '@/lib/editor/api/ops';
import {
  baixarArquivo,
  hostPermitido,
  resolverMp3Myinstants,
  resolverUrlDeVideo,
} from '@/lib/editor/acervo/servidor';
import { firebaseConfig } from '@/firebase/config';

const execFileP = promisify(execFile);

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const STORAGE_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.gif': 'image/gif',
};

function nomeSeguro(n: string): string {
  return n.replace(/[^\w.\-]+/g, '_').slice(0, 120);
}

/** Caminho do ffmpeg vendorado nas functions (mesmo binário do render). */
function ffmpegBin(): string {
  return join(
    process.cwd(),
    'functions',
    'node_modules',
    '@ffmpeg-installer',
    'win32-x64',
    'ffmpeg.exe',
  );
}

/** Duração/dimensões: o ffmpeg escreve no STDERR e sai != 0 sem output. */
async function medir(
  caminho: string,
): Promise<{ duration?: number; width?: number; height?: number }> {
  let saida = '';
  try {
    await execFileP(ffmpegBin(), ['-i', caminho], { timeout: 60000 });
  } catch (e) {
    saida = String((e as { stderr?: string }).stderr ?? '');
  }
  const out: { duration?: number; width?: number; height?: number } = {};
  const d = saida.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (d) {
    out.duration = Number(
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

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    assertEmulador();

    const body = (await req.json().catch(() => ({}))) as {
      tipo?: 'som' | 'meme';
      nome?: string;
      arquivoLocal?: string;
      urlPagina?: string;
      url?: string;
    };
    const tipoItem = body.tipo === 'meme' ? 'meme' : 'som';

    const projeto = await lerDoc(`videoProjects/${id}`);
    if (!projeto) {
      return NextResponse.json(
        { ok: false, erro: `projeto '${id}' nao existe` },
        { status: 404 },
      );
    }

    // ---- 1. Consegue os bytes -------------------------------------------
    let bytes: Uint8Array;
    let nomeArquivo: string;

    if (body.arquivoLocal) {
      const info = await stat(body.arquivoLocal).catch(() => null);
      if (!info?.isFile()) {
        return NextResponse.json(
          { ok: false, erro: `arquivo nao encontrado: ${body.arquivoLocal}` },
          { status: 404 },
        );
      }
      bytes = new Uint8Array(await readFile(body.arquivoLocal));
      nomeArquivo = basename(body.arquivoLocal);
    } else {
      const alvoBruto = body.urlPagina ?? body.url;
      if (!alvoBruto) {
        return NextResponse.json(
          { ok: false, erro: 'informe `arquivoLocal`, `urlPagina` ou `url`' },
          { status: 400 },
        );
      }
      if (!hostPermitido(alvoBruto)) {
        return NextResponse.json(
          {
            ok: false,
            erro:
              'host fora do acervo curado — o editor só baixa das fontes ' +
              'catalogadas (myinstants, Mixkit, Pexels, Archive, Videezy, ' +
              'Pixabay, Coverr, Tenor, GIPHY).',
          },
          { status: 400 },
        );
      }
      const urlArquivo =
        tipoItem === 'som'
          ? body.url && /\.mp3(\?|$)/i.test(body.url)
            ? body.url
            : await resolverMp3Myinstants(alvoBruto)
          : await resolverUrlDeVideo(alvoBruto);
      if (!hostPermitido(urlArquivo)) {
        return NextResponse.json(
          { ok: false, erro: `a página apontou para um host não permitido: ${urlArquivo}` },
          { status: 400 },
        );
      }
      bytes = await baixarArquivo(urlArquivo);
      nomeArquivo =
        decodeURIComponent(basename(new URL(urlArquivo).pathname)) ||
        (tipoItem === 'som' ? 'som.mp3' : 'efeito.mp4');
    }

    if (bytes.byteLength === 0) {
      return NextResponse.json(
        { ok: false, erro: 'o arquivo baixado veio vazio' },
        { status: 502 },
      );
    }

    const ext = (extname(nomeArquivo) || (tipoItem === 'som' ? '.mp3' : '.mp4'))
      .toLowerCase();
    const tipo: 'audio' | 'video' | 'image' =
      tipoItem === 'som' ? 'audio' : ext === '.gif' ? 'image' : 'video';

    // ---- 2. Mede com ffmpeg (precisa de arquivo em disco) ----------------
    const temp = join(tmpdir(), `acervo_${gerarId('tmp')}${ext}`);
    await writeFile(temp, bytes);
    const medidas = tipo === 'image' ? {} : await medir(temp);
    await unlink(temp).catch(() => {});

    // ---- 3. Sobe pro Storage do projeto ---------------------------------
    const arquivo = `${gerarId('acv')}-${nomeSeguro(nomeArquivo)}`;
    const storagePath = `videoProjects/${id}/assets/${arquivo}`;
    const bucket = firebaseConfig.storageBucket;
    const up = await fetch(
      `http://${STORAGE_HOST}/v0/b/${bucket}/o?name=${encodeURIComponent(storagePath)}`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner',
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
        },
        body: bytes as unknown as BodyInit,
      },
    );
    if (!up.ok) {
      return NextResponse.json(
        { ok: false, erro: `falha no upload: HTTP ${up.status}` },
        { status: 502 },
      );
    }
    const meta = (await up.json()) as { downloadTokens?: string };
    const downloadUrl =
      `http://${STORAGE_HOST}/v0/b/${bucket}/o/${encodeURIComponent(storagePath)}` +
      `?alt=media${meta.downloadTokens ? `&token=${meta.downloadTokens}` : ''}`;

    return NextResponse.json(
      {
        ok: true,
        asset: {
          id: gerarId('asset'),
          name: body.nome?.trim() || nomeArquivo,
          type: tipo,
          storagePath,
          downloadUrl,
          size: bytes.byteLength,
          ...medidas,
        },
      },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, erro: (e as Error).message },
      { status: 500 },
    );
  }
}
