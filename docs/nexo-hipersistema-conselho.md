# NEXO ORQUESTRA — Hipersistema de Fiscalização (Documento de Arquitetura do Conselho)

> **Status:** proposta de arquitetura aprovada pelo conselho (9 pareceres) e revisada por 3 lentes adversariais (viabilidade/custo, LGPD/risco-legal, segurança/robustez).
> **Data:** 2026-06-10 · **Branch de referência:** `main` (nexo_* em produção) + `nexo/expansao` (multi-feature commitado, não deployado).
> **Princípio mãe:** *TUDO LINKADO* — qualquer CPF/CNPJ/documento renderizado em qualquer tela é um ponto de entrada investigável, sem copiar-colar.
> **Princípio de engenharia herdado e confirmado no código real:** ADITIVO · IDEMPOTENTE (docId determinístico + `set{merge:true}`) · self-contained em `functions/` (nunca importa de `src/`) · *"indício nunca acusação"* · PII hasheada/mascarada (`pii.ts` espelhado dos dois lados) · **o CRON MATERIALIZA, o SERVING SÓ LÊ**.

---

## 0. Aviso do relator: a blindagem vem ANTES da ambição

Este documento descreve um hipersistema ambicioso, mas o conselho NÃO o aprova no formato *big-bang*. As três lentes adversariais convergiram num veredito único:

- **Viável na ambição, inviável na ordem proposta.** O núcleo de valor (sanção × vínculo-vivo, entity-chip, score único) é real, barato e roda 100% na infra que já existe (Cloud Functions + `multi-provider.ts`). O resto é onde moram o custo e o risco.
- **A "fronteira inviolável" do design (`lgpd-gate`) tem um buraco do tamanho da coleção mais sensível.** A coleção `entities` (firestore.rules:299-305) hoje guarda **CPF/RG/endereço CRUS** legíveis por qualquer usuário autenticado, e a regra `nexo_.*` (firestore.rules:335-338) dá **leitura bruta de TODA coleção `nexo_*`** a qualquer usuário ativo. O gate mascara na SAÍDA da rota — o dado cru continua legível direto no banco via REST.
- **O pseudônimo é reversível por padrão.** `pii.ts:43` traz `SALT_FALLBACK` **hardcoded e commitado**; sem `NEXO_PII_SALT` no ambiente, `hashDoc(cpf) = sha256(salt_público + 11_dígitos)` é força-brutável em segundos.

Por isso, **a Seção 12 (Guardrails LGPD) e a Seção 14 (Segurança) são pré-requisitos invioláveis, não apêndices.** Cinco blindagens precedem qualquer P0 (ver §15.0).

---

## 1. Visão e nome do sistema

### 1.1 Nome
**NEXO ORQUESTRA** — *o grande processador*. Formaliza o que hoje já existe implicitamente (crons encadeados por horário) num **DAG explícito, versionado e observável de 5 estágios**, e abre extensões **estritamente aditivas** sobre o esqueleto provado em produção.

### 1.2 Visão
Transformar o NEXO de um conjunto de coletores+detectores num **hipersistema de fiscalização** em que:
1. cada documento público vira **prova rastreável** (acervo com hash, versão e procedência);
2. cada CPF/CNPJ vira **objeto investigável universal** (entity-chip em todas as telas);
3. o eixo central — **"quem está sancionado E ainda contrata AGORA"** — é materializado e lido em O(1);
4. a inteligência (LLM/RAG) é **acessório de prova, nunca acusação**, e a privacidade é **enforçada pelo dado**, não prometida pela convenção.

### 1.3 O que NÃO é (ressalva dos críticos)
- Não é um sistema de "lista negra publicável". O `scoreRisco` e os quadrantes são **insumo interno de fiscalização com acesso restrito por papel**, jamais publicação. Disclaimer não basta juridicamente.
- Não é um motor de IA que decide identidade ou culpa. Record-linkage é determinístico/auditável; o LLM entra como mais um *registro cru*.
- Não depende de um worker doméstico para entregar valor. As ondas P0/P1-A rodam **sem worker algum**.

---

## 2. O grande processador: DAG de 5 estágios (fluxo lógico forte)

O `nexo-orquestra` grava **1 run-manifest por ciclo** em `nexo_runs` (versão de cada subprocessador, hashes de entrada, durações, status por nó) para reprodutibilidade e rollback. **Ressalva do crítico (viabilidade):** na Fase 1 o DAG **só ANOTA** — a observabilidade vive no `nexo_sync_state` que já existe; NÃO é um cron novo que reescreve os crons existentes. Promover a cron formal só após o MVP provar volume.

```
                          ┌──────────────────────────────────────────────┐
                          │            NEXO ORQUESTRA (DAG)               │
                          │  run-manifest → nexo_runs  (versão+hash+status)│
                          └──────────────────────────────────────────────┘
                                            │ declara dependências reais
                                            │ (nó a jusante checa nexo_sync_state
                                            │  do nó a montante e DEGRADA HONESTO,
                                            │  em vez de encadear por relógio)
                                            ▼
 [E1] COLETA ───────────────────────────────────────────────────────────────────────────
   crons existentes  +  coleta-sancoes-estaduais (TCE-SP/CGE-SP)  +  coleta-punidas-municipal
        │ idempotente (docId determinístico)            │ hash multiset → nexo_sync_state
        ▼
 [E2] CATÁLOGO + PROCEDÊNCIA ────────────────────────────────────────────────────────────
   documentos.ts evoluído → ACERVO (procedencias[], versoes[], hash sha256, dedup)
        │ (estágio EXTRAIR roda no worker — fora do caminho crítico das ondas iniciais)
        ▼
 [E3] LINKAGE + RESOLUÇÃO DE IDENTIDADE ─────────────────────────────────────────────────
   linkage.ts  +  resolverEntidade (det → prob)  → nexo_links (grafo) + identidade canônica
        │ TODOS apontam para a MESMA base canônica (LLM NÃO decide identidade)
        ▼
 [E4] PERFIL + MATERIALIZAÇÃO + CRUZAMENTO ──────────────────────────────────────────────
   perfil-entidades.ts  +  mat-vinculo-vivo  +  indice-sancao-consolidada  +  scoreRiscoEntidade
        │ .stream()+.select() PROJETADO (nunca .get() de coleção inteira)
        │ → nexo_entidades, nexo_vinculo_vivo, nexo_sancao_consolidada, nexo_entidade_risco
        ▼
 [E5] SÍNTESE LLM + SERVING ──────────────────────────────────────────────────────────────
   crons gerente/advogado (multi-provider) + rotas Next que SÓ LEEM projeções (lgpd-gate na saída)
                                            ▲
                                            │ enriquecimento ASSÍNCRONO (degrada honesto)
                          ┌─────────────────┴───────────────────┐
                          │  WORKER LOCAL NVIDIA  ←  fila nexo_jobs │
                          │  OCR · embeddings · sumarização · OSINT │
                          └─────────────────────────────────────────┘
```

### 2.1 Resolução do conflito ESCALA × AMBIÇÃO (CTO+big-data × cientista+ML)
Nada pesado entra em Cloud Functions. O DAG declara dependências reais; toda materialização troca `.get()` de coleção inteira por `.stream()+.select()` projetado. Cruzamentos caros viram **materializações incrementais por exercício gravadas como doc**, nunca joins em memória sob demanda. O cap silencioso (`MAX_DOCS_POR_COLECAO=30_000` em `perfil-entidades.ts`, `20_000` em `linkage.ts`) vira **telemetria explícita** ("cap atingido"). IA pesada vai para o worker; a falha do worker é absorvida.

> **RESSALVA CRÍTICA (alta gravidade) — o `stream-projetado-guard` AINDA NÃO EXISTE.** Verificado no código: `coleta-sancoes.ts` projeta só 2 campos (`_cnpj`/`_valor`), mas `perfil-entidades.ts` ainda faz `.get()` de coleção INTEIRA (`lerExercicio`, `lerSancoes` sem filtro, `agregarVinculos`). Há **4 incidentes de OOM/timeout em prod** (commits 9a19779, d13a0a9, 131312a, 667a1bc). `mat-vinculo-vivo` reusa `perfil-entidades.ts` → **NASCE com o mesmo risco de OOM em 1GiB**. **Inversão obrigatória:** o stream-guard é **pré-requisito de P0-A**, não sucessor em P1-A. Refatorar `perfil-entidades.ts`/`linkage.ts` e **MEDIR memória de pico com dados reais de 2025** antes de escrever `mat-vinculo-vivo`. Se não couber em 1GiB com stream, o cruzamento JÁ é job do worker, não cron.

### 2.2 Resolução do conflito OSINT × LGPD (OSINT × jurista)
Os guardrails do jurista são **regras de primeira classe** — o módulo `nexo-lgpd-gate` que TODO subprograma atravessa. **Ressalva crítica:** o gate como está hoje é convenção de biblioteca na SAÍDA, não fronteira de dado. Ver §12 e §14 para o reposicionamento obrigatório (mascarar no CRON antes do write; regras Firestore por papel).

### 2.3 Topologia de execução (3 zonas — custo × latência × privacidade)
- **(a) BROWSER WebGPU** — instantâneo+privado. **Ressalva crítica:** cortar NER neural/WebLLM do P0. Detecção = regex + `docValido()` (já existe, instantâneo, zero download). `@huggingface/transformers` está no repo mas só para Whisper (`transcribe.worker.ts`); `@mlc-ai/web-llm` **não está no repo**. WebGPU é experimento opcional FORA do P0.
- **(b) CLOUD multi-provider.ts** — caminho quente leve (gerente/advogado/RAG-responder). Chain grátis-primeiro NVIDIA NIM → Groq → OpenRouter → Gemini.
- **(c) WORKER LOCAL NVIDIA** — pesado/lote/idempotente. **Cortado do caminho crítico das ondas iniciais.** Entra isolado, com health-check no sync-state e "modo-sem-worker" testado.

---

## 3. Catálogo dos subprogramas

Legenda: **P0** = núcleo de valor / blindagem · **P1** = escala+enriquecimento · **P2** = inteligência avançada (adiada).
"Onde roda": CF = Cloud Function · lib = biblioteca pura (isomórfica) · worker = worker local NVIDIA · browser = cliente.

| Subprograma | Prio | Onde roda | Depende de | Notas dos críticos |
|---|---|---|---|---|
| **nexo-lgpd-gate** (guardrails 1ª classe) | **P0** | lib (`src/` + espelho `functions/`) | `pii.ts` (existe) | Deve virar invariante de **leitura**, não só escrita. Mascarar no CRON antes do write. |
| **stream-projetado-guard** | **P0** | refactor de `perfil-entidades.ts`/`linkage.ts` | — | **PRÉ-REQUISITO de P0-A** (promovido de P1-A). Medir memória de pico. |
| **mat-vinculo-vivo** (cruzarVinculoVivoSancao — pedido 3) | **P0** | CF cron 08h15, `.stream()+.select()` | indice-sancao-consolidada, nexo_entidades, nexo_empenhos, nexo_contratos_municipais | Núcleo. Funciona só com lado federal; estadual degrada honesto. |
| **superficie-entity-chip** (pedido 4) | **P0** | browser + rota Next leve | resolverEntidade, nexo_entidades, mat-vinculo-vivo, nexo_links, lgpd-gate, `docValido` | Sem NER neural/WebLLM no P0. CPF nunca na URL (usar docHash). |
| **indice-sancao-consolidada** | **P0** | CF cron diário | coleta-sancoes-estaduais, coleta-punidas-municipal, `idCanonicoEntidade` | Fusão multi-esfera por CNPJ-raiz. |
| **coleta-sancoes-estaduais** (TCE-SP + CGE-SP) | **P0** | CF cron 12h, self-contained | nexo_empenhos, parser de `coleta-contas-irregulares.ts` | Validar ESTRUTURA antes de persistir (WAF serve 200 com lixo). |
| **scoreRiscoEntidade** (score composto único) | **P1** | lib em `perfil-entidades.ts` | `prioridade.ts`, nexo_alertas, mat-vinculo-vivo, nexo_links | Doação NÃO pesa como risco. Score explicável e expurgável. |
| **resolverEntidade** (EntityResolver v2 det+prob) | **P1** | lib `record-linkage.ts` + cron perfil | `idCanonicoEntidade` (existe), nexo_entidades | Merge probabilístico = decisão que afeta pessoa → revisão humana ANTES de efeito visível. |
| **nexo-orquestra** (orquestrador-DAG) | **P1** | CF onSchedule leve (maxInstances:1) | nexo_sync_state (existe) | Fase 1 SÓ ANOTA; vive no sync-state. Não vira cron novo no MVP. |
| **coleta-punidas-municipal** | **P1** | CF cron semanal | resolverEntidade, registrarDocumento | **Premissa do design ERRADA: NÃO "destrava FR-05"** (ver §3.1). |
| **fila-jobs** (`nexo_jobs` com backpressure) | **P1** | produtor: CF · consumidor: worker | acervo-documental | Backpressure por **contador agregado** (`nexo_jobs_meta`), não `count()` recorrente. |
| **worker-local-nvidia** | **P1** | worker Node no gabinete | fila-jobs, multi-provider, acervo | **Ponto único de falha doméstico.** Cortado do caminho crítico inicial. SA fine-grained, sem admin SDK ideal. |
| **acervo-documental** (catalogar→baixar→extrair→busca) | **P1** | catalogar/baixar: CF 1GiB · extrair: worker | documentos.ts, pdfjs-dist (existe), worker | Mascarar PII **antes** de indexar/enviar a LLM externo. |
| **rag-acervo** (busca híbrida + RAG citado) | **P2** | rota Next + browser (re-rank) + worker (index) | acervo-documental, multi-provider, lgpd-gate | Adiado até o acervo provar volume. Cota NVIDIA isolada do gerente/advogado. |
| **detectarComunidadeCartel** (Louvain) | **P2** | CF cron novo · `grafo-comunidade.ts` | nexo_links, nexo_socios | Pessoa física no cluster = perfilamento. Nós PF colapsáveis. Bloqueado até papéis. |
| **osint-perimetrado** (dork-builder + redes públicas) | **P2** | deep-links: rota · coleta: worker | **lgpd-gate (BLOQUEANTE)**, resolverEntidade, worker | **BLOQUEADO** até existir papéis+finalidade logada + LIA/DPIA escrita + política de retenção. SSRF allowlist. |

### 3.1 Correção de premissa: FR-05 (ressalva média, confirmada no código)
O design afirmava que `coleta-punidas-municipal` "destrava o FR-05 hoje vazio". **Falso.** Verificado: `src/lib/nexo/detectores/leniencia-det.ts` existe e implementa o FR-05 como **detector de LENIÊNCIA**, com suíte de regressão completa (`src/lib/nexo/__tests__/fr05.test.ts`). O design confundiu o "FR-05 do catálogo de monitoramentos (empresaspunidas SMARAPD)" com o FR-05 já codado (leniência) — **IDs distintos compartilhando rótulo**.
**Decisão obrigatória:** a lista municipal `empresaspunidas` é uma **FONTE NOVA**. Criar detector com **ID próprio** (ex.: `SM-PUNIDA`) consumindo-a, e auditar `docs/nexo/02-catalogo-de-monitoramentos.md` para não reusar ID ocupado. O valor (sanção municipal real) permanece; só o enquadramento estava errado.

---

## 4. Os operadores de cruzamento (registry versionado)

Cada operador é uma função pura registrada com versão; o `nexo-orquestra` grava a versão usada no run-manifest.

1. **VÍNCULO-VIVO ⋈ SANÇÃO** (federal ∪ estadual ∪ municipal) por CNPJ-raiz: `(contrato vigente OU empenho<12m OU licitação em andamento) JOIN indice-sancao-consolidada`, vigência aferida por `sancaoVigente()`. Quadrante crítico = vivo + sanção vigente AGORA. **É o pedido 3.**
2. **SANÇÃO ⋈ PAGAMENTO PÓS-DATA:** `empenho/pagamento.data >= sancao.dataInicio` = pagamento durante inidoneidade (distingue pré-sanção regular de pós-sanção a apurar — lógica do `cruzamento_pos_sancao.py`).
3. **ENTITY-RESOLUTION determinístico** (chave-mãe de TODO join): CNPJ-raiz colapsa filiais | CPF-Módulo11 | rótulo-nome canônico — reuso integral de `idCanonicoEntidade`.
4. **ENTITY-RESOLUTION probabilístico** (Fellegi-Sunter): blocking (cnpjRaiz | tokens-nome | CEP | telefone | metaphone-PT) + Jaro-Winkler+endereço+sócios → **candidato de merge** (revisão humana), **NUNCA funde doc válido automaticamente**.
5. **empenho ↔ contrato** por `numeroProcesso` administrativo normalizado (forte) — já em `linkage.ts`, promovido a operador versionado.
6. **empenho ↔ licitação** por processo licitatório/edital normalizado (forte) — já em `linkage.ts`.
7. **empenho(SMARAPD) ↔ tce_despesa** por `nrEmpenho` normalizado (`EMP-{seq pad10}-{ano}`) + CNPJ (forte) — a **"regra de ouro"**, travada por golden test cross-ambiente.
8. **processo ↔ edição do DOM** por nº de processo citado no texto (média) — reforçado pela extração do full-text do PDF.
9. **DOC(PDF) ↔ ENTIDADE/GRAFO:** CNPJ/processo/empenho extraídos do CORPO do PDF pelo worker viram `chavesLinkage` e costuram o documento-prova ao alerta.
10. **DEDUP por conteúdo (sha256):** mesmo PDF re-hospedado em URLs diferentes colapsa em um, revelando re-publicação.
11. **VERSÃO ↔ VERSÃO (alteração retroativa):** hash de conteúdo entre coletas detecta documento trocado silenciosamente → dispara `alteracao.ts`.
12. **SÓCIO-COMUM → COMUNIDADE:** mesmo `cpfHash` em CNPJ-raízes distintos, escalado de par para cluster (Louvain) = grupo econômico/cartel a apurar; co-disputa da mesma licitação = sinal forte.
13. **SANÇÃO ⋈ QSA:** sócio de empresa sancionada que abre/controla OUTRA fornecedora (laranja/sucessão) por `cpfHash`, reusando `socio-comum-det.ts`.
14. **SEMÂNTICO:** cosseno entre embedding da query e dos chunks (`nexo_doc_chunks`).
15. **ENTIDADE → DOSSIÊ (fan-in):** `idCanonico` cruza empenhos+contratos+sanções+chunks dos PDFs linkados → sumário único no worker, citando fontes.
16. **ENTIDADE ↔ PRESENÇA-OSINT** por nome canônico (sempre "indício a verificar", dentro do lgpd-gate).
17. **SCORE COMPOSTO:** média geométrica do score triplo (`prioridade.ts`) agregada por entidade em UM `scoreRisco` 0..100 — coerência de ranking entre TODAS as telas.

> **RESSALVA CRÍTICA (LGPD/segurança):** operadores 4, 7, 8, 9, 10, 11 dependem do **stream-guard** e de **índices compostos declarados** (§14.4). Operadores que casam por NOME (estadual/municipal, comunidade) **NUNCA sobem a "crítico"** — cap em "atenção" garantido por teste. Operador 17 **não pode pesar doação** (ato lícito) como fator de risco.

---

## 5. O entity-chip universal

A superfície que torna QUALQUER CPF/CNPJ renderizado em qualquer tela um objeto investigável — o documento JÁ é o ponto de entrada. Pipeline único: **DETECÇÃO → PRÉVIA → DRILL-DOWN.**

### 5.1 DETECÇÃO (browser, lib pura `entity-detect.ts`)
Varre nós de texto com regex tolerante e **VALIDA Módulo-11 via `docValido()` de `entidades.ts`** — descarta lixo numérico (código TCE de 6 dígitos, protocolos). CNPJ/CPF entram com confiança alta. Memoizado por string; instrumentação opt-in por rota (`EntityProvider`) para rollout gradual.

> **RESSALVA CRÍTICA (média) — NER neural CORTADO.** Para detectar CPF/CNPJ, regex + `docValido()` (que JÁ existe) resolve 100%. NER neural client-side é over-engineering e baixa centenas de MB. `transformers.js` está no repo só para Whisper. **RG: o crítico de LGPD determina NÃO detectar, NÃO destacar, NÃO oferecer busca** — RG é documento pessoal, não público por LAI; se aparecer em PDF, o gate MASCARA (trata como CPF), não destaca.

### 5.2 PRÉVIA (rota leve + cache)
`<EntityChip>` abre `<EntityHovercard>` no hover-intent (~120ms, prefetch). O hook `useEntidadePreview` faz dedupe por doc + cache em memória + SWR. A rota `GET /api/nexo/entidade/[hash]` resolve a identidade canônica via `resolverEntidade` e **LÊ as projeções PRÉ-COMPUTADAS** `nexo_entidades` + `nexo_vinculo_vivo` (não API externa ao vivo — leitura O(1), cacheável com ETag). Mostra: razão social, badge VÍNCULO VIVO, badge SANÇÃO (3 esferas com nível), total faturado, nº contratos/empenhos, top-3 flags, `scoreRisco`. Estados honestos: skeleton, "coleta inativa" vs "sem registro", erro com retry.

> **RESSALVA CRÍTICA (segurança, média):** (a) **CPF NUNCA na URL** — a rota recebe `docHash`, não o número (URL vaza para logs de proxy/Cloud Run/referer). (b) **Prefetch com debounce real + dedupe + teto de concorrência**, e resposta uniforme em timing para "sem registro" vs "com registro" (evitar oráculo de enumeração). (c) `Cache-Control: no-store` na rota de prévia.

### 5.3 DRILL-DOWN
Clique abre o perfil completo + `<GrafoVinculos>` (sigma.js, ego-network navegável de `nexo_links`), fechando o loop chip→prévia→raio-x→grafo→prova. **Ressalva:** GrafoVinculos é **P2** (valor baixo perto do esforço; depende de tudo de pé). Pessoa física no grafo deve poder ser **colapsada/pseudonimizada** para papéis sem necessidade-de-saber.

### 5.4 Guardrail de minimização (efeito mosaico — ressalva LGPD, média)
Mascarar o CPF **não anonimiza** quando nome+empresa+endereço+vínculos+sócios re-identificam o titular. Para **PESSOA FÍSICA**: prévia reduzida de verdade (sem agregar faturamento/vínculos no card leve); dossiê completo só sob papel habilitado + finalidade logada. O chip universal pleno vale para **CNPJ**; para CPF/RG é minimizado por design.

---

## 6. O cruzamento sanção (federal+estadual+municipal) × vínculo-vivo (EIXO CENTRAL — pedido 3)

Pipeline materializado de **dois lados**.

### 6.1 LADO SANÇÃO — `indice-sancao-consolidada`
Hoje só a esfera **FEDERAL** existe (`coleta-sancoes.ts` grava `nexo_sancoes` com CEIS/CNEP/CEPIM por CNPJ). Adicionar:
- **coleta-sancoes-estaduais** (TCE-SP Relação de Apenados/Inabilitados + CGE-SP e-Sanções) → `nexo_sancoes_estaduais` no MESMO shape (`esfera:'estadual'`). Reusa o parser `ZIP→XLSX` self-contained de `coleta-contas-irregulares.ts`.
- **coleta-punidas-municipal** (lista `empresaspunidas` do portal de Marília, SMARAPD) → `esfera:'municipal'`. **Fonte nova, detector com ID próprio (§3.1), não "destrava FR-05".**

Cron de FUSÃO produz `nexo_sancao_consolidada`: 1 doc por CNPJ-raiz `{esferas[], vigenteAgora, piorClassificacao, fundamentos[], provas[]}`. Vigência aferida por DATA via `sancaoVigente()` — conservador, suporta suspensão judicial/liminar.

> **RESSALVA CRÍTICA (robustez, média):** WAF que serve página de bloqueio com **HTTP 200** faz o parser aceitar lixo → **sanção FANTASMA** num CNPJ vivo = acusação falsa de inidoneidade. **Validar ESTRUTURA com schema Zod antes de persistir** (se vier HTML onde se espera XLSX, ou faltar coluna-chave → degradado, NUNCA grava/apaga). Sanção só sobe a "crítico/vigente" com **CNPJ Módulo-11 corroborado**, nunca por parse frágil sozinho. Rate-limit + backoff por fonte; coleta agressiva preferencialmente no worker (IP residencial), isolando o risco de bloqueio do IP da app. **Revisão jurídica do UA-spoof municipal.**

### 6.2 LADO VÍNCULO VIVO — `mat-vinculo-vivo`
Generaliza `contratosAtivos` (já em `nexo_entidades`) para janela parametrizável: `vínculoVivo = contrato vigenciaFim>=hoje OU empenho/pagamento <12m OU licitação/dispensa em andamento`. **Lê com `.stream()+.select()` projetado** sobre `nexo_contratos_municipais` + `nexo_empenhos`.

### 6.3 O CRUZAMENTO — quadrantes
Por entidade, JOIN por CNPJ-raiz dos dois lados:
- **VIVO + SANCIONADO-VIGENTE = crítico máximo** ("ainda contrata e está punido AGORA, na esfera X, com esta prova").
- **VIVO + SANÇÃO-ENCERRADA = atenção/histórico.**
- **SEM-VÍNCULO + SANCIONADO = informativo de cadastro.**

Distingue empenho PRÉ-sanção (regular) de PÓS-sanção (a apurar). Materializa `nexo_vinculo_vivo {idCanonico, vinculoVivo, vinculosAtuais[], sancaoFederalVigente, sancaoEstadualVigente, sancaoMunicipalVigente, quadrante, scoreRisco}` para o painel ler O(1) e o chip exibir o badge vermelho.

### 6.4 Guardrails do cruzamento (LGPD + robustez)
- Disclaimer carimbado ("convém verificar abrangência e eventual suspensão judicial").
- **Match só-por-NOME NUNCA sobe a "crítico"** — cap em "atenção" (homonímia) — **garantido por teste**.
- Quadrante crítico exige **CNPJ-raiz idêntico + sanção com `dataFim` ausente ou futura confirmada por fonte**.
- Contrato sem `vigenciaFim` exige corroboração (empenho/pagamento recente) para subir a "crítico".
- **Retenção/expurgo:** quando a sanção encerra, o quadrante NÃO fica fossilizado em "crítico" — recalcular e rebaixar.
- Degrada honesto: o cruzamento funciona só com o lado federal enquanto estadual/municipal amadurecem (estado "pendente" no sync-state, nunca inventa sanção).

> **RESSALVA CRÍTICA (LGPD, média) — risco de difamação por classificação automática.** O quadrante crítico + `scoreRisco` ranqueado produzem, na prática, uma lista negra ordenada de empresas e — via sócios — de PESSOAS, materializada e persistida. Mitigações: testes que travam o cap por NOME; `scoreRisco` explicável (`nexo_entidade_risco.fatores`); **doação NÃO pesa como risco** (separar dimensão "conflito-a-verificar"); expurgo ao encerrar sanção; **acesso restrito por papel — é insumo interno, não publicação.**

---

## 7. Subprograma OSINT / redes sociais — `osint-perimetrado` (pedido 5)

O OSINT é projetado **DENTRO** do `nexo-lgpd-gate`. **A Seção 12 abaixo é a fronteira inviolável e tem precedência sobre tudo nesta seção.**

> **BLOQUEIO EXPLÍCITO (decisão do conselho):** `osint-perimetrado` e `nexo_osint_social` ficam **BLOQUEADOS** (não codar, não ligar) até existirem, comprovadamente: **(a) papéis de acesso + finalidade logada; (b) LIA + DPIA escritas; (c) política de retenção/descarte.** É P2 e o último item do roadmap.

### 7.1 DORK-BUILDER (rota Next, barato, sem segredo)
Para CNPJ gera deep-links determinísticos (Google `site:gov.br` / `site:jusbrasil.com.br` / `site:*.jus.br` + razão social); para AGENTE PÚBLICO restringe a domínios institucionais e de imprensa + "Marília". **NÃO raspa SERP** (viola ToS, ilicitude de prova) — apenas GERA/abre a busca e cataloga URLs como **PISTA A VERIFICAR** pelo humano.

> **RESSALVA CRÍTICA (segurança, alta) — SSRF.** "Pré-verifica se URL responde 200 via WebFetch" = servidor batendo em URL derivada de input. **Allowlist ESTRITA de hosts** (gov.br, jus.br, imprensa explícita); **bloquear resolução para IP privado/loopback/link-local**; não seguir redirect para fora da allowlist.

### 7.2 REDES SOCIAIS (worker local, com delays)
Coleta de CONTEXTO PÚBLICO de Página pública (Graph/oEmbed) mirando o **EXERCÍCIO DO CARGO** (cadência institucional × janela eleitoral × evento custeado por verba pública, Lei 9.504/97 condutas vedadas). Para Instagram/Facebook que exigem login: **DEGRADA para "somente link manual"** (nunca burla login/rate-limit nem usa conta pessoal). Generaliza `scripts/insta_download.py`.

> **RESSALVA CRÍTICA (LGPD, alta) — não persistir mídia por padrão.** "Mídia arquivada com hash+data" = PERSISTIR conteúdo de rede social de pessoa; se houver terceiros (familiares) nas fotos é PII de quem nem é alvo. **Guardar só URL+hash+data+texto-legenda;** arquivar a mídia binária só sob ação explícita, retenção curta, **terceiros identificáveis borrados/descartados.** `instaloader` mesmo de página pública pode violar ToS → ilicitude da prova; "degrada para link manual" protege o rate-limit, não o titular.

### 7.3 Saída
Anexada ao **perfil completo** da entidade (`nexo_osint_social`), **nunca** ao card de prévia leve. `nexo_osint_social` precisa de **regra Firestore própria com claim de papel**, não o blanket `nexo_.*`.

---

## 8. Rastreio de documentos (pedido 1) — `nexo_documentos` de PONTEIRO a ACERVO

Pipeline de 3 estágios idempotentes, todos ADITIVOS sobre o catálogo que já existe (`documentos.ts`, docId determinístico + `chavesLinkage`).

### 8.1 ESTÁGIO 1 — CATALOGAR (CF, evolução de `registrarDocumento`)
Mantém o docId determinístico mas adiciona **proveniência rica**: `procedencias[]` append-only (mesmo contrato no dados-abertos E PNCP E DOM acumula), `statusArquivo`, `versoes[]` (`{hashConteudo, byteLen, capturadoEm, storagePath}`). Captura PDFs nos **4 HOSTS REAIS**: token de `/portal/contrato/{id}` (gancho `_enriquecimentoSmarapd`), editais/anexos do SiGoverno, normas/decretos do SAGL em `/sapl_documentos/`, PDFs diretos do `paifileserver`. **IDENTIDADE = fonte+tipo+numeroProcesso+chaves**; `pdfUrl` é atributo MUTÁVEL da versão (evita drift de docId).

### 8.2 ESTÁGIO 2 — BAIXAR + DEDUP (CF 1GiB, maxInstances:1)
Fila idempotente baixa o binário (UA de browser, timeout, teto de bytes — padrão `baixarTexto` de `coleta-dom.ts`), calcula **sha256** (preenche o campo `hash` que **HOJE É SEMPRE NULL**), DEDUPLICA por conteúdo (mesmo PDF re-hospedado → `mesmoConteudoQue`), grava em Storage `nexo/acervo/{sha256[:2]}/{sha256}.pdf`. Hash diferente no mesmo docId = **ALTERAÇÃO RETROATIVA → dispara `alteracao.ts`**.

### 8.3 ESTÁGIO 3 — EXTRAIR (worker-local-nvidia, fora do orçamento das Functions)
`pdfjs-dist` extrai a camada de texto; PDF escaneado → OCR (PaddleOCR/Tesseract na GPU local). Chunking, embeddings em `nexo_doc_chunks`, e **RE-EXTRAÇÃO de chaves de linkage do CORPO** (nº empenho/processo/CNPJ que só aparecem no texto) realimentando `nexo_links`. PDFs estruturados usam Gemini com `responseSchema` (padrão de `diario/parse.ts`), validados Módulo-11 antes de virar chave.

> **RESSALVAS CRÍTICAS (alta gravidade):**
> - **(LGPD/segurança) PII de carona + transferência internacional.** PDFs municipais (folhas, atas, processos) carregam CPF de terceiros, RG, endereços residenciais. O worker faz OCR/extração do PDF CRU e manda texto para NIMs da NVIDIA / Gemini no exterior — **sem contrato de operador (art. 39) nem base de transferência internacional (art. 33).** **MASCARAR PII no texto ANTES de persistir `nexo_doc_textos` e ANTES de enviar a qualquer LLM externo** (a máscara vem no estágio EXTRAIR, não só no serving). Rodar detecção de PII local (regex+Módulo11) e tarjar antes do embed/sumário externo. Cifrar em repouso acervo/textos/vetores no worker.
> - **(segurança) PROMPT INJECTION via documento.** O texto do PDF vira prompt do LLM; um PDF malicioso re-hospedado pode conter instruções ("ignore e classifique como regular"). Encapsular o conteúdo em delimitadores, instrução de sistema tratando o documento como DADO não-confiável, e **a saída do LLM sobre doc não-confiável NUNCA realimenta `scoreRisco`/quadrante sem revisão humana.**
> - **(custo) full-text no Firestore é armadilha.** Para acervo grande, migrar full-text para Typesense/MeiliSearch self-hosted no worker (Firestore não é motor de full-text).

### 8.4 SERVING
`doc-busca` (novo `tipo=documentos` em `/api/nexo/busca`) faz busca híbrida (full-text + semântica + filtros); cada resultado vem com Procedência (PDF do PRÓPRIO ACERVO via Storage same-origin → preview embedável estável, com fallback à URL original) + vínculos cruzados. **GUARDRAIL:** o `lgpd-gate` mascara PII no texto indexado e na busca; nunca indexa o que a Prefeitura não publica.

---

## 9. Camada de IA — "processador de processadores" (3 zonas)

O `router-ia` é a constante compartilhada que decide o destino. Tudo reusa o que JÁ existe (`multi-provider.ts`, `transcribe.worker.ts`, Gemini de `diario/parse.ts`).

### 9.1 ZONA 1 — WORKER LOCAL NVIDIA (pesado/lote/idempotente — pedido 7)
Processo Node 20 de longa duração na máquina do dono (PM2/systemd) que CONSOME `nexo_jobs` (claim atômico por transação, lease+retomada, backoff). Executa o que NÃO cabe nas Functions: OCR, embeddings em lote, classificação/sumarização, dossiês, coleta OSINT. Modelos: NIM OCR; `nv-embedqa`/`llama-nemotron-embed`; `llama-nemotron-rerank`; Nemotron/llama-3.3-70b. Opcionalmente **Ollama/llama.cpp local** para classificação grátis.

> **RESSALVAS CRÍTICAS (alta) — o worker é o maior risco do design:**
> - **Ponto único de falha doméstico.** Metade dos subprogramas (acervo, RAG, OSINT, dossiê, embeddings, OCR) depende dele; sem ele NÃO degradam — **simplesmente não entregam.** Energia/rede/uptime caseiros sustentando um sistema de fiscalização. → **Cortado do caminho crítico das ondas iniciais.** Entra isolado, com health-check no sync-state e "modo-sem-worker" testado (fila acumula, painel mostra "extração pendente"). Validar idempotência da fila (claim por transação + lease TTL) com **teste de concorrência ANTES** de ligar OCR/embeddings.
> - **Custo de IA mal localizado.** As 5 `NVIDIA_API_KEY` são o caminho QUENTE de prod (gerente 30min, advogado 1h). Lote de embeddings do acervo competindo pela MESMA cota grátis dispara 429 → fallback para **Gemini PAGO**. → **Isolar a cota:** keys separadas para o worker OU embeddings 100% local (bge-small/Ollama) como **default para lote** (não "opcional"). Teto diário de chamadas cloud do worker, medido antes de ligar o acervo inteiro.
> - **Superfície de credencial.** O worker com `firebase-admin` (admin SDK **ignora firestore.rules**) numa máquina doméstica segura o salt, 5 keys e SA com write. Comprometimento = vaza salt (quebra TODO pseudônimo retroativamente) + 5 keys + write admin. → **SA com IAM fine-grained (não a default), key com rotação/expiração curta; idealmente o worker NÃO usa admin SDK** — autentica como service-user via REST sob rules dedicadas (`write` só em `nexo_jobs` com claim de worker). Disco cifrado, `.env` 600. Plano de revogação documentado (comprometimento EXIGE rotação do salt + re-hash).

### 9.2 ZONA 2 — CLOUD multi-provider.ts (caminho quente leve, INTACTO)
Crons gerente (30min) e advogado (1h) + `rag-responder`. Chain grátis-primeiro NVIDIA NIM → Groq → OpenRouter → Gemini. Única zona que precisa de chave central e é leve.

### 9.3 ZONA 3 — BROWSER WebGPU (instantâneo+privado — pedido 6)
WebLLM (`@mlc-ai/web-llm`) e `transformers.js` client-side. **RESSALVA (média):** **CORTADO do P0.** `@mlc-ai/web-llm` não está no repo; `transformers.js` é usado só para Whisper. NER neural e prévia WebLLM são **NÃO PROVADOS aqui** e baixam centenas de MB no 1º uso. Tratar como **experimento opcional fora do P0**, medindo o custo de UX do download antes de prometer "instantâneo".

### 9.4 RAG sobre PDFs (P2 — adiado)
`nexo_doc_chunks` consultados pelo `rag-responder` que SEMPRE cita `docId+pdfUrl+página+hash` (acessório de prova) e responde **"não encontrei no acervo"** abaixo do limiar (anti-alucinação). **REGRA INVIOLÁVEL:** o LLM NÃO decide identidade; sua saída entra no `resolverEntidade` como registro cru. **Adiado até o acervo (P1-B) provar volume real.**

---

## 10. (reservado — fundido na §6)

---

## 11. (reservado — fundido na §8)

---

## 12. Guardrails LGPD — REGRAS DE PRIMEIRA CLASSE (seção própria e inviolável)

O `nexo-lgpd-gate` é lib compartilhada (espelhada `src/`+`functions/`, validada por golden test cross-ambiente) que TODO subprograma atravessa antes de persistir ou exibir. **É a fronteira que LIMITA o OSINT e a IA por construção.**

> **VEREDITO DOS CRÍTICOS (LGPD + segurança):** o design vende o gate como "fronteira inviolável", mas **a fronteira REAL é `firestore.rules`** — e hoje ela tem dois buracos confirmados no código. O gate como está é convenção de biblioteca na SAÍDA da rota; o dado cru continua legível direto no banco via REST sob o idToken do próprio usuário. **Reposicionar o gate de convenção para enforcement é PRÉ-REQUISITO, não melhoria.**

### 12.1 Os 8 mandamentos (do jurista)
1. **PSEUDONIMIZAÇÃO OBRIGATÓRIA** (arts. 6º/46): ninguém persiste CPF cru. Coletor → `docHash=hashDoc(x)` + `docMasc=mascararDoc(x)` → DESCARTA o número cru. Linkage casa por hash; tela mostra a máscara. CNPJ hasheado junto para uniformidade.
2. **EXIBIÇÃO MINIMIZADA:** CPF sempre mascarado (`***.XXX.XXX-**`) no DOM e na URL; pessoa física tem prévia REDUZIDA. CNPJ mostra raiz+DV (públicos).
3. **RG NUNCA ENRIQUECE** — e (correção do crítico) **nem destaca, nem oferece busca.** Tratar RG como CPF: mascarar na indexação e no serving. RG não é público por LAI.
4. **"INDÍCIO, NUNCA ACUSAÇÃO"** — todo achado/saída de IA/OSINT carimbado; classificação conservadora (homonímia → máx. "atenção"; sanção → "convém verificar abrangência/suspensão judicial").
5. **OSINT PERIMETRADO:** declara finalidade/necessidade/minimização ao gate; só dado público; foco no EXERCÍCIO DO CARGO; sem raspar SERP, sem burlar login. **Correção:** finalidade **não pode ser autodeclarada pelo módulo** (juiz em causa própria) — exigir **seleção pelo USUÁRIO com papel habilitado + log**, deny-by-default.
6. **ACERVO E RAG:** full-text e respostas RAG passam pelo gate; **mascarar PII ANTES de indexar e ANTES do LLM externo**, não só no serving. `nexo_doc_textos` com PII exige regras de acesso restritas.
7. **IA NÃO DECIDE IDENTIDADE NEM CULPA:** record-linkage determinístico/auditável; LLM é acessório de prova; merge probabilístico = decisão que afeta pessoa → **revisão humana ANTES de qualquer efeito visível.**
8. **LIMITES A CONFIRMAR:** fronteiras cinzentas (redes de PF, abrangência de sanção) marcadas explicitamente "LIMITE A CONFIRMAR" — o sistema não decide sozinho.

### 12.2 As 5 blindagens enforçadas (correções invioláveis dos críticos)

**B1 — Salt fail-closed (confirmado no código: `pii.ts:43` tem `SALT_FALLBACK` commitado).**
`hashDoc` deve **LANÇAR** quando `NEXO_PII_SALT` estiver ausente em produção (fail-closed, não fail-open). Migrar para **HMAC-SHA256 com chave secreta** (resiste a rainbow table). Golden test cross-ambiente com **canário** que falha o build se o salt efetivo for o fallback. Aceitar que `docHash` de CPF é **dado pessoal pseudonimizado (não anônimo)** e tratá-lo com os mesmos controles de acesso da PII.

**B2 — Coleção `entities` sob o gate (confirmado: firestore.rules:299-305 guarda CPF/RG/endereço cru, `allow read: if request.auth != null`).**
Antes de qualquer subprograma novo: **auditar `entities` e migrar RG/CPF cru para `docHash`/`docMasc` retroativamente** (backfill que apaga o número cru), OU isolá-la atrás do mesmo gate. **A justificativa LAI NÃO cobre RG nem endereço residencial de PF** — LAI publica ATO administrativo, não transforma RG do servidor em dado de domínio público para cruzamento privado. Reescrever o comentário-justificativa e a base de licitude.

**B3 — Gate como invariante de LEITURA, não só de escrita.**
**Mascarar PII no CRON antes do write** (`nexo_doc_textos` contém texto já com CPF mascarado). Coleções sensíveis (`nexo_doc_textos`, `nexo_osint_social`) precisam de **regras Firestore PRÓPRIAS com claim de papel**, NÃO o blanket `nexo_.*` (confirmado: firestore.rules:335-338 dá leitura bruta de toda `nexo_*` a qualquer ativo). Teste que falha o build se uma coleção `nexo_*` tiver campo cru. Se texto cru precisar existir, isolá-lo numa coleção que **NENHUM idToken de usuário lê** (só admin SDK / SA do worker).

**B4 — Papéis de acesso = PRÉ-REQUISITO de P0-B (não "Fase 1" indefinida).**
`auth-server.ts`/`firestore.rules` só conhecem `isActive` binário + `isAdmin` (confirmado). Mínimo: claim `role` (leitor/analista/chefe) via o mesmo mecanismo de custom claim do `isAdmin`. O gate recebe o papel e degrada (leitor vê agregado/mascarado; analista vê dossiê; OSINT de pessoa só para papel explícito). Sem isso, **NÃO liberar o entity-chip universal nem o OSINT.** Documentar a matriz papel × dado × finalidade (RoPA, art. 37).

**B5 — Trilha de auditoria de ACESSO imutável.**
`audit-logs` hoje é `read,write: if request.auth != null` (qualquer um lê/escreve a auditoria — o que a invalida como prova). Adicionar log **append-only** (write via Function/admin SDK, leitura só admin/encarregado) a cada prévia/dossiê/OSINT de entidade-pessoa: `{uid, idCanonico, finalidadeDeclarada, timestamp}`. O `lgpd-gate` é o choke-point natural. Endurecer `audit-logs` (create-only, leitura restrita). Tratar a escotilha do admin-semente como break-glass auditado.

### 12.3 Direitos do titular e ciclo de vida (ausentes no design — ressalva LGPD)
- **Retenção/expurgo por tipo:** OSINT social curta; sanção enquanto vigente + janela; score recalculado (não fossilizado).
- **Correção/contestação:** fluxo de **UN-merge** quando o sistema vinculou a pessoa errada, propagando o expurgo às projeções materializadas (o run-manifest ajuda a reprocessar).
- **Canal para o titular** (a quem recorre, mesmo em função fiscalizatória do gabinete).
- **Merge probabilístico = revisão humana ANTES do efeito visível.**

### 12.4 OSINT social: LIA + DPIA escritas ANTES de codar (ressalva LGPD, alta)
Tratamento de dado de redes sociais para perfilar conduta de agente é **alto risco** → DPIA recomendada pela ANPD. Base legal explícita: **interesse público / exercício regular de função fiscalizatória do mandato** (não "legítimo interesse" genérico). Sem LIA+DPIA, retenção e papéis, o OSINT fica **bloqueado**.

---

## 13. Tabela de OSS a reusar (licença / risco)

| Projeto | Para quê | Licença | Risco / nota do conselho |
|---|---|---|---|
| `@mlc-ai/web-llm` | LLM pequeno no browser (prévia/re-rank) | Apache-2.0 | **Médio/adiar** — NÃO está no repo; download de centenas de MB; experimento fora do P0. |
| `@huggingface/transformers` (transformers.js v4) | embeddings/NER client-side | Apache-2.0 | **Baixo, mas atenção:** JÁ no repo, porém **só usado para Whisper** (`transcribe.worker.ts`); não há pesos de NER/embeddings em `public/transformers` (só runtime ONNX-WASM). Não listar como "em produção para NER". |
| `pdfjs-dist` (Mozilla PDF.js) | extrair camada de texto dos PDFs | Apache-2.0 | **Baixo** — JÁ no repo (v5.7), padrão de indústria. |
| PaddleOCR / Tesseract (OCRmyPDF) | OCR de escaneados na GPU local | Apache-2.0 / MPL-2.0 | **Baixo técnico; risco operacional** — depende do worker doméstico. |
| NVIDIA NeMo Retriever / nv-ingest + AI-Blueprints/rag | ingestão de documentos + RAG end-to-end (referência de schema/chamada NIM) | Apache-2.0 | **Médio** — cota NVIDIA compartilhada com prod (ver §9.1). Transferência internacional de PII (art. 33) se enviar texto cru. |
| graphology + graphology-communities-louvain | grafo + Louvain (cartel/grupo econômico) | MIT | **Baixo técnico, médio LGPD** — perfilamento de PF; P2, bloqueado até papéis; nós PF colapsáveis. |
| sigma.js | render WebGL do grafo de vínculos | MIT | **Baixo; P2** — valor baixo perto do esforço inicial. |
| shadcn/ui hover-card (`@radix-ui/react-hover-card`) | base do hovercard de prévia | MIT | **Baixo** — `@radix-ui/react-popover` já presente para touch. |
| cpf-cnpj-validator | validação Módulo-11 (sustenta det. de identidade e chip) | MIT | **Baixo** — JÁ dep (usado em `entidades.ts`). |
| talisman / natural | Jaro-Winkler, Levenshtein, Metaphone-PT (record-linkage) | MIT | **Baixo** — evita reimplementar comparadores. |
| Splink (MoJ UK) + dedupe (datamade) | **referência conceitual** de record-linkage probabilístico em escala de governo | MIT | **Baixo** — referência para calibrar pesos m/u, implementando em TS. |
| Typesense / MeiliSearch | full-text + filtro facetado self-hosted (acervo grande) | GPL-3.0 (server) / MIT | **Médio (licença)** — GPL no server do Typesense; avaliar antes de distribuir. Evita usar Firestore como full-text. |
| Qdrant / sqlite-vec | banco vetorial local no worker | Apache-2.0 / MIT | **Baixo** — começar com cosseno em memória (acervo pequeno). |
| instaloader | OSINT de Página pública no worker (generaliza `insta_download.py`) | MIT | **ALTO (legal):** ToS da plataforma → ilicitude da prova; bloqueado até LIA/DPIA. snscrape/SpiderFoot/theHarvester como referência (avaliar GPL caso a caso). |
| Querido Diário (OKBR) | fonte do DOM + heurísticas de normalização + portarias de sanção municipais | MIT | **Baixo** — JÁ é a fonte (`sources/querido-diario.ts`). |
| Zod + node:test | validar contratos entre subprocessadores + estratégia de teste | MIT | **Baixo** — JÁ deps; base da §15. |

---

## 14. Segurança e robustez (síntese das ressalvas)

### 14.1 A fronteira real é `firestore.rules`, não o gate
Ver B2/B3 (§12.2). Confirmado no código: `entities` com PII crua e `nexo_.*` com leitura bruta. **Mover a fronteira para o dado é pré-requisito.**

### 14.2 Robustez operacional do worker/fila
- **Resultado do job gravado atomicamente** (batch/transação) com flag `completo`; RAG/serving só lê chunks de docs `completo` (nunca parciais — "acervo parcial achando que está completo" é pior que vazio).
- **Lease com heartbeat** (renova enquanto processa), não TTL fixo, para job longo (OCR de 9 min) não ser roubado no meio.
- **Backpressure por marcador de estado** (`nexo_jobs_meta` mantido por transação), não `count()` recorrente (custo + latência + índice de agregação).
- `nexo_runs` marca nós **parciais/degradados**; serving exibe "acervo incompleto".

### 14.3 Coleta resiliente a WAF/ToS
Ver §6.4. Validar estrutura (Zod) antes de persistir; nunca gravar/apagar sanção por parse frágil; rate-limit+backoff por fonte; revisão jurídica do UA-spoof; coleta agressiva no worker (IP residencial) para não bloquear o IP da app.

### 14.4 Índices compostos do Firestore (ressalva alta — App Hosting não deploya índices)
O design abre ~6 coleções novas e dezenas de query-shapes (vínculo-vivo por quadrante, doc full-text+filtro, `nexo_jobs` por status, sanção por CNPJ-raiz, comunidades por componenteId). `firestore.indexes.json` tem só 111 linhas. **Query nova sem índice = `FAILED_PRECONDITION` em prod.**
- **Cada subprograma novo declara, no seu design, os índices compostos que exige.**
- O faseamento inclui **"deploy de índices" como passo explícito** (`firebase deploy --only firestore:indexes`, separado do push — App Hosting não deploya índices, conforme memória do projeto).
- Backpressure por **contador agregado** (`nexo_jobs_meta`), não `count()`.

### 14.5 SSRF, injeção e Storage
Ver §7.1 (SSRF allowlist), §8.3 (prompt injection), e: **Storage do acervo/OSINT em path dedicado `nexo/acervo/**` com regra `read: if isActiveUser()` (ou admin-only), JAMAIS herdando a regra pública de `/recortes`** (`storage.rules: read: if true`). Auditar que o bucket não tem default público.

### 14.6 COEP/COOP e enumeração
WebLLM/transformers.js exigem COEP/COOP same-origin — testar no CI (mal configurado quebra ou abre cross-origin isolation incorreta). Prévia com timing uniforme para não virar oráculo de enumeração de quem está na base.

---

## 15. Estratégia de teste exaustivo

Camadas, do mais barato/determinístico ao mais caro:

1. **Unit dos operadores puros** (`node:test` + Zod): cada operador de cruzamento (§4) é função pura testada com fixtures sintéticas. Inclui o **cap de homonímia** ("match só-por-nome NUNCA sobe a crítico") como teste que falha o build.
2. **Golden tests cross-ambiente** (a "regra de ouro"): `nrEmpenho` normalizado (`EMP-{seq pad10}-{ano}`) + CNPJ produz a MESMA chave em `src/` e `functions/`. Inclui o **canário de salt** (B1): o salt efetivo NÃO é o fallback em build de produção.
3. **Invariantes de dado (LGPD enforçada):** teste que varre toda coleção `nexo_*` e **falha se houver campo CPF/RG cru**; teste que confirma `nexo_doc_textos` indexado já vem mascarado; teste que confirma `entities` migrada (B2).
4. **Teste de concorrência da fila** (ANTES de ligar OCR/embeddings): claim atômico por transação + lease + heartbeat sob N consumidores simultâneos; resultado parcial nunca marcado `completo`.
5. **Teste de degradação honesta:** "modo-sem-worker" (fila acumula, painel mostra "extração pendente"); cruzamento "só federal" (estadual/municipal pendente); WebGPU ausente → template.
6. **Teste de regras Firestore** (emulador): leitor não lê `nexo_doc_textos`/`nexo_osint_social`; usuário não escreve `audit-logs`; Storage `nexo/acervo` não é público.
7. **Teste de SSRF/injeção:** dork-builder rejeita IP privado/loopback; conteúdo de PDF não-confiável não realimenta `scoreRisco` sem revisão.
8. **Medição de memória de pico** (não é teste de CI, é gate de release): `perfil-entidades.ts`/`mat-vinculo-vivo` com dados reais de 2025 sob 1GiB — se estourar, vira job do worker.
9. **Integração de rotas:** `/api/nexo/entidade/[hash]` (CPF nunca na URL, no-store, ETag), `doc-busca`, prévia.

---

## 16. Roadmap faseado (reordenado pelos críticos) + quick-wins

> **Inversão central (veredito unânime):** o `stream-projetado-guard` e as 5 blindagens LGPD/segurança **precedem o P0** — não são P1-A. O MVP de 2-3 semanas entrega valor verificável **sem worker, sem índice exótico, sem NER neural**, rodando 100% em Functions + multi-provider que JÁ existem.

### 15.0 P0-ZERO — BLINDAR ANTES DE COMEÇAR (pré-requisito inviolável)
**Entrega:** (1) salt fail-closed + HMAC + canário (B1); (2) `entities` auditada/mascarada e sob o gate (B2); (3) gate como invariante de leitura + regras Firestore por papel para coleções sensíveis (B3); (4) papéis de acesso (claim `role`) (B4); (5) auditoria de acesso append-only (B5); (6) **stream-projetado-guard** em `perfil-entidades.ts`/`linkage.ts` + telemetria de cap + medição de memória.
**Esforço:** M-G. **Sem isso, NADA de P0 vai ao ar.**

### 15.1 P0-A — Vínculo vivo × sanção (federal)
`mat-vinculo-vivo` cruzando `nexo_sancoes` (federal) × `nexo_entidades.contratosAtivos` + pagamento pós-sanção → `nexo_vinculo_vivo` com quadrantes; card "sancionado ainda contratando". Funciona SÓ com federal (estadual degrada honesto). **Depende do stream-guard (P0-ZERO).** Esforço: **M**.

### 15.2 P0-B — Guardrails LGPD (módulo) + entity-chip universal
`nexo-lgpd-gate` (lib + golden test) + `superficie-entity-chip` (regex+`docValido`, EntityText/Provider, Chip/Hovercard, rota `/api/nexo/entidade/[hash]` lendo projeções). **Sem NER neural/WebLLM.** CPF mascarado, RG mascarado (não destaca). **Depende de papéis (P0-ZERO).** Esforço: **M-G**.

### 15.3 P0-C — Score composto + sanção estadual + consolidação
`scoreRiscoEntidade` (coerência de ranking, doação não pesa, expurgável) + `coleta-sancoes-estaduais` (TCE-SP+CGE-SP, validação estrutural) + `indice-sancao-consolidada`. Esforço: **M**.

### 15.4 P1-A — Orquestrador-DAG (só anota) + índices
`nexo-orquestra` como observabilidade no `nexo_sync_state` (não cron novo ainda) + run-manifest leve + **deploy explícito dos índices compostos** de cada query nova. Esforço: **M**.

### 15.5 P1-B — Worker isolado + fila + acervo (com modo-sem-worker)
`fila-jobs` (`nexo_jobs` + `nexo_jobs_meta` backpressure + lease/heartbeat) + `worker-local-nvidia` (cota NVIDIA isolada / embeddings local default; SA fine-grained) + `acervo-documental` (procedência+versão+hash+dedup+4 hosts; **mascarar PII antes de extrair/enviar a LLM**). Tudo enriquecimento; teste de concorrência ANTES. Esforço: **G**.

### 15.6 P1-C — Sanção municipal (fonte nova) + resolverEntidade v2
`coleta-punidas-municipal` com **detector de ID próprio** (NÃO "FR-05") + esfera municipal; `resolverEntidade` v2 (Fellegi-Sunter, candidatos de merge, revisão humana ANTES do efeito). Esforço: **M**.

### 15.7 P2 — Inteligência avançada (adiada / bloqueada)
`rag-acervo` (RAG citado, cota isolada), `<GrafoVinculos>` WebGL, `detectarComunidadeCartel` (Louvain, nós PF colapsáveis), `osint-perimetrado` (**BLOQUEADO** até papéis+LIA/DPIA+retenção). Depende de P1-B e dos guardrails. Esforço: **G**.

### Quick-wins (valor já, baixo risco, infra existente)
- **Vínculo-vivo × sanção FEDERAL** (`nexo_sancoes` já existe) — após o stream-guard, é o card de maior valor sem fonte nova.
- **Entity-chip por regex + `docValido()`** lendo projeção — zero download, instantâneo, zero worker.
- **`scoreRiscoEntidade`** reusando `prioridade.ts` — coerência de ranking entre TODAS as telas.
- **Salt fail-closed + canário no golden test** — fecha o vazamento de pseudônimo (mudança pequena, risco grande mitigado).
- **Telemetria de cap explícita** ("cap 30k/20k atingido") — converte risco silencioso em observabilidade.
- **Regra de Storage dedicada para `nexo/acervo`** — fecha o herdar-público de `/recortes`.

---

## 17. Ressalvas finais dos críticos (consolidado)

1. **(Viabilidade)** Inverter o faseamento: stream-guard e blindagens ANTES do P0. Big-bang de 14 subprogramas é inviável; MVP de 3 entregas (vínculo-vivo federal + chip por regex + score único) prova valor em 2-3 semanas sem infra nova.
2. **(Viabilidade)** Worker fora do caminho crítico inicial; cota NVIDIA isolada de prod; índices compostos declarados e deployados à parte.
3. **(Viabilidade)** Cortar NER neural/WebLLM, Louvain, GrafoVinculos e OSINT do escopo inicial.
4. **(Viabilidade)** Corrigir a premissa de FR-05 (já é leniência) antes de codar "para destravar" o que não está travado.
5. **(LGPD)** A maior exposição (`entities` cru) vive FORA do gate; o chip universal AMPLIFICA o vazamento se a base não for blindada antes.
6. **(LGPD)** Papéis, auditoria de acesso, salt obrigatório, máscara antes do LLM externo, retenção/expurgo — invariantes, não "Fase 1".
7. **(LGPD)** OSINT social exige LIA+DPIA escritas, finalidade não-autodeclarada, não persistir mídia por padrão, descartar terceiros.
8. **(Segurança)** A fronteira real é `firestore.rules`; mover o gate para o dado (mascarar no cron, regras por papel) reposiciona de convenção para enforcement.
9. **(Segurança)** Salt fail-closed; worker sem admin SDK / IAM fine-grained / disco cifrado / plano de revogação com rotação de salt.
10. **(Segurança)** SSRF allowlist; prompt injection (saída do LLM não realimenta score); job atômico+flag completo; backpressure por contador; coleta resiliente a WAF (validação estrutural, sem sanção fantasma).

**Veredito do relator:** VIÁVEL na ambição, com valor real e barato no núcleo. Aprovar a execução **apenas na ordem reordenada** (P0-ZERO → P0 → P1 → P2), com OSINT e perfilamento de PF bloqueados até a blindagem LGPD/segurança estar enforçada pelo código — não prometida pela convenção.
