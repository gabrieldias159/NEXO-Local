/**
 * Detector FR-04 — FORNECEDOR INIDÔNEO RECEBENDO RECURSO PÚBLICO — NEXO.
 *
 * Cruza os fornecedores da Prefeitura Municipal de Marília/SP (CNPJ + nome +
 * valor empenhado no exercício) com os cadastros federais de inidôneos
 * (CEIS/CNEP/CEPIM, via `sources/sancoes-federais.ts`). Para cada fornecedor
 * com sanção VIGENTE na data de referência, gera um `AlertaDetectado`.
 *
 * Empresa inidônea/suspensa não pode contratar nem receber recurso público
 * (Lei 14.133/2021, art. 14, IV). Empresa punida pela Lei Anticorrupção
 * (Lei 12.846/2013) figura no CNEP. A presença simultânea de uma sanção
 * vigente e de empenhos da Prefeitura é um indício forte a apurar.
 *
 * REGRA DE LINGUAGEM: "indício, nunca acusação". A sanção é fato cadastral
 * oficial; a coincidência com empenhos pode ter explicação legítima (sanção
 * posterior ao empenho, homonímia de CNPJ corrigida, suspensão restrita a
 * outro ente). Convém apurar. Ver plano-mestre §6–§7. Apenas dados públicos.
 */
import { formatBRL } from '../normalizar';
import { ehEntidadePublica } from '../entidades';
import type { SancaoFederal, ConsultaSancaoCnpj } from '../sources/sancoes-federais';
import type {
  AlertaDetectado,
  ContextoAnalise,
  Detector,
  Evidencia,
} from './tipos';

const CATEGORIA = 'Fornecedores';

/** Fornecedor de Marília candidato ao cruzamento com as sanções federais. */
export interface FornecedorMarilia {
  /** CNPJ/CPF — apenas dígitos. */
  cnpj: string;
  nome: string;
  /** Valor total empenhado pela Prefeitura no exercício (R$). */
  valorEmpenhado: number;
}

/**
 * Verifica se uma sanção está VIGENTE numa data de referência (ISO).
 *  - sem `dataInicio` e sem `dataFim`: tratada como vigente (sanção sem prazo
 *    publicado — conservador, sempre indício a apurar);
 *  - com `dataInicio` futura: ainda não vigente;
 *  - com `dataFim` passada: já encerrada.
 */
export function sancaoVigente(s: SancaoFederal, refISO: string): boolean {
  if (s.dataInicio && s.dataInicio > refISO) return false;
  if (s.dataFim && s.dataFim < refISO) return false;
  return true;
}

/** Resumo curto da vigência para texto de evidência. */
function descreverVigencia(s: SancaoFederal): string {
  if (s.dataInicio && s.dataFim) return `vigência ${s.dataInicio} a ${s.dataFim}`;
  if (s.dataInicio) return `vigência desde ${s.dataInicio} (sem prazo final publicado)`;
  if (s.dataFim) return `vigência até ${s.dataFim}`;
  return 'vigência sem datas publicadas';
}

/**
 * Detector FR-04. Recebe os fornecedores de Marília e o resultado das consultas
 * de sanção (uma por CNPJ) e devolve um alerta para cada fornecedor com ao
 * menos uma sanção vigente na `dataReferencia`.
 *
 * @param dataReferencia data ISO `yyyy-MM-dd` usada para aferir vigência —
 *   default: hoje.
 */
export function analisarSancoes(input: {
  fornecedores: FornecedorMarilia[];
  consultas: ConsultaSancaoCnpj[];
  dataReferencia?: string;
}): AlertaDetectado[] {
  const { fornecedores, consultas } = input;
  const refISO = input.dataReferencia ?? new Date().toISOString().slice(0, 10);

  // Indexa fornecedores por CNPJ (só dígitos) para o cruzamento.
  const porCnpj = new Map<string, FornecedorMarilia>();
  for (const f of fornecedores) {
    if (!f.cnpj) continue;
    const cur = porCnpj.get(f.cnpj);
    if (cur) {
      cur.valorEmpenhado += f.valorEmpenhado;
      if (!cur.nome && f.nome) cur.nome = f.nome;
    } else {
      porCnpj.set(f.cnpj, { ...f });
    }
  }

  const out: AlertaDetectado[] = [];

  for (const consulta of consultas) {
    const fornecedor = porCnpj.get(consulta.cnpj);
    if (!fornecedor) continue; // sanção de CNPJ que não é fornecedor de Marília
    if (consulta.sancoes.length === 0) continue;

    const vigentes = consulta.sancoes.filter((s) => sancaoVigente(s, refISO));
    const encerradas = consulta.sancoes.filter((s) => !sancaoVigente(s, refISO));
    if (vigentes.length === 0 && encerradas.length === 0) continue;

    const temVigente = vigentes.length > 0;
    const cadastros = Array.from(
      new Set((temVigente ? vigentes : encerradas).map((s) => s.cadastro)),
    ).join(', ');
    const nome = fornecedor.nome || consulta.cnpj;
    const valor = fornecedor.valorEmpenhado;

    // Sanção VIGENTE → crítico. Só sanção encerrada → atenção (histórico).
    const classificacao: AlertaDetectado['classificacao'] = temVigente
      ? 'critico'
      : 'atencao';

    const sancoesRelevantes = temVigente ? vigentes : encerradas;
    const evidencias: Evidencia[] = sancoesRelevantes.slice(0, 8).map((s) => ({
      resumo:
        `[${s.cadastro}] ${s.tipoSancao || 'sanção'} — ${descreverVigencia(s)}` +
        (s.orgaoSancionador ? ` · órgão: ${s.orgaoSancionador}` : '') +
        (s.fundamentacao ? ` · base: ${s.fundamentacao.slice(0, 120)}` : ''),
      data: s.dataInicio,
      ref: s.cadastro,
    }));
    evidencias.push({
      resumo: `Valor empenhado pela Prefeitura no exercício: ${formatBRL(valor)}`,
      data: null,
      ref: 'SMARAPD',
    });

    const titulo = temVigente
      ? `Fornecedor com sanção federal vigente recebendo recurso público — ${nome}`
      : `Fornecedor com histórico de sanção federal (já encerrada) — ${nome}`;

    const descricao = temVigente
      ? `Fornecedor da Prefeitura de Marília consta com ${vigentes.length} ` +
        `sanção(ões) vigente(s) no(s) cadastro(s) federal(is) ${cadastros}, ` +
        `tendo recebido ${formatBRL(valor)} em empenhos no exercício. ` +
        'CNPJ inidôneo/suspenso não pode contratar com o poder público.'
      : `Fornecedor da Prefeitura de Marília tem ${encerradas.length} ` +
        `sanção(ões) já encerrada(s) no(s) cadastro(s) ${cadastros}. ` +
        `Recebeu ${formatBRL(valor)} em empenhos no exercício — sem ` +
        'sanção vigente na data de referência.';

    const explicacao = temVigente
      ? 'A empresa figura em cadastro federal de inidôneos/punidos com sanção ' +
        'aparentemente vigente, ao mesmo tempo em que recebeu empenhos da ' +
        'Prefeitura. Isso é um indício forte a apurar — convém verificar a data ' +
        'de cada empenho frente ao início da sanção, a abrangência da penalidade ' +
        '(suspensão pode ser restrita ao ente que aplicou) e eventual decisão ' +
        'judicial suspendendo seus efeitos. Não constitui, por si só, ' +
        'irregularidade nem acusação.'
      : 'A empresa teve sanção federal no passado, hoje encerrada. Os empenhos ' +
        'do exercício, em princípio, ocorreram fora do período de inidoneidade. ' +
        'Registrado como histórico relevante para a devida diligência da ' +
        'Prefeitura — não é, por si só, irregularidade.';

    out.push({
      detectorId: 'FR-04',
      detectorNome: 'Fornecedor inidôneo recebendo recurso público',
      categoria: CATEGORIA,
      titulo,
      descricao,
      sujeitoTipo: 'fornecedor',
      sujeitoId: consulta.cnpj,
      sujeitoRotulo: nome,
      classificacao,
      scores: {
        // Fonte oficial (CGU) — confiabilidade alta. Probabilidade alta quando
        // a sanção é vigente; bem menor quando é apenas histórico encerrado.
        confiabilidade: temVigente ? 90 : 82,
        probabilidadeIrregularidade: temVigente ? 85 : 30,
      },
      fundamentoLegal: [
        'Lei 14.133/2021 art. 14 IV',
        'Lei 12.846/2013',
      ],
      evidencias,
      explicacao,
      valorEnvolvido: valor,
    });
  }

  // Críticos primeiro; dentro de cada classe, maior valor envolvido.
  const peso: Record<string, number> = { critico: 0, suspeita: 1, atencao: 2, informativo: 3 };
  return out.sort(
    (a, b) =>
      (peso[a.classificacao] ?? 9) - (peso[b.classificacao] ?? 9) ||
      b.valorEnvolvido - a.valorEnvolvido,
  );
}

/**
 * Agrega os empenhos do exercício em fornecedores candidatos ao cruzamento com
 * sanções. Regras (alinhadas ao plano-mestre):
 *  - só CNPJ de 14 dígitos (sanção federal é por empresa; CPF não entra aqui);
 *  - EXCLUI entes públicos (`ehEntidadePublica`) — a Prefeitura/Câmara/SAAE não
 *    são "fornecedores inidôneos"; senão reintroduz o bug "Prefeitura como
 *    fornecedor" que a Onda 1 corrigiu;
 *  - soma o valor empenhado por CNPJ (matriz/filiais somam pelo doc cheio).
 */
export function fornecedoresParaSancoes(
  empenhos: ContextoAnalise['empenhos'],
): FornecedorMarilia[] {
  const porCnpj = new Map<string, FornecedorMarilia>();
  for (const e of empenhos) {
    const cnpj = e.cpfCnpj; // já só dígitos (EmpenhoNorm)
    if (cnpj.length !== 14) continue;
    if (ehEntidadePublica(cnpj, e.fornecedorNome)) continue;
    const cur = porCnpj.get(cnpj);
    if (cur) {
      cur.valorEmpenhado += e.valorEmpenhado;
      if (!cur.nome && e.fornecedorNome) cur.nome = e.fornecedorNome;
    } else {
      porCnpj.set(cnpj, {
        cnpj,
        nome: e.fornecedorNome,
        valorEmpenhado: e.valorEmpenhado,
      });
    }
  }
  return [...porCnpj.values()];
}

/**
 * Detector FR-04 no formato do pipeline (`rodarDetectores`). Liga o cruzamento
 * sancionado×empenho que antes estava coletado (`nexo_sancoes`) mas DESLIGADO da
 * detecção. Degrada para [] honestamente quando a fonte de sanções não foi
 * anexada ao contexto (cruzamento inativo) — nunca um falso negativo silencioso.
 */
export const detectorSancoesFornecedor: Detector = {
  id: 'FR-04',
  nome: 'Fornecedor inidôneo recebendo recurso público',
  categoria: CATEGORIA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const consultas = ctx.sancoes ?? [];
    if (consultas.length === 0) return []; // fonte de sanções não anexada
    const fornecedores = fornecedoresParaSancoes(ctx.empenhos);
    if (fornecedores.length === 0) return [];
    return analisarSancoes({
      fornecedores,
      consultas,
      dataReferencia: ctx.dataReferencia,
    });
  },
};
