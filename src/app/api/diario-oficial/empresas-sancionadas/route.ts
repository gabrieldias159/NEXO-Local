/**
 * GET /api/diario-oficial/empresas-sancionadas
 *
 * Retorna a lista de empresas sancionadas/impedidas de contratar com a
 * Prefeitura de Marília, conforme o Portal da Transparência.
 *
 * Fonte: paiportalserver/modulovisao/fixo/secretaria_emprego_trabalho/empresaspunidas
 * Cache: 1 hora (dados raramente mudam)
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const revalidate = 3600;

const PORTAL_URL =
  'https://transparencia.marilia.sp.gov.br/paiportalserver/modulovisao/fixo/secretaria_emprego_trabalho/empresaspunidas';

const FILE_BASE = 'https://transparencia.marilia.sp.gov.br/paifileserver/';

export interface EmpresaSancionada {
  empresa: string;
  portarias: {
    titulo: string;
    pdfUrl: string | null;
  }[];
}

export interface EmpresasSancionadasResponse {
  empresas: EmpresaSancionada[];
  total: number;
  fonte: string;
  atualizadoEm: string | null;
}

async function fetchEmpresasPunidas(): Promise<EmpresaSancionada[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(PORTAL_URL, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'application/json',
        Referer: 'https://transparencia.marilia.sp.gov.br/',
      },
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) return [];

    const raw = await res.text();
    let json: { VisaoItens?: unknown[] };
    try {
      json = JSON.parse(raw) as { VisaoItens?: unknown[] };
    } catch {
      return [];
    }

    const items = (json.VisaoItens ?? []) as Array<{
      title?: string;
      children?: Array<{
        title?: string;
        Arquivo?: { Url?: string; Nome?: string };
      }>;
    }>;

    return items.map((item) => ({
      empresa: (item.title ?? '').trim(),
      portarias: (item.children ?? []).map((child) => ({
        titulo: (child.title ?? '').trim(),
        // O PDF da portaria vive no filemanager do paifileserver. O padrão
        // antigo (FILE_BASE + Url) dava HTTP 404. O endpoint correto (confirmado
        // 200 + %PDF, CORS *, inline) é filemanager/pai/download. Arquivo.Url já
        // vem percent-encoded — passar VERBATIM, sem re-encodar.
        pdfUrl: child.Arquivo?.Url
          ? `${FILE_BASE}filemanager/pai/download?nomeArquivo=${child.Arquivo.Url}&isInlineContent=true`
          : null,
      })),
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') ?? '').trim().toLowerCase();

  const empresas = await fetchEmpresasPunidas();

  const filtered = q
    ? empresas.filter(
        (e) =>
          e.empresa.toLowerCase().includes(q) ||
          e.portarias.some((p) => p.titulo.toLowerCase().includes(q)),
      )
    : empresas;

  const response: EmpresasSancionadasResponse = {
    empresas: filtered,
    total: filtered.length,
    fonte: 'Portal da Transparência — Prefeitura de Marília',
    atualizadoEm: new Date().toISOString(),
  };

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
    },
  });
}
