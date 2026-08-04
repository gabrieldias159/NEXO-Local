/**
 * Catálogo completo de monitoramentos do NEXO.
 *
 * Materializa as 14 áreas do catálogo-mestre (docs/nexo/02). O anexo cita
 * "132" no resumo, mas as faixas de ID somam 172 monitoramentos de fato —
 * este arquivo registra os 172.
 *
 * `status`:
 *   ativo      — detector implementado e rodando.
 *   computavel — fonte de dados acessível; lógica ainda não implementada.
 *   planejado  — depende de fonte/integração ainda não disponível.
 */

export type DispDado = 'disponivel' | 'parcial' | 'integracao';
export type StatusMon = 'ativo' | 'computavel' | 'planejado';

export interface MonitoramentoCat {
  id: string;
  area: string;
  nome: string;
  detecta: string;
  regra: string;
  severidade: number;
  fundamento: string;
  disp: DispDado;
  quickWin: boolean;
  status: StatusMon;
}

export interface AreaCat {
  prefixo: string;
  nome: string;
}

export const AREAS: readonly AreaCat[] = [
  { prefixo: 'LC', nome: 'Licitações e compras' },
  { prefixo: 'OB', nome: 'Obras públicas' },
  { prefixo: 'FC', nome: 'Frota e combustível' },
  { prefixo: 'SA', nome: 'Saúde, medicamentos e almoxarifado' },
  { prefixo: 'EM', nome: 'Contratos emergenciais' },
  { prefixo: 'DE', nome: 'Diárias, eventos, shows e publicidade' },
  { prefixo: 'FR', nome: 'Fornecedores' },
  { prefixo: 'FP', nome: 'Folha, cargos e terceirizados' },
  { prefixo: 'OR', nome: 'Execução orçamentária' },
  { prefixo: 'MF', nome: 'Metas fiscais e LRF' },
  { prefixo: 'DO', nome: 'Diário Oficial' },
  { prefixo: 'TS', nome: 'Convênios, repasses e terceiro setor' },
  { prefixo: 'XS', nome: 'Cruzamentos cross-source' },
  { prefixo: 'RC', nome: 'Receita e renúncia' },
];

/**
 * IDs cobertos por um detector implementado e RODANDO sobre dados reais do
 * portal (alguns por proxy declarado na `explicacao` do alerta). Os 172
 * monitoramentos têm detector codado em `src/lib/nexo/detectores/*`; os que
 * não estão neste conjunto rodam, mas degradam para vazio até a fonte de
 * dados específica ser coletada (ver comentário de cada detector).
 */
const ATIVOS = new Set<string>([
  'LC-01', 'LC-02', 'LC-03', 'LC-04', 'LC-05', 'LC-06', 'LC-07', 'LC-14',
  'LC-16', 'LC-17', 'LC-18', 'LC-19', 'LC-20', 'LC-24',
  'OB-08', 'OB-09', 'OB-10', 'OB-13', 'OB-14',
  'FC-01', 'FC-02', 'FC-07', 'FC-08', 'FC-10', 'FC-11',
  'SA-05', 'SA-08', 'SA-09', 'SA-11', 'SA-12', 'SA-13',
  'EM-01', 'EM-02', 'EM-03', 'EM-04', 'EM-07', 'EM-08',
  'DE-01', 'DE-02', 'DE-03', 'DE-04', 'DE-05', 'DE-06', 'DE-07', 'DE-08',
  'DE-09', 'DE-11', 'DE-12',
  'FR-01', 'FR-02', 'FR-03', 'FR-04', 'FR-06', 'FR-08', 'FR-09', 'FR-10',
  'FR-11', 'FR-12',
  'FP-01', 'FP-06', 'FP-09', 'FP-13', 'FP-14',
  'OR-01', 'OR-02', 'OR-03', 'OR-04', 'OR-05', 'OR-06', 'OR-07', 'OR-08',
  'OR-09', 'OR-10',
  'MF-01', 'MF-02', 'MF-03', 'MF-04', 'MF-05', 'MF-06',
  'MF-09', 'MF-10', 'MF-11', 'MF-12', 'MF-13', 'MF-14',
  'DO-01', 'DO-02', 'DO-03', 'DO-04', 'DO-05', 'DO-06', 'DO-07', 'DO-08',
  'TS-01', 'TS-03', 'TS-06', 'TS-07',
  'XS-07', 'XS-10',
  'RC-01', 'RC-02', 'RC-05',
]);

function m(
  id: string,
  nome: string,
  detecta: string,
  regra: string,
  severidade: number,
  fundamento: string,
  disp: DispDado,
  quickWin: boolean,
): MonitoramentoCat {
  const area = id.slice(0, 2);
  const status: StatusMon = ATIVOS.has(id)
    ? 'ativo'
    : disp === 'disponivel'
      ? 'computavel'
      : 'planejado';
  return { id, area, nome, detecta, regra, severidade, fundamento, disp, quickWin, status };
}

export const CATALOGO: readonly MonitoramentoCat[] = [
  // ── 1. LICITAÇÕES E COMPRAS ──────────────────────────────────────────────
  m('LC-01', 'Fracionamento por fornecedor', 'Sequência de dispensas ao mesmo CNPJ que soma acima do limite legal', '≥3 dispensas ao mesmo CNPJ em 90 dias com soma > limite do exercício', 4, 'Lei 14.133/2021 art. 75 §1º', 'disponivel', true),
  m('LC-02', 'Fracionamento por objeto', 'Mesmo objeto pulverizado em várias compras pequenas', 'Similaridade textual de objeto; soma anual > limite com ≥3 compras diretas', 4, 'Lei 14.133/2021 art. 75 §1º, art. 18', 'disponivel', false),
  m('LC-03', 'Fracionamento entre secretarias', 'Mesmo objeto por dispensa em UGs diferentes', 'Mesmo objeto + ≥2 UGs + soma > limite no exercício', 4, 'Lei 14.133/2021 art. 75 §1º', 'disponivel', false),
  m('LC-04', 'Valor colado no limite', 'Dispensa com valor 90–100% do teto legal', 'Valor da dispensa entre 90% e 100% do limite', 3, 'Lei 14.133/2021 art. 75 I/II', 'disponivel', true),
  m('LC-05', 'Sequência logo abaixo do limite', 'Vários empenhos diretos pouco abaixo do teto', '≥4 compras diretas do mesmo CNPJ entre 80–99% do limite', 3, 'Lei 14.133/2021 art. 75 §1º', 'disponivel', false),
  m('LC-06', 'Peso de contratação direta', 'Dispensa+inexigibilidade como fatia anormal do gasto', '(DISPENSA+DISPENSADA+INEXIGIBILIDADE) / total empenhado > 25%', 3, 'Lei 14.133/2021 art. 17, 28', 'disponivel', true),
  m('LC-07', 'Inexigibilidade frágil', 'Inexigibilidade relevante sem comprovação de exclusividade', 'Inexigibilidade + valor > R$ 50k + sem justificativa no DOM', 4, 'Lei 14.133/2021 art. 74', 'disponivel', false),
  m('LC-08', 'Único habilitado', 'Pregão/concorrência com 1 só licitante na fase final', 'Processo competitivo com 1 habilitado na fase final', 3, 'Lei 14.133/2021 art. 17', 'integracao', false),
  m('LC-09', 'Baixa competitividade crônica', 'Modalidade com média de participantes muito baixa', 'Média de licitantes/certame < 3 por objeto/secretaria', 3, 'Lei 14.133/2021 art. 11, 25', 'integracao', false),
  m('LC-10', 'Prazo mínimo de publicação', 'Intervalo edital→sessão abaixo do mínimo legal', '(data sessão − data publicação) < prazo legal da modalidade', 4, 'Lei 14.133/2021 art. 55', 'integracao', false),
  m('LC-11', 'Edital com exigência restritiva', 'Termo de referência com exigência técnica sob medida', 'NLP no edital: marca, atestado incomum, prazo/local incompatíveis', 4, 'Lei 14.133/2021 art. 25 §1º, art. 9º', 'integracao', false),
  m('LC-12', 'Orçamento estimado alinhado', 'Pesquisa de preços com empresas de fachada', 'Cotações com CNAE incompatível, CNPJ novo ou endereço comum', 4, 'Lei 14.133/2021 art. 23', 'integracao', false),
  m('LC-13', 'Competição figurativa', 'Mesmos participantes com alternância previsível de vitória', 'Grafo: mesmo grupo de CNPJs em ≥3 certames com rodízio de vitória', 5, 'Lei 12.846/2013 art. 5º IV', 'integracao', false),
  m('LC-14', 'Carona / ata de outro município', 'Adesão a ata de outro ente sem pesquisa local', 'Empenho com ata externa + sem pesquisa local + preço acima dos contratos locais', 4, 'Lei 14.133/2021 art. 86 §2º', 'parcial', false),
  m('LC-15', 'Carona com sobrepreço', 'Adesão a ata com preço unitário acima do mercado local', 'Preço unitário da carona > +15% vs. mediana de contratos comparáveis', 4, 'Lei 14.133/2021 art. 23, 86', 'parcial', false),
  m('LC-16', 'Objeto licitado em excesso', 'Mesmo objeto licitado repetidamente no exercício', 'Mesmo objeto licitado >3x no exercício', 2, 'Lei 14.133/2021 art. 18, 12', 'integracao', false),
  m('LC-17', 'Empenho sem licitação correspondente', 'Modalidade não-direta sem processo licitatório localizável', 'Modalidade pregão/concorrência + ProcessoLicitatorio vazio/não encontrado', 3, 'Lei 14.133/2021 art. 12', 'parcial', false),
  m('LC-18', 'Modalidade incompatível com valor', 'Valor exigiria modalidade mais rigorosa que a usada', 'Valor empenhado por objeto > faixa da modalidade declarada', 4, 'Lei 14.133/2021 art. 28–29', 'disponivel', true),
  m('LC-19', 'Aditivo acima do limite', 'Soma de aditivos ultrapassa 25% (50% reforma) do original', 'Σ aditivos / valor original > 0,25 (ou 0,50 reforma)', 4, 'Lei 14.133/2021 art. 125', 'parcial', false),
  m('LC-20', 'Aditivo de prazo desproporcional', 'Aditivo de prazo maior que o prazo contratual original', 'prazo aditado > prazo original (>100%)', 3, 'Lei 14.133/2021 art. 124–125', 'parcial', false),
  m('LC-21', 'Apostilamento mascarando reajuste', 'Apostilamentos sucessivos elevando valor sem aditivo', '≥3 apostilamentos no mesmo contrato com elevação acumulada > 15%', 3, 'Lei 14.133/2021 art. 136', 'integracao', false),
  m('LC-22', 'Vencedor recém-aberto', 'Empresa vencedora com CNPJ aberto pouco antes do certame', 'data abertura do CNPJ < 180 dias antes da licitação', 3, 'Lei 14.133/2021 art. 5º', 'disponivel', false),
  m('LC-23', 'Alteração societária pré-vitória', 'Mudança de quadro societário às vésperas da vitória', 'alteração de sócios nos 90 dias anteriores à vitória', 4, 'Lei 12.846/2013 art. 5º IV', 'parcial', false),
  m('LC-24', 'Empenho sem itens detalháveis', 'Empenho relevante sem drill-down de itens', 'valor > R$ 100k + itens vazios ou genéricos', 2, 'Lei 4.320/1964 art. 63', 'disponivel', false),
  m('LC-25', 'Sobrepreço em compra de bem', 'Preço unitário de item acima de referência de mercado', 'preço unitário > +25% vs. mediana do mesmo item no portal/PNCP', 4, 'Lei 14.133/2021 art. 23', 'parcial', false),

  // ── 2. OBRAS PÚBLICAS ────────────────────────────────────────────────────
  m('OB-01', 'Sobrepreço unitário médio', 'Item de planilha acima da referência oficial', 'preço unitário / SINAPI-SICRO entre 1,15 e 1,25', 3, 'Lei 14.133/2021 art. 23; TCU Súm. 258', 'integracao', false),
  m('OB-02', 'Sobrepreço unitário alto', 'Item de planilha bem acima da referência', 'razão entre 1,25 e 1,40', 4, 'Lei 14.133/2021 art. 23', 'integracao', false),
  m('OB-03', 'Sobrepreço unitário crítico', 'Item extremamente acima da referência', 'razão > 1,40 sem justificativa técnica', 5, 'Lei 14.133/2021 art. 23; Lei 8.429/1992', 'integracao', false),
  m('OB-04', 'BDI fora do padrão', 'Taxa de BDI acima da faixa usual', 'BDI declarado > faixa de referência (TCU 2.622/2013)', 3, 'TCU Ac. 2.622/2013-P', 'integracao', false),
  m('OB-05', 'Curva ABC concentrada', 'Poucos itens concentram a maior parte do valor', 'top 10 itens / valor total > 80%', 3, 'Lei 14.133/2021 art. 23', 'integracao', false),
  m('OB-06', 'Jogo de planilha', 'Itens caros super-executados, baratos sub-executados', 'itens acima da referência com execução > prevista e vice-versa', 4, 'Lei 14.133/2021 art. 25', 'integracao', false),
  m('OB-07', 'Financeiro acima do físico', 'Percentual pago supera percentual físico medido', '% financeiro pago − % físico medido > 10 pontos', 5, 'Lei 4.320/1964 art. 62–63; Lei 8.429/1992', 'integracao', false),
  m('OB-08', 'Pagamento sem medição', 'Pagamento de obra sem boletim de medição', 'empenho/pagamento de obra sem medição vinculada', 4, 'Lei 4.320/1964 art. 63', 'integracao', false),
  m('OB-09', 'Obra paralisada com saldo', 'Obra parada mantendo saldo empenhado relevante', 'status = paralisada + saldo empenhado > R$ 50k', 3, 'Lei 14.133/2021 art. 115', 'integracao', false),
  m('OB-10', 'Obra paga recentemente e parada', 'Pagamento recente em obra sem evolução física', 'pagamento nos últimos 60 dias + 0% de avanço físico', 4, 'Lei 4.320/1964 art. 63', 'integracao', false),
  m('OB-11', 'Aditivos de obra em cadeia', 'Sucessão de aditivos no mesmo contrato de obra', '≥3 aditivos OU Σ aditivos > 25% (50% reforma)', 4, 'Lei 14.133/2021 art. 125', 'disponivel', false),
  m('OB-12', 'Obra sem ART/RRT', 'Contrato de obra sem registro de responsabilidade técnica', 'ausência de ART/RRT do responsável técnico no processo', 4, 'Lei 6.496/1977; Lei 12.378/2010', 'integracao', false),
  m('OB-13', 'Obra anunciada sem contrato', 'Obra divulgada sem contrato localizável', 'obra citada em DOM/notícia sem contrato/empenho', 3, 'LC 131/2009; LAI', 'parcial', false),
  m('OB-14', 'Recape/tapa-buraco repetido no local', 'Mesmo logradouro recebendo pavimentação repetidas vezes', 'mesmo endereço/objeto de pavimentação contratado >1x em 18 meses', 3, 'Lei 14.133/2021 art. 18; Lei 8.429/1992', 'integracao', false),

  // ── 3. FROTA E COMBUSTÍVEL ───────────────────────────────────────────────
  m('FC-01', 'Concentração de gasto em posto', 'Gasto de combustível concentrado num único posto', 'um CNPJ de posto > 70% do gasto de combustível da UG', 3, 'Lei 14.133/2021 art. 11', 'disponivel', true),
  m('FC-02', 'Gasto de combustível atípico', 'Despesa mensal de combustível fora da média histórica', 'gasto mensal > média móvel 12m + 2 desvios-padrão', 2, 'LRF art. 1º §1º', 'disponivel', true),
  m('FC-03', 'Consumo km/l incompatível', 'Rendimento incompatível com o tipo de veículo', 'km/l < 50% da média esperada do tipo', 4, 'Lei 8.429/1992; DL 200/1967', 'integracao', false),
  m('FC-04', 'Abastecimento acima do tanque', 'Litros abastecidos superam a capacidade do tanque', 'litros > capacidade do tanque + 10%', 4, 'Lei 8.429/1992 art. 10', 'integracao', false),
  m('FC-05', 'Veículo parado com consumo', 'Veículo inativo/baixado seguindo com abastecimento', 'abastecimento para veículo sem deslocamento ou baixado', 4, 'Lei 8.429/1992', 'integracao', false),
  m('FC-06', 'Abastecimento sem quilometragem', 'Abastecimentos sem km informada', 'km ausente em > 20% dos abastecimentos do veículo/mês', 2, 'Controle interno; LAI', 'integracao', false),
  m('FC-07', 'Abastecimento em fim de semana/feriado', 'Abastecimento fora de expediente sem justificativa', 'abastecimento em domingo/feriado de veículo administrativo', 3, 'Lei 9.504/1997 art. 73', 'integracao', false),
  m('FC-08', 'Abastecimentos sequenciais', 'Múltiplos abastecimentos do mesmo veículo no dia', '≥2 abastecimentos do mesmo veículo em 24h', 3, 'Controle interno', 'integracao', false),
  m('FC-09', 'Cartão usado em veículos diferentes', 'Mesmo cartão-combustível em veículos distintos', 'mesmo cartão → ≥2 placas no mesmo período', 4, 'Lei 8.429/1992; fraude documental', 'integracao', false),
  m('FC-10', 'Fornecedor único de combustível por longo período', 'Mesmo posto fornece sem competição por período longo', 'mesmo CNPJ fornece combustível por > 24 meses sem nova licitação', 3, 'Lei 14.133/2021 art. 11, 106', 'parcial', false),
  m('FC-11', 'Manutenção de frota recorrente sem laudo', 'Gastos repetidos de manutenção sem relatório técnico', '≥4 manutenções do mesmo veículo/ano sem laudo', 2, 'Lei 4.320/1964 art. 63', 'integracao', false),

  // ── 4. SAÚDE, MEDICAMENTOS E ALMOXARIFADO ────────────────────────────────
  m('SA-01', 'Pagamento sem entrada em estoque', 'Insumo pago sem registro de entrada no almoxarifado', 'empenho pago + ausência de entrada de estoque', 5, 'Lei 4.320/1964 art. 62–63; Lei 8.429/1992', 'integracao', false),
  m('SA-02', 'NF sem correspondência no almoxarifado', 'Nota fiscal liquidada sem lançamento de recebimento', 'quantidade NF ≠ quantidade registrada no estoque', 5, 'Lei 4.320/1964 art. 63', 'integracao', false),
  m('SA-03', 'Entrega parcial paga como integral', 'Pagamento integral com entrega comprovada menor', 'quantidade entregue < contratada, pagamento 100%', 4, 'Lei 14.133/2021 art. 140; Lei 8.429/1992', 'integracao', false),
  m('SA-04', 'Entrada sem lote/validade', 'Recebimento de medicamento sem lote ou validade', 'campo lote ou validade ausente no registro de entrada', 3, 'RDC ANVISA; controle interno', 'integracao', false),
  m('SA-05', 'Preço acima do Banco de Preços em Saúde', 'Item de saúde comprado acima da referência nacional', 'preço unitário > +20% vs. mediana do Banco de Preços em Saúde', 4, 'Lei 14.133/2021 art. 23', 'integracao', false),
  m('SA-06', 'Compra sem distribuição posterior', 'Medicamento pago sem saída para unidades', 'compra registrada + 0 saídas em 90 dias', 3, 'Lei 8.429/1992; LC 141/2012', 'integracao', false),
  m('SA-07', 'Falta na unidade apesar de compra recente', 'Unidade sem o item enquanto há compra recente paga', 'reclamação de falta + compra do item nos últimos 60 dias', 4, 'LC 141/2012; LAI', 'integracao', false),
  m('SA-08', 'Concentração de itens num fornecedor', 'Um CNPJ concentra a maior parte do fornecimento de saúde', 'um fornecedor > 30% do valor de medicamentos/insumos da Saúde', 3, 'Lei 14.133/2021 art. 11', 'disponivel', true),
  m('SA-09', 'Compra emergencial recorrente de saúde', 'Itens contínuos comprados por emergência repetidas vezes', 'EM-01 aplicado a objetos da Saúde', 4, 'Lei 14.133/2021 art. 75 VIII', 'parcial', false),
  m('SA-10', 'Contrato de gestão sem relatório de metas', 'Repasse a OSS sem prestação de metas', 'contrato de gestão com repasse + ausência de relatório de metas', 4, 'Lei 9.637/1998; LC 141/2012', 'parcial', false),
  m('SA-11', 'Locação de ambulância com baixa comprovação', 'Pagamento recorrente de locação na saúde sem comprovação', 'locação paga mensalmente sem relatório de utilização', 3, 'Lei 4.320/1964 art. 63', 'disponivel', false),
  m('SA-12', 'Mesmo fiscal atestando alto volume', 'Um único fiscal atesta volume anormal de liquidações', 'um servidor atesta > N liquidações/mês acima da média', 2, 'Lei 14.133/2021 art. 117', 'parcial', false),
  m('SA-13', 'Manutenção hospitalar sem relatório técnico', 'Serviço de manutenção em unidade de saúde sem laudo', 'empenho de manutenção hospitalar sem relatório técnico', 2, 'Lei 4.320/1964 art. 63', 'parcial', false),

  // ── 5. CONTRATOS EMERGENCIAIS ────────────────────────────────────────────
  m('EM-01', 'Emergência repetida no mesmo objeto', '>1 emergência para o mesmo objeto em 12 meses', 'mesmo objeto + modalidade emergencial + ≥2 ocorrências em 12 meses', 4, 'Lei 14.133/2021 art. 75 VIII', 'parcial', false),
  m('EM-02', 'Mesmo fornecedor emergencial recorrente', 'Mesmo CNPJ contratado por emergência várias vezes', '≥3 contratos emergenciais ao mesmo CNPJ em 12 meses', 4, 'Lei 14.133/2021 art. 75 VIII', 'parcial', false),
  m('EM-03', 'Emergência após fim de contrato previsível', 'Emergencial logo após vencimento conhecido de contrato', 'emergencial em 60 dias após fim de contrato do mesmo objeto', 4, 'Lei 14.133/2021 art. 75 VIII, art. 12', 'parcial', false),
  m('EM-04', 'Objeto previsível tratado como urgente', 'Objeto contínuo classificado como emergência', 'objeto previsível (limpeza, merenda, etc.) contratado por emergência', 3, 'Lei 14.133/2021 art. 75 VIII', 'parcial', false),
  m('EM-05', 'Emergência sem pesquisa de preço', 'Contrato emergencial sem evidência de pesquisa de preços', 'emergencial + ausência de pesquisa de preço no processo', 3, 'Lei 14.133/2021 art. 23, 75 §3º', 'integracao', false),
  m('EM-06', 'Aditivo emergencial sucessivo', 'Contrato emergencial prorrogado além do prazo excepcional', 'aditivo de prazo em emergencial / vigência total > 1 ano', 4, 'Lei 14.133/2021 art. 75 VIII', 'disponivel', false),
  m('EM-07', 'Emergência de valor expressivo sem estudo', 'Emergencial de alto valor sem estudo técnico preliminar', 'emergencial + valor > R$ 200k + ausência de ETP', 4, 'Lei 14.133/2021 art. 18, 75 §6º', 'integracao', false),
  m('EM-08', 'Calamidade usada para contratar fora do escopo', 'Dispensa de calamidade com objeto sem nexo com o evento', 'dispensa por decreto de calamidade + objeto sem relação com o evento', 4, 'Lei 14.133/2021 art. 75 VIII; LRF art. 65', 'parcial', false),

  // ── 6. DIÁRIAS, EVENTOS, SHOWS E PUBLICIDADE ─────────────────────────────
  m('DE-01', 'Diária sem prestação de contas', 'Diária paga sem relatório/comprovante de presença', 'diária paga + ausência de relatório de viagem no prazo', 3, 'Lei 4.320/1964 art. 63; decreto de diárias', 'parcial', false),
  m('DE-02', 'Acúmulo de diárias por beneficiário', 'Servidor com volume/valor de diárias muito acima do normal', 'mesmo beneficiário > 15 diárias/mês OU > R$ 5k/mês', 3, 'Lei 4.320/1964; controle interno', 'disponivel', true),
  m('DE-03', 'Diárias com datas sobrepostas', 'Mesmo servidor com diárias de períodos sobrepostos', 'janelas de diária do mesmo CPF com interseção de datas', 4, 'Lei 8.429/1992 art. 10', 'disponivel', true),
  m('DE-04', 'Viagens repetidas ao mesmo destino', 'Mesmo destino visitado muitas vezes sem resultado', '≥4 diárias ao mesmo destino para o mesmo grupo no exercício', 2, 'Lei 4.320/1964 art. 63', 'disponivel', false),
  m('DE-05', 'Grupo fixo de viajantes', 'Sempre os mesmos servidores viajando juntos', 'conjunto recorrente de beneficiários em ≥3 deslocamentos', 2, 'Controle interno; impessoalidade', 'disponivel', false),
  m('DE-06', 'Passagens/locomoção desproporcional', 'Gasto de passagens/locomoção atípico para a unidade', 'gasto da UG > média histórica + 2 desvios-padrão', 2, 'LRF; controle interno', 'disponivel', true),
  m('DE-07', 'Show com cachê incompatível', 'Cachê de evento alto demais para o porte do município', 'valor do contrato de show acima da faixa de referência', 4, 'Lei 14.133/2021 art. 74 II, art. 23', 'parcial', false),
  m('DE-08', 'Show por intermediária recém-criada', 'Inexigibilidade de show via empresa nova/sem histórico', 'inexigibilidade de evento + CNPJ intermediário < 12 meses', 5, 'Lei 14.133/2021 art. 74 II §1º', 'parcial', false),
  m('DE-09', 'Inexigibilidade de show mal explicada', 'Carta de exclusividade frágil em contratação artística', 'inexigibilidade artística + sem comprovação robusta no DOM', 4, 'Lei 14.133/2021 art. 74 II', 'parcial', false),
  m('DE-10', 'Evento por emenda com promoção política', 'Emenda vinculada a evento com autopromoção', 'emenda → evento + publicações destacando agente político', 4, 'Lei 9.504/1997 art. 73; CF art. 37 §1º', 'parcial', false),
  m('DE-11', 'Publicidade com promoção pessoal', 'Publicidade institucional com nome/imagem do gestor', 'NLP em peças de publicidade: nome/imagem/slogan pessoal', 4, 'CF art. 37 §1º; Lei 9.504/1997 art. 73', 'parcial', false),
  m('DE-12', 'Pico de publicidade em janela eleitoral', 'Gasto de publicidade dispara em período sensível', 'gasto de publicidade no trimestre pré-eleitoral > +30% vs. ano anterior', 3, 'Lei 9.504/1997 art. 73 VI/VII', 'disponivel', true),
  m('DE-13', 'Publicidade acima do teto da RCL', 'Gasto de publicidade excede o parâmetro da RCL', 'gasto de publicidade / RCL > 1%', 3, 'CF art. 37 §1º; TCE-SP', 'disponivel', false),

  // ── 7. FORNECEDORES ──────────────────────────────────────────────────────
  m('FR-01', 'Concentração de contratos', 'Um fornecedor concentra fatia anormal dos contratos', 'um CNPJ raiz > 20% do valor de contratos/empenhos ativos', 3, 'Lei 14.133/2021 art. 11', 'disponivel', true),
  m('FR-02', 'Fornecedor de UF distante em serviço presencial', 'Empresa de outra UF executando serviço presencial', 'UF da sede ≠ SP + CNAE de serviço presencial', 4, 'Lei 14.133/2021 art. 25', 'disponivel', true),
  m('FR-03', 'CNPJ não-ativo recebendo pagamento', 'Pagamento a empresa com situação cadastral ≠ ATIVA', 'situação ∈ {baixada, inapta, suspensa, nula} na data do pagamento', 5, 'Lei 14.133/2021 art. 14, 68', 'disponivel', true),
  m('FR-04', 'Fornecedor inidôneo (CEIS/CNEP)', 'Empresa em cadastro de inidôneos recebendo recurso', 'CNPJ em CEIS, CNEP ou CEPIM com sanção vigente', 5, 'Lei 14.133/2021 art. 14 IV; Lei 12.846/2013', 'integracao', false),
  m('FR-05', 'Empresa punida no portal recebendo pagamento', 'Empresa na lista de punidas do município ainda paga', 'CNPJ em empresaspunidas com sanção ativa + pagamento no período', 5, 'Lei 14.133/2021 art. 14', 'disponivel', true),
  m('FR-06', 'Múltiplos CNPJs da mesma raiz', 'Empresa usa filiais distintas para fracionar contratação', 'mesma raiz de 8 dígitos com contratos cuja soma cruza limite', 3, 'Lei 14.133/2021 art. 75 §1º', 'disponivel', true),
  m('FR-07', 'Sócios/endereço/contador em comum', 'Concorrentes compartilham sócio, endereço ou contador', 'grafo: ≥2 CNPJs com sócio, endereço ou contador em comum', 5, 'Lei 12.846/2013 art. 5º IV', 'parcial', false),
  m('FR-08', 'CNAE incompatível com o objeto', 'Empresa contratada para objeto fora da atividade declarada', 'CNAE sem aderência ao objeto contratado', 3, 'Lei 14.133/2021 art. 62, 67', 'disponivel', false),
  m('FR-09', 'Capital social incompatível com contrato', 'Capital social muito inferior ao valor contratado', 'valor do contrato / capital social > 10', 3, 'Lei 14.133/2021 art. 69', 'disponivel', false),
  m('FR-10', 'Empresa sem estrutura aparente', 'Indícios de empresa de fachada', 'endereço residencial + porte ME/MEI + contrato de alto valor', 4, 'Lei 12.846/2013 art. 5º', 'parcial', false),
  m('FR-11', 'Vencedor único em várias secretarias', 'Mesmo fornecedor vencendo objetos distintos em muitas UGs', 'mesmo CNPJ com contratos em ≥4 UGs com objetos heterogêneos', 2, 'Lei 14.133/2021 art. 11', 'disponivel', false),
  m('FR-12', 'Empresa nova com contrato relevante', 'CNPJ recém-aberto já com contrato de grande valor', 'abertura < 12 meses + contrato > R$ 100k', 3, 'Risco gerencial', 'disponivel', true),
  m('FR-13', 'Fornecedor doador de campanha', 'Fornecedor que doou para campanha do gestor e contratou', 'CNPJ/sócio em doações de campanha do gestor + contrato no mandato', 4, 'Lei 9.504/1997; CF art. 37', 'integracao', false),

  // ── 8. FOLHA, CARGOS E TERCEIRIZADOS ─────────────────────────────────────
  m('FP-01', 'Remuneração acima do teto', 'Servidor com remuneração superior ao teto constitucional', 'total de vencimentos > teto aplicável', 4, 'CF art. 37 XI', 'disponivel', true),
  m('FP-02', 'Gratificações inflando o líquido', 'Gratificações como fatia anormal da remuneração', '(vencimentos − salário base) / salário base > 0,70', 3, 'CF art. 37 XI', 'parcial', false),
  m('FP-03', 'CPF duplicado ou inválido', 'Mesmo CPF em servidores distintos ou DV inválido', 'CPF repetido entre matrículas OU dígito verificador inválido', 5, 'Auditoria cadastral; Lei 8.429/1992', 'parcial', false),
  m('FP-04', 'Múltiplas matrículas simultâneas', 'Servidor com mais de um vínculo ativo ao mesmo tempo', 'mesmo CPF com ≥2 matrículas ativas no mesmo mês', 4, 'CF art. 37 XVI', 'parcial', false),
  m('FP-05', 'Acúmulo ilegal de cargos', 'Combinação de cargos não permitida pela Constituição', 'par de cargos do mesmo CPF fora das exceções do art. 37 XVI', 4, 'CF art. 37 XVI–XVII', 'parcial', false),
  m('FP-06', 'Comissionado sem lotação visível', 'Cargo em comissão sem descrição/lotação clara', 'cargo comissionado com lotação vazia ou genérica', 3, 'CF art. 37 V; SV 13', 'disponivel', false),
  m('FP-07', 'Nepotismo (mesmo sobrenome do gestor)', 'Comissionado com sobrenome do agente político', 'sobrenome do comissionado coincide com gestor + livre escolha', 5, 'Súmula Vinculante 13', 'parcial', false),
  m('FP-08', 'Nepotismo cruzado (indício)', 'Designações recíprocas de parentes entre agentes', 'grafo de sobrenomes: troca cruzada entre gabinetes', 4, 'Súmula Vinculante 13', 'parcial', false),
  m('FP-09', 'Nomeação concentrada pré-eleição', 'Pico de nomeações nos meses anteriores ao pleito', 'nº de nomeações nos 90 dias pré-eleição > +50% vs. média', 4, 'Lei 9.504/1997 art. 73 V', 'disponivel', true),
  m('FP-10', 'Rotatividade anormal de secretários', 'Troca frequente de titulares de secretaria', '≥3 trocas de titular na mesma secretaria em 12 meses', 2, 'CF art. 37 (eficiência)', 'parcial', false),
  m('FP-11', 'Despesa de pessoal em alta vs. receita', 'Crescimento da folha descolado da receita', 'crescimento % folha 12m > crescimento % receita 12m + tolerância', 3, 'LRF art. 19–20', 'disponivel', false),
  m('FP-12', 'Horas extras concentradas', 'Horas extras concentradas em poucos servidores/setores', 'um setor/servidor concentra fatia anormal das horas extras', 3, 'LRF art. 22', 'parcial', false),
  m('FP-13', 'Terceirizado sem lista nominal / sem local', 'Contrato de mão de obra sem relação nominal ou local', 'contrato de terceirização sem lista nominal ou posto definido', 3, 'Lei 14.133/2021 art. 117; Súmula TST 331', 'parcial', false),
  m('FP-14', 'Terceirizado vinculado a mais de um contrato', 'Mesma pessoa terceirizada em contratos simultâneos', 'mesmo CPF de terceirizado em ≥2 contratos vigentes', 4, 'Lei 8.429/1992; fraude documental', 'integracao', false),

  // ── 9. EXECUÇÃO ORÇAMENTÁRIA ─────────────────────────────────────────────
  m('OR-01', 'Pagamento sem empenho prévio', 'Pagamento registrado sem empenho que o anteceda', 'pagamento sem NroEmpenho válido ou empenho posterior ao pagamento', 5, 'Lei 4.320/1964 art. 60', 'disponivel', true),
  m('OR-02', 'Liquidação sem empenho', 'Liquidação sem empenho correspondente', 'liquidação sem empenho vinculado', 4, 'Lei 4.320/1964 art. 63', 'disponivel', false),
  m('OR-03', 'Empenho sem liquidação prolongada', 'Empenho aberto há muito tempo sem liquidar', 'empenho aberto > 90 dias sem liquidação, exercício corrente', 2, 'Lei 4.320/1964 art. 58–63', 'disponivel', true),
  m('OR-04', 'Quebra da ordem cronológica', 'Pagamento fora da ordem cronológica por fonte', 'fornecedor pago antes de outro com liquidação mais antiga', 4, 'Lei 14.133/2021 art. 141; LC 131/2009', 'disponivel', true),
  m('OR-05', 'Dotação executada acima de 100%', 'Execução superior ao orçado sem suplementação', 'empenhado/dotação > 1,00 sem crédito adicional', 4, 'Lei 4.320/1964 art. 59; LRF', 'disponivel', false),
  m('OR-06', 'Suplementações repetidas na mesma dotação', 'Mesma dotação suplementada várias vezes', '≥3 créditos adicionais na mesma dotação no exercício', 3, 'Lei 4.320/1964 art. 40–43', 'parcial', false),
  m('OR-07', 'Empenho anulado e reemitido', 'Empenho anulado e refeito ao mesmo fornecedor', 'anulação + novo empenho mesmo CNPJ/valor em janela curta', 3, 'Lei 4.320/1964; LRF art. 42', 'disponivel', false),
  m('OR-08', 'Liquidações concentradas em fim de período', 'Pico de liquidações no fim do mês/exercício', 'fatia anormal das liquidações nos últimos 5 dias úteis', 2, 'Lei 4.320/1964 art. 63; LRF art. 42', 'disponivel', true),
  m('OR-09', 'Reforço de empenho atípico', 'Reforços sucessivos elevando empenho original', '≥3 reforços no mesmo empenho ou reforço > 50% do original', 2, 'Lei 4.320/1964 art. 60', 'disponivel', false),
  m('OR-10', 'Despesa em elemento incompatível', 'Objeto classificado em elemento de despesa que não corresponde', 'descrição do objeto sem aderência ao elemento de despesa', 2, 'Lei 4.320/1964 art. 12–13', 'disponivel', false),

  // ── 10. METAS FISCAIS E LRF ──────────────────────────────────────────────
  m('MF-01', 'Aplicação em Saúde abaixo do mínimo', 'Aplicação em saúde abaixo do piso constitucional', 'aplicação em saúde / receita de impostos < 15%', 5, 'EC 29/2000; LC 141/2012 art. 7º', 'disponivel', true),
  m('MF-02', 'Aplicação em Educação abaixo do mínimo', 'Aplicação em MDE abaixo do piso constitucional', 'aplicação em educação / receita de impostos < 25%', 5, 'CF art. 212', 'disponivel', true),
  m('MF-03', 'FUNDEB — magistério abaixo de 70%', 'Remuneração do magistério abaixo do mínimo do FUNDEB', 'aplicação em magistério / FUNDEB < 70%', 5, 'CF art. 212-A', 'disponivel', true),
  m('MF-04', 'Pessoal Executivo no limite/alerta', 'Despesa de pessoal do Executivo próxima/acima do teto', 'despesa pessoal / RCL: alerta ≥48,6% · prudencial ≥51,3% · limite >54%', 5, 'LRF art. 19–20, 22', 'disponivel', true),
  m('MF-05', 'Pessoal Câmara no limite', 'Despesa de pessoal da Câmara próxima/acima do teto', 'despesa pessoal Câmara / RCL > 6%', 4, 'LRF art. 20 II a; CF art. 29-A', 'disponivel', true),
  m('MF-06', 'Dívida consolidada acima do limite', 'Dívida consolidada líquida acima do teto do Senado', 'DCL / RCL > 120%', 4, 'Resolução Senado 40/2001', 'disponivel', false),
  m('MF-07', 'Resultado primário fora da meta', 'Resultado primário descumprindo a meta da LDO', 'resultado primário apurado < meta do Anexo de Metas Fiscais', 3, 'LRF art. 4º, 9º', 'parcial', false),
  m('MF-08', 'Resultado nominal fora da meta', 'Resultado nominal divergente da meta da LDO', 'resultado nominal apurado fora da faixa da meta', 3, 'LRF art. 4º', 'parcial', false),
  m('MF-09', 'Restos a pagar sem cobertura de caixa', 'RAP inscritos acima da disponibilidade de caixa', 'RAP inscritos > disponibilidade de caixa por fonte (art. 42)', 5, 'LRF art. 42', 'disponivel', true),
  m('MF-10', 'Restos a pagar antigos sem baixa', 'RAP de exercícios anteriores parados sem liquidação', 'RAP com inscrição > 2 anos sem baixa/pagamento', 3, 'LRF art. 42; Lei 4.320/1964', 'disponivel', false),
  m('MF-11', 'Atraso na publicação de RREO/RGF', 'Relatório fiscal não publicado dentro do prazo legal', 'data atual > prazo de publicação do RREO/RGF sem documento', 4, 'LRF art. 52, 55', 'disponivel', true),
  m('MF-12', 'Indicador fiscal em tendência de piora', 'Série histórica de um indicador piorando', 'indicador piora em ≥3 períodos consecutivos rumo ao limite', 3, 'LRF art. 59', 'disponivel', false),
  m('MF-13', 'Queda de investimento social em ano eleitoral', 'Investimento em saúde/educação cai no ano eleitoral', 'queda > 10% no investimento vs. exercício anterior', 4, 'LC 141/2012; CF 212', 'disponivel', false),
  m('MF-14', 'Arrecadação abaixo do previsto', 'Receita realizada muito abaixo da prevista na LOA', 'receita realizada / prevista no período < 90%', 3, 'LRF art. 9º, 59 §1º I', 'disponivel', true),

  // ── 11. DIÁRIO OFICIAL ───────────────────────────────────────────────────
  m('DO-01', 'Ato publicado fora do horário usual', 'Publicação de ato em horário/dia atípico', 'ato publicado em fim de semana, feriado ou fora do padrão', 2, 'Princípio da publicidade', 'disponivel', false),
  m('DO-02', 'Decreto de crédito sem amparo legal citado', 'Decreto de crédito sem indicação da lei autorizativa', 'decreto de crédito adicional sem referência à lei autorizativa', 3, 'Lei 4.320/1964 art. 42–43', 'disponivel', false),
  m('DO-03', 'Volume anormal de atos num único DOM', 'Edição concentrando número atípico de atos sensíveis', 'nº de atos sensíveis numa edição > média + 2 desvios', 2, 'Padrão estatístico', 'disponivel', true),
  m('DO-04', 'Republicação/retificação de ato sensível', 'Ato de contratação/nomeação retificado após publicação', 'retificação de extrato de contrato, dispensa ou nomeação', 2, 'Princípio da publicidade', 'disponivel', false),
  m('DO-05', 'Extrato de contrato sem dados essenciais', 'Extrato sem objeto, valor, prazo ou fornecedor', 'extrato de contrato/aditivo com campo essencial ausente', 3, 'Lei 14.133/2021 art. 94; LC 131/2009', 'disponivel', false),
  m('DO-06', 'Composição de comissão de licitação', 'Mapeia membros de comissões publicados (insumo XS-01)', 'extrair portarias de nomeação de comissão/agente de contratação', 1, 'Lei 14.133/2021 art. 8º', 'disponivel', false),
  m('DO-07', 'Fiscal de contrato — mapeamento', 'Mapeia designações de fiscais publicadas (insumo SA-12)', 'extrair portarias de designação de fiscal de contrato', 1, 'Lei 14.133/2021 art. 117', 'disponivel', false),
  m('DO-08', 'Sindicância/PAD aberto', 'Detecta abertura de sindicância ou PAD', 'publicação de instauração de sindicância/PAD', 2, 'Estatuto do servidor', 'disponivel', false),

  // ── 12. CONVÊNIOS, REPASSES E TERCEIRO SETOR ─────────────────────────────
  m('TS-01', 'Parceria sem plano de trabalho publicado', 'Termo de colaboração sem plano de trabalho ou prestação de contas', 'parceria com repasse + ausência de plano ou prestação de contas', 4, 'Lei 13.019/2014 art. 42, 63–69', 'parcial', false),
  m('TS-02', 'OSC com CNPJ inativo/suspenso', 'Entidade beneficiada com situação cadastral irregular', 'situação cadastral da OSC ≠ ATIVA na data do repasse', 5, 'Lei 13.019/2014 art. 39', 'parcial', false),
  m('TS-03', 'Prestação de contas fora do prazo', 'OSC não presta contas no prazo do MROSC', 'repasse + ausência de prestação de contas após 90 dias', 4, 'Lei 13.019/2014 art. 69', 'parcial', false),
  m('TS-04', 'Repasse sem chamamento público', 'Parceria sem chamamento e sem dispensa válida', 'termo de colaboração sem chamamento e sem fundamento de dispensa', 4, 'Lei 13.019/2014 art. 24, 30–32', 'parcial', false),
  m('TS-05', 'OSC com dirigente ligado a agente público', 'Entidade cujo dirigente tem vínculo com agente público', 'grafo: dirigente da OSC = servidor/agente ou parente', 5, 'Lei 13.019/2014 art. 39 III', 'integracao', false),
  m('TS-06', 'Emenda impositiva sem repasse', 'Emenda parlamentar impositiva não executada no prazo', 'emenda impositiva sem empenho/repasse após 90 dias do prazo', 3, 'CF art. 166 §§9º–18', 'disponivel', true),
  m('TS-07', 'Concentração de repasses numa OSC', 'Mesma entidade concentra fatia anormal das parcerias', 'uma OSC > 30% do valor de parcerias do exercício', 3, 'Lei 13.019/2014; impessoalidade', 'disponivel', false),
  m('TS-08', 'OSC de saúde sem habilitação válida', 'Entidade de saúde sem CEBAS recebendo recurso', 'OSC de saúde sem CEBAS ou habilitação válida + repasse', 4, 'Lei 12.101/2009; Lei 13.019/2014', 'integracao', false),
  m('TS-09', 'Despesa fora do plano de trabalho', 'Recurso de parceria aplicado em item não previsto', 'item da prestação de contas sem previsão no plano aprovado', 3, 'Lei 13.019/2014 art. 66', 'integracao', false),

  // ── 13. CRUZAMENTOS CROSS-SOURCE ─────────────────────────────────────────
  m('XS-01', 'Membro de comissão sócio de vencedora', 'Integrante de comissão de licitação é sócio da vencedora', 'grafo: CPF de membro de comissão ∈ sócios da empresa vencedora', 5, 'Lei 14.133/2021 art. 9º; Lei 8.429/1992', 'parcial', false),
  m('XS-02', 'Dispensa no DOM ausente do portal', 'Dispensa publicada no DOM sem empenho no portal', 'dispensa no DOM sem registro em DespesaAgrupada por nº de processo', 4, 'LC 131/2009; LAI; Lei 14.133 art. 94', 'parcial', true),
  m('XS-03', 'Decreto de crédito sem execução registrada', 'Decreto de crédito no DOM sem empenhos rastreáveis', 'decreto de crédito no DOM sem empenhos na dotação no prazo', 4, 'Lei 4.320/1964 art. 42–43', 'parcial', false),
  m('XS-04', 'Portaria de nomeação sem servidor na folha', 'Nomeação no DOM sem servidor correspondente na folha', 'portaria de nomeação no DOM sem nome/matrícula na folha em 2 meses', 5, 'CF art. 37; servidor fantasma', 'parcial', false),
  m('XS-05', 'Servidor sai da folha e vira PJ contratada', 'Ex-servidor recebendo como PJ logo após exoneração', 'nome de exonerado = sócio de CNPJ com contrato em até 12 meses', 5, 'Lei 14.133/2021 art. 9º §1º; Lei 8.429/1992', 'integracao', false),
  m('XS-06', 'Contrato publicado no DOM sem empenho', 'Extrato de contrato no DOM sem empenho correspondente', 'extrato de contrato no DOM sem empenho vinculado por nº', 3, 'Lei 14.133/2021 art. 94; LC 131/2009', 'parcial', false),
  m('XS-07', 'Empenho sem contrato/processo publicado', 'Empenho relevante sem contrato nem processo localizável', 'empenho > R$ 100k sem numeroContrato/numeroProcesso e sem extrato no DOM', 3, 'Lei 14.133/2021 art. 95; LC 131/2009', 'disponivel', true),
  m('XS-08', 'Norma alterada beneficiando fornecedor', 'Norma cria exceção que beneficia fornecedor específico', 'norma no SAPL abre exceção + contratação compatível em 60 dias', 5, 'CF art. 37; Lei 8.429/1992', 'integracao', false),
  m('XS-09', 'Saldo contábil ≠ extrato bancário', 'Divergência entre saldo declarado e caixa real', 'saldo contábil − saldo do extrato fora de tolerância', 4, 'LRF art. 42, 50; Lei 4.320/1964', 'parcial', false),
  m('XS-10', 'Empenho sem lastro de caixa', 'Empenho assumido sem disponibilidade financeira', 'empenho em fonte com disponibilidade de caixa insuficiente', 4, 'LRF art. 16–17, 42', 'parcial', false),
  m('XS-11', 'CEP de obra coincide com fornecedor', 'Endereço da obra é o mesmo de empresa fornecedora', 'CEP/endereço da obra = endereço de CNPJ fornecedor', 4, 'Lei 14.133/2021 art. 9º; Lei 8.429/1992', 'integracao', false),
  m('XS-12', 'CNPJ no endereço de agente público', 'Fornecedor com endereço de servidor/agente ou parente', 'endereço de CNPJ contratado = endereço de agente público', 5, 'Lei 14.133/2021 art. 9º §1º; Lei 8.429/1992', 'integracao', false),
  m('XS-13', 'Reclamação no e-SIC × execução orçamentária', 'Tema com muitas reclamações e gasto declarado no serviço', 'pico de manifestações no e-SIC + despesa relevante no mesmo serviço', 3, 'LAI; LC 131/2009', 'integracao', false),
  m('XS-14', 'Apontamento do TCE-SP sobre fornecedor', 'Fornecedor/contrato local citado em julgado do TCE-SP', 'match de CNPJ/nº de processo entre o município e a base do TCE-SP', 4, 'CF art. 31 (competência do TCE-SP)', 'integracao', false),

  // ── 14. RECEITA E RENÚNCIA ───────────────────────────────────────────────
  m('RC-01', 'Queda atípica de arrecadação de tributo', 'Receita de um tributo cai de forma anômala', 'arrecadação mensal de um tributo < média 12m − 2 desvios', 2, 'LRF art. 11', 'disponivel', true),
  m('RC-02', 'Receita prevista sem realização', 'Rubrica orçada na LOA sem arrecadação correspondente', 'rubrica de receita prevista com realização ≈ 0 no exercício', 2, 'Lei 4.320/1964; LRF art. 12', 'disponivel', false),
  m('RC-03', 'Renúncia de receita sem estimativa de impacto', 'Benefício fiscal sem o estudo exigido pela LRF', 'norma de renúncia sem estimativa de impacto orçamentário', 3, 'LRF art. 14', 'parcial', false),
  m('RC-04', 'Dívida ativa estagnada', 'Estoque de dívida ativa sem cobrança/baixa relevante', 'dívida ativa cresce e arrecadação de dívida ativa ≈ 0', 2, 'LRF art. 11, 13; Lei 8.429/1992', 'parcial', false),
  m('RC-05', 'Receita de transferência abaixo do esperado', 'Transferências muito abaixo do previsto', 'FPM/ICMS/transferências realizadas << previsto sem causa macro', 2, 'Lei 4.320/1964', 'disponivel', false),
  m('RC-06', 'Lançamento de receita inconsistente entre fontes', 'Receita do portal diverge da reportada ao SICONFI', 'receita total do portal ≠ receita do RREO no mesmo período', 3, 'LRF art. 51; LC 131/2009', 'parcial', false),
];

export function contarPorStatus(): Record<StatusMon, number> {
  const r: Record<StatusMon, number> = { ativo: 0, computavel: 0, planejado: 0 };
  for (const c of CATALOGO) r[c.status]++;
  return r;
}

export const TOTAL_MONITORAMENTOS = CATALOGO.length;
