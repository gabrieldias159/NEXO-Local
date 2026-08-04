Confirmed: `tipoEmpenho` exists in `DespesaNorm` (normalizar.ts:264,285) but not in `EmpenhoNorm` (lines 8-24, only DespesaNorm has it), and `probabilidadeEnquadramento` is referenced in prioridade.ts/tipos.ts but no detector sets it. All claims are grounded. I have enough verification to consolidate decisively. Producing the plano-mestre now.

---

# PLANO-MESTRE NEXO — Consolidação do Conselho dos 20 Especialistas

> **ORÁCULO** · alvo único: Prefeitura de Marília/SP (IBGE **3529005**, CNPJ 44477909000100) · ano corrente 2026 (eleitoral). Documento de coordenação. Os números de linha citados são dos pareceres e foram aferidos por amostragem direta no código (deteccao.ts:42-48, requerimentos.ts:231-237, entidades.ts:17-20, normalizar.ts:264 — todos confirmados).

## Sumário do Conselho

### Convergências (recomendado por VÁRIOS setores — peso = quantos pareceres pediram)

| # | Convergência | Setores que pediram | Peso |
|---|---|---|---|
| C1 | **Anexar 2ªs fontes (PNCP/sanções/TCE/DOM) ao `ContextoAnalise` e estender `COLECOES_BRUTAS` em `deteccao.ts:42-48`** — destrava os ~13 detectores XS que hoje retornam `[]` | Cientista Dados, Eng. Dados, Investigador, Cruzamento×2, Licitações, Contabilidade, Estratégia, Entidades, Jurídico-Adm | **10+** |
| C2 | **Cruzamento sancionado-recebendo-recurso (FR-04: CEIS/CNEP × empenho) no pipeline persistido** — confiabilidade 90, quase zero falso positivo, vira representação direta | Jurídico-Adm, Penal, Cientista Dados, Investigador, Cruzamento, Estratégia | **6** |
| C3 | **Materializar `scorePrioridade` + ranking de fornecedores no cron** (tirar `getCnpj`/BrasilAPI e full-scan do hot path do App Hosting) | Eng. Software, Eng. Dados, DevOps, BI, Cientista Dados | **5** |
| C4 | **Preencher a 3ª perna do score (`probabilidadeEnquadramento`, hoje default 50)** — governa o ranking mas está vazia/invisível | Jurídico-Adm, Penal, Cientista Dados, Estatística, BI, Investigador, Contabilidade | **7** |
| C5 | **`tipoEmpenho` no `EmpenhoNorm` + netting de anulação/estorno** (hoje ranking/concentração/sanções somam bruto) | Eng. Software, Eng. Dados, Contabilidade, Cientista Dados, Cruzamento, Estatística | **6** |
| C6 | **Completar denylist `ENTES_PUBLICOS_MARILIA` (entidades.ts:19) + carimbar `orgaoPublico` na fronteira (`normalizar.ts`)** — bug "Prefeitura como fornecedor" latente em 17 detectores | Eng. Software, Eng. Dados, Cientista Dados, Contabilidade, Entidades, Estratégia, Investigador | **7** |
| C7 | **Disclaimer canônico obrigatório em TODA saída copiável/exportável** (hoje só na JUSTIFICATIVA / só na /tce) | Jurídico-Adm, Penal, UX, BI, Segurança, Normalização | **6** |
| C8 | **Grafo societário (QSA via minhareceita/QD-partners) persistido** — destrava cartel/laranja (XS-01/05/11/12) | Cientista Dados, Eng. Dados, Investigador, Cruzamento×2, Entidades, Estratégia, Auditoria | **8** |
| C9 | **Detector divergência SMARAPD × TCE-SP por nº empenho** (dupla fonte oficial = baixíssimo FP) | Jurídico-Adm, Cientista Dados, Eng. Dados, Estatística, Cruzamento×2, Contabilidade, Auditoria, Investigador | **9** |
| C10 | **Coletor Querido Diário (DOM full-text) em cron → `nexo_diario_dom`** | Eng. Dados, Hacker, Investigador, Cruzamento×2, Licitações, Estratégia | **6** |
| C11 | **`orderBy`+`limit`+índices Firestore no serving** (`firestore-read.ts` lê coleção inteira; índices atuais mortos) | Eng. Software, Eng. Dados, DevOps | **3** |
| C12 | **Expandir `DETECTOR_REQUERIMENTO` de 5 para ~141 detectores** (hoje ~136 achados não viram minuta) | Jurídico-Adm, UX, Estratégia | **3** |
| C13 | **Confirmar tabela `limites.ts` contra Decreto 12.807/2025** (warning Fase-0 #7 aberto; calibra fracionamento) | Jurídico-Adm, Eng. Software, Licitações | **3** |
| C14 | **Trocar média+2σ por mediana+MAD nos detectores de outlier** | Cientista Dados, Estatística | **2** |
| C15 | **Suíte de regressão (vitest, golden-snapshot) — ZERO testes hoje** | Eng. Software, Estatística, Contabilidade, Estratégia | **4** |
| C16 | **`nexo_auditoria` append-only (quem viu/copiou/exportou indício nominal)** — LGPD art. 37 | Penal, Segurança | **2** |
| C17 | **Mascarar CPF/RG no servidor antes do `NextResponse.json()`** (hoje cru em todas as rotas /api/nexo/* exceto folha) | Segurança, Normalização, Penal | **3** |
| C18 | **`maxInstances:1` + lock/lease nos crons; tirar detecção do hot path do App Hosting (OOM)** | DevOps, Idempotência | **2** |

### Divergências (onde os pareceres conflitam — decisão do ORÁCULO)

1. **Onde sanitizar entidade pública** — Eng.Software quer na fronteira (`normalizar.ts`, denylist só em `src/lib`); Eng.Dados quer carimbar `_orgaoPublico` já na **ingestão** (`functions/coleta.ts`, denylist espelhada). **Decisão:** fronteira em `normalizar.ts` AGORA (P0, custo zero de duplicação) + guard imediato nos 17 loops; espelhar na ingestão só DEPOIS, quando o backfill justificar o filtro server-side barato (Onda 4). Documentar a escolha para não nascer "segundo bug de Mauá silencioso".

2. **Como tornar a detecção escalável** — DevOps quer **mover o motor para DENTRO da Function** (4GiB, elimina o hop HTTP); Eng.Software/Eng.Dados aceitam manter o POST mas com Zod+versão+chunking. **Decisão:** mover o motor para a Function é o destino correto (Opção B do DevOps), MAS é "mexe-em-código-que-funciona" de alto risco — fica na **Onda 5**, gated pela suíte de regressão. Antes disso, mitigação barata: validar body com Zod + alarme de OOM. Não é P0 enquanto o volume atual não estoura.

3. **Exibir vs ocultar o número da 3ª perna** — BI quer **exibir** `probabilidadeEnquadramento` como 3º medidor; Penal exige **NUNCA** renderizar como "% de ilícito/improbidade" (munição contra o gabinete). **Decisão:** ambos têm razão e são compatíveis — exibir como **"Aderência a elementos objetivos da norma" / checklist**, nunca como "% de improbidade". Adicionar teste que falha se vazar como percentual de ilícito (parecer Penal). Rótulo de Penal vence o de BI.

4. **Per-capita** — Estatística alerta que copiar o limiar de Calil (cidade de 8-10k hab) para Marília (~240k) gera falso positivo em massa. **Decisão:** per-capita SIM, mas escalado ao porte e ancorado na própria série multi-ano de Marília, nunca o número do exemplo. P1, não P0.

### Os 5 Temas-Mestres

1. **🔌 LIGAR O QUE JÁ ESTÁ PAGO (cross-source).** O diferencial do NEXO — cartel, sancionado, divergência TCE — está coletado no Firestore mas **morto**: `deteccao.ts` só lê 5 coleções, os 13 XS retornam `[]`. ROI negativo todo dia que não se liga o fio. **É o teto de impacto do produto.**
2. **⚖️ DA DETECÇÃO AO ATO (última milha jurídica).** Sem `DETECTOR_REQUERIMENTO` completo (5→141), sem camada de Representação (TCE/MP), sem disclaimer carimbado e sem a 3ª perna preenchida, o achado morre na tela e/ou vira passivo jurídico.
3. **🧮 HONESTIDADE DO NÚMERO (netting + estatística robusta + materialidade).** Anulação somada como gasto, média+2σ mascarando outlier, limiares mágicos (20%, 2x, R$150k) sem materialidade — tudo isso produz indício rebatível e munição contra o próprio gabinete.
4. **🛡️ BLINDAGEM (LGPD + eleitoral + boa-fé).** CPF cru nas rotas, `nexo_auditoria` inexistente, gate eleitoral `ano%4===0` desligado em 2026, minuta sem disclaimer circulando — o gabinete não prova uso institucional no ano de maior exposição.
5. **🏗️ FUNDAÇÃO DE ESCALA (cron materializa, serving só lê).** Score/ranking recomputado por-request, full-scan no Firestore, índices mortos, detecção no hot path do App Hosting que serve TODO o Ofício Express. Cresce linearmente com o backfill até estourar.

---

## Roadmap priorizado (tabela única deduplicada)

| # | Ação | Categoria | Prio | Valor | Esforço | Risco | Setores que pediram |
|---|---|---|---|---|---|---|---|
| 1 | **Estender `COLECOES_BRUTAS` (deteccao.ts:42) + `ContextoAnalise`/`ContextoCross` com PNCP, sanções, TCE, DOM, subvenções, folha, publicidade** — destrava 13 XS | cruzamento | **P0** | alto | médio | baixo | 10+ setores |
| 2 | **FR-04 sancionado×empenho no pipeline persistido** (`nexo_sancoes`×`nexo_empenhos` por raiz CNPJ) | detector | **P0** | alto | baixo | baixo | 6 setores |
| 3 | **Detector divergência SMARAPD×TCE-SP por nº empenho** (`tce-despesas.ts` já traz nroEmpenho+CNPJ+valor) | cruzamento | **P0** | alto | médio | baixo | 9 setores |
| 4 | **Suíte vitest + golden-snapshot de `rodarDetectores` + invariante "fornecedor ≠ ente público"** | auditoria | **P0** | alto | médio | nenhum | 4 setores |
| 5 | **Denylist completa `ENTES_PUBLICOS_MARILIA` (IPREMM 59989830000136, Câmara, SAAE/DAEM, fundos) + carimbar `orgaoPublico`/`cnpjRaiz` na fronteira `normalizar.ts` + guard nos 17 loops** | detector | **P0** | alto | médio | baixo | 7 setores |
| 6 | **Disclaimer canônico (`NEXO_DISCLAIMER`) concatenado em `gerarTextoRequerimento` + clipboard/PDF/dossiê/briefing + mascarar PII na geração** | jurídico | **P0** | alto | baixo | nenhum | 6 setores |
| 7 | **Expandir `DETECTOR_REQUERIMENTO` 5→~141 por PREFIXO de família + fallback R00** | jurídico | **P0** | alto | baixo | baixo | 3 setores |
| 8 | **Preencher 3ª perna `probabilidadeEnquadramento`: régua jurídica 4 faixas + derivação `f(classificacao, fundamentoLegal)` em pós-processador** | modelo | **P0** | alto | baixo | baixo | 7 setores |
| 9 | **Confirmar `limites.ts` contra Dec. 11.317/11.871/12.343/12.807; teto data-aware (ano da data do empenho)** | dado | **P0** | alto | baixo | nenhum | 3 setores |
| 10 | **Materializar `scorePrioridade`+`ordenacaoTs` no doc `nexo_alertas` (deteccao.ts:~207)** | processador | **P0** | alto | médio | baixo | 5 setores |
| 11 | **`nexo_auditoria` append-only (ver/copiar/exportar indício nominal) via `verificarSessao` + rules create-only** — LGPD art. 37 | auditoria | **P0** | alto | baixo | baixo | 2 setores |
| 12 | **Mascarar CPF/RG no servidor antes do `NextResponse.json()` em todas as rotas /api/nexo/*** | segurança | **P0** | alto | médio | baixo | 3 setores |
| 13 | **`maxInstances:1` + retryConfig + lease em nexo_sync_state/_locks nos crons** | infra | **P0** | alto | baixo | baixo | 2 setores |
| 14 | **Filtrar `nexo_empenhos` por `_exercicio` em `coleta-sancoes.ts:189`** (parar full-scan 4x/dia) | coletor | **P0** | alto | baixo | baixo | DevOps |
| 15 | **Decoder windows-1252 (`fetchTextSmart`) em SMARAPD/dados-abertos/functions** (mojibake em 100% dos acentos) + header `Origin` obrigatório | processador | **P0** | alto | médio | baixo | Normalização |
| 16 | **Corrigir gate eleitoral `ano%4===0` (folha.ts:172, diarias-comp.ts:172); separar pleito municipal de geral; ligar art.73 jul-set/2026** | detector | **P0** | alto | baixo | médio | Penal |
| 17 | **Ranking de fornecedores pré-computado no cron → `nexo_ranking_fornecedores` (netting+raiz+ente público); rota só LÊ** | processador | **P0/P1** | alto | médio | baixo | 5 setores |
| 18 | **`tipoEmpenho` no `EmpenhoNorm` + base do ranking/concentração migrada para LÍQUIDO (`DespesaAgrupada`)** | dado | **P1** | alto | médio | médio | 6 setores |
| 19 | **Camada de fetch resiliente: token-bucket por host + backoff/jitter + detecção de challenge** | coletor | **P0/P1** | alto | médio | baixo | Hacker |
| 20 | **Trocar fonte de normas morta `RSS2_normas` (503) por `@@normas` (200)** — bug vivo em prod | coletor | **P0** | alto | baixo | baixo | Hacker |
| 21 | **Coletor Câmara SAGL/Zope (`@@materias`/`@@normas`/`@@sessoes/votacao`) em cron; migrar `onSaplSync` de 1-autor-hardcoded** | coletor | **P0/P1** | alto | médio | médio | Hacker |
| 22 | **Coletor Querido Diário (DOM full-text) → `nexo_diario_dom`** (dispensa=1.351 hits) | coletor | **P1** | alto | médio | baixo | 6 setores |
| 23 | **Coletor despesas TCE-SP por empenho → `nexo_tce_despesas`** (2ª fonte granular) | coletor | **P1** | alto | médio | baixo | Eng. Dados, Cruzamento |
| 24 | **Grafo societário QSA → `nexo_socios` + `nexo_grafo_componentes` (union-find) anexado como `grafoSocietario`** | grafo | **P1** | alto | alto | baixo | 8 setores |
| 25 | **Detector cartel/sócio-comum sobre componentes conexos (XS-01/05/11/12/15)** | detector | **P1** | alto | alto | médio | 5 setores |
| 26 | **Mediana+MAD (Iglewicz-Hoaglin |Z|>3.5) em diario-det/diarias-comp/emergenciais/receita** | processador | **P1** | alto | médio | médio | 2 setores |
| 27 | **Benford (1º/2º dígito + MAD de Nigrini) → `nexo_benford` + detector BN-01** | detector | **P1** | alto | médio | baixo | Estatística |
| 28 | **`orderBy`+`limit`+`startAfter` em `firestore-read.ts` + índices compostos (exercicio,ativo,scorePrioridade DESC)** | infra | **P1** | alto | médio | baixo | 3 setores |
| 29 | **Coletor aditivos PNCP `/termos` (LC-19/20 reais) + `/contratacoes/publicacao` (modalidade) + `frutoAdesao` (carona LC-14)** | coletor | **P1** | alto | médio | baixo | Licitações |
| 30 | **Materializar alertas LRF/EC29/CF212 (MF-09/12/13/14) em `nexo_alertas` via detector `metas-fiscais-det.ts`** | detector | **P1** | alto | médio | médio | Auditoria, Contabilidade |
| 31 | **Coletor AUDESP `resultado_analises_audesp.zip` + `rcl_completo.zip`** (% oficiais do TCE + cross-check SICONFI) | coletor | **P1** | alto | médio | baixo | Auditoria |
| 32 | **Restos a pagar: `anoInscricao` real + tipo RPP/RPNP + valorPago/Cancelado (consertar MF-10 inerte, normalizar.ts:208)** | coletor | **P1** | alto | médio | baixo | Contabilidade |
| 33 | **Camada de Representação (`representacoes.ts`): TCE-SP art.113 §1º + Notícia de Fato MP-SP, com rol de procedência** | jurídico | **P0/P1** | alto | médio | baixo | Jurídico-Adm |
| 34 | **Camada de CASO `nexo_casos` (status/nota/protocolo) + minuta exportável PDF/.docx + prefill editor** | ux | **P1** | alto | alto | baixo | UX |
| 35 | **Detector sobrepreço item × Compras.gov pesquisa-preço (PNCP `/itens/resultados`)** | cruzamento | **P1** | alto | alto | baixo | 4 setores |
| 36 | **Health-check por fonte (distinguir "caiu/mudou" de "sem dado") + snapshot+hash do bruto HTML/JSON-LD** | auditoria | **P1** | alto | médio | baixo | Hacker, Normalização |
| 37 | **Estado explícito "cruzamento inativo: fonte não anexada" na resposta (anti-falso-negativo)** | auditoria | **P1** | médio | baixo | nenhum | Cruzamento×2 |
| 38 | **Camada materialidade + FDR (Benjamini-Hochberg) + piso R$ ancorado na RCL** | modelo | **P1** | alto | alto | médio | Estatística |
| 39 | **Hash invariante à ordem (multiset, coleta.ts:149) + `ocorrencias` idempotente por geração** | coletor | **P0** | alto | baixo | baixo | Idempotência |
| 40 | **Cruzamento empenho SMARAPD × contrato PNCP (sem-contrato, divergência, acima-do-global)** | cruzamento | **P1** | alto | alto | médio | Cruzamento, Licitações, Estratégia |
| 41 | **Scraper `/portal/contrato/{id}` (único lugar do NOME da contratada) + resolução CNPJ** | coletor | **P2** | alto | médio | baixo | 4 setores |
| 42 | **Validar dígito verificador Módulo 11 (cpf-cnpj-validator já no projeto) na normalização** | processador | **P0** | alto | médio | baixo | Normalização |
| 43 | **Instrumentar tetos de paginação + corrigir truncamento patrimônio (40 pág = 13% de 153k bens)** | coletor | **P0/P1** | alto | médio | baixo | Eng. Dados, Hacker |
| 44 | **Coletor lei13019 (59 OSCs com CNPJ em atributo HTML, UA browser) → cruzamento OSC×CEIS/CEPIM** | coletor | **P1** | alto | médio | médio | Hacker, Normalização, Cruzamento |
| 45 | **Coletor Conselhos Municipais (Laravel, 36 conselhos) → reunião-sem-ata + CAE×merenda** | coletor | **P1** | médio | baixo | baixo | Hacker |
| 46 | **Curva ABC por GRUPO (raiz) + HHI substituindo limiar fixo 20% (concentracao.ts:13)** | processador | **P1** | médio | médio | médio | Cientista Dados, Estatística |
| 47 | **Detector Ficha Limpa: XLSX TCE contas-irregulares × ordenadores/sócios** | cruzamento | **P0/P1** | alto | médio/alto | médio | Penal, Auditoria |
| 48 | **Endpoint `/api/nexo/agregados` (série mensal + matriz UG×fornecedor + distribuição) pré-computado** | processador | **P0/P1** | alto | médio | baixo | BI |
| 49 | **Exibir 3ª perna como "Aderência à norma" no AlertaDetalhe (NUNCA "% de ilícito") + teste de trava** | ux | **P0** | alto | baixo | nenhum | BI, Penal |
| 50 | **Mover motor de detectores para DENTRO de `onNexoColetaDiaria` (4GiB) — sair do hot path App Hosting** | processador | **P1** | alto | alto | médio | DevOps |
| 51 | **Navegação mobile (drawer) no `NexoShell` + saúde real das fontes no header** | ux | **P0/P1** | alto | médio | baixo | UX |
| 52 | **Detector série temporal: degrau/CUSUM + sazonalidade + pico eleitoral (Lei 9.504 art.73)** | processador | **P2** | médio | alto | baixo | Estatística, Cientista Dados |
| 53 | **Backfill histórico 2021-2024 com checkpoint (baseline de série)** | coletor | **P2** | médio | médio | baixo | Eng. Dados, DevOps |
| 54 | **Conciliação SMARAPD×SICONFI×TCE por dotação/função** | cruzamento | **P2** | alto | alto | baixo | Contabilidade, Auditoria |
| 55 | **Detector empenha-anula-reemite (manobra de competência) sobre `MovimentoEmpenho`** | detector | **P2** | médio | médio | baixo | Eng. Software, Contabilidade, Cruzamento |
| 56 | **RBAC (Leitor/Analista/Chefe) via claim + gate de revisão humana antes de exportar indício nominal** | segurança | **P1** | alto | médio | médio | Segurança, Penal |
| 57 | **Cachear `verificarSessao` 60s + rate-limit por uid nas rotas que coletam ao vivo** | infra | **P1** | médio | baixo | baixo | Segurança |
| 58 | **Desligar/rarear 10 módulos coletados sem leitor (patrimônio, publicidade, subvenções...)** | coletor | **P1** | alto | baixo | baixo | DevOps |
| 59 | **Quebrar mega-arquivos `*-cat.ts` + separar `*-planejados.ts` dos ativos** | processador | **P2** | médio | médio | baixo | Eng. Software |
| 60 | **Reconciliação programática registry↔catálogo (derivar ATIVOS, não Set manual)** | auditoria | **P1** | médio | baixo | baixo | Eng. Software |
| 61 | **Votação nominal SAGL × fornecedor beneficiado (XS-08) + alteração legislativa→fornecedor (H08)** | cruzamento | **P3** | médio | alto | **alto** | Jurídico-Adm, Hacker, Cruzamento, Estratégia |
| 62 | **Timeline por alvo no dossiê (cadeia licitação→empenho→liquidação→pagamento) + cadeia visual** | ux | **P2** | alto | médio | baixo | BI, Investigador |
| 63 | **Loop de calibração: realimentar `status='falso_positivo'` (Beta/shrink bayesiano por detectorId)** | modelo | **P2** | alto | médio | baixo | Cientista Dados |
| 64 | **TTL/expurgo de dado pessoal + `nexo_alertas` inativos >18m + retenção LGPD** | infra | **P3** | médio | médio | baixo | Segurança, DevOps |

---

## Coletores densos a construir (priorizados, base no catálogo)

| Prio | Fonte / Endpoint | Dado denso | Paginação / Backfill | Coleção destino |
|---|---|---|---|---|
| **P0** | **Sanções** `nexo_sancoes` já existe — só **ligar à detecção** + rankear por LÍQUIDO | CEIS/CNEP ativo × empenho | top-N líquidos (MAX_CNPJS=400 atual; ordenar pós-netting) | (já coletado) |
| **P0** | **Câmara SAGL** `sapl.marilia.sp.leg.br/@@normas?ano&tipo` (substitui RSS2_normas 503) e `@@materias`, `@@sessoes/{id}/votacao`, `@@vereadores` | normas (vigência/altera-revoga), votação NOMINAL, autoria Exec×vereador | por ano×tipo (tipo obrigatório); `@@sessoes/presenca` retorna vazio — não confiar | `nexo_camara_sagl`, PDF em `/sapl_documentos/` |
| **P1** | **Querido Diário** `api.queridodiario.ok.org.br/gazettes?territory_ids=3529005` | DOM full-text (4.201 edições, dispensa=1.351 hits, disponível desde 2022-10-10) | `published_since/until` incremental; ID = edição+termo | `nexo_diario_dom` |
| **P1** | **TCE-SP despesas** `transparencia.tce.sp.gov.br/api/json/despesas/marilia/{ano}/{mes}` | nr_empenho + CNPJ + valor (2ª fonte do MESMO empenho) | 12 chamadas/ano; reusar netting de `coleta-tce.ts:133` | `nexo_tce_despesas` |
| **P1** | **PNCP** `/contratos/{ano}/{seq}/termos` (aditivos), `/contratacoes/publicacao` (modalidade), `/itens/{n}/resultados` (valorUnitarioHomologado), `/atas` | aditivos reais (LC-19/20), modalidade, sobrepreço, carona (`frutoAdesao`) | fan-out por contrato; **cron southamerica-east1** (geo-bloqueio 403); tamanhoPagina≥10 senão HTTP 400 | `nexo_contratos` (enriquecer) |
| **P1** | **AUDESP** `transparencia.tce.sp.gov.br/.../resultado_analises_audesp.zip` + `rcl_completo.zip` | % educação/saúde/pessoal JÁ CALCULADOS pelo TCE + RCL mensal desde 2015 | mensal; filtrar id_ente Marília | `nexo_audesp_indicadores` |
| **P1** | **QSA** `minhareceita.org/{cnpj}` + `queridodiario.../company/partners/{cnpj}` (sem auth) | sócios, endereço, capital, dataAbertura, naturezaJurídica | fila com backoff/TTL 30d; CPF mascarado em repouso; cobertura como métrica (ME/MEI têm buraco) | `nexo_socios` |
| **P1** | **Dados Abertos Prefeitura** `getContratos/getLicitacoes/getObras` (hoje live-only) | contratos municipais com `numeroProcesso` (nomeContratada=null no JSON) | cron; nome só via scrape `/portal/contrato/{id}` | `nexo_contratos_municipais` |
| **P1** | **lei13019** `lei13019.com.br/parcerias.php?orgao_id=23` | 59 OSCs com CNPJ no atributo HTML `cnpjEntidade` | **UA de browser obrigatório (WAF 403 p/ curl)**; parser cheerio sobre atributo | `nexo_terceiro_setor_osc` |
| **P1** | **TCE-SP XLSX** `relacao-de-responsaveis-por-contas-julgadas-irregulares` | nome+CPF de responsáveis (Ficha Limpa LC 64/90) | download + filtro município | `nexo_contas_irregulares` |
| **P1** | **Conselhos** `www2.marilia.sp.gov.br/api/conselhos` (Laravel) | 36 conselhos, atas, eventos (CAE=24 merenda) | `Accept: application/json` SEMPRE (senão 302/422) | `nexo_conselhos` |
| **P2** | **Compras.gov** `dadosabertos.compras.gov.br/modulo-pesquisa-preco/1_consultarMaterial` | preço de referência federal por código de catálogo | sem auth; casar por código/descrição | `nexo_precos_ref` |
| **P2** | **Patrimônio** SMARAPD (corrigir `maxPag:40`) | 153.211 bens, Fornecedor com CNPJ embutido | paginar por sub-filtro UG ou checkpoint (~307 pág); **só após existir detector que leia** | `nexo_patrimonio` (já existe, truncado) |
| **P2** | **Publicidade drill-down** SMARAPD `FiltroRedirecionaVisao IDDespesa TipoValor='3'` | empenho→liquidação→pagamento de mídia | por IDDespesa dos maiores empenhos | `nexo_publicidade_detalhe` |
| **P3** | **CADPREV** `cadprev.previdencia.gov.br` (IPREMM — ipremm.com.br dá HTTP 000) | DRAA/DPIN/DAIR/DIPR/CRP do RPPS | fluxo JSF (ViewState+POST), esforço alto | `nexo_cadprev` |

---

## Cruzamentos de dados (record linkage) — maior valor / menor ruído

| # | Cruzamento | Chave de junção | Indício gerado | FP / Enquadramento |
|---|---|---|---|---|
| **X1** | **Sancionado × empenho** | CNPJ-raiz empenho × CEIS/CNEP ativo na data | Fornecedor impedido recebendo recurso | ~zero FP · Lei 14.133 art.14 IV + Lei 12.846 |
| **X2** | **Divergência TCE × SMARAPD** | `nroEmpenho` normalizado (zero-pad/UG difere) + CNPJ | Prefeitura declara X ao TCE, publica Y no portal; ou empenho num lado só | baixíssimo FP · dever de fidedignidade LAI + LRF art.48 → **representação ao próprio TCE** |
| **X3** | **Sócio-comum entre vencedores** | CPF de sócio (QSA) entre raízes CNPJ distintas no mesmo certame | Cartel/conluio | baixo FP se CPF idêntico · art.90 Lei 14.133 + Lei 12.846 art.5 IV |
| **X4** | **Mesmo endereço/contador** | logradouro+nº+CEP normalizado entre fornecedores concorrentes | Concorrência simulada / empresa-fachada | médio-forte · art.90 |
| **X5** | **Empenho × contrato PNCP** | `numeroProcesso`/`numeroControlePNCP`; fallback CNPJ+faixa de valor | Empenho > teto sem contrato PNCP; contrato sem execução; execução > valorGlobal | baixo FP · fuga Lei 14.133 art.95 |
| **X6** | **Aditivo PNCP real × teto 25%** | contrato → `/termos` | LC-19/20 reais (sai do proxy valorGlobal−valorInicial) | alto · art.125 |
| **X7** | **Sobrepreço item × referência federal** | código de catálogo / descrição × `valorUnitarioHomologado` PNCP | razão preço/ref > 1,25 = sobrepreço | robusto · art.23 + dano ao erário ("merenda Campinas") |
| **X8** | **DOM × portal** | nº de processo no full-text × empenhos | Dispensa no DOM ausente do portal (XS-02); contrato no DOM sem empenho (XS-06) | lacuna de transparência · LAI |
| **X9** | **Contas irregulares (Ficha Limpa) × ordenadores/sócios** | nome+CPF do responsável | Sócio/ordenador com contas julgadas irregulares | baixo FP · LC 64/90 art.1 I 'g' (SEM afirmar inelegibilidade) |
| **X10** | **Servidor (folha) × sócio de fornecedor** | nomeNorm (folha sem CPF → homonímia) | XS-05 ex-servidor vira PJ; XS-04 nomeação sem folha | exigir reforço (sobrenome incomum + objeto coincidente) senão só "atenção" |
| **X11** | **OSC subvencionada × CEIS/CEPIM × fornecedor SMARAPD** | CNPJ da OSC (via lei13019) | OSC impedida recebendo; mesma entidade nos 2 canais | médio · Lei 13.019 |
| **X12** | **Repasse RPPS (IPREMM) × SICONFI × CADPREV** | CNPJ 59989830000136 + alíquotas folha | Repasse declarado × recolhido divergente | alto · Lei 9.717 + LRF art.50 |

**Regra dura para todo cruzamento (Cruzamento + Investigador):** vínculo só vira "suspeita/crítico" com **CNPJ idêntico (14 dígitos)**; match por nome/similaridade nasce no máximo "informativo" com aviso "confirmar identidade". Evita associar julgado/sanção à pessoa errada por homonímia — o trilho "indício ≠ acusação" depende disso.

---

## Processadores & modelos de dados

- **Entity resolution (`entidades.ts` estendido):** `resolverEntidade(doc, nome) → {idCanonico, candidatos, confiança}`. Token-set ratio + Jaro-Winkler sobre `rotuloCanonico`, com **blocking** por prefixo de raiz CNPJ + 1º token (evita N²). Validação de dígito verificador (Módulo 11, `cpf-cnpj-validator` já no projeto) ANTES de admitir como entidade — `"PESSOA FISICA - 605238"` (6 dígitos = código interno) vira documento vazio, não pseudo-CPF. Suportar CNPJ alfanumérico (NT RFB 49/2024). `canonicalizarOrgao(nome)` para colapsar SME/SMS/SAAE.
- **Grafo (union-find/DSU, O(N·α(N)) no cron):** nós = {CNPJ-raiz, CPF-sócio, servidor-folha, OSC}; arestas = {sócio-de, mesmo-endereço, mesmo-CNAE+objeto, co-licitante}. Componentes conexos → `nexo_grafo_componentes {componenteId, cnpjsRaiz[], cpfsSocio[], forcaMaxAresta, score}`. Score de vínculo: CPF-sócio (forte) > endereço (médio-forte) > nome-só (fraco, homonímia) > CNAE (contextual) → alimenta a 3ª perna. Evoluir para Louvain/label-propagation só se a densidade exigir.
- **Netting:** `tipoEmpenho` no `EmpenhoNorm` + `ehMovimentoExpansivo(e)`; LÍQUIDO = Σempenho+Σreforço−Σanulação (descartar ≤0). Fonte canônica = `MovimentoEmpenho` (razão por movimento, hoje coletado e morto). **Toda** análise estatística (Benford/HHI/per-capita) roda sobre base netada + sem entes públicos, senão estorno e repasse intra-governo contaminam a distribuição.
- **Benford/ABC/robusto:** `estatistica/benford.ts` (1º+2º dígito, MAD de Nigrini >0.015, qui-quadrado só como secundário — rejeita sempre com N grande); `estatistica/robusto.ts` (mediana+MAD, escore Iglewicz-Hoaglin |Z|>3.5, fallback IQR quando MAD=0); curva ABC por **grupo/raiz** sobre base líquida; HHI substituindo o limiar fixo de 20%; exigir n≥3 empenhos (evita disparar com energia/água, monopólio natural).
- **Materialidade + FDR:** piso R$ ancorado na RCL/orçamento de Marília; Benjamini-Hochberg sobre os alertas do exercício antes de publicar (sem isso parte dos ~141 detectores produz ruído estatístico esperado). Carimbar `papelTrabalho {universo, critério, corte, nº exceções}` em cada alerta.
- **3ª perna (`probabilidadeEnquadramento`) — régua jurídica de 4 faixas:** ALTO 85-95 (norma cogente + dado oficial cruzado: FR-04, LC-19 com aditivo PNCP, divergência TCE, MF-IND); MÉDIO 55-70 (norma clara + dado próprio: LC-01, LC-18, XS-07); BAIXO 35-50 (proxy textual/princípio: LC-14, LC-24); MUITO BAIXO <35 (depende de dolo não inferível: nepotismo R10). Derivar default `f(classificacao, fundamentoLegal, sujeitoTipo)` no pós-processador para os ~136 que não setam. **Renderizar como checklist "Aderência à norma", NUNCA como "% de improbidade"** (teste de trava).
- **Per-capita normalizado:** população IBGE/SIDRA coletada (não hardcoded), escalada ao porte de Marília (~240k), comparada à própria série multi-ano — denominador de normalização antes de qualquer comparação inter-temporal.

---

## Onda de execução recomendada (o que eu, Claude, implemento primeiro)

> Separação rígida: **🟢 ADITIVO seguro** (cria arquivo/coleção/campo novo, não muda número visível) vs **🟡 MEXE em código que funciona** (muda número na tela/minuta — exige a suíte de regressão antes).

### Onda 0 — Rede de segurança + bug vivo (🟢 aditivo, dias)
*Pré-requisito de TODO o resto. Risco nulo, destrava com segurança.*
- **#4** Suíte vitest + golden-snapshot de `rodarDetectores` + invariante "fornecedor ≠ ente público" + unit de `entidades.ts`/`prioridade.ts`.
- **#20** Trocar `RSS2_normas` (503) por `@@normas` — **bug vivo em produção**, 🟢 substituir fonte morta por viva.
- **#39** Hash invariante à ordem + `ocorrencias` idempotente por geração.
- **#13** `maxInstances:1`+retryConfig+lease nos crons. **#14** filtrar `coleta-sancoes` por `_exercicio`.

### Onda 1 — Blindagem + última milha jurídica (🟢 quase tudo aditivo, alto valor/baixo esforço)
*Protege o gabinete no ano eleitoral e faz o achado virar ato. É o multiplicador de menor risco.*
- **#6** Disclaimer canônico em toda saída + **#42** Módulo 11 + **#15** decoder cp1252 + header Origin (este último 🟡 leve: muda nomes — cobrir com #4).
- **#7** `DETECTOR_REQUERIMENTO` 5→141 por prefixo + R00. **#8** preencher 3ª perna (régua + derivação). **#49** exibir 3ª perna como checklist.
- **#11** `nexo_auditoria` append-only. **#12** mascarar CPF/RG no servidor. **#16** corrigir gate eleitoral (🟡 — muda comportamento de FP-09/DE-12; cobrir com teste).
- **#9** confirmar `limites.ts` (🟢 verificação documental). **#33** camada de Representação TCE/MP.

### Onda 2 — LIGAR O CROSS-SOURCE (o teto de impacto do produto)
*🟢 anexar fontes é aditivo; 🟡 os detectores que disparam mudam o feed — gated por #4 e #5.*
- **#5** denylist completa + carimbo na fronteira + guard nos 17 loops (🟡 — corrige bug latente; cobrir com invariante de #4).
- **#1** estender `COLECOES_BRUTAS` + `ContextoCross`. **#37** estado "cruzamento inativo" honesto.
- **#2** FR-04 sancionado×empenho. **#3** divergência TCE×SMARAPD. **#47** Ficha Limpa.
- **#10**+**#17** materializar `scorePrioridade`+ranking no cron. **#48** `/api/nexo/agregados`.

### Onda 3 — Honestidade do número + serving escalável (🟡 muda números — exige Onda 0)
- **#18** `tipoEmpenho`+netting LÍQUIDO. **#26** mediana+MAD. **#46** ABC/HHI por grupo. **#32** restos `anoInscricao`.
- **#27** Benford. **#38** materialidade+FDR. **#28** orderBy+índices Firestore.
- **#30** materializar MF-* fiscais. **#31** AUDESP. **#19** fetch resiliente. **#36** health-check + snapshot+hash.

### Onda 4 — Coletores densos novos + grafo (🟢 aditivo, alto esforço)
- **#22** Querido Diário. **#23** TCE despesas. **#29** PNCP /termos+publicacao+itens+atas. **#21** SAGL completo. **#24**+**#25** QSA+grafo+cartel. **#43** patrimônio. **#44** lei13019. **#41** scraper contrato. **#35**/**#40** sobrepreço + empenho×PNCP. **#53** backfill 2021-2024.

### Onda 5 — Refatorações de arquitetura/escala (🟡 mexe em código que funciona — por último, gated)
- **#50** mover motor para dentro da Function (OOM). **#34** camada de CASO + minuta exportável. **#51** mobile + saúde header. **#56**/**#57** RBAC+cache+rate-limit. **#54** conciliação tripla. **#52**/**#63** série temporal + calibração FP. **#59**/**#60** quebrar mega-arquivos + reconciliação registry. **#58**/**#64** desligar módulos sem leitor + TTL. **#61** votação SAGL×fornecedor (P3, alto risco eleitoral — por último).

---

## Riscos & guardrails

**Jurídico (calúnia/difamação/improbidade):**
- Minuta copiada (`dossies/page.tsx:53`) circula fora do ambiente controlado **sem disclaimer e já nomeando o fornecedor** → exposição a dano moral (CC art.186/927) e calúnia (CP art.138-140). **Guardrail:** disclaimer concatenado no clipboard/PDF (Onda 1, #6); bloquear protocolo direto sem confirmação do gabinete.
- Pós-Lei 14.230/2021 improbidade exige **dolo específico** (rol art.11 taxativo). **Guardrail:** auditar todo texto que cite "improbidade" (R10 nepotismo) para NÃO afirmar — só "indício a apurar"; citar a norma administrativa cogente (14.133/LRF/4.320), não 8.429.
- Limite de dispensa errado (warning Fase-0 #7) torna a representação rebatível e queima credibilidade no TCE. **Guardrail:** #9 antes de qualquer representação de fracionamento.

**LGPD (art. 7º/12/23/37):**
- CPF/RG cru no Firestore e nas rotas (exceto folha); `nexo_auditoria` inexistente. **Guardrail:** mascarar na origem (#12) + auditoria append-only (#11) + minimização na exportação (mascarar nome de sócio/MEI, modo "sem nominar" para difusão ampla). Base legal: fiscalização parlamentar (art.31 CF / Lei Orgânica) — **política pública, não eleitoral**. Banner de finalidade persistente no `/nexo/layout.tsx`.
- Grafo manipula CPF de sócio (QSA) e nome de servidor → persistir **mascarado em repouso**, desmascarar só no dossiê sob revisão humana liberada (RBAC, #56).

**Eleitoral 2026:**
- Gate `ano%4===0` desliga conduta vedada no ano de maior exposição (runtime inerte vs F18 "ativo"). **Guardrail:** #16 separa pleito municipal de geral, liga art.73 jul-set como "atenção".
- Qualquer heatmap/gráfico "risco por secretaria" sem rótulo "a apurar" vira peça de campanha. **Guardrail:** mesmo rigor de linguagem do AlertaDetalhe em toda visualização; cruzamentos políticos (votação SAGL, H08) tratados como INVESTIGAÇÃO com revisão humana obrigatória, nunca representação/publicação automática.

**Segurança:**
- `firestore.rules` liberam CPF/RG a qualquer autenticado (rules 285-291, 321-322); duplicata morta `src/firestore.rules`. **Guardrail:** RBAC por papel para dado pessoal completo; remover duplicata; `crypto.timingSafeEqual` no segredo de `detectar`; restringir Web API key no GCP; sanitizar mensagens de erro upstream.

**Custo / escala:**
- Detecção no hot path do App Hosting (1CPU/1GB, `maxInstances:1`) que serve TODO o Ofício Express → OOM derruba o app inteiro conforme o backfill cresce. **Guardrail:** #50 (Onda 5, gated); alarme de OOM antes. Full-scan `coleta-sancoes` 4x/dia (#14); índices mortos + scan no serving (#28); 10 módulos coletados sem leitor (#58). Backfill retroativo SÓ depois dos P0 de detecção e filtro de exercício (senão amplifica os dois gargalos de uma vez).

**Anti-bot / resiliência:**
- Sem rate-limit por host: 4 workers concorrentes batem o mesmo SMARAPD e podem disparar o WAF; um 429/503 transitório quebra o módulo em PARCIAL. lei13019/SMARAPD dependem de UA de browser falsificado. **Guardrail:** #19 (token-bucket por host + backoff/jitter + detecção de challenge: se esperava JSON e veio text/html 200, é WAF — não persistir lixo). **#36** health-check distingue "fonte caiu/mudou" de "sem dado" (o sensor que pegaria o `RSS2_normas` morto); snapshot+hash do bruto detecta alteração retroativa de ato.

**Arquivos-âncora confirmados no código:** `deteccao.ts:42-48` (5 coleções), `requerimentos.ts:231-237` (5 detectores mapeados), `entidades.ts:17-20` (só Prefeitura + TODO), `normalizar.ts:264` (`tipoEmpenho` só em DespesaNorm), `prioridade.ts`/`tipos.ts` (3ª perna existe, nenhum detector preenche). Docs de governança: `docs/nexo-plano-mestre.md`, `docs/nexo-fontes-catalogo.md`, `docs/transcricoes_advogado.md`, `docs/nexo-roadmap-v2.md`.