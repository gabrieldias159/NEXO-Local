/**
 * GET /api/nexo/pessoa-conexoes?nome=<NOME>
 *
 * A ROTA AGREGADORA da ficha de pessoa física (item 1 do plano de
 * docs/nexo-perfilamento-auditoria.md): dado um NOME, funde numa resposta só
 * tudo que as coleções do NEXO sabem sobre a pessoa:
 *  - empresas onde aparece como SÓCIA (QSA de `nexo_socios`) enriquecidas com
 *    os agregados de `nexo_entidades` (empenhos/contratos/sanções da empresa);
 *  - agregado como fornecedora PF (nexo_entidades tipo=pessoa);
 *  - FOLHA de pagamento (`nexo_pagamentos`): cargo/lotação se é servidora;
 *  - diárias e passagens (`nexo_diarias`/`nexo_passagens`): n, total, últimas;
 *  - atos de pessoal no DOM (`nexo_nomeacoes`): nomeações/exonerações;
 *  - contas irregulares TCE-SP Ficha Limpa (`nexo_contas_irregulares`).
 *
 * Join por NOME NORMALIZADO (fontes públicas mascaram CPF) — homônimos são
 * possíveis e a UI rotula. Leitura no padrão do /api/nexo/busca: varredura
 * limitada em memória, sem índice novo, nunca expõe documento cru.
 */
import { createHash } from 'node:crypto';

import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo, lerDocNexo } from '@/lib/nexo/firestore-read';
import { normalizarNome, cnpjRaiz, soDigitos } from '@/lib/nexo/entidades';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIMITE_LEITURA = 4000;

export interface EmpresaDeSocio {
  cnpj: string;
  razaoSocial: string | null;
  qualificacao: string | null;
  cpfMasc: string | null;
  /** Agregados da empresa junto à prefeitura (nexo_entidades), se houver. */
  totalEmpenhado: number;
  nEmpenhos: number;
  nContratos: number;
  contratosAtivos: number;
  sancionado: boolean;
  nSancoes: number;
  flags: string[];
}

export interface RegistroFolha {
  cargo: string | null;
  lotacao: string | null;
  exercicio: number;
}
export interface ResumoDiarias {
  n: number;
  total: number;
  ultimas: { data: string | null; valor: number; tipo: 'diária' | 'passagem' }[];
}
export interface AtoPessoalDom {
  tipo: string | null;
  cargo: string | null;
  secretaria: string | null;
  ato: string | null;
  trecho: string | null;
  data: string | null;
  urlPdf: string | null;
}
export interface ContaIrregular {
  processoTC: string | null;
  exercicio: string | null;
  origem: string | null;
  materia: string | null;
  transitoJulgado: string | null;
  cpfParcial: string | null;
}

export interface PessoaConexoesResponse {
  nome: string;
  /** Empresas em que a pessoa é sócia (match exato por nome normalizado). */
  empresas: EmpresaDeSocio[];
  /** Agregado da própria pessoa como fornecedora PF, se existir. */
  fornecedorPF: {
    documento: string | null;
    totalEmpenhado: number;
    nEmpenhos: number;
    nContratos: number;
    sancionado: boolean;
    flags: string[];
  } | null;
  /** Folha de pagamento municipal — presença como servidor(a). */
  folha: RegistroFolha | null;
  /** Diárias + passagens recebidas (beneficiário). */
  diarias: ResumoDiarias | null;
  /** Atos de pessoal no Diário Oficial (nomeação/exoneração/designação). */
  nomeacoes: AtoPessoalDom[];
  /** TCE-SP Ficha Limpa — contas julgadas irregulares (match por nome!). */
  contasIrregulares: ContaIrregular[];
  /**
   * Retrato materializado pelo cron `cruzamento-pessoas` (nexo_pessoas_
   * cruzamento) — inclui joins por chaveFraca (nome+cpf6), mais fortes que os
   * por nome desta rota. Null enquanto o cron não cobriu a pessoa.
   */
  materializado: Record<string, unknown> | null;
  disponivel: boolean;
  motivo: string | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json({ erro: 'acesso negado ao NEXO' }, { status: sessao.status });
  }
  const idToken = sessao.idToken;

  const url = new URL(req.url);
  const nomeParam = (url.searchParams.get('nome') ?? '').trim();
  if (!nomeParam || nomeParam.length < 5) {
    return NextResponse.json({ erro: 'informe ?nome= (mínimo 5 caracteres)' }, { status: 400 });
  }
  const alvo = normalizarNome(nomeParam);

  try {
    const anoAtual = new Date().getFullYear();
    // fast-path materializado: mesmo sha256 puro do personId usado pelo cron
    // cruzamento-pessoas (docIdDePessoa em functions/src/nexo/cruzamento-pessoas.ts)
    const personId = `n:${alvo}`;
    const docIdMat = createHash('sha256').update(personId).digest('hex');
    // leituras independentes em paralelo (todas limitadas e projetadas)
    const [materializado, sociosDocs, entidades, folhaDocs, diariasDocs, passagensDocs, nomeacoesDocs, contasDocs] =
      await Promise.all([
        lerDocNexo(`nexo_pessoas_cruzamento/${docIdMat}`, idToken).catch(() => null),
        lerColecaoNexo('nexo_socios', { limit: LIMITE_LEITURA }, idToken, ['_cnpj', 'razaoSocial', 'socios', 'temQsa']),
        lerColecaoNexo('nexo_entidades', { limit: LIMITE_LEITURA }, idToken, [
          'tipo', 'nome', 'doc', 'totalEmpenhado', 'nEmpenhos', 'nContratos', 'contratosAtivos', 'sancionado', 'nSancoes', 'flags',
        ]),
        lerColecaoNexo('nexo_pagamentos', { exercicio: anoAtual, fonte: 'pagamentos', limit: LIMITE_LEITURA }, idToken, [
          'NomeServidor', 'Nome', 'NomeFornecedor', 'CargoFuncao', 'Cargo', 'Funcao', 'Lotacao', 'Secretaria', 'Mes',
        ]).catch(() => [] as Record<string, unknown>[]),
        lerColecaoNexo('nexo_diarias', { limit: LIMITE_LEITURA }, idToken, [
          'NomeFornecedor', 'Beneficiario', 'NomeServidor', 'ValorEmpenhado', 'ValorEmpenho', 'DataEmp', 'DataEmpenho', 'Data',
        ]).catch(() => [] as Record<string, unknown>[]),
        lerColecaoNexo('nexo_passagens', { limit: LIMITE_LEITURA }, idToken, [
          'NomeFornecedor', 'Beneficiario', 'NomeServidor', 'ValorEmpenhado', 'ValorEmpenho', 'DataEmp', 'DataEmpenho', 'Data',
        ]).catch(() => [] as Record<string, unknown>[]),
        lerColecaoNexo('nexo_nomeacoes', { limit: 1000 }, idToken, [
          'tipo', 'nome', 'nomeNorm', 'cargo', 'secretaria', 'ato', 'trecho', 'data', 'urlPdf',
        ]).catch(() => [] as Record<string, unknown>[]),
        lerColecaoNexo('nexo_contas_irregulares', { limit: 1000 }, idToken, [
          'nome', 'nomeNorm', 'cpfParcial', 'processoTC', 'exercicio', 'origem', 'materia', 'transitoJulgado',
        ]).catch(() => [] as Record<string, unknown>[]),
      ]);
    const empresasBrutas: { cnpj: string; razaoSocial: string | null; qualificacao: string | null; cpfMasc: string | null }[] = [];
    for (const d of sociosDocs) {
      const socios = Array.isArray(d.socios) ? (d.socios as Record<string, unknown>[]) : [];
      for (const s of socios) {
        if (normalizarNome(str(s.nome) ?? '') !== alvo) continue;
        const cnpj = soDigitos(str(d._cnpj) ?? '');
        if (!cnpj) continue;
        empresasBrutas.push({
          cnpj,
          razaoSocial: str(d.razaoSocial),
          qualificacao: str(s.qualificacao),
          cpfMasc: str(s.cpfMasc),
        });
        break; // a pessoa só entra 1x por empresa
      }
    }

    // 2) agregados: nexo_entidades em memória, indexado por raiz do documento
    const porRaiz = new Map<string, Record<string, unknown>>();
    let fornecedorPF: PessoaConexoesResponse['fornecedorPF'] = null;
    for (const e of entidades) {
      const doc = soDigitos(str(e.doc) ?? '');
      if (doc.length === 14) porRaiz.set(cnpjRaiz(doc), e);
      if (
        e.tipo === 'pessoa' &&
        !fornecedorPF &&
        normalizarNome(str(e.nome) ?? '') === alvo
      ) {
        fornecedorPF = {
          documento: str(e.doc),
          totalEmpenhado: num(e.totalEmpenhado),
          nEmpenhos: num(e.nEmpenhos),
          nContratos: num(e.nContratos),
          sancionado: e.sancionado === true,
          flags: Array.isArray(e.flags) ? (e.flags as string[]) : [],
        };
      }
    }

    const empresas: EmpresaDeSocio[] = empresasBrutas.map((b) => {
      const ag = porRaiz.get(cnpjRaiz(b.cnpj));
      return {
        ...b,
        totalEmpenhado: num(ag?.totalEmpenhado),
        nEmpenhos: num(ag?.nEmpenhos),
        nContratos: num(ag?.nContratos),
        contratosAtivos: num(ag?.contratosAtivos),
        sancionado: ag?.sancionado === true,
        nSancoes: num(ag?.nSancoes),
        flags: Array.isArray(ag?.flags) ? (ag!.flags as string[]) : [],
      };
    });
    // empresas com dinheiro público primeiro
    empresas.sort((a, b) => b.totalEmpenhado - a.totalEmpenhado);

    // 3) FOLHA: registro mais recente do servidor com este nome
    let folha: PessoaConexoesResponse['folha'] = null;
    let mesMax = -1;
    for (const d of folhaDocs) {
      const n = str(d.NomeServidor) ?? str(d.Nome) ?? str(d.NomeFornecedor);
      if (!n || normalizarNome(n) !== alvo) continue;
      const mes = Number(d.Mes) || 0;
      if (mes <= mesMax) continue;
      mesMax = mes;
      folha = {
        cargo: str(d.CargoFuncao) ?? str(d.Cargo),
        lotacao: str(d.Funcao) ?? str(d.Lotacao) ?? str(d.Secretaria),
        exercicio: anoAtual,
      };
    }

    // 4) DIÁRIAS + PASSAGENS: beneficiário com este nome
    const movs: { data: string | null; valor: number; tipo: 'diária' | 'passagem' }[] = [];
    const varre = (docs: Record<string, unknown>[], tipo: 'diária' | 'passagem') => {
      for (const d of docs) {
        const n = str(d.NomeFornecedor) ?? str(d.Beneficiario) ?? str(d.NomeServidor);
        if (!n || normalizarNome(n) !== alvo) continue;
        movs.push({
          data: str(d.DataEmp) ?? str(d.DataEmpenho) ?? str(d.Data),
          valor: num(d.ValorEmpenhado) || num(d.ValorEmpenho),
          tipo,
        });
      }
    };
    varre(diariasDocs, 'diária');
    varre(passagensDocs, 'passagem');
    movs.sort((a, b) => String(b.data ?? '').localeCompare(String(a.data ?? '')));
    const diarias: PessoaConexoesResponse['diarias'] = movs.length
      ? { n: movs.length, total: Math.round(movs.reduce((s, m) => s + m.valor, 0) * 100) / 100, ultimas: movs.slice(0, 8) }
      : null;

    // 5) ATOS DE PESSOAL no DOM
    const nomeacoes: AtoPessoalDom[] = nomeacoesDocs
      .filter((d) => normalizarNome(str(d.nome) ?? str(d.nomeNorm) ?? '') === alvo)
      .map((d) => ({
        tipo: str(d.tipo),
        cargo: str(d.cargo),
        secretaria: str(d.secretaria),
        ato: str(d.ato),
        trecho: str(d.trecho),
        data: str(d.data),
        urlPdf: str(d.urlPdf),
      }))
      .sort((a, b) => String(b.data ?? '').localeCompare(String(a.data ?? '')))
      .slice(0, 12);

    // 6) TCE Ficha Limpa — contas irregulares (match por NOME, corroborar por cpfParcial)
    const contasIrregulares: ContaIrregular[] = contasDocs
      .filter((d) => normalizarNome(str(d.nome) ?? str(d.nomeNorm) ?? '') === alvo)
      .map((d) => ({
        processoTC: str(d.processoTC),
        exercicio: str(d.exercicio),
        origem: str(d.origem),
        materia: str(d.materia),
        transitoJulgado: str(d.transitoJulgado),
        cpfParcial: str(d.cpfParcial),
      }))
      .slice(0, 12);

    const resp: PessoaConexoesResponse = {
      nome: nomeParam,
      empresas,
      fornecedorPF,
      folha,
      diarias,
      nomeacoes,
      contasIrregulares,
      materializado,
      disponivel: true,
      motivo: null,
    };
    return NextResponse.json(resp);
  } catch (err) {
    const resp: PessoaConexoesResponse = {
      nome: nomeParam,
      empresas: [],
      fornecedorPF: null,
      folha: null,
      diarias: null,
      nomeacoes: [],
      contasIrregulares: [],
      materializado: null,
      disponivel: false,
      motivo: err instanceof Error ? err.message : 'falha ao consultar conexões',
    };
    return NextResponse.json(resp, { status: 200 });
  }
}
