/**
 * GET /api/nexo/fornecedor-campanha?cnpj=NN — o CNPJ prestou serviço a
 * campanhas eleitorais? Lê `nexo_fornecedores_campanha` (agregados do TSE por
 * fornecedor×candidato×ano — ver docs/spec-fornecedores-campanha.md e a coleta
 * `onNexoBackfillTseDespesasHttp`).
 *
 * ENQUADRAMENTO: prestar serviço a campanha é lícito e público (Lei 9.504/97).
 * A resposta é INSUMO de conferência cruzada — vínculo a apurar, nunca acusação.
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';

export const runtime = 'nodejs';

const headersCache = { 'Cache-Control': 'private, max-age=300' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

export interface CampanhaFornecida {
  ano: number;
  candidato: string;
  partido: string;
  cargo: string;
  municipio: string;
  valorTotal: number;
  nDespesas: number;
}

export interface FornecedorCampanhaResponse {
  cnpj: string;
  campanhas: CampanhaFornecida[];
  totalGeral: number;
  /** Cobertura honesta do dado: anos/UF que a coleta abrange hoje. */
  cobertura: string;
  /** 'pendente' = coleção vazia (backfill do TSE ainda não rodou). */
  ingestao: { status: 'ok' | 'pendente' };
  atualizadoEm: string;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: headersNoStore },
    );
  }
  try {
    const { searchParams } = new URL(req.url);
    const cnpj = (searchParams.get('cnpj') ?? '').replace(/\D/g, '');
    // Alternativa p/ PESSOA FÍSICA (fase 2): lookup pelo hash irreversível do
    // documento (mesmo `docHash` do grafo/raio-x) — CPF NUNCA trafega cru.
    const docHash = (searchParams.get('docHash') ?? '').trim();
    if (cnpj.length !== 14 && !docHash) {
      return NextResponse.json(
        { erro: 'informe cnpj (14 dígitos) ou docHash' },
        { status: 400, headers: headersNoStore },
      );
    }

    const docs = await lerColecaoNexo(
      'nexo_fornecedores_campanha',
      cnpj.length === 14 ? { cnpj } : { igual: { campo: 'docHash', valor: docHash } },
      sessao.idToken,
    );

    // A coleção pode estar vazia por falta de backfill — distinguir de "sem
    // match" exige uma sondagem barata (1 doc qualquer da coleção).
    let temColecao = docs.length > 0;
    if (!temColecao) {
      const sonda = await lerColecaoNexo(
        'nexo_fornecedores_campanha',
        { limit: 1 },
        sessao.idToken,
        ['ano'],
      );
      temColecao = sonda.length > 0;
    }

    const campanhas: CampanhaFornecida[] = docs
      .map((d) => ({
        ano: Number(d.ano) || 0,
        candidato: String(d.candidato ?? ''),
        partido: String(d.partido ?? ''),
        cargo: String(d.cargo ?? ''),
        municipio: String(d.municipio ?? ''),
        valorTotal: Number(d.valorTotal) || 0,
        nDespesas: Number(d.nDespesas) || 0,
      }))
      .sort((a, b) => b.ano - a.ano || b.valorTotal - a.valorTotal);

    const resp: FornecedorCampanhaResponse = {
      cnpj,
      campanhas,
      totalGeral: campanhas.reduce((s, c) => s + c.valorTotal, 0),
      cobertura: 'Eleições 2020, 2022 e 2024 — SP (fornecedores PJ e PF)',
      ingestao: { status: temColecao ? 'ok' : 'pendente' },
      atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(resp, { headers: headersCache });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erro ao cruzar campanhas';
    return NextResponse.json({ erro: msg }, { status: 500, headers: headersNoStore });
  }
}
