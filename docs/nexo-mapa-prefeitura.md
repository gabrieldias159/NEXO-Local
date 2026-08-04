# 🌳 NEXO — Árvore de fontes e documentos da Prefeitura de Marília

> Gerado pelo WF-1 (mapeamento, 13/31 subsistemas confirmados por rede) +
> catálogo do repositório (18 externos). Detalhe bruto em `nexo-mapa-fontes.json`.
> **Tema-mãe: TUDO LINKADO.** Cada fonte abaixo lista suas **chaves de linkage**
> (como conecta empenho↔contrato↔edital↔dispensa↔DOM↔documento) e os
> **documentos** que expõe (para o catálogo `nexo_documentos`).
> Legenda: ✅ coletado · 🟡 coletado com gap · 🔴 não coletado.

## 1. SMARAPD PAI — Portal da Transparência (núcleo "seguir o dinheiro")
Host SPA `pai-webapp`; API REST/JSON same-domain, **exige User-Agent de browser**
(sem ele = HTTP 400). POST `modulovisao/filter`. Chave de linkage primária em
toda a família: **nº empenho + nº processo (admin/licitatório) + CNPJ**.

- 🟡 **Empenho/Fornecedor** (`fornecedor`/`fornecedoranalitico`) → `nexo_empenhos`.
  Núcleo do linkage. **Gap:** drill-down de ITENS (objeto granular via IDDespesa)
  e as colunas-URL Itens/Liquidações/Pagamentos (deep-link) não coletados.
- 🟡 **DespesaAgrupada** (`DespesaseInvestimentos`) → `nexo_despesas`. Objeto,
  elemento, tipoEmpenho, modalidade. **Gap:** ValorLiquidado, Vínculo/FonteRecurso.
- 🟡 **Diárias** → `nexo_diarias`. **Gap:** DESTINO não coletado (drill-down).
- ✅ **Empenho por Modalidade** (`quadro_de_renda_local`) → `nexo_modalidades`.
- 🟡 **Restos a Pagar** (`restoapagar`) → `nexo_restos`. **Gap:** field-mapping
  (cpfCnpj vem vazio → MF-10 quase não dispara), anoInscrição/tipo RPP-RPNP.
- 🟡 **Patrimônio** → 153k bens, **truncado em 40 pág**. Fornecedor c/ CNPJ embutido.
- ✅ **Publicidade** (7 endpoints) — drill-down empenho→liquidação→pagamento de mídia.
- 🟡 **Folha/Servidores** — chave p/ nepotismo/sócio (cruzar nome).
- 🟡 **Licitações** (7 endpoints) — nº processo, modalidade, objeto, situação,
  **PDFs de edital**. → catálogo de documentos.
- 🟡 **Contratos** (8 endpoints) — `portal/contrato/{id}` é o **ÚNICO lugar do
  NOME da contratada**. nº contrato/processo, vigência, valor. **Linkage central.**
- 🟡 **Obras** (6 endpoints) — contrato, medições, situação física/financeira.
- ✅ **Receita** — arrecadação por fonte/rubrica.
- 🔴 **Convênios/Subvenções/Adiantamentos** — mapear (OSC, repasses).

## 2. Dados Abertos da Prefeitura (9 endpoints)
`getContratos`/`getLicitacoes`/`getObras`/`getEmpenhos`… JSON, cobre até 2017.
Contratos municipais com **numeroProcesso** (nomeContratada às vezes null →
casar com scrape de `portal/contrato/{id}`). **Chave:** numeroProcesso, nº contrato.

## 3. DOM — Diário Oficial Municipal 🔴
- **Querido Diário** `api.queridodiario.ok.org.br/gazettes?territory_ids=3529005`:
  full-text (dispensa/contrato/edital), `published_since/until`, **PDF da edição**.
- DOM direto (usado por `onDiarioDirectFetch`). **Chave:** nº processo no texto →
  cruza com empenho (DOM×portal: ato publicado ausente do portal = XS).
  → catálogo `nexo_documentos` (cada edição/ato = um documento).

## 4. Câmara SAGL 🟡
- ✅ **@@normas** (JSON-LD, recém-corrigido; RSS2 morto) — leis/decretos, PDF em
  `/sapl_documentos/`. **Base legal viva p/ o crivo.**
- 🔴 **@@materias** (PLs/requerimentos, autoria Exec×vereador), **@@sessoes/votação**
  (nominal — tratar como investigação).

## 5. Fontes oficiais de controle (2ª fonte / divergência) 🔴
- **TCE-SP despesas** `transparencia.tce.sp.gov.br/api/json/despesas/marilia/{ano}/{mes}`:
  **nr_empenho + CNPJ + valor** = 2ª fonte do MESMO empenho → divergência SMARAPD×TCE.
- **TCE-SP contas irregulares** (XLSX) — nome+CPF (Ficha Limpa LC64/90).
- **AUDESP** (zip) — % saúde/educação/pessoal já calculados + RCL mensal.
- **PNCP** — `/contratos/{ano}/{seq}/termos` (aditivos LC-19/20), `/itens/resultados`
  (sobrepreço), modalidade, atas, frutoAdesão. Geo-bloqueio (southamerica-east1).
- **SICONFI/STN** — RREO/RGF (LRF/EC29/CF212). ✅ já há coletor.
- **CGU sanções** CEIS/CNEP/CEPIM → ✅ `nexo_sancoes` (FR-04 ligado; falta token).

## 6. Grafo / terceiro setor / referência 🔴
- **QSA** `minhareceita.org/{cnpj}` — sócios (CPF), endereço, capital (cartel/laranja).
- **lei13019** `lei13019.com.br/parcerias.php?orgao_id=23` — 59 OSCs c/ CNPJ no
  atributo HTML; **UA de browser obrigatório (WAF)**.
- **Conselhos** `www2.marilia.sp.gov.br/api/conselhos` (Laravel) — atas/eventos.
- **Compras.gov** — preço de referência federal (sobrepreço por código de catálogo).
- **CADPREV** (IPREMM/RPPS) — DRAA/DAIR/CRP; fluxo JSF.
- **IBGE/SIDRA** — população (per-capita normalizado).

---

## 🔗 Mapa de LINKAGE (chave de junção → vínculo)
| De | Para | Chave | Vira |
|---|---|---|---|
| empenho | contrato | numeroProcesso / nº contrato / PNCP | execução do contrato |
| empenho | licitação/edital | processoLicitatorio | base licitatória |
| empenho | dispensa | nº processo (DOM/dados-abertos) | contratação direta |
| empenho | DOM | nº processo no full-text | publicidade do ato |
| contrato | documento (PDF) | id do contrato / `portal/contrato/{id}` | prova |
| empenho | TCE despesas | nr_empenho + CNPJ | divergência 2ª fonte |
| CNPJ | sanção / QSA | CNPJ-raiz | inidôneo / cartel |

## 📄 Tipos de documento p/ `nexo_documentos` (catálogo)
Edital, contrato, termo aditivo, processo de dispensa/inexigibilidade, nota de
empenho/liquidação/pagamento, edição do DOM, ato/decreto/lei, ata de conselho,
parecer jurídico, planilha orçamentária. Cada doc: `{tipo, orgao, data,
numeroProcesso, url, pdfUrl, hash, chavesLinkage[], fonte}`.

## Plano de coleta priorizado (valor×esforço)
1. **DOM full-text (Querido Diário)** → catálogo de documentos + DOM×portal.
2. **Contratos** (`portal/contrato/{id}` scrape do nome) + **dados-abertos getContratos**.
3. **Editais/Licitações** (PDFs) + **dispensas**.
4. **TCE despesas** (divergência por nº empenho).
5. **PNCP** /termos /itens (aditivos, sobrepreço).
6. **QSA** (grafo societário).
