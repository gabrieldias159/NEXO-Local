/**
 * Detector FR-05 — FORNECEDOR COM ACORDO DE LENIÊNCIA RECEBENDO EMPENHOS — NEXO.
 *
 * Cruza os fornecedores da Prefeitura Municipal de Marília/SP (CNPJ + nome +
 * valor empenhado no exercício) com o cadastro de Acordos de Leniência da CGU
 * (Lei 12.846/2013, arts. 16–17, via `sources/leniencia.ts` ← `nexo_leniencia`).
 * Para cada fornecedor abrangido por um acordo, gera um `AlertaDetectado`.
 *
 * Graduação (espelha a lógica vigente×encerrada do FR-04):
 *  - acordo DESCUMPRIDO → 'critico' — o descumprimento restaura a exposição às
 *    sanções atenuadas (Lei 12.846/2013, art. 16, §8º) e é o cenário mais grave;
 *  - acordo EM VIGÊNCIA → 'atencao' — celebrar leniência é LÍCITO (a empresa
 *    colaborou), mas é fato de devida diligência obrigatória do contratante;
 *  - acordo já CUMPRIDO/ENCERRADO → 'informativo' (histórico relevante).
 *
 * REGRA DE LINGUAGEM: "indício, nunca acusação". O acordo é fato cadastral
 * oficial da CGU; receber empenhos sob acordo vigente não é, por si só,
 * vedado — convém apurar. Ver plano-mestre §6–§7. Apenas dados públicos.
 */
import { formatBRL } from '../normalizar';
import { fornecedoresParaSancoes } from './sancoes-det';
import type { FornecedorMarilia } from './sancoes-det';
import type { AcordoLeniencia, ConsultaLenienciaCnpj } from '../sources/leniencia';
import type {
  AlertaDetectado,
  ContextoAnalise,
  Detector,
  Evidencia,
  Procedencia,
} from './tipos';

const CATEGORIA = 'Fornecedores';

/**
 * Baixa a caixa para casar a situação textual da CGU. (Acentos são cobertos
 * nos próprios regexes — ex.: `vig[eê]ncia` — sem strip de combining chars.)
 */
function normalizarTexto(v: string): string {
  return (v ?? '').toLowerCase();
}

/** true quando a situação do acordo indica DESCUMPRIMENTO (o caso mais grave). */
export function acordoDescumprido(a: AcordoLeniencia): boolean {
  return /descumprid|rescindid/.test(normalizarTexto(a.situacaoAcordo));
}

/**
 * true quando o acordo está EM VIGÊNCIA na data de referência (ISO).
 * Ordem de decisão:
 *  1. situação descumprida/rescindida → NÃO vigente (tratada à parte, é o
 *     cenário crítico);
 *  2. situação textual conclusiva ("cumprido"/"encerrado"/"finalizado") → não
 *     vigente; "em vigência"/"vigente" → vigente;
 *  3. sem situação conclusiva → vigência pelas datas, com o mesmo critério
 *     conservador do FR-04 (sem datas publicadas = vigente, indício a apurar).
 */
export function acordoVigente(a: AcordoLeniencia, refISO: string): boolean {
  if (acordoDescumprido(a)) return false;
  const s = normalizarTexto(a.situacaoAcordo);
  // Atenção à ordem: "descumprido" contém "cumprido", mas já saiu acima.
  if (/cumprido|encerrad|finalizad/.test(s)) return false;
  if (/vig[eê]ncia|vigente/.test(s)) return true;
  if (a.dataInicio && a.dataInicio > refISO) return false;
  if (a.dataFim && a.dataFim < refISO) return false;
  return true;
}

/** Resumo curto da vigência para texto de evidência. */
function descreverVigencia(a: AcordoLeniencia): string {
  if (a.dataInicio && a.dataFim) return `vigência ${a.dataInicio} a ${a.dataFim}`;
  if (a.dataInicio) return `vigência desde ${a.dataInicio} (sem prazo final publicado)`;
  if (a.dataFim) return `vigência até ${a.dataFim}`;
  return 'vigência sem datas publicadas';
}

/**
 * PROCEDÊNCIA da prova — deep-link público do Portal da Transparência Federal.
 * Com o `idAcordo` (vem da API CGU), o detalhe FORTE
 * `…/sancoes/acordos-leniencia/{id}`; sem ele, a consulta de sanções
 * pré-filtrada por cadastro de leniência + CNPJ
 * (`…/sancoes/consulta?cadastro=4&cpfCnpj={cnpj}` — `cadastro=4` é o código de
 * "Acordos de leniência" no próprio portal). O ponteiro bruto aponta o doc por
 * CNPJ em `nexo_leniencia` (prova de 2º nível).
 */
export function procedenciaLeniencia(
  cnpj: string,
  idAcordo?: string,
): Procedencia {
  const id = (idAcordo ?? '').trim();
  return {
    fonte: 'CGU',
    label: id
      ? 'Abrir acordo de leniência no Portal da Transparência Federal'
      : 'Consultar acordos de leniência no Portal da Transparência Federal',
    url: id
      ? `https://portaldatransparencia.gov.br/sancoes/acordos-leniencia/${encodeURIComponent(id)}`
      : `https://portaldatransparencia.gov.br/sancoes/consulta?cadastro=4&cpfCnpj=${cnpj}`,
    tipoDoc: 'pagina',
    podePreview: false, // SPA do portal federal — sem embed
    refColecao: 'nexo_leniencia',
    refId: cnpj,
  };
}

/**
 * Detector FR-05. Recebe os fornecedores de Marília e as verificações de
 * leniência (uma por CNPJ) e devolve um alerta para cada fornecedor abrangido
 * por ao menos um acordo — graduado por situação (descumprido > vigente >
 * histórico).
 *
 * @param dataReferencia data ISO `yyyy-MM-dd` usada para aferir vigência —
 *   default: hoje.
 */
export function analisarLeniencia(input: {
  fornecedores: FornecedorMarilia[];
  consultas: ConsultaLenienciaCnpj[];
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
    if (!fornecedor) continue; // acordo de CNPJ que não é fornecedor de Marília
    if (consulta.acordos.length === 0) continue; // verificado e limpo

    const descumpridos = consulta.acordos.filter(acordoDescumprido);
    const vigentes = consulta.acordos.filter((a) => acordoVigente(a, refISO));
    const historicos = consulta.acordos.filter(
      (a) => !acordoDescumprido(a) && !acordoVigente(a, refISO),
    );

    const temDescumprido = descumpridos.length > 0;
    const temVigente = vigentes.length > 0;
    const nome = fornecedor.nome || consulta.cnpj;
    const valor = fornecedor.valorEmpenhado;

    // Descumprido → crítico. Vigente → atenção (acordo é lícito). Só histórico
    // (cumprido/encerrado) → informativo.
    const classificacao: AlertaDetectado['classificacao'] = temDescumprido
      ? 'critico'
      : temVigente
        ? 'atencao'
        : 'informativo';

    const relevantes = temDescumprido
      ? descumpridos
      : temVigente
        ? vigentes
        : historicos;

    const evidencias: Evidencia[] = relevantes.slice(0, 8).map((a) => ({
      resumo:
        `Acordo de leniência ${a.situacaoAcordo || 'sem situação publicada'} — ` +
        descreverVigencia(a) +
        (a.orgaoResponsavel ? ` · órgão responsável: ${a.orgaoResponsavel}` : '') +
        (a.qtdEmpresasAbrangidas > 1
          ? ` · abrange ${a.qtdEmpresasAbrangidas} empresas`
          : ''),
      data: a.dataInicio,
      ref: 'CGU',
      procedencia: procedenciaLeniencia(consulta.cnpj, a.idAcordo),
    }));
    evidencias.push({
      resumo: `Valor empenhado pela Prefeitura no exercício: ${formatBRL(valor)}`,
      data: null,
      ref: 'SMARAPD',
    });

    const titulo = temDescumprido
      ? `Fornecedor com acordo de leniência DESCUMPRIDO recebendo empenhos — ${nome}`
      : temVigente
        ? `Fornecedor com acordo de leniência em vigência recebendo empenhos — ${nome}`
        : `Fornecedor com histórico de acordo de leniência (já encerrado) — ${nome}`;

    const descricao = temDescumprido
      ? `Fornecedor da Prefeitura de Marília consta com ${descumpridos.length} ` +
        `acordo(s) de leniência DESCUMPRIDO(S) no cadastro da CGU, tendo ` +
        `recebido ${formatBRL(valor)} em empenhos no exercício. O ` +
        'descumprimento restaura a exposição da empresa às sanções da Lei ' +
        'Anticorrupção que o acordo havia atenuado.'
      : temVigente
        ? `Fornecedor da Prefeitura de Marília consta com ${vigentes.length} ` +
          `acordo(s) de leniência em vigência no cadastro da CGU, tendo ` +
          `recebido ${formatBRL(valor)} em empenhos no exercício. O acordo é ` +
          'ato lícito de colaboração — registrado como fato de devida diligência.'
        : `Fornecedor da Prefeitura de Marília tem ${historicos.length} ` +
          `acordo(s) de leniência já cumprido(s)/encerrado(s) no cadastro da ` +
          `CGU. Recebeu ${formatBRL(valor)} em empenhos no exercício — sem ` +
          'acordo vigente ou descumprido na data de referência.';

    const explicacao = temDescumprido
      ? 'A empresa firmou acordo de leniência (admitindo a prática de ato ' +
        'lesivo à Administração) e o DESCUMPRIU, segundo o cadastro da CGU — ' +
        'ao mesmo tempo em que recebeu empenhos da Prefeitura. É um indício ' +
        'forte a apurar: o descumprimento afasta os benefícios do acordo ' +
        '(Lei 12.846/2013, art. 16, §8º) e pode reativar sanções que vedam a ' +
        'contratação. Convém verificar a data de cada empenho frente ao ' +
        'descumprimento e eventual sanção restaurada. Não constitui, por si ' +
        'só, irregularidade nem acusação.'
      : temVigente
        ? 'A empresa tem acordo de leniência em vigência — ato LÍCITO pelo ' +
          'qual colaborou com a investigação de ato lesivo em troca de ' +
          'atenuação de sanções (Lei 12.846/2013, art. 16). Receber empenhos ' +
          'nessa condição não é vedado, mas o histórico admitido no acordo é ' +
          'fato relevante de devida diligência: convém à Prefeitura conhecer ' +
          'o escopo do acordo e acompanhar seu cumprimento. Não é, por si só, ' +
          'irregularidade.'
        : 'A empresa teve acordo de leniência no passado, hoje ' +
          'cumprido/encerrado. Registrado como histórico relevante para a ' +
          'devida diligência da Prefeitura — não é, por si só, irregularidade.';

    out.push({
      detectorId: 'FR-05',
      detectorNome: 'Fornecedor com acordo de leniência recebendo empenhos',
      categoria: CATEGORIA,
      titulo,
      descricao,
      sujeitoTipo: 'fornecedor',
      sujeitoId: consulta.cnpj,
      sujeitoRotulo: nome,
      classificacao,
      scores: {
        // Fonte oficial (CGU) — confiabilidade alta. Probabilidade alta só no
        // descumprimento; acordo vigente é lícito (vínculo a apurar); histórico
        // encerrado é quase só memória institucional.
        confiabilidade: temDescumprido ? 90 : temVigente ? 88 : 85,
        probabilidadeIrregularidade: temDescumprido ? 80 : temVigente ? 45 : 20,
      },
      fundamentoLegal: [
        'Lei 12.846/2013, art. 16 (acordo de leniência)',
        'Lei 12.846/2013, art. 17 (extensão do acordo às sanções de licitação)',
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
 * Detector FR-05 no formato do pipeline (`rodarDetectores`). Reutiliza a MESMA
 * agregação de fornecedores do FR-04 (`fornecedoresParaSancoes`): só CNPJ de
 * 14 dígitos e NUNCA ente público (`ehEntidadePublica`) — a invariante-mãe
 * "Prefeitura nunca é fornecedor" vale aqui por construção. Degrada para []
 * honestamente quando `ctx.leniencia` não foi anexado (cruzamento inativo).
 */
export const detectorLenienciaFornecedor: Detector = {
  id: 'FR-05',
  nome: 'Fornecedor com acordo de leniência recebendo empenhos',
  categoria: CATEGORIA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const consultas = ctx.leniencia ?? [];
    if (consultas.length === 0) return []; // fonte de leniência não anexada
    const fornecedores = fornecedoresParaSancoes(ctx.empenhos);
    if (fornecedores.length === 0) return [];
    return analisarLeniencia({
      fornecedores,
      consultas,
      dataReferencia: ctx.dataReferencia,
    });
  },
};
