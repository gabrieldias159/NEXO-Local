/**
 * ACERVO DO GABINETE — servir um arquivo do disco pra PRÉ-ESCUTA/PREVIEW.
 *
 *   GET /api/editor/acervo/arquivo?caminho=C:/…/AM034_moedas_dinheiro.mp3
 *
 * Só serve arquivos DENTRO da pasta do acervo (`pastaAcervo()`), com tipo de
 * mídia conhecido. É o que permite ouvir o som ou ver o meme antes de decidir
 * trazer pro projeto — sem baixar nada e sem copiar bytes para o Storage.
 */
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import { assertEmulador } from '@/lib/editor/api/firestore-rest';
import { pastaAcervo } from '@/lib/editor/acervo/servidor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

export async function GET(req: Request): Promise<Response> {
  try {
    assertEmulador();
    const caminho = new URL(req.url).searchParams.get('caminho') ?? '';
    if (!caminho) return new Response('falta `caminho`', { status: 400 });

    // Confinado à pasta do acervo — nada de `..` saindo pra outro lugar.
    const alvo = resolve(caminho);
    const raiz = resolve(pastaAcervo());
    if (!alvo.toLowerCase().startsWith(raiz.toLowerCase())) {
      return new Response('caminho fora do acervo', { status: 403 });
    }

    const mime = MIME[extname(alvo).toLowerCase()];
    if (!mime) return new Response('tipo de arquivo não servido', { status: 415 });

    const bytes = await readFile(alvo);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (e) {
    return new Response((e as Error).message, { status: 500 });
  }
}
