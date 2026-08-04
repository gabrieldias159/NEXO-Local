# NEXO — Auditoria de cobertura e qualidade das bases de PERFILAMENTO

> Data: 01/07/2026 · Escopo: ficha de pessoa física (`/nexo/pessoa/[chave]`) e jurídica (`/nexo/fornecedores/[cnpj]`) — "abrir a ficha e ver TUDO que o sistema sabe".
> Método: leitura de `functions/src/nexo/*`, `src/lib/nexo/*`, `src/app/api/nexo/*`, `src/app/nexo/{pessoa,fornecedores,eleicoes}/*`, `public/eleicoes/*` e docs (`nexo-fontes-catalogo.md`, `nexo-nova-infra.md`, `transparencia-api-reference.md`, `nexo-mapa-fontes.json`).

---

## 0. Arquitetura de perfilamento hoje (resumo de 1 tela)

Duas cadeias PARALELAS que não se falam completamente:

1. **Cadeia Firestore (crons diários)** — `coleta.ts` (SMARAPD, 16 módulos incl. folha `nexo_pagamentos`) → `linkage.ts` (`nexo_links`) → `perfil-entidades.ts` (`nexo_entidades`, fusão de gêmeas name-only) → `coleta-socios.ts` (`nexo_socios`, minhareceita) → `cruzamentos.ts` (`nexo_cruzamentos` + `nexo_ranking_vinculo`, joins por `hashDoc`/`chaveFraca`). Sanções em 4 crons próprios (CGU 6h, TCE-SP 12h, leniência e contas irregulares mensais). DOM incremental via Querido Diário.
2. **Cadeia estática de eleições (offline)** — `scripts/eleicoes/*.mjs` geram `public/eleicoes/*.json` (2016/2020/2024) e um processo **one-off não versionado** gerou `cruzamento_nexo.json` (149/694 candidatos cruzados, join por nome exato).

**A ficha PF consome quase só a cadeia 2** (estáticos + `/api/nexo/pessoa-conexoes`, join por nome). **Ela NÃO lê** `nexo_pagamentos` (folha real), `nexo_cruzamentos`/`nexo_ranking_vinculo` (os únicos joins por cpf6/hash), `nexo_contas_irregulares`, nem o DOM ao vivo (`/api/nexo/diario-busca`). A ficha PJ consome `/api/nexo/fornecedor/[cnpj]` (cadastral BrasilAPI/minhareceita + sanções CGU) mas não mostra empenhos/contratos/licitações/vínculos (que existem no raio-x `busca?tipo=entidade`).

Chaves canônicas (`functions/src/nexo/chaves.ts`, `pii.ts`):
- `normNome` = NFD → sem acento → UPPER → espaços colapsados.
- `cpf6De` = 6 dígitos do MIOLO do CPF (posições 4–9) — o único trecho que Receita (QSA mascarado) e TSE expõem em comum.
- `chaveFraca` = `hashDoc(normNome + "|" + cpf6)`.
- `hashDoc` = `sha256(SALT + dígitos)`; SALT de `NEXO_PII_SALT` com **fallback público hardcoded** — ver §3.3.
- `entidadeId` = raiz do CNPJ (8 díg.) quando doc válido; senão rótulo canônico do nome. `chaveEmpenho` = `EMP-{seq pad10}-{ano}`; `chaveProcesso` = `{num}/{ano}`.

---

## 1. MATRIZ DE COBERTURA

Legenda: ✅ coberta · 🟡 parcial · ❌ ausente. "Janela" = anos efetivamente cobertos.

### 1.1 Pessoa Física (`/nexo/pessoa/[chave]`, chave = `n:` + nome normalizado)

| Pergunta investigativa | Status | Coleção/fonte | Chave de join | Fraquezas |
|---|---|---|---|---|
| Foi candidato? Eleito? Votação? | ✅ | `candidatos_{2016,2020,2024}.json` (TSE) | personId (nome norm.) + `aliasIds` por título de eleitor | Só municipais 2016+; estaduais/federais fora |
| Bens declarados | 🟡 | `fichas_*.json` (TSE, campo `bens`/`bensTotal`) | `sq` da candidatura | Só quem foi candidato; autodeclarado; valores nominais |
| Doou para campanha? | 🟡 | `doadores.json` (estático 2020+2024) e `nexo_doacoes_tse` (155.754 docs, **só 2020+2024**, receitas de candidatos SP) | estático: personId por nome; Firestore: `docHashDoador`/`cpf6`/`chaveFraca` | **2012/2016 ausentes**; doador originário (repasse partidário) ignorado; ficha usa o join por NOME, não o hash |
| Recebeu doação (como candidato)? De quem? | ✅ | `doadores.json` + `financas_*.json` + `cruz.recebeu` | `sq` / personId | Idem: 2016 tem só total receita/despesa (financas), sem extrato de doadores |
| É servidor municipal? Cargo/salário? | 🟡 | **Existe folha real**: `nexo_pagamentos` (SMARAPD `pagamentoaservidores`, ~23,3 mil reg/ano, maxPag 240) — mas a ficha **não a usa**; "servidor" na ficha vem de `cruzamento_nexo.json` inferido de diárias/passagens/nomeações | folha: nome+matrícula (**sem CPF na fonte**); ficha: nome exato | Ficha PF cega para a folha; folha sem CPF/verba-a-verba (FP-02..12 em stub); join só por nome |
| Recebe diárias/passagens? | ✅ | `nexo_diarias` (maxPag **25** — risco de truncar; campo `destino` não coletado) + `nexo_passagens` | `_cnpj`(CPF)/`_fornecedor` | Janela 2025→corrente (`ANO_BASE=2025`); sem destino/motivo |
| Foi nomeado/exonerado (DOM)? | 🟡 | `nexo_nomeacoes` (regex verbo+nome sobre DOM, ~22 docs) + `cruz.dom` | `nomeNorm` (DOM não publica CPF) | Estruturado só de 2026 em diante (cursor incremental, lookback 14d); histórico veio de `diarios.rawText` (resumos 2010-2024, truncados); `.txt` integral do Querido Diário NÃO varrido |
| É citado no DOM (qualquer contexto)? | 🟡 | `/api/nexo/diario-busca` (Querido Diário full-text, on-demand) — **não linkado da ficha** | termo livre | Busca existe mas o usuário precisa ir manualmente em outra tela |
| É sócio de empresa? | 🟡 | `nexo_socios` (**529 CNPJs**) via `/api/nexo/pessoa-conexoes` + `cruz.socio` | nome normalizado exato (varredura invertida, `limit 4000`) | Cobertura QSA só top fornecedores por `totalEmpenhado` (200/execução, 400 candidatos, TTL 30d); homônimos; limit 4000 vira amostra quando a coleção crescer |
| Empresa dele tem dinheiro público? | ✅ | merge `nexo_socios` × `nexo_entidades` por `cnpjRaiz` (pessoa-conexoes) | raiz CNPJ 8 díg. | Depende da cobertura QSA acima |
| É fornecedor PF da prefeitura? | ✅ | `nexo_entidades` tipo=pessoa (3.182 docs) | CPF (empenho traz CPF completo) / nome | Janela do perfil = corrente + anterior |
| Foi sancionado (PF)? Contas irregulares? | 🟡 | `nexo_contas_irregulares` (XLSX TCE-SP Ficha Limpa, ~84 linhas Marília) — **não exibido na ficha** | `nomeNorm` (CPF anonimizado na fonte: `cpfParcial` 3+2 díg. só corrobora) | Homonímia; ficha PF não consulta a coleção |
| Vínculo doador↔fornecedor (ranking) | 🟡 | `nexo_cruzamentos` + `nexo_ranking_vinculo` (cron 08h45, joins por `hashDoc`/`chaveFraca`) — **não exibidos na ficha** | `docHash`, `chaveFraca` | O único join forte por documento existe mas não chega ao perfilamento |
| Parentesco / mesmo núcleo familiar | ❌ | inexistente | — | Sem fonte pública direta; só proxy (sobrenome + endereço QSA), não implementado |
| Imóveis / veículos | ❌ | inexistente (exceto `bens` TSE p/ candidatos) | — | Sem fonte pública consultável; frota é data-blocked (e-SIC); IPTU/Renavam não públicos |

### 1.2 Pessoa Jurídica (`/nexo/fornecedores/[cnpj]`)

| Pergunta investigativa | Status | Coleção/fonte | Chave de join | Fraquezas |
|---|---|---|---|---|
| Cadastro (razão social, CNAE, capital, situação) | ✅ | BrasilAPI → fallback minhareceita, live com cache 12h | CNPJ 14 díg. | Endereço/e-mail/telefone retornados pela fonte **não são persistidos nem usados** |
| QSA (sócios) | ✅(live) / 🟡(persistido) | `info.socios` live na ficha; `nexo_socios` persistido só p/ 529 CNPJs | CNPJ; sócio→pessoa por nome (`personIdDe`) | Link sócio→ficha PF por nome (homônimo); QSA persistido é amostra top-N |
| Tem empenhos? Quanto? | ✅ | `nexo_empenhos` (maxPag 140) → agregado em `nexo_entidades` (dedup fan-out) | `_cnpj` / raiz | Janela 2025→corrente; backfill HTTP até 2015 existe mas perfil/linkage só olham 2 anos; **a ficha PJ não mostra** (só o raio-x `busca?tipo=entidade`) |
| Tem contrato? | ✅ | `nexo_contratos_municipais` (dados-abertos, muitas vezes **sem CNPJ/objeto** — gancho de enriquecimento SMARAPD) + `nexo_contratos` (PNCP, com fornecedor) | `chaveProcesso` `{num}/{ano}` + `_cnpj` | Fonte municipal não publica CNPJ da contratada; PNCP corrente+anterior, 30 págs |
| Participou de licitação SEM ganhar? | ❌ | `nexo_licitacoes` traz **só metadados do processo** (sem vencedor NEM participantes; `valorEstimado:null`); PNCP = só contratados | — | **Lacuna estrutural**: nenhuma fonte integrada lista licitantes/perdedores (base do detector de cartel/co-disputa) |
| Foi sancionada? | ✅ | `nexo_sancoes` (CEIS/CNEP/CEPIM, 6h, top 400 CNPJs) + `nexo_sancoes_estaduais` (TCE-SP apenados, 12h, top 600 + varredura por órgão MARILIA) + `nexo_leniencia` (mensal, 800) | CNPJ (guard por raiz 8 díg.) | Top-N por valor empenhado → PJ pequena pode nunca ser checada; **sanção municipal (`empresaspunidas` SMARAPD) não integrada**; CGE-SP sem endpoint (degradado honesto) |
| Doou para campanha (PJ)? | 🟡 | `nexo_doacoes_tse` + cruzamento `empresa-doador` (anomalia pós-2015, ADI 4650) | `hashDoc(cnpj)` = `docHash` | Só faz sentido em eleições ≤2014 → **precisa de 2012** (hoje só 2020/2024 ⇒ cruzamento estruturalmente vazio) |
| Sócio dela doou? | 🟡 | `nexo_cruzamentos` tipo `socio-doador` | `cpfHash` (média) ou `chaveFraca` (fraca→informativo) | Limitado pela cobertura QSA (529) e pelos anos TSE (2020/2024) |
| Grupo econômico (sócio comum)? | 🟡 | `nexo_cruzamentos` tipo `socio-comum` (cpfHash idêntico em 2 fornecedores) | `cpfHash` | Só entre os 529 com QSA; **endereço/e-mail/telefone comuns não usados** (dados disponíveis na minhareceita e descartados) |
| Mesmo endereço / filiais | 🟡 | filiais colapsadas por `cnpjRaiz` (8 díg.) | raiz CNPJ | Grupos com CNPJs de raízes diferentes no mesmo endereço: invisíveis |
| Recebeu subvenção/emenda (3º setor)? | ✅ | `nexo_subvencoes` (fonte 2013-2021) + `nexo_emendas` | `_cnpj` | Portal não expõe autor/valor previsto da emenda; lei13019.com.br (59 OSCs c/ CNPJ) não integrada |
| Citada no DOM? | 🟡 | `nexo_links` `processo-dom` (via `chavesProcesso`) + diario-busca on-demand | chaveProcesso | Nome da empresa no DOM não é indexado (só números de processo) |
| Divergência SMARAPD × TCE | ✅ | `nexo_tce_despesas` (chave `EMP-{seq}-{ano}__{cnpj}`, quinzenal) | `chaveEmpenho` — join FORTE | Corrente+anterior |
| Restos a pagar | 🟡 | `nexo_restos` | — | Bug de field-mapping: `cpfCnpj` vem vazio → MF-10 quase mudo |
| Patrimônio/bens fornecidos | 🟡 | `nexo_patrimonio` | — | **Truncado (~20k de 153k, 13%) e ÓRFÃO** (nenhum detector/tela lê) |

---

## 2. LACUNAS CRÍTICAS (ordenadas por gravidade)

| # | Lacuna | Evidência | Fonte pública que resolve | Esforço | Valor |
|---|---|---|---|---|---|
| L1 | **Ficha PF não consome as bases fortes que JÁ existem** (folha `nexo_pagamentos`, `nexo_cruzamentos`/`nexo_ranking_vinculo` com cpf6/hash, `nexo_contas_irregulares`, diario-busca) | `pessoa/[chave]/page.tsx` só lê estáticos + pessoa-conexoes | — (dado interno; criar rota agregadora/snapshot) | **S/M** | **Alto** |
| L2 | **Doações TSE só 2020+2024** — sem 2012 (última eleição com doação de PJ legal → único ano que liga empresa-doadora↔fornecedor) e sem 2016 | `ANOS_PADRAO=[2024,2020]` em `coleta-tse-doacoes.ts`; faixa aceita já é 2002-2100 | `https://cdn.tse.jus.br/estatistica/sead/odsele/prestacao_contas/prestacao_de_contas_eleitorais_candidatos_{2012,2016}.zip` (mesmo layout; 2012 pode variar colunas — validar header) | **S** | **Alto** |
| L3 | **Participantes de licitação (perdedores/co-disputa)** — nenhuma fonte lista licitantes; detector de cartel aspiracional | `coleta-licitacoes.ts` (fonte sem fornecedor); parecer conselho "mesmos participantes" não atendido | PNCP `/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens/{n}/resultados` (homologados) + **atas/editais PDF** em `www.marilia.sp.gov.br/portal/editais/...` e `/portal/download/licitacoes/{hash}/` (parse de "empresas participantes" nas atas de sessão); DOM (homologações citam classificadas) | **L** | **Alto** |
| L4 | **Cobertura QSA ~529 CNPJs** (top por totalEmpenhado; 200/execução) — sócio de PJ média/pequena invisível; % do universo de fornecedores com CNPJ não medida | `MAX_CNPJS=200`, `MAX_CANDIDATOS=400`, TTL 30d em `coleta-socios.ts` | a própria `minhareceita.org/{cnpj}` (grátis, já integrada) — é só ampliar o funil/backfill; medir cobertura = nº CNPJs distintos em `nexo_entidades` tipo=empresa | **S** | **Alto** |
| L5 | **Endereço/e-mail/telefone do CNPJ descartados** — minhareceita retorna e não persistimos ⇒ grupo econômico por endereço comum impossível | `coleta-socios.ts` normaliza só QSA; `cnpj.ts` idem | mesma fonte, custo zero: persistir `logradouro+numero+cep`, `email`, `telefone` em `nexo_socios`/`nexo_entidades` e cruzar | **S** | **Alto** |
| L6 | **DOM histórico sem texto integral** — nomeações estruturadas só 2026+; cruzamento usou resumos truncados 2010-2024; `.txt` integrais do QD nunca varridos | meta do cruzamento (`limitacao`); `coleta-dom.ts` cursor incremental | Querido Diário `api.queridodiario.ok.org.br/gazettes?territory_ids=3529005` (`.txt` integral por edição, desde ~2010) — backfill paginado + regex de atos existente | **M** | **Alto** |
| L7 | **`cruzamento_nexo.json` é one-off não versionado** — 149 pessoas congeladas, join por nome, não re-executável | agente confirmou: nenhum script no repo/histórico gera o arquivo | — (reescrever como cron/callable no padrão snapshot de `nexo-nova-infra.md`) | **M** | **Alto** |
| L8 | **Janela analítica de 2 anos** — linkage/perfil/sanções leem corrente+anterior (`ANO_BASE=2025`); histórico 2015+ só via backfill manual e não entra nos agregados | `exerciciosAlvo()` em perfil/linkage/coletas | backfill HTTP já existe (`onNexoBackfillHttp`, 4 anos/chamada); falta rodar + parametrizar agregadores multi-ano | **M** | Médio-Alto |
| L9 | **Sanção municipal não integrada** — visão fixa SMARAPD `secretaria_emprego_trabalho/empresaspunidas` fora do pipeline (e Ordem Cronológica, Imóveis Locados idem) | `transparencia-api-reference.md` §5 | `.../paiportalserver/modulovisao/fixo/secretaria_emprego_trabalho/empresaspunidas` | **S** | Médio |
| L10 | **Folha sem CPF/verba** — fonte publica só nome/matrícula/cargo/totais; nepotismo e acúmulo (FP-02..12) em stub | schema §4 do api-reference; stubs em `folha.ts` | Parcial: e-SIC p/ folha analítica; TCE-SP AUDESP remuneração de agentes públicos (`transparencia.tce.sp.gov.br` módulo remuneração) — validar se expõe Marília | **M** | Médio |
| L11 | **Doador originário ignorado** — repasses via partido/candidato mascaram o financiador real | `coleta-tse-doacoes.ts` ignora `receitas_candidatos_doador_originario` explicitamente | mesmo ZIP TSE, entrada `receitas_candidatos_doador_originario_{ano}_SP.csv` | **S** | Médio |
| L12 | **Parentesco** — inexistente; nepotismo só por sobrenome (não implementado) | detectores FP-07/08 stub | Não há fonte pública estruturada. Proxy: sobrenomes compostos raros + mesmo endereço de QSA + mesmo local de votação (seção); sempre "indício a apurar" (Lei 14.230/21) | **M** | Médio (com guardrail) |
| L13 | Imóveis/veículos de particulares | — | Inexistente (IPTU/Renavam não públicos). Cobrir o possível: `bens` TSE (feito p/ candidatos), Imóveis LOCADOS pela prefeitura (visão fixa `pca/imoveislocados`), frota via e-SIC | **L** | Baixo-Médio |
| L14 | `nexo_patrimonio` truncado (13%) e órfão; `nexo_diarias` maxPag 25 pode truncar; drill-downs (itens de empenho, destino de diária, liquidações de publicidade) não coletados | `coleta.ts` caps; mapa-fontes k=smarapd-patrimonio | mesma API SMARAPD (subir caps + drill-down por `IDDespesa`) | **S/M** | Médio |

---

## 3. QUALIDADE DOS JOINS

### 3.1 Nome normalizado exato (`normNome`) — o join dominante da ficha PF
- **Onde**: `pessoa-conexoes` (sócio↔pessoa), ficha PJ (sócio→link pessoa), `cruzamento_nexo.json`, nomeações DOM, contas irregulares.
- **Falso positivo**: homônimo exato (mesmo nome completo). Mitigações já boas no cruzamento estático (≥2 tokens, ≥9 chars, filtro recipiente=MARILIA, verbo de ato adjacente no DOM, denylist de 7 nomes curtos) — mas `pessoa-conexoes` **não aplica nenhuma** dessas heurísticas além do mínimo de 5 chars.
- **Falso negativo**: abreviações ("JOSE A. FERREIRA"), nome de casada/solteira, acréscimo de sobrenome entre eleições (parcialmente resolvido por `aliasIds` via título de eleitor), erro de digitação na fonte municipal.
- **Melhorias**: (a) sempre exibir `docsDistintos`/nº de CPFs distintos por nome como termômetro de ambiguidade; (b) quando ambos os lados têm CPF completo, **nunca** usar nome (ver 3.4); (c) fuzzy controlado apenas como sugestão rotulada, nunca como merge automático (decisão correta já tomada em `perfil-entidades.mesclarNomeOnly`: só nome exato inequívoco, ≥6 chars, 1 CNPJ candidato).

### 3.2 `chaveFraca` (nome + cpf6) — a ponte sócio↔doador
- cpf6 = 6 dígitos do miolo → espaço de 10^6; combinado com nome completo exato, a probabilidade de colisão real é baixíssima (FP raro). O sistema já rebaixa para `informativo` — calibragem conservadora correta.
- **Falso negativo é o problema dominante**: basta a grafia do nome divergir entre Receita e TSE para a chave não fechar (a chave embute o nome inteiro no hash). Melhoria: variante `chaveFraca2 = hashDoc(primeiroToken + ultimoToken + "|" + cpf6)` como segundo estágio, rotulada com confiança menor.
- XS-DOADOR = 0 hoje deve-se menos à chave e mais à **falta dos anos TSE certos** (L2) e à cobertura QSA (L4).

### 3.3 `hashDoc` — risco operacional de SALT
- `sha256(SALT + doc)` com **fallback hardcoded público** se `NEXO_PII_SALT` não estiver definido. Dois riscos: (a) hash previsível/reversível por força bruta de CPF (11 díg.) se o fallback estiver em uso em prod; (b) **joins silenciosamente quebrados se functions e app Next usarem SALTs diferentes** (o hash é a chave de igualdade entre `nexo_doacoes_tse.docHashDoador`, `nexo_socios.cpfHash` e `hashDoc(_cnpj)` de empenhos). Recomendação: assert de sanidade no boot (logar hash de um doc de teste em cada runtime e comparar via sync_state) + garantir o secret nos dois ambientes. Nota positiva: `onNexoBackfillChaveFraca` deliberadamente não re-chaveia — coerente.

### 3.4 Joins por documento completo — subutilizados (maior oportunidade)
Hoje o CPF completo existe em TRÊS lugares e quase não é usado para juntar:
1. **Empenhos/diárias/passagens SMARAPD**: `_cnpj` traz CPF completo de fornecedor PF.
2. **TSE receitas**: CPF completo do doador (vira `docHashDoador`).
3. **TSE consulta_cand**: `NR_CPF_CANDIDATO` completo e público — **não coletado hoje** (candidatos_*.json não guardam CPF).
⇒ dá para fazer **join EXATO por `hashDoc`**: candidato↔fornecedor-PF, candidato↔sócio (via cpf6), doador↔fornecedor-PF, doador↔beneficiário de diária — eliminando o nome como chave primária na maior parte da ficha PF. O título de eleitor (`fichas_*.json.titulo`) já resolve a identidade INTRA-TSE (feito em `unifica_pessoas.mjs`); o CPF do consulta_cand resolve a identidade TSE↔NEXO.

### 3.5 Joins técnicos (documental)
- `chaveEmpenho` SMARAPD↔TCE: forte, bem construído (pad 10 + CNPJ).
- `chaveProcesso` `{num}/{ano}`: guard de cardinalidade sensato (nº curto só casa com ≤2 alvos; nº longo rebaixa a `media` com >4 alvos). Risco residual: processos de secretarias distintas com mesma numeração — mitigável carimbando UG quando disponível.
- `cpfParcial` (contas irregulares, 3+2 díg.): corretamente tratado como corroboração, nunca chave primária.
- Fusão de gêmeas name-only (`mesclarNomeOnly`): política correta (exato, inequívoco, sem fuzzy); manter.

---

## 4. PLANO PRIORIZADO (valor ÷ esforço)

| # | Ação | Fonte | Onde encaixa | O que destrava no perfilamento |
|---|---|---|---|---|
| **1** | **Rota agregadora `/api/nexo/pessoa/[id]` (padrão snapshot)** que funde o que JÁ existe: pessoa-conexoes + folha (`nexo_pagamentos` por nome/matrícula) + `nexo_cruzamentos`/`nexo_ranking_vinculo` + `nexo_contas_irregulares` + diárias/passagens/nomeações live — e a ficha PF passa a consumi-la | interno | nova rota + tarefa/snapshot (`nexo-nova-infra.md`); ficha PF troca 11 fetches estáticos por 1 snapshot + estáticos TSE | Ficha PF deixa de ser "eleições + amostra"; vira raio-x real; cargo/salário do servidor aparece; esforço S/M, valor máximo |
| **2** | **Backfill TSE 2012 + 2016** (e regenerar `doadores.json`/cruzamentos) | `cdn.tse.jus.br/.../prestacao_de_contas_eleitorais_candidatos_{2012,2016}.zip` (validar layout 2012) | `onNexoBackfillTseDoacoes` já aceita ano arbitrário — só chamar com `[2012,2016]` e ajustar parser p/ colunas antigas; cron mensal inalterado | Habilita empresa-doadora↔fornecedor (2012 = PJ legal), histórico de financiamento de TODOS os políticos locais em 4 eleições |
| **3** | **Coletar CPF do candidato (consulta_cand TSE) e migrar joins para `hashDoc`/cpf6** | `cdn.tse.jus.br/estatistica/sead/odsele/consulta_cand/consulta_cand_{ano}.zip` (col. `NR_CPF_CANDIDATO`) | `scripts/eleicoes/gera_candidatos.mjs` (guardar `cpfHash`+`cpf6`, nunca o cru) + refazer cruzamento | Join EXATO candidato↔fornecedor-PF↔sócio↔doador↔diárias; mata o homônimo como risco nº 1 |
| **4** | **Ampliar QSA a 100% dos fornecedores com CNPJ + persistir endereço/e-mail/telefone** | minhareceita (já integrada) | `coleta-socios.ts`: subir `MAX_CANDIDATOS`/`MAX_CNPJS` (ou loop até esgotar TTL) + 3 campos novos; métrica de cobertura no sync_state | Sócio de qualquer fornecedor visível; detector "mesmo endereço/e-mail" p/ grupo econômico (cartel) |
| **5** | **Refazer `cruzamento_nexo` como cron versionado** (substitui o one-off), usando as chaves do item 3 e gravando snapshot com TTL | interno | novo `functions/src/nexo/cruzamento-eleicoes.ts` no padrão tarefa→snapshot; mantém heurísticas anti-FP do meta | Cruzamento sai de 149 pessoas congeladas para 694+ recomputáveis a cada coleta; auditável e reexecutável |
| 6 | **Backfill DOM texto integral (2010+) + indexar nomes/CNPJs** | Querido Diário `.txt` por edição | `coleta-dom.ts`: modo backfill por faixa de datas (reusar `onNexoBackfillHttp` como modelo); reusar regex de atos | "Citado no DOM" vira cobertura de 15 anos; nomeações/exonerações históricas (carreira do servidor) |
| 7 | **Botão/aba "Diário Oficial" na ficha** consumindo `/api/nexo/diario-busca?termo={nome ou razão social}` on-demand | Querido Diário (já integrado) | só UI nas duas fichas | Cobertura DOM imediata (esforço S) enquanto o item 6 não roda |
| 8 | **Sanção municipal `empresaspunidas` + Ordem Cronológica + Imóveis Locados** (visões fixas SMARAPD) | `.../modulovisao/fixo/secretaria_emprego_trabalho/empresaspunidas` etc. | novo módulo em `coleta.ts` (ou cron leve próprio) + merge no bloco de sanções da ficha PJ | Fecha o triângulo federal+estadual+municipal de sanções |
| 9 | **Janela multi-ano**: rodar backfill 2015-2024 de empenhos/contratos e parametrizar `exerciciosAlvo()` de perfil/linkage/cruzamentos p/ todos os anos presentes | SMARAPD (backfill já existe) | `onNexoBackfillHttp` + flag de anos em perfil-entidades/linkage | Total empenhado histórico por entidade; padrões de longa data (fornecedor "de sempre") |
| 10 | **Participantes de licitação**: fase 1 — resultados/itens PNCP por compra; fase 2 — parser de atas de sessão (PDF) de `/portal/editais` extraindo licitantes | PNCP consulta + `www.marilia.sp.gov.br/portal/editais/...` + `/portal/download/licitacoes/{hash}/` | novo cron `coleta-participantes.ts` + gateway de IA p/ extração de PDF (já existe pipeline de PDF no gateway) | Única forma de detectar cartel/co-disputa e "perdedor de fachada"; esforço L, planejar por último mas começar a fase 1 |

**Correções de higiene embutidas (fazer junto, custo ~0):** assert de SALT entre runtimes (§3.3); subir `maxPag` de `nexo_diarias` (25) e `nexo_patrimonio`; consertar `cpfCnpj` vazio em `nexo_restos`; coletar `receitas_candidatos_doador_originario` no mesmo passe do item 2; aplicar as heurísticas anti-homônimo do cruzamento estático em `pessoa-conexoes`.

---

## 5. Riscos e guardrails (manter)
- Tudo que é join probabilístico continua carimbado `informativo/atencao` e "indício a apurar, nunca acusação" (Lei 14.230/21) — os crons já fazem isso (`_enquadramento`, `_classificacaoMax`); qualquer dado novo na ficha deve herdar o padrão.
- LGPD: CPF nunca cru em URL/JSON público (padrão `hashDoc`+`docMasc` já correto); ao adotar CPF do consulta_cand (item 3), armazenar apenas `cpfHash`/`cpf6`, jamais o dígito completo em estático versionado.
- `limit 4000` de `pessoa-conexoes`/`busca` vira amostragem silenciosa quando as coleções crescerem — trocar por consulta indexada (`array-contains` em `chavesFracas`/`nomeNorm`) ou mover o join para o snapshot (item 1).
