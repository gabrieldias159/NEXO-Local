/**
 * Catálogo de monitoramentos do NEXO — as 14 áreas do catálogo-mestre
 * (docs/nexo/02-catalogo-de-monitoramentos.md, 132 monitoramentos) e os
 * detectores efetivamente ativos no sistema.
 */

export interface DetectorAtivo {
  id: string;
  nome: string;
}

export interface AreaMonitoramento {
  prefixo: string;
  nome: string;
  /** Tamanho da área no catálogo-mestre planejado. */
  planejado: number;
  /** Detectores efetivamente implementados e rodando. */
  ativos: DetectorAtivo[];
}

export const AREAS_MONITORAMENTO: readonly AreaMonitoramento[] = [
  {
    prefixo: 'LC',
    nome: 'Licitações e compras',
    planejado: 25,
    ativos: [
      { id: 'LC-01', nome: 'Fracionamento de despesa' },
      { id: 'LC-05', nome: 'Aditivo acima do limite legal' },
      { id: 'LC-07', nome: 'Alta proporção de contratação direta' },
      { id: 'LC-08', nome: 'Recorrência de fornecedor em contratos' },
      { id: 'LC-09', nome: 'Contrato de valor atípico' },
    ],
  },
  { prefixo: 'OB', nome: 'Obras públicas', planejado: 14, ativos: [] },
  { prefixo: 'FC', nome: 'Frota e combustível', planejado: 11, ativos: [] },
  { prefixo: 'SA', nome: 'Saúde, medicamentos e almoxarifado', planejado: 13, ativos: [] },
  { prefixo: 'EM', nome: 'Contratos emergenciais', planejado: 8, ativos: [] },
  {
    prefixo: 'DE',
    nome: 'Diárias, eventos e publicidade',
    planejado: 13,
    ativos: [
      { id: 'DE-01', nome: 'Volume atípico de diárias' },
      { id: 'DE-02', nome: 'Diárias — razão salário' },
    ],
  },
  {
    prefixo: 'FR',
    nome: 'Fornecedores',
    planejado: 13,
    ativos: [
      { id: 'FN-01', nome: 'Concentração de fornecedor' },
      { id: 'FN-02', nome: 'Fornecedor com múltiplos CNPJs' },
      { id: 'FN-03', nome: 'Fornecedor de outra UF' },
      { id: 'FN-04', nome: 'Empresa recém-criada' },
      { id: 'FN-05', nome: 'Situação cadastral irregular / inidôneo' },
      { id: 'FN-06', nome: 'Empresa fantasma / fachada' },
      { id: 'FN-07', nome: 'Superfaturamento' },
    ],
  },
  {
    prefixo: 'FP',
    nome: 'Folha, cargos e terceirizados',
    planejado: 14,
    ativos: [
      { id: 'FP-01', nome: 'Remuneração elevada' },
      { id: 'FP-09', nome: 'Nomeações concentradas' },
      { id: 'FP-10', nome: 'Funcionário fantasma' },
    ],
  },
  {
    prefixo: 'OR',
    nome: 'Execução orçamentária',
    planejado: 10,
    ativos: [
      { id: 'OR-01', nome: 'Pagamento sem empenho prévio' },
      { id: 'OR-02', nome: 'Liquidação sem empenho' },
      { id: 'OR-03', nome: 'Pedalada fiscal' },
      { id: 'OR-04', nome: 'Quebra da ordem cronológica' },
      { id: 'OR-05', nome: 'Dotação executada acima de 100%' },
      { id: 'OR-06', nome: 'Restos a pagar relevantes' },
      { id: 'OR-07', nome: 'Anulações recorrentes de empenho' },
      { id: 'OR-08', nome: 'Empenhos concentrados no fim do exercício' },
      { id: 'OR-09', nome: 'Reforço de empenho atípico' },
      { id: 'OR-10', nome: 'Despesa em elemento incompatível' },
      { id: 'OR-11', nome: 'Desvio de verba vinculada' },
      { id: 'OR-12', nome: 'Precatórios' },
      { id: 'OR-13', nome: 'Restos a pagar — Art. 42 LRF' },
    ],
  },
  {
    prefixo: 'MF',
    nome: 'Metas fiscais e LRF',
    planejado: 14,
    ativos: [
      { id: 'MF-IND', nome: 'Indicadores fiscais (saúde, educação, pessoal, dívida)' },
      { id: 'MF-PRZ', nome: 'Rastreador de prazos RREO/RGF' },
      { id: 'MF-15', nome: 'Dívida ativa' },
      { id: 'MF-16', nome: 'Variações patrimoniais' },
      { id: 'MF-17', nome: 'Índice de liquidez' },
      { id: 'MF-18', nome: 'Duodécimo' },
      { id: 'MF-19', nome: 'Resultado primário/nominal' },
    ],
  },
  { prefixo: 'DO', nome: 'Diário Oficial', planejado: 8, ativos: [] },
  { prefixo: 'TS', nome: 'Convênios e terceiro setor', planejado: 9, ativos: [] },
  { prefixo: 'XS', nome: 'Cruzamentos cross-source', planejado: 14, ativos: [] },
  { prefixo: 'RC', nome: 'Receita e renúncia', planejado: 6, ativos: [] },
  { prefixo: 'TP', nome: 'Transparência e LAI', planejado: 5, ativos: [
    { id: 'TP-01', nome: 'Checklist transparência LAI' },
  ] },
];

/** Total de detectores ativos no sistema. */
export function totalDetectoresAtivos(): number {
  return AREAS_MONITORAMENTO.reduce((s, a) => s + a.ativos.length, 0);
}

/** Total de monitoramentos do catálogo-mestre planejado. */
export const TOTAL_CATALOGO = 132;
