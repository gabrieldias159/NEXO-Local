/**
 * Catálogo de requerimentos-modelo (R01–R12) e geração de minutas.
 *
 * Cada modelo casa com uma família de achados. A partir de um alerta do motor
 * de detecção, o NEXO gera a minuta de um requerimento de informação pronto
 * para o gabinete adaptar. Linguagem de indício — nunca acusação.
 *
 * Base: docs/nexo/04-requerimentos-e-achados.md (LASTRO).
 */
import type { AlertaDetectado } from './detectores';
import { NEXO_DISCLAIMER } from './constants';

export interface RequerimentoModelo {
  id: string;
  titulo: string;
  quandoUsar: string;
  fundamento: string;
  /** Documentos a solicitar ao Executivo. */
  documentos: string[];
  /** Perguntas objetivas. */
  perguntas: string[];
}

export const REQUERIMENTOS: Record<string, RequerimentoModelo> = {
  R01: {
    id: 'R01',
    titulo: 'Fracionamento de despesa',
    quandoUsar: 'Sequência de contratações diretas do mesmo objeto/fornecedor que somam acima do limite de dispensa.',
    fundamento: 'Lei 14.133/2021, art. 75; CF art. 37',
    documentos: [
      'Cópia integral dos processos de contratação direta do fornecedor no período',
      'Justificativas de dispensa e pesquisas de preço de cada contratação',
      'Pareceres jurídicos e notas de empenho, liquidação e pagamento',
      'Planejamento anual de contratações da secretaria demandante',
    ],
    perguntas: [
      'Por que o objeto não foi licitado de forma agregada na modalidade correspondente?',
      'As contratações têm o mesmo objeto e a mesma secretaria demandante?',
      'Há contrato ou processo administrativo único vinculando as despesas?',
    ],
  },
  R02: {
    id: 'R02',
    titulo: 'Sobrepreço e aditivos em obras',
    quandoUsar: 'Contrato de obra com valor global muito acima do inicial ou itens acima da referência.',
    fundamento: 'Lei 14.133/2021, arts. 125 e 23',
    documentos: [
      'Planilha orçamentária, projeto básico e termo de referência da obra',
      'Todos os termos aditivos, com justificativa técnica de cada um',
      'Medições, ordens de serviço e relatórios de fiscalização do contrato',
      'Comparativo dos preços unitários com SINAPI/SICRO',
    ],
    perguntas: [
      'Qual a justificativa técnica para o acréscimo de valor sobre o contrato original?',
      'O percentual aditado respeita o limite legal de 25% (50% para reforma)?',
      'A evolução financeira paga corresponde à evolução física medida?',
    ],
  },
  R03: {
    id: 'R03',
    titulo: 'Combustível e uso da frota',
    quandoUsar: 'Consumo de combustível incompatível com a frota, a quilometragem ou a capacidade do tanque.',
    fundamento: 'CF art. 37; Lei 14.133/2021',
    documentos: [
      'Relatório de abastecimentos por veículo, com data, litros e quilometragem',
      'Diário de bordo e identificação dos condutores',
      'Contrato com o posto fornecedor e notas fiscais',
      'Relação da frota com placas, lotação e situação (ativo/baixado)',
    ],
    perguntas: [
      'Existe controle eletrônico de abastecimento com limite por veículo?',
      'Como se explica o consumo apurado frente à quilometragem registrada?',
      'Há abastecimentos em finais de semana, feriados ou de veículos inativos?',
    ],
  },
  R04: {
    id: 'R04',
    titulo: 'Medicamentos pagos sem comprovação de entrega',
    quandoUsar: 'Pagamento de insumos de saúde sem evidência de entrada em estoque ou distribuição.',
    fundamento: 'Lei 14.133/2021; Lei 4.320/1964; normas do SUS',
    documentos: [
      'Notas fiscais e comprovantes de recebimento dos insumos',
      'Relatórios de entrada e saída do almoxarifado da saúde',
      'Relatório de distribuição por unidade de saúde',
      'Identificação dos responsáveis pela conferência e pela liquidação',
    ],
    perguntas: [
      'A quantidade da nota fiscal corresponde à registrada no estoque?',
      'Há lote e validade para todo o fornecimento pago?',
      'O pagamento foi feito antes ou depois do recebimento físico?',
    ],
  },
  R05: {
    id: 'R05',
    titulo: 'Contratos emergenciais repetidos',
    quandoUsar: 'Emergência que se repete para o mesmo objeto, sugerindo falta de planejamento.',
    fundamento: 'Lei 14.133/2021, art. 75, VIII',
    documentos: [
      'Processos de dispensa emergencial do objeto nos últimos 24 meses',
      'Justificativas técnicas e pareceres jurídicos de cada contratação',
      'Histórico do contrato regular anterior e sua data de vencimento',
      'Comprovação de licitação em andamento para substituir a emergência',
    ],
    perguntas: [
      'Por que o objeto, sendo previsível, foi contratado de forma emergencial?',
      'O contrato regular anterior tinha data certa de vencimento conhecida?',
      'Qual fornecedor atendeu cada emergência?',
    ],
  },
  R06: {
    id: 'R06',
    titulo: 'Eventos, shows e contratação cultural',
    quandoUsar: 'Show ou evento com cachê elevado, intermediária desconhecida ou inexigibilidade frágil.',
    fundamento: 'Lei 14.133/2021, art. 74; Lei 9.504/1997',
    documentos: [
      'Processo integral de contratação do evento e a carta de exclusividade',
      'Pesquisa de preços e estudo de viabilidade do evento',
      'Contrato com a empresa intermediária e seu CNPJ/quadro societário',
      'Origem dos recursos (emenda parlamentar, fonte) e plano de comunicação',
    ],
    perguntas: [
      'Como se justifica o cachê frente ao porte do município?',
      'A empresa intermediária tem histórico e estrutura compatíveis?',
      'O evento foi usado para promoção pessoal de agente político?',
    ],
  },
  R07: {
    id: 'R07',
    titulo: 'Diárias e prestação de contas',
    quandoUsar: 'Beneficiário com volume atípico de diárias ou diárias sem prestação de contas.',
    fundamento: 'CF art. 37; legislação municipal de diárias',
    documentos: [
      'Relação das diárias do beneficiário no exercício, com destino e valor',
      'Portarias de viagem, relatórios de viagem e comprovantes de presença',
      'Comprovação do interesse público e do resultado de cada deslocamento',
      'Notas fiscais de hospedagem e transporte, quando houver',
    ],
    perguntas: [
      'As viagens têm relação direta com a atribuição do cargo?',
      'Há relatório de resultado e comprovante de presença para cada diária?',
      'Houve repetição de destino sem resultado demonstrável?',
    ],
  },
  R08: {
    id: 'R08',
    titulo: 'Fornecedor sediado em outra UF',
    quandoUsar: 'Serviço de natureza presencial contratado com empresa de outro estado.',
    fundamento: 'Lei 14.133/2021, arts. 5º e 63',
    documentos: [
      'Edital e processo licitatório da contratação',
      'Exigências de capacidade técnica e de estrutura local do edital',
      'Comprovação da estrutura operacional da empresa em Marília',
      'Eventuais contratos de subcontratação',
    ],
    perguntas: [
      'A empresa mantém estrutura própria no município para o serviço?',
      'O edital exigiu comprovação de capacidade de execução local?',
      'Há subcontratação de terceiros para a execução presencial?',
    ],
  },
  R09: {
    id: 'R09',
    titulo: 'Dispensa ou inexigibilidade de valor elevado',
    quandoUsar: 'Alta proporção do orçamento contratada sem concorrência competitiva.',
    fundamento: 'Lei 14.133/2021, arts. 74 e 75; CF art. 37',
    documentos: [
      'Relação de contratações por dispensa e inexigibilidade no exercício',
      'Justificativas e pareceres jurídicos das contratações de maior valor',
      'Pesquisas de preço que embasaram as contratações diretas',
      'Estudos que demonstrem a inviabilidade de competição, quando alegada',
    ],
    perguntas: [
      'Por que parcela relevante do orçamento foi contratada sem licitação?',
      'As hipóteses legais de dispensa/inexigibilidade foram corretamente aplicadas?',
      'Havia alternativa licitatória competitiva para cada contratação?',
    ],
  },
  R10: {
    id: 'R10',
    titulo: 'Nepotismo e nomeações',
    quandoUsar: 'Indício de contratação de parentes ou nomeações concentradas.',
    fundamento: 'CF art. 37; Súmula Vinculante 13 do STF',
    documentos: [
      'Relação de cargos comissionados, com lotação e atribuições',
      'Vínculo de parentesco entre nomeados e agentes públicos',
      'Atos de nomeação e exoneração do período',
      'Justificativa técnica para as nomeações em cargos sensíveis',
    ],
    perguntas: [
      'Há parentes de agentes públicos ocupando cargos comissionados?',
      'As nomeações se concentram em período pré-eleitoral?',
      'Os cargos comissionados têm atribuições de direção/assessoramento?',
    ],
  },
  R11: {
    id: 'R11',
    titulo: 'Limites fiscais e mínimos constitucionais',
    quandoUsar: 'Indicador de saúde, educação, pessoal ou dívida fora do limite legal.',
    fundamento: 'CF arts. 198 e 212; LC 101/2000 (LRF)',
    documentos: [
      'Relatórios de Gestão Fiscal (RGF) e RREO do exercício',
      'Demonstrativo de aplicação em saúde e em educação',
      'Demonstrativo da despesa total com pessoal sobre a RCL',
      'Plano de recondução ao limite, se aplicável',
    ],
    perguntas: [
      'O indicador apurado respeita o limite/mínimo constitucional ou da LRF?',
      'Quais medidas estão sendo adotadas para a recondução ao limite?',
      'Os relatórios fiscais foram publicados no prazo legal?',
    ],
  },
  R12: {
    id: 'R12',
    titulo: 'Divergência entre Diário Oficial e Portal da Transparência',
    quandoUsar: 'Ato publicado no DOM ausente do portal, ou pagamento sem publicidade.',
    fundamento: 'Lei 12.527/2011 (LAI); LC 101/2000, art. 48',
    documentos: [
      'Cópia do ato publicado no Diário Oficial e do processo correspondente',
      'Registro da despesa no Portal da Transparência',
      'Conciliação entre os atos publicados e os empenhos do período',
      'Justificativa para eventuais divergências identificadas',
    ],
    perguntas: [
      'Por que o ato publicado no Diário não consta no Portal da Transparência?',
      'Há despesas executadas sem a devida publicidade?',
      'Os dois sistemas são conciliados periodicamente?',
    ],
  },
};

/** Mapeia o detector ao modelo de requerimento mais adequado. */
const DETECTOR_REQUERIMENTO: Record<string, string> = {
  'LC-01': 'R01',
  'LC-05': 'R02',
  'LC-07': 'R09',
  'FN-01': 'R09',
  'DE-01': 'R07',
};

export function modeloParaDetector(detectorId: string): RequerimentoModelo | null {
  const id = DETECTOR_REQUERIMENTO[detectorId];
  return id ? REQUERIMENTOS[id] ?? null : null;
}

/** Junta itens em prosa corrida ("a, b, c e d") — estilo do gabinete, sem lista. */
function emProsa(itens: string[]): string {
  const xs = itens.map((s) => s.trim()).filter(Boolean);
  if (xs.length === 0) return '';
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`;
}

/** Minúscula só na inicial — para encaixar no meio de uma frase corrida. */
function inicialMinuscula(s: string): string {
  const t = s.trim();
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

/** Remove pontuação final — para concatenar sem ponto no meio da frase. */
function semPontoFinal(s: string): string {
  return s.trim().replace(/[.;:]+\s*$/, '');
}

const RE_INTERROGATIVO =
  /^(por que|porque|como|qual|quais|quando|onde|quem|o que|quanto|quantos|quantas)\b/i;

/** Converte pergunta direta em oração indireta ("se ..." / "por que ..."). */
function perguntaIndireta(pergunta: string): string {
  const q = inicialMinuscula(semPontoFinal(pergunta).replace(/\?+$/, ''));
  return RE_INTERROGATIVO.test(q) ? q : `se ${q}`;
}

/**
 * Gera a minuta de um requerimento a partir de um alerta — NO PADRÃO DO GABINETE
 * (Câmara de Marília), o mesmo do módulo oficial de Requerimentos (ver
 * src/ai/flows/ai-requerimento-assistant.ts): parágrafo ÚNICO, fórmula
 * "Solicitando ao Prefeito Municipal de Marília/SP informar a esta Casa, dentro
 * do prazo regimental de 15 dias e sob pena de responsabilidade, de acordo com o
 * Art. 16, XXII, da Lei Orgânica do Município de Marília, ...", SEM
 * "considerandos" retóricos e SEM listas/tópicos (documentos e perguntas
 * dobrados em prosa). Linguagem de indício, nunca acusação (disclaimer no rodapé).
 */
export function gerarTextoRequerimento(
  alerta: AlertaDetectado,
  modelo: RequerimentoModelo,
): string {
  const ano = new Date().getFullYear();
  const documentos = emProsa(modelo.documentos.map(inicialMinuscula));
  const questoes = emProsa(modelo.perguntas.map(perguntaIndireta));
  const baseFatual = alerta.descricao
    ? `, tendo em vista o indício apurado pelo monitoramento de dados ` +
      `públicos: ${semPontoFinal(alerta.descricao)}`
    : '';

  const pedido =
    'Solicitando ao Prefeito Municipal de Marília/SP informar a esta Casa, ' +
    'dentro do prazo regimental de 15 dias e sob pena de responsabilidade, de ' +
    'acordo com o Art. 16, XXII, da Lei Orgânica do Município de Marília, a ' +
    `situação relativa a ${inicialMinuscula(semPontoFinal(alerta.titulo))}` +
    (documentos ? `, encaminhando ${documentos}` : '') +
    (questoes ? `, bem como esclarecendo ${questoes}` : '') +
    `${baseFatual}.`;

  return [
    `REQUERIMENTO Nº ______/${ano}`,
    '',
    pedido,
    '',
    '________________________________________________________________',
    NEXO_DISCLAIMER,
  ].join('\n');
}
