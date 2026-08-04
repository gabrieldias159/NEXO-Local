# NEXO — Requerimentos Recomendados & Briefing de Achados

### Núcleo de Enfrentamento e Inteligência Pública

**Câmara Municipal de Marília/SP — Gabinete Vereador Fefin**
Documento operacional v1.0 · 2026-05-21
Autoria: LASTRO (Analista de Dados · Inteligência de Marília) · complementa
`docs/nexo-plano-mestre.md` e `docs/transparencia-analise-preliminar.md`

---

## 0. Para que serve este documento

Este documento responde a dois pedidos diretos do gabinete:

1. **"Receber recomendações de requerimentos para investigar suspeitas
   encontradas."** → **Parte 1** entrega 12 requerimentos-modelo, um por tipo
   de achado que o NEXO pode produzir. Cada modelo é texto pronto para
   adaptar: o que pedir, que perguntas objetivas fazer, qual o fundamento.
2. **"Ser assessorado do que está acontecendo de errado na coisa pública."**
   → **Parte 2** entrega um briefing inicial priorizado a partir dos achados
   preliminares reais de Marília, e propõe uma feature de assessoria
   periódica recorrente dentro do NEXO.

> **Regra de linguagem (plano-mestre §2, inegociável):** tudo aqui é
> **indício a apurar** — "possível indício", "inconsistência documental",
> "requer apuração", "hipótese de enquadramento". Nada é acusação. Um
> requerimento de informação **não imputa irregularidade**: ele pede os
> documentos que confirmam ou afastam a hipótese. Essa é a postura correta —
> e também a mais segura juridicamente para o vereador.

---

## 0.1 Como funciona um requerimento de informação (praxe brasileira)

Síntese da praxe legislativa municipal, para calibrar os modelos:

- **Natureza.** O requerimento de informação é o instrumento pelo qual o
  vereador pede formalmente documentos e esclarecimentos ao Poder Executivo.
  É a porta de entrada da fiscalização — antes de CPI, antes de denúncia ao
  TCE/MP.
- **Fundamento.** Apoia-se em três pilares combinados: (a) **CF art. 5º,
  XXXIII e art. 31** — direito de acesso à informação e competência
  fiscalizatória do Legislativo municipal; (b) **Lei 12.527/2011 (LAI)** — o
  vereador pode requerer informação como qualquer cidadão; (c) **Lei
  Orgânica do Município de Marília e Regimento Interno da Câmara** — que
  disciplinam o rito local e o prazo de resposta. *Verificar os artigos
  exatos da LOM de Marília e do Regimento da Câmara antes de protocolar — o
  número do artigo deve constar no requerimento.*
- **Entendimento dos tribunais.** STF e TJ-SP firmaram que o vereador pode
  pedir informação **diretamente ao Executivo, com base na LAI, sem depender
  de aprovação do plenário**. Na prática, muitas câmaras ainda submetem o
  requerimento a votação — convém usar os dois caminhos conforme o Regimento
  local, sabendo que a recusa de resposta é, por si, ato sindicável.
- **Prazo.** A LAI assegura acesso imediato ao que está disponível e, quando
  não, resposta em **até 20 dias** (prorrogável por 10, art. 11). A LOM pode
  fixar prazo próprio (frequentemente 15 ou 30 dias). **Não respondido o
  requerimento no prazo, há omissão** — fato que sustenta reiteração,
  representação ao Ministério Público e, conforme o caso, ação por
  improbidade por negativa de publicidade.
- **Boa prática de redação.** Pedidos numerados e objetivos (não "informe
  tudo sobre X", mas "encaminhe cópia de Y referente ao período Z");
  identificação precisa do objeto (número de processo, empenho, contrato);
  prazo citado; fundamento citado; tom institucional e não acusatório.

> **Padrão NEXO:** todo requerimento gerado pelo módulo nasce de uma
> investigação com os 3 scores e evidências anexadas. O texto descreve o
> **indício** ("foram identificados, em dados públicos, os seguintes
> padrões..."), nunca a conclusão. O botão "Gerar requerimento" (plano-mestre
> §9) pré-preenche o editor do `oficioexpress` com um destes 12 modelos.

---

# PARTE 1 — REQUERIMENTOS RECOMENDADOS (12 MODELOS)

Cada modelo segue a mesma estrutura:
**Quando usar · Fundamento · Documentos a solicitar · Perguntas objetivas ·
Texto-base · Próximo passo se não responderem.**

Os `[campos entre colchetes]` são preenchidos pelo NEXO a partir da
investigação (CNPJ, número de empenho, valores, datas). Os modelos são
genéricos e municipais — adaptáveis a qualquer achado da mesma família.

---

## R01 — Fracionamento de despesa / dispensas repetidas

**Quando usar.** Processador P1. ≥3 dispensas ao mesmo CNPJ em 90 dias com
soma acima do limite do exercício; sequência de contratações logo abaixo do
limite; mesmo objeto pulverizado entre secretarias.

**Fundamento.** Lei 14.133/2021, art. 75, II e §1º (vedação ao fracionamento
para fugir da modalidade); CF art. 37 (legalidade, impessoalidade,
moralidade, publicidade, eficiência); LAI art. 7º. Limites de dispensa de
**2026**: R$ 62.725,59 (compras/serviços) e R$ 125.451,15
(obras/engenharia) — usar sempre o limite do exercício do empenho.

**Documentos a solicitar.**
1. Cópia integral dos processos de contratação direta `[lista de processos
   administrativos]` celebrados com `[fornecedor / CNPJ]` no período
   `[período]`.
2. Justificativa de cada dispensa, estudo técnico preliminar e termo de
   referência.
3. Pesquisas de preço que embasaram cada contratação (com identificação das
   empresas consultadas).
4. Pareceres jurídicos e da controladoria interna sobre cada processo.
5. Notas de empenho, liquidação, notas fiscais e comprovantes de execução.
6. Relação de todas as contratações do mesmo objeto, no exercício, por todas
   as secretarias.

**Perguntas objetivas.**
- Houve planejamento anual de contratações (PCA) que previsse esse objeto?
  Em caso positivo, por que não foi licitado na modalidade correspondente ao
  valor total anual?
- Qual o critério adotado para enquadrar cada contratação como dispensa,
  considerando que a soma no período supera o limite legal?
- As contratações de objeto idêntico em secretarias diferentes foram
  comunicadas entre si para fins de cômputo do valor global?

**Texto-base.**
> "Requeiro, com base no art. 5º, XXXIII, e art. 31 da Constituição Federal,
> na Lei nº 12.527/2011 e no [art. ___ da Lei Orgânica do Município /
> Regimento Interno], que o Poder Executivo encaminhe a este vereador as
> informações e documentos abaixo, tendo em vista que a análise de dados
> públicos do Portal da Transparência identificou possível indício de
> fracionamento de despesa: foram constatadas [n] contratações diretas em
> favor de [fornecedor], no período de [período], somando R$ [valor], objeto
> [objeto]. Esclareço que o presente pedido não imputa irregularidade,
> destinando-se a verificar a regularidade do procedimento."

**Se não responderem.** Reiterar; representar ao Ministério Público por
negativa de publicidade (LAI); encaminhar o indício ao TCE-SP/AUDESP, que já
recebe os dados de licitações e contratos do município.

---

## R02 — Sobrepreço / superfaturamento de obra

**Quando usar.** Processador P2. Preço unitário acima de SINAPI/SICRO; curva
ABC distorcida (jogo de planilha); % financeiro pago acima do % físico
medido; aditivos em cadeia.

**Fundamento.** Lei 14.133/2021, arts. 23 (referência de preços), 125
(limites de aditivo: 25% / 50% reforma) e 6º; Lei 8.429/1992; Lei
12.846/2013. Referência de preço: SINAPI e SICRO são as tabelas oficiais.

**Documentos a solicitar.**
1. Planilha orçamentária completa da obra `[obra / contrato]`, com preços
   unitários, quantitativos e composição de BDI.
2. Projeto básico/executivo e ART/RRT do responsável técnico.
3. Todos os boletins de medição, com memória de cálculo e relatório
   fotográfico datado.
4. Todos os termos aditivos (de valor e de prazo), com justificativa técnica
   e percentual acumulado.
5. Notas fiscais, ordens de serviço e comprovantes de pagamento.
6. Cronograma físico-financeiro original e atualizado.

**Perguntas objetivas.**
- Qual a fonte de referência de preços utilizada na composição do orçamento?
  Para os itens cujo preço unitário supera a referência SINAPI/SICRO, qual a
  justificativa técnica?
- Qual o percentual físico efetivamente medido na data do último pagamento e
  qual o percentual financeiro já desembolsado?
- A soma dos aditivos de valor ultrapassa 25% (ou 50%, se reforma) do valor
  original do contrato?

**Texto-base.**
> "...a análise de dados públicos identificou possível indício de
> incompatibilidade entre os preços contratados na obra [obra] e as
> referências oficiais (SINAPI/SICRO), bem como possível descompasso entre o
> avanço físico e o avanço financeiro. Requer-se o encaminhamento dos
> documentos abaixo para verificação."

**Se não responderem.** Representação ao TCE-SP (competente para auditoria
de obras); ao MP-SP; solicitar inspeção da Controladoria Interna.

---

## R03 — Combustível / consumo de frota incompatível

**Quando usar.** Processador P3. Consumo km/l incompatível com o veículo;
abastecimento acima da capacidade do tanque; veículo parado com consumo;
abastecimento em fim de semana/feriado; concentração em um único posto.

**Fundamento.** CF art. 37; Lei 14.133/2021; Lei 8.429/1992; Lei 4.320/1964
(comprovação da despesa). Combustível é, conforme o conhecimento de detecção
do plano-mestre §1, um dos três primeiros pontos de auditoria.

**Documentos a solicitar.**
1. Relação completa da frota municipal: placa, secretaria de lotação, tipo e
   capacidade de tanque.
2. Relatório analítico de abastecimentos do período `[período]` por veículo:
   data, hora, litros, valor, hodômetro, posto, condutor.
3. Diários de bordo dos veículos `[lista de placas]`.
4. Contrato de fornecimento de combustível e/ou de gestão de cartão-frota.
5. Notas fiscais de abastecimento e ordens de serviço de manutenção.

**Perguntas objetivas.**
- Como é controlada a quilometragem para fins de aferição de consumo?
- Para os abastecimentos cujo volume registrado supera a capacidade do
  tanque do veículo, qual a explicação?
- Os veículos `[placas]`, registrados como inativos/em manutenção, tiveram
  abastecimentos no período? Em caso positivo, qual a justificativa?

**Texto-base.**
> "...a análise de dados públicos identificou possível indício de
> inconsistência entre o consumo de combustível registrado, a capacidade dos
> veículos e a quilometragem informada da frota municipal..."

**Se não responderem.** Reiterar; representar ao MP-SP; sugerir auditoria da
Controladoria.

---

## R04 — Medicamento/insumo pago sem comprovação de entrega

**Quando usar.** Processador P4. Pagamento sem entrada em estoque; nota
fiscal sem correspondência no almoxarifado; entrega parcial registrada como
total; preço acima do Banco de Preços em Saúde.

**Fundamento.** Lei 14.133/2021; Lei 4.320/1964, art. 63 (liquidação =
verificação do direito adquirido, comprovação da entrega); Lei 8.429/1992;
normas do SUS. Almoxarifado da saúde é o terceiro ponto crítico do §1.

**Documentos a solicitar.**
1. Notas fiscais e empenhos das aquisições `[itens / processos]` do
   fornecedor `[CNPJ]`.
2. Registros de entrada no almoxarifado/farmácia (com lote e validade) e
   termos de recebimento assinados.
3. Relatórios de distribuição às unidades de saúde.
4. Identificação dos servidores responsáveis pela conferência e pela
   liquidação de cada nota.
5. Pesquisa de preços e comparativo com o Banco de Preços em Saúde.

**Perguntas objetivas.**
- A quantidade registrada na nota fiscal `[nº]` corresponde à quantidade
  efetivamente lançada como entrada no sistema de estoque?
- Qual servidor atestou o recebimento e qual atestou a liquidação?
- Os preços unitários contratados são compatíveis com o Banco de Preços em
  Saúde para os mesmos itens no período?

**Texto-base.**
> "...a análise identificou possível indício de divergência entre o
> quantitativo de medicamentos/insumos faturado e pago e o quantitativo
> registrado em estoque..."

**Se não responderem.** MP-SP; TCE-SP; Conselho Municipal de Saúde;
Controladoria.

---

## R05 — Contrato emergencial repetido / falta de planejamento

**Quando usar.** Processador P5. >1 emergência para o mesmo objeto em 12
meses; emergencial logo após o fim de contrato previsível; mesmo fornecedor
emergencial recorrente; objeto previsível classificado como urgente.

**Fundamento.** Lei 14.133/2021, art. 75, VIII (dispensa emergencial — exige
imprevisibilidade) e art. 18 (planejamento); CF art. 37.

**Documentos a solicitar.**
1. Processos de contratação emergencial `[lista]` do objeto `[objeto]` nos
   últimos 24 meses.
2. Justificativa da emergência e da imprevisibilidade em cada caso.
3. Contrato anterior do mesmo objeto, com data de vencimento, e cronograma
   da licitação que deveria tê-lo sucedido.
4. Pareceres jurídicos e pesquisas de preço.

**Perguntas objetivas.**
- O objeto `[objeto]` é de natureza contínua e previsível? Em caso positivo,
  o que caracterizou a emergência?
- Havia contrato anterior com vencimento conhecido? Por que a licitação
  ordinária não foi concluída antes do término?
- Por que o mesmo fornecedor foi contratado em caráter emergencial mais de
  uma vez para o mesmo objeto?

**Texto-base.**
> "...a análise identificou possível indício de uso reiterado de contratação
> emergencial para objeto de natureza previsível e contínua, o que pode
> sugerir falha de planejamento..."

**Se não responderem.** TCE-SP; MP-SP.

---

## R06 — Show/evento por inexigibilidade ("farra dos shows")

**Quando usar.** Processador P6. Cachê incompatível com o porte do
município; contratação por empresa intermediária recém-criada; carta de
exclusividade frágil; emenda parlamentar vinculada; palco que vira palanque.

**Fundamento.** Lei 14.133/2021, art. 74, II (inexigibilidade para artista —
exige consagração e exclusividade comprovada); Lei 9.504/1997 (condutas
vedadas em ano eleitoral); CF art. 37.

**Documentos a solicitar.**
1. Processo integral de inexigibilidade `[nº]`, incluindo a carta de
   exclusividade e a comprovação de consagração do artista.
2. Comprovação de que a contratada `[CNPJ]` é representante exclusiva do
   artista (e não mera intermediária).
3. Pesquisa de cachês praticados pelo mesmo artista em eventos comparáveis.
4. Origem dos recursos (emenda parlamentar, fonte, programa).
5. Plano de comunicação do evento e relatório de execução.

**Perguntas objetivas.**
- A empresa contratada é a representante exclusiva do artista para todo o
  território nacional, ou apenas para a praça/data? Qual a data de abertura
  do CNPJ?
- O cachê pago é compatível com o praticado pelo artista em municípios de
  porte semelhante?
- Houve uso de imagem ou nome de agente político na divulgação do evento
  custeado com recurso público?

**Texto-base.**
> "...a análise identificou possível indício de fragilidade na justificativa
> de inexigibilidade da contratação artística [evento], notadamente quanto à
> comprovação de exclusividade e à compatibilidade do valor..."

**Se não responderem.** TCE-SP; MP-SP; em ano eleitoral, observar prazos do
calendário eleitoral para eventual representação ao MP Eleitoral.

---

## R07 — Diária mal prestada / "trenzinho da alegria"

**Quando usar.** Processador P6. Diária sem relatório de viagem, sem
comprovante de presença ou sem resultado demonstrável; mesmo servidor com
muitas diárias/mês; grupo fixo de viajantes; destino sem relação com a
função.

**Fundamento.** Lei 4.320/1964 (comprovação da despesa); legislação
municipal de diárias e regulamento interno; CF art. 37; Lei 8.429/1992.

**Documentos a solicitar.**
1. Portarias de concessão das diárias a `[beneficiário]` no período
   `[período]`.
2. Relatórios de viagem, certificados de participação e comprovantes de
   presença de cada deslocamento.
3. Comprovantes de hospedagem e transporte.
4. Demonstração do interesse público e da relação da viagem com as
   atribuições do cargo.

**Perguntas objetivas.**
- Foram apresentados, no prazo regulamentar, relatório de viagem e
  comprovação de comparecimento para cada diária concedida?
- Qual o resultado/produto da participação do servidor em cada evento?
- O destino e o objeto das viagens guardam relação com as atribuições do
  cargo `[cargo]`?

**Texto-base.**
> "...a análise identificou possível indício de ausência de prestação de
> contas de diárias concedidas a [beneficiário], que acumulou [n] diárias no
> período somando R$ [valor]..."

**Se não responderem.** Controladoria; TCE-SP; MP-SP.

---

## R08 — Fornecedor de outra UF em serviço presencial

**Quando usar.** Cruzamento especial. Empresa com sede em UF distante
prestando serviço público continuado e presencial em Marília (caso real: M
Construções & Serviços, Natal/RN, coleta de lixo).

**Fundamento.** Lei 14.133/2021, arts. 5º (isonomia, competitividade) e 37
(habilitação); CF art. 37. *Atenção: ser de outra UF não é, por si,
irregularidade — o que se apura é o edital e a capacidade de execução
local.*

**Documentos a solicitar.**
1. Edital completo da licitação `[processo]` e seus anexos (termo de
   referência, exigências de habilitação técnica).
2. Ata da sessão, relação de licitantes participantes e propostas.
3. Comprovação da estrutura local da contratada `[CNPJ]`: filial, garagem,
   veículos, mão de obra em Marília.
4. Contrato, aditivos e eventuais autorizações de subcontratação.
5. Relatórios de fiscalização da execução do serviço.

**Perguntas objetivas.**
- O edital previa exigências de capacidade técnica e operacional compatíveis
  com a natureza presencial e continuada do serviço?
- A contratada mantém estrutura física e operacional própria em Marília, ou
  o serviço é subcontratado? Há autorização para subcontratação?
- Quantas empresas participaram do certame e qual a diferença entre as
  propostas?

**Texto-base.**
> "...a análise identificou que o serviço presencial e continuado de
> [objeto] é executado por empresa com sede em [UF], o que motiva o pedido
> de verificação do edital, das exigências de habilitação e da estrutura
> local de execução..."

**Se não responderem.** TCE-SP; MP-SP.

---

## R09 — Inexigibilidade/dispensa elevada — sole-source recorrente

**Quando usar.** Detector A04 / núcleo de Modalidade. Volume alto de
INEXIGIBILIDADE + DISPENSA + DISPENSADA frente ao total empenhado; objeto que
poderia ter sido licitado de forma competitiva.

**Fundamento.** Lei 14.133/2021, arts. 74 e 75 (hipóteses taxativas de
contratação direta); CF art. 37, XXI (regra é a licitação).

**Documentos a solicitar.**
1. Relação de todos os contratos por inexigibilidade e por dispensa do
   exercício `[ano]`, com objeto, fornecedor, valor e fundamento legal
   invocado.
2. Para os 10 maiores valores: processo administrativo integral.
3. Justificativa de cada enquadramento como contratação direta.
4. Demonstração de inviabilidade de competição (inexigibilidade) ou de
   adequação à hipótese de dispensa.

**Perguntas objetivas.**
- Qual o percentual do orçamento executado por contratação direta
  (inexigibilidade + dispensa) no exercício, e como ele se compara aos
  exercícios anteriores?
- Para os contratos de maior valor por inexigibilidade, qual o elemento que
  caracteriza a inviabilidade de competição?
- Existe planejamento para substituir contratações diretas recorrentes por
  licitação ordinária?

**Texto-base.**
> "...a análise de dados públicos do Portal da Transparência identificou que
> as modalidades de contratação direta concentram parcela expressiva do
> orçamento municipal, o que motiva o pedido de esclarecimento sobre os
> fundamentos adotados..."

**Se não responderem.** TCE-SP/AUDESP; MP-SP.

---

## R10 — Nepotismo / nomeações de risco

**Quando usar.** Processador de folha / cruzamento. Servidor comissionado com
sobrenome de gestor nomeado por livre escolha; nomeações concentradas no
período pré-eleitoral; portaria de nomeação no DOM sem servidor
correspondente na folha.

**Fundamento.** CF art. 37; **Súmula Vinculante 13 do STF** (vedação ao
nepotismo); Lei 9.504/1997, art. 73, V (vedação de nomeações no período
eleitoral, com ressalvas). *Linguagem cuidadosa: trata-se de verificar
vínculo e regularidade da nomeação, não de afirmar parentesco.*

**Documentos a solicitar.**
1. Relação dos cargos em comissão e funções de confiança, com nome,
   lotação, atribuições e data de nomeação.
2. Atos de nomeação publicados no período `[período]`.
3. Declarações de inexistência de vínculo de parentesco exigidas pela
   administração (declarações de nepotismo).
4. Critérios de escolha para os cargos de livre nomeação.

**Perguntas objetivas.**
- Quantas nomeações para cargo em comissão ocorreram nos 90 dias anteriores
  ao período vedado pela legislação eleitoral?
- A administração colhe declaração de inexistência de parentesco no momento
  da nomeação? Essas declarações estão disponíveis?
- As portarias de nomeação publicadas no Diário Oficial têm servidor
  correspondente registrado na folha de pagamento?

**Texto-base.**
> "...a análise identificou padrões nas nomeações para cargos em comissão que
> motivam o pedido de informações para verificação de conformidade com a
> Súmula Vinculante 13 e com a legislação eleitoral..."

**Se não responderem.** MP-SP; em período eleitoral, MP Eleitoral.

---

## R11 — Estouro de limite fiscal / mínimos constitucionais

**Quando usar.** Subsistema de Metas Fiscais. Aplicação em saúde abaixo de
15% ou em educação abaixo de 25%; despesa de pessoal acima da faixa
prudencial da LRF; restos a pagar acima da disponibilidade de caixa; RREO/RGF
publicado fora do prazo.

**Fundamento.** CF art. 212 (educação) e art. 212-A (FUNDEB); EC 29 / LC
141/2012 (saúde); LRF (LC 101/2000), arts. 19–20 (pessoal), 42 (restos a
pagar), 52 e 55 (prazos de RREO/RGF). Conforme o §6 do plano-mestre, **a
causa nº 1 de rejeição de contas costuma ser estouro de limite ou perda de
prazo — não desvio.**

**Documentos a solicitar.**
1. Relatório Resumido de Execução Orçamentária (RREO) e Relatório de Gestão
   Fiscal (RGF) dos últimos bimestres/quadrimestres, com datas de publicação.
2. Demonstrativo da aplicação em saúde e em educação no exercício.
3. Demonstrativo da despesa total com pessoal frente à RCL.
4. Demonstrativo de restos a pagar e da disponibilidade de caixa por fonte.
5. Plano de recondução aos limites, se algum limite prudencial ou de alerta
   houver sido atingido.

**Perguntas objetivas.**
- Os percentuais aplicados em saúde e educação no exercício atingem os
  mínimos constitucionais? Como se comparam à série dos últimos 3 anos?
- A despesa com pessoal encontra-se abaixo do limite prudencial da LRF? Há
  medidas de contenção em curso?
- Os relatórios RREO e RGF foram publicados dentro dos prazos legais?

**Texto-base.**
> "...a análise de dados fiscais públicos (SICONFI/STN e relatórios LRF)
> identificou possível indício de [aproximação de limite / aplicação abaixo
> do mínimo / publicação fora de prazo], o que motiva o pedido dos
> demonstrativos para verificação..."

**Se não responderem.** TCE-SP (jurisdição direta sobre LRF e mínimos);
MP-SP.

---

## R12 — Divergência DOM × Portal da Transparência

**Quando usar.** Cruzamento especial. Dispensa/contrato publicado no Diário
Oficial sem empenho correspondente no Portal (ou o inverso); decreto de
crédito adicional sem registro de execução; pagamento sem publicação do
contrato.

**Fundamento.** LC 131/2009 e LAI (transparência ativa em tempo real); Lei
4.320/1964; CF art. 37 (publicidade).

**Documentos a solicitar.**
1. Extrato/íntegra do contrato `[nº]` publicado no DOM em `[data]` e o
   empenho correspondente.
2. Esclarecimento sobre a ausência, no Portal da Transparência, do
   contrato/dispensa `[identificação]` publicado no DOM.
3. Para decretos de abertura de crédito adicional: demonstrativo da execução
   dentro do prazo legal.
4. Cronograma de atualização dos dados do Portal da Transparência.

**Perguntas objetivas.**
- O contrato/dispensa `[identificação]`, publicado no Diário Oficial, consta
  no Portal da Transparência? Em caso negativo, por quê?
- Os dados de despesa do Portal são atualizados em tempo real, conforme a LC
  131/2009? Qual a defasagem média?

**Texto-base.**
> "...a análise comparativa entre o Diário Oficial do Município e o Portal da
> Transparência identificou possível inconsistência de publicidade: o ato
> [identificação] consta em uma fonte e não na outra..."

**Se não responderem.** MP-SP (negativa de transparência); TCE-SP;
Controladoria-Geral.

---

## 1.1 Tabela de uso rápido

| # | Achado / Processador | Modalidade-alvo | Encaminhamento se omisso |
|---|---|---|---|
| R01 | Fracionamento (P1) | Dispensa | MP-SP, TCE-SP |
| R02 | Sobrepreço de obra (P2) | Obra/contrato | TCE-SP, MP-SP |
| R03 | Combustível (P3) | Frota | MP-SP, Controladoria |
| R04 | Medicamento sem entrega (P4) | Saúde | MP-SP, TCE-SP, CMS |
| R05 | Emergencial repetido (P5) | Emergência | TCE-SP, MP-SP |
| R06 | Show por inexigibilidade (P6) | Inexigibilidade | TCE-SP, MP/MP Eleitoral |
| R07 | Diária mal prestada (P6) | Diárias | Controladoria, TCE-SP |
| R08 | Fornecedor de outra UF | Serviço presencial | TCE-SP, MP-SP |
| R09 | Inexigibilidade/dispensa alta | Contratação direta | TCE-SP/AUDESP, MP-SP |
| R10 | Nepotismo / nomeações | Folha/comissão | MP-SP, MP Eleitoral |
| R11 | Estouro de limite fiscal | LRF / mínimos | TCE-SP, MP-SP |
| R12 | Divergência DOM × Portal | Publicidade | MP-SP, TCE-SP |

> Cada modelo é a **minuta inicial**. A revisão humana obrigatória
> (plano-mestre §2.3) ajusta valores, datas e os artigos exatos da Lei
> Orgânica de Marília e do Regimento Interno antes do protocolo.

---

# PARTE 2 — BRIEFING INICIAL DE ASSESSORIA

## 2.1 Leitura geral — "o que parece estar acontecendo"

A partir dos achados preliminares reais de Marília
(`transparencia-analise-preliminar.md`), o quadro inicial é o seguinte —
**tudo indício a apurar, nada conclusão**:

O orçamento de Marília em 2026 gira em torno de **R$ 811 milhões**. Dentro
dele, há um volume relevante de despesa que **não passou por disputa
competitiva**: DISPENSA, DISPENSADA e INEXIGIBILIDADE somam, juntas, **cerca
de R$ 110 milhões** (≈ 13,5% do total empenhado). Isso, por si, não é
ilícito — a lei admite contratação direta em hipóteses específicas. Mas é um
volume que **exige acompanhamento**: a regra constitucional é a licitação, e
a contratação direta é a exceção que precisa de fundamento caso a caso.

Sobre esse pano de fundo, quatro fatos concretos chamam atenção e merecem
ser olhados primeiro.

---

## 2.2 Achados prioritários (ordenados por relevância)

### 🔴 Prioridade 1 — M Construções & Serviços (coleta de lixo, ~R$ 24M/ano)

**O fato.** O CNPJ 02.823.335/0001-35, com sede em **Natal/RN**, é o 2º
maior fornecedor do município em 2026, com contrato estimado em **~R$ 24
milhões/ano** para coleta de resíduos sólidos domiciliares — serviço
**presencial, continuado e diário**. Origem: Processo 2/2024, modalidade
registrada sob código 90 ("Outros/Não Aplicável"). Empenho #87 de
07/01/2026: R$ 6 milhões parciais.

**Por que é prioridade 1.** É o maior valor sob possível indício, é serviço
essencial visível para o cidadão, e o cruzamento UF-sede × natureza do
serviço é forte: a execução presencial diária por empresa de outro estado
levanta a hipótese de subcontratação ou de edital com exigências que não
selecionaram fornecedores locais. **A relevância financeira sozinha já
satisfaz um dos gatilhos de "alerta → investigação".**

**O que olhar.** Edital do Processo 2/2024 e suas exigências de habilitação;
estrutura local da contratada (garagem, frota, mão de obra em Marília);
número de licitantes; existência de subcontratação; o porquê do
enquadramento sob código "90".

**Requerimento.** R08 (fornecedor de outra UF) + R09 (modalidade/código).

### 🔴 Prioridade 2 — Concentração de contratação direta (~R$ 110M sem concorrência)

**O fato.** INEXIGIBILIDADE (R$ 54,4M) + DISPENSA (R$ 19,0M) + DISPENSADA
(R$ 36,8M) ≈ **R$ 110 milhões** executados fora do regime competitivo.

**Por que é prioridade 2.** É um padrão estrutural, não um caso isolado.
Não se conclui irregularidade a partir do volume — mas o volume define
**onde a fiscalização deve concentrar esforço**. Dentro desses R$ 110M
estarão os candidatos naturais a fracionamento (P1), emergência repetida
(P5) e inexigibilidade frágil (P6).

**O que olhar.** Os 10 maiores contratos por inexigibilidade e por dispensa;
o fundamento legal invocado em cada um; a evolução do percentual de
contratação direta em relação a exercícios anteriores.

**Requerimento.** R09 (sole-source recorrente); R01 para os casos de
fracionamento que a análise detalhar.

### 🟡 Prioridade 3 — HU / Associação Beneficente com 3 CNPJs (~R$ 6,8M)

**O fato.** Três CNPJs da mesma raiz (09.528.436/0001-22, /0002-03,
/0003-94) somam **R$ 6,8 milhões**. Pode ser perfeitamente regular — filiais
distintas vinculadas a unidades gestoras distintas. Mas pode também indicar
distribuição de contratações entre filiais para manter cada empenho abaixo
do limiar de uma modalidade mais rigorosa.

**Por que é prioridade 3.** Valor relevante e padrão que merece
esclarecimento, mas com explicação legítima plausível — não se deve tratar
como suspeita até a análise por CNPJ raiz confirmar (ou afastar) o padrão.

**O que olhar.** Objeto de cada contratação por filial; se os objetos são
correlatos; se a soma por CNPJ raiz cruzaria um limite de modalidade.

**Requerimento.** R01 (fracionamento) — apenas se a análise por raiz
confirmar objeto correlato somando acima de limite.

### 🟡 Prioridade 4 — PRIME Consultoria (R$ 2,7M + restos a pagar)

**O fato.** PRIME Consultoria e Assessoria (CNAE: consultoria em gestão
empresarial) aparece com **R$ 2,7M** em empenhos 2026 e também em **Restos a
Pagar de 2025**. Valor elevado de consultoria para um município de ~250 mil
habitantes.

**Por que é prioridade 4.** Consultoria é objeto frequentemente contratado
por inexigibilidade ("serviço técnico especializado de natureza singular") —
hipótese que exige demonstração robusta. A presença simultânea em restos a
pagar sugere relação contratual que se arrasta entre exercícios.

**O que olhar.** Objeto exato da consultoria; modalidade de contratação;
justificativa de eventual inexigibilidade; produtos/relatórios entregues.

**Requerimento.** R09; e R04/R05 adaptados se o objeto for serviço
continuado mal enquadrado.

### 🟡 Prioridade 5 — Concentração de diárias

**O fato.** Em amostra de 500 registros (de 1.652 em 2026), destacam-se
beneficiários com acúmulo atípico: um servidor com **R$ 12.750 em 6
empenhos** e outro com **8 empenhos** separados no período.

**Por que é prioridade 5.** Valores individualmente baixos, mas o padrão de
concentração (mesmo beneficiário, alta frequência) é exatamente o sinal do
"trenzinho da alegria". É o achado de menor valor financeiro, mas o de
apuração mais simples e rápida — bom candidato para um primeiro requerimento
de baixo custo político e alta didática.

**O que olhar.** Cargo e lotação dos beneficiários; se as datas de viagens
se sobrepõem; existência de relatórios de viagem e comprovantes de presença;
relação dos destinos com a função.

**Requerimento.** R07 (diária mal prestada).

---

## 2.3 Sequência de ação recomendada para o gabinete

1. **Semana 1 — Fechar a base.** Concluir a varredura completa de
   `DespesaAgrupada` e `fornecedor` 2026 (não apenas a amostra de 500),
   enriquecer CNPJs via BrasilAPI e consolidar o ranking real por valor e
   por modalidade. Sem isso, todo achado é parcial.
2. **Semana 1–2 — Primeiro requerimento, baixo risco.** Protocolar R07
   (diárias) — apuração simples, didática, demonstra o método sem expor o
   gabinete. Serve de teste do prazo de resposta do Executivo.
3. **Semana 2–3 — O achado-âncora.** Protocolar R08 + R09 sobre M
   Construções / coleta de lixo. É o maior valor e o de maior visibilidade
   pública.
4. **Semana 3–4 — O padrão estrutural.** Protocolar R09 sobre o conjunto da
   contratação direta (~R$ 110M), pedindo os 10 maiores e a série histórica.
5. **Contínuo — Metas fiscais.** Acompanhar saúde 15% / educação 25% /
   pessoal LRF / prazos de RREO-RGF; protocolar R11 ao primeiro sinal de
   limite tangenciado ou prazo perdido.
6. **Sempre — Revisão humana antes de cada protocolo** e disclaimer em todo
   material exportado.

> **Postura recomendada ao vereador.** O requerimento de informação é uma
> ferramenta de baixo risco e alto retorno: ele não acusa, apenas pede
> documentos. Se o Executivo responde, o gabinete ganha base documental
> sólida; se não responde no prazo, a própria omissão vira fato fiscalizável
> (representação ao MP por negativa de publicidade). Em ambos os cenários, o
> gabinete avança.

---

## 2.4 Feature proposta — "Briefing Periódico de Assessoria" no NEXO

O gabinete pediu **assessoria recorrente** — não um relatório único. Proponho
formalizar isso como uma feature do NEXO.

### Conceito

Um **resumo executivo gerado automaticamente em cadência fixa**, que
responde sempre à mesma pergunta — *"o que mudou e o que merece olhar
agora?"* — e entrega ao gabinete uma leitura curta, priorizada e acionável,
sem exigir que alguém navegue os painéis.

### Rota e lugar no produto

`/nexo/briefing` — nova rota dentro da war room (plano-mestre §4.3), com
histórico de edições anteriores. O Painel de Situação (`/nexo`) passa a
exibir o **último briefing** em destaque no topo.

### Cadências

| Cadência | Conteúdo | Gatilho |
|---|---|---|
| **Briefing diário** (dias úteis) | Novos alertas das últimas 24h; mudanças no DOM; alertas críticos (score ≥75) | Cron, após `nexo_detectores_batch` |
| **Briefing semanal** | Top 5 achados da semana priorizados; status dos requerimentos protocolados; prazos de resposta vencendo | Cron semanal |
| **Briefing mensal** | Panorama: evolução da contratação direta, ranking de fornecedores por risco, metas fiscais, série histórica | Cron mensal |
| **Briefing de exceção** | Disparo imediato quando surge alerta crítico ou limite fiscal tangenciado | Evento (Cloud Function) |

### Estrutura de cada briefing

1. **Manchete** — uma frase: a coisa mais importante do período.
2. **O que mudou** — novos alertas e investigações, com variação vs. período
   anterior.
3. **Prioridades a olhar** — top 3–5, no formato da Parte 2.2 deste
   documento (fato · por que é prioridade · o que olhar · requerimento
   sugerido).
4. **Acompanhamento de requerimentos** — protocolados, respondidos, vencidos
   sem resposta (estes viram alerta próprio).
5. **Pulso fiscal** — semáforo dos mínimos constitucionais e limites LRF +
   próximos prazos de RREO/RGF.
6. **Ações sugeridas** — botões "Gerar requerimento" já vinculados às
   investigações citadas.
7. **Rodapé** — disclaimer obrigatório do plano-mestre.

### Princípios da feature

- **Sempre linguagem de indício.** O briefing herda o trilho jurídico do §2
  — nada de acusação, tudo "requer apuração".
- **Curto por desenho.** O diário cabe em uma tela; o mensal em duas páginas.
  Assessoria que ninguém lê não assessora.
- **Rastreável.** Cada item do briefing aponta para a investigação e as
  evidências de origem (fonte, URL, hash, data de coleta).
- **Acionável.** Todo achado prioritário já traz o requerimento-modelo
  correspondente (R01–R12) pronto para o botão "Gerar requerimento".
- **Com memória.** O briefing compara com o período anterior — "subiu",
  "estável", "novo" — para o gabinete enxergar tendência.
- **Revisão humana antes de exportar.** O briefing pode ser gerado
  automaticamente, mas qualquer versão que saia do sistema (impressa, enviada)
  passa por aprovação — coerente com §2.3.

### Implementação (alto nível, sem código)

- Novo job de cron `nexo_briefing_periodico`, rodando após
  `nexo_detectores_batch` e `nexo_correlator_grafo`.
- Nova coleção Firestore `nexo_briefings` — cada documento é um briefing
  datado, com `_meta` padrão e referências às investigações citadas.
- Na Fase 3, a redação em linguagem natural usa a Claude API com prompt
  caching (plano-mestre §10, Fase 3) — alimentada pelos dados estruturados
  das investigações, nunca inventando fatos.
- Reaproveita o motor de scoring (§7) para ordenar as prioridades.

---

# PARTE 3 — RECOMENDAÇÕES AO PLANO-MESTRE

Sugiro acrescentar ao `nexo-plano-mestre.md`:

1. **Novo §9.1 — Catálogo de Requerimentos-Modelo.** Hoje o §9 fala em
   "minuta de requerimento" como saída genérica. Falta o **catálogo** R01–R12
   deste documento — um modelo por família de detector. Cada detector do §6
   passa a apontar o requerimento-modelo correspondente, fechando o ciclo
   detector → investigação → requerimento.

2. **Nova rota `/nexo/briefing` no §4.3** e a feature de Briefing Periódico
   de Assessoria como entregável explícito da Fase 1 (versão diária/semanal,
   regra fixa) e Fase 3 (redação por IA). A assessoria recorrente foi pedida
   diretamente pelo gabinete e hoje não tem lugar formal no roadmap.

3. **Nova coleção `nexo_briefings` no §5** e novo job
   `nexo_briefing_periodico` no §8.

4. **Acompanhamento de requerimentos como objeto de primeira classe.** O
   vínculo investigação ↔ requerimento já existe no §9, mas falta tratar o
   **prazo de resposta** (15–30 dias conforme a LOM): requerimento vencido
   sem resposta deve virar um **alerta automático** — a omissão é fato
   fiscalizável.

5. **Verificar e fixar os artigos da Lei Orgânica de Marília e do Regimento
   Interno da Câmara** que disciplinam o requerimento de informação e o
   prazo de resposta. Os modelos R01–R12 deixam `[art. ___]` em aberto
   justamente porque esse dado precisa ser confirmado na fonte primária
   (`legislacao.marilia.sp.gov.br` / SAPL) antes de qualquer protocolo. Vale
   um item no backlog da Fase 0.

6. **Reforçar a tabela de limites por exercício (§11 backlog #7)** também na
   geração de requerimentos: o R01 cita R$ 62.725,59 / R$ 125.451,15 (2026),
   mas o texto gerado deve sempre puxar o limite do **exercício do empenho**
   investigado, nunca uma constante.

---

## Disclaimer obrigatório

> Este documento processa dados públicos e identifica padrões
> estatisticamente atípicos que podem (ou não) indicar irregularidades.
> Nenhuma informação aqui constitui acusação, prova de improbidade ou de
> ilícito. Os requerimentos-modelo destinam-se a **solicitar documentos** que
> confirmem ou afastem hipóteses — não a imputar conduta. Os indícios devem
> ser investigados pelas instituições competentes (TCE-SP, Ministério
> Público, Controladoria) antes de qualquer juízo de valor.

---

## Fontes consultadas (praxe de requerimentos)

- [O Vereador e o Pedido de Informação ao Prefeito — Jusbrasil](https://www.jusbrasil.com.br/artigos/o-vereador-e-o-pedido-de-informacao-ao-prefeito/582988088)
- [Vereador pode pedir informações como qualquer cidadão, diz TJ-SP — ConJur](https://www.conjur.com.br/2022-set-30/pedido-informacao-vereador-nao-aprovacao-plenario/)
- [O direito de vereadores ao acesso à informação — ConJur](https://www.conjur.com.br/2025-mar-26/o-direito-de-vereadores-ao-acesso-a-informacao-e-a-inconstitucionalidade-da-exigencia-de-aprovacao-plenaria/)
- [Como qualquer cidadão, parlamentar pode requerer informações ao Executivo — STF](https://portal.stf.jus.br/noticias/verNoticiaDetalhe.asp?idConteudo=376474)
- [O Vereador pode enviar requerimento de informação diretamente ao prefeito? — IBPOM](https://ibpom.com.br/vereador-pode-enviar-requerimento-de-informacao/)
- [Cartilha do Vereador — Interlegis/Senado](https://www12.senado.leg.br/interlegis/comunicacao/publicacoes-1/cartilha-do-vereador/)
- [Modelos de Requerimentos — Interlegis](https://www.interlegis.leg.br/capacitacao/publicacoes-e-modelos/documentos-legislativos/modelos-de-requerimentos)
- [Pedido de Informação — Câmara Municipal de Camaquã/RS](https://www.camaracq.rs.gov.br/documentos/tipo:legislativo-2/subtipo:pedido-de-informacao-316)
