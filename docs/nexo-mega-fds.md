# NEXO — MEGA IMPLEMENTAÇÃO (fim de semana autônomo)

> Mandato do dono (saiu pro fds, modo autônomo exaustivo): *"faça as melhorias
> exaustivamente dos endpoints da prefeitura, usa o DOM, coleta, cruza,
> exaustivamente, ciência de dados, análises, polimentos, crivos, critérios,
> busca de documentos, base de dados de documentos, árvore gigantesca de
> documentos públicos, leis relevantes para o crivo. Cron de gerente a cada
> 30min, cron de advogado a cada 1h. Workflow de 100 agentes mapeando TUDO do
> site da prefeitura. Os documentos devem ser acessórios para consulta do que a
> IA e os dados encontram. Página de contratos, editais, licitações, processos
> de dispensa. Cruzar empenhos com contratos firmados — TUDO PRECISA ESTAR
> LINKADO. Workflow de UI/UX em 3 rounds. Mega implementação e atualização."*

**Regras invioláveis (do projeto):** só ADITIVO/testado (não quebrar o que já
funciona); **sem deploy/push** sem ordem explícita; "indício, nunca acusação"
em toda saída; disclaimer carimbado; LGPD (mascarar PII). Branch de trabalho:
`nexo/expansao`. Tudo commitado no worktree, nada deployado.

---

## Tema-mãe: TUDO LINKADO (rastro probatório)
O fio condutor de toda a rajada: **cada número, alerta e achado tem que apontar
para o documento-fonte**. Empenho ↔ contrato ↔ edital ↔ licitação ↔ processo de
dispensa ↔ publicação no DOM ↔ PDF/processo. O documento é o **acessório de
consulta** do que a IA e os dados encontram. Sem o link, o indício não vale.

---

## Estado entregue (antes desta rajada)
- **Onda 1** — qualidade da entidade (ente público fora da lista de fornecedor),
  3ª perna do score, disclaimer. ✅ commit `a6bd75d`.
- **Onda 2 (fatia 1)** — FR-04 sancionado×empenho LIGADO ponta-a-ponta. ✅ `4ebdef3`.
- **Fix OOM** — `/api/nexo/detectar` HTTP 500 era OOM; App Hosting 1→2 GB. ✅ `593c48e`. *(precisa deploy)*
- **Requerimento do dossiê no padrão do gabinete** (Art. 16 XXII LOM). ✅ `223409a`.
- **Onda 0** — rede de segurança (38 testes node:test) + bugs vivos
  (RSS2_normas→@@normas, hash multiset, hardening crons). A invariante-mãe pegou
  XS-07 e FR-10 emitindo Prefeitura como fornecedor → corrigido. ✅ `972c7b5`.

---

## Roadmap do fim de semana (workflows encadeados)

> Cada WF roda em background; eu integro (wiring + typecheck root+functions +
> testes) e commito entre cada um. Sem deploy.

### WF-1 — 🗺️ MAPEAMENTO EXAUSTIVO do site da prefeitura (≈100 agentes, discovery)
*Pedido: "workflow de 100 agentes, mapeia tudooooo, descobre tudo, extrai o máximo".*
- Fan-out por subsistema: SMARAPD (todos os módulos/visões), dados-abertos
  (getContratos/getLicitacoes/getObras/getEmpenhos…), DOM/Querido Diário,
  portal `/portal/contrato/{id}`, conselhos (Laravel), lei13019 (OSCs),
  patrimônio, publicidade, folha, TCE-SP, PNCP, SICONFI, AUDESP, CADPREV.
- Cada agente: descobre endpoints reais (status/forma/paginação/auth/WAF),
  que DADO densos retorna, que DOCUMENTO/PDF expõe, e a chave de LINKAGE
  (nº empenho, nº processo, nº contrato, CNPJ, numeroControlePNCP).
- **Saída:** catálogo estruturado (a "árvore gigantesca") → `docs/nexo-mapa-fontes.json`
  + ranking de valor/esforço. Read-only (não escreve código).

### WF-2 — 🏗️ COLETORES densos novos (Onda 4) + CATÁLOGO DE DOCUMENTOS
*Pedido: coletar exaustivamente, DOM, base de documentos, árvore.*
- DOM full-text (Querido Diário) → `nexo_diario_dom` (dispensa/contrato/edital).
- Contratos/editais/licitações/dispensas (dados-abertos + scrape de nome) →
  `nexo_contratos_municipais`, `nexo_licitacoes`, `nexo_dispensas`.
- TCE-SP despesas por empenho → `nexo_tce_despesas` (2ª fonte do mesmo empenho).
- PNCP enriquecido (/termos aditivos, /itens, modalidade).
- **Catálogo de documentos** `nexo_documentos`: 1 doc por peça pública
  (tipo, órgão, data, nº processo, URL/PDF, hash, chaves de linkage) — a base
  que lista/cataloga TODO documento público encontrado.

### WF-3 — 🔗 MOTOR DE LINKAGE (record linkage) — "TUDO LINKADO"
*Pedido: cruzar empenhos com contratos firmados, TUDO PRECISA ESTAR LINKADO.*
- Resolver empenho ↔ contrato (numeroProcesso/PNCP; fallback CNPJ+faixa valor)
  ↔ edital/licitação ↔ dispensa ↔ publicação DOM ↔ documento (`nexo_documentos`).
- Persistir o grafo de vínculos em `nexo_links` (aresta tipada com confiança).
- **Procedência/prova** em todo alerta: cada `Evidencia` ganha `procedencia`
  com deep-link ao documento (já existe o builder em `procedencia.ts` — estender
  e CONECTAR à UI). Documento = acessório de consulta do achado.
- Detectores de divergência: empenho sem contrato, contrato sem execução,
  SMARAPD×TCE por nº empenho, DOM×portal.

### WF-4 — 🧮 CIÊNCIA DE DADOS + CRIVOS (Onda 3)
*Pedido: ciência de dados, análises, crivos, critérios.*
- Netting (líquido = empenho+reforço−anulação) antes de toda estatística.
- Robusto: mediana+MAD (Iglewicz-Hoaglin) no lugar de média+2σ.
- Benford (1º/2º dígito, MAD de Nigrini) → `nexo_benford` + detector BN-01.
- Curva ABC/HHI por grupo (raiz CNPJ); materialidade ancorada na RCL; FDR.
- **Crivo legal:** base de leis relevantes (`nexo_base_legal`) sempre aplicada
  ao classificar — Lei 14.133, 4.320, LRF, LAI, 12.846, 8.429 (com cautela
  pós-14.230), 9.504 (eleitoral), LOM art. 16. Cada detector cita a norma.

### WF-5 — 🤖 CRONS DE IA: GERENTE (30min) + ADVOGADO (1h)
*Pedido literal: cron de gerente a cada 30min, cron de advogado a cada 1h.*
- **`onNexoGerente`** (every 30 min): lê `nexo_alertas`/sync_state, prioriza o
  que apurar primeiro (potencial desc), detecta fontes degradadas, monta um
  "briefing do gerente" em `nexo_briefings` (o que mudou, top-N, saúde).
- **`onNexoAdvogado`** (every 1 h): aplica o crivo jurídico sobre os alertas
  abertos — enquadramento legal (base de leis), minuta de representação
  (TCE art.113 / Notícia de Fato MP), rótulo de aderência à norma (nunca "%
  de ilícito"). Grava parecer em `nexo_pareceres`, linkando os documentos-prova.
- Genkit/Gemini (key v6 já provisionada). `maxInstances:1`, idempotente.
  **NÃO deployar** (custo recorrente) até o dono mandar.

### WF-6 — 🎨 UI/UX em 3 ROUNDS
*Pedido literal: workflow de melhoria de UI/UX em 3 rounds.*
- **Round 1 (diagnóstico):** auditoria de todas as telas /nexo + /requerimentos
  (heurísticas, mobile, acessibilidade, hierarquia, estados vazios/erro).
- **Round 2 (implementação):** **nova página Contratos/Editais/Licitações/
  Dispensas** (pedido explícito) com busca/filtro e LINK pra cada documento;
  painel de provas no AlertaDetalhe (rastro probatório clicável); 3ª perna como
  "Aderência à norma"; navegação mobile.
- **Round 3 (polimento + verificação):** consistência visual, performance,
  revisão adversarial de cada tela contra o Round 1.

---

## Telas/entregáveis de UI explícitos
- **Página `/nexo/contratos`** (ou `/nexo/documentos`): contratos, editais,
  licitações, processos de dispensa — lista/filtro + link pro documento-fonte.
- **Painel de PROVAS** no detalhe do alerta: cada evidência com botão "ver
  documento" (PDF/processo/DOM), o rastro empenho→contrato→edital→pagamento.
- **Cruzamento empenho↔contrato** visível e navegável (TUDO LINKADO).

### WF-7 — 🔬 BASE PRÓPRIA + SUBPROGRAMAS DE BUSCA + RAIO-X (visão nova do dono)
*Pedido: "ingestão e consumo dos dados em uma base PRÓPRIA de tudo (pessoas,
empresas, empenhos, contratos, licitações, objetos, valores, orçamento por
rubrica/secretaria...). Subprogramas: identificar empresas com contrato ativo;
localizar servidores (setor, rede social, identificação); licitações em
andamento; compras diretas em andamento; cruzar a base com o DOM; RAIO-X de uma
entidade; e apontar se os dados foram ALTERADOS depois. Mirabola algo grandioso."*

- **Base própria (já em construção):** as coleções `nexo_*` + `nexo_documentos`
  + `nexo_links` JÁ são a base própria. Falta o **perfil unificado por entidade**.
- **`nexo_entidades` (RAIO-X):** 1 doc por CNPJ/CPF/órgão agregando TUDO que está
  linkado — empenhos, contratos, licitações (objetos/valores), sanções,
  documentos, vínculos societários, total faturado, flags. O "raio-x" que, dado
  um nome de empresa, mostra tudo dela na base da prefeitura.
- **Subprogramas de busca (`/api/nexo/busca` + telas):**
  - 🏢 **Empresas** com contrato/empenho ativo (por nome/CNPJ/objeto/valor).
  - 👤 **Servidores** (folha) — setor, cargo; identificação. *(rede social =
    enriquecimento externo opcional, com cautela LGPD.)*
  - 📋 **Licitações em andamento** + **compras diretas (dispensas) em andamento**.
  - 🔀 **Cruzamento base × DOM** — divergências/apontamentos.
- **Detecção de ALTERAÇÃO retroativa (#36):** snapshot+hash do bruto a cada
  coleta; se um registro mudar depois de visto, gerar flag "dado alterado após
  publicação" (forte indício — o ato mudou no sistema). É o "apontar se foram
  alterados depois".
- Telas de busca/raio-x entram no **WF-6 (UI)**; o backend (perfis+busca+hash)
  é WF-7.

## Ordem de execução
WF-1 (mapa) ✅ → WF-2 (coletores+catálogo) ✅ → WF-3 (linkage+provas) ✅ →
**WF-4 (ciência de dados+crivo legal)** → **WF-7 (base própria/raio-x/busca +
detecção de alteração)** → WF-5 (crons IA gerente/advogado) →
WF-6 (UI/UX 3 rounds: telas de contratos/editais + busca/raio-x + provas).
Integro e commito entre cada. Quando o dono voltar: revisar, então deploy
(`firebase deploy --only functions` + push p/ App Hosting + rules/indexes).
