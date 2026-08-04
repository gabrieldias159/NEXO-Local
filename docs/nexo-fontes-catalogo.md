I'll consolidate this mapping into a technical, actionable catalog. Let me organize the data — it's already rich and verified, so I'll synthesize it directly without needing to re-fetch.

# CATÁLOGO DE FONTES DE DADOS PÚBLICOS — MARÍLIA/SP (NEXO)
*Consolidado por FANTASMA — engenheiro de coleta. Marca: ✅ CONFIRMADO (fetch real) vs 🔶 ALEGADO (spec/inferido, não materializado).*

---

## Sumário

**Cobertura:** 11 fontes mapeadas, **~120 endpoints catalogados**, dos quais **~78 CONFIRMADOS por fetch real** e o restante alegado/pendente de validação com sessão/token.

**Estado de integração:** apenas **1 fonte já integrada** (PNCP). As outras 10 estão em backlog. Dentro do SMARAPD PAI, 8 módulos novos foram confirmados e ainda não integrados.

**Descobertas novas mais relevantes (não integradas):**

1. **API de Dados Abertos da Prefeitura** (`/portal/dados-abertos/{categoria}/{ano}`) — JSON puro, sem auth, 15 categorias incluindo **Diário Oficial com texto integral** e **legislação com schema próprio (ementa/número)**. Núcleo descoberto sob verificação. O nome da contratada **só existe no HTML** (`/portal/contrato/{id}`), nunca no JSON.
2. **SAGL/OpenLegis da Câmara** expõe uma **API JSON-LD não-documentada** via views Zope `@@materias`/`@@normas`/`@@sessoes`/`@@vereadores` — incluindo **votação nominal com nomes reais dos vereadores** (sessão 918 confirmada). Não é SAPL Django; `/api/` retorna 404.
3. **Querido Diário** indexa o DOM de Marília full-text: **4.201 edições** pesquisáveis por termo (`dispensa`=1.351 hits), com PDF+TXT — fonte de indícios primária, sem auth.
4. **SMARAPD PAI** — 8 módulos novos no mesmo `POST /modulovisao/filter`: patrimônio mobiliário (**153.211 bens**), publicidade com drill-down empenho→liquidação→pagamento, subvenções, emendas parlamentares, COVID, balancete de receita, restos a pagar, passagens.
5. **Parcerias 3º setor (lei13019.com.br, orgao_id=23)** — 59 OSCs com CNPJ; `prestacao-de-contas-emenda` serve **107 linhas tabulares no HTML server-side** (não é AJAX como se supunha).
6. **TCE-SP API REST** (`/api/json/despesas/marilia/{ano}/{mes}`) — empenhos com CNPJ/CPF do fornecedor, **segunda fonte** que permite detectar divergência Prefeitura-declara-ao-TCE vs portal próprio.

**Correção factual crítica que atravessa todo o NEXO:** o **IBGE de Marília é `3529005`**, NÃO `3529005` (que é **Mauá-SP**). Vários endpoints do mapa antigo (PNCP, Transparência Federal, SICONFI) carregavam o código errado — **corrigir em toda a base**.

---

## Catálogo por Fonte

### 1. Portal da Prefeitura — `marilia.sp.gov.br`
- **Base URL:** `https://www.marilia.sp.gov.br`
- **Tipo:** misto (API JSON + HTML server-rendered + exports) · **Auth:** nenhuma · **Já integrado:** não · **Prioridade:** alta
- **Entrega:** API de Dados Abertos JSON em `/portal/dados-abertos/{categoria}/{ano}` cobrindo 15 categorias; licitações, contratos+ARP, obras, compra-direta (dispensas), chamamento-público, concursos, **Diário Oficial com texto integral**, e legislação. Páginas HTML de detalhe com download de anexos (ZIP/PDF).

**Endpoints CONFIRMADOS:**

| Método | URL | Parâmetros | Formato |
|---|---|---|---|
| GET ✅ | `/portal/dados-abertos/licitacoes/{ano}` | path: ano | JSON `{dados:[{titulo,datas,numeroEdital,numeroProcesso,modalidade,situacao,descricao}]}` — 107 em 2026 |
| GET ✅ | `/portal/dados-abertos/contratos/{ano}` | path: ano | JSON — **`nomeContratada=null` no feed** (912 reg/2026) |
| GET ✅ | `/portal/dados-abertos/obras/{ano}` | path: ano | JSON `{titulo,dataExecucaoInicio/Fim,categoria,situacao,valor,descricao}` (19/2026) |
| GET ✅ | `/portal/dados-abertos/diario-oficial/{ano}` | path: ano | JSON `{edicao,data,edicaoExtra,descricao=TEXTO INTEGRAL}` (106/2026) |
| GET ✅ | `/portal/dados-abertos/compra-direta/{ano}` | path: ano (slug com hífen) | JSON (campos de edital, modalidade=Dispensa) |
| GET ✅ | `/portal/dados-abertos/chamamento-publico/{ano}` | path: ano | JSON |
| GET ✅ | `/portal/dados-abertos/concursos/{ano}` | path: ano (**filtra por ano**: 2026 vazio, 2025 tem dados) | JSON; vazio retorna `{dados:[["Nenhum registro encontrado."]]}` |
| GET ✅ | `/portal/dados-abertos/legislacao/{ano}` | path: ano | JSON schema próprio `{ementa,numero,categoria,situacao,descricao}` — 150 reg, **promovido a confirmado** |
| GET ✅ | `/portal/dados-abertos/carta-servicos/{ano}` | path: ano | JSON `{nome,assunto,sobre,formaDeResposta}` — **promovido** |
| GET ✅ | `/portal/dados-abertos/avaliacoes/{ano}` | path: ano | JSON métricas de satisfação — **promovido** |
| GET ✅ | `/portal/dados-abertos/ouvidoria/{ano}` | path: ano | JSON **agregado** (sempre zerado, baixa utilidade) |
| GET ✅ | `/portal/dados-abertos/sic/{ano}` | path: ano | JSON **agregado LAI** (sempre zerado) |
| GET ✅ | `/portal/editais/{tipo}` e `/portal/editais/1` | path: tipo (1=licitação, 3=concurso); paginado | HTML (5576 editais / 112 páginas) |
| GET ✅ | `/portal/editais/0/{tipo}/{id}/` | path: tipo+id (ex `/0/1/7921/`) | HTML detalhe: objeto, amparo legal (Lei 14.133), valor, links download |
| GET ✅ | `/portal/contrato/{id}` | path: id (ex 1683) | **HTML — ÚNICA fonte do NOME da contratada** (confirmado 1683=CODEMAR). CNPJ NÃO aparece |
| GET ✅ | `/portal/obras` | query/form: bairro, rua, categoria, situação | HTML — **Valor Pago + indicador de atraso** (não estão no JSON) |
| GET ✅ | `/csv.php?pagina={Pagina}` | query: pagina | CSV (force-download) — **mas retornou 0 bytes stateless; depende de sessão/cookie** |
| GET ✅ | `/m_pdf.php?pagina={Pagina}` | query: pagina | PDF real ~14.5KB — **promovido a confirmado** |

**Não confirmados (🔶):** `/portal/dados-abertos/{audiencias-publicas|...}/{ano}` (estrutura não detalhada); `/portal/download/{contratos\|licitacoes}/{hash}/` (URLs/hashes reais, mas binário não materializado via fetch); `contas-publicas`/`relatorio-viagens` (JSON válido porém vazios nos anos testados).

**Cruzamentos:** `numeroProcesso`/`numeroEdital` → licitação↔contrato↔ARP interno · nome da contratada (HTML) → CNPJ via PNCP/TCE/BrasilAPI/CEIS · `valorContrato`/empenho → DespesaAgrupada do PAI · obras (valor×pago×prazo) → contratos/empenhos · Diário Oficial JSON → integração de Diário existente + SAPL.

---

### 2. Câmara Municipal / SAGL — `sapl.marilia.sp.leg.br`
- **Base URL:** `https://sapl.marilia.sp.leg.br`
- **Tipo:** api-json (views Zope `@@nome`, JSON-LD) · **Auth:** nenhuma · **Já integrado:** não · **Prioridade:** alta
- **Entrega:** A Câmara roda **SAGL/OpenLegis (Zope/waitress)**, não SAPL Django — `/api/` REST e swagger **não existem (404)**. Expõe API JSON-LD pública via `@@`: matérias com autoria/tramitação/pareceres/votação, normas, sessões com pauta/ata/presença/votação nominal, vereadores, comissões, legislaturas. Todos com PDF.

**Endpoints CONFIRMADOS (14):**

| Método | URL | Parâmetros | Formato/Conteúdo |
|---|---|---|---|
| GET ✅ | `/@@materias?ano={ano}&tipo={t}` | ano; tipo (1=PL, 8=Indicação, 24=Proc.Contas, 25=Denúncia) | JSON-LD items[] (autoria distingue Executivo×vereador, PDF) |
| GET ✅ | `/@@materias/{id}` | id matéria | Dossiê: `processing[]`, `committeeOpinion[]` (relator+voto), `voteResult[]`, `accessoryDocument[]` |
| GET ✅ | `/@@materias/{id}/tramitacao` | id | JSON linha do tempo (datas, unidades, PDFs) |
| GET ✅ | `/@@normas?ano={ano}&tipo={t}` | **tipo OBRIGATÓRIO** (1=LeiOrd, 2=LeiComp, 7=DecExec, 9=Portaria…) | JSON-LD items[] (ementa, data) |
| GET ✅ | `/@@normas/{id}` | id=cod_norma | JSON: status vigência, `normas_vinculadas[]` (altera/revoga), PDF |
| GET ✅ | `/@@sessoes/tipo/{tipo}/ano/{ano}` | path-based; **type_id do mapa está invertido — validar** | JSON-LD: ata/pauta PDF + links presença/votação |
| GET ✅ | `/@@sessoes/id/{id}/votacao` | id sessão | **votacaoNominal com NOMES dos vereadores** (sessão 918 ✅) |
| GET 🔶 | `/@@sessoes/id/{id}/presenca` | id sessão | JSON chamadaRegimental/ordemDia — **retornou VAZIO em todas testadas; não confiar sem mais teste** |
| GET ✅ | `/@@vereadores` e `/@@vereadores/{id}` | id parlamentar | 18 vereadores; ficha com filiações, mandatos, comissões, `cod_autor` |
| GET ✅ | `/@@comissoes` e `/@@comissoes/{id}` | id | 11 comissões; composição histórica + reuniões |
| GET ✅ | `/@@legislaturas` | — | 21 itens (atual=21: 2025-2028) |
| GET ✅ | `/sapl_documentos/{tipo}/{arquivo}.pdf` | path vem no JSON | PDF binário real (testado 565KB norma, 169KB matéria) — **caminho oficial de PDF** |

**Quebrados/inexistentes (✅ confirmado que NÃO servem):** `/generico/RSS2_normas` (HTTP 503, NameError Zope); `/api/` (404 Zope); `pysc/download_norma_pysc` (HTTP 500 — usar `sapl_documentos`).

**Cruzamentos:** `authorship` (Executivo×vereador) → servidores + DOM · `voteResult`/votação nominal → matérias que beneficiam fornecedores · `cod_autor` → todas as matérias do vereador · normas → despesa autorizada (LOA/LDO via SICONFI).

> **Nota:** a fonte "Legislação Municipal" do mapa antigo aponta para o **mesmo host** via rotas legadas `/consultas/legislacao/{tipo}?ano_norma={ano}` (HTML scrape, sem throttle) e `download_materia_pysc` (PDF confirmado). A busca avançada `norma_juridica_pesquisar_proc` está **quebrada (503/anti-bot)** — usar listagens + `cod_norma` sequencial (~42500+) para crawl incremental.

---

### 3. SMARAPD PAI — módulos novos — `transparencia.marilia.sp.gov.br`
- **Base URL:** `https://transparencia.marilia.sp.gov.br/paiportalserver/`
- **Tipo:** api-json · **Auth:** nenhuma (**mas 3 headers obrigatórios**) · **Já integrado:** não (8 módulos pendentes) · **Prioridade:** alta
- **Entrega:** Todos os 8 módulos no MESMO `POST /modulovisao/filter`, variando `ChaveModulo`+`NomeVisao`+`Exercicio`. Catálogo-mestre via `GET /DadosAbertos`.

**⚠️ Headers OBRIGATÓRIOS em TODA chamada** (senão HTTP 400 "Não foi possível obter a origem"): `User-Agent`, `Origin: https://transparencia.marilia.sp.gov.br`, `Referer: https://transparencia.marilia.sp.gov.br/`.

**Body padrão do filter:** `{ChaveModulo, NomeVisao, Exercicio, Periodicidade:'ANUAL', Periodo:null, Filtros:[], Ordenacao:[], Pagina:1, QuantidadeRegistros:N, FiltroRedirecionaVisao:{Campo:null,Valor:null,TipoValor:null}, UrlExportacao:''}`

**Endpoints CONFIRMADOS (10):**

| Método | ChaveModulo / NomeVisao | Anos | Volume / nota |
|---|---|---|---|
| GET ✅ | `/DadosAbertos` | — | catálogo 17 módulos; sync 2026-06-02 (fresco) |
| GET ✅ | `/MenuPortal` | — | árvore de menu (descobre URI/NomeVisao) |
| POST ✅ | `despesa_covid` / `despesacovid` | 2020-2025 | 884 total (2020=499) |
| POST ✅ | `despesas_subvencoes` / `subvencoes` | **2013-2021** (série congela em 2021) | ~600/ano; beneficiário=entidade |
| POST ✅ | `despesa_viagem` / `passagenslocomocao` | 2013-2026 | 278/2026; campo extra `UG` |
| POST ✅ | `despesas_de_pagamentos` / `publicidade` | 2013-2025 (falta 2017,2026) | **drill-down** `Itens/Liquidacoes/Documentos/Pagamentos` (URLs com `FiltroRedirecionaVisao` Campo=`IDDespesa`, TipoValor='3') |
| POST ✅ | `patrimonio_mobiliario` / `patrimonio` | 2026 (snapshot) | **153.211 bens** (51.071 págs); `Fornecedor` com CNPJ embutido |
| POST ✅ | `emendas_parlamentares` / `EmendasParlamentares` | 2020-2026 | **CamelCase no NomeVisao**; 2026=21, 2025=193 |
| POST ✅ | `balancetereceita` / `Arrecadacoes` | 2026 | 179 naturezas; **schema colunar 12 meses** + TotalArrecadado/Previsto; valores negativos=estornos |
| POST ✅ | `restoapagar` / `restoapagar` | 2025-2026 | 82/2026; schema enxuto (sem ValorEmpenhado/Liquidado) |

**Falta confirmar (🔶):** fetch ponta-a-ponta dos drill-downs de publicidade; tolerância a `QuantidadeRegistros` alto na coleta massiva de patrimônio (rate-limit/timeout).

**Cruzamentos:** `Fornecedor`/CNPJ → módulo fornecedor integrado, CEIS/CNEP, BrasilAPI, PNCP · `NroEmpenho` → DespesaAgrupada e restoapagar · `subvencoes`+`emendas` → terceiro setor · `balancetereceita` → SICONFI RREO · `IDDespesa` liga publicidade→empenho→liquidação→pagamento.

---

### 4. PNCP — contratações — `pncp.gov.br` ⭐ JÁ INTEGRADO
- **Base URL:** `https://pncp.gov.br/api` · **Auth:** nenhuma · **Prioridade:** alta
- **Entrega:** Duas APIs: **Consulta** (`/api/consulta/v1`, busca paginada por período+CNPJ/IBGE) e **Detalhe/Integração** (`/api/pncp/v1/orgaos/{cnpj}/...`, drill-down com aditivos/arquivos/empenhos/itens/resultados). Marília: **CNPJ `44477909000100`, IBGE `3529005`**.

**Endpoints CONFIRMADOS (13/16):**

| Método | URL | Nota |
|---|---|---|
| GET ✅ | `/consulta/v1/contratos` | `dataInicial/dataFinal` (yyyyMMdd), `cnpjOrgao`, `pagina`, `tamanhoPagina`(10-500); 41 campos |
| GET ✅ | `/consulta/v1/contratos/atualizacao` | sync incremental |
| GET ✅ | `/consulta/v1/atas` | **`tamanhoPagina>=10` senão HTTP 400** |
| GET ✅ | `/consulta/v1/atas/atualizacao` | incremental |
| GET ✅ | `/consulta/v1/contratacoes/publicacao` | `codigoModalidadeContratacao` OBRIG (6=Pregão,8=Dispensa,7=Inexig); `codigoMunicipioIbge=3529005` |
| GET ✅ | `/consulta/v1/contratacoes/proposta` | **`dataFinal>=hoje` senão HTTP 422** |
| GET ✅ | `/consulta/v1/contratacoes/atualizacao` | modalidade obrig; **HTTP 204 em janela vazia** |
| GET ✅ | `/pncp/v1/orgaos/{cnpj}/contratos/{ano}/{seq}` | ficha completa |
| GET ✅ | `/pncp/v1/orgaos/{cnpj}/contratos/{ano}/{seq}/termos` | **aditivos**; sem aditivo=HTTP 204 |
| GET ✅ | `/pncp/v1/orgaos/{cnpj}/contratos/{ano}/{seq}/arquivos` | PDF com URI download |
| GET ✅ | `/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens` + `/itens/{n}/resultados` | itens + vencedor `valorUnitarioHomologado` |
| GET ✅ | `/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/atas` + `/atas/{n}` | ata SRP |
| GET ✅ | `/consulta/v3/api-docs` + `/pncp/v3/api-docs` | OpenAPI 3 |

**Não materializaram dado real (🔶):** `instrumentoscobranca/inclusao` e `.../contratos/.../empenhos` — rota válida e documentada mas SMARAPD não alimenta esses campos. Ganho marginal, não bloqueante.

**Cruzamentos:** `niFornecedor` → BrasilAPI/CEIS/CNEP/PAI · `numeroControlePNCP` → empenhos PAI · `frutoAdesao=true` → carona (fuga de licitação) · valorGlobal×valorAcumulado×empenhos → aditivos que estouram limite.

---

### 5. TCE-SP / AUDESP — `transparencia.tce.sp.gov.br`
- **Base URL:** `https://transparencia.tce.sp.gov.br` · **Auth:** nenhuma (leitura) · **Já integrado:** não · **Prioridade:** alta
- **Entrega:** API REST JSON/XML com despesas/receitas mensais (empenho, CNPJ/CPF fornecedor, valor); datasets bulk ZIP/CSV (RCL, análises AUDESP); HTML de contas irregulares (PDF/XLSX). Slug de Marília = **`marilia`** (sem IBGE).

**Endpoints CONFIRMADOS:**

| Método | URL | Nota |
|---|---|---|
| GET ✅ | `/api/json/municipios` (e `/api/xml/municipios`) | 644 municípios; `{municipio:"marilia",municipio_extenso:"Marília"}` |
| GET ✅ | `/api/json/despesas/marilia/{exercicio}/{mes}` | 2014-2025; `{orgao,nr_empenho,id_fornecedor(CNPJ/CPF),nm_fornecedor,vl_despesa}` — ~900+/mês |
| GET ✅ | `/api/json/receitas/marilia/{exercicio}/{mes}` | `{ds_fonte_recurso,ds_alinea,vl_arrecadacao}` |
| GET ✅ | `/sites/default/files/conjunto-dados/despesas-{ano}.zip` | bulk estadual ~2.07GB (preferir API por município) |
| GET ✅ | `/sites/default/files/conjunto-dados/receitas-{ano}.zip` | ~34.5MB |
| GET ✅ | `/sites/default/files/conjunto-dados/rcl_completo.zip` | RCL mensal LRF desde 2015 (~813KB) |
| GET ✅ | `/sites/default/files/conjunto-dados/resultado_analises_audesp.zip` | %educação/saúde/pessoal já calculados (~468KB) |
| POST ✅ | `/despesas-fornecedor` | rastreio de 1 CNPJ por evento (Pagamento/Liquidação) — **HTML, exige `form_build_id`+sessão Drupal** |
| GET ✅ | `tce.sp.gov.br/relacao-de-responsaveis-por-contas-julgadas-irregulares` | XLSX/PDF, **sem filtro por município** — baixar e filtrar |
| GET ✅ | `painel.tce.sp.gov.br/pentaho/.../iegm.wcdf/generatedContent?userid=anony&password=zero` | dashboard IEG-M renderiza anônimo; **CDA data API = 401, só visual** |

**Falta confirmar (🔶):** URLs exatas de `licitacoes-contratos/` e `divida-ativa/` (pastas dão 404); apenados e pesquisa-de-processos são só HTML. **AUDESP API** (`audesp.tce.sp.gov.br`) é confirmadamente **só submissão autenticada (JWT)** — descartar para leitura.

**Cruzamentos:** `id_fornecedor` → PAI/PNCP/BrasilAPI/CEIS · `nr_empenho`+`vl_despesa` → **dupla fonte** (detecta divergência TCE vs portal próprio) · RCL/análises → limites LRF SICONFI · contas irregulares → flag Ficha Limpa.

---

### 6. Parcerias 3º setor — `lei13019.com.br` + SMARAPD parcerias
- **Base URL:** `https://www.lei13019.com.br/` · **Tipo:** misto · **Auth:** nenhuma · **Já integrado:** não · **Prioridade:** alta
- **Entrega:** Relação completa das parcerias Lei 13.019/2014 de Marília (**orgao_id=23**): termos de colaboração/fomento, prestação de contas, repasses, chamamentos, emendas. **59 OSCs com CNPJ** extraídas do HTML.

**Endpoints CONFIRMADOS (9):**

| Método | URL | Nota |
|---|---|---|
| GET ✅ | `/parcerias.php?orgao_id=23&...` | **59 OSCs**; CNPJs em atributos `cnpjEntidade` dos `<option>` (não surfam em markdown — exige parser HTML cru) |
| GET ✅ | `/inicial.php?orgao_id=23&pasta=sp/marilia/` | hub de navegação |
| GET ✅ | `/prestacao-de-contas.php?orgao_id=23&...` | shell; dados financeiros via AJAX |
| GET ✅ | `/prestacao-de-contas-emenda.php?orgao_id=23&origem_de_recurso={1\|2\|5}` | **107 linhas tabulares no HTML server-side** (Proposta/Instrumento/Autor/Valor) — não é AJAX |
| GET ✅ | `/prestacao-de-contas-propostas-emenda.php?orgao_id=23&origem_de_recurso=1` | **107 propostas reais — promovido**; ⚠️ curl→403/WAF, sensível a user-agent |
| GET ✅ | `/editais.php?orgao_id=23&...` | Chamamento 3/2026 |
| GET ✅ | `transparencia.marilia.sp.gov.br/paiportalserver/modulovisao/fixo/siafic/parceriascelebradas` | JSON `{Titulo,Informacao.Texto:HTML,VisaoItens:[]}` — só links/PDFs; **exige header Origin** |
| GET ✅ | `transparencia.../paiportalserver/MenuPortal` | descobre `despesas_subvencoes`, `siafic/parceriascelebradas`, 3× lei13019 |
| GET ✅ | `marilia.sp.gov.br/portal/contratos/1/0/0/0/0/0/9/0/.../` (tipo 9) + `/portal/contrato/3717` | TC 252/TC/2025, EDUCANDÁRIO BENTO DE ABREU, R$150.000, PDF |

**Não confirmados (🔶):** `transparencia.../modulovisao/dinamico/despesas_subvencoes/subvencoes` — **dá 404 em todas variantes** apesar de aparecer no MenuPortal (rota/método real desconhecido; provável POST `/filter` com payload específico).

**Cruzamentos:** CNPJ das 59 OSCs → fornecedor/DespesaAgrupada do PAI, `despesas_subvencoes`, CEIS/CNEP, BrasilAPI (OSC-fantasma criada perto do chamamento), PNCP tipo 9, emendas. Anomalias: múltiplas filiais do mesmo CNPJ-base recebendo parcerias separadas; valor repassado≠pago no PAI.

---

### 7. Fontes nacionais conexas — Querido Diário, IBGE, Compras.gov, minhareceita, CKAN-SP
- **Tipo:** misto · **Auth:** mista (núcleo sem auth; Transparência Federal e dados.gov.br exigem token) · **Já integrado:** não · **Prioridade:** alta

**Endpoints CONFIRMADOS (13, sem auth):**

| Método | URL | Nota |
|---|---|---|
| GET ✅ | `api.queridodiario.ok.org.br/gazettes?territory_ids=3529005&querystring={termo}&published_since=&published_until=` | **DOM full-text**, 4.201 edições, PDF+`txt_url`+excerpts; `dispensa`=1.351 hits |
| GET ✅ | `api.queridodiario.ok.org.br/cities/3529005` | level 3 full-text, availability 2022-10-10 |
| GET ✅ | `api.queridodiario.ok.org.br/company/info/{cnpj}` + `/company/partners/{cnpj}` | CNPJ+QSA (sócios) da Receita |
| GET ✅ | `api.queridodiario.ok.org.br/openapi.json` | 11 paths |
| GET ✅ | `servicodados.ibge.gov.br/api/v1/localidades/municipios/3529005` | **valida IBGE=3529005** |
| GET ✅ | `servicodados.ibge.gov.br/api/v3/agregados/5938/.../?localidades=N6[3529005]` | PIB Marília 2021 = 9.756.006 mil |
| GET ✅ | `dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial?codigoItemCatalogo={cod}` | **preço de referência federal** (sobrepreço); precoUnitario+niFornecedor |
| GET ✅ | `dadosabertos.compras.gov.br/v3/api-docs` | 80+ endpoints sem auth |
| GET ✅ | `minhareceita.org/{cnpj}` | CNPJ+QSA sem auth |
| GET ✅ | `dadosabertos.sp.gov.br/api/3/action/package_search?q=marilia` (CKAN-SP) | datasets c/ recorte Marília + JUCESP |
| GET ✅ | `institucional.jucesp.sp.gov.br/downloads/dados_abertos/REL_{AAAA-MM}_PDA-CONSTITUICAO.csv` | CSV 7.1MB, `;`-delimitado — **AGREGADO por município/CNAE, NÃO lista de CNPJ individual** |

**Exigem token (🔶 — integráveis mas pendentes de cadastro):**
- `api.portaldatransparencia.gov.br/api-de-dados/{recurso}-por-municipio?codigoIbge=3529005` — header `chave-api-dados` (gratuito). Endpoints por município: novo-bolsa-familia, bpc, seguro-defeso, safra, peti, `/despesas/recursos-recebidos`, convênios, emendas. **2 endpoints (`bpc-por-municipio`, `auxilio-emergencial-por-municipio`) estavam marcados confirmados mas estão AUSENTES do OpenAPI — re-verificar nome/path.**
- `dados.gov.br/dados/api/publico/...` — header `Authorization` (chave gov.br), 401 mesmo para leitura.

**Sem API (🔶):** SINAPI (Caixa) — só ZIP/XLSX mensal por UF; pipeline de download/parse.

**Cruzamentos:** CNPJ/sócios (minhareceita+QD/partners) → fornecedores PAI/PNCP/TCE (sócios em comum=cartel/laranja) · pesquisa-preço Compras → empenhos (sobrepreço) · QD full-text → dispensas/emergenciais/aditivos por palavra-chave · IBGE → per-capita.

---

### 8. Conselhos Municipais — `www2.marilia.sp.gov.br/conselho`
- **Base URL:** `https://www2.marilia.sp.gov.br/api/conselhos` · **Tipo:** api-json (Laravel) · **Auth:** nenhuma (leitura) · **Já integrado:** não · **Prioridade:** alta
- **Entrega:** SPA Vue + API REST Laravel pública. 36 conselhos (Saúde id=42, Educação 25, Assistência Social 13, Criança/Adolescente 12, Alimentação Escolar 24): dados jurídicos, acervo de documentos (Atas/Normas/Resoluções PDF), agenda de reuniões.

**⚠️ Enviar `Accept: application/json` em TODA chamada** — sem ele o `documents` sem `org` dá 302 redirect em vez de 422.

**Endpoints CONFIRMADOS (5):**

| Método | URL | Nota |
|---|---|---|
| GET ✅ | `/api/conselhos/organizations` | 36 itens; dados jurídicos (law_file/decree_file/ordinance_file/maintainer). **NÃO traz nome** (mapa id→nome hardcoded no bundle) |
| GET ✅ | `/api/conselhos/organizations/{id}` | detalhe; **membros só via PDF `ordinance_file`** (não há endpoint JSON de membros) |
| GET ✅ | `/api/conselhos/documents?org={id}` | **`org` OBRIGATÓRIO** (senão 422); Ata/Norma/Resolução; org=13 tem 103 docs |
| GET ✅ | `/api/conselhos/events?org={id}` | agenda; `time`=epoch ms; org=24 tem 51 eventos |
| GET ✅ | `/storage/conselhos/{path}` | PDF público (URL-encode espaços/acentos) |

**Cruzamentos:** deliberações Saúde/Educação → execução orçamentária PAI + FUNDEB · CAE → contratos de merenda PNCP · portarias de nomeação → folha/diárias · eventos×documents → **reuniões sem ata** (baixa transparência).

---

### 9. SIC / e-SIC — `marilia.1doc.com.br`
- **Base URL:** `https://marilia.1doc.com.br` · **Tipo:** html-scrape (plataforma 1Doc/Softplan) · **Auth:** desconhecida · **Já integrado:** não · **Prioridade:** média
- **Entrega:** Página de transparência embute inline o objeto JS `transparencyData` com agregados de Ouvidoria/e-SIC/Ouvidoria SUS. **Não há pedidos individuais públicos** — só agregados.

**Endpoints CONFIRMADOS:**

| Método | URL | Nota |
|---|---|---|
| GET ✅ | `/b.php?pg=o/transparencia&s=marilia` | **único data-rich**: `transparencyData={...}` inline parseável. e-SIC 52/47/11.94d; Ouvidoria 2241/1833/98.87%; SUS 660/485. **WebFetch deu falso-negativo; GET cru confirma** |
| GET ✅ | `/b.php?pg=wp/wp&consulta=1&ss=2&codigo={codigo}` | lookup 1-a-1 por protocolo |
| GET ✅ | `/verificacao` | forms de verificação |
| GET ✅ | `/b.php?pg=o/central_servicos&tab={categoria\|perfil}` | taxonomia de serviços (UI) |
| GET ✅ | `/b.php?pg=o/carta_servicos_nova&s=marilia` | abertura exige login gov.br |

**Falta confirmar (🔶):** anos históricos (AJAX de ano não reversado, só 2026 sai inline); render de protocolo válido; POST `formAtendimento` (CAPTCHA).

**Cruzamentos:** satisfação/prazo → obrigação LAI · assuntos (tapa-buraco, lixo) → obras/contratos PAI · protocolo → resposta oficial verificável.

---

### 10. IPREMM — previdência municipal
- **Base URL:** `cadprev.previdencia.gov.br` (nacional) | `fourinfosistemas.com.br/...id=3073` (FourPrev) | `ipremm.com.br` (WAF 403) · **Auth:** mista · **Já integrado:** não · **Prioridade:** média
- **Entrega:** RPPS de Marília (CNPJ **59.989.830/0001-36**). Site institucional inteiro responde **403 (WAF)** a fetch. Holerite no FourPrev gated (sem transparência pública). Dados ricos no **CADPREV nacional** (DAIR/DRAA/DPIN/DIPR/CRP) e IEGPREV do TCE-SP.

**Endpoints CONFIRMADOS:**

| Método | URL | Nota |
|---|---|---|
| GET ✅ | `cadprev.previdencia.gov.br/Cadprev/pages/publico/crp/pesquisarEnteCrp.xhtml` | CRP por nome do ente; menus DRAA/DPIN/DAIR/DIPR/CRP. **Integrável via busca por nome, não URL direta** |
| GET ✅ | `cadprev.../extrato/extratoExterno.xhtml?cnpj=59989830000136` | carrega mas CNPJ sozinho="Ente não localizado" — exige UF/co_ente |
| GET ✅ | `fourinfosistemas.com.br/servicosonlinefourprev/login.jsf?id=3073` | gated, sem transparência (corretamente fora de escopo) |
| GET ✅ | `painel.tce.sp.gov.br/pentaho/.../iegprev.wcdf/generatedContent?userid=anony&password=zero` | IEGPREV carrega anônimo; **CDA/JSON não confirmado, só casca HTML** |
| GET ✅ | `apidatalake.tesouro.gov.br/ords/siconfi/tt/rreo` | SICONFI funciona (provado com SP capital) |

**⚠️ ERRO A CORRIGIR:** o mapa usava `id_ente=3529005` (=Mauá) no SICONFI. **id_ente correto de Marília = `3529005`**. RPPS dificilmente aparece isolado no RREO consolidado — fonte forte é **CADPREV/extratoExterno**, não SICONFI.

**Bloqueados/não confirmados (🔶):** todo `ipremm.com.br` (portal-transparência, PDFs de balancete `/imagens_arquivos/artigos/files/balancetescontabeis/`, ASP legado `pg.asp?codigo=N`) — **403 WAF sistemático**, padrões de path não verificáveis. Tratar como não-integrável por fetch automatizado sem contornar WAF.

**Cruzamentos:** CNPJ → BrasilAPI/PNCP/CEIS · repasses Prefeitura→IPREMM × PAI + SICONFI RREO Anexo 04 · folha aposentados × servidores ativos (acúmulo) · investimentos DAIR → CVM.

---

### 11. Legislação Municipal (Executivo) — portal Prefeitura
- **Base URL:** `https://www.marilia.sp.gov.br/portal/leis_decretos/...` (espelho do Executivo) · **Auth:** nenhuma · **Já integrado:** não · **Prioridade:** alta (consolidada com fonte #2)
- **Entrega:** Portarias/atos do Executivo que **NÃO estão na base da Câmara**. URL posicional `/portal/leis_decretos/{pagina}/0/0/.../`, ~1510 páginas, filtros `form_categoria`/`form_situacao`/`form_secretaria`. PDFs via slug ofuscado `/portal/download/legislacao/{SLUG}/`.
- ✅ Confirmado: Portaria nº 48356; categorias Lei Ordinária/Complementar/Decreto/Portaria. 🔶 **Falta confirmar:** segmentos corretos de paginação (padrão posicional do mapa não populou lista).

---

## Backlog de Integração (priorizado)

### ALTA prioridade

| Fonte | Endpoint | Dado novo | Esforço | Cruzamento com NEXO |
|---|---|---|---|---|
| Prefeitura | `/portal/dados-abertos/{contratos,licitacoes,obras,compra-direta}/{ano}` | Contratos/ARP, editais, obras, dispensas em JSON puro | **Baixo** | numeroProcesso↔PNCP/TCE; valorContrato↔DespesaAgrupada PAI |
| Prefeitura | `/portal/contrato/{id}` (HTML) | **NOME da contratada** (não existe no JSON) | Médio (scrape HTML) | Resolve CNPJ via PNCP/TCE/BrasilAPI |
| Prefeitura | `/portal/dados-abertos/diario-oficial/{ano}` | Texto integral de leis/portarias/atos | Baixo | Diário existente + SAPL (NLP de atos) |
| Querido Diário | `/gazettes?territory_ids=3529005&querystring=` | **DOM full-text 4.201 edições** (dispensa/emergencial/aditivo) | **Baixo** (sem auth) | empenhos/contratos por palavra-chave+data |
| SAGL Câmara | `/@@sessoes/id/{id}/votacao` | **Votação nominal por vereador** | Médio | voto × matérias que beneficiam fornecedores |
| SAGL Câmara | `/@@materias/{id}` + `/@@normas/{id}` | Tramitação, pareceres c/ relator, normas+vínculos | Médio | autoria Executivo×vereador; normas↔LOA/LDO |
| SMARAPD PAI | `POST /modulovisao/filter` (8 módulos) | Patrimônio 153k bens, publicidade drill-down, subvenções, emendas | Médio (headers obrig.) | Fornecedor/CNPJ↔fornecedor integrado, CEIS, PNCP |
| TCE-SP | `/api/json/despesas/marilia/{ano}/{mes}` | Empenhos c/ CNPJ/CPF — **2ª fonte** | **Baixo** | divergência TCE vs portal próprio; CNPJ↔sanções |
| TCE-SP | `resultado_analises_audesp.zip` + `rcl_completo.zip` | %educação/saúde/pessoal + RCL LRF | Baixo | limites LRF × SICONFI |
| lei13019 | `/parcerias.php?orgao_id=23` + `/prestacao-de-contas-emenda.php` | **59 OSCs c/ CNPJ** + 107 linhas execução emendas | Médio (parser HTML cru, user-agent browser) | CNPJ OSC↔CEIS, subvenções PAI, OSC-fantasma |
| Conselhos | `/api/conselhos/{organizations,documents,events}` | Atas/deliberações + agenda (reunião sem ata) | **Baixo** (Laravel JSON) | deliberações↔execução orçamentária; CAE↔merenda |
| Compras.gov | `/modulo-pesquisa-preco/1_consultarMaterial` | **Preço de referência federal** (sobrepreço) | Baixo | preço item × empenhos/contratos Marília |
| minhareceita / QD company | `minhareceita.org/{cnpj}`, `/company/partners/{cnpj}` | CNPJ+QSA (sócios) sem auth | Baixo | sócios em comum entre fornecedores (cartel/laranja) |
| PNCP | `instrumentoscobranca`, `/empenhos` (completar) | Faturas + empenhos por contrato | Baixo | *só se achar órgão que publique* |
| Legislação Executivo | `/portal/leis_decretos/{pag}/...` | Portarias/atos do Executivo (fora da Câmara) | Médio (descobrir paginação) | atos↔folha/servidores |

### MÉDIA prioridade

| Fonte | Endpoint | Dado novo | Esforço | Cruzamento com NEXO |
|---|---|---|---|---|
| Transparência Federal | `/api-de-dados/...-por-municipio?codigoIbge=3529005` | Repasses+benefícios federais | Médio (**token gratuito**) | recursos-recebidos × execução municipal; baseline socioeconômico |
| IBGE SIDRA | `/api/v3/agregados/5938/...N6[3529005]` | PIB/população | Baixo | normalização per-capita |
| IPREMM/CADPREV | `cadprev.../pesquisarEnteCrp.xhtml` | DAIR/DRAA/DPIN/DIPR/CRP do RPPS | Alto (fluxo busca por nome JSF) | repasses↔PAI; folha aposentados↔ativos |
| SIC/e-SIC | `/b.php?pg=o/transparencia&s=marilia` | Agregados Ouvidoria/e-SIC | Baixo (parse inline `transparencyData`) | satisfação↔LAI; assuntos↔obras |
| JUCESP (CKAN-SP) | `REL_{AAAA-MM}_PDA-CONSTITUICAO.csv` | Constituição de empresas (**agregado**, não CNPJ individual) | Baixo | tendência de aberturas por CNAE/município |

### BAIXA prioridade / parar

| Fonte | Endpoint | Motivo |
|---|---|---|
| Prefeitura | `ouvidoria`/`sic`/`contas-publicas`/`relatorio-viagens` JSON | sempre zerados/vazios |
| SAGL | `/generico/RSS2_normas`, `/api/`, `pysc/download_norma_pysc` | quebrados (503/404/500) |
| TCE-SP | `audesp.tce.sp.gov.br` | só submissão JWT, não leitura |
| IPREMM | todo `ipremm.com.br` | 403 WAF sistemático |
| SINAPI | site Caixa | sem API (só ZIP/XLSX mensal) |

---

## Pegadinhas

**Geo-bloqueio / WAF / anti-bot:**
- `ipremm.com.br` inteiro → **403 WAF sistemático** a fetch automatizado (portal-transparência, PDFs de balancete, ASP legado). Tratar como não-integrável sem contornar WAF (headers de browser/cookie).
- `lei13019.com.br` → **WAF que diferencia cliente**: WebFetch/browser passa, `curl` simples leva **403**. Integração em produção precisa user-agent de browser e possivelmente cookies/rate-limit.
- SAGL `norma_juridica_pesquisar_proc` → **HTTP 503 reproduzível** (anti-bot no endpoint de busca). Usar listagens `/consultas/legislacao/` + `cod_norma` sequencial.

**Headers obrigatórios (senão a request falha):**
- **SMARAPD PAI** (`DadosAbertos`, `MenuPortal`, `modulovisao/filter`, `parceriascelebradas`): exige `User-Agent` + `Origin: https://transparencia.marilia.sp.gov.br` + `Referer` em TODAS as chamadas, senão **HTTP 400**.
- **Conselhos**: enviar `Accept: application/json` sempre — sem ele o `documents` sem `org` retorna **302 redirect** em vez do 422 esperado.

**Encoding / parsing:**
- Prefeitura: campo `descricao` de licitações/diário vem com **HTML embutido**.
- lei13019: **CNPJs das 59 OSCs estão em atributos HTML `cnpjEntidade`** dos `<option>` — a conversão markdown os descarta; exige **parser de HTML cru**.
- SIC/e-SIC: dado útil é objeto JS inline `transparencyData` no HTML — **WebFetch via modelo deu falso-negativo**; usar GET cru.
- Conselhos: paths de PDF em `/storage/conselhos/` precisam **URL-encode de espaços/acentos**.
- JUCESP CSV: delimitado por `;`, e é **AGREGADO por município/CNAE** — NÃO serve para "empresa recém-aberta venceu licitação" (não há CNPJ individual).
- TCE-SP `id_fornecedor` vem como string composta: `"CNPJ - PESSOA JURIDICA - 52060118000109"` ou `"PESSOA FISICA - 605238"`.

**Paginação:**
- PNCP `/atas`: **`tamanhoPagina>=10`** senão HTTP 400. `contratacoes/*`: tamanho 10-50.
- SMARAPD patrimônio: **51.071 páginas a 3/pág** — usar `QuantidadeRegistros` alto (~1000), mas tolerância a valor alto não validada (risco timeout/rate-limit).
- Prefeitura editais HTML: 112 páginas; `csv.php` retorna **0 bytes stateless** (depende de sessão/cookie de busca).
- Falta confirmar paginação de `@@materias`/`@@normas` (mapa cita "step", não testado além da 1ª página) e do portal de contratos/prestação-emenda.

**Códigos HTTP a tratar como vazio (não erro):**
- PNCP: 204 (termos sem aditivo, janela vazia), 404 (empenhos inexistentes), 422 (`proposta` com dataFinal passada).
- Conselhos: 404 (id inexistente), 422 (documents sem `org`).
- Prefeitura: `{dados:[["Nenhum registro encontrado."]]}` quando vazio.

**Auth oculta (bloqueante não-óbvia):**
- **Transparência Federal** (`api.portaldatransparencia.gov.br`): exige header `chave-api-dados` (token gratuito por cadastro). **401 idêntico** para rota válida e inexistente — 401 não prova nada. 2 endpoints (`bpc-por-municipio`, `auxilio-emergencial-por-municipio`) **ausentes do OpenAPI** — re-verificar antes de confiar.
- **dados.gov.br**: header `Authorization` (chave gov.br) mesmo para leitura.
- **TCE-SP** `/despesas-fornecedor`: scrape de 2 etapas (capturar `form_build_id`+sessão Drupal).

**SPA bundles / dado escondido:**
- Conselhos: mapa `id→nome` do conselho está **hardcoded no bundle Vue** (`ConselhosView`), não na API.
- Câmara: `presenca` retornou **vazio em todas as sessões testadas** — não confiar em índice de presença via API sem mais validação.
- SIC: seletor de ano usa AJAX bundlado não reversado — **só 2026 sai inline**.
- TCE/IEGM/IEGPREV Pentaho: dashboard renderiza anônimo mas **CDA data API = 401** — só visual, sem dados brutos.

**CORREÇÃO TRANSVERSAL (afeta múltiplas integrações):**
- **IBGE de Marília = `3529005`** (NÃO `3529005`=Mauá; NÃO `3529005` no SICONFI nem `id_ente`). Validado por `servicodados.ibge.gov.br/.../municipios/3529005`, Querido Diário e PNCP (159 registros com `municipioNome="Marília"`). Auditar e corrigir TODA referência a IBGE/id_ente no NEXO antes de coletar.