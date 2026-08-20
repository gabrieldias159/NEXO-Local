/**
 * Leitura do ACERVO DO GABINETE em disco e download UNITÁRIO (recursos 13/14).
 *
 * Roda só no servidor (usa `node:fs`). A pasta padrão é a do dono
 * (`Downloads/ACERVO_GABINETE`); dá para apontar outra com a variável de
 * ambiente `ACERVO_GABINETE_DIR`.
 *
 * Regra do acervo (o `_leiame` dos dois catálogos): **catálogo-first**. Aqui
 * a gente lê os metadados de tudo e baixa UM item por vez, quando o usuário
 * pede. Nunca em massa.
 *
 * Os resolvedores de página (Mixkit/Pexels/Archive/Videezy) são a porta do
 * `ferramentas/baixar_video.py` do acervo, reescrita em TS para não depender
 * de Python no caminho do editor.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

import type { ItemMeme, ItemSom, NivelRisco } from './tipos';

/** Pasta do acervo (configurável por env). */
export function pastaAcervo(): string {
  return (
    process.env.ACERVO_GABINETE_DIR ||
    'C:/Users/Vereador/Downloads/ACERVO_GABINETE'
  );
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Hosts de onde o editor aceita baixar. O acervo é curado e conhecido — abrir
 * para qualquer URL transformaria a rota num proxy de download genérico.
 */
const HOSTS_PERMITIDOS = [
  'myinstants.com',
  'mixkit.co',
  'assets.mixkit.co',
  'pexels.com',
  'images.pexels.com',
  'videos.pexels.com',
  'archive.org',
  'videezy.com',
  'static.videezy.com',
  'pixabay.com',
  'cdn.pixabay.com',
  'coverr.co',
  'storage.coverr.co',
  'media.tenor.com',
  'tenor.com',
  'giphy.com',
  'media.giphy.com',
];

export function hostPermitido(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return HOSTS_PERMITIDOS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Normaliza o texto de risco do catálogo (pode vir com motivo junto). */
function normalizarRisco(bruto: unknown): NivelRisco {
  const txt = String(bruto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (txt.startsWith('alto')) return 'alto';
  if (txt.startsWith('medio')) return 'medio';
  return 'baixo';
}

async function lerJson(caminho: string): Promise<Record<string, unknown>> {
  const txt = await readFile(caminho, 'utf8');
  return JSON.parse(txt) as Record<string, unknown>;
}

async function listarArquivos(dir: string, exts: string[]): Promise<string[]> {
  try {
    const itens = await readdir(dir, { withFileTypes: true });
    return itens
      .filter(
        (i) =>
          i.isFile() && exts.some((e) => i.name.toLowerCase().endsWith(e)),
      )
      .map((i) => join(dir, i.name));
  } catch {
    return [];
  }
}

// ============================================================================
// Catálogo de SONS (recurso 13)
// ============================================================================

/**
 * Sons do acervo: os 79 do catálogo do myinstants (só referência, baixados um
 * a um) + os que já estão no disco em `sons/cc0` e `sons/myinstants`.
 */
export async function lerCatalogoSons(): Promise<ItemSom[]> {
  const raiz = pastaAcervo();
  const out: ItemSom[] = [];

  // 1) já em disco — entram primeiro (uso imediato, zero download).
  const locais = [
    ...(await listarArquivos(join(raiz, 'sons', 'cc0'), ['.mp3', '.wav'])),
    ...(await listarArquivos(join(raiz, 'sons', 'myinstants'), ['.mp3', '.wav'])),
    ...(await listarArquivos(join(raiz, 'sons'), ['.wav'])),
    ...(await listarArquivos(join(raiz, 'trilhas'), ['.mp3', '.wav'])),
  ];
  for (const caminho of locais) {
    const nome = basename(caminho);
    out.push({
      id: `disco:${caminho}`,
      nome,
      tags: tagsDoNomeDeArquivo(nome),
      risco: 'baixo',
      motivoRisco: 'já aprovado e baixado no acervo',
      arquivoLocal: caminho,
      origem: 'disco',
    });
  }

  // 2) catálogo online (myinstants) — metadados, download sob demanda.
  try {
    const cat = await lerJson(join(raiz, 'sons', 'catalogo.json'));
    const lista = (cat.myinstants_catalogo ?? []) as Array<
      Record<string, unknown>
    >;
    for (const item of lista) {
      const nome = String(item.nome ?? 'som');
      out.push({
        id: `cat:${String(item.url_pagina ?? nome)}`,
        nome,
        urlPagina: item.url_pagina ? String(item.url_pagina) : undefined,
        urlMp3: item.url_mp3 ? String(item.url_mp3) : undefined,
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        momento: item.momento ? String(item.momento) : undefined,
        risco: normalizarRisco(item.risco),
        motivoRisco: item.motivo_risco ? String(item.motivo_risco) : undefined,
        origem: 'catalogo',
      });
    }
  } catch {
    /* sem catálogo: fica só o que está em disco */
  }

  return out;
}

/** Tira palavras-chave do nome do arquivo (AM034_moedas_dinheiro.mp3). */
function tagsDoNomeDeArquivo(nome: string): string[] {
  return nome
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[_\-\s]+/)
    .filter((p) => p.length > 3 && !/^(am|som|b|vm)\d*$/i.test(p))
    .slice(0, 4);
}

// ============================================================================
// Catálogo de MEMES/EFEITOS em vídeo (recurso 14)
// ============================================================================

export async function lerCatalogoMemes(): Promise<ItemMeme[]> {
  const raiz = pastaAcervo();
  const out: ItemMeme[] = [];

  // 1) memes próprios já em disco (VM*).
  const locais = [
    ...(await listarArquivos(join(raiz, 'memes_video'), [
      '.mp4',
      '.webm',
      '.mov',
    ])),
    ...(await listarArquivos(join(raiz, 'memes_video', '_novos'), [
      '.mp4',
      '.webm',
      '.mov',
    ])),
  ];
  for (const caminho of locais) {
    const nome = basename(caminho);
    out.push({
      id: `disco:${caminho}`,
      nome,
      fonte: 'Acervo local',
      risco: 'baixo',
      riscoDetalhe: 'já aprovado e baixado no acervo',
      arquivoLocal: caminho,
      origem: 'disco',
      usoOrganico: false,
      somenteBusca: false,
    });
  }

  // 2) catálogo online curado.
  try {
    const cat = await lerJson(join(raiz, 'memes_video', 'catalogo_online.json'));
    const lista = (cat.efeitos ?? []) as Array<Record<string, unknown>>;
    for (const item of lista) {
      const fonte = String(item.fonte ?? '');
      const url = item.url ? String(item.url) : undefined;
      const riscoBruto = String(item.risco ?? '');
      const terceiros = /tenor|giphy/i.test(fonte);
      out.push({
        id: `cat:${url ?? String(item.nome)}`,
        nome: String(item.nome ?? 'efeito'),
        fonte,
        url,
        licenca: item.licenca ? String(item.licenca) : undefined,
        risco: normalizarRisco(riscoBruto),
        riscoDetalhe: riscoBruto || undefined,
        uso: item.uso ? String(item.uso) : undefined,
        origem: 'catalogo',
        // Regra do dono: Tenor/GIPHY são conteúdo de terceiros — só post
        // orgânico, nunca impulsionado.
        usoOrganico: terceiros || /organic/i.test(riscoBruto),
        // "BUSCA Tenor: …" é um link de busca, não um arquivo.
        somenteBusca: /requer chave/i.test(fonte) || /^BUSCA /i.test(String(item.nome ?? '')),
      });
    }
  } catch {
    /* sem catálogo: fica só o que está em disco */
  }

  return out;
}

// ============================================================================
// Download unitário
// ============================================================================

async function baixarTexto(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

/**
 * Página do myinstants → URL do mp3. O arquivo está no `onclick="play('…')"`
 * do botão de tocar (mesma extração do `baixar_myinstants.py`).
 */
export async function resolverMp3Myinstants(urlPagina: string): Promise<string> {
  const html = await baixarTexto(urlPagina);
  const m =
    html.match(/play\('([^']+\.mp3)'/) ??
    html.match(/data-url="([^"]+\.mp3)"/) ??
    html.match(/href="(\/media\/sounds\/[^"]+\.mp3)"/);
  if (!m) throw new Error('não achei o .mp3 nessa página do myinstants');
  return m[1].startsWith('/') ? `https://www.myinstants.com${m[1]}` : m[1];
}

/**
 * Página de banco de vídeo → URL do arquivo. Porta os resolvedores testados
 * do `baixar_video.py`: Mixkit, Videezy, Pexels e Archive.org. URL que já
 * aponta para um arquivo passa direto.
 */
export async function resolverUrlDeVideo(url: string): Promise<string> {
  if (/\.(mp4|webm|mov|mkv)(\?|$)/i.test(url)) return url;
  const host = new URL(url).hostname.toLowerCase();

  if (host.endsWith('mixkit.co')) {
    const html = await baixarTexto(url);
    const id = url.replace(/\/$/, '').match(/-(\d+)$/)?.[1];
    let urls = [
      ...html.matchAll(
        /https:\/\/assets\.mixkit\.co\/videos\/\d+\/\d+-(?:1080|720|360)\.mp4/g,
      ),
    ].map((m) => m[0]);
    if (id) {
      const doVideo = urls.filter((u) => u.includes(`/videos/${id}/`));
      if (doVideo.length) urls = doVideo;
    }
    for (const res of ['1080', '720', '360']) {
      const achou = urls.find((u) => u.endsWith(`-${res}.mp4`));
      if (achou) return achou;
    }
    throw new Error('nenhum .mp4 encontrado na página do Mixkit');
  }

  if (host.endsWith('videezy.com')) {
    const html = await baixarTexto(url);
    const m = html.match(
      /https:\/\/static\.videezy\.com\/system\/resources\/previews\/[^"']+\.mp4/,
    );
    if (!m) throw new Error('nenhum .mp4 encontrado na página do Videezy');
    return m[0];
  }

  if (host.endsWith('pexels.com')) {
    const id = new URL(url).pathname.match(/\/video\/(?:[a-z0-9-]*?-)?(\d+)\/?$/)?.[1];
    if (!id) throw new Error('não achei o id numérico na URL do Pexels');
    return `https://www.pexels.com/download/video/${id}/`;
  }

  if (host.endsWith('archive.org')) {
    const ident = url.match(/archive\.org\/(?:details|download)\/([^/?#]+)/)?.[1];
    if (!ident) throw new Error('URL do Archive.org sem identificador');
    const meta = JSON.parse(
      await baixarTexto(`https://archive.org/metadata/${ident}`),
    ) as { files?: Array<{ name?: string; source?: string; size?: string }> };
    const videos = (meta.files ?? []).filter((f) =>
      /\.(mp4|mov|webm|mkv)$/i.test(f.name ?? ''),
    );
    if (videos.length === 0) throw new Error('item do Archive sem vídeo');
    const originais = videos.filter((f) => f.source === 'original');
    const escolhido = (originais.length ? originais : videos).sort(
      (a, b) => Number(b.size ?? 0) - Number(a.size ?? 0),
    )[0];
    return `https://archive.org/download/${ident}/${encodeURIComponent(escolhido.name ?? '')}`;
  }

  throw new Error(
    `não sei resolver a página de ${host} — use a URL direta do arquivo`,
  );
}

/** Baixa os bytes de um arquivo do acervo (com o User-Agent de navegador). */
export async function baixarArquivo(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}
