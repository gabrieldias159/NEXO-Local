/**
 * GET /api/nexo/fornecedor/{cnpj}
 *
 * Enriquece um CNPJ: dados cadastrais (BrasilAPI), checagem de inidôneos
 * (CEIS/CNEP) e as flags de risco derivadas.
 */
import { NextResponse } from 'next/server';
import { getCnpj, getSancoes, type CnpjInfo } from '@/lib/nexo/sources/cnpj';
import { computarFlagsFornecedor, type FornecedorFlag } from '@/lib/nexo/fornecedor-flags';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';

export const runtime = 'nodejs';
export const revalidate = 86400;

/** Uma sanção detalhada (de `nexo_sancoes`, coletada da CGU). */
export interface SancaoRegistro {
  /** CEIS | CNEP | CEPIM. */
  cadastro: string;
  tipoSancao: string;
  orgaoSancionador: string;
  fundamentacao: string;
  dataInicio: string | null;
  dataFim: string | null;
  nomeSancionado: string;
}

/** Detalhe das sanções já ingeridas (nexo_sancoes) — qual/onde/fonte/quando. */
export interface SancoesDetalhe {
  sancionado: boolean;
  qtdSancoes: number;
  cadastros: string[];
  registros: SancaoRegistro[];
  /** Fonte/origem dos dados (para citação). */
  fonte: string;
  verificadoEm: string | null;
}

export interface FornecedorResponse {
  cnpj: string;
  info: CnpjInfo | null;
  sancoes: { verificado: boolean; ceis: number; cnep: number };
  /** Sanções DETALHADAS do nexo_sancoes (preferir a esta sobre a checagem live). */
  sancoesDetalhe: SancoesDetalhe | null;
  flags: FornecedorFlag[];
  erro: string | null;
  atualizadoEm: string;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ cnpj: string }> },
) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json({ erro: 'acesso negado ao NEXO' }, { status: sessao.status });
  }
  const idToken = sessao.idToken;

  const { cnpj: cnpjParam } = await params;
  const cnpj = String(cnpjParam ?? '').replace(/\D/g, '');

  // getCnpj não lança mais (degrada para null); erroUpstream fica para casos extremos.
  let info: CnpjInfo | null = null;
  let erroUpstream: string | null = null;
  try {
    info = await getCnpj(cnpj);
  } catch (err) {
    erroUpstream = err instanceof Error ? err.message : 'falha ao consultar dados cadastrais';
  }

  // Sanções DETALHADAS já coletadas (nexo_sancoes, CGU). É a fonte rica:
  // qual cadastro, órgão sancionador, fundamentação e período. Degrada honesto.
  let sancoesDetalhe: SancoesDetalhe | null = null;
  try {
    const docs = await lerColecaoNexo('nexo_sancoes', { cnpj }, idToken);
    const d = docs[0];
    if (d) {
      const registros = Array.isArray(d.sancoes)
        ? (d.sancoes as Record<string, unknown>[]).map((s) => ({
            cadastro: String(s.cadastro ?? ''),
            tipoSancao: String(s.tipoSancao ?? ''),
            orgaoSancionador: String(s.orgaoSancionador ?? ''),
            fundamentacao: String(s.fundamentacao ?? ''),
            dataInicio: (s.dataInicio as string) ?? null,
            dataFim: (s.dataFim as string) ?? null,
            nomeSancionado: String(s.nomeSancionado ?? ''),
          }))
        : [];
      sancoesDetalhe = {
        sancionado: d.sancionado === true,
        qtdSancoes: Number(d.qtdSancoes) || registros.length,
        cadastros: Array.isArray(d.cadastros) ? (d.cadastros as unknown[]).map(String) : [],
        registros,
        fonte: 'CGU — Portal da Transparência Federal (CEIS/CNEP/CEPIM)',
        verificadoEm: typeof d._verificadoEm === 'string' ? d._verificadoEm : null,
      };
    }
  } catch {
    /* nexo_sancoes indisponível — segue sem o detalhe (checagem live abaixo). */
  }

  const sancoes = await getSancoes(cnpj);
  const flags = info
    ? computarFlagsFornecedor(info, sancoes.verificado ? sancoes : undefined)
    : [];

  const response: FornecedorResponse = {
    cnpj,
    info,
    sancoes: { verificado: sancoes.verificado, ceis: sancoes.ceis, cnep: sancoes.cnep },
    sancoesDetalhe,
    flags,
    erro: erroUpstream ?? (info ? null : 'CNPJ não encontrado nas bases cadastrais (BrasilAPI/minhareceita).'),
    atualizadoEm: new Date().toISOString(),
  };

  // Falha de fonte externa não pode ser cacheada como resultado válido.
  if (erroUpstream) {
    return NextResponse.json(response, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'private, max-age=43200',
    },
  });
}
