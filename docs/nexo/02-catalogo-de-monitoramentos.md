# NEXO — Catálogo de Monitoramentos

### Catálogo-Mestre de Detectores e Monitoramentos Contínuos

**Câmara Municipal de Marília/SP — Gabinete Vereador Fefin**
Documento NEXO 02 · v1.0 · 2026-05-21
Autoria: **VÉRTEX** (Cientista de Dados · Detecção) · revisão: ORÁCULO
Complementa: `docs/nexo-plano-mestre.md` §6 e §7 · `docs/transparencia-anomalias-arquitetura.md` §3

---

## 0. Como ler este catálogo

Este é o **catálogo completo de tudo que o NEXO vai monitorar**. Ele consolida
e expande quatro fontes: os 6 processadores do plano-mestre, os ~38 detectores
da arquitetura v1.0, o subsistema de Metas Fiscais e as red flags das
transcrições do advogado (ex-auditor do TCE-SP) — somando detectores novos
derivados de jurisprudência do TCU e do TCE-SP.

**Resultado:** 132 monitoramentos catalogados, organizados em 14 áreas.

### 0.1 Esquema de numeração unificado

`{ÁREA}-{NN}` — prefixo de duas letras por área, número sequencial.

| Prefixo | Área | Faixa |
|---|---|---|
| `LC` | Licitações e compras | LC-01 … LC-25 |
| `OB` | Obras públicas | OB-01 … OB-14 |
| `FC` | Frota e combustível | FC-01 … FC-11 |
| `SA` | Saúde, medicamentos, almoxarifado | SA-01 … SA-13 |
| `EM` | Contratos emergenciais | EM-01 … EM-08 |
| `DE` | Diárias, eventos, shows, publicidade | DE-01 … DE-13 |
| `FR` | Fornecedores | FR-01 … FR-13 |
| `FP` | Folha, cargos, terceirizados | FP-01 … FP-14 |
| `OR` | Execução orçamentária | OR-01 … OR-10 |
| `MF` | Metas fiscais e LRF | MF-01 … MF-14 |
| `DO` | Diário Oficial | DO-01 … DO-08 |
| `TS` | Convênios, repasses, terceiro setor | TS-01 … TS-09 |
| `XS` | Cruzamentos cross-source | XS-01 … XS-14 |
| `RC` | Receita e renúncia (transversal) | RC-01 … RC-06 |

> O catálogo da arquitetura v1.0 usava prefixos `A`–`H`. A tabela de migração
> no §16 mapeia cada ID antigo para o novo, para não se perder rastreabilidade.

### 0.2 Campos de cada monitoramento

- **ID** — identificador unificado.
- **Nome** — rótulo curto.
- **O que detecta** — descrição em linguagem de indício.
- **Regra / lógica** — condição de disparo com limiares concretos.
- **Fontes** — bases de dados necessárias (ver §0.3).
- **Sev.** — severidade base 1–5 (5 = crítico). É a `severidadeBase` do
  detector; o score final aplica os multiplicadores de contexto do plano-mestre §7.
- **Fundamento legal** — normas para análise humana (não é enquadramento).
- **Disp.** — disponibilidade do dado hoje: ✅ pronto · 🟡 parcial · 🔴 a integrar.
- **QW** — ⚡ marca quick wins (dado pronto + regra simples + alto valor).

### 0.3 Códigos de fonte

| Código | Fonte | Tier | Status |
|---|---|---|---|
| `SM-DESP` | SMARAPD `DespesaAgrupada` (despesas orçamentárias) | A | ✅ |
| `SM-EMP` | SMARAPD `fornecedor` (empenho analítico) | A | ✅ |
| `SM-ITENS` | SMARAPD `empenho_sintetico/itensempenho` (drill-down) | A | ✅ |
| `SM-DIA` | SMARAPD `diarias` | A | ✅ |
| `SM-FOLHA` | SMARAPD `pagamentos` (folha) | A | ✅ |
| `SM-REC` | SMARAPD `balancetereceita` / `ReceitaAnalitica` | A | ✅ |
| `SM-RAP` | SMARAPD `restoapagar` | A | ✅ |
| `SM-MOD` | SMARAPD `quadro_de_renda_local` (empenho por modalidade) | A | ✅ |
| `SM-EMENDA` | SMARAPD `emendas_parlamentares` | A | ✅ |
| `SM-PUB` | SMARAPD `despesas_de_pagamentos` (publicidade) | A | ✅ |
| `SM-SUBV` | SMARAPD `despesas_subvencoes` | A | ✅ |
| `SM-VIAGEM` | SMARAPD `despesa_viagem` (passagens e locomoção) | A | ✅ |
| `SM-LRF` | SMARAPD visões fixas LRF (`modulovisao/fixo/...`) | A | ✅ |
| `SM-ORDEM` | SMARAPD `LGPD/OrdemCronologicaPagamento` | A | ✅ |
| `SM-PUNIDA` | SMARAPD `empresaspunidas` (empresas punidas/inidôneas) | A | ✅ |
| `SM-TS` | SMARAPD `siafic/parceriascelebradas` (parcerias 3º setor) | A | ✅ |
| `SM-IMOVEL` | SMARAPD `pca/imoveislocados` | A | ✅ |
| `SM-METAS` | SMARAPD `relatorio_gestao_a/planodemetas` | A | ✅ |
| `DOM` | Diário Oficial de Marília (indexado) | B | ✅ |
| `EDITAL` | Portal de editais da Prefeitura | B | 🔴 |
| `CONTR` | Contratos e atas da Prefeitura | B | 🔴 |
| `OBRAS` | Andamento de obras da Prefeitura | B | 🔴 |
| `LEGIS` | Legislação municipal / SAPL | B/C | 🟡 |
| `CNPJ` | BrasilAPI `/cnpj` (razão social, CNAE, sócios, UF) | C | ✅ |
| `SICONFI` | SICONFI/STN — RREO, RGF, DCA (IBGE 3529005) | C | ✅ |
| `CEIS` | CEIS/CNEP/CEPIM — cadastros de inidôneos | C | 🔴 |
| `TCE` | TCE-SP — apontamentos, julgados, AUDESP | C | 🔴 |
| `PNCP` | Portal Nacional de Contratações Públicas | C | 🔴 |
| `SINAPI` | SINAPI / SICRO — preços de referência de obra | C | 🔴 |
| `BPS` | Banco de Preços em Saúde | C | 🔴 |
| `TSE` | TSE — doações e prestação de contas de campanha | C | 🔴 |
| `FROTA` | Cadastro de frota / abastecimento (via LAI) | B | 🔴 |
| `ALMOX` | Almoxarifado / estoque da Saúde (via LAI) | B | 🔴 |
| `ESIC` | e-SIC / 1Doc / Ouvidoria | B | 🔴 |

### 0.4 Princípio jurídico (vale para todo o catálogo)

Todo monitoramento gera **indício técnico**, jamais acusação. As saídas usam
"possível indício", "inconsistência documental", "padrão atípico", "requer
apuração". O fundamento legal citado serve a análise humana — o sistema não
infere dolo (Lei 14.230/2021 exige dolo específico para improbidade). Ver
disclaimer no §17.

### 0.5 Tabela de limites de dispensa por exercício

Os detectores de fracionamento e proximidade de limite **nunca usam constante**:
consultam esta tabela pelo exercício do empenho.

| Exercício | Compras e serviços comuns | Obras e serviços de engenharia | Base |
|---|---|---|---|
| 2024 | R$ 57.500,00 | R$ 119.812,00 | Decreto 11.871/2023 |
| 2025 | R$ 60.000,00 (aprox.) | R$ 120.000,00 (aprox.) | Decreto 12.343/2024 |
| 2026 | R$ 62.725,59 | R$ 125.451,15 | atualização anual Lei 14.133/2021 art. 75 |

> Manter atualizada a cada atualização anual dos valores da Lei 14.133/2021.
> Anos anteriores a 2024 (Lei 8.666/1993) precisam de tabela própria se houver
> análise retroativa.

---

## 1. LICITAÇÕES E COMPRAS (LC-01 … LC-25)

Maior área de risco — licitações e contratos estão entre as três maiores
causas de operações da PF e de rejeição de contas (TCU). Detecta fracionamento,
direcionamento de edital, competição figurativa e fuga de modalidade.

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **LC-01** | Fracionamento por fornecedor | Sequência de dispensas ao mesmo CNPJ que soma acima do limite legal | ≥3 dispensas ao mesmo CNPJ em janela de 90 dias com soma > limite do exercício (§0.5) | SM-EMP, SM-DESP | 4 | Lei 14.133/2021 art. 75 §1º; TCU Ac. 1.084/2007-P | ✅ | ⚡ |
| **LC-02** | Fracionamento por objeto | Mesmo objeto pulverizado em várias compras pequenas, independente do CNPJ | Agrupar por similaridade textual de objeto/elemento de despesa; soma anual no mesmo objeto > limite com ≥3 compras diretas | SM-EMP, SM-ITENS | 4 | Lei 14.133/2021 art. 75 §1º; art. 18 | ✅ | |
| **LC-03** | Fracionamento entre secretarias | Mesmo objeto comprado por dispensa em UGs diferentes para escapar da soma | Mesmo objeto + ≥2 UGs distintas + soma > limite no exercício | SM-DESP | 4 | Lei 14.133/2021 art. 75 §1º | ✅ | |
| **LC-04** | Valor colado no limite | Dispensa com valor 90–100% do teto legal | Valor da dispensa entre 90% e 100% do limite do exercício | SM-EMP, SM-DESP | 3 | Lei 14.133/2021 art. 75 I/II | ✅ | ⚡ |
| **LC-05** | Sequência logo abaixo do limite | Vários empenhos diretos pouco abaixo do teto, mesmo período | ≥4 compras diretas do mesmo CNPJ entre 80–99% do limite no exercício | SM-EMP | 3 | Lei 14.133/2021 art. 75 §1º | ✅ | |
| **LC-06** | Peso de contratação direta | Dispensa+inexigibilidade representam fatia anormal do gasto da UG/mês | (DISPENSA+DISPENSADA+INEXIGIBILIDADE) / total empenhado > 25% no mês de uma UG | SM-DESP, SM-MOD | 3 | Lei 14.133/2021 art. 17, 28 | ✅ | ⚡ |
| **LC-07** | Inexigibilidade frágil | Inexigibilidade de valor relevante sem comprovação robusta de exclusividade | Modalidade inexigibilidade + valor > R$ 50k + ausência de extrato/justificativa no DOM | SM-DESP, DOM | 4 | Lei 14.133/2021 art. 74 | ✅ | |
| **LC-08** | Único habilitado | Pregão/concorrência homologado com 1 só licitante após habilitação | Processo competitivo com 1 habilitado na fase final | EDITAL, CONTR | 3 | Lei 14.133/2021 art. 17 | 🔴 | |
| **LC-09** | Baixa competitividade crônica | Mesma modalidade com média de participantes muito baixa | Média de licitantes/certame < 3 por objeto/secretaria no exercício | EDITAL | 3 | Lei 14.133/2021 art. 11, 25 | 🔴 | |
| **LC-10** | Prazo mínimo de publicação | Intervalo edital→sessão abaixo do mínimo legal por modalidade | (data sessão − data publicação) < prazo legal da modalidade | EDITAL, DOM | 4 | Lei 14.133/2021 art. 55 | 🔴 | |
| **LC-11** | Edital com exigência restritiva | Termo de referência com exigência técnica sob medida que afunila concorrência | NLP sobre o edital: exigências de marca, atestado incomum, prazo/local incompatíveis com o objeto | EDITAL | 4 | Lei 14.133/2021 art. 25 §1º; art. 9º | 🔴 | |
| **LC-12** | Orçamento estimado alinhado | Pesquisa de preços com empresas de fachada/sem relação com o objeto | Cotações da pesquisa com CNAE incompatível, CNPJ recém-aberto ou endereço comum entre cotantes | EDITAL, CNPJ | 4 | Lei 14.133/2021 art. 23; TCU | 🔴 | |
| **LC-13** | Competição figurativa | Mesmos participantes em vários certames com alternância previsível de vitória | Grafo: mesmo trio/quarteto de CNPJs aparece junto em ≥3 certames, vencedores rodiziando | EDITAL, CNPJ | 5 | Lei 12.846/2013 art. 5º IV; Lei 14.133 art. 5º | 🔴 | |
| **LC-14** | Carona / ata de outro município | Adesão a ata de registro de preços de outro ente sem pesquisa local | Empenho referenciando ata externa + ausência de pesquisa de preço local + preço acima de contratos locais | SM-DESP, CONTR, DOM | 4 | Lei 14.133/2021 art. 86 §2º; TCU | 🟡 | |
| **LC-15** | Carona com sobrepreço | Adesão a ata cujo preço unitário supera o mercado de Marília | Preço unitário da carona > +15% vs. mediana de contratos comparáveis do município | SM-ITENS, CONTR | 4 | Lei 14.133/2021 art. 23; art. 86 | 🟡 | |
| **LC-16** | Objeto licitado em excesso | Mesmo objeto licitado repetidamente no exercício (falha de planejamento) | Mesmo objeto licitado >3x no exercício | EDITAL | 2 | Lei 14.133/2021 art. 18, 12 | 🔴 | |
| **LC-17** | Empenho sem licitação correspondente | Modalidade não-direta declarada sem processo licitatório localizável | Modalidade pregão/concorrência + campo `ProcessoLicitatorio` vazio ou não encontrado no portal de editais | SM-EMP, EDITAL | 3 | Lei 14.133/2021 art. 12; LC 131/2009 | 🟡 | |
| **LC-18** | Modalidade incompatível com valor | Valor contratado exigiria modalidade mais rigorosa que a usada | Valor empenhado por objeto > faixa da modalidade declarada | SM-DESP, SM-MOD | 4 | Lei 14.133/2021 art. 28–29 | ✅ | ⚡ |
| **LC-19** | Aditivo acima do limite | Soma de aditivos ultrapassa 25% (50% para reforma) do valor original | Σ aditivos / valor original > 0,25 (ou 0,50 reforma) | CONTR, DOM | 4 | Lei 14.133/2021 art. 125 | 🟡 | |
| **LC-20** | Aditivo de prazo desproporcional | Aditivo de prazo maior que o prazo contratual original | prazo aditado > prazo original (>100%) | CONTR, DOM | 3 | Lei 14.133/2021 art. 124–125 | 🟡 | |
| **LC-21** | Apostilamento mascarando reajuste | Apostilamentos sucessivos elevando valor sem aditivo formal | ≥3 apostilamentos no mesmo contrato com elevação acumulada > 15% | CONTR, DOM | 3 | Lei 14.133/2021 art. 136 | 🔴 | |
| **LC-22** | Vencedor recém-aberto | Empresa vencedora com CNPJ aberto pouco antes do certame | data abertura do CNPJ < 180 dias antes da data da licitação | CNPJ, SM-EMP | 3 | Risco gerencial; Lei 14.133 art. 5º | ✅ | |
| **LC-23** | Alteração societária pré-vitória | Mudança de quadro societário às vésperas da licitação vencida | alteração de sócios nos 90 dias anteriores à vitória | CNPJ, EDITAL | 4 | Lei 12.846/2013 art. 5º IV | 🟡 | |
| **LC-24** | Empenho sem itens detalháveis | Empenho de valor relevante sem drill-down de itens/quantidades | valor > R$ 100k + `itensempenho` vazio ou genérico ("serviços diversos") | SM-EMP, SM-ITENS | 2 | Lei 4.320/1964 art. 63; transparência | ✅ | |
| **LC-25** | Sobrepreço em compra de bem | Preço unitário de item de compra acima de referência de mercado | preço unitário > +25% vs. mediana de compras do mesmo item no portal/PNCP | SM-ITENS, PNCP | 4 | Lei 14.133/2021 art. 23 | 🟡 | |

---

## 2. OBRAS PÚBLICAS (OB-01 … OB-14)

Os 4 movimentos do superfaturamento (transcrições): preço item a item vs.
referência; edital sob medida; medição física ≠ valor pago; aditivos em cadeia.

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **OB-01** | Sobrepreço unitário médio | Item de planilha acima da referência oficial | preço unitário / SINAPI-SICRO entre 1,15 e 1,25 | OBRAS, CONTR, SINAPI | 3 | Lei 14.133/2021 art. 23; TCU Súm. 258 | 🔴 | |
| **OB-02** | Sobrepreço unitário alto | Item de planilha bem acima da referência | razão entre 1,25 e 1,40 | OBRAS, SINAPI | 4 | Lei 14.133/2021 art. 23 | 🔴 | |
| **OB-03** | Sobrepreço unitário crítico | Item de planilha extremamente acima da referência | razão > 1,40 sem justificativa técnica | OBRAS, SINAPI | 5 | Lei 14.133/2021 art. 23; Lei 8.429/1992 | 🔴 | |
| **OB-04** | BDI fora do padrão | Taxa de BDI acima da faixa usual para o tipo de obra | BDI declarado > faixa de referência (Ac. TCU 2.622/2013) | OBRAS, CONTR | 3 | TCU Ac. 2.622/2013-P | 🔴 | |
| **OB-05** | Curva ABC concentrada | Poucos itens concentram a maior parte do valor (risco de jogo de planilha) | top 10 itens / valor total > 80% | OBRAS | 3 | Lei 14.133/2021 art. 23 | 🔴 | |
| **OB-06** | Jogo de planilha | Itens caros super-executados + itens baratos sub-executados | itens com preço acima da referência têm execução > prevista; itens abaixo têm execução < prevista | OBRAS | 4 | Lei 14.133/2021 art. 25; TCU | 🔴 | |
| **OB-07** | Financeiro acima do físico | Percentual pago supera percentual físico medido | % financeiro pago − % físico medido > 10 pontos | OBRAS, SM-DESP | 5 | Lei 4.320/1964 art. 62–63; Lei 8.429/1992 | 🔴 | |
| **OB-08** | Pagamento sem medição | Pagamento de obra sem boletim de medição correspondente | empenho/pagamento de obra sem medição vinculada no período | OBRAS, SM-EMP | 4 | Lei 4.320/1964 art. 63 | 🔴 | |
| **OB-09** | Obra paralisada com saldo | Obra parada mantendo saldo empenhado relevante | status = paralisada + saldo empenhado > R$ 50k | OBRAS, SM-EMP | 3 | Lei 14.133/2021 art. 115; LRF | 🔴 | |
| **OB-10** | Obra paga recentemente e parada | Pagamento recente em obra sem evolução física | pagamento nos últimos 60 dias + 0% de avanço físico no período | OBRAS, SM-DESP | 4 | Lei 4.320/1964 art. 63 | 🔴 | |
| **OB-11** | Aditivos de obra em cadeia | Sucessão de aditivos de valor/prazo no mesmo contrato de obra | ≥3 aditivos no mesmo contrato OU Σ aditivos > 25% (50% reforma) | CONTR, DOM | 4 | Lei 14.133/2021 art. 125 | 🟡 | |
| **OB-12** | Obra sem ART/RRT | Licitação/contrato de obra sem registro de responsabilidade técnica | ausência de ART/RRT do responsável técnico no processo | OBRAS, EDITAL | 4 | Lei 6.496/1977; Lei 12.378/2010 | 🔴 | |
| **OB-13** | Obra anunciada sem contrato | Obra divulgada (notícia/DOM) sem contrato localizável | obra citada em DOM/notícia sem contrato/empenho correspondente | DOM, OBRAS, CONTR | 3 | LC 131/2009; LAI | 🟡 | |
| **OB-14** | Recape/tapa-buraco repetido no local | Mesmo logradouro recebendo recuperação de pavimento repetidas vezes | mesmo endereço/objeto de pavimentação contratado >1x em 18 meses | OBRAS, SM-ITENS | 3 | Lei 14.133/2021 art. 18; Lei 8.429/1992 | 🔴 | |

---

## 3. FROTA E COMBUSTÍVEL (FC-01 … FC-11)

1º lugar que a PF olha (transcrições). Boa parte depende de dados de frota
obtidos via LAI — mas FC-01/FC-02 já rodam só com o portal.

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **FC-01** | Concentração de gasto em posto | Gasto de combustível concentrado em um único fornecedor/posto | um CNPJ de posto > 70% do gasto de combustível da UG no exercício | SM-DESP, SM-EMP | 3 | Lei 14.133/2021 art. 11; LRF | ✅ | ⚡ |
| **FC-02** | Gasto de combustível atípico | Despesa mensal de combustível de uma UG fora da média histórica | gasto mensal > média móvel 12m + 2 desvios-padrão | SM-DESP | 2 | LRF art. 1º §1º; controle interno | ✅ | ⚡ |
| **FC-03** | Consumo km/l incompatível | Rendimento incompatível com o tipo de veículo | km/l < 50% da média esperada do tipo de veículo | FROTA | 4 | Lei 8.429/1992; Decreto-Lei 200/1967 | 🔴 | |
| **FC-04** | Abastecimento acima do tanque | Litros abastecidos superam a capacidade do tanque | litros > capacidade do tanque + margem de 10% | FROTA | 4 | Lei 8.429/1992 art. 10 | 🔴 | |
| **FC-05** | Veículo parado com consumo | Veículo inativo/em manutenção/baixado seguindo com abastecimento | abastecimento registrado para veículo sem deslocamento ou já baixado | FROTA | 4 | Lei 8.429/1992; uso indevido de bem público | 🔴 | |
| **FC-06** | Abastecimento sem quilometragem | Abastecimentos sem km informada (impede auditoria) | km ausente em > 20% dos abastecimentos do veículo no mês | FROTA | 2 | Controle interno; LAI | 🔴 | |
| **FC-07** | Abastecimento em fim de semana/feriado | Abastecimento fora de dia/horário de expediente sem justificativa | abastecimento em domingo/feriado de veículo administrativo | FROTA | 3 | Lei 9.504/1997 art. 73 (uso eleitoral); controle interno | 🔴 | |
| **FC-08** | Abastecimentos sequenciais | Múltiplos abastecimentos do mesmo veículo no mesmo dia | ≥2 abastecimentos do mesmo veículo em 24h | FROTA | 3 | Controle interno | 🔴 | |
| **FC-09** | Cartão usado em veículos diferentes | Mesmo cartão-combustível atrelado a veículos distintos | mesmo cartão → ≥2 placas no mesmo período | FROTA | 4 | Lei 8.429/1992; fraude documental | 🔴 | |
| **FC-10** | Fornecedor único de combustível por longo período | Mesmo posto fornece sem renovação/competição por período longo | mesmo CNPJ fornece combustível por > 24 meses sem nova licitação | SM-DESP, CONTR | 3 | Lei 14.133/2021 art. 11, 106 | 🟡 | |
| **FC-11** | Manutenção de frota recorrente sem laudo | Gastos repetidos de manutenção sem relatório técnico | ≥4 manutenções do mesmo veículo/ano sem laudo localizável | SM-DESP, FROTA | 2 | Lei 4.320/1964 art. 63 | 🔴 | |

---

## 4. SAÚDE, MEDICAMENTOS E ALMOXARIFADO (SA-01 … SA-13)

3º lugar que a PF olha — "a nota fiscal diz que entrou, o paciente sai sem
remédio" (transcrições).

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **SA-01** | Pagamento sem entrada em estoque | Medicamento/insumo pago sem registro de entrada no almoxarifado | empenho pago + ausência de entrada de estoque correspondente | SM-EMP, ALMOX | 5 | Lei 4.320/1964 art. 62–63; Lei 8.429/1992 | 🔴 | |
| **SA-02** | NF sem correspondência no almoxarifado | Nota fiscal liquidada sem lançamento de recebimento | quantidade NF ≠ quantidade registrada no estoque | ALMOX, SM-EMP | 5 | Lei 4.320/1964 art. 63 | 🔴 | |
| **SA-03** | Entrega parcial paga como integral | Pagamento integral com entrega comprovada menor | quantidade entregue/distribuída < quantidade contratada, pagamento 100% | ALMOX, SM-EMP | 4 | Lei 14.133/2021 art. 140; Lei 8.429/1992 | 🔴 | |
| **SA-04** | Entrada sem lote/validade | Recebimento de medicamento sem lote ou validade registrados | campo lote ou validade ausente no registro de entrada | ALMOX | 3 | RDC ANVISA; controle interno | 🔴 | |
| **SA-05** | Preço acima do Banco de Preços em Saúde | Item de saúde comprado acima da referência nacional | preço unitário > +20% vs. mediana do Banco de Preços em Saúde | SM-ITENS, BPS | 4 | Lei 14.133/2021 art. 23 | 🔴 | |
| **SA-06** | Compra sem distribuição posterior | Medicamento comprado e pago sem saída para unidades | compra registrada + 0 saídas/distribuição em 90 dias | ALMOX | 3 | Lei 8.429/1992; LC 141/2012 | 🔴 | |
| **SA-07** | Falta na unidade apesar de compra recente | Unidade sem o item enquanto há compra recente paga | reclamação/protocolo de falta + compra do item nos últimos 60 dias | ALMOX, ESIC | 4 | LC 141/2012; LAI | 🔴 | |
| **SA-08** | Concentração de itens num fornecedor | Um CNPJ concentra a maior parte do fornecimento de saúde | um fornecedor > 30% do valor de medicamentos/insumos da Saúde no ano | SM-EMP | 3 | Lei 14.133/2021 art. 11 | ✅ | ⚡ |
| **SA-09** | Compra emergencial recorrente de saúde | Itens de uso contínuo comprados por emergência repetidas vezes | ver EM-01 aplicado a objetos da Saúde (medicamento, insumo, oxigênio) | SM-DESP, DOM | 4 | Lei 14.133/2021 art. 75 VIII | 🟡 | |
| **SA-10** | Contrato de gestão sem relatório de metas | Repasse a OSS/contrato de gestão sem prestação de metas | contrato de gestão com repasse + ausência de relatório de metas no período | SM-TS, CONTR | 4 | Lei 9.637/1998; LC 141/2012 | 🟡 | |
| **SA-11** | Locação de ambulância/veículo com baixa comprovação | Pagamento recorrente de locação na saúde sem comprovação de uso | locação paga mensalmente sem relatório de utilização/quilometragem | SM-DESP | 3 | Lei 4.320/1964 art. 63 | ✅ | |
| **SA-12** | Mesmo fiscal atestando alto volume | Um único fiscal atesta volume de liquidações anormal | um servidor atesta > N liquidações/mês acima da média do setor | SM-EMP, SM-FOLHA | 2 | Lei 14.133/2021 art. 117 | 🟡 | |
| **SA-13** | Manutenção hospitalar sem relatório técnico | Serviço de manutenção em unidade de saúde pago sem laudo | empenho de manutenção hospitalar sem relatório técnico vinculado | SM-DESP | 2 | Lei 4.320/1964 art. 63 | 🟡 | |

---

## 5. CONTRATOS EMERGENCIAIS (EM-01 … EM-08)

Quando a emergência vira padrão administrativo — falha de planejamento ou
fuga de licitação.

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **EM-01** | Emergência repetida no mesmo objeto | >1 emergência para o mesmo objeto em 12 meses | mesmo objeto + modalidade emergencial + ≥2 ocorrências em 12 meses | SM-DESP, DOM | 4 | Lei 14.133/2021 art. 75 VIII | 🟡 | |
| **EM-02** | Mesmo fornecedor emergencial recorrente | Mesmo CNPJ contratado por emergência várias vezes | ≥3 contratos emergenciais ao mesmo CNPJ em 12 meses | SM-EMP, DOM | 4 | Lei 14.133/2021 art. 75 VIII | 🟡 | |
| **EM-03** | Emergência após fim de contrato previsível | Contratação emergencial logo após vencimento conhecido de contrato | emergencial dentro de 60 dias após fim de contrato anterior do mesmo objeto | CONTR, SM-DESP | 4 | Lei 14.133/2021 art. 75 VIII; art. 12 | 🟡 | |
| **EM-04** | Objeto previsível tratado como urgente | Objeto de natureza contínua/previsível classificado como emergência | objeto na lista de previsíveis (limpeza, merenda, transporte, combustível, medicamento contínuo) contratado por emergência | SM-DESP, DOM | 3 | Lei 14.133/2021 art. 75 VIII | 🟡 | |
| **EM-05** | Emergência sem pesquisa de preço | Contrato emergencial sem evidência de pesquisa de preços | emergencial + ausência de pesquisa de preço no processo | EDITAL, CONTR | 3 | Lei 14.133/2021 art. 23, 75 §3º | 🔴 | |
| **EM-06** | Aditivo emergencial sucessivo | Contrato emergencial prorrogado além do prazo excepcional | aditivo de prazo em contrato emergencial / vigência total > 1 ano | CONTR, DOM | 4 | Lei 14.133/2021 art. 75 VIII (prazo de até 1 ano) | 🟡 | |
| **EM-07** | Emergência de valor expressivo sem estudo | Emergencial de alto valor sem estudo técnico preliminar | emergencial + valor > R$ 200k + ausência de ETP | EDITAL, CONTR | 4 | Lei 14.133/2021 art. 18; art. 75 §6º | 🔴 | |
| **EM-08** | Calamidade/decreto usado para contratar fora do escopo | Contratações por dispensa de calamidade com objeto sem nexo com o evento | dispensa fundada em decreto de calamidade + objeto sem relação clara com o evento declarado | SM-DESP, DOM, LEGIS | 4 | Lei 14.133/2021 art. 75 VIII; LRF art. 65 | 🟡 | |

---

## 6. DIÁRIAS, EVENTOS, SHOWS E PUBLICIDADE (DE-01 … DE-13)

"Trenzinho da alegria" + "farra dos shows" + publicidade com promoção pessoal —
sensibilidade reforçada em ano eleitoral (2026 é municipal).

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **DE-01** | Diária sem prestação de contas | Diária paga sem relatório/comprovante de presença | diária paga + ausência de relatório de viagem no prazo regulamentar | SM-DIA, DOM | 3 | Lei 4.320/1964 art. 63; decreto municipal de diárias | 🟡 | |
| **DE-02** | Acúmulo de diárias por beneficiário | Servidor com volume/valor de diárias muito acima do normal | mesmo beneficiário > 15 diárias/mês OU valor acumulado > R$ 5k/mês | SM-DIA | 3 | Lei 4.320/1964; controle interno | ✅ | ⚡ |
| **DE-03** | Diárias com datas sobrepostas | Mesmo servidor com diárias de períodos que se sobrepõem | janelas de diária do mesmo CPF com interseção de datas | SM-DIA | 4 | Lei 8.429/1992 art. 10; fraude documental | ✅ | ⚡ |
| **DE-04** | Viagens repetidas ao mesmo destino | Mesmo destino visitado muitas vezes sem resultado demonstrável | ≥4 diárias ao mesmo destino para o mesmo grupo no exercício | SM-DIA | 2 | Lei 4.320/1964 art. 63 | ✅ | |
| **DE-05** | Grupo fixo de viajantes | Sempre os mesmos servidores viajando juntos | conjunto recorrente de beneficiários em ≥3 deslocamentos | SM-DIA | 2 | Controle interno; impessoalidade | ✅ | |
| **DE-06** | Passagens/locomoção desproporcional | Gasto de passagens/locomoção atípico para a unidade | gasto da UG > média histórica + 2 desvios-padrão | SM-VIAGEM | 2 | LRF; controle interno | ✅ | ⚡ |
| **DE-07** | Show com cachê incompatível | Cachê de evento alto demais para o porte do município | valor do contrato de show acima de faixa de referência para cidade do porte | SM-DESP, DOM | 4 | Lei 14.133/2021 art. 74 II; art. 23 | 🟡 | |
| **DE-08** | Show por intermediária recém-criada | Inexigibilidade de show via empresa intermediária nova/sem histórico | inexigibilidade de evento + CNPJ intermediário aberto < 12 meses ou sem outros contratos | SM-DESP, CNPJ | 5 | Lei 14.133/2021 art. 74 II §1º | 🟡 | |
| **DE-09** | Inexigibilidade de show mal explicada | Carta de exclusividade frágil ou ausente em contratação artística | inexigibilidade artística + ausência de comprovação robusta de exclusividade no DOM | SM-DESP, DOM | 4 | Lei 14.133/2021 art. 74 II | 🟡 | |
| **DE-10** | Evento custeado por emenda com promoção política | Emenda parlamentar vinculada a evento com autopromoção | emenda → evento + publicações oficiais destacando agente político | SM-EMENDA, SM-DESP, DOM | 4 | Lei 9.504/1997 art. 73; CF art. 37 §1º | 🟡 | |
| **DE-11** | Publicidade com promoção pessoal | Publicidade institucional com nome/imagem/slogan do gestor | NLP em peças de publicidade: presença de nome/imagem/slogan pessoal | SM-PUB, DOM | 4 | CF art. 37 §1º; Lei 9.504/1997 art. 73 | 🟡 | |
| **DE-12** | Pico de publicidade em janela eleitoral | Gasto de publicidade dispara em período sensível | gasto de publicidade no trimestre pré-eleitoral > +30% vs. mesma janela do ano anterior | SM-PUB | 3 | Lei 9.504/1997 art. 73 VI/VII | ✅ | ⚡ |
| **DE-13** | Publicidade acima do teto da RCL | Gasto de publicidade excede o parâmetro percentual da RCL | gasto de publicidade / RCL > 1% | SM-PUB, SICONFI | 3 | CF art. 37 §1º; jurisprudência TCE-SP | ✅ | |

---

## 7. FORNECEDORES (FR-01 … FR-13)

Mapa de empresas que contratam com o município — resolução de entidades e
grafo de vínculos.

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **FR-01** | Concentração de contratos | Um fornecedor concentra fatia anormal dos contratos ativos | um CNPJ raiz > 20% do valor de contratos/empenhos ativos | SM-EMP | 3 | Lei 14.133/2021 art. 11 | ✅ | ⚡ |
| **FR-02** | Fornecedor de UF distante em serviço presencial | Empresa de outra UF executando serviço que exige presença local | UF da sede ≠ SP + CNAE de serviço presencial (coleta, limpeza, obra, manutenção) | SM-DESP, CNPJ | 4 | Lei 14.133/2021 art. 25 (restrição) | ✅ | ⚡ |
| **FR-03** | CNPJ não-ativo recebendo pagamento | Pagamento a empresa com situação cadastral ≠ ATIVA | situação cadastral ∈ {baixada, inapta, suspensa, nula} na data do pagamento | CNPJ, SM-EMP | 5 | Lei 14.133/2021 art. 14; art. 68 | ✅ | ⚡ |
| **FR-04** | Fornecedor inidôneo (CEIS/CNEP) | Empresa em cadastro de inidôneos recebendo recurso | CNPJ presente em CEIS, CNEP ou CEPIM com sanção vigente | CEIS, SM-EMP | 5 | Lei 14.133/2021 art. 14 IV; Lei 12.846/2013 | 🔴 | |
| **FR-05** | Empresa punida no portal recebendo pagamento | Empresa na lista de punidas do próprio município ainda sendo paga | CNPJ em `empresaspunidas` com sanção ativa + empenho/pagamento no período | SM-PUNIDA, SM-EMP | 5 | Lei 14.133/2021 art. 14 | ✅ | ⚡ |
| **FR-06** | Múltiplos CNPJs da mesma raiz | Empresa usa filiais/CNPJs distintos para fracionar contratação | mesma raiz de 8 dígitos com contratos distintos cuja soma cruza um limite de modalidade | SM-EMP | 3 | Lei 14.133/2021 art. 75 §1º | ✅ | ⚡ |
| **FR-07** | Sócios/endereço/contador em comum | Concorrentes diferentes compartilham sócio, endereço ou contador | grafo: ≥2 CNPJs ativos no município com sócio, endereço ou contador em comum | CNPJ | 5 | Lei 12.846/2013 art. 5º IV | 🟡 | |
| **FR-08** | CNAE incompatível com o objeto | Empresa contratada para objeto fora da sua atividade declarada | CNAE principal e secundários sem aderência ao objeto contratado | CNPJ, SM-DESP | 3 | Lei 14.133/2021 art. 62, 67 | ✅ | |
| **FR-09** | Capital social incompatível com contrato | Capital social muito inferior ao valor contratado | valor do contrato / capital social > 10 | CNPJ, CONTR | 3 | Lei 14.133/2021 art. 69 (qualificação econômica) | ✅ | |
| **FR-10** | Empresa sem estrutura aparente | Indícios de empresa de fachada (endereço residencial, sem porte) | endereço residencial + porte ME/MEI + contrato de alto valor | CNPJ | 4 | Lei 12.846/2013 art. 5º; Lei 14.133 art. 5º | 🟡 | |
| **FR-11** | Vencedor único em várias secretarias | Mesmo fornecedor vencendo objetos distintos em muitas UGs | mesmo CNPJ com contratos em ≥4 UGs com objetos heterogêneos | SM-EMP | 2 | Lei 14.133/2021 art. 11 | ✅ | |
| **FR-12** | Empresa nova com contrato relevante | CNPJ recém-aberto já com contrato de grande valor | abertura < 12 meses + contrato > R$ 100k | CNPJ, SM-EMP | 3 | Risco gerencial | ✅ | ⚡ |
| **FR-13** | Fornecedor doador de campanha | Fornecedor que doou para campanha do gestor e contratou no mandato | CNPJ/sócio consta em doações de campanha do gestor + contrato no mandato | TSE, SM-EMP | 4 | Lei 9.504/1997; CF art. 37 | 🔴 | |

---

## 8. FOLHA, CARGOS E TERCEIRIZADOS (FP-01 … FP-14)

2º lugar que a PF olha — servidor fantasma e folha inflada. Dados pessoais
mascarados na UI (LGPD).

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **FP-01** | Remuneração acima do teto | Servidor com remuneração superior ao teto constitucional | total de vencimentos > teto aplicável (subsídio do prefeito) | SM-FOLHA | 4 | CF art. 37 XI | ✅ | ⚡ |
| **FP-02** | Gratificações inflando o líquido | Gratificações representando fatia anormal da remuneração | (vencimentos − salário base) / salário base > 0,70 | SM-FOLHA | 3 | CF art. 37 XI (indício de burla ao teto) | 🟡 | |
| **FP-03** | CPF duplicado ou inválido | Mesmo CPF em servidores distintos ou DV inválido | CPF repetido entre matrículas OU dígito verificador inválido | SM-FOLHA | 5 | Auditoria cadastral; Lei 8.429/1992 | 🟡 | |
| **FP-04** | Múltiplas matrículas simultâneas | Servidor com mais de um vínculo ativo ao mesmo tempo | mesmo CPF com ≥2 matrículas ativas no mesmo mês | SM-FOLHA | 4 | CF art. 37 XVI (acúmulo) | 🟡 | |
| **FP-05** | Acúmulo ilegal de cargos | Combinação de cargos não permitida pela Constituição | par de cargos do mesmo CPF fora das exceções do art. 37 XVI | SM-FOLHA | 4 | CF art. 37 XVI–XVII | 🟡 | |
| **FP-06** | Comissionado sem lotação visível | Cargo em comissão sem descrição/lotação clara | cargo comissionado com campo `Funcao`/lotação vazio ou genérico | SM-FOLHA | 3 | CF art. 37 V; SV 13 | ✅ | |
| **FP-07** | Nepotismo (mesmo sobrenome do gestor) | Comissionado com sobrenome coincidente com agente político | sobrenome do servidor comissionado coincide com gestor/secretário + nomeação por livre escolha | SM-FOLHA, DOM | 5 | Súmula Vinculante 13 | 🟡 | |
| **FP-08** | Nepotismo cruzado (indício) | Designações recíprocas de parentes entre agentes públicos | grafo de sobrenomes: troca cruzada de parentes entre gabinetes/secretarias | SM-FOLHA, DOM | 4 | Súmula Vinculante 13 (designações recíprocas) | 🟡 | |
| **FP-09** | Nomeação concentrada pré-eleição | Pico de nomeações nos meses anteriores ao pleito | nº de nomeações nos 90 dias pré-eleição > +50% vs. média | SM-FOLHA, DOM | 4 | Lei 9.504/1997 art. 73 V | ✅ | ⚡ |
| **FP-10** | Rotatividade anormal de secretários | Troca frequente de titulares de secretaria | ≥3 trocas de titular na mesma secretaria em 12 meses | DOM | 2 | Eficiência (CF art. 37); controle interno | 🟡 | |
| **FP-11** | Despesa de pessoal em alta vs. receita | Crescimento da folha descolado da receita | crescimento % da folha 12m > crescimento % da receita 12m + faixa de tolerância | SM-FOLHA, SM-REC | 3 | LRF art. 19–20 | ✅ | |
| **FP-12** | Horas extras concentradas | Pagamento de horas extras concentrado em poucos servidores/setores | um setor ou servidor concentra fatia anormal das horas extras pagas | SM-FOLHA | 3 | LRF art. 22; controle interno | 🟡 | |
| **FP-13** | Terceirizado sem lista nominal / sem local | Contrato de mão de obra sem relação nominal ou local de prestação | contrato de terceirização sem lista nominal de trabalhadores ou sem posto definido | CONTR, SM-DESP | 3 | Lei 14.133/2021 art. 117; Súmula TST 331 | 🟡 | |
| **FP-14** | Terceirizado vinculado a mais de um contrato | Mesma pessoa terceirizada aparece em contratos distintos simultâneos | mesmo CPF de terceirizado em ≥2 contratos vigentes | CONTR | 4 | Lei 8.429/1992; fraude documental | 🔴 | |

---

## 9. EXECUÇÃO ORÇAMENTÁRIA (OR-01 … OR-10)

Seguir o dinheiro: empenho → liquidação → pagamento, e os desvios de rito.

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **OR-01** | Pagamento sem empenho prévio | Pagamento registrado sem empenho que o anteceda | pagamento sem `NroEmpenho` válido ou data de empenho posterior ao pagamento | SM-EMP, SM-DESP | 5 | Lei 4.320/1964 art. 60 | ✅ | ⚡ |
| **OR-02** | Liquidação sem empenho | Liquidação sem empenho correspondente | liquidação sem empenho vinculado | SM-EMP | 4 | Lei 4.320/1964 art. 63 | ✅ | |
| **OR-03** | Empenho sem liquidação prolongada | Empenho aberto há muito tempo sem liquidar | empenho aberto > 90 dias sem liquidação, exercício corrente | SM-EMP | 2 | Lei 4.320/1964 art. 58–63 | ✅ | ⚡ |
| **OR-04** | Quebra da ordem cronológica | Pagamento fora da ordem cronológica por fonte/categoria | fornecedor pago antes de outro com liquidação mais antiga na mesma fonte | SM-ORDEM, SM-EMP | 4 | Lei 14.133/2021 art. 141; LC 131/2009 | ✅ | ⚡ |
| **OR-05** | Dotação executada acima de 100% | Dotação com execução superior ao orçado sem suplementação registrada | empenhado/dotação > 1,00 sem crédito adicional correspondente | SM-DESP, DOM | 4 | Lei 4.320/1964 art. 59; LRF | ✅ | |
| **OR-06** | Suplementações repetidas na mesma dotação | Mesma dotação suplementada várias vezes (planejamento frágil) | ≥3 créditos adicionais na mesma dotação no exercício | DOM, SM-DESP | 3 | Lei 4.320/1964 art. 40–43; LDO | 🟡 | |
| **OR-07** | Empenho anulado e reemitido | Empenho anulado e refeito ao mesmo fornecedor/valor (possível maquiagem) | anulação + novo empenho mesmo CNPJ/valor próximo em janela curta | SM-DESP | 3 | Lei 4.320/1964; LRF art. 42 | ✅ | |
| **OR-08** | Liquidações concentradas em fim de período | Pico de liquidações no fim do mês/exercício | fatia anormal das liquidações concentrada nos últimos 5 dias úteis | SM-EMP | 2 | Lei 4.320/1964 art. 63; LRF art. 42 | ✅ | ⚡ |
| **OR-09** | Reforço de empenho atípico | Reforços sucessivos elevando empenho original | ≥3 reforços no mesmo empenho ou reforço > 50% do valor original | SM-DESP | 2 | Lei 4.320/1964 art. 60 | ✅ | |
| **OR-10** | Despesa em elemento incompatível com o objeto | Objeto contratado classificado em elemento de despesa que não corresponde | descrição do objeto sem aderência ao elemento de despesa declarado | SM-DESP, SM-ITENS | 2 | Lei 4.320/1964 art. 12–13; Portaria STN | ✅ | |

---

## 10. METAS FISCAIS E LRF (MF-01 … MF-14)

Subsistema de monitoramento contínuo — exercício atual + série histórica. A
causa nº 1 de rejeição de contas não é desvio: é estouro de limite ou perda
de prazo (transcrições). Confirmação externa: TCE-SP alertou 86–89% dos
municípios paulistas por risco de descumprimento da LRF em 2024–2025.

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **MF-01** | Aplicação em Saúde abaixo do mínimo | Aplicação em saúde abaixo do piso constitucional | aplicação em saúde / receita de impostos < 15% | SICONFI, SM-LRF | 5 | EC 29/2000; LC 141/2012 art. 7º | ✅ | ⚡ |
| **MF-02** | Aplicação em Educação abaixo do mínimo | Aplicação em MDE abaixo do piso constitucional | aplicação em educação / receita de impostos < 25% | SICONFI, SM-LRF | 5 | CF art. 212 | ✅ | ⚡ |
| **MF-03** | FUNDEB — magistério abaixo de 70% | Remuneração do magistério abaixo do mínimo do FUNDEB | aplicação em magistério / FUNDEB < 70% | SICONFI, SM-LRF | 5 | CF art. 212-A | ✅ | ⚡ |
| **MF-04** | Pessoal Executivo no limite/alerta | Despesa de pessoal do Executivo próxima ou acima do teto da LRF | despesa pessoal / RCL: alerta ≥48,6% · prudencial ≥51,3% · limite >54% | SICONFI, SM-LRF | 5 | LRF art. 19–20, 22 | ✅ | ⚡ |
| **MF-05** | Pessoal Câmara no limite | Despesa de pessoal da Câmara próxima ou acima do teto | despesa pessoal Câmara / RCL > 6% (alerta a partir de 95% do limite) | SICONFI | 4 | LRF art. 20 II a; CF art. 29-A | ✅ | ⚡ |
| **MF-06** | Dívida consolidada acima do limite | Dívida consolidada líquida acima do teto do Senado | DCL / RCL > 120% | SICONFI | 4 | Resolução Senado 40/2001 | ✅ | |
| **MF-07** | Resultado primário fora da meta | Resultado primário descumprindo a meta da LDO | resultado primário apurado < meta do Anexo de Metas Fiscais | SICONFI, LEGIS | 3 | LRF art. 4º, 9º | 🟡 | |
| **MF-08** | Resultado nominal fora da meta | Resultado nominal divergente da meta da LDO | resultado nominal apurado fora da faixa da meta | SICONFI, LEGIS | 3 | LRF art. 4º | 🟡 | |
| **MF-09** | Restos a pagar sem cobertura de caixa | Restos a pagar inscritos acima da disponibilidade de caixa | RAP inscritos > disponibilidade de caixa por fonte (art. 42) | SICONFI, SM-RAP | 5 | LRF art. 42 | ✅ | ⚡ |
| **MF-10** | Restos a pagar antigos sem baixa | RAP de exercícios anteriores parados sem liquidação | RAP com inscrição > 2 anos sem baixa/pagamento | SM-RAP | 3 | LRF art. 42; Lei 4.320/1964 | ✅ | |
| **MF-11** | Atraso na publicação de RREO/RGF | Relatório fiscal não publicado dentro do prazo legal | data atual > prazo de publicação do RREO (bimestral) ou RGF (quadrimestral) sem documento | SICONFI, SM-LRF, DOM | 4 | LRF art. 52, 55; "prazo é linha vermelha" | ✅ | ⚡ |
| **MF-12** | Indicador fiscal em tendência de piora | Série histórica de um indicador piorando de forma consistente | indicador piora em ≥3 períodos consecutivos aproximando-se do limite | SICONFI | 3 | LRF art. 59; padrão estatístico | ✅ | |
| **MF-13** | Queda de investimento social em ano eleitoral | Investimento em saúde/educação cai no ano eleitoral vs. anterior | queda > 10% no investimento em saúde ou educação vs. exercício anterior | SICONFI | 4 | Padrão estatístico; LC 141/2012; CF 212 | ✅ | |
| **MF-14** | Arrecadação abaixo do previsto | Receita realizada muito abaixo da prevista na LOA (risco LRF art. 9º) | receita realizada / receita prevista no período < 90% (gatilho de limitação de empenho) | SM-REC, SICONFI | 3 | LRF art. 9º; art. 59 §1º I | ✅ | ⚡ |

---

## 11. DIÁRIO OFICIAL (DO-01 … DO-08)

Transforma atos publicados em dados rastreáveis. O DOM é onde a irregularidade
costuma aparecer primeiro como ato formal aparentemente comum.

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **DO-01** | Ato publicado fora do horário usual | Publicação de ato em horário/dia atípico | ato publicado em fim de semana, feriado ou fora do horário padrão | DOM | 2 | Princípio da publicidade; controle interno | ✅ | |
| **DO-02** | Decreto de crédito sem amparo legal citado | Decreto de abertura de crédito sem indicação da lei autorizativa | decreto de crédito adicional sem referência à lei orçamentária autorizativa | DOM, LEGIS | 3 | Lei 4.320/1964 art. 42–43 | ✅ | |
| **DO-03** | Volume anormal de atos num único DOM | Edição do DOM concentrando número atípico de atos sensíveis | nº de nomeações/dispensas/aditivos numa edição > média + 2 desvios | DOM | 2 | Padrão estatístico | ✅ | ⚡ |
| **DO-04** | Republicação/retificação de ato sensível | Ato de contratação/nomeação retificado após publicação | retificação de extrato de contrato, dispensa ou nomeação | DOM | 2 | Princípio da publicidade | ✅ | |
| **DO-05** | Extrato de contrato sem dados essenciais | Extrato publicado sem objeto, valor, prazo ou fornecedor | extrato de contrato/aditivo com campo essencial ausente | DOM | 3 | Lei 14.133/2021 art. 94; LC 131/2009 | ✅ | |
| **DO-06** | Composição de comissão de licitação | Mapeia membros de comissões publicados no DOM (insumo de cruzamento) | extrair portarias de nomeação de comissão/agente de contratação | DOM | 1 | Lei 14.133/2021 art. 8º (insumo para XS-01) | ✅ | |
| **DO-07** | Fiscal de contrato — mapeamento | Mapeia designações de fiscais publicadas (insumo de cruzamento) | extrair portarias de designação de fiscal de contrato | DOM | 1 | Lei 14.133/2021 art. 117 (insumo para SA-12) | ✅ | |
| **DO-08** | Sindicância/PAD aberto | Detecta abertura de sindicância ou PAD (contexto de risco) | publicação de instauração de sindicância/PAD | DOM | 2 | Lei 8.112-análoga; estatuto municipal | ✅ | |

---

## 12. CONVÊNIOS, REPASSES E TERCEIRO SETOR (TS-01 … TS-09)

Parcerias com OSC/OSS regidas pela Lei 13.019/2014 (MROSC). O TCE-SP aponta
prestação de contas insuficiente como falha recorrente no terceiro setor.

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **TS-01** | Parceria sem plano de trabalho publicado | Termo de colaboração/fomento sem plano de trabalho ou prestação de contas | parceria com repasse + ausência de plano de trabalho ou prestação de contas no prazo | SM-TS, SM-SUBV, DOM | 4 | Lei 13.019/2014 art. 42, 63–69 | 🟡 | |
| **TS-02** | OSC com CNPJ inativo/suspenso | Entidade beneficiada com situação cadastral irregular | situação cadastral da OSC ≠ ATIVA na data do repasse | SM-TS, CNPJ | 5 | Lei 13.019/2014 art. 39 | 🟡 | |
| **TS-03** | Prestação de contas fora do prazo | OSC não presta contas no prazo do MROSC | repasse + ausência de prestação de contas após 90 dias do fim da parceria/exercício | SM-TS | 4 | Lei 13.019/2014 art. 69 | 🟡 | |
| **TS-04** | Repasse sem chamamento público | Parceria celebrada sem chamamento e sem hipótese de dispensa válida | termo de colaboração sem chamamento e sem fundamento de dispensa/inexigibilidade | SM-TS, DOM | 4 | Lei 13.019/2014 art. 24, 30–32 | 🟡 | |
| **TS-05** | OSC com dirigente ligado a agente público | Entidade cujo dirigente tem vínculo com agente público | grafo: dirigente da OSC = servidor/agente político ou parente | SM-TS, SM-FOLHA, CNPJ | 5 | Lei 13.019/2014 art. 39 III; impessoalidade | 🔴 | |
| **TS-06** | Emenda impositiva sem repasse | Emenda parlamentar impositiva não executada no prazo | emenda impositiva sem empenho/repasse após 90 dias do prazo | SM-EMENDA | 3 | CF art. 166 §§9º–18; LDO | ✅ | ⚡ |
| **TS-07** | Concentração de repasses numa OSC | Mesma entidade concentra fatia anormal das parcerias | uma OSC > 30% do valor de parcerias do exercício | SM-TS, SM-SUBV | 3 | Lei 13.019/2014; impessoalidade | ✅ | |
| **TS-08** | OSC de saúde sem habilitação válida | Entidade na área de saúde sem CEBAS/habilitação recebendo recurso | OSC de saúde sem CEBAS ou habilitação válida + repasse | SM-TS | 4 | Lei 12.101/2009; Lei 13.019/2014 | 🔴 | |
| **TS-09** | Despesa fora do plano de trabalho | Recurso de parceria aplicado em item não previsto | item de despesa da prestação de contas sem previsão no plano aprovado | SM-TS | 3 | Lei 13.019/2014 art. 66 | 🔴 | |

---

## 13. CRUZAMENTOS CROSS-SOURCE (XS-01 … XS-14)

O núcleo do diferencial do NEXO — só existem combinando duas ou mais fontes.
Estes monitoramentos rodam no motor de correlação / grafo.

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **XS-01** | Membro de comissão sócio de vencedora | Integrante de comissão de licitação é sócio de empresa vencedora | grafo: CPF de membro de comissão (DO-06) ∈ sócios da empresa vencedora (CNPJ) | DOM, CNPJ, EDITAL | 5 | Lei 14.133/2021 art. 9º; Lei 8.429/1992 | 🟡 | |
| **XS-02** | Dispensa no DOM ausente do portal | Dispensa publicada no Diário Oficial sem empenho correspondente no portal | dispensa no DOM sem registro em `DespesaAgrupada`/`fornecedor` por nº de processo | DOM, SM-DESP | 4 | LC 131/2009; LAI; Lei 14.133 art. 94 | 🟡 | ⚡ |
| **XS-03** | Decreto de crédito sem execução registrada | Decreto de abertura de crédito no DOM sem empenhos rastreáveis | decreto de crédito adicional no DOM sem empenhos na dotação no prazo | DOM, SM-DESP | 4 | Lei 4.320/1964 art. 42–43 | 🟡 | |
| **XS-04** | Portaria de nomeação sem servidor na folha | Nomeação publicada no DOM sem servidor correspondente na folha | portaria de nomeação no DOM sem registro do nome/matrícula na folha em até 2 meses | DOM, SM-FOLHA | 5 | CF art. 37; servidor fantasma | 🟡 | |
| **XS-05** | Servidor sai da folha e vira PJ contratada | Ex-servidor recebendo como pessoa jurídica logo após exoneração | nome de servidor exonerado vinculado a sócio de CNPJ com contrato em até 12 meses | SM-FOLHA, DOM, CNPJ | 5 | Lei 14.133/2021 art. 9º §1º; Lei 8.429/1992 | 🔴 | |
| **XS-06** | Contrato publicado no DOM sem empenho | Extrato de contrato no DOM sem empenho/pagamento correspondente | extrato de contrato no DOM sem empenho vinculado por nº de contrato | DOM, SM-EMP | 3 | Lei 14.133/2021 art. 94; LC 131/2009 | 🟡 | |
| **XS-07** | Empenho sem contrato/processo publicado | Empenho de valor relevante sem contrato nem processo localizável | empenho > R$ 100k sem `numeroContrato`/`numeroProcesso` e sem extrato no DOM | SM-EMP, DOM, CONTR | 3 | Lei 14.133/2021 art. 95; LC 131/2009 | ✅ | ⚡ |
| **XS-08** | Norma alterada beneficiando fornecedor | Norma municipal cria exceção que beneficia fornecedor específico logo depois | norma no SAPL abre exceção + contratação compatível ao beneficiário em até 60 dias | LEGIS, SM-EMP, CNPJ | 5 | CF art. 37; Lei 8.429/1992 | 🔴 | |
| **XS-09** | Saldo contábil ≠ extrato bancário | Divergência entre saldo declarado e disponibilidade real de caixa | saldo contábil de disponibilidade − saldo do extrato bancário fora de tolerância | SICONFI, SM-LRF | 4 | LRF art. 42, 50; Lei 4.320/1964 | 🟡 | |
| **XS-10** | Empenho sem lastro de caixa | Empenho assumido sem disponibilidade financeira na fonte | empenho em fonte cuja disponibilidade de caixa é insuficiente | SM-DESP, SICONFI | 4 | LRF art. 16–17, 42 | 🟡 | |
| **XS-11** | CEP de obra coincide com fornecedor | Endereço da obra é o mesmo de empresa fornecedora (autocontratação física) | CEP/endereço da obra = endereço de CNPJ fornecedor | OBRAS, CNPJ | 4 | Lei 14.133/2021 art. 9º; Lei 8.429/1992 | 🔴 | |
| **XS-12** | CNPJ no endereço de agente público | Fornecedor com endereço de servidor/agente ou parente até 3º grau | endereço de CNPJ contratado = endereço de agente público/parente | CNPJ, SM-FOLHA | 5 | Lei 14.133/2021 art. 9º §1º; Lei 8.429/1992 | 🔴 | |
| **XS-13** | Reclamação no e-SIC × execução orçamentária | Tema com muitas reclamações enquanto há gasto declarado naquele serviço | pico de manifestações no e-SIC sobre um serviço + despesa relevante registrada no mesmo serviço | ESIC, SM-DESP | 3 | LAI; LC 131/2009 | 🔴 | |
| **XS-14** | Apontamento do TCE-SP sobre fornecedor/contrato | Fornecedor ou contrato local citado em julgado/apontamento do TCE-SP | match de CNPJ/nº de processo entre dados do município e base do TCE-SP/AUDESP | TCE, SM-EMP, CONTR | 4 | Competência do TCE-SP (CF art. 31) | 🔴 | |

---

## 14. RECEITA E RENÚNCIA (RC-01 … RC-06) — área transversal

Não constava do escopo original mas é red flag das transcrições ("a receita
entra mas não é lançada corretamente") e da LRF. Acrescentada por VÉRTEX.

| ID | Nome | O que detecta | Regra / lógica | Fontes | Sev. | Fundamento legal | Disp. | QW |
|---|---|---|---|---|---|---|---|---|
| **RC-01** | Queda atípica de arrecadação de tributo | Receita de um tributo cai de forma anômala vs. série histórica | arrecadação mensal de um tributo < média 12m − 2 desvios | SM-REC | 2 | LRF art. 11 (instituição e arrecadação) | ✅ | ⚡ |
| **RC-02** | Receita prevista sem realização | Rubrica orçada na LOA sem arrecadação correspondente | rubrica de receita prevista com realização ≈ 0 no exercício | SM-REC | 2 | Lei 4.320/1964; LRF art. 12 | ✅ | |
| **RC-03** | Renúncia de receita sem estimativa de impacto | Benefício fiscal concedido sem o estudo exigido pela LRF | norma de renúncia (isenção/anistia) sem estimativa de impacto orçamentário | LEGIS, DOM | 3 | LRF art. 14 | 🟡 | |
| **RC-04** | Dívida ativa estagnada | Estoque de dívida ativa sem cobrança/baixa relevante | dívida ativa cresce e arrecadação de dívida ativa ≈ 0 | SM-REC, SICONFI | 2 | LRF art. 11, 13; Lei 8.429/1992 (renúncia) | 🟡 | |
| **RC-05** | Receita de transferência abaixo do esperado | Transferências constitucionais/voluntárias muito abaixo do previsto | FPM/ICMS/transferências realizadas << previsto sem causa macroeconômica | SM-REC, SICONFI | 2 | Lei 4.320/1964 | ✅ | |
| **RC-06** | Lançamento de receita inconsistente entre fontes | Receita registrada no portal diverge da reportada ao SICONFI | receita total do portal ≠ receita do RREO no mesmo período | SM-REC, SICONFI | 3 | LRF art. 51; LC 131/2009 | 🟡 | |

---

## 15. Síntese e priorização

### 15.1 Contagem por área

| Área | Qtd. | Quick wins |
|---|---:|---:|
| Licitações e compras (LC) | 25 | 4 |
| Obras públicas (OB) | 14 | 0 |
| Frota e combustível (FC) | 11 | 2 |
| Saúde e almoxarifado (SA) | 13 | 1 |
| Contratos emergenciais (EM) | 8 | 0 |
| Diárias, eventos, publicidade (DE) | 13 | 5 |
| Fornecedores (FR) | 13 | 6 |
| Folha e terceirizados (FP) | 14 | 2 |
| Execução orçamentária (OR) | 10 | 5 |
| Metas fiscais e LRF (MF) | 14 | 9 |
| Diário Oficial (DO) | 8 | 2 |
| Convênios e terceiro setor (TS) | 9 | 2 |
| Cruzamentos cross-source (XS) | 14 | 2 |
| Receita e renúncia (RC) | 6 | 2 |
| **TOTAL** | **132** | **42** |

### 15.2 Os 12 monitoramentos mais valiosos (implementar primeiro)

Critério: alto valor de fiscalização × dado já disponível × validado nos
achados preliminares de 2026.

1. **LC-01 / LC-04 — Fracionamento e valor colado no limite.** Núcleo do
   manual do investigador; dado pronto (`SM-EMP`). DISPENSA+DISPENSADA já
   somam R$ 55,7M em 2026.
2. **FR-02 — Fornecedor de UF distante em serviço presencial.** Já há caso
   concreto (M Construções, Natal/RN, coleta de lixo, ~R$ 24M).
3. **FR-03 / FR-05 — CNPJ não-ativo / empresa punida recebendo pagamento.**
   Cruzamento direto, severidade 5, dado pronto.
4. **MF-01/02/03/04 — Mínimos constitucionais e pessoal LRF.** Causa nº 1 de
   rejeição de contas; SICONFI estável; 86–89% dos municípios paulistas já
   alertados pelo TCE-SP.
5. **MF-09 / MF-11 — Restos a pagar sem caixa e atraso de RREO/RGF.** "Prazo
   é linha vermelha"; flagra problema antes do TCE.
6. **OR-01 / OR-04 — Pagamento sem empenho e quebra de ordem cronológica.**
   Indício forte, dado pronto, visão fixa dedicada (`SM-ORDEM`).
7. **LC-07 — Inexigibilidade frágil.** R$ 54,4M em inexigibilidade em 2026 —
   o maior bolso sole-source do orçamento.
8. **FR-07 — Sócios/endereço/contador em comum.** Coração da detecção de
   competição figurativa; precisa de enriquecimento CNPJ mas é o diferencial.
9. **DE-02 / DE-03 — Acúmulo e sobreposição de diárias.** Dado pronto
   (`SM-DIA`); já há beneficiários atípicos identificados.
10. **XS-02 — Dispensa no DOM ausente do portal.** Cruza duas fontes já
    integradas; flagra pagamento sem publicidade.
11. **FP-09 — Nomeações concentradas pré-eleição.** 2026 é ano eleitoral
    municipal — janela de risco aberta agora.
12. **DE-08 — Show por intermediária recém-criada.** "Farra dos shows";
    altíssima severidade, alto apelo de fiscalização.

### 15.3 Quick wins (42) — dado pronto + regra simples

Marcados com ⚡ nas tabelas. São o backlog de detecção da Fase 1, todos
rodando só com fontes Tier A já confirmadas (SMARAPD + SICONFI) ou com o DOM
já indexado:

`LC-01` · `LC-04` · `LC-06` · `LC-18` · `FC-01` · `FC-02` · `SA-08` ·
`DE-02` · `DE-03` · `DE-06` · `DE-12` · `FR-01` · `FR-02` · `FR-03` ·
`FR-05` · `FR-06` · `FR-12` · `FP-01` · `FP-09` · `OR-01` · `OR-03` ·
`OR-04` · `OR-08` · `MF-01` · `MF-02` · `MF-03` · `MF-04` · `MF-05` ·
`MF-09` · `MF-11` · `MF-14` · `DO-03` · `TS-06` · `RC-01` · `XS-02` ·
`XS-07` — e os demais marcados ⚡ nas tabelas das §1–§14.

> Recomendação de sequência: começar pelo bloco MF (9 quick wins, maior
> impacto político-institucional, API SICONFI limpa) e pelo bloco FR
> (6 quick wins, valida os achados preliminares de 2026), em paralelo.

### 15.4 O que depende de novas integrações

- **Obras (OB-01…14)** — exige conector de `OBRAS` + `SINAPI/SICRO`. Maior
  bloco "travado" (14 detectores, 0 quick wins). Prioridade de Fase 2.
- **Frota detalhada (FC-03…11)** — exige dados de abastecimento, em geral só
  por LAI. FC-01/FC-02 já cobrem o gasto agregado enquanto isso.
- **Almoxarifado da Saúde (SA-01…07)** — exige acesso ao sistema de estoque,
  via LAI. É o 3º ponto da PF — vale insistir na obtenção do dado.
- **Editais/contratos (LC-08…16, EM-05…07)** — exige scraping do portal de
  editais e contratos. Habilita o módulo de licitações por dentro.
- **CEIS/CNEP, TCE-SP, TSE** — fontes externas de Fase 2/3 que destravam
  FR-04, FR-13, XS-14 e os cruzamentos políticos.

---

## 16. Tabela de migração de IDs (arquitetura v1.0 → catálogo unificado)

| ID antigo | ID novo | ID antigo | ID novo |
|---|---|---|---|
| A01 | LC-01 | D06 | FR-03 |
| A02 | LC-04 | E01 | FP-01 |
| A03 | LC-08 | E02 | FP-02 |
| A04 | LC-10 | E03 | FP-06 |
| A05 | LC-19 | E04 | FP-09 |
| A06 | LC-16 | E05 | FP-03 |
| A07 | LC-22 | E06 | FP-07 |
| A08 | FR-07 (endereço) | E07 | FP-05 |
| A09 | FR-04 | F01 | TS-01 |
| A10 | LC-13 / FR-07 | F02 | TS-06 |
| B01 | OR-03 | F03 | TS-02 |
| B02 | OR-01 | F04 | TS-08 |
| B03 | OR-05 | G01 | OB-07 |
| B04 | OR-06 | G02 | OB-09 |
| B05 | OB-07 | G03 | OB-12 |
| B06 | MF-10 | G04 | OB-11 / LC-20 |
| B07 | OR-04 | H01 | XS-01 |
| C01 | MF-01 | H02 | XS-03 |
| C02 | MF-02 | H03 | XS-02 |
| C03 | MF-13 | H04 | XS-04 |
| C04 | MF-03 | H05 | XS-05 |
| D01 | FR-01 | H06 | FR-13 |
| D02 | XS-12 | H07 | XS-11 |
| D03 | LC-23 | H08 | XS-08 |
| D04 | OR-04 | — | — |
| D05 | EM-02 | — | — |

Os 38 detectores da v1.0 estão todos cobertos; o catálogo unificado os expande
de 38 para 132.

---

## 17. Recomendações de atualização ao plano-mestre

Para incorporar ao `nexo-plano-mestre.md`:

1. **Adicionar a área transversal "Receita e Renúncia" (RC)** ao §6 — hoje o
   plano cobre só o lado da despesa. Renúncia sem estudo de impacto (RC-03) e
   divergência de receita entre fontes (RC-06) são red flags diretas da LRF e
   das transcrições.
2. **Substituir a numeração `A`–`H` pelo esquema unificado de 14 prefixos**
   deste catálogo. O §6 cita "≈38 detectores"; o número de compromisso passa
   a ser **132 monitoramentos**.
3. **Promover o subsistema de Metas Fiscais a entrega da Fase 1 com os 9
   quick wins** (MF-01…05, 09, 11, 14) explicitados — é o bloco de maior
   retorno e menor custo (API SICONFI limpa).
4. **Criar um conector de e-SIC/Ouvidoria (1Doc)** no mapa de fontes §3 — hoje
   ausente. Habilita XS-13 e SA-07 e dá um sinal de "omissão administrativa"
   que nenhuma outra fonte oferece.
5. **Registrar a tabela de limites de dispensa por exercício (§0.5)** como
   artefato versionado e citá-la no §6 — o plano menciona a tabela mas não a
   materializa.
6. **Acrescentar ao §8 (cron) o job de coleta de receita** (`SM-REC`) — hoje
   o cron cobre despesas, empenhos, diárias, folha e DOM, mas não receita,
   necessária para RC-01…06 e MF-14.
7. **Incluir mapeamento de comissões de licitação e fiscais de contrato
   (DO-06/DO-07)** como rotina permanente do conector do DOM — são insumo
   obrigatório dos cruzamentos XS-01 e SA-12.
8. **Sinalizar contexto eleitoral de 2026**: o multiplicador "ano eleitoral
   +10" do §7 deve estar ativo agora; os detectores DE-10/11/12 e FP-09 são
   prioridade de calendário, não só de backlog.

---

## Disclaimer obrigatório

> Este catálogo descreve monitoramentos que processam dados públicos e
> identificam padrões estatisticamente atípicos que podem (ou não) indicar
> irregularidades. Nenhum item aqui constitui acusação, prova de improbidade
> ou de ilícito. Os fundamentos legais citados servem apenas à análise humana
> e não representam enquadramento. Todo indício deve ser investigado pelas
> instituições competentes (TCE-SP, Ministério Público, Controladoria) antes
> de qualquer juízo de valor.

---

## Fontes de pesquisa (jurisprudência e padrões)

- TCU — Cartéis, superfaturamento e atuação do TCU: <https://portal.tcu.gov.br/imprensa/noticias/carteis-superfaturamento-e-a-atuacao-do-tcu>
- TCU — Investigação de fraudes em licitações (Companhia Docas do Pará): <https://portal.tcu.gov.br/imprensa/noticias/tcu-continua-investigacao-sobre-fraudes-em-licitacoes-promovidas-pela-companhia-docas-do-para>
- TCE-SP — 86% dos municípios paulistas com desequilíbrio nas contas: <https://www.tce.sp.gov.br/6524-86-municipios-paulistas-apresentam-desequilibrio-contas-aponta-tcesp>
- TCE-SP — 89% dos municípios alertados por risco de descumprir a LRF: <https://www.tce.sp.gov.br/6524-89-municipios-paulistas-sao-alertados-por-risco-descumprir-lrf>
- TCE-SP — Gasto excessivo com pessoal: <https://www.tce.sp.gov.br/6524-cada-dez-prefeituras-apresenta-gasto-excessivo-com-pessoal>
- TCE-SP — Manual de Repasses Públicos ao Terceiro Setor: <https://www.tce.sp.gov.br/sites/default/files/publicacoes/repasses_publicos_terceiro_setor.pdf>
- CNMP — Nepotismo e nepotismo cruzado, critérios de controle: <https://www.cnmp.mp.br/portal/institucional/724-institucional/comissoes-institucional/comissao-de-controle-administrativo-e-financeiro/ordenador-de-despesas/recursos-humanos-e-gestao-de-pessoas/1229-nepotismo-e-nepotismo-cruzado-criterios-de-controle>
- STF — Súmula Vinculante 13: <https://portal.stf.jus.br/noticias/verNoticiaDetalhe.asp?idConteudo=532538>
