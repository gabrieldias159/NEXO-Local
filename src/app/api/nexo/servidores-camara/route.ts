/**
 * GET /api/nexo/servidores-camara — relação de servidores (ATIVOS e
 * DESLIGADOS) da CÂMARA Municipal de Marília.
 *
 * Fonte: o próprio portal de transparência da Câmara publica a relação como uma
 * planilha Google Sheets (CSV público) — a mesma que alimenta o relatório em
 * https://cm-marilia.github.io/website/funcionarios.html. É pública, sem
 * geo-bloqueio nem auth, então o servidor busca direto e cacheia (não precisa de
 * cron/coleta). Colunas: nome_func, cargo, lotacao, data_admissao,
 * data_demissao (vazio = ATIVO), jornada. Mantida SEPARADA da folha da
 * Prefeitura (SMARAPD) — cada servidor rotulado com o órgão de origem.
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';

export const runtime = 'nodejs';
// Cache de 6h: a planilha muda raramente e é a mesma p/ todos os usuários.
export const revalidate = 21600;

const CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vREQz2WgS7eshAd2iP8ln0Wz716a6crFuPkwbyYs5jtEq8Ifv1XynH4ou0xv--TQFm8UPm8Nvro5JNt/pub?output=csv';

export interface ServidorCamara {
  nome: string;
  cargo: string | null;
  lotacao: string | null;
  admissao: string | null;
  demissao: string | null;
  jornada: string | null;
  situacao: 'ativo' | 'desligado';
}
export interface ServidoresCamaraResponse {
  servidores: ServidorCamara[];
  total: number;
  ativos: number;
  desligados: number;
  atualizadoEm: string | null;
  fonte: string;
  erro: string | null;
}

/** Parser de linha CSV (aspas + vírgula dentro de aspas). */
function parseLinhaCsv(linha: string): string[] {
  const out: string[] = [];
  let cur = '';
  let dentro = false;
  for (let i = 0; i < linha.length; i++) {
    const ch = linha[i];
    if (ch === '"') {
      if (dentro && linha[i + 1] === '"') {
        cur += '"';
        i++;
      } else dentro = !dentro;
    } else if (ch === ',' && !dentro) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const limpo = (s: string | undefined): string | null => {
  const t = (s ?? '').trim();
  return t ? t : null;
};

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok) {
    return NextResponse.json({ erro: 'acesso negado ao NEXO' }, { status: sessao.status });
  }

  try {
    const r = await fetch(CSV_URL, { next: { revalidate } });
    if (!r.ok) throw new Error(`planilha respondeu HTTP ${r.status}`);
    const texto = await r.text();
    const linhas = texto.split(/\r?\n/).filter((l) => l.trim().length > 0);

    // 1ª linha = metadado "MODIF_REAL: dd/mm/aaaa, hh:mm:ss"; 2ª = cabeçalho.
    let atualizadoEm: string | null = null;
    const m = linhas[0]?.match(/MODIF_REAL:\s*([^",]+(?:,\s*[\d:]+)?)/i);
    if (m) atualizadoEm = m[1].trim();
    const idxHeader = linhas.findIndex((l) => /nome_func/i.test(l));
    const header = parseLinhaCsv(linhas[idxHeader] ?? '').map((h) => h.trim().toLowerCase());
    const col = (nome: string) => header.indexOf(nome);
    const iNome = col('nome_func');
    const iCargo = col('cargo');
    const iLot = col('lotacao');
    const iAdm = col('data_admissao');
    const iDem = col('data_demissao');
    const iJor = col('jornada');

    const servidores: ServidorCamara[] = [];
    for (const l of linhas.slice(idxHeader + 1)) {
      const f = parseLinhaCsv(l);
      const nome = limpo(f[iNome]);
      if (!nome) continue;
      const demissao = iDem >= 0 ? limpo(f[iDem]) : null;
      servidores.push({
        nome,
        cargo: iCargo >= 0 ? limpo(f[iCargo]) : null,
        lotacao: iLot >= 0 ? limpo(f[iLot]) : null,
        admissao: iAdm >= 0 ? limpo(f[iAdm]) : null,
        demissao,
        jornada: iJor >= 0 ? limpo(f[iJor]) : null,
        situacao: demissao ? 'desligado' : 'ativo',
      });
    }
    servidores.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    const resp: ServidoresCamaraResponse = {
      servidores,
      total: servidores.length,
      ativos: servidores.filter((s) => s.situacao === 'ativo').length,
      desligados: servidores.filter((s) => s.situacao === 'desligado').length,
      atualizadoEm,
      fonte: 'Câmara Municipal de Marília — Portal da Transparência (Relação de Servidores)',
      erro: null,
    };
    return NextResponse.json(resp, { headers: { 'Cache-Control': 'private, max-age=21600' } });
  } catch (err) {
    const resp: ServidoresCamaraResponse = {
      servidores: [],
      total: 0,
      ativos: 0,
      desligados: 0,
      atualizadoEm: null,
      fonte: 'Câmara Municipal de Marília',
      erro: err instanceof Error ? err.message : 'falha ao consultar a relação de servidores',
    };
    return NextResponse.json(resp, { status: 502 });
  }
}
