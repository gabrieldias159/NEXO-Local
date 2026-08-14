/**
 * POST /api/video/import-url
 *
 * Faz proxy/extração de uma URL de vídeo externa (YouTube, Facebook,
 * direct mp4, etc.) e retorna o stream do vídeo binário.
 *
 * Estratégia YouTube:
 *  1. Scraping do ytInitialPlayerResponse da página watch (mais resiliente a bloqueios por IP).
 *  2. Fallback via youtubei.js Innertube.
 *
 * Body: { url: string }
 */

import { NextResponse } from 'next/server';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { verificarSessao } from '@/lib/nexo/auth-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DIRECT_FILE_RE = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
const YOUTUBE_HOST_RE = /(?:^|\.)youtube\.com$|(?:^|\.)youtu\.be$/i;
const FACEBOOK_HOST_RE = /(?:^|\.)facebook\.com$|(?:^|\.)fb\.watch$/i;
const INSTAGRAM_HOST_RE = /(?:^|\.)instagram\.com$/i;

/**
 * Cookies de uma sessão real do YouTube — necessários para bypassar o
 * desafio "confirme que você não é um bot" disparado em IPs de datacenter
 * (GCP/Cloud Run). Definir via Secret Manager:
 *   firebase apphosting:secrets:set YOUTUBE_COOKIE
 * O valor deve ser a string completa de cookies (formato: "k1=v1; k2=v2; ...").
 */
function getYouTubeCookie(): string | undefined {
  const c = process.env.YOUTUBE_COOKIE?.trim();
  return c && c.length > 0 ? c : undefined;
}

/** Verdadeiro se o IP é loopback/privado/link-local (incl. metadata GCP 169.254.169.254). */
function ipIsPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local + metadata server
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.split(':').pop();
    if (v4 && isIP(v4) === 4) return ipIsPrivate(v4);
  }
  return false;
}

/**
 * Anti-SSRF: rejeita protocolos não-http(s), hosts de metadata conhecidos e
 * qualquer URL cujo host resolva (via DNS) para um IP de rede interna. Chamado
 * antes de cada fetch de URL controlada pelo usuário.
 */
async function assertSafePublicUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('URL inválida.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Protocolo não permitido.');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'metadata.google.internal' || host === 'metadata' || host === 'localhost') {
    throw new Error('Host bloqueado.');
  }
  const targets: string[] = [];
  if (isIP(host)) {
    targets.push(host);
  } else {
    const records = await lookup(host, { all: true });
    for (const r of records) targets.push(r.address);
  }
  for (const ip of targets) {
    if (ipIsPrivate(ip)) {
      throw new Error('Destino aponta para rede interna — bloqueado.');
    }
  }
}

interface ImportRequest {
  url: string;
}

function extractVideoId(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    if (url.hostname.endsWith('youtu.be')) {
      return url.pathname.slice(1).split('/')[0] ?? null;
    }
    return (
      url.searchParams.get('v') ??
      url.pathname.match(/\/(?:shorts|embed|v)\/([^/?#]+)/)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}

/**
 * Extrai URL de streaming diretamente do ytInitialPlayerResponse embutido
 * na página HTML do YouTube. Mais resiliente a bloqueios de IP do que a
 * API Innertube, pois é uma requisição de página web comum.
 */
async function extractYouTubeFromHtml(videoId: string): Promise<string | null> {
  const cookie = getYouTubeCookie();
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`YouTube watch page retornou HTTP ${res.status}`);

  const html = await res.text();

  // Tenta extrair ytInitialPlayerResponse de diferentes padrões de script
  let playerJson: string | null = null;
  const patterns = [
    /ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});\s*(?:var |<\/script)/,
    /ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) { playerJson = m[1]; break; }
  }
  if (!playerJson) {
    throw new Error('ytInitialPlayerResponse não encontrado na página. Vídeo pode ser privado ou removido.');
  }

  let pr: Record<string, unknown>;
  try {
    pr = JSON.parse(playerJson);
  } catch {
    throw new Error('Falha ao parsear ytInitialPlayerResponse');
  }

  const sd = pr.streamingData as Record<string, unknown> | undefined;
  if (!sd) {
    // playabilityStatus pode conter o motivo real
    const ps = pr.playabilityStatus as Record<string, unknown> | undefined;
    const reason = (ps?.reason as string) ?? 'streamingData ausente';
    throw new Error(`YouTube não retornou streaming data: ${reason}`);
  }

  type YtFmt = { mimeType?: string; height?: number; url?: string; signatureCipher?: string };
  const formats: YtFmt[] = [
    ...((sd.formats as YtFmt[]) ?? []),
    ...((sd.adaptiveFormats as YtFmt[]) ?? []),
  ];

  // Formatos muxed com URL direta (sem signatureCipher) — áudio+vídeo combinados
  const directMp4 = formats.find((f) => f.mimeType?.includes('mp4') && f.url && !f.signatureCipher);
  if (directMp4?.url) return directMp4.url;

  // Qualquer URL direta, independente de mime
  const anyDirect = formats.find((f) => f.url && !f.signatureCipher);
  if (anyDirect?.url) return anyDirect.url;

  throw new Error(
    `YouTube retornou ${formats.length} formato(s) mas nenhum com URL direta (todos cifrados). Tente yt-dlp.`,
  );
}

/**
 * Fallback via youtubei.js Innertube — menos resiliente a IPs de datacenter,
 * mas tenta formatos que precisam de decipher.
 */
async function extractYouTubeViaInnertube(videoId: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('youtubei.js' as never).catch(() => null);
  if (!mod?.Innertube) return null;

  const cookie = getYouTubeCookie();
  const yt = await mod.Innertube.create({
    generate_session_locally: true,
    ...(cookie ? { cookie } : {}),
  });
  const info = await yt.getBasicInfo(videoId);

  type YtFormat = {
    mime_type?: string;
    height?: number;
    decipher?: (player: unknown) => Promise<string>;
    url?: string;
  };
  const formats: YtFormat[] = [
    ...((info.streaming_data?.formats ?? []) as YtFormat[]),
    ...((info.streaming_data?.adaptive_formats ?? []) as YtFormat[]),
  ];
  if (formats.length === 0) return null;

  const mp4WithUrl = formats.find((f) => f.mime_type?.includes('mp4') && f.url);
  if (mp4WithUrl?.url) return mp4WithUrl.url;

  const sorted = [...formats]
    .filter((f) => f.mime_type?.includes('mp4'))
    .sort((a, b) => {
      const score = (h: number) => (h <= 480 ? h : 480 - (h - 480));
      return score(b.height ?? 0) - score(a.height ?? 0);
    });
  const chosen = sorted[0] ?? formats[0];
  if (!chosen) return null;
  if (chosen.decipher) return await chosen.decipher(yt.session.player);
  return chosen.url ?? null;
}

async function extractYouTubeDirect(pageUrl: string): Promise<string> {
  const videoId = extractVideoId(pageUrl);
  if (!videoId) throw new Error(`Não conseguiu extrair video ID de: ${pageUrl}`);

  // 1. Scraping HTML (mais resiliente a bloqueios de IP)
  let htmlError: string | null = null;
  try {
    const url = await extractYouTubeFromHtml(videoId);
    if (url) return url;
  } catch (e) {
    htmlError = e instanceof Error ? e.message : String(e);
    console.warn('[YT/html] falhou:', htmlError);
  }

  // 2. Fallback Innertube
  try {
    const url = await extractYouTubeViaInnertube(videoId);
    if (url) return url;
  } catch (e) {
    const innerErr = e instanceof Error ? e.message : String(e);
    console.warn('[YT/innertube] falhou:', innerErr);
    throw new Error(`Ambas as estratégias falharam. HTML: ${htmlError ?? 'sem URL direta'}. Innertube: ${innerErr}`);
  }

  throw new Error(
    `Não foi possível obter URL para videoId=${videoId}. HTML: ${htmlError ?? 'sem URL direta'}.`,
  );
}

async function extractInstagramDirect(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const og = html.match(
      /<meta\s+(?:property|name)="og:video(?::url|:secure_url)?"\s+content="([^"]+)"/i,
    );
    if (og?.[1]) return og[1].replace(/&amp;/g, '&');
    const videoUrl = html.match(/"video_url"\s*:\s*"([^"]+)"/);
    if (videoUrl?.[1]) return JSON.parse(`"${videoUrl[1]}"`);
    return null;
  } catch {
    return null;
  }
}

async function extractFacebookDirect(pageUrl: string): Promise<string | null> {
  try {
    // Tenta também a versão mbasic (mobile-basic) que ainda serve HTML simples sem JS pesado
    const candidates = [pageUrl];
    try {
      const u = new URL(pageUrl);
      if (u.hostname === 'www.facebook.com' || u.hostname === 'facebook.com') {
        const m = new URL(pageUrl);
        m.hostname = 'mbasic.facebook.com';
        candidates.push(m.toString());
      }
    } catch { /* ignore */ }

    for (const url of candidates) {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 10; SAMSUNG SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36',
          Accept: 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const html = await res.text();

      // Padrões modernos e legados — testa todos antes de desistir.
      const patterns: RegExp[] = [
        /"hd_src"\s*:\s*"([^"]+)"/,
        /"sd_src"\s*:\s*"([^"]+)"/,
        /"playable_url_quality_hd"\s*:\s*"([^"]+)"/,
        /"playable_url"\s*:\s*"([^"]+)"/,
        /"browser_native_(?:hd|sd)_url"\s*:\s*"([^"]+)"/,
        /<meta\s+(?:property|name)="og:video(?::url|:secure_url)?"\s+content="([^"]+)"/i,
      ];
      for (const re of patterns) {
        const m = html.match(re);
        if (m?.[1]) {
          try {
            return m[1].includes('\\') ? JSON.parse(`"${m[1]}"`) : m[1].replace(/&amp;/g, '&');
          } catch {
            return m[1];
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  // Exige sessão Firebase válida (ID token + perfil ativo). Sem isto a rota era
  // um proxy aberto a qualquer um — abuso de custo e vetor de SSRF.
  const sessao = await verificarSessao(req);
  if (!sessao.ok) {
    const error =
      sessao.status === 403
        ? 'Conta sem acesso a este recurso.'
        : sessao.status === 502
        ? 'Verificador de sessão indisponível. Tente novamente.'
        : 'Autenticação necessária.';
    return NextResponse.json({ error }, { status: sessao.status });
  }

  let body: ImportRequest;
  try {
    body = (await req.json()) as ImportRequest;
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const rawUrl = (body?.url ?? '').trim();
  if (!rawUrl) {
    return NextResponse.json({ error: 'URL ausente' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: 'URL inválida' }, { status: 400 });
  }

  // 1) Arquivo direto.
  if (DIRECT_FILE_RE.test(parsed.pathname)) {
    return streamRemoteAsVideo(rawUrl);
  }

  // 2) Facebook público.
  if (FACEBOOK_HOST_RE.test(parsed.hostname)) {
    const direct = await extractFacebookDirect(rawUrl);
    if (!direct) {
      return NextResponse.json(
        {
          error:
            'Não foi possível localizar o vídeo direto no Facebook. ' +
            'Links do tipo facebook.com/share/v/ requerem login para acesso direto. ' +
            'Tente usar o link da publicação original (não o link de compartilhamento) ' +
            'ou "Copiar URL do vídeo" no menu do próprio vídeo.',
        },
        { status: 422 },
      );
    }
    return streamRemoteAsVideo(direct);
  }

  // 2b) Instagram público (post/reel).
  if (INSTAGRAM_HOST_RE.test(parsed.hostname)) {
    const direct = await extractInstagramDirect(rawUrl);
    if (!direct) {
      return NextResponse.json(
        {
          error:
            'Não foi possível localizar o vídeo direto no Instagram. Pode ser um post privado ou conteúdo bloqueado por login.',
        },
        { status: 422 },
      );
    }
    return streamRemoteAsVideo(direct);
  }

  // 3) YouTube — scraping HTML + fallback Innertube.
  if (YOUTUBE_HOST_RE.test(parsed.hostname)) {
    try {
      const direct = await extractYouTubeDirect(rawUrl);
      return streamRemoteAsVideo(direct);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'erro desconhecido';
      console.error('[YT] extração falhou:', message);
      return NextResponse.json(
        {
          error: 'Não foi possível extrair o vídeo do YouTube.',
          details: message,
        },
        { status: 422 },
      );
    }
  }

  // 4) Fallback genérico: tenta como direct file.
  return streamRemoteAsVideo(rawUrl);
}

async function streamRemoteAsVideo(remoteUrl: string): Promise<Response> {
  try {
    await assertSafePublicUrl(remoteUrl);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'URL não permitida.' },
      { status: 403 },
    );
  }
  try {
    let isGoogleVideo = false;
    try {
      const h = new URL(remoteUrl).hostname;
      isGoogleVideo = h === 'googlevideo.com' || h.endsWith('.googlevideo.com');
    } catch {
      isGoogleVideo = false;
    }
    const cookie = isGoogleVideo ? getYouTubeCookie() : undefined;
    const res = await fetch(remoteUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'video/*,*/*;q=0.9',
        ...(isGoogleVideo
          ? {
              Referer: 'https://www.youtube.com/',
              Origin: 'https://www.youtube.com',
            }
          : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(1800000), // 30 min — alinhado ao timeout do Cloud Run
    });
    if (!res.ok || !res.body) {
      return NextResponse.json(
        { error: `Falha ao baixar: HTTP ${res.status}` },
        { status: 502 },
      );
    }
    const ct = res.headers.get('content-type') ?? 'video/mp4';
    if (!ct.startsWith('video/') && !ct.includes('octet-stream')) {
      return NextResponse.json(
        {
          error: `Resposta não é vídeo (Content-Type: ${ct}). URL pode estar protegida ou inválida.`,
        },
        { status: 422 },
      );
    }
    const cl = res.headers.get('content-length');

    // Pequenos (<50MB) → buffer total + Content-Length explícito. Mais robusto
    // que streaming através do front-end do Cloud Run (que pode dropar QUIC).
    const cnum = cl ? Number.parseInt(cl, 10) : NaN;
    if (Number.isFinite(cnum) && cnum > 0 && cnum < 50 * 1024 * 1024) {
      const buf = await res.arrayBuffer();
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': ct,
          'Content-Length': String(buf.byteLength),
          'Cache-Control': 'private, no-store',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // Grandes ou tamanho desconhecido → streaming via TransformStream com
    // X-Accel-Buffering: no para evitar buffering em proxies intermediários.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    res.body.pipeTo(writable).catch((e) => {
      console.error('[streamRemoteAsVideo] pipe error:', e);
    });
    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': ct,
        ...(cl ? { 'Content-Length': cl } : {}),
        'Cache-Control': 'private, no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    return NextResponse.json({ error: 'Falha na requisição', details: message }, { status: 502 });
  }
}
