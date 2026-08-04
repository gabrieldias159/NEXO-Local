/**
 * Detector XS-14 — Cruzamento cross-source TCE-SP × fornecedores de Marília.
 *
 * OBJETIVO: sinalizar quando um fornecedor/contrato da Prefeitura de Marília
 * aparece citado em julgado ou apontamento de auditoria do TCE-SP. É um
 * cruzamento (cross-source): de um lado a lista de fornecedores de Marília
 * (API pública de despesas do TCE-SP); de outro, julgados/apontamentos do
 * TCE-SP referentes ao município.
 *
 * ── LIMITAÇÃO HONESTA ──
 * O TCE-SP NÃO publica fonte consultável de julgados/apontamentos filtrável
 * por município (ver `sources/tce-sp.ts`). Logo, na prática, o lado "julgados"
 * do cruzamento chega VAZIO (`integracao: 'pendente'`). Quando isso ocorre, o
 * detector NÃO inventa alertas — devolve `[]` e o estado pendente é reportado
 * pela rota/UI. O detector só produz `AlertaDetectado[]` se julgados reais
 * forem fornecidos (ex.: alimentação manual de números de processo).
 *
 * REGRA DE LINGUAGEM: todo alerta é INDÍCIO a apurar — nunca acusação.
 * Apenas dados públicos. LGPD. Ver plano-mestre §6–§7.
 */
import { formatBRL } from '../normalizar';
import type {
  FornecedorTCE,
  JulgadoTCE,
  ApontamentoTCE,
} from '../sources/tce-sp';
import type { AlertaDetectado } from './tipos';

const DETECTOR_ID = 'XS-14';
const DETECTOR_NOME = 'Fornecedor de Marília citado em julgado do TCE-SP';
const CATEGORIA = 'Cruzamentos cross-source';
const FUNDAMENTO = ['CF art. 31'];

/** Resultados de julgamento que indicam mérito desfavorável. */
const RESULTADOS_DESFAVORAVEIS = /irregular|desfavor|ilegal|reprov|conden|multa|d[eé]bito/i;

/**
 * Normaliza um documento para comparação: só dígitos. Vazio retorna string
 * vazia (nunca cruza fornecedores sem documento por documento).
 */
function docKey(doc: string): string {
  return (doc || '').replace(/\D+/g, '');
}

/**
 * Normaliza um nome para comparação aproximada: maiúsculas, sem acento, sem
 * pontuação, espaços colapsados. Usado como fallback quando não há documento.
 */
function nomeKey(nome: string): string {
  return (nome || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface FornecedorIndex {
  porDoc: Map<string, FornecedorTCE>;
  porNome: Map<string, FornecedorTCE>;
}

function indexarFornecedores(fornecedores: FornecedorTCE[]): FornecedorIndex {
  const porDoc = new Map<string, FornecedorTCE>();
  const porNome = new Map<string, FornecedorTCE>();
  for (const f of fornecedores) {
    const d = docKey(f.documento);
    if (d) {
      // Mantém o de maior valor empenhado como representante.
      const cur = porDoc.get(d);
      if (!cur || f.valorEmpenhado > cur.valorEmpenhado) porDoc.set(d, f);
    }
    const n = nomeKey(f.nome);
    if (n && n.length >= 6) {
      const cur = porNome.get(n);
      if (!cur || f.valorEmpenhado > cur.valorEmpenhado) porNome.set(n, f);
    }
  }
  return { porDoc, porNome };
}

/** Tenta casar um documento+nome contra o índice de fornecedores. */
function casarFornecedor(
  idx: FornecedorIndex,
  documento: string,
  nome: string,
): { fornecedor: FornecedorTCE; modo: 'documento' | 'nome' } | null {
  const d = docKey(documento);
  if (d) {
    const f = idx.porDoc.get(d);
    if (f) return { fornecedor: f, modo: 'documento' };
  }
  const n = nomeKey(nome);
  if (n && n.length >= 6) {
    const f = idx.porNome.get(n);
    if (f) return { fornecedor: f, modo: 'nome' };
  }
  return null;
}

// ── XS-14a — fornecedor citado em JULGADO do TCE-SP ──────────────────────────

function detectarFornecedorEmJulgado(
  idx: FornecedorIndex,
  julgados: JulgadoTCE[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];

  for (const j of julgados) {
    const casado = casarFornecedor(idx, j.fornecedorDocumento, j.fornecedorNome);
    if (!casado) continue;

    const { fornecedor, modo } = casado;
    const meritoDesfavoravel =
      RESULTADOS_DESFAVORAVEIS.test(j.resultado) ||
      RESULTADOS_DESFAVORAVEIS.test(j.ementa);

    // Cruzamento por documento é forte; por nome é apenas indicativo.
    const classificacao: AlertaDetectado['classificacao'] = meritoDesfavoravel
      ? modo === 'documento'
        ? 'suspeita'
        : 'atencao'
      : 'informativo';
    const confiabilidade = modo === 'documento' ? 82 : 55;
    const probabilidade = meritoDesfavoravel
      ? modo === 'documento'
        ? 64
        : 46
      : 24;

    const rotulo = fornecedor.nome || j.fornecedorNome || fornecedor.documento;

    out.push({
      detectorId: DETECTOR_ID,
      detectorNome: DETECTOR_NOME,
      categoria: CATEGORIA,
      titulo: `Fornecedor de Marília citado em julgado do TCE-SP — ${rotulo}`,
      descricao:
        `O fornecedor ${rotulo} recebeu ${formatBRL(fornecedor.valorEmpenhado)} ` +
        `em empenhos da administração de Marília e aparece citado no processo ` +
        `${j.numeroProcesso || '(sem número)'} do TCE-SP` +
        (j.resultado ? ` — resultado: ${j.resultado}.` : '.') +
        (modo === 'nome'
          ? ' Cruzamento feito por similaridade de nome (confirmar identidade).'
          : ''),
      sujeitoTipo: 'fornecedor',
      sujeitoId: fornecedor.documento || nomeKey(fornecedor.nome),
      sujeitoRotulo: rotulo,
      classificacao,
      scores: {
        confiabilidade,
        probabilidadeIrregularidade: probabilidade,
      },
      fundamentoLegal: FUNDAMENTO,
      evidencias: [
        {
          resumo: `Empenhos em Marília: ${formatBRL(fornecedor.valorEmpenhado)} em ${fornecedor.qtdEmpenhos} empenho(s)`,
          valor: fornecedor.valorEmpenhado,
        },
        {
          resumo: `Processo TCE-SP: ${j.numeroProcesso || '(sem número)'}${j.tipo ? ` — ${j.tipo}` : ''}`,
          data: j.data,
          ref: j.url || undefined,
        },
        ...(j.resultado
          ? [{ resumo: `Resultado do julgamento: ${j.resultado}` }]
          : []),
        ...(j.ementa ? [{ resumo: `Ementa: ${j.ementa.slice(0, 220)}` }] : []),
        ...(j.relator ? [{ resumo: `Relator: ${j.relator}` }] : []),
        {
          resumo: `Critério do cruzamento: ${modo === 'documento' ? 'CNPJ/CPF idêntico' : 'similaridade de razão social'}`,
        },
      ],
      explicacao:
        'O cruzamento aproxima a lista de fornecedores da Prefeitura de Marília ' +
        '(API pública de despesas do TCE-SP) de julgados do próprio TCE-SP. ' +
        'A citação de um fornecedor em julgado NÃO significa irregularidade no ' +
        'contrato com Marília — o processo pode tratar de outro ente, de outro ' +
        'objeto, ou ter resultado favorável. É um indício para verificar se há ' +
        'sobreposição de objeto, período e responsabilidade.' +
        (modo === 'nome'
          ? ' Como o cruzamento foi por nome, confirme a identidade do fornecedor antes de qualquer juízo.'
          : ''),
      valorEnvolvido: fornecedor.valorEmpenhado,
    });
  }

  return out;
}

// ── XS-14b — fornecedor citado em APONTAMENTO de auditoria do TCE-SP ──────────

function detectarFornecedorEmApontamento(
  idx: FornecedorIndex,
  apontamentos: ApontamentoTCE[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];

  for (const a of apontamentos) {
    const casado = casarFornecedor(idx, a.fornecedorDocumento, a.fornecedorNome);
    if (!casado) continue;

    const { fornecedor, modo } = casado;
    const rotulo = fornecedor.nome || a.fornecedorNome || fornecedor.documento;

    out.push({
      detectorId: DETECTOR_ID,
      detectorNome: DETECTOR_NOME,
      categoria: CATEGORIA,
      titulo: `Fornecedor de Marília em apontamento de auditoria do TCE-SP — ${rotulo}`,
      descricao:
        `O fornecedor ${rotulo} (${formatBRL(fornecedor.valorEmpenhado)} em ` +
        `empenhos de Marília) é citado em apontamento de auditoria do TCE-SP` +
        (a.categoria ? ` na categoria "${a.categoria}".` : '.'),
      sujeitoTipo: 'fornecedor',
      sujeitoId: fornecedor.documento || nomeKey(fornecedor.nome),
      sujeitoRotulo: rotulo,
      classificacao: modo === 'documento' ? 'atencao' : 'informativo',
      scores: {
        confiabilidade: modo === 'documento' ? 78 : 52,
        probabilidadeIrregularidade: modo === 'documento' ? 48 : 32,
      },
      fundamentoLegal: FUNDAMENTO,
      evidencias: [
        {
          resumo: `Empenhos em Marília: ${formatBRL(fornecedor.valorEmpenhado)} em ${fornecedor.qtdEmpenhos} empenho(s)`,
          valor: fornecedor.valorEmpenhado,
        },
        {
          resumo: `Apontamento TCE-SP: ${a.categoria || 'sem categoria'} (exercício ${a.exercicio})`,
          data: a.data,
        },
        ...(a.descricao
          ? [{ resumo: `Descrição: ${a.descricao.slice(0, 220)}` }]
          : []),
        {
          resumo: `Critério do cruzamento: ${modo === 'documento' ? 'CNPJ/CPF idêntico' : 'similaridade de razão social'}`,
        },
      ],
      explicacao:
        'Apontamento de auditoria do TCE-SP que cita um fornecedor da Prefeitura ' +
        'de Marília. O apontamento é uma observação do controle externo — não é ' +
        'condenação. Convém verificar se o apontamento se refere ao mesmo ' +
        'contrato/objeto executado em Marília e qual foi o desdobramento.' +
        (modo === 'nome'
          ? ' Cruzamento por nome — confirme a identidade do fornecedor.'
          : ''),
      valorEnvolvido: fornecedor.valorEmpenhado,
    });
  }

  return out;
}

// ── Runner XS-14 ─────────────────────────────────────────────────────────────

export interface EntradaAnaliseTCE {
  /** Fornecedores de Marília (lado funcional, API pública de despesas). */
  fornecedores: FornecedorTCE[];
  /** Julgados do TCE-SP — vazio enquanto a integração estiver pendente. */
  julgados: JulgadoTCE[];
  /** Apontamentos do TCE-SP — vazio enquanto a integração estiver pendente. */
  apontamentos: ApontamentoTCE[];
}

/**
 * Executa o detector XS-14 sobre o cruzamento TCE-SP × Marília.
 *
 * Se `julgados` e `apontamentos` chegarem vazios (caso real hoje, pois o
 * TCE-SP não expõe essa dimensão de forma consultável), o detector devolve
 * `[]` — não inventa alertas. O estado pendente é reportado pela rota.
 */
export function analisarTCE(entrada: EntradaAnaliseTCE): AlertaDetectado[] {
  const { fornecedores, julgados, apontamentos } = entrada;

  if (fornecedores.length === 0) return [];
  if (julgados.length === 0 && apontamentos.length === 0) return [];

  const idx = indexarFornecedores(fornecedores);

  return [
    ...detectarFornecedorEmJulgado(idx, julgados),
    ...detectarFornecedorEmApontamento(idx, apontamentos),
  ].sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
}
