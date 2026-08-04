/**
 * Detector FR-04E — FORNECEDOR COM SANÇÃO ESTADUAL (TCE-SP) RECEBENDO RECURSO
 * PÚBLICO — NEXO.
 *
 * Espelha o FR-04 federal (`sancoes-det.ts`), mas cruza os fornecedores da
 * Prefeitura Municipal de Marília/SP com a RELAÇÃO DE APENADOS do TCE-SP
 * (cadastro `TCE-SP-APENADOS`, coletada em `nexo_sancoes_estaduais`). São
 * impedimentos de licitar/contratar e declarações de inidoneidade aplicados no
 * âmbito estadual — muitas vezes pela PRÓPRIA Prefeitura de Marília (campo
 * `orgaoSancionador`), o que reforça o indício quando a empresa segue recebendo
 * empenhos.
 *
 * Fundamento: impedimento (Lei 14.133/2021, art. 156, III) e inidoneidade (Lei
 * 8.666/1993, art. 87, IV) impedem contratar/receber recurso público — a
 * abrangência pode variar (o impedimento do art. 156 é, em regra, restrito ao
 * ente sancionador; a inidoneidade do art. 87 é mais ampla). Por isso o FR-04E
 * classifica como SUSPEITA (não crítico), sempre indício a apurar — nunca
 * acusação. A coincidência pode ter explicação legítima (empenho anterior à
 * sanção, decisão suspendendo os efeitos, penalidade restrita a outro ente).
 * Apenas dados públicos. Ver plano-mestre §6–§7.
 */
import { formatBRL, soDigitos } from '../normalizar';
import type { SancaoFederal, ConsultaSancaoCnpj } from '../sources/sancoes-federais';
// Reusa a lógica de vigência e a agregação de fornecedores do FR-04 federal.
import {
  sancaoVigente,
  fornecedoresParaSancoes,
  type FornecedorMarilia,
} from './sancoes-det';
import type {
  AlertaDetectado,
  ContextoAnalise,
  Detector,
  Evidencia,
} from './tipos';

const CATEGORIA = 'Fornecedores';
const DETECTOR_NOME = 'Fornecedor com sanção estadual (TCE-SP) recebendo recurso público';

// ── Reidratação dos docs de `nexo_sancoes_estaduais` para o detector ──────────

/**
 * Coage uma sanção estadual JÁ normalizada (sub-array `sancoes` gravado em
 * `nexo_sancoes_estaduais`) ao tipo `SancaoFederal` reusado pelo motor. O
 * `cadastro` é fixado em `TCE-SP-APENADOS`; os campos extra do estadual
 * (`esfera`, `idApenacao`) são descartados (o detector não os usa). As datas já
 * chegam em ISO `yyyy-MM-dd` (ou null) da coleta.
 */
function coagirSancaoEstadual(v: unknown): SancaoFederal | null {
  if (v == null || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  return {
    cadastro: 'TCE-SP-APENADOS',
    cnpjSancionado: soDigitos(r.cnpjSancionado as string),
    nomeSancionado: String(r.nomeSancionado ?? ''),
    tipoSancao: String(r.tipoSancao ?? ''),
    dataInicio: typeof r.dataInicio === 'string' ? r.dataInicio : null,
    dataFim: typeof r.dataFim === 'string' ? r.dataFim : null,
    orgaoSancionador: String(r.orgaoSancionador ?? ''),
    fundamentacao: String(r.fundamentacao ?? ''),
  };
}

/**
 * Converte os docs CRUS de `nexo_sancoes_estaduais` (um por CNPJ verificado,
 * com o sub-array `sancoes` estadual) em `ConsultaSancaoCnpj[]` para alimentar
 * o FR-04E — tanto no pipeline persistido (`/api/nexo/detectar`) quanto na
 * análise ao vivo (`/api/nexo/analise`). Descarta CNPJ inválido (≠14 dígitos).
 * Espelha `consultasDeDocsSancoes` do conector federal.
 */
export function consultasDeDocsSancoesEstaduais(
  docs: Record<string, unknown>[],
): ConsultaSancaoCnpj[] {
  const out: ConsultaSancaoCnpj[] = [];
  for (const d of docs) {
    const cnpj = soDigitos((d.cnpj ?? d._cnpj) as string);
    if (cnpj.length !== 14) continue;
    const sancoes = (Array.isArray(d.sancoes) ? d.sancoes : [])
      .map(coagirSancaoEstadual)
      .filter((s): s is SancaoFederal => s !== null);
    out.push({ cnpj, sancoes, tokenConfigurado: true, erro: null });
  }
  return out;
}

// ── Detecção ──────────────────────────────────────────────────────────────────

/** Resumo curto da vigência para texto de evidência. */
function descreverVigencia(s: SancaoFederal): string {
  if (s.dataInicio && s.dataFim) return `vigência ${s.dataInicio} a ${s.dataFim}`;
  if (s.dataInicio) return `vigência desde ${s.dataInicio} (sem prazo final publicado)`;
  if (s.dataFim) return `vigência até ${s.dataFim}`;
  return 'vigência sem datas publicadas';
}

/**
 * Detector FR-04E. Recebe os fornecedores de Marília e as consultas de sanção
 * ESTADUAL (uma por CNPJ) e devolve um alerta para cada fornecedor com ao menos
 * uma sanção do TCE-SP na `dataReferencia`. Reusa `sancaoVigente` do FR-04.
 *
 * @param dataReferencia data ISO `yyyy-MM-dd` usada para aferir vigência —
 *   default: hoje.
 */
export function analisarSancoesEstaduais(input: {
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
    // Encerrada há mais de 2 anos é ruído histórico puro — não vira indício
    // (calibragem de qualidade: FR-04E enchia o backlog com sanção antiga).
    const limiteAntigo = new Date(refISO);
    limiteAntigo.setFullYear(limiteAntigo.getFullYear() - 2);
    const limiteISO = limiteAntigo.toISOString().slice(0, 10);
    const encerradas = consulta.sancoes.filter(
      (s) => !sancaoVigente(s, refISO) && (!s.dataFim || s.dataFim >= limiteISO),
    );
    if (vigentes.length === 0 && encerradas.length === 0) continue;

    const temVigente = vigentes.length > 0;
    const nome = fornecedor.nome || consulta.cnpj;
    const valor = fornecedor.valorEmpenhado;
    const sancoesRelevantes = temVigente ? vigentes : encerradas;

    // Quando o órgão sancionador é a PRÓPRIA Prefeitura de Marília, a penalidade
    // recai diretamente sobre o ente contratante — indício mais forte a apurar.
    const impedidoPeloProprioEnte = sancoesRelevantes.some((s) =>
      /MARILIA|MARÍLIA/i.test(s.orgaoSancionador || ''),
    );

    // Sanção VIGENTE → suspeita (impedimento estadual pode ser restrito ao ente;
    // por isso não é 'critico' como o FR-04 federal). Só encerrada (≤2 anos) →
    // INFORMATIVO: é histórico para devida diligência, não indício ativo
    // (rebaixado de 'atencao' na calibragem de qualidade).
    const classificacao: AlertaDetectado['classificacao'] = temVigente
      ? 'suspeita'
      : 'informativo';

    const evidencias: Evidencia[] = sancoesRelevantes.slice(0, 8).map((s) => ({
      resumo:
        `[TCE-SP-APENADOS] ${s.tipoSancao || 'impedimento/inidoneidade'} — ` +
        `${descreverVigencia(s)}` +
        (s.orgaoSancionador ? ` · órgão: ${s.orgaoSancionador}` : '') +
        (s.fundamentacao ? ` · base: ${s.fundamentacao.slice(0, 120)}` : ''),
      data: s.dataInicio,
      ref: 'TCE-SP-APENADOS',
    }));
    evidencias.push({
      resumo: `Valor empenhado pela Prefeitura no exercício: ${formatBRL(valor)}`,
      data: null,
      ref: 'SMARAPD',
    });

    const titulo = temVigente
      ? `Fornecedor com sanção estadual (TCE-SP) vigente recebendo recurso público — ${nome}`
      : `Fornecedor com histórico de sanção estadual (TCE-SP, já encerrada) — ${nome}`;

    const descricao = temVigente
      ? `Fornecedor da Prefeitura de Marília consta na Relação de Apenados do ` +
        `TCE-SP (cadastro TCE-SP-APENADOS) com ${vigentes.length} sanção(ões) ` +
        `vigente(s), tendo recebido ${formatBRL(valor)} em empenhos no exercício. ` +
        (impedidoPeloProprioEnte
          ? 'A penalidade foi aplicada pela PRÓPRIA Prefeitura de Marília — o ' +
            'impedimento recai diretamente sobre o ente contratante.'
          : 'Empresa impedida/inidônea não pode contratar com o poder público ' +
            'no âmbito da penalidade.')
      : `Fornecedor da Prefeitura de Marília tem ${encerradas.length} sanção(ões) ` +
        `estadual(is) já encerrada(s) na Relação de Apenados do TCE-SP. ` +
        `Recebeu ${formatBRL(valor)} em empenhos no exercício — sem sanção ` +
        'vigente na data de referência.';

    const explicacao = temVigente
      ? 'A empresa figura na Relação de Apenados do TCE-SP com sanção ' +
        'aparentemente vigente (impedimento de licitar/contratar, art. 156, III ' +
        'da Lei 14.133/2021, ou declaração de inidoneidade, art. 87, IV da Lei ' +
        '8.666/1993), ao mesmo tempo em que recebeu empenhos da Prefeitura. É um ' +
        'indício a apurar — convém verificar a data de cada empenho frente ao ' +
        'início da sanção, a ABRANGÊNCIA da penalidade (o impedimento do art. 156 ' +
        'costuma ser restrito ao ente sancionador; a inidoneidade do art. 87 é ' +
        'mais ampla) e eventual decisão suspendendo seus efeitos. Não constitui, ' +
        'por si só, irregularidade nem acusação.'
      : 'A empresa teve sanção estadual (TCE-SP) no passado, hoje encerrada. Os ' +
        'empenhos do exercício, em princípio, ocorreram fora do período de ' +
        'impedimento/inidoneidade. Registrado como histórico relevante para a ' +
        'devida diligência da Prefeitura — não é, por si só, irregularidade.';

    out.push({
      detectorId: 'FR-04E',
      detectorNome: DETECTOR_NOME,
      categoria: CATEGORIA,
      titulo,
      descricao,
      sujeitoTipo: 'fornecedor',
      sujeitoId: consulta.cnpj,
      sujeitoRotulo: nome,
      classificacao,
      scores: {
        // Fonte oficial (Relação de Apenados do TCE-SP) — confiabilidade alta.
        // Probabilidade de irregularidade sobe quando a sanção é vigente e,
        // ainda mais, quando o ente sancionador é a própria Prefeitura.
        confiabilidade: temVigente ? 85 : 78,
        probabilidadeIrregularidade: temVigente
          ? impedidoPeloProprioEnte
            ? 75
            : 60
          : 25,
      },
      fundamentoLegal: [
        'Lei 14.133/2021 art. 156 III',
        'Lei 8.666/1993 art. 87 IV',
        'Lei 14.133/2021 art. 14 IV',
      ],
      evidencias,
      explicacao,
      valorEnvolvido: valor,
    });
  }

  // Suspeitas primeiro; dentro de cada classe, maior valor envolvido.
  const peso: Record<string, number> = { critico: 0, suspeita: 1, atencao: 2, informativo: 3 };
  return out.sort(
    (a, b) =>
      (peso[a.classificacao] ?? 9) - (peso[b.classificacao] ?? 9) ||
      b.valorEnvolvido - a.valorEnvolvido,
  );
}

/**
 * Detector FR-04E no formato do pipeline (`rodarDetectores`). Liga o cruzamento
 * sancionado(TCE-SP)×empenho. Lê `ctx.sancoesEstaduais` (de
 * `nexo_sancoes_estaduais`); degrada para [] honestamente quando a fonte não
 * foi anexada ao contexto (cruzamento inativo) — nunca um falso negativo mudo.
 */
export const detectorSancoesEstaduaisFornecedor: Detector = {
  id: 'FR-04E',
  nome: DETECTOR_NOME,
  categoria: CATEGORIA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const consultas = ctx.sancoesEstaduais ?? [];
    if (consultas.length === 0) return []; // fonte estadual não anexada
    const fornecedores = fornecedoresParaSancoes(ctx.empenhos);
    if (fornecedores.length === 0) return [];
    return analisarSancoesEstaduais({
      fornecedores,
      consultas,
      dataReferencia: ctx.dataReferencia,
    });
  },
};
