/**
 * GET /api/nexo/sancoes?exercicio=2026
 *
 * Subsistema SANÇÕES FEDERAIS do NEXO — detector FR-04 (fornecedor inidôneo
 * recebendo recurso público).
 *
 * Fluxo:
 *  1. Coleta os fornecedores da Prefeitura de Marília no exercício, via API
 *     SMARAPD (módulo `fornecedor` / visão `fornecedoranalitico`).
 *  2. Agrega por CNPJ e seleciona os ~20 maiores fornecedores.
 *  3. Cruza cada CNPJ com os cadastros federais de inidôneos (CEIS, CNEP,
 *     CEPIM) via API do Portal da Transparência Federal (CGU).
 *  4. Roda o detector FR-04 e devolve os indícios.
 *
 * A integração com a CGU depende de `PORTAL_TRANSPARENCIA_TOKEN`. Sem o token
 * a rota NÃO falha: responde 200 com `tokenConfigurado: false` e um aviso
 * claro de que a integração precisa do token. Com token presente mas API
 * indisponível, responde erro honesto (`Cache-Control: no-store`).
 *
 * Apenas dados públicos — todo alerta é indício a apurar, não acusação.
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { filterModuloAllPages } from '@/lib/nexo/sources/smarapd';
import { normalizarEmpenhosFornecedor } from '@/lib/nexo/normalizar';
import {
  consultarSancoesLote,
  tokenConfigurado,
} from '@/lib/nexo/sources/sancoes-federais';
import type { SancaoFederal } from '@/lib/nexo/sources/sancoes-federais';
import { analisarSancoes } from '@/lib/nexo/detectores/sancoes-det';
import type { FornecedorMarilia } from '@/lib/nexo/detectores/sancoes-det';
import type { AlertaDetectado } from '@/lib/nexo/detectores/tipos';

export const runtime = 'nodejs';
export const revalidate = 3600;
export const maxDuration = 120;

/** Quantos dos maiores fornecedores cruzar com os cadastros federais. */
const TOP_FORNECEDORES = 20;
/** Teto de páginas da coleta de empenhos — amostra ampla, sem estourar timeout. */
const MAX_PAGINAS_EMPENHOS = 40;

/** Um fornecedor consultado, com o veredito do cruzamento. */
export interface FornecedorSancao {
  cnpj: string;
  nome: string;
  valorEmpenhado: number;
  /** Sanções encontradas (qualquer cadastro), [] quando limpo. */
  sancoes: SancaoFederal[];
  /** true quando há ao menos uma sanção vigente na data de referência. */
  temSancaoVigente: boolean;
}

/** Resposta da rota — exportada para a página importar com `import type`. */
export interface SancoesResponse {
  exercicio: number;
  /** Data ISO usada para aferir vigência das sanções. */
  dataReferencia: string;
  /** false quando PORTAL_TRANSPARENCIA_TOKEN não está configurado. */
  tokenConfigurado: boolean;
  coleta: {
    /** Total de fornecedores distintos coletados do exercício. */
    fornecedoresColetados: number;
    /** Quantos CNPJs foram efetivamente cruzados com a CGU. */
    fornecedoresConsultados: number;
    /** Erro da coleta de empenhos SMARAPD, se houver. */
    erroEmpenhos: string | null;
    /** Erro da consulta de sanções na CGU, se houver. */
    erroSancoes: string | null;
  };
  resumo: {
    fornecedoresComSancao: number;
    fornecedoresComSancaoVigente: number;
    valorEnvolvidoVigente: number;
    alertas: number;
  };
  alertas: AlertaDetectado[];
  /** Os fornecedores consultados, com o resultado do cruzamento. */
  fornecedores: FornecedorSancao[];
  /** Aviso humano quando a integração não pôde rodar plenamente. */
  aviso: string | null;
  atualizadoEm: string;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { searchParams } = new URL(req.url);
  const exercicio =
    Number(searchParams.get('exercicio')) || new Date().getFullYear();
  const dataReferencia = new Date().toISOString().slice(0, 10);

  // ── 1. Coleta de empenhos/fornecedores de Marília (SMARAPD) ────────────────
  let fornecedores: FornecedorMarilia[] = [];
  let erroEmpenhos: string | null = null;
  try {
    const brutos = await filterModuloAllPages(
      {
        chaveModulo: 'fornecedor',
        nomeVisao: 'fornecedoranalitico',
        exercicio,
        periodicidade: 'ANUAL',
      },
      { maxPaginas: MAX_PAGINAS_EMPENHOS, delayMs: 120 },
    );
    const empenhos = normalizarEmpenhosFornecedor(brutos, exercicio);

    // Agrega por CNPJ — somente CNPJ (14 dígitos): sanções federais são de
    // empresas; CPF de pessoa física fica fora (LGPD) e não figura no CEIS PJ.
    const porCnpj = new Map<string, FornecedorMarilia>();
    for (const e of empenhos) {
      if (e.cpfCnpj.length !== 14) continue;
      if (e.valorEmpenhado <= 0) continue;
      const cur = porCnpj.get(e.cpfCnpj);
      if (cur) {
        cur.valorEmpenhado += e.valorEmpenhado;
        if (!cur.nome && e.fornecedorNome) cur.nome = e.fornecedorNome;
      } else {
        porCnpj.set(e.cpfCnpj, {
          cnpj: e.cpfCnpj,
          nome: e.fornecedorNome,
          valorEmpenhado: e.valorEmpenhado,
        });
      }
    }
    fornecedores = Array.from(porCnpj.values()).sort(
      (a, b) => b.valorEmpenhado - a.valorEmpenhado,
    );
  } catch (err) {
    erroEmpenhos = err instanceof Error ? err.message : 'erro desconhecido';
  }

  // Top N maiores fornecedores — o cruzamento é o uso travado: fornecedores
  // de Marília x cadastros federais.
  const topFornecedores = fornecedores.slice(0, TOP_FORNECEDORES);

  // ── 2. Token ausente → estado honesto, sem chamar a CGU ────────────────────
  if (!tokenConfigurado()) {
    const response: SancoesResponse = {
      exercicio,
      dataReferencia,
      tokenConfigurado: false,
      coleta: {
        fornecedoresColetados: fornecedores.length,
        fornecedoresConsultados: 0,
        erroEmpenhos,
        erroSancoes: null,
      },
      resumo: {
        fornecedoresComSancao: 0,
        fornecedoresComSancaoVigente: 0,
        valorEnvolvidoVigente: 0,
        alertas: 0,
      },
      alertas: [],
      fornecedores: topFornecedores.map((f) => ({
        cnpj: f.cnpj,
        nome: f.nome,
        valorEmpenhado: f.valorEmpenhado,
        sancoes: [],
        temSancaoVigente: false,
      })),
      aviso:
        'Integração com os cadastros federais (CEIS/CNEP/CEPIM) inativa: a ' +
        'variável de ambiente PORTAL_TRANSPARENCIA_TOKEN não está configurada. ' +
        'O token é gratuito — cadastre um e-mail em ' +
        'portaldatransparencia.gov.br/api-de-dados/cadastrar-email (login gov.br) ' +
        'e defina PORTAL_TRANSPARENCIA_TOKEN no ambiente do servidor. Os ' +
        'fornecedores de Marília abaixo já foram coletados e estão prontos para ' +
        'o cruzamento assim que o token estiver disponível.',
      atualizadoEm: new Date().toISOString(),
    };
    // 200 — não é erro; é integração pendente de configuração.
    return NextResponse.json(response, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // ── 3. Cruzamento com CEIS/CNEP/CEPIM ──────────────────────────────────────
  const consulta = await consultarSancoesLote(topFornecedores.map((f) => f.cnpj));
  const erroSancoes = consulta.erro;

  // ── 4. Detector FR-04 ──────────────────────────────────────────────────────
  const alertas = analisarSancoes({
    fornecedores: topFornecedores,
    consultas: consulta.resultados,
    dataReferencia,
  });

  const consultaPorCnpj = new Map(
    consulta.resultados.map((r) => [r.cnpj, r]),
  );
  const fornecedoresOut: FornecedorSancao[] = topFornecedores.map((f) => {
    const r = consultaPorCnpj.get(f.cnpj);
    const sancoes = r?.sancoes ?? [];
    const temVigente = sancoes.some((s) => {
      if (s.dataInicio && s.dataInicio > dataReferencia) return false;
      if (s.dataFim && s.dataFim < dataReferencia) return false;
      return true;
    });
    return {
      cnpj: f.cnpj,
      nome: f.nome,
      valorEmpenhado: f.valorEmpenhado,
      sancoes,
      temSancaoVigente: temVigente,
    };
  });

  const comSancao = fornecedoresOut.filter((f) => f.sancoes.length > 0).length;
  const comVigente = fornecedoresOut.filter((f) => f.temSancaoVigente).length;
  const valorVigente = alertas
    .filter((a) => a.classificacao === 'critico')
    .reduce((s, a) => s + a.valorEnvolvido, 0);

  const response: SancoesResponse = {
    exercicio,
    dataReferencia,
    tokenConfigurado: true,
    coleta: {
      fornecedoresColetados: fornecedores.length,
      fornecedoresConsultados: topFornecedores.length,
      erroEmpenhos,
      erroSancoes,
    },
    resumo: {
      fornecedoresComSancao: comSancao,
      fornecedoresComSancaoVigente: comVigente,
      valorEnvolvidoVigente: valorVigente,
      alertas: alertas.length,
    },
    alertas,
    fornecedores: fornecedoresOut,
    aviso:
      erroSancoes !== null
        ? `A consulta aos cadastros federais falhou parcialmente: ${erroSancoes}. ` +
          'Os resultados podem estar incompletos.'
        : erroEmpenhos !== null
          ? `A coleta de fornecedores no Portal da Transparência de Marília ` +
            `falhou: ${erroEmpenhos}.`
          : null,
    atualizadoEm: new Date().toISOString(),
  };

  // Falha total: não coletou fornecedores E a CGU falhou → erro honesto.
  if (topFornecedores.length === 0 && (erroEmpenhos !== null || erroSancoes !== null)) {
    return NextResponse.json(response, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // Erro de API CGU presente → não cachear resposta possivelmente incompleta.
  if (erroSancoes !== null) {
    return NextResponse.json(response, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return NextResponse.json(response, {
    headers: { 'Cache-Control': 'private, max-age=1800' },
  });
}
