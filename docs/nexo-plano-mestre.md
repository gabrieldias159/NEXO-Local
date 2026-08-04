# NEXO — Plano-Mestre

### Núcleo de Enfrentamento e Inteligência Pública

**Câmara Municipal de Marília/SP — Gabinete Vereador Fefin**
Documento de planejamento **v1.5** · revisado em 2026-05-22

> v1.5 fecha o catálogo: **os 172 monitoramentos têm detector codado e
> registrado no motor** — **102 rodando sobre dados reais** do portal, os
> demais com a lógica pronta, aguardando a coleta da fonte específica (e-SIC,
> almoxarifado, frota, julgados do TCE-SP). v1.4 trouxe as integrações PNCP,
> sanções federais CEIS/CNEP/CEPIM e TCE-SP. v1.3 materializou os 172 como
> dado estruturado e abriu os subsistemas Receita, Convênios & 3º Setor e
> Sinais do Diário Oficial. v1.2 registrou a implementação das Fases 0-1.
> v1.1 consolidou a revisão do complexo de inteligência (agentes ORÁCULO,
> VÉRTEX, PRISMA, LASTRO, FANTASMA). O detalhamento vive nos cinco anexos em
> `docs/nexo/` — ver §0. Histórico completo no changelog ao final.

---

## 0. O que é o NEXO

NEXO é um módulo interno do `oficioexpress` que funciona como uma **sala de
situação de fiscalização parlamentar**. Ao acionar o item de menu, abre-se uma
interface própria ("war room"), com layout, navegação e identidade visual
separados do resto do app — pensada para concentrar coleta, cruzamento,
detecção de anomalias e produção de dossiês sobre a gestão municipal.

O nome resume a função: **criar nexo** — ligar dados públicos dispersos
(licitação → contrato → empenho → liquidação → pagamento → execução) em uma
linha do tempo auditável, para identificar padrões de risco antes que
desapareçam.

> **Frase-guia:** transformar dados públicos dispersos em uma linha do tempo
> auditável da gestão municipal, cruzando planejamento, contratação e
> execução, para identificar padrões de risco.
>
> **Regra de ouro:** toda suspeita nasce de dado, documento, comparação e
> repetição — nunca de opinião.

### Decisões de escopo (travadas)

| Decisão | Escolha |
|---|---|
| Codinome / rota | **NEXO** · `/nexo` |
| Escopo de entrega | **Completo** — todas as fases são compromisso |
| Diário Oficial | permanece também na sidebar principal |
| Empresas Sancionadas | **migra** para dentro do NEXO |
| Alvo de investigação | **exclusivamente a Prefeitura Municipal de Marília/SP** (IBGE 3529005) |

### Alvo único de investigação

O NEXO investiga **um só alvo: a Prefeitura Municipal de Marília/SP**. As
fontes nacionais e estaduais do §3 (SICONFI, PNCP, TCE-SP, CEIS/CNEP, TSE,
BrasilAPI…) **não ampliam o alvo** — são sempre consultadas **filtradas a
Marília**: o município de código IBGE 3529005, o órgão "Prefeitura de
Marília", os fornecedores que contrataram com Marília e os mandatos locais.
Se um fornecedor de Marília também aparecer em outra cidade, esse dado é
usado apenas como **contexto do contrato firmado em Marília** (inclusive é
uma red flag — "mesma empresa em várias cidades") — nunca para investigar a
outra cidade. Nenhuma outra prefeitura é monitorada.

### Documentos anexos (detalhamento)

| Anexo | Conteúdo | Autor |
|---|---|---|
| `docs/nexo/01-fontes-de-dados.md` | 25 fontes públicas validadas | FANTASMA |
| `docs/nexo/02-catalogo-de-monitoramentos.md` | 172 monitoramentos em 14 áreas | VÉRTEX |
| `docs/nexo/03-insights-e-correlacoes.md` | grafo, resolução de entidades, modelos | PRISMA |
| `docs/nexo/04-requerimentos-e-achados.md` | requerimentos-modelo R01–R12 + briefing | LASTRO |
| `docs/nexo/05-revisao-do-plano.md` | revisão crítica + 20 features | ORÁCULO |
| `docs/nexo-equipe.md` | charter do complexo de inteligência | — |

Este plano-mestre é a **espinha**; os anexos são a **carne**.

---

## 1. Origem do conhecimento de detecção

O catálogo de detectores destila duas fontes.

**1.1 Transcrições do advogado** (`docs/transcricoes_advogado.md`)
Conteúdo de **Alessandro Calil**, ex-auditor do TCE-SP, que produz vídeos de
"blindagem do gestor público". O material é, na prática, **o manual do
investigador contado pelo lado da defesa**: cada vídeo explica como o
TCE/PF/MP flagra o gestor. Invertendo o sinal, tudo que ele ensina a evitar
vira aquilo que o NEXO caça. Padrões extraídos:

- **Os 3 primeiros lugares que a PF olha:** combustível (frota × consumo ×
  km), terceirizados (servidor fantasma, folha inflada), almoxarifado da
  saúde (nota fiscal diz que entrou, paciente sai sem remédio).
- **Fracionamento:** sequências de contratações logo abaixo do limite de
  dispensa, mesmo objeto/fornecedor/período.
- **3 sinais de edital direcionado:** exigência técnica sob medida; orçamento
  alinhado (empresas de fachada na pesquisa de preços); competição figurativa.
- **4 movimentos do superfaturamento de obra:** preço item a item vs.
  SINAPI/SICRO; edital sob medida; medição física ≠ valor pago; aditivos em
  cadeia.
- **"Trenzinho da alegria":** diária sem relatório/comprovante/resultado.
- **"Farra dos shows" — 5 sinais:** cidade pequena + cachê gigante; emenda
  surgida do nada; inexigibilidade frágil; intermediária recém-criada; palco
  que vira palanque.
- **Carona/ata de registro de preços; "cadê o dinheiro" (saldo contábil ≠
  extrato); nepotismo; publicidade institucional com promoção pessoal.**

**1.2 Documentos técnicos** — `transparencia-api-reference.md` (API SMARAPD),
`transparencia-anomalias-arquitetura.md` (arquitetura v1.0, 38 detectores),
`transparencia-analise-preliminar.md` (achados 2026), `modulo_investiga.md`
(score triplo). Substituídos/expandidos pelos anexos `docs/nexo/`.

> **⚠ Correção v1.1 — limites de dispensa.** Os limites do art. 75 da Lei
> 14.133/2021 são atualizados por **decreto federal anual**. Para **2026**, o
> **Decreto 12.807/2025** fixou **R$ 65.492,11** (compras e serviços comuns)
> e **R$ 130.984,20** (obras e serviços de engenharia). As transcrições
> citavam R$ 62.725,59 / R$ 125.451,15 — desatualizado. **A fonte
> autoritativa é o decreto.** O sistema usa uma **tabela de limites por
> exercício**, alimentada dos decretos federais — nunca uma constante
> digitada à mão (este é o anti-padrão que produz falso positivo e negativo
> no detector de fracionamento).

---

## 2. Princípios inegociáveis

1. **Indício, nunca acusação.** Toda saída usa "possível indício",
   "inconsistência documental", "requer apuração". Jamais "houve
   corrupção/fraude/improbidade".
2. **Rastro probatório.** Todo dado guarda fonte, URL, data/hora de coleta e
   hash. Sem isso, não vira evidência.
3. **Revisão humana obrigatória** antes de qualquer dossiê ou requerimento.
4. **LGPD.** Dados pessoais mascarados na origem; uso restrito à finalidade
   de fiscalização (finalidade, necessidade, minimização).
5. **Apenas dados públicos** ou legalmente acessíveis.
6. **Disclaimer** em todo relatório exportado (texto ao final do documento).
7. **Explicabilidade.** Todo score é decomponível em fatores legíveis — o
   sistema sempre mostra *por que* sinalizou. Nenhum número opaco.

---

## 3. Mapa de fontes de dados

FANTASMA validou **25 fontes** (catálogo completo + testes de endpoint no
anexo `01-fontes-de-dados.md`). Resumo por tier:

### Tier A — Confirmado e pronto (APIs públicas, sem scraping)

| Fonte | Uso | Nota |
|---|---|---|
| API SMARAPD `/paiportalserver/` | 17 módulos (empenhos, folha, diárias, despesas…) | exige header `User-Agent` |
| SICONFI/STN | RREO, RGF, DCA — histórico fiscal (IBGE 3529005) | base do monitor de metas |
| **PNCP** | edital → contrato → vigência → aditivo | preenche o elo que o SMARAPD não tem |
| **CEIS/CNEP/CEPIM** (Transparência Federal/CGU) | inidôneos — **tem API oficial** (token grátis) | não é scraping |
| **TCE-SP / AUDESP** | validação cruzada do que a Prefeitura declara ao Tribunal | API + cubo Fase IV |
| BrasilAPI / CNPJ.ws | razão social, CNAE, sócios, abertura, UF | enriquecimento |
| TSE Dados Abertos | doações de campanha, candidatos, bens | desbloqueia cruzamento doador→vencedor |
| IBGE | população, referências | — |

### Tier B — Site da Prefeitura e correlatos (scraping HTML/PDF)

Editais `marilia.sp.gov.br/portal/editais/1` · Contratos `/portal/contratos`
· Obras `/portal/obras` · Diário Oficial (✅ integrado) · Legislação
`legislacao.marilia.sp.gov.br` · site da Câmara · IPREMM (previdência).

### Tier C — Coleta ativa e referência

- **e-SIC / Ouvidoria / 1Doc** — não é só leitura: vira **instrumento de
  coleta ativa**. Onde não há dado público (ex.: km/consumo por veículo), o
  NEXO gera automaticamente um pedido e-SIC.
- FNDE/PNAE (merenda), DATASUS/SIOPS (saúde), Banco de Preços em Saúde,
  SINAPI/SICRO (referência de preço de obra).

### Mudanças de tier desde a v1.0

- **PNCP, TCE-SP e CEIS/CNEP/CEPIM sobem para Fase 1** — são APIs limpas;
  adiá-las custa caro.
- **Cloud Run Jobs devem rodar em `southamerica-east1`** — o PNCP retorna 403
  fora do Brasil.
- **Divergência entre fontes vira detector próprio** — vários números agora
  têm 3+ fontes independentes (ex.: mínimo de saúde = SMARAPD LRF + SICONFI +
  SIOPS). Quando discordam, isso é um indício.
- **Ação do gabinete:** criar conta gov.br (token CGU) e solicitar acesso ao
  Banco de Preços em Saúde.

> **⚠ Dívida técnica #1:** `src/lib/transparencia/smarapd-client.ts` sonda
> URLs erradas **e** não envia `User-Agent` — sem o header a API responde
> HTTP 400. Reescrever contra `/paiportalserver/` com `User-Agent` + `Referer`.

---

## 4. Arquitetura técnica

### 4.1 Camadas

```
[0]   Coleta            → conectores por fonte
[1]   Snapshot          → cópia bruta + hash + URL + timestamp (prova)
[1.5] Diff temporal     → compara versões: o que mudou, surgiu, sumiu
[2]   Normalização      → ETL com schemas Zod
[2.5] Resolução de      → dedup e ligação de entidades (fornecedor,
      entidades            servidor, órgão) — camada própria
[3]   Indexação         → Firestore + índices compostos
[4]   Detecção          → processadores / motor de regras
[5]   Scoring           → 3 indicadores + explicabilidade
[6]   Correlação        → grafo cross-source (G01–G10)
[7]   UI + Alertas      → sala de situação + dossiês + requerimentos
```

As camadas **[1.5] Diff temporal** e **[2.5] Resolução de entidades** são
novas na v1.1 e centrais: sem diff, a "linha do tempo auditável" não existe e
não há re-detecção incremental barata; sem resolução de entidades,
fracionamento entre secretarias, grafo e o caso "HU com 3 CNPJs" não
funcionam.

### 4.2 Distribuição de cargas

| Carga | Onde roda |
|---|---|
| Coleta SMARAPD / PNCP / TCE (paginação longa) | Cloud Run Job (cron, `southamerica-east1`) |
| Re-detecção em lote · correlator de grafo | Cloud Run Job |
| Detecção incremental por evento | Cloud Functions Gen2 (trigger) |
| Consulta CNPJ on-demand | Next.js API route (`runtime = 'nodejs'`) |

Lembrete: Cloud Functions, `firestore.rules` e `firestore.indexes.json`
**não** sobem com o App Hosting — exigem `firebase deploy --only …` manual.

### 4.3 Estrutura de rotas (`/nexo`)

```
/nexo                         → Painel de Situação
/nexo/briefing                → Digest de assessoria (o "o que está errado")
/nexo/coleta                  → status dos conectores + snapshots + diffs
/nexo/investigacoes[/id]      → pipeline alerta → investigação → dossiê
/nexo/fornecedores[/cnpj]     → perfil + timeline + grafo
/nexo/contratos[/id]          → contratos, licitações, aditivos
/nexo/obras                   → obras + medições
/nexo/metas-fiscais           → metas fiscais e orçamentárias (atual + histórico)
/nexo/folha                   → auditoria de folha e terceirizados
/nexo/receita                 → receita, arrecadação e renúncia (RC)
/nexo/contratos-pncp          → contratos da Prefeitura no PNCP (LC-19, LC-20)
/nexo/convenios               → convênios, subvenções e 3º setor (TS)
/nexo/sancoes                 → sanções federais CEIS/CNEP/CEPIM (FR-04)
/nexo/tce                     → cruzamento com o TCE-SP (XS-14)
/nexo/diario-sinais           → sinais e detectores do Diário Oficial (DO)
/nexo/diario-oficial          → DOM indexado
/nexo/empresas-sancionadas    → subsistema migrado
/nexo/processadores           → config + execução dos motores
/nexo/dossies                 → relatórios + integração com requerimentos
```

Layout próprio em `src/app/nexo/layout.tsx`; componentes em
`src/components/nexo/`; lógica em `src/lib/nexo/`.

---

## 5. Modelo de dados (Firestore)

ID determinístico `sha1(fonte+chaveNatural)`; todo doc carrega
`_meta: { fonte, coletadoEm, hashConteudo, versaoSchema }`.

| Coleção | Conteúdo |
|---|---|
| `nexo_raw_{fonte}` | snapshots brutos (reprocessar sem rebuscar) |
| `nexo_snapshots_diff` | resultado da camada de diff temporal |
| `nexo_entidades` | entidades resolvidas (fornecedor, servidor, órgão) |
| `nexo_merges_log` | log auditável e reversível das fusões de entidade |
| `nexo_empenhos` | empenhos + liquidações + pagamentos |
| `nexo_contratos` | contratos, aditivos, empenhos vinculados (PNCP) |
| `nexo_fornecedores` | 2 níveis: `EmpresaGrupo` (CNPJ raiz) + `Estabelecimento` |
| `nexo_diarias` · `nexo_folha` · `nexo_obras` | dados por domínio |
| `nexo_indicadores_fiscais` | metas fiscais por exercício e período (atual + histórico) |
| `nexo_grafo_nos` · `nexo_grafo_arestas` | grafo de correlações |
| `nexo_alertas` · `nexo_investigacoes` | pipeline de detecção |
| `nexo_briefings` | digests de assessoria gerados |
| `nexo_auditoria` | trilha append-only de ações dentro do NEXO |
| `nexo_sync_state` · `nexo_detector_runs` | operação dos conectores/detectores |

Fornecedor em **dois níveis** resolve o caso HU (3 filiais, R$ 6,8M somados)
e permite ver fracionamento por filial.

---

## 6. Monitoramentos, processadores e grafo

VÉRTEX consolidou **172 monitoramentos em 14 áreas**, cada um com ID, regra,
limiares, fonte, severidade e fundamento legal — catálogo completo no anexo
`02-catalogo-de-monitoramentos.md` e materializado como dado estruturado em
`src/lib/nexo/catalogo-completo.ts`, onde cada item carrega um status honesto:
**ativo** (detector rodando sobre dados reais), **computável** (regra pronta,
aguardando ligação no painel) ou **planejado** (depende de fonte ainda sem
API pública — frota km/consumo, almoxarifado, medições de obra, cubo TCE-SP).

**14 áreas** (esquema de ID unificado por prefixo): Licitações/compras `LC`,
Obras `OB`, Fornecedores & contratos `FC`, Saúde/almoxarifado `SA`,
Emergenciais `EM`, Diárias/eventos/publicidade `DE`, Frota `FR`*,
Folha/terceirizados `FP`, Execução orçamentária `OR`, Metas fiscais/LRF `MF`,
Diário Oficial `DO`, Convênios/terceiro setor `TS`, Receita e renúncia `RC`,
Cruzamentos cross-source `XS`.

### Os 6 processadores
P1 Fracionamento · P2 Obras/sobrepreço/medições/aditivos · P3 Frota e
combustível · P4 Saúde/almoxarifado/entregas · P5 Contratos emergenciais ·
P6 Diárias/eventos/shows/publicidade.

\* **Ajuste do P3:** não há fonte pública de km/consumo por veículo. P3 vira
**semi-manual** — flagra o gasto agregado de combustível e gera
automaticamente um pedido e-SIC para obter os dados de detalhe.

### Subsistema de Metas Fiscais & Orçamentárias (monitoramento contínuo)

Cumprir metas fiscais e limites constitucionais é **obrigação inegociável** —
e, segundo o advogado, a causa nº 1 de rejeição de contas não é desvio, é
estouro de limite ou perda de prazo. Monitora, no **exercício atual e em
série histórica**:

| Indicador | Limite / meta | Fundamento |
|---|---|---|
| Aplicação em Saúde | ≥ 15% das receitas de impostos | EC 29 · LC 141/2012 |
| Aplicação em Educação (MDE) | ≥ 25% das receitas de impostos | CF art. 212 |
| FUNDEB — magistério | ≥ 70% | CF art. 212-A |
| Despesa com pessoal — Executivo | ≤ 54% da RCL (prudencial 51,3% · alerta 48,6%) | LRF art. 19–20 |
| Despesa com pessoal — Câmara | ≤ 6% da RCL | LRF art. 20 |
| Dívida consolidada líquida | ≤ 120% da RCL | Res. Senado 40/2001 |
| Resultado primário e nominal | meta do Anexo de Metas Fiscais da LDO | LRF art. 4º |
| Restos a pagar | ≤ disponibilidade de caixa | LRF art. 42 |
| Publicação de RREO/RGF | dentro do prazo legal | LRF art. 52 e 55 |

Fontes: SICONFI/STN (histórico), visões fixas LRF do SMARAPD (corrente), LDO.
Saída: medidores do ano atual + tendência plurianual + **rastreador de
prazos** + alerta ao ultrapassar limite ou faixa prudencial. Depende de API
limpa — **entregue já na Fase 0** como prova de vida.

### Grafo de correlações

PRISMA desenhou **13 tipos de nó** e **~18 de aresta** (factuais vs.
derivadas), com **10 consultas de alto valor `G01–G10`** — sócio comum entre
concorrentes, autocontratação, doador→vencedor, servidor↔fornecedor, empresa
que migra entre secretarias, anel de fachadas, etc. Viável em Firestore
(`nexo_grafo_*`), sem banco de grafo dedicado. Detalhe no anexo 03.

---

## 7. Scoring e ciclo alerta → investigação

Três indicadores **separados** (0–100), com explicabilidade obrigatória:

1. **Confiabilidade documental** — força da prova: documento oficial, fonte
   primária, URL, hash, data, corroboração.
2. **Probabilidade de irregularidade** — quanto o padrão destoa da
   normalidade: repetição, valor atípico, mesmo fornecedor, ausência de
   justificativa, divergência entre fontes, proximidade de limite legal.
3. **Aderência a elementos objetivos da norma** — *(renomeado na v1.1; antes
   "probabilidade de enquadramento legal").* Apresentado como **checklist**
   de elementos presentes/ausentes (conduta, agente, ato, valor, dano
   potencial, violação de rito), **nunca como % de ilícito**. Um score
   "85% de improbidade" seria munição contra o próprio gabinete.

**Doutrina anti-falso-positivo** (PRISMA): lista de exceções versionada;
normalização por pares com mediana/MAD; fator-justificativa que abate o
score; trava por `confiancaResolucao` de entidade; feedback loop de
calibração (gabinete marca útil/inútil).

**Um alerta vira investigação quando:**
```
confiabilidade ≥ 70  E  probabilidade_irregularidade ≥ 60
E ( ≥2 fontes independentes  OU  valor relevante  OU  repetição do padrão )
```
Classificação visual: informativo (0–24), atenção (25–49), suspeita (50–74),
crítico (75–100, dispara notificação).

---

## 8. Coleta agendada (cron)

| Job | Frequência | Fonte |
|---|---|---|
| `nexo_sync_despesas` / `_empenhos` | diário | SMARAPD |
| `nexo_sync_pncp` | diário | PNCP |
| `nexo_sync_receita` | semanal | SMARAPD receitas |
| `nexo_sync_diarias` | semanal | SMARAPD |
| `nexo_sync_folha` | mensal | SMARAPD |
| `nexo_sync_dom` | dias úteis | Diário Oficial |
| `nexo_sync_editais_obras` | diário | site da Prefeitura |
| `nexo_sync_siconfi` / `_tce` | quinzenal | SICONFI · TCE-SP |
| `nexo_enrich_cnpj` | a cada 6h (fila) | BrasilAPI · CEIS/CNEP |
| `nexo_detectores_batch` · `_correlator_grafo` | diário | processadores · grafo |
| `nexo_briefing_periodico` | diário/semanal | digest de assessoria |

Rate limiting de saída por host.

---

## 9. Saída: dossiês, requerimentos e assessoria

Cada investigação gera um **dossiê**: título, resumo, linha do tempo,
envolvidos, fontes, evidências, lacunas documentais, os 3 indicadores,
checklist normativo, perguntas para fiscalização e minuta de requerimento.

### 9.1 Catálogo de requerimentos-modelo (R01–R12)

LASTRO produziu **12 requerimentos-modelo**, um por família de achado
(fracionamento, sobrepreço de obra, combustível, medicamento sem entrega,
emergencial repetido, show por inexigibilidade, diária mal prestada,
fornecedor de outra UF, inexigibilidade elevada, nepotismo, estouro de limite
fiscal, divergência DOM × Portal). Cada modelo traz fundamento legal,
documentos a solicitar, perguntas objetivas e texto-base com campos
preenchíveis pelo NEXO. Catálogo completo no anexo 04.

Cada detector aponta para o seu `R0x`. O botão "Gerar requerimento" abre o
editor do `oficioexpress` pré-preenchido, com vínculo bidirecional
investigação ↔ requerimento. **O prazo de resposta do requerimento é objeto
de primeira classe:** requerimento vencido sem resposta vira alerta
automático.

### 9.2 Briefing de assessoria

O usuário quer "ser assessorado do que está acontecendo de errado na coisa
pública". O NEXO entrega isso pela rota `/nexo/briefing`: um digest periódico
(diário/semanal/mensal/exceção) que resume e prioriza os indícios em
linguagem direta — sempre como indício a apurar. Coleção `nexo_briefings`,
job `nexo_briefing_periodico`; redação assistida por Claude API na Fase 3.

---

## 10. Features (visão de produto)

ORÁCULO catalogou 20 features (anexo 05). As 8 prioritárias por valor ×
esforço:

| # | Feature | Valor | Esforço |
|---|---|---|---|
| F4 | Trilha de auditoria do NEXO (`nexo_auditoria`) | alto | baixo |
| F3 | Tabela viva de prazos legais | alto | baixo |
| F6 | Watchlist de entidades (acompanhar fornecedor/órgão) | alto | baixo |
| F1 | Digest do ORÁCULO / briefing de assessoria | alto | médio |
| F8 | Camada de agregados (consultas rápidas no painel) | alto | médio |
| F2 | Notificações multicanal com digest | alto | médio |
| F5 | Exportação de dossiê PDF com cadeia de evidências | alto | médio |
| F18 | Modo conduta vedada eleitoral (ativo em 2026) | alto | médio |

Outras catalogadas: ciclo pós-protocolo, comparação plurianual,
acompanhamento por secretaria, copiloto conversacional, visualização de
grafo, modo cidadão (transparência pública), busca semântica.

---

## 11. Roadmap (escopo Completo — todas as fases são compromisso)

### Fase 0 — Fundação + prova de vida
- Reescrever o client SMARAPD (`/paiportalserver/` + `User-Agent`/`Referer`).
- Layout e shell de `/nexo`; item de menu na sidebar principal.
- Schemas Zod, coleções `nexo_*`, `rules`, índices.
- Conectores de coleta SMARAPD + snapshots + **camada de diff** + **resolução
  de entidades**.
- **Subsistema de Metas Fiscais via SICONFI + rastreador de prazos** — prova
  de vida visível e barata, sem scraping.
- Migrar Empresas Sancionadas para `/nexo/empresas-sancionadas`.

### Fase 1 — Detecção núcleo
- Os 6 processadores + os 42 quick wins do catálogo.
- Score triplo + explicabilidade + ciclo alerta → investigação.
- Painel de Situação, investigações, dossiês.
- **PNCP + TCE-SP + CEIS/CNEP/CEPIM** (APIs limpas, promovidas da Fase 2).
- Enriquecimento CNPJ; cruzamento DOM × Portal.
- Catálogo de requerimentos R01–R12 + integração com Requerimentos.
- Briefing de assessoria (`/nexo/briefing`).

### Fase 2 — Profundidade
- Folha/terceirizados; obras + medições; scraping de editais.
- Grafo completo G01–G10; TSE × contratos; folha × CNPJ.
- Subsistemas de Previdência (IPREMM/RPPS) e Educação/merenda (FNDE/PNAE).
- Conector de e-SIC/Ouvidoria como coleta ativa.

### Fase 3 — Referências de preço + IA
- SINAPI/SICRO/Banco de Preços para sobrepreço.
- Claude API: dossiês, minutas de requerimento e briefing (prompt caching).
- RAG sobre jurisprudência TCE-SP + normas SAPL.
- Feedback loop de calibração de detectores.

---

## 12. Backlog inicial (Fase 0)

1. Reescrever `smarapd-client.ts` → `src/lib/nexo/sources/smarapd.ts` com
   `User-Agent` + `Referer` (não basta corrigir a URL).
2. Validar os 17 módulos com `POST /modulovisao/filter` reais.
3. Schemas Zod das coleções `nexo_*`.
4. `firestore.rules` (por papel) + `firestore.indexes.json`.
5. Job de coleta `DespesaAgrupada` + snapshot + camada de diff.
6. `src/app/nexo/layout.tsx` + shell de navegação + item de menu.
7. Tabela de limites de dispensa por exercício, alimentada dos decretos
   federais (Decreto 12.807/2025 para 2026).
8. Migrar a página de Empresas Sancionadas para dentro do `/nexo`.
9. Conector SICONFI + painel de Metas Fiscais (prova de vida).
10. Confirmar os artigos da **Lei Orgânica de Marília** e do **Regimento
    Interno da Câmara** que fundamentam os requerimentos (os modelos R01–R12
    deixam o artigo em aberto de propósito).
11. Definir papéis de usuário (Leitor / Analista / Chefe-Vereador) e a
    coleção `nexo_auditoria` append-only.

---

## 13. Governança, segurança e risco

- **Papéis de acesso:** Leitor, Analista, Chefe-Vereador. `firestore.rules`
  por papel; a "revisão humana obrigatória" tem dono explícito (Analista
  promove, Chefe aprova). Toda ação relevante grava em `nexo_auditoria`.
- **LGPD:** base legal escrita; mascaramento de dado pessoal na origem;
  política de retenção; folha individualizada com acesso restrito.
- **Risco eleitoral 2026.** 2026 é ano de eleição municipal. O NEXO é
  ferramenta **institucional de fiscalização**, não peça de campanha: uso
  interno, linguagem de indício, disclaimer em toda saída, nada de conclusão
  pública sem apuração. O "Modo conduta vedada" (F18) monitora o Executivo —
  e o mesmo rigor se aplica ao uso do próprio sistema.
- **Riscos técnicos:** API SMARAPD sem SLA (mitigação: snapshots + cursores);
  scraping frágil (conectores isolados); PNCP com geo-bloqueio
  (`southamerica-east1`); filtro server-side da API dá 400 → varredura
  completa, dimensionar custo de coleta e de leitura do Firestore.
- **Falso positivo:** risco reputacional — mitigado pela doutrina
  anti-falso-positivo (§7), 3 indicadores e revisão humana.
- **Deploy:** `rules`/`indexes`/`functions` exigem deploy manual separado.

---

## Disclaimer obrigatório (rodapé do sistema e de todo relatório)

> Este sistema processa dados públicos e identifica padrões estatisticamente
> atípicos que podem (ou não) indicar irregularidades. Nenhuma informação
> aqui constitui acusação, prova de improbidade ou de ilícito. Os indícios
> devem ser investigados pelas instituições competentes (TCE-SP, Ministério
> Público, Controladoria) antes de qualquer juízo de valor.

---

## Changelog

**v1.5 (2026-05-22)** — catálogo fechado: 172 detectores codados.
- **Os 172 monitoramentos das 14 áreas têm detector implementado** e
  registrado no motor (`src/lib/nexo/detectores/*-cat.ts`, 7 arquivos novos
  cobrindo LC, OB, FC, SA, EM, DE, FP, OR, MF, FR, TS, XS, RC).
- **102 detectores rodam sobre dados reais** do portal (eram 70) — alguns por
  proxy conservador, sempre declarado na `explicacao` do alerta.
- Os **70 restantes** têm a lógica de detecção pronta mas degradam para vazio
  até a fonte específica ser coletada: diário de bordo da frota (km/litro),
  almoxarifado da saúde (entrada/saída de estoque), planilha e medições de
  obra, folha individualizada, grafo societário, texto do DOM, julgados do
  TCE-SP, e-SIC. Nenhum inventa dado nem gera falso positivo — retornam `[]`
  com a fonte ausente nomeada em comentário.
- Registry: 141 detectores no runner `rodarDetectores` (pipeline da rota
  `/api/nexo/analise`) + os demais em rotas dedicadas (Diário Oficial, Metas
  Fiscais, Convênios, Receita, PNCP, Sanções, TCE-SP).
- Estado do catálogo: **102 ativo · 4 computável · 66 planejado**.
- O runner isola falha de detector individual e registra em log — uma exceção
  num detector não derruba a análise.

**v1.4 (2026-05-22)** — 70 detectores ativos + integrações externas.
- **70 dos 172 monitoramentos ativos** sobre dados reais (eram ~45): novos
  detectores computáveis de Execução orçamentária (OR-01/02/04/05/10),
  Licitações (LC-07/18/20/24), Diárias e publicidade (DE-04/06/12),
  Fornecedores (FR-08), Cruzamentos (XS-07), Metas fiscais de risco
  (MF-09/10/12/13/14) e Diário Oficial (DO-02/04/05/06/07/08).
- **Três integrações externas novas**, cada uma com conector + detector +
  rota + página:
  - **PNCP** (`/nexo/contratos-pncp`) — contratos e aditivos da Prefeitura;
    detectores LC-19 e LC-20. O PNCP é geo-bloqueado fora do Brasil — a
    coleta ao vivo exige App Hosting em `southamerica-east1`.
  - **Sanções federais** (`/nexo/sancoes`) — CEIS/CNEP/CEPIM via API da CGU;
    detector FR-04 (fornecedor inidôneo). Depende da variável de ambiente
    `PORTAL_TRANSPARENCIA_TOKEN` (token gratuito gov.br) — sem ela a página
    mostra estado neutro com o passo-a-passo, sem quebrar.
  - **TCE-SP** (`/nexo/tce`) — cruzamento XS-14. O lado "fornecedores de
    Marília" é funcional (API pública de despesas do TCE-SP); o lado
    "julgados/apontamentos" fica `pendente` e honesto: o TCE-SP não publica
    fonte consultável de decisões por município.
- 4 detectores ficam **computáveis mas inativos** por dependência de dado
  ainda fora do contexto: LC-22 (data de abertura do CNPJ), DE-13 (RCL),
  FR-05 (lista de punidas municipal), FP-11 (série multi-exercício de folha)
  — retornam vazio honestamente em vez de gerar falso positivo.
- Revisão Codex do lote: 2 críticos (CPF de pessoa física exibido sem
  máscara nas páginas PNCP/TCE — corrigido com `mascararDoc`), 1 alto
  (diario-sinais mascarava falha da coleta de texto como "sem sinais") e 5
  médios — todos corrigidos.
- Estado do catálogo: **70 ativo · 4 computável · 98 planejado** (os
  planejados dependem de fonte sem API pública — frota km, almoxarifado,
  medições de obra, julgados do TCE-SP).

**v1.3 (2026-05-22)** — expansão em largura do motor de detecção.
- Os **172 monitoramentos** do catálogo materializados como dado estruturado
  (`src/lib/nexo/catalogo-completo.ts`), cada um com status honesto
  ativo/computável/planejado — corrige a contagem antiga de "132" (erro de
  soma no anexo 02).
- **~45 detectores computáveis sobre dados reais** em 14 áreas (antes 17 em
  6): novos detectores de Licitações (LC), Execução orçamentária (OR),
  Diárias/Eventos/Publicidade (DE), Fornecedores/Frota/Saúde (FC/FR/SA),
  Diário Oficial (DO), Folha/Convênios/Receita (FP/TS/RC).
- Empenhos enriquecidos com `DespesaAgrupada` (objeto + modalidade do
  empenho), o que destrava os detectores de fracionamento por objeto e de
  anulação/reforço atípicos.
- Três novos subsistemas autocontidos, cada um com conector + detectores +
  rota + página: **Receita** (`/nexo/receita`), **Convênios & 3º Setor**
  (`/nexo/convenios`) e **Sinais do Diário Oficial** (`/nexo/diario-sinais`).
- Extração real dos indicadores de Metas Fiscais (MF) via RREO/RGF do
  SICONFI, com distinção entre "sem dados publicados" e "fonte indisponível".
- Revisão Codex do lote: 0 crítico, 3 alto, 6 médio — todos corrigidos
  (`Cache-Control: no-store` nas respostas de acesso negado; limite de
  páginas e atraso da coleta de 3º setor reduzidos contra timeout; guarda de
  corrida nas páginas; coleta parcial do SMARAPD agora registrada em log).

**v1.2 (2026-05-21)** — registra a implementação das Fases 0-1.
- Módulo `/nexo` no ar: sala de situação war-room, 14 subsistemas.
- Motor de detecção com **17 detectores ativos** em 6 áreas (LC, FN, DE, OR,
  FP, MF) sobre dados reais — análise ao vivo via SMARAPD, PNCP e SICONFI.
- Conectores: SMARAPD (empenhos, diárias, modalidades, restos a pagar,
  folha), SICONFI (RREO/RGF), PNCP (contratos), BrasilAPI + CEIS/CNEP.
- Subsistemas operacionais: Painel de Situação, Investigações, Fornecedores
  (+ perfil/enriquecimento), Contratos & Licitações, Obras, Folha, Metas
  Fiscais (+ rastreador de prazos), Coleta, Briefing, Dossiês (+ minutas
  R01–R12), Processadores (catálogo), Empresas Sancionadas.
- Automação: Cloud Function `onNexoColetaDiaria` — coleta diária com
  hash/diff e purga de obsoletos.
- Segurança: as 5 rotas `/api/nexo/*` exigem sessão Firebase (autentica e
  autoriza por perfil ativo).
- 4 rodadas de revisão Codex; achados crítico/alto/médio corrigidos.
- **Pendente de deploy manual:** `firebase deploy --only firestore:rules` e
  `--only functions`; confirmar `MARILIA.cnpjPrefeitura` (PNCP); opcional o
  token `PORTAL_TRANSPARENCIA_TOKEN` (CEIS/CNEP).
- Restam ~115 dos 132 monitoramentos do catálogo — a arquitetura está pronta
  para recebê-los incrementalmente.

**v1.1 (2026-05-21)** — consolida a revisão do complexo de inteligência.
- Correção dos limites de dispensa 2026 (Decreto 12.807/2025) + tabela por
  exercício.
- Novas camadas: diff temporal `[1.5]` e resolução de entidades `[2.5]`.
- 7º princípio: explicabilidade. 3º score renomeado para "aderência a
  elementos objetivos da norma" (checklist, não %).
- 25 fontes mapeadas; PNCP/TCE-SP/CEIS promovidos à Fase 1.
- 132 monitoramentos em 14 áreas (nova área Receita/Renúncia).
- Grafo G01–G10; fornecedor em 2 níveis; doutrina anti-falso-positivo.
- Catálogo de requerimentos R01–R12; briefing de assessoria; 20 features.
- Metas Fiscais antecipado para a Fase 0 (prova de vida).
- Novo §13 Governança (papéis, LGPD, risco eleitoral 2026).
- Cinco anexos detalhados em `docs/nexo/`.

**v1.0 (2026-05-21)** — versão inicial do plano-mestre.
