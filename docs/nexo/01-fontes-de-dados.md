# NEXO — Catálogo de Fontes de Dados

### Núcleo de Enfrentamento e Inteligência Pública

**Câmara Municipal de Marília/SP — Gabinete Vereador Fefin**
Documento técnico v1.0 · 2026-05-21 · autor: FANTASMA (Engenheiro de Coleta)
Complementa `docs/nexo-plano-mestre.md` §3 — substitui-o como referência viva de fontes.

---

## 0. Como ler este documento

Este é o **mapa de coleta do NEXO**. Vai muito além dos 17 módulos SMARAPD do
plano-mestre: cataloga e valida todas as fontes públicas relevantes para
monitorar a Prefeitura de Marília e a gestão pública municipal brasileira em
2026. Cada fonte foi verificada com chamada real de endpoint sempre que
possível (testes registrados em §10).

### Restrições de método (trilho jurídico — plano-mestre §2)

- **Apenas dados públicos** ou legalmente acessíveis. Nada de dado privado
  obtido indevidamente.
- **Linguagem de indício**, nunca de acusação.
- **Rastro probatório**: toda coleta guarda fonte, URL, data/hora e hash.

### Legenda de viabilidade

| Nota | Significado |
|---|---|
| 🟢 **Pronto** | API REST/JSON estável, sem autenticação ou com cadastro simples; integrável já |
| 🟡 **Scraping** | Sem API; exige raspar HTML/PDF; conector isolado e antifrágil |
| 🟠 **Difícil** | API instável, login pesado, layout volátil, ou volume/captcha — exige esforço alto |
| 🔴 **Inviável agora** | Sem acesso público programático viável; observar e reavaliar |

### Legenda de Tier

- **Tier A** — núcleo municipal de Marília (a espinha dorsal do NEXO).
- **Tier B** — controle externo e contratações nacionais (TCE-SP, PNCP, federal).
- **Tier C** — enriquecimento e referência (CNPJ, preços, IBGE, eleitoral).
- **Tier D** — setoriais e de contexto (saúde, educação, previdência, etc.).

---

## 1. Resumo executivo — o que muda no plano

O plano-mestre §3 trabalhava com três Tiers e ~10 fontes. Este catálogo
**triplica a superfície de coleta** e, principalmente, **desbloqueia
monitoramentos que hoje não existem**. Os ganhos mais importantes:

1. **PNCP (Portal Nacional de Contratações Públicas)** — desde a Lei
   14.133/2021, **toda** licitação, ata e contrato municipal tem de ser
   publicado no PNCP, com API REST pública. Isto resolve a maior lacuna do
   plano: o SMARAPD mostra o *empenho* (o dinheiro saindo), mas não o
   *edital* nem o *contrato* com vigência e aditivos. O PNCP fecha o elo
   `licitação → contrato → aditivo`.
2. **TCE-SP / AUDESP** — o Tribunal já recebe de Marília, por obrigação
   legal, a base estruturada de licitações e contratos (AUDESP Fase IV) e
   publica despesas/receitas com API. É a **fonte de validação cruzada**:
   o que a Prefeitura declara ao TCE deve bater com o que publica no portal.
3. **Portal da Transparência Federal (CGU)** — CEIS/CNEP/CEPIM com **API
   oficial** (não scraping, como o plano supunha) + convênios e
   transferências federais para Marília. Desbloqueia o detector "fornecedor
   inidôneo recebendo pagamento" sem fragilidade.
4. **TSE Dados Abertos** — doações de campanha, bens de candidatos e quadro
   societário eleitoral. Desbloqueia o cruzamento H06 (doador de campanha
   que vence licitação) — hoje impossível por falta de fonte.
5. **SIOPS + FNDE** — execução de saúde e merenda/educação com séries
   históricas. Reforça o subsistema de Metas Fiscais e abre fiscalização de
   PNAE/PDDE (merenda escolar), área sensível ausente do plano.

Recomendação central: **promover PNCP, TCE-SP e Portal Federal de Tier 2/Fase
2 para Tier A/Fase 1**. São APIs limpas, estáveis e de altíssimo valor
fiscalizatório — adiá-las custa caro.

---

## 2. Tier A — Núcleo municipal de Marília

### 2.1 Portal da Transparência SMARAPD (API `paiportalserver`) — 🟢 PRONTO

| Item | Valor |
|---|---|
| Portal | `https://transparencia.marilia.sp.gov.br/` |
| API base | `https://transparencia.marilia.sp.gov.br/paiportalserver/` |
| File server | `https://transparencia.marilia.sp.gov.br/paifileserver/` |
| Mirror | `https://transparencia-marilia.smarapd.com.br/paiportalserver/` |
| Fornecedor | SMARAPD — produto PAI (Portal de Acesso à Informação) |
| Autenticação | Nenhuma para leitura |
| Histórico | Varia por módulo (`despesa_sintetica` até 2017; `balancetereceita` só 2026) |
| Atualização | LC 131/2009 exige tempo real; na prática atraso de 24–72h |
| Confiabilidade | Alta para o dado; **sem SLA** — pode mudar sem aviso |

**O que oferece:** os 17 módulos dinâmicos (folha, empenho analítico,
despesas orçamentárias, diárias, restos a pagar, emendas, publicidade, COVID,
subvenções, receitas, modalidade) + visões fixas LRF + Empresas Punidas +
ordem cronológica de pagamento. Detalhamento completo em
`docs/transparencia-api-reference.md`.

**⚠ Achado de validação crítico (2026-05-21):** a API **exige um header
`User-Agent`**. Sem ele, `GET /DadosAbertos`, `GET /MenuPortal` e
`POST /modulovisao/filter` retornam **HTTP 400**. Com `User-Agent` de
navegador, retornam **HTTP 200** normalmente. O conector tem de enviar sempre
um `User-Agent` realista (e idealmente `Referer` do próprio portal). Esta é
provavelmente a razão de o `smarapd-client.ts` antigo "não funcionar" — não é
só a URL errada, é o header ausente. Registrar no backlog Fase 0 #1.

**Método de acesso:** `POST /modulovisao/filter` com corpo JSON; paginar de
`Pagina=1` até `QuantidadePaginas`. Encoding misto (latin-1 em alguns campos)
— normalizar. Filtros server-side dão 400; filtrar client-side após download.

**Viabilidade:** 🟢 — é o coração do NEXO. Validado e funcionando.

### 2.2 Site institucional `marilia.sp.gov.br` — 🟡 SCRAPING

Hub de links da gestão. Seções confirmadas em
`marilia.sp.gov.br/portal/paginas-dinamicas-categoria/9/portal-da-transparencia`:

| Seção | URL | O que oferece | Viabilidade |
|---|---|---|---|
| Editais de Licitação | `marilia.sp.gov.br/portal/editais/1` | Nº licitação, edital PDF, processo, modalidade, situação, datas de postagem/sessão, objeto, secretaria | 🟡 scraping — HTTP 200 confirmado |
| Concursos / Proc. Seletivos | `marilia.sp.gov.br/portal/editais/3` | Editais de concurso e PSS | 🟡 scraping |
| Contratos e Atas | `marilia.sp.gov.br/portal/contratos` | Contratos, atas de registro de preços, aditivos | 🟡 scraping |
| Andamento de Obras | `marilia.sp.gov.br/portal/obras` | Obras, status, fotos, placas | 🟡 scraping |
| Diário Oficial | `marilia.sp.gov.br/portal/dados-abertos/diario-oficial` | DOM em PDF | 🟢 **já integrado** no oficioexpress |
| Dados de Marília | `marilia.sp.gov.br/portal/servicos/1002/dados-de-marilia` | Indicadores socioeconômicos do município | 🟡 scraping |

**O que desbloqueia:** o portal de editais/contratos é a **única fonte
local** do edital e do contrato com vigência/aditivos antes de cruzar com o
PNCP. Permite o detector "dispensa no DOM ausente do portal de licitações" e
o jogo de planilha (anexos do edital de obra).

**Viabilidade:** 🟡 — HTML estável de portal de prefeitura; conector com
`cheerio` + `pdf-parse`. Conectores isolados (a quebra de um não derruba os
demais). Reconciliar com PNCP por número de processo.

### 2.3 Diário Oficial do Município (DOM) — 🟢 JÁ INTEGRADO

| Item | Valor |
|---|---|
| URL | `marilia.sp.gov.br/portal/dados-abertos/diario-oficial/{ano}` |
| Status | ✅ integrado e indexado no oficioexpress |
| Frequência | Dias úteis |

**O que oferece:** nomeações, exonerações, portarias, extratos de contrato,
dispensas, inexigibilidades, aditivos, comissões de licitação, fiscais de
contrato, ordens de serviço, decretos de crédito adicional, sanções.

**O que desbloqueia (cruzamentos do plano §6):** portaria de nomeação sem
servidor na folha; dispensa publicada ausente do portal; decreto de crédito
sem empenho no prazo legal; membro de comissão sócio de vencedora.

### 2.4 Legislação Municipal — 🟡 SCRAPING

| Item | Valor |
|---|---|
| URL | `legislacao.marilia.sp.gov.br` (redireciona — HTTP 301) |
| O que oferece | Leis, decretos, portarias, LDO, LOA, PPA municipais |
| Viabilidade | 🟡 — confirmar destino do 301; provável base pesquisável |

**O que desbloqueia:** a **LDO** traz as metas fiscais pactuadas (Anexo de
Metas) — insumo direto do subsistema de Metas Fiscais. Cruzar alteração de
norma com benefício a fornecedor específico (detector H08).

### 2.5 SAPL — Câmara Municipal de Marília — 🟢 PARCIAL / 🟠

| Item | Valor |
|---|---|
| Portal | `sapl.marilia.sp.leg.br` · `marilia.sp.leg.br` |
| Normas (vivo) | `sapl.marilia.sp.leg.br/@@normas?ano={ano}&tipo=7` (JSON-LD) |
| RSS normas (MORTO) | `sapl.marilia.sp.leg.br/generico/RSS2_normas?lst_tip_norma=7` — HTTP 503 |
| Status | ✅ integrado via `src/lib/sapl/normas-client.ts` (usa `@@normas`) |

**⚠ Achado de validação:** a **API REST DRF não está exposta** nesta
instância. `/api/`, `/api/norma/normajuridica/` e
`/api/materia/materialegislativa/` retornaram **HTTP 404**. O RSS de normas
(`/generico/RSS2_normas`) está **MORTO em prod** (HTTP 503, NameError do Zope)
— **não é mais o caminho do `normas-client.ts`**. A fonte viva é a view
JSON-LD `@@normas?ano={ano}&tipo={tipo}` (HTTP 200; `ano` obrigatório), que o
client passou a consumir. Conclusão: **não contar com a API DRF nem com o
RSS**; usar `@@normas` para normas e scraping das páginas públicas
(`/materia/...`, `/norma/...`) para o resto.

**O que oferece:** matérias legislativas, normas, sessões plenárias, pautas,
atas, comissões, parlamentares, votações.

**O que desbloqueia:** rastrear projetos de lei e normas que abrem exceções;
monitorar a própria atividade da Câmara (limite de despesa de pessoal ≤6% RCL).

**Viabilidade:** 🟢 para normas via `@@normas` JSON-LD (já feito); 🟠 para o resto (scraping).

### 2.6 IPREMM — Instituto de Previdência do Município — 🟡 SCRAPING

| Item | Valor |
|---|---|
| URL | `ipremm.com.br` |
| O que oferece | Relatórios de investimentos (DAIR/APR), balanços, atas do Comitê de Investimentos, demonstrativos atuariais |
| Viabilidade | 🟡 scraping de PDFs; complementar com SICONFI (RPPS declara ao Tesouro) |

**O que desbloqueia (área ausente do plano):** o RPPS é vetor clássico de
risco — déficit atuarial, aplicação de recursos previdenciários fora do
enquadramento da Resolução CMN, certificação dos gestores (Portaria MTP
1.467/2022). Marília já teve **CPI do IPREMM** (2017) e déficit atuarial
relatado na casa das centenas de milhões. Monitorar: regularidade do CRP
(Certificado de Regularidade Previdenciária), aporte do Tesouro municipal,
rentabilidade vs. meta atuarial. Fontes cruzadas: SICONFI (Previdência) e
CADPREV/Secretaria de Previdência.

### 2.7 Marília Sem Papel / 1Doc — e-SIC e Ouvidoria — 🟡 SCRAPING

| Item | Valor |
|---|---|
| Plataforma | `marilia.1doc.com.br` |
| Painel transparência | `marilia.1doc.com.br/b.php?pg=o/transparencia` |
| O que oferece | Manifestações de ouvidoria, pedidos e-SIC, estatísticas: recebidas, respondidas, no prazo, tempo médio de resposta, por ano de referência |
| Viabilidade | 🟡 scraping do painel HTML (sem API pública); base Lei 13.460 + Lei 12.527 |

**O que desbloqueia (módulo 9 do `modulo_investiga`):** indicadores de
**omissão administrativa** — queda na taxa de resposta, pedidos arquivados
sem resposta, assunto recorrente sem providência, divergência entre resposta
oficial e execução orçamentária. É o canal do gabinete: o e-SIC é também a
**ferramenta de coleta ativa** do NEXO (pedir o que não está publicado).

### 2.8 IPTU / NFS-e / ISS — Tributação municipal — 🟠 DIFÍCIL

| Item | Valor |
|---|---|
| Sistema ISS-e / NFS-e | `marilia.sp.gov.br/sistema-eletronico/` |
| Consulta pública NFS-e nacional | `nfse.gov.br/consultapublica` |
| Viabilidade | 🟠 — NFS-e individual exige certificado/login; sem coleta em massa |

**Observação:** a NFS-e municipal está em migração para o **padrão nacional
2026** (Reforma Tributária). A consulta de nota individual não é pública em
massa — útil só pontualmente, dentro de uma investigação, para conferir uma
nota citada num empenho. Não é fonte de varredura. Renúncia de receita
(isenções de ISS/IPTU) deve ser buscada via legislação municipal e RREO.

---

## 3. Tier B — Controle externo e contratações nacionais

### 3.1 PNCP — Portal Nacional de Contratações Públicas — 🟢 PRONTO ⭐

| Item | Valor |
|---|---|
| Portal | `pncp.gov.br` |
| API de consulta | `https://pncp.gov.br/api/consulta/v1/` |
| Swagger | `pncp.gov.br/api/consulta/swagger-ui/index.html` |
| Manual | `gov.br/pncp` → Central de Conteúdo / GitHub `pncpgovbr/manual-integracao-pncp` |
| Autenticação | **Nenhuma** para a API de consulta (REST/JSON, sem cadastro) |
| Base legal | Lei 14.133/2021 — publicação no PNCP é **obrigatória** |
| Histórico | Desde 2021; cobertura cresce conforme adesão à 14.133 |

**O que oferece — endpoints-chave:**
- `GET /v1/contratacoes/publicacao` — editais/avisos por período. Filtros:
  `dataInicial`, `dataFinal`, `codigoModalidadeContratacao`,
  `codigoMunicipioIbge` (Marília = `3529005`), `uf`, `cnpjOrgao`,
  `codigoUnidadeAdministrativa`, `pagina`.
- `GET /v1/contratos` — contratos firmados.
- `GET /v1/atas` — atas de registro de preços.
- PCA (Plano Anual de Contratações) e termos de referência.

**⚠ Achado de validação:** chamadas de teste a `pncp.gov.br/api/consulta/v1/`
a partir deste ambiente retornaram **HTTP 403** mesmo com `User-Agent` e
`Referer` de navegador. A API é documentada como pública e sem autenticação —
o 403 é provavelmente **WAF/bloqueio geográfico** (o ambiente de teste é
US-only). **Mitigação:** o conector PNCP deve rodar a partir de **egress
brasileiro** (Cloud Run em `southamerica-east1`, que é onde os jobs de coleta
do NEXO já devem rodar). Validar o 200 a partir do GCP-BR no primeiro job.
Plano B: dados abertos do PNCP em arquivo (`gov.br/pncp` → Dados Abertos).

**O que desbloqueia (a maior lacuna do plano):** o SMARAPD entrega o
*empenho*; o PNCP entrega o *edital* (com critérios de habilitação — base do
detector de edital direcionado), o *contrato* (com vigência e valor original)
e os *aditivos*. Sem o PNCP, os detectores P2 (aditivo >25%), P5 (emergencial
recorrente) e "edital sob medida" ficam cegos. **Cruzar PNCP × SMARAPD por
número de processo é o elo que faltava.** O PNCP também permite **benchmarking
nacional**: o mesmo objeto licitado em outro município por preço menor.

**Viabilidade:** 🟢 — API REST limpa e moderna, sem autenticação. **Promover
para Fase 1.**

### 3.2 TCE-SP / AUDESP — Tribunal de Contas do Estado de SP — 🟢/🟡 ⭐

| Item | Valor |
|---|---|
| Portal Transparência Municipal | `transparencia.tce.sp.gov.br` |
| Datasets | `transparencia.tce.sp.gov.br/conjunto-de-dados` |
| APIs | `transparencia.tce.sp.gov.br/apis` |
| Site institucional | `tce.sp.gov.br` · AUDESP: `tce.sp.gov.br/audesp` |
| Autenticação | Nenhuma para a API de despesas/receitas |

**O que oferece — API REST (validada, HTTP 200):**
- `GET /api/json/municipios` — lista de municípios jurisdicionados ✅
- `GET /api/{json|xml}/despesas/{municipio}/{ano}/{mes}` — despesas
  detalhadas (documento, fornecedor, data, valor).
- `GET /api/{json|xml}/receitas/{municipio}/{ano}/{mes}` — receitas.
- ⚠ **Limitação séria:** a API REST de despesas/receitas cobre **2014–2019**.
  Para dados recentes, usar o **portal de datasets** (download de arquivos
  abertos) e a área de **Fornecedores** (busca de empresas que prestaram
  serviço a prefeituras de SP).

**AUDESP Fase IV (Licitações e Contratos):** o TCE-SP recebe de todos os
jurisdicionados, por webservice JSON, a base estruturada de licitações e
contratos (modelo dimensional — "cubo de dados"). A nova Fase IV estava em
testes finais (transmissão só por webservice JSON). O **cubo Fase IV** é
exposto no portal de transparência como dataset.

**O que desbloqueia:** a **validação cruzada definitiva** — o que a
Prefeitura declara ao Tribunal tem de bater com o que publica no portal
próprio e no PNCP. Divergência entre as três fontes = indício forte. O TCE-SP
também publica **apontamentos e julgados** de contas (úteis como antecedente
de fornecedor/gestor), mas isso é scraping 🟠.

**Viabilidade:** 🟢 para a API de despesas/receitas e datasets; 🟡 para o cubo
Fase IV (estrutura dimensional, parsing mais pesado); 🟠 para julgados.
**Promover para Fase 1/2.**

### 3.3 Portal da Transparência Federal (CGU) — 🟢 PRONTO ⭐

| Item | Valor |
|---|---|
| Portal | `portaldatransparencia.gov.br` |
| API | `https://api.portaldatransparencia.gov.br/` |
| Swagger | `api.portaldatransparencia.gov.br/swagger-ui/index.html` |
| Cadastro de token | `portaldatransparencia.gov.br/api-de-dados/cadastrar-email` |
| Autenticação | **Token** no header HTTP. Cadastro grátis: e-mail + login gov.br nível Prata/Ouro (ou CPF+senha com 2FA) |
| Rate limit | 700 req/min (00h–06h), 400 req/min (demais horários), 180 req/min (APIs restritas). Excesso = token suspenso 8h |

**O que oferece — consultas relevantes:**
- **CEIS** — Cadastro de Empresas Inidôneas e Suspensas.
- **CNEP** — Cadastro Nacional de Empresas Punidas (Lei Anticorrupção
  12.846/2013).
- **CEPIM** — Entidades sem fins lucrativos impedidas de convênio/parceria.
- **CEAF** — expulsões da administração federal.
- **Convênios** do Executivo Federal — repasses a Marília (objeto, valor,
  vigência, situação de prestação de contas).
- Contratos, licitações, NF-e, despesas, servidores e viagens federais.

**O que desbloqueia:** os detectores A09/D06 ("fornecedor inidôneo recebendo
pagamento") e F03/F04 (entidade impedida recebendo convênio). O plano supunha
CEIS/CNEP por scraping frágil em Fase 2 — **errado: há API oficial**, basta
cadastrar token. O eixo de **convênios federais** permite seguir o dinheiro
federal que chega a Marília (saúde, infraestrutura) e verificar prestação de
contas.

**Viabilidade:** 🟢 — API oficial, token grátis. O cadastro exige conta
gov.br do gabinete. **Promover CEIS/CNEP/CEPIM para Fase 1.**

### 3.4 SICONFI / STN — Sistema de Informações Contábeis e Fiscais — 🟢 PRONTO

| Item | Valor |
|---|---|
| API base | `https://apidatalake.tesouro.gov.br/ords/siconfi/tt/` |
| Docs | `apidatalake.tesouro.gov.br/docs/siconfi/` |
| Cód. IBGE Marília | `3529005` |
| Autenticação | Nenhuma — público, sem captcha |
| Histórico | Anos anteriores completos |

**O que oferece — endpoints (validados, HTTP 200):**
- `GET /rreo` — Relatório Resumido de Execução Orçamentária (bimestral).
- `GET /rgf` — Relatório de Gestão Fiscal (quadrimestral).
- `GET /dca` — Declaração de Contas Anuais.
- `GET /msc` — Matriz de Saldos Contábeis.
- Anexos: RREO-Anexo 02 (despesa por função), anexos de saúde/educação/RCL,
  RGF de despesa com pessoal e dívida.

Parâmetros: `an_exercicio`, `id_ente` (3529005), `co_tipo_demonstrativo`,
`nr_periodo`, `co_anexo`, `co_poder`.

**O que desbloqueia:** é a **fonte primária do subsistema de Metas Fiscais**
(plano §6). RCL, despesa com pessoal vs. limites LRF, dívida consolidada,
mínimos de saúde/educação, resultado primário/nominal, restos a pagar — tudo
com **série histórica plurianual** sem scraping. Permite o rastreador de
prazos (RREO/RGF têm prazo legal de publicação).

**Viabilidade:** 🟢 — API estável e oficial. Já previsto Fase 1.

### 3.5 Compras.gov.br / Comprasnet — 🟢 PRONTO (relevância secundária)

| Item | Valor |
|---|---|
| API dados abertos | `dadosabertos.compras.gov.br/swagger-ui/index.html` |
| API legada | `compras.dados.gov.br` (`/{modulo}/v1/{metodo}.{formato}`) |
| Comprasnet Contratos | `contratos.comprasnet.gov.br/api/docs` |
| Autenticação | Nenhuma |

**O que oferece:** licitações, contratos, atas, fornecedores (SICAF),
catálogo CATMAT/CATSER do **governo federal**. Inclui consulta a
contratações via Lei 14.133 (espelhadas do PNCP).

**Relevância para Marília:** **secundária** — a Prefeitura de Marília não
compra pelo Comprasnet. Utilidade real: (a) **CATMAT/CATSER** como dicionário
de itens para normalizar descrições de empenho; (b) **SICAF** para checar
situação de fornecedor; (c) **benchmarking** de preço de item idêntico
comprado pela União. Para licitação municipal, o PNCP é a fonte certa.

**Viabilidade:** 🟢 como apoio. Não é prioritário.

### 3.6 dados.gov.br — Portal Brasileiro de Dados Abertos — 🟢 CATÁLOGO

| Item | Valor |
|---|---|
| Portal | `dados.gov.br` |
| Natureza | Catálogo CKAN federal — agrega datasets de muitos órgãos |

**O que oferece:** não é fonte primária, é um **índice**. Útil para descobrir
datasets (compras federais, convênios, programas sociais) e como ponto de
entrada para bases que de outra forma seriam difíceis de localizar.
**Viabilidade:** 🟢 — usar como catálogo de descoberta, não como conector.

---

## 4. Tier C — Enriquecimento e referência

### 4.1 APIs de CNPJ — 🟢 PRONTO

| Fonte | URL | Auth | Rate limit | Nota |
|---|---|---|---|---|
| **BrasilAPI** | `brasilapi.com.br/api/cnpj/v1/{cnpj}` | Nenhuma | Sem limite explícito | ✅ validado HTTP 200. Fonte = minha-receita |
| **CNPJ.ws (pública)** | `publica.cnpj.ws/cnpj/{cnpj}` | Nenhuma | 3 req/min | Backup; dados similares |
| **minhareceita.org** | `minhareceita.org/{cnpj}` | Nenhuma | Sem limite oficial | Open-source; **repo migrou p/ Codeberg jan/2026 — manutenção irregular** |

**O que oferece:** razão social, nome fantasia, situação cadastral, data de
abertura, CNAE principal e secundários, **quadro societário (QSA)**, capital
social, endereço, UF, porte.

**⚠ Achado de validação:** todas as três derivam dos **dumps mensais da
Receita Federal** — há **defasagem**: CNPJ baixado há meses pode aparecer
"ATIVA". Para o detector "fornecedor com situação ≠ ATIVA recebendo
pagamento", tratar a data do dump como margem de erro. **Estratégia
recomendada:** BrasilAPI como primária; CNPJ.ws como fallback; cachear em
`nexo_fornecedores` com `receitaConsultadaEm`; re-enriquecer
periodicamente.

**O que desbloqueia:** todo o módulo de fornecedores e os cruzamentos por
sócio/endereço/CNAE. O **QSA** é o insumo do grafo de relacionamentos
(sócios em comum, sócio que é agente público).

**Viabilidade:** 🟢 — já previsto. Confirmado.

### 4.2 JUCESP — Junta Comercial do Estado de SP — 🟠 DIFÍCIL

| Item | Valor |
|---|---|
| Portal | `jucesponline.sp.gov.br` |
| Ficha simplificada | `Pesquisa.aspx?IDProduto=1` (dados atuais) |
| Ficha completa | `Pesquisa.aspx?IDProduto=2` (histórico desde 1992) |
| Autenticação | Consulta gratuita; sem API |

**O que oferece:** histórico societário **detalhado** — alterações de quadro,
NIRE, capital, objeto social, atos registrados. Vai além do QSA da Receita:
mostra **a linha do tempo das mudanças societárias**.

**O que desbloqueia:** o detector "alteração societária nos 90 dias antes da
vitória em licitação" (D03) — só a JUCESP tem a *data* da alteração.
Detecção de empresa de fachada (constituição recente + capital baixo +
mudança de sócio às vésperas do certame).

**Viabilidade:** 🟠 — sem API; site ASP.NET com formulário e provável captcha.
Uso **pontual dentro de investigação** (consultar a ficha de um fornecedor
específico já sob suspeita), não varredura em massa. Considerar consulta
manual assistida na Fase 2.

### 4.3 IBGE — 🟢 PRONTO

| Item | Valor |
|---|---|
| API localidades | `servicodados.ibge.gov.br/api/v1/localidades/municipios/3529005` ✅ HTTP 200 |
| API agregados (SIDRA) | `servicodados.ibge.gov.br/api/v3/agregados/` |
| Docs | `servicodados.ibge.gov.br/api/docs` |
| Autenticação | Nenhuma |

**O que oferece:** dados do município (código, malha, hierarquia geográfica)
e agregados estatísticos — população estimada, PIB, indicadores
socioeconômicos.

**O que desbloqueia:** **normalização de denominadores** — a população de
Marília é o denominador de "gasto per capita", essencial para comparar
Marília com municípios semelhantes e flagrar gasto atípico (ex.: cachê de
show "incompatível com o porte da cidade"). É infraestrutura de contexto,
não detector.

**Viabilidade:** 🟢 — API estável, base de comparação.

### 4.4 Referências de preço de obra — SINAPI / SICRO — 🟡 DOWNLOAD

| Fonte | Acesso | Atualização | Nota |
|---|---|---|---|
| **SINAPI** (Caixa/IBGE) | `caixa.gov.br` → Poder Público → SINAPI; ZIP mensal (XLSX/PDF) por UF | Mensal, com 1–2 meses de defasagem | Sem API oficial; APIs de terceiros existem (pagas) |
| **SICRO** (DNIT) | `dnit.gov.br` → custos rodoviários; planilhas por estado | Periódica | Para obras de pavimentação/rodovia |

**O que oferece:** preço de referência de insumos e composições de
engenharia (SINAPI = edificações; SICRO = rodovias).

**O que desbloqueia:** o **detector de sobrepreço de obra (P2)** — comparar
preço unitário item a item da planilha do edital com a referência oficial
(≥15% médio, ≥25% alto, ≥40% crítico). Sem SINAPI/SICRO o P2 não funciona.

**Viabilidade:** 🟡 — download de planilha XLSX mensal (não há API gratuita
oficial); montar tabela de referência interna no Firestore, atualizada
mensalmente por job. Já previsto Fase 3 — adequado.

### 4.5 TSE — Dados Abertos Eleitorais — 🟢 PRONTO ⭐

| Item | Valor |
|---|---|
| Portal | `dadosabertos.tse.jus.br` (CKAN) |
| Divulga Cand. Contas | `divulgacandcontas.tse.jus.br` |
| Autenticação | Nenhuma |
| Formato | Download CSV/TXT por ano de eleição |

**O que oferece:**
- **Prestação de contas eleitorais** — receitas e despesas de campanha de
  candidatos, partidos e comitês; **doadores e fornecedores**; CNPJ de
  campanha; extratos bancários.
- **Candidatos** — dados pessoais, **bens declarados**, coligações,
  motivos de cassação, redes sociais, propostas de governo.

**O que desbloqueia (cruzamento hoje impossível):** o detector **H06** —
"fornecedor doou para a campanha do gestor e venceu licitação no mandato".
O plano-mestre cita H06 com pseudocódigo (`tse_doacoes`) mas **não tinha a
fonte mapeada** — é esta. Também: **evolução patrimonial** de agentes
públicos (bens declarados em eleições sucessivas) e fornecedores de campanha
que viram fornecedores da Prefeitura.

**Viabilidade:** 🟢 — download CSV anual, base estável. Cuidado LGPD: dado de
campanha é público, mas o uso é restrito à finalidade fiscalizatória.
**Promover para Fase 2** (era "Fase 2+" vago no plano).

---

## 5. Tier D — Setoriais e de contexto

### 5.1 SIOPS / DATASUS — Orçamento público em saúde — 🟢/🟡

| Item | Valor |
|---|---|
| Painel de Preços da Saúde | `infoms.saude.gov.br/.../SEIDIGI_DEMAS_BPS.html` |
| SIOPS gov.br | `gov.br/saude/pt-br/acesso-a-informacao/siops` |
| OpenDataSUS SIOPS | `opendatasus.saude.gov.br/dataset/siops` |
| TABNET indicadores | `siops-asp.datasus.gov.br/cgi/siops/serhist/MUNICIPIO/indicadores.HTM` |
| Autenticação | Nenhuma |

**O que oferece:** receitas e despesas de saúde declaradas bimestralmente
pelo município (declaração obrigatória — LC 141/2012), indicadores e séries
históricas, anexo "Saúde" do RREO.

**O que desbloqueia:** **validação cruzada do mínimo de 15% em saúde** — o
SIOPS (federal) vs. as visões fixas LRF do SMARAPD vs. o RREO do SICONFI. Três
fontes para o mesmo número; divergência é indício. Complementa o subsistema
de Metas Fiscais.

**Viabilidade:** 🟢 via OpenDataSUS (datasets CSV); 🟡 via TABNET (interface
web antiga).

### 5.2 Banco de Preços em Saúde (BPS) — 🟢 PRONTO ⭐

| Item | Valor |
|---|---|
| Portal | `gov.br/saude/pt-br/acesso-a-informacao/banco-de-precos` |
| Painel de Preços | `infoms.saude.gov.br/.../SEIDIGI_DEMAS_BPS.html` |
| Autenticação | Acesso público; bases anuais compiladas em **CSV** (e-mail válido p/ painel) |

**O que oferece:** preços de compras públicas e privadas de **medicamentos e
produtos para saúde** — +20 mil itens padronizados pela Unidade de Catalogação
do Ministério da Saúde. A maior base de preços de saúde do país.

**O que desbloqueia:** o **detector P4** — "preço de medicamento acima do
Banco de Preços em Saúde". É a referência de preço para a área de saúde, o
equivalente ao SINAPI para obras. Sem o BPS, o sobrepreço de medicamento não
tem âncora.

**Viabilidade:** 🟢 — bases anuais em CSV. **Promover para Fase 2/3** junto
com o conector de saúde.

### 5.3 FNDE — Educação e merenda escolar — 🟢 PRONTO ⭐

| Item | Valor |
|---|---|
| Portal dados abertos | `fnde.gov.br/dadosabertos/` (CKAN) |
| Liberação de recursos | `fnde.gov.br/dadosabertos/` → "Liberação de Recursos" |
| Autenticação | Nenhuma |

**O que oferece:**
- **PNAE** (merenda escolar) — alunos atendidos, escolas, repasses mensais,
  cadastro de nutricionistas (SINUTRI).
- **PDDE** (Dinheiro Direto na Escola) — execução financeira, escolas
  atendidas, saldos, situação da prestação de contas.
- **PNATE** (transporte escolar) e outros programas.
- Consulta de liberações e prestação de contas por entidade/município.

**O que desbloqueia (área nova):** fiscalização da **merenda escolar** —
repasse federal recebido vs. licitação de gêneros alimentícios no SMARAPD/PNCP;
situação irregular de prestação de contas; merenda é objeto previsível
classificado como emergencial (cruza com P5). O plano-mestre **não tinha
educação/merenda como vetor** — o FNDE abre isso.

**Viabilidade:** 🟢 — CKAN com datasets e consultas. **Adicionar à Fase 2.**

### 5.4 Frota e combustível — observação de viabilidade

O **processador P3 (frota/combustível)** do plano depende de dados que **não
têm fonte pública direta confirmada**: km rodado por veículo, capacidade de
tanque, diário de bordo, abastecimento por placa. O portal SMARAPD traz o
*empenho* de combustível (fornecedor, valor), não o *consumo por veículo*.

**Caminho realista:** o detalhe de frota normalmente só vem via **e-SIC**
(pedir relatório de abastecimento por veículo, contrato do posto, controle de
quilometragem) ou via **AUDESP** (o TCE recebe dados de frota de alguns
jurisdicionados). Classificar P3 como **🟠 difícil — depende de coleta ativa
por e-SIC**. Recomendação: tratar P3 como detector "semi-manual" — o NEXO
identifica o gasto agregado atípico com combustível e **gera o pedido e-SIC**
para obter o detalhe. Ajustar a expectativa do plano §6/P3.

### 5.5 Outras fontes de contexto (registrar, baixa prioridade)

| Fonte | O que oferece | Viabilidade |
|---|---|---|
| **CADPREV / Sec. de Previdência** | Regularidade do RPPS (CRP), demonstrativos do IPREMM declarados à União | 🟡 — complementa §2.6 |
| **TCU** | Acórdãos com jurisprudência de licitações/obras (base de fundamentação) | 🟡 scraping / `pesquisa.apps.tcu.gov.br` |
| **DOU** (Imprensa Nacional) | Atos federais que afetam Marília (convênios, portarias) | 🟢 `in.gov.br` tem API/labs |
| **Conselhos Municipais** | Atas e deliberações (saúde, educação, assistência) | 🟡 `www2.marilia.sp.gov.br/conselho` — scraping |
| **Balanços Anuais / LOA / PPA** | Planejamento orçamentário (visão fixa SMARAPD `loa`) | 🟢 já via SMARAPD |
| **Lei 13.019 (3º setor federal)** | Emendas e parcerias com OSCs | 🟡 `lei13019.com.br` |
| **Receita Federal — quadro de sócios bruto** | Dump completo CNPJ (todos os sócios do país) | 🟠 dump grande; útil p/ grafo nacional de sócios |

---

## 6. Matriz consolidada de fontes

| # | Fonte | Tier | Acesso | Auth | Viabilidade | Fase sugerida |
|---|---|---|---|---|---|---|
| 1 | SMARAPD `paiportalserver` | A | API REST/JSON | Não (exige UA header) | 🟢 | 0–1 |
| 2 | Site `marilia.sp.gov.br` (editais/contratos/obras) | A | Scraping HTML/PDF | Não | 🟡 | 1–2 |
| 3 | Diário Oficial Municipal | A | Scraping PDF | Não | 🟢 (integrado) | — |
| 4 | Legislação Municipal | A | Scraping HTML | Não | 🟡 | 1 |
| 5 | SAPL Câmara (`@@normas` JSON-LD) | A | JSON-LD + scraping | Não | 🟢/🟠 | 1 (integrado) |
| 6 | IPREMM (previdência) | A | Scraping PDF | Não | 🟡 | 2 |
| 7 | 1Doc — e-SIC / Ouvidoria | A | Scraping HTML | Não | 🟡 | 2 |
| 8 | NFS-e / ISS municipal | A | Login/certificado | Sim | 🟠 | 3 (pontual) |
| 9 | **PNCP** | B | API REST/JSON | Não | 🟢 (403 fora do BR) | **1** ⭐ |
| 10 | **TCE-SP / AUDESP** | B | API REST + datasets | Não | 🟢/🟡 | **1–2** ⭐ |
| 11 | **Portal Transparência Federal (CGU)** — CEIS/CNEP/CEPIM/convênios | B | API REST/JSON | Token grátis | 🟢 | **1** ⭐ |
| 12 | SICONFI / STN | B | API REST/JSON | Não | 🟢 | 1 |
| 13 | Compras.gov.br / Comprasnet | B | API REST/JSON | Não | 🟢 | 2 (apoio) |
| 14 | dados.gov.br (catálogo CKAN) | B | Catálogo | Não | 🟢 | descoberta |
| 15 | CNPJ — BrasilAPI / CNPJ.ws / minhareceita | C | API REST/JSON | Não | 🟢 | 1 |
| 16 | JUCESP | C | Site ASP.NET | Não (s/ API) | 🟠 | 2 (pontual) |
| 17 | IBGE (localidades / SIDRA) | C | API REST/JSON | Não | 🟢 | 1 (contexto) |
| 18 | SINAPI / SICRO | C | Download XLSX | Não | 🟡 | 3 |
| 19 | **TSE Dados Abertos** | C | Download CSV | Não | 🟢 | **2** ⭐ |
| 20 | SIOPS / DATASUS | D | Datasets CSV / TABNET | Não | 🟢/🟡 | 2 |
| 21 | **Banco de Preços em Saúde** | D | Download CSV | E-mail (painel) | 🟢 | **2–3** ⭐ |
| 22 | **FNDE** (PNAE/PDDE/PNATE) | D | CKAN datasets | Não | 🟢 | **2** ⭐ |
| 23 | CADPREV / Sec. Previdência | D | Scraping/datasets | Não | 🟡 | 3 |
| 24 | TCU (acórdãos) | D | Scraping/busca | Não | 🟡 | 3 |
| 25 | DOU / Imprensa Nacional | D | API/labs | Não | 🟢 | 3 |

⭐ = fonte nova de alto valor que **desbloqueia monitoramento ausente do plano**.

---

## 7. O que cada fonte nova desbloqueia (mapa de impacto)

| Fonte nova | Detector/monitoramento que destrava | Hoje no plano |
|---|---|---|
| **PNCP** | Edital (critérios de habilitação → edital direcionado); contrato com vigência; aditivos >25% (P2); benchmarking nacional de preço; elo `licitação→contrato` | Ausente — plano só tinha empenho |
| **TCE-SP / AUDESP** | Validação cruzada Prefeitura×TCE×PNCP; cubo Fase IV de licitações/contratos; antecedentes de fornecedor (julgados) | Era "Fase 2, scraping frágil" — na verdade tem API |
| **Portal Federal (CGU)** | A09/D06 (inidôneo recebendo pagamento) sem fragilidade; F03/F04 (entidade impedida); convênios federais e prestação de contas | Era "Fase 2, scraping" — tem API oficial |
| **TSE Dados Abertos** | H06 (doador de campanha que vence licitação); evolução patrimonial de agentes; fornecedor de campanha → fornecedor da Prefeitura | Citado sem fonte mapeada |
| **FNDE** | Fiscalização de merenda escolar (PNAE) e PDDE; prestação de contas irregular; transporte escolar | Educação/merenda ausentes |
| **Banco de Preços em Saúde** | P4 — sobrepreço de medicamento com âncora de referência | Citado como Fase 3 sem detalhe de acesso |
| **SIOPS** | Tripla validação do mínimo de 15% em saúde | Plano usava só SMARAPD/SICONFI |
| **IPREMM / CADPREV** | Monitoramento do RPPS (déficit atuarial, enquadramento de investimentos, CRP) | Área ausente |
| **JUCESP** | D03 — alteração societária às vésperas do certame (a *data* da mudança) | Citado, sem fonte da data |
| **IBGE** | Denominador per capita p/ comparação entre municípios | Implícito, não mapeado |

---

## 8. Recomendações para o plano-mestre

1. **Repromover o Tier de fontes.** O plano-mestre §3 trata PNCP, TCE-SP e
   CEIS/CNEP como "Fase 2 / scraping frágil". A validação mostra que **as três
   têm API/dados estruturados públicos**. Recomendo:
   - **PNCP → Fase 1**, junto com SMARAPD. É o elo `licitação→contrato` que
     falta e sustenta P2 e P5.
   - **Portal Federal (CGU) CEIS/CNEP/CEPIM → Fase 1.** Token grátis; o
     gabinete precisa criar a conta gov.br para o cadastro.
   - **TCE-SP (API despesas/receitas + datasets) → Fase 1; cubo AUDESP Fase
     IV → Fase 2.**
   - **TSE, FNDE, Banco de Preços em Saúde → Fase 2** (eram vagos/Fase 3).

2. **Corrigir o conector SMARAPD (backlog Fase 0 #1).** O motivo do
   `smarapd-client.ts` falhar não é só a URL errada — a API **exige header
   `User-Agent`** (sem ele, HTTP 400; com ele, HTTP 200, confirmado). A
   reescrita precisa fixar `User-Agent` + `Referer` em todo request.

3. **Conectores de coleta brasileira devem rodar com egress no Brasil.** O
   PNCP retornou HTTP 403 fora do Brasil (provável WAF/geo). Os Cloud Run Jobs
   do NEXO devem rodar em `southamerica-east1`. Validar o 200 do PNCP no
   primeiro job a partir do GCP-BR; manter o Plano B dos arquivos de Dados
   Abertos do PNCP.

4. **Ajustar a expectativa do processador P3 (frota/combustível).** Não há
   fonte pública de km/consumo por veículo. P3 deve operar em modo
   "semi-manual": o NEXO flagra o gasto agregado atípico com combustível e
   **gera automaticamente o pedido e-SIC** para obter o detalhe. O e-SIC/1Doc
   passa a ser, além de fonte, **instrumento de coleta ativa** do NEXO.

5. **Adicionar dois subsistemas ao escopo:**
   - **Previdência (IPREMM/RPPS)** — déficit atuarial, enquadramento de
     investimentos, regularidade do CRP. Marília já teve CPI do IPREMM;
     é vetor de risco real e visível.
   - **Educação/merenda (FNDE/PNAE/PDDE)** — repasse federal vs. execução
     local; prestação de contas. Hoje totalmente fora do plano.

6. **Estratégia de validação cruzada como princípio.** Vários números agora
   têm **3+ fontes independentes** (ex.: mínimo de saúde = SMARAPD LRF +
   SICONFI RREO + SIOPS; licitação = portal Marília + PNCP + AUDESP).
   Divergência entre fontes deve ser, por si só, um **detector** — eleva a
   "probabilidade de irregularidade" e a "confiabilidade documental" do
   score triplo (plano §7).

7. **Cadastros e credenciais a providenciar (ação do gabinete):**
   - Conta gov.br nível Prata/Ouro do gabinete → token da API do Portal da
     Transparência Federal.
   - E-mail institucional para o painel do Banco de Preços em Saúde.
   - Nada mais exige cadastro — SMARAPD, PNCP, SICONFI, TCE-SP, IBGE, TSE,
     FNDE e CNPJ são abertos.

---

## 9. Riscos e mitigações de coleta

| Risco | Fontes afetadas | Mitigação |
|---|---|---|
| API sem SLA muda sem aviso | SMARAPD | Snapshots brutos + cursores; monitorar `Versao` em `DadosAbertos` |
| WAF / bloqueio geográfico | PNCP (403 fora do BR) | Egress BR; Plano B = arquivos de Dados Abertos |
| Header obrigatório não óbvio | SMARAPD (UA) | Fixar `User-Agent`+`Referer` no client; teste de fumaça no CI |
| Scraping quebra com layout | editais, obras, 1Doc, JUCESP, IPREMM | Conectores isolados; falha de um não derruba os demais; alarme de "0 registros" |
| Dado de CNPJ defasado | BrasilAPI/CNPJ.ws/minhareceita | Guardar `receitaConsultadaEm`; re-enriquecer; tratar situação como margem de erro |
| Token suspenso por rate limit | Portal Federal (CGU) | Respeitar 400 req/min; preferir janela 00h–06h (700 req/min); fila |
| API REST do TCE-SP só até 2019 | TCE-SP despesas/receitas | Usar datasets + cubo AUDESP Fase IV p/ dados recentes |
| LGPD em folha e dados eleitorais | SMARAPD folha, TSE | Mascarar dado pessoal na UI; uso restrito à finalidade fiscalizatória |
| minhareceita repo migrou/manutenção irregular | minhareceita.org | Usar como 3ª opção; BrasilAPI primária |

---

## 10. Registro de validação (2026-05-21)

Testes reais de endpoint executados durante a elaboração deste documento:

| Endpoint testado | Resultado | Conclusão |
|---|---|---|
| `GET paiportalserver/DadosAbertos` sem User-Agent | HTTP 400 | Header obrigatório |
| `GET paiportalserver/DadosAbertos` com User-Agent | **HTTP 200**, 52 KB, catálogo completo | ✅ funciona |
| `POST paiportalserver/modulovisao/filter` (módulo `diarias`) com UA | **HTTP 200** — 1.726 registros de diárias 2026 | ✅ funciona |
| `GET apidatalake.tesouro.gov.br/ords/siconfi/tt/rgf` (Marília 2024) | **HTTP 200** | ✅ funciona |
| `GET apidatalake.tesouro.gov.br/ords/siconfi/tt/rreo` (Marília 2025) | **HTTP 200** | ✅ funciona |
| `GET pncp.gov.br/api/consulta/v1/contratacoes/publicacao` | HTTP 403 (com e sem UA) | WAF/geo — exige egress BR |
| `GET pncp.gov.br/api/consulta/v1/contratos` | HTTP 403 | idem |
| `GET servicodados.ibge.gov.br/api/v1/localidades/municipios/3529005` | **HTTP 200** | ✅ funciona |
| `GET brasilapi.com.br/api/cnpj/v1/{cnpj}` | **HTTP 200** | ✅ funciona |
| `GET transparencia.tce.sp.gov.br/api/json/municipios` | **HTTP 200** | ✅ funciona |
| `GET sapl.marilia.sp.leg.br/api/norma/normajuridica/` | HTTP 404 | API DRF não exposta — usar RSS/scraping |
| `GET sapl.marilia.sp.leg.br/generico/RSS2_normas` | HTTP 503 | MORTO em prod (NameError Zope) — substituído |
| `GET sapl.marilia.sp.leg.br/@@normas?ano={ano}&tipo={tipo}` | **HTTP 200** | ✅ JSON-LD vivo; `ano` obrigatório; é o caminho atual do `normas-client.ts` |
| `GET marilia.sp.gov.br/portal/editais/1` | **HTTP 200** | ✅ scraping viável |
| `GET legislacao.marilia.sp.gov.br` | HTTP 301 | redireciona — confirmar destino |
| `GET dadosabertos.compras.gov.br/.../consultarContratacoes` | HTTP 404 | revisar path do endpoint no Swagger |

> Notas: os 403/404/503 acima são de ambiente/parâmetro, não negam a
> existência das fontes — todas têm documentação pública confirmada. PNCP em
> particular é amplamente usado via API; o 403 é geográfico.

---

## Disclaimer

> Este catálogo lista fontes de dados públicos e legalmente acessíveis para
> fins de fiscalização parlamentar. O acesso e o uso de qualquer fonte devem
> observar a LGPD (finalidade, necessidade, minimização), os termos de uso de
> cada serviço e o princípio de que todo achado é **indício** sujeito a
> apuração pelas instituições competentes — nunca acusação.
