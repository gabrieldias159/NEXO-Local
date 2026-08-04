# NEXO — Insights e Correlações

### O que os dados podem revelar que um detector isolado não enxerga

**Câmara Municipal de Marília/SP — Gabinete Vereador Fefin**
Documento PRISMA (Correlação & Modelos) · v1.0 · 2026-05-21
Complementa `docs/nexo-plano-mestre.md` (§4–§7) e `docs/nexo-equipe.md`

---

## 0. Propósito e tese

Os 6 processadores e os ~38 detectores do plano-mestre são **regras locais**:
cada um olha um empenho, um contrato, uma diária e responde "isto destoa?".
São indispensáveis, mas têm um teto. Um detector de fracionamento vê três
dispensas ao mesmo CNPJ; ele **não** vê que o sócio desse CNPJ também é sócio
da empresa que "concorreu" e perdeu, nem que o contador é o mesmo de outras
quatro fornecedoras da Prefeitura, nem que o padrão de empenhos se repete em
dezembro de todo exercício.

> **Tese do PRISMA:** o maior valor do NEXO não está em mais detectores — está
> em **resolver entidades** (saber que duas linhas são a mesma pessoa/empresa)
> e em **ligar os pontos em grafo e em série temporal**. Insight de correlação
> é o que transforma 40 alertas dispersos em 1 dossiê com narrativa.

Este documento define, sem escrever código de produção (apenas pseudocódigo
conceitual), seis frentes:

1. Resolução de entidades — deduplicar e ligar.
2. Grafo de relacionamentos — nós, arestas e consultas de alto valor.
3. Padrões temporais — sazonalidade, fim de exercício/mandato, sequências.
4. Modelos estatísticos — ABC, sobrepreço, Benford, km/l, HHI, competitividade.
5. Insights cross-source — cruzamentos entre fontes diferentes.
6. Refinamento do score triplo e redução de falso positivo.

Tudo opera sob o trilho jurídico do plano-mestre §2: **indício, nunca
acusação**; todo achado guarda fonte, URL, data e hash; revisão humana
obrigatória.

> **Nota de calibração honesta.** Vários modelos abaixo (Benford, HHI,
> competitividade) só ganham robustez com **série histórica** e com dados de
> licitação (nº de participantes). Hoje a API SMARAPD entrega o exercício
> corrente bem e o histórico de forma irregular; nº de licitantes não está na
> API e depende do scraping de editais (Tier B, Fase 2). O documento marca
> explicitamente o que é viável **agora** (dados de empenho 2026) e o que é
> **Fase 2/3**. Modelo estatístico aplicado sobre amostra pequena gera falso
> positivo — esse risco é tratado em §6.

---

## 1. Resolução de entidades (entity resolution)

### 1.1 Por que isto vem antes de tudo

Resolução de entidades é o ato de decidir que dois registros que **parecem**
diferentes são, na verdade, **a mesma entidade do mundo real** — ou que estão
**ligados**. Sem isto:

- "M CONSTRUÇÕES & SERVIÇOS LTDA", "M CONSTRUCOES E SERVICOS", "M Construções
  Ltda" e o CNPJ `02.823.335/0001-35` viram quatro fornecedores diferentes nas
  estatísticas — e o ranking de risco mente.
- Fracionamento entre a matriz `09.528.436/0001-22` e as filiais `/0002-03` e
  `/0003-94` (caso HU, R$ 6,8M combinados) **não é detectado**, porque cada
  CNPJ de 14 dígitos é tratado isoladamente.
- "Secretaria Municipal da Saúde", "Fundo Municipal de Saúde" e "SMS" contam
  como três órgãos, e o mapa de risco por secretaria fica diluído.

A literatura de detecção de fraude em compras públicas é unânime: dados de
fornecedor sujos e duplicados são, em si, **a vulnerabilidade que a fraude
explora** — a fraude se esconde justamente na ambiguidade
([Senzing](https://senzing.com/public-sector-entity-resolution/),
[SAS](https://www.sas.com/en_us/insights/articles/risk-fraud/stop-contract-and-procurement-fraud.html)).
Resolução de entidades é, portanto, **pré-requisito de todo o resto** — grafo,
modelos e cruzamentos só funcionam sobre entidades resolvidas.

### 1.2 As quatro entidades a resolver

| Entidade | Chave forte | Chaves fracas (para ligar/deduplicar) |
|---|---|---|
| **Fornecedor (PJ)** | CNPJ 14 díg. | CNPJ raiz 8 díg., razão social, nome fantasia, endereço, telefone, e-mail, sócios, contador |
| **Pessoa física** | CPF (quando público) | nome normalizado + data nasc., nome + cargo, nome + sobrenome de gestor |
| **Órgão / secretaria / UG** | código UG | nome do órgão, unidade orçamentária, programa |
| **Servidor** | matrícula | CPF, nome normalizado, cargo + lotação |

### 1.3 Estratégia para FORNECEDORES — a mais crítica

A resolução de fornecedor tem **dois objetivos distintos** que não devem ser
confundidos:

- **(A) Deduplicar** — colapsar registros que são *literalmente a mesma PJ*.
- **(B) Ligar (clustering por afinidade)** — agrupar PJs *distintas mas
  relacionadas* (mesmo grupo econômico, sócios em comum, mesmo endereço). Isto
  **não** é deduplicação: as empresas continuam separadas, mas ganham uma
  aresta no grafo (§2).

#### (A) Deduplicação — três níveis de chave

**Nível 1 — CNPJ completo (14 dígitos), determinístico.**
Normalizar: remover pontuação, `padStart` 14, validar dígitos verificadores.
Registros com mesmo CNPJ-14 são a mesma entidade-estabelecimento. ID
determinístico do fornecedor = o próprio CNPJ-14. Sem ambiguidade.

**Nível 2 — CNPJ raiz (8 dígitos) → entidade "empresa-grupo".**
Os 8 primeiros dígitos identificam a **pessoa jurídica**; os 4 seguintes
(`/0001`, `/0002`…) são estabelecimentos (matriz e filiais). Modelar **dois
níveis**:

```
Empresa-grupo (raiz 8 díg.)  09.528.436
  ├── Estabelecimento /0001-22  (matriz)
  ├── Estabelecimento /0002-03  (filial)
  └── Estabelecimento /0003-94  (filial)
```

As estatísticas de risco (total empenhado, concentração, fracionamento)
**devem ser calculadas nos dois níveis**. O caso HU mostra por quê: três
filiais somam R$ 6,8M; se a soma por grupo cruza um limiar de modalidade que
nenhum estabelecimento sozinho cruzaria, há **indício de fracionamento por
filial** — invisível para um detector que só agrupa por CNPJ-14.

> **Pseudocódigo conceitual — chave de empresa-grupo:**
> ```
> raiz(cnpj14)        = cnpj14[0:8]
> idGrupo             = "grupo:" + raiz
> idEstabelecimento   = "estab:" + cnpj14
> // todo empenho aponta para estab; estab aponta para grupo;
> // detectores rodam em estab E em grupo
> ```

**Nível 3 — sem CNPJ (CPF ou texto livre).** Parte dos empenhos pequenos e
diárias traz pessoa física ou razão social sem CNPJ associado. Aqui não há
chave forte; cai na deduplicação probabilística por nome (abaixo).

#### Deduplicação probabilística por nome (quando falta CNPJ)

Pipeline clássico de *record linkage* em três passos:

1. **Normalização canônica do nome.** Maiúsculas; remover acentos; expandir/
   uniformizar `&`→`E`, `LTDA`/`ME`/`EPP`/`EIRELI`/`S.A.`/`S/A`; remover
   pontuação; colapsar espaços; corrigir o encoding `latin-1` quebrado da API
   (`M\xf4nica`→`MONICA`). Resultado: `nomeCanonico`.

2. **Blocking (bloqueio).** Comparar todos contra todos é O(n²) — 15.558
   fornecedores = 121 milhões de pares. Reduz-se gerando uma *chave de bloco* e
   só comparando dentro do bloco. Chaves de bloco úteis: primeiros 4 caracteres
   do nome canônico; *Soundex/Metaphone* adaptado a português; primeiro token
   significativo + UF.

3. **Scoring de similaridade dentro do bloco.** Para cada par no mesmo bloco,
   combinar:
   - distância de strings no nome (Jaro-Winkler ou Levenshtein normalizado);
   - igualdade de endereço normalizado;
   - igualdade de telefone/e-mail;
   - sobreposição de sócios (vinda do enriquecimento BrasilAPI).

   ```
   scoreMatch = 0.45*simNome + 0.25*igualEndereco
              + 0.15*igualTelefone + 0.15*sobreposicaoSocios
   se scoreMatch >= 0.92  -> mesma entidade (merge automático, log)
   se 0.75 <= scoreMatch < 0.92 -> "candidato a merge" (fila de revisão humana)
   se scoreMatch < 0.75  -> entidades distintas
   ```

   **Princípio:** merge automático só na faixa altíssima; a zona cinzenta vai
   para revisão humana — nunca fundir entidades com base em palpite, porque um
   merge errado **contamina todo o grafo**.

#### (B) Ligação por afinidade (sócios, endereço, contador, telefone)

Isto **não funde** fornecedores — cria **arestas** entre eles. Fontes dos
atributos de ligação:

| Atributo de ligação | Fonte | Disponibilidade |
|---|---|---|
| Sócios (nome, qualificação) | BrasilAPI `/cnpj/v1/` (`socios[]`) | ✅ pronto |
| Endereço (logradouro, nº, CEP, geo) | BrasilAPI; geocodificar CEP | ✅ pronto |
| CNAE / capital social / data abertura | BrasilAPI | ✅ pronto |
| Telefone / e-mail | BrasilAPI (`ddd_telefone_1`, etc.) | ✅ parcial |
| **Contador / escritório contábil** | **não vem da BrasilAPI** | ⚠️ Fase 2/3 — ver nota |

> **Nota sobre "contador em comum".** O contador responsável **não** está nas
> APIs públicas gratuitas de CNPJ. Aparece em: (a) rodapé de balanços/notas
> explicativas; (b) cadastro de licitantes em alguns editais; (c) JUCESP
> (alterações contratuais). É um sinal forte de fachada coordenada, mas seu
> custo de coleta é alto e a cobertura é parcial. **Recomendação:** tratar
> "contador em comum" como atributo **oportunístico** — preencher quando
> aparecer no scraping de editais/balanços, nunca como pré-requisito de
> análise. Não bloquear o grafo esperando por ele.

Regra de ligação (gera aresta, não merge):

```
para cada par de fornecedores (A, B) distintos:
  se compartilham >=1 socio        -> aresta SOCIO_COMUM (peso = nº sócios)
  se mesmo endereço normalizado    -> aresta MESMO_ENDERECO
  se mesmo telefone/e-mail         -> aresta MESMO_CONTATO
  se mesmo contador (quando houver)-> aresta MESMO_CONTADOR
  se data abertura < 180 dias antes de 1ª contratação -> rótulo EMPRESA_NOVA
```

#### Cuidados específicos de Marília (reduzir falso positivo desde a origem)

- **Endereços de coworking / contabilidades / salas comerciais compartilhadas.**
  Dezenas de MEs legítimas dividem o mesmo endereço de um escritório de
  contabilidade. *Mesmo endereço* sozinho **não** é indício — vira indício
  quando combinado com (sócio comum OU concorrência no mesmo certame OU CNAE
  igual). Manter uma **lista de endereços "ruidosos"** (alta cardinalidade de
  CNPJs) e rebaixar o peso da aresta quando o endereço estiver nessa lista.
- **Homonímia.** "JOSE CARLOS DA SILVA" (top de diárias na análise preliminar)
  é nome comum; deduplicar pessoa física por nome **exige** CPF ou
  matrícula+lotação como desempate. Nome puro nunca funde pessoas.
- **Filial ≠ fracionamento automático.** Matriz e filial em UGs distintas pode
  ser organização administrativa legítima. O agrupamento por raiz **levanta a
  hipótese**; o detector ainda precisa do padrão (mesmo objeto, janela curta,
  soma acima do limite) para gerar alerta.

### 1.4 Estratégia para ÓRGÃOS / SECRETARIAS

Universo pequeno e fechado (dezenas de UGs) — resolução manual assistida, não
probabilística:

- Construir, **uma vez**, uma **tabela canônica de órgãos** de Marília: UG
  oficial ↔ secretaria ↔ unidade orçamentária ↔ fundo vinculado ↔ apelidos
  ("SMS", "Saúde", "Fundo Municipal de Saúde").
- Toda linha de empenho/despesa passa por essa tabela de-para na normalização.
- Vincular a secretaria-mãe e o(s) fundo(s) — Fundo Municipal de Saúde é o
  veículo orçamentário da Secretaria de Saúde; para fins de mapa de risco,
  consolidam.
- Esta tabela também é onde mora a **tabela de-para de modalidade** (código
  `50`, `90`… → nome) citada como dívida na API reference.

### 1.5 Estratégia para SERVIDORES

- Chave forte: **matrícula**. Mas o mesmo CPF pode ter **várias matrículas**
  (acúmulo de cargos — legítimo ou não; é o detector C02/E07).
- Resolver a **pessoa** por CPF; manter as matrículas como vínculos
  pendurados na pessoa. Isto permite ver "pessoa X tem 2 matrículas ativas".
- Quando o CPF não estiver visível (mascaramento LGPD na folha): resolver por
  `nomeCanonico + dataAdmissao + lotação` como chave composta, com confiança
  menor — e marcar o vínculo como "identidade não confirmada".
- Ligar servidor ↔ fornecedor exige CPF do servidor ↔ CPF de sócio. Como a
  folha mascara CPF, parte dessa ligação dependerá de **nome** — sinal mais
  fraco, sempre rotulado "requer confirmação documental".

### 1.6 Saída da camada de resolução

Acrescentar duas estruturas ao modelo de dados do plano-mestre §5:

- `nexo_entidades` — registro canônico unificado (PJ-grupo, PJ-estabelecimento,
  pessoa, órgão, servidor), com `idCanonico`, lista de `registrosFonte[]` que
  foram colapsados, método de resolução (`deterministico` | `probabilistico` |
  `manual`) e `confiancaResolucao` (0–1).
- `nexo_merges_log` — toda decisão de merge/ligação: par envolvido, score,
  decisão, quem decidiu (`auto` | `uid humano`), data. **Auditável e
  reversível** — se um merge se mostrar errado, é preciso poder desfazer sem
  refazer tudo.

---

## 2. Grafo de relacionamentos

O grafo é o coração do "criar nexo". Ele materializa as coleções
`nexo_grafo_nos` / `nexo_grafo_arestas` do plano-mestre §5. A literatura mostra
que análise de vínculos (*link analysis*) é a técnica certa quando a fraude
envolve **conluio ou anéis organizados** — exatamente o caso de bid-rigging
([SAS](https://www.sas.com/en_us/insights/articles/risk-fraud/stop-contract-and-procurement-fraud.html),
[Linkurious](https://linkurious.com/blog/fraud-use-cases-graph-analytics/)).
Ferramentas de referência como o **BRAVA** da autoridade antitruste espanhola
combinam exatamente grafo + ML para mapear relações entre empresas, lances e
pessoas
([Network Law Review](https://www.networklawreview.org/computational-antitrust-evidence/)).

### 2.1 Tipos de NÓ

| Nó | Origem | Atributos-chave |
|---|---|---|
| `EmpresaGrupo` | CNPJ raiz 8 díg. | razão social, CNAE, capital, situação, UF, dataAbertura |
| `Estabelecimento` | CNPJ 14 díg. | matriz/filial, endereço, geo |
| `Pessoa` | CPF / nome resolvido | nome, papéis (sócio, servidor, agente político) |
| `Orgao` | UG / secretaria | nome canônico, fundo vinculado |
| `Servidor` | matrícula | cargo, lotação, dataAdmissao, vínculo |
| `Licitacao` | processo licitatório | modalidade, objeto, valor estimado, ano |
| `Contrato` | nº contrato | objeto, valor, vigência, aditivos |
| `Empenho` | nº empenho + exercício | valor, data, elemento, modalidade |
| `Endereco` | endereço normalizado + geo | logradouro, CEP, é "ruidoso"? |
| `Contador` | nome do contador (quando houver) | — |
| `AtoDOM` | publicação no Diário Oficial | tipo, data, nº |
| `Norma` | lei/decreto/portaria (SAPL) | tipo, data, ementa |
| `DoacaoCampanha` | registro TSE | doador, candidato, ano eleitoral, valor |

> Endereço e Contador como **nós próprios** (e não meros atributos) é uma
> decisão deliberada: vira trivial perguntar "quais empresas penduram neste
> endereço?" — uma travessia de 1 salto em vez de uma varredura.

### 2.2 Tipos de ARESTA

| Aresta | De → Para | Semântica |
|---|---|---|
| `PERTENCE_A` | Estabelecimento → EmpresaGrupo | matriz/filial |
| `SOCIO_DE` | Pessoa → EmpresaGrupo | participação societária (peso: qualificação, data) |
| `SOCIO_COMUM` | EmpresaGrupo ↔ EmpresaGrupo | derivada — sócio compartilhado |
| `MESMO_ENDERECO` | Estabelecimento ↔ Endereço | sede declarada |
| `MESMO_CONTATO` | EmpresaGrupo ↔ EmpresaGrupo | telefone/e-mail compartilhado |
| `MESMO_CONTADOR` | EmpresaGrupo ↔ Contador | contador responsável |
| `PARTICIPOU_DE` | EmpresaGrupo → Licitacao | foi licitante (precisa scraping de edital) |
| `VENCEU` | EmpresaGrupo → Licitacao | foi vencedora |
| `GEROU` | Licitacao → Contrato; Contrato → Empenho | cadeia de execução |
| `FORNECEU_A` | EmpresaGrupo → Orgao | recebeu empenho daquele órgão |
| `EMPENHOU` | Orgao → Empenho | empenho emitido |
| `LOTADO_EM` | Servidor → Orgao | lotação |
| `É` | Servidor ↔ Pessoa | servidor é a mesma pessoa física |
| `MEMBRO_COMISSAO` | Servidor → Licitacao | integrou comissão de licitação |
| `FISCAL_DE` | Servidor → Contrato | fiscal do contrato |
| `DOOU_PARA` | EmpresaGrupo/Pessoa → Pessoa(agente) | doação de campanha (TSE) |
| `PUBLICOU` | AtoDOM → Contrato/Licitacao/Servidor | ato no DOM referente |
| `BENEFICIA` | Norma → EmpresaGrupo/Orgao | norma cria exceção que favorece (derivada) |
| `SANCIONADA` | EmpresaGrupo → cadastro CEIS/CNEP | empresa inidônea |

**Distinção importante:** arestas **factuais** (vêm direto de uma fonte:
`SOCIO_DE`, `VENCEU`, `EMPENHOU`) vs. arestas **derivadas** (calculadas pelo
correlator: `SOCIO_COMUM`, `BENEFICIA`). Derivadas carregam `_meta` com a regra
e a versão que as gerou, para serem recalculáveis e auditáveis.

### 2.3 Consultas de grafo de alto valor

Cada consulta abaixo é um **insight que nenhum detector isolado produz**.
Numeradas `G##` para virarem itens do catálogo (junto aos `A##`/`H##`).

**G01 — Sócio em comum entre concorrentes do mesmo certame.**
> Caminho: `EmpresaGrupo A` —`PARTICIPOU_DE`→ `Licitacao L` ←`PARTICIPOU_DE`—
> `EmpresaGrupo B`, **e** existe `Pessoa P` com `SOCIO_DE` para A **e** para B.
Indício de competição figurativa — "as duas empresas que disputaram têm o
mesmo dono". É a forma de conluio mais citada na literatura
([Linkurious](https://linkurious.com/blog/fraud-use-cases-graph-analytics/)).
Severidade alta. *Depende de scraping de edital (lista de participantes).*

**G02 — Autocontratação / conflito de interesse.**
> `Servidor S` —`MEMBRO_COMISSAO`→ `Licitacao L` ←`VENCEU`— `EmpresaGrupo E`,
> **e** `S` —`É`→ `Pessoa P` —`SOCIO_DE`→ `E`.
Membro da comissão é sócio da vencedora (detector H01). Variante:
`S` —`FISCAL_DE`→ `Contrato` da empresa em que é sócio. Severidade máxima.

**G03 — Doador de campanha → vencedor de licitação.**
> `EmpresaGrupo E` —`DOOU_PARA`→ `Pessoa(gestor)`, **e** `E` —`VENCEU`→
> `Licitacao` no mandato desse gestor (detector H06).
Cruzamento TSE × contratos. Severidade alta; peso extra se a doação é recente
e o contrato é grande. *Depende do conector TSE (Fase 2).*

**G04 — Servidor ligado a fornecedor (nepotismo econômico).**
> `Servidor S` —`É`→ `Pessoa P`; `P` —`SOCIO_DE`→ `E`, **e** `E`
> —`FORNECEU_A`→ qualquer `Orgao`. Variante por parentesco: `P` e um sócio de
> `E` compartilham sobrenome + endereço.
O servidor (ou parente) é sócio de empresa que vende para a Prefeitura.

**G05 — Empresa que migra entre secretarias.**
> `EmpresaGrupo E` —`FORNECEU_A`→ {`Orgao₁`, `Orgao₂`, … `Orgaoₙ`} com `n`
> alto **e** objetos heterogêneos (CNAE da empresa cobre só um deles).
Empresa que vende limpeza para a Saúde, evento para a Cultura e material para a
Educação — *generalista demais*. Pode ser legítimo (distribuidora ampla) ou
indício de empresa "carregadora" de contratos. Cruzar com CNAE: se o objeto
foge do CNAE, sobe o peso.

**G06 — Anel de fornecedores (componente conexo suspeito).**
> Rodar detecção de **componentes conexos** sobre o subgrafo só de arestas
> `SOCIO_COMUM` + `MESMO_ENDERECO` + `MESMO_CONTATO` + `MESMO_CONTADOR`.
> Componentes com ≥3 empresas que **também** disputaram os mesmos certames são
> candidatos a anel de bid-rigging.
É a generalização de G01 — não dois, mas um *cluster* de fachadas alternando
vitórias. GraphSAGE/GNN sobre o grafo bipartite licitante×licitação é o
estado-da-arte aqui, mas exige rótulos; para o NEXO, **componentes conexos +
regra é suficiente e explicável**
([SpringerLink](https://link.springer.com/chapter/10.1007/978-3-031-82427-2_3)).

**G07 — Empresa nova com contrato relevante.**
> `EmpresaGrupo E` com `dataAbertura` < 180 dias antes da 1ª `VENCEU`/primeiro
> `FORNECEU_A`, e valor acumulado acima de um piso.
Detector A07 elevado a consulta de grafo — porque o nó já carrega a data.

**G08 — Caminho doador → norma → benefício.**
> `Pessoa/Empresa` —`DOOU_PARA`→ `Pessoa(legislador/gestor)`, esse agente
> associado a `Norma` que `BENEFICIA` `EmpresaGrupo` ligada ao doador
> (detector H08). Caminho de 3–4 saltos; raro, mas altíssima severidade.

**G09 — Fornecedor sancionado dentro da rede ativa.**
> `EmpresaGrupo E` —`SANCIONADA`→ CEIS/CNEP, **e** `E` —`FORNECEU_A`→ `Orgao`
> com empenho posterior à data da sanção (detector A09/D06). Também: empresa
> *limpa* mas com `SOCIO_COMUM` para uma empresa sancionada — "sócio de
> inidônea recontratando via outra PJ".

**G10 — Concentração de fiscal/atestador.**
> `Servidor S` —`FISCAL_DE`→ muitos `Contrato` de um mesmo `EmpresaGrupo`, ou
> atesta volume desproporcional de liquidações. Cruza com a red-flag das
> transcrições: "pagamentos atestados pelo mesmo fiscal em grande volume".

### 2.4 Métricas de grafo (sinais estruturais)

Além de consultas por padrão, **métricas topológicas** geram sinais:

- **Grau ponderado de um fornecedor** — soma de valor das arestas
  `FORNECEU_A`. Já é o ranking de concentração, mas no grafo.
- **Centralidade de intermediação (betweenness) de uma Pessoa.** Pessoa com
  alta intermediação conecta muitos clusters de empresas — possível "operador"
  que costura grupos formalmente separados. Sinal de investigação, nunca
  conclusão.
- **Densidade do ego-network de uma licitação.** Se as empresas que disputaram
  um certame formam, entre si, um subgrafo muito denso (muitas arestas
  `SOCIO_COMUM`/`MESMO_ENDERECO`), a "competição" era aparente.
- **Crescimento temporal do componente.** Um cluster de fachadas que aparece
  todo de uma vez, meses antes de uma onda de licitações, é mais suspeito que
  um que existe há anos.

### 2.5 Viabilidade técnica do grafo

Não é preciso um banco de grafo dedicado na Fase 2. As coleções
`nexo_grafo_nos`/`nexo_grafo_arestas` em Firestore bastam para: (a) travessias
curtas (1–3 saltos) sob demanda na UI; (b) o job `nexo_correlator_grafo`
materializar arestas derivadas e componentes conexos diariamente. Algoritmos
mais pesados (betweenness global, GNN) rodam em batch no Cloud Run Job,
carregando o grafo em memória (o universo de Marília — milhares de nós — cabe
folgado). Visualização na UI com Cytoscape.js, como o plano já prevê.

---

## 3. Padrões temporais

Detector olha um ponto; **série temporal olha o ritmo**. Muita irregularidade
não está no valor de um empenho, mas em *quando* e em *que cadência* os
empenhos acontecem.

### 3.1 Sazonalidade de empenhos (linha de base)

Construir, por **órgão × elemento de despesa × mês**, uma série histórica de
valor empenhado. Disto saem duas coisas:

- **Perfil sazonal normal.** Merenda escolar cai em janeiro/julho (férias);
  combustível é relativamente estável; obras concentram no segundo semestre.
  Conhecer o normal é o que permite flagrar o anormal.
- **Anomalia = mês que destoa do seu próprio histórico**, não de uma média
  global. Empenho de R$ 200k em material de escritório é normal para a Saúde e
  anormal para um pequeno fundo — a comparação tem que ser *contra a própria
  série*.

> Pseudocódigo conceitual:
> ```
> serie[orgao, elemento] = valores mensais (>=24 meses ideal)
> baseline = mediana móvel + faixa robusta (mediana ± k * MAD)
> se valor_mes fora da faixa -> sinal "mês atípico" (peso ∝ desvio)
> ```
> Usar **mediana e MAD** (desvio absoluto mediano), não média e desvio-padrão:
> são robustos a outliers — e o NEXO está justamente caçando outliers, então a
> linha de base não pode ser puxada por eles.

### 3.2 Concentração no fim do exercício

Red-flag clássica (e citada nas transcrições — "liquidações concentradas no
fim do exercício"). Dois indicadores:

- **Índice de dezembro.** `valorEmpenhado(dezembro) / média(jan–nov)`. Empenho
  é instrumento de planejamento; um pico em dezembro sugere empenho "para
  segurar dotação" ou execução afobada antes do encerramento.
- **Corrida de empenhos nos últimos 5 dias úteis do exercício.** Contagem e
  valor de empenhos emitidos no apagar das luzes — cruzar com o detector de
  empenho sem liquidação (a liquidação vem só no ano seguinte como restos a
  pagar). Conecta com a red-flag "Cadê o dinheiro" / restos a pagar sem
  cobertura.

### 3.3 Concentração no fim do MANDATO

2024 foi ano eleitoral; o mandato atual vai até 2028. O **ciclo eleitoral de 4
anos** é uma dimensão temporal própria:

- **Onda de nomeações nos 90–180 dias pré-eleição** (detector E04, vedação da
  Lei 9.504/97 art. 73 V) — contar portarias de nomeação no DOM por mês e
  marcar o pico da janela vedada.
- **Empenho/contratação acelerada no último ano de mandato** — comparar o
  volume do exercício final com a média dos três anteriores, por elemento.
- **Queda de investimento em saúde/educação logo após a eleição** (detector
  C03) — o inverso: corte no ano seguinte ao pico eleitoral.
- **Publicidade institucional em ano eleitoral** — série mensal de gasto com
  publicidade; pico no semestre pré-eleição é red-flag direta das transcrições.

### 3.4 Sequências suspeitas (padrões na ordem dos eventos)

Aqui o sinal é a **ordem e o espaçamento**, não o valor:

- **Sequência de dispensas logo abaixo do limite.** Já é P1, mas visto como
  série: 7 dispensas de R$ 58–62k espaçadas regularmente ao longo do ano,
  mesmo CNPJ, mesmo objeto — o *ritmo regular* é em si um indício (planejamento
  de fracionamento, não coincidência).
- **Empenho anulado → reemitido.** `Anulação` seguida de novo `Empenho` para o
  mesmo fornecedor, valor semelhante, poucos dias depois (detector F01) —
  padrão de "ajuste" de exercício/dotação.
- **Emergencial logo após o fim de contrato previsível.** Contrato encerra em
  data conhecida; dispensa emergencial do mesmo objeto aparece dias depois
  (detector P5) — o *gap zero* entre fim do contrato e a "emergência" desmente
  a imprevisibilidade.
- **Aditivos em cadeia.** Sequência de aditivos de prazo/valor em intervalos
  curtos — a *cadência* dos aditivos importa tanto quanto o percentual
  acumulado.
- **Pagamento fora da ordem cronológica.** A série de pagamentos por fornecedor
  vs. a ordem de liquidação — fornecedor que "fura a fila" repetidamente
  (detector F02/D04, LC 131/2009).

### 3.5 Séries históricas como contexto de todo alerta

Toda vez que um detector dispara, anexar ao alerta a **série histórica do
sujeito**: "este fornecedor empenhou R$ X em 2024, R$ Y em 2025, R$ Z em 2026
(parcial)". Crescimento abrupto de faturamento com a Prefeitura é, por si, um
contexto que o revisor humano precisa ver — e que aumenta ou diminui a
prioridade do alerta.

> **Limitação honesta.** Análise de série exige histórico. Hoje vários módulos
> SMARAPD só trazem 2026; `despesa_sintetica` vai a 2017; o SICONFI tem
> histórico fiscal bom. Recomendação: **começar a empilhar snapshots agora** —
> cada coleta diária é um ponto de série futura. A análise temporal madura é
> Fase 1–2, mas o *acúmulo* tem que começar na Fase 0.

---

## 4. Modelos estatísticos

Modelos não substituem regras; eles **priorizam** e **contextualizam**. Cada
um abaixo entrega um *score parcial* que alimenta o score triplo (§6).

### 4.1 Curva ABC — concentração de itens e de fornecedores

**ABC de fornecedores (viável já, sobre empenhos 2026).** Ordenar fornecedores
por valor recebido decrescente, acumular o percentual:

- Classe A: fornecedores que somam os primeiros 80% do gasto.
- Classe B: os 80–95%.
- Classe C: a cauda.

Insight: se **pouquíssimos** fornecedores formam a classe A (cauda muito
curta), o mercado fornecedor do município é concentrado. A análise preliminar
já mostra que CPFL+M Construções+Revita concentram centenas de milhões — ABC
torna isso um indicador formal e monitorável mês a mês.

**ABC de itens de contrato de obra (Fase 2/3, exige planilha orçamentária).**
Dentro de uma obra, ordenar itens por valor. Se poucos itens concentram a maior
parte do contrato **e** esses itens estão com preço acima da referência, há
indício de **"jogo de planilha"** — concentrar a margem nos itens que serão
mais executados. É o detector P2.

### 4.2 Sobrepreço vs. referência

Modelo de razão simples, mas que só fica robusto com a base de preços:

```
razaoSobrepreco = precoUnitarioContratado / precoReferencia
faixas: >=1.15 médio · >=1.25 alto · >=1.40 crítico
```

Referências: **SINAPI/SICRO** para obras; **Banco de Preços em Saúde** para
medicamentos/insumos; **atas de outros municípios** e **contratos anteriores
do próprio município** como referência secundária. Esta última — *o histórico
de preço do próprio município para o mesmo item* — é **a referência mais
viável já**, porque sai dos próprios dados de `itensempenho` que a API entrega
via drill-down. Construir uma **série de preço unitário por item normalizado**
e flagrar saltos: "o município pagou R$ 4,20 pelo item X em 2025 e R$ 9,80 em
2026" é um indício forte sem precisar do SINAPI.

### 4.3 Lei de Benford nos valores de empenho

A Lei de Benford prevê a distribuição esperada dos **dígitos iniciais** de
conjuntos numéricos naturais (1 aparece como 1º dígito ~30,1% das vezes; 9,
~4,6%). Números *fabricados* tendem a distribuir dígitos de forma mais
uniforme, então o desvio de Benford é um **teste de plausibilidade** de um
conjunto de valores
([ACFE](https://www.acfe.com/acfe-insights-blog/blog-detail?s=what-is-benfords-law-and-why-fraud-examiners-use-it),
[Wikipedia](https://en.wikipedia.org/wiki/Benford%27s_law)).

Aplicação no NEXO:

- **Teste de 1º dígito e de 2º dígito** sobre o conjunto de `ValorEmpenho` —
  por **órgão** e por **fornecedor** (não no agregado global, que sempre passa
  por ser grande demais).
- Métrica de aderência: **MAD** (desvio absoluto médio) entre a distribuição
  observada e a de Benford. MAD baixo = conforme; MAD alto = não-conforme.
- **Teste de primeiros-dois-dígitos** focado na faixa logo abaixo dos limites
  de dispensa (R$ 62.725,59 em 2026): um *excesso* de valores começando em
  "58", "59", "60", "61", "62" é exatamente a assinatura de valores
  *escolhidos* para ficar abaixo do limite — é a Lei de Benford trabalhando a
  favor do detector de fracionamento.

> **Cautela metodológica (importante para não gerar falso positivo):**
> - Benford **exige conjunto grande** (centenas de valores) e que abranja
>   várias ordens de grandeza. Um fornecedor com 12 empenhos **não** é
>   testável — não rodar o teste abaixo de um N mínimo (sugestão: N ≥ 300 para
>   o conjunto agregado; o teste por fornecedor só para os grandes).
> - Conjuntos com **piso/teto naturais** (diárias, que têm valor tabelado;
>   contratos de valor fixo mensal) **violam Benford legitimamente**. Não
>   aplicar o teste a séries com valores tabelados.
> - Não-conformidade de Benford **não é indício de irregularidade por si só** —
>   é um **sinalizador de onde olhar com lupa**. No NEXO, o resultado de
>   Benford entra como *modificador de prioridade*, nunca como detector
>   autônomo que gera alerta. Esta é a postura correta e defensável.

### 4.4 Outliers de consumo km/l (frota)

Quando houver dados de frota (Fase 2 — depende de relatório de abastecimento,
hoje não na API): para cada veículo, `kmRodado / litros`. O modelo:

- Construir a **distribuição de km/l por tipo de veículo** (ambulância, carro
  de passeio, caminhão, máquina) — o referencial é o *tipo*, não a frota toda.
- Outlier = veículo cujo km/l cai fora da faixa robusta do seu tipo (mediana ±
  k·MAD), ou fisicamente impossível (km/l absurdamente baixo, abastecimento >
  capacidade do tanque, km zerado com consumo).
- Cruzar com posto: concentração de abastecimento num único `cnpj_posto` e
  abastecimento em fim de semana/feriado.

### 4.5 Índice de concentração de fornecedores (HHI)

O **Herfindahl-Hirschman Index** mede concentração de mercado: `HHI = Σ(sᵢ²)`,
onde `sᵢ` é a participação percentual de cada fornecedor. Varia de ~0
(competição pulverizada) a 10.000 (monopólio)
([Gatewit](https://gatewit.com/2025/11/22/using-herfindahl-hirschman-index-hhi-in-procurement-a-complete-guide/)).

Aplicação no NEXO — calcular HHI **por mercado relevante**, não no agregado:

- HHI por **elemento de despesa** (ex.: "serviços de limpeza", "combustível").
- HHI por **secretaria**.
- HHI por **modalidade** (dentro de "dispensa", quão concentrado está?).

Insight: um elemento de despesa com HHI alto significa que pouquíssimas
empresas dominam aquela compra no município — pode ser característica natural
do mercado (há poucos fornecedores de oxigênio medicinal) ou pode ser indício
de mercado fechado/cartelizado. O HHI **não acusa**; ele diz *onde a
competição é frágil*, e mercado frágil é onde o restante dos detectores deve
focar.

> Calcular HHI sobre **EmpresaGrupo** (raiz 8 díg.), não sobre estabelecimento
> — senão matriz e filial parecem concorrentes e o índice subestima a
> concentração real. Outro motivo por que a resolução de entidades (§1) vem
> antes.

### 4.6 Competitividade de licitações

O melhor indicador de risco de corrupção em compras públicas, segundo a
literatura, é de uma simplicidade desconcertante: **single bidding** —
licitação com um único participante
([arXiv, Wachs et al.](https://arxiv.org/pdf/1909.08664)). Indicadores de
competitividade a calcular (quando o scraping de editais entregar nº de
participantes — Fase 2):

- **Taxa de licitante único** por modalidade/secretaria/ano.
- **Número médio de participantes** por certame — queda ao longo do tempo é
  red-flag.
- **Taxa de uso de contratação direta** (dispensa + inexigibilidade) sobre o
  total — a análise preliminar já aponta R$ 55,7M em dispensa/dispensada e
  R$ 54,4M em inexigibilidade; transformar isso em **série mensal e em
  percentual da despesa total** é um indicador de saúde do sistema de compras.
- **"Taxa de vitória" de cada empresa** — fornecedor que ganha uma fração
  desproporcional dos certames em que aparece.
- **Alternância previsível** — duas/três empresas que se revezam ganhando
  (cruza com G06). A literatura usa a "alta frequência de participação
  conjunta" de um par de licitantes como rótulo de conluio
  ([Springer, GraphSAGE](https://link.springer.com/article/10.1007/s42001-024-00293-4)).

### 4.7 Um índice composto: Corruption Risk Indicator (CRI) por contrato

A literatura consolida vários sinais num **Corruption Risk Index** por
processo/contrato — uma métrica objetiva da probabilidade de risco
([Springer, mapeamento sistemático](https://link.springer.com/article/10.1140/epjds/s13688-025-00569-3)).
Recomendação: o NEXO ter um **CRI** por contrato como camada acima dos
detectores, somando (com pesos versionados) sinais binários/contínuos:
licitante único, contratação direta, empresa nova, valor logo abaixo do limite,
prazo de publicação curto, vencedor recorrente, aditivo alto, sobrepreço. O CRI
não substitui o score triplo — ele **alimenta** a "probabilidade de
irregularidade" (§6) de forma transparente e explicável item a item.

---

## 5. Insights cross-source

Aqui está o diferencial declarado do plano-mestre: cruzar fontes que, isoladas,
parecem normais. Cada cruzamento abaixo amplia ou refina os detectores `H##`.

### 5.1 DOM × Portal da Transparência

O Diário Oficial já está indexado — é a fonte mais madura. Cruzamentos:

- **Dispensa/inexigibilidade no DOM sem empenho no portal** (e vice-versa).
  Toda contratação direta deve ter publicidade *e* execução; a ausência de um
  dos lados é inconsistência documental (detectores H02/H03).
- **Extrato de contrato no DOM × contrato no portal** — contrato pago sem
  publicação, ou publicado sem execução registrada.
- **Decreto de crédito adicional no DOM × empenhos subsequentes** — empenhos
  amparados por crédito aberto precisam estar no prazo legal.
- **Portaria de nomeação/exoneração no DOM × folha** — portaria de nomeação
  sem servidor correspondente na folha (H04), ou servidor na folha sem portaria
  publicada. Cruza com a red-flag do "servidor fantasma".
- **Cadência de publicação.** O DOM como série: pico de portarias antes da
  eleição (§3.3); decreto publicado fora de horário/dia útil.

### 5.2 TSE × Contratos

Conector TSE (doações de campanha — Fase 2). O grande cruzamento G03/H06:
empresa (ou seus sócios) que doou para a campanha do gestor **e** depois venceu
licitação/recebeu empenho no mandato. Refinamentos:

- Ligar não só o **doador direto**, mas **sócios do doador** e **empresas com
  sócio comum ao doador** — a doação pode vir de uma PJ e o contrato ir para
  outra do mesmo grupo (por isso o grafo, §2).
- Peso por **proximidade temporal** (doação no ciclo eleitoral imediatamente
  anterior) e por **materialidade** (valor do contrato).
- Cruzar também com **doadores de campanha de vereadores** — emenda
  parlamentar que vai para fornecedor que doou para o autor da emenda.

### 5.3 CEIS/CNEP/CEPIM × Pagamentos

Cadastros federais de empresas inidôneas/sancionadas (Fase 2; o subsistema de
Empresas Sancionadas já migra para o NEXO). Cruzamentos:

- **Empresa em CEIS/CNEP recebendo empenho/pagamento** após a data de início
  da sanção (detectores A09/D06, G09).
- **Sócio de empresa sancionada** abrindo/operando outra PJ que contrata com o
  município — "troca de fachada". Só visível via grafo: `EmpresaGrupo limpa`
  —`SOCIO_COMUM`→ `EmpresaGrupo sancionada`.
- **Empresa com situação cadastral CNPJ ≠ ATIVA** (baixada, inapta, suspensa)
  recebendo pagamento — vem do enriquecimento BrasilAPI, viável já.

### 5.4 Folha × CNPJ (servidor ↔ empresário)

O cruzamento mais sensível à LGPD — sempre com dados mascarados na UI e
rotulado "requer confirmação documental":

- **Servidor (ou parente próximo) sócio de fornecedor** (G04/D02). Ligação por
  CPF quando visível; por nome + sobrenome + endereço quando não — sempre sinal
  fraco até confirmação.
- **Ex-servidor que sai da folha e passa a receber como PJ** (detector H05) —
  série temporal: nome desaparece da folha no mês M, CNPJ com sócio de mesmo
  nome começa a receber empenhos no mês M+k.
- **Sobrenome de gestor entre servidores comissionados de livre nomeação**
  (nepotismo, Súmula Vinculante 13 — E06).
- **Mesma pessoa em duas folhas / acúmulo** — resolução de servidor por CPF
  (§1.5) já entrega isso.

### 5.5 Outros cruzamentos de alto valor

- **SICONFI × execução do portal** — o que o município *declara* à STN (RREO/
  RGF) vs. o que aparece no portal de transparência. Divergência entre o
  declarado e o executado é red-flag fiscal ("saldo contábil ≠ extrato").
- **SAPL × fornecedores** — norma municipal alterada que cria exceção
  beneficiando fornecedor específico em janela curta (H08/G08).
- **Editais (Tier B) × empenhos** — exigência técnica do edital × CNAE/porte do
  vencedor: edital "sob medida" para uma empresa específica.
- **Obras anunciadas (site/notícias) × contrato × medição × pagamento** — obra
  divulgada sem contrato localizável; pago sem medição; parada com pagamento
  recente.
- **e-SIC/Ouvidoria × execução** — pico de reclamação sobre falta de
  medicamento numa unidade × compra recente paga daquele medicamento (cruza com
  P4: "comprou e pagou, mas falta na ponta").

---

## 6. Refinamento do score triplo e redução de falso positivo

O plano-mestre §7 define os três indicadores. O PRISMA propõe **como
calculá-los de forma calibrada e explicável**, e **como cortar falso positivo**
— que é o risco reputacional nº 1 do projeto.

### 6.1 Os três scores — papéis distintos, nunca somar num número só

| Score | Pergunta que responde | Natureza |
|---|---|---|
| **Confiabilidade documental** | "Quão sólida é a prova?" | Cresce com qualidade de fonte |
| **Probabilidade de irregularidade** | "Quão atípico é o padrão?" | Cresce com desvio estatístico |
| **Probabilidade de enquadramento** | "Os elementos da norma aparecem?" | Cresce com aderência a um tipo legal |

Mantê-los **separados** é deliberado e correto: um achado pode ter prova
fortíssima (confiabilidade 95) de um fato que é só *atípico*, não ilegal
(enquadramento 20). Misturar tudo num número esconde isso e produz acusação
disfarçada de estatística.

### 6.2 Confiabilidade documental — proposta de cálculo

Soma de evidências presentes, teto 100:

```
+25 documento oficial / fonte primária (API gov, DOM, SICONFI)
+15 URL preservada + hash do conteúdo + timestamp de coleta
+20 corroboração por >=2 fontes independentes
+15 dado estruturado (não extraído por OCR/heurística frágil)
+15 cadeia de execução completa (empenho->liquidação->pagamento)
+10 sujeito identificado com chave forte (CNPJ/CPF/matrícula resolvido)
-20 dado proveniente de scraping frágil sem corroboração
-15 entidade resolvida só por nome (confiança de resolução < 0.9)
```

A confiabilidade **cai** quando o achado depende de scraping frágil ou de
resolução de entidade incerta — isso conecta a calibração diretamente à
camada §1.

### 6.3 Probabilidade de irregularidade — proposta de cálculo

Aqui entram os modelos estatísticos do §4 como **fatores explícitos e
ponderados**:

```
componente determinístico (do detector que disparou): severidadeBase * 12
+ fator repetição          (nº de ocorrências do padrão, saturando)
+ fator materialidade      (valor financeiro, escala logarítmica)
+ fator proximidade-limite (quão colado ao limite legal de dispensa)
+ fator concentração       (posição do fornecedor na curva ABC / HHI do mercado)
+ fator temporal           (fim de exercício/mandato; sazonalidade rompida)
+ fator grafo              (densidade suspeita na vizinhança; sócio comum)
+ fator Benford            (não-conformidade do conjunto — modificador leve)
- fator justificativa      (existe processo/parecer/pesquisa de preço publicado)
```

**Decisões de calibração que reduzem falso positivo:**

- **Saturação, não soma linear.** O 10º empenho do mesmo padrão não pesa como o
  3º. Cada fator satura num teto — senão um fornecedor grande e legítimo
  acumula score só por ser grande.
- **Normalizar pelo mercado, não pelo absoluto.** "Atípico" é em relação ao
  *par* (mesmo elemento, mesmo porte de órgão), via mediana/MAD da série — não
  contra uma constante global.
- **Fator justificativa abate o score.** Se o processo administrativo, o
  parecer jurídico ou a pesquisa de preço **estão publicados**, a probabilidade
  de irregularidade *desce*. O sistema tem que premiar a transparência: a
  ausência de documento é que é indício, não a contratação em si.

### 6.4 Probabilidade de enquadramento — proposta de cálculo

Checklist de **elementos objetivos** do tipo legal candidato — sem nunca inferir
dolo (Lei 14.230/2021 exige dolo específico; o sistema não o afirma):

```
para a hipótese legal candidata, marcar presença de:
[ ] conduta identificável (ato administrativo concreto)
[ ] agente identificável
[ ] valor / materialidade
[ ] violação de rito (modalidade errada, prazo, ausência de etapa)
[ ] dano potencial ao erário (estimável)
[ ] ausência de motivação/justificativa
[ ] beneficiário identificável
enquadramento = (elementos presentes / elementos do tipo) * 100
rótulo obrigatório: "elemento subjetivo (dolo) pendente de análise humana"
```

### 6.5 Promoção a investigação — manter o gatilho, com guarda

O gatilho do plano-mestre permanece:

```
confiabilidade >= 70  E  prob_irregularidade >= 60
E ( >=2 fontes independentes  OU  valor relevante  OU  repetição )
```

Acrescentar uma **trava de qualidade**: não promover se a entidade-sujeito tem
`confiancaResolucao < 0.85` — antes, exigir confirmação da identidade. Promover
investigação sobre a empresa errada é o pior falso positivo possível.

### 6.6 Sete mecanismos concretos de redução de falso positivo

1. **Whitelist contextual / supressão de ruído conhecido.** CPFL (energia),
   contratos de concessionária, folha de pessoal regular — gastos
   estruturalmente grandes e legítimos não devem inflar rankings de risco.
   Manter uma lista de exceções *justificada e versionada* (cada item com
   motivo e data), nunca uma exclusão silenciosa.
2. **N mínimo para modelos estatísticos.** Benford, ABC, HHI, sazonalidade só
   rodam acima de um tamanho de amostra. Abaixo dele, o modelo **não opina** —
   não chuta.
3. **Normalização por pares.** Sempre comparar contra o semelhante (mesmo
   elemento/porte), com estatística robusta (mediana/MAD).
4. **Fator justificativa.** Documento publicado abate o score (§6.3).
5. **Lista de endereços/contadores "ruidosos".** Coworkings e contabilidades
   compartilhadas têm peso de aresta rebaixado (§1.3).
6. **Exigir corroboração para os achados de severidade máxima.** Sinal de uma
   fonte só, não estruturado, fica em "atenção" — não escala a "crítico"
   sozinho.
7. **Feedback loop com o gabinete.** Cada alerta marcado pelo revisor como
   `falso_positivo` realimenta a calibração: ajustar pesos/limiares dos fatores
   que mais geram falso positivo. É o caminho para o NEXO **aprender com o uso**
   sem virar caixa-preta — os pesos continuam explícitos e auditáveis (não é
   ML opaco). O `modulo_investiga` e o roadmap Fase 3 já preveem esse loop;
   aqui ele ganha função de calibração estatística.

### 6.7 Explicabilidade — inegociável

Todo score exibido deve vir com a **decomposição dos fatores** que o
formaram ("+18 repetição, +12 materialidade, +15 sócio comum, -10
justificativa publicada"). Score sem decomposição é opinião disfarçada de
número — e contraria o princípio "indício nasce de dado, comparação e
repetição, nunca de opinião". A literatura de antitruste computacional caminha
na mesma direção: ferramentas modernas (BRAVA) acoplam LIME/SHAP justamente
para tornar cada pontuação explicável
([Network Law Review](https://www.networklawreview.org/computational-antitrust-evidence/)).

---

## 7. O que recomendo acrescentar ao plano-mestre

Síntese para o ORÁCULO consolidar:

1. **Elevar "Resolução de Entidades" a etapa própria da arquitetura** (§4.1),
   entre Normalização e Indexação — `[2.5] Resolução de Entidades`. Hoje está
   diluída; é pré-requisito de grafo, modelos e cruzamentos, e merece status de
   camada.
2. **Acrescentar duas coleções ao modelo de dados** (§5): `nexo_entidades`
   (registro canônico resolvido, com `confiancaResolucao`) e `nexo_merges_log`
   (decisões de merge/ligação — auditável e reversível).
3. **Modelar fornecedor em dois níveis** — `EmpresaGrupo` (raiz 8 díg.) e
   `Estabelecimento` (14 díg.) — e rodar detectores e HHI no nível de grupo.
   Resolve o caso HU (fracionamento por filial) de forma estrutural.
4. **Adicionar nós e arestas faltantes ao grafo** (§5/§6): nós `Endereco`,
   `Contador`, `DoacaoCampanha`; arestas `SOCIO_COMUM`, `MESMO_ENDERECO`,
   `MESMO_CONTADOR`, `DOOU_PARA`, `MEMBRO_COMISSAO`, `FISCAL_DE`. Distinguir
   arestas factuais de derivadas.
5. **Catalogar as consultas de grafo `G01–G10`** como família própria no
   catálogo de detecção, ao lado dos `A##`/`H##` — são detectores de
   correlação, responsabilidade do PRISMA junto ao VÉRTEX.
6. **Criar o subsistema de Modelos Estatísticos** com N mínimo de amostra
   declarado por modelo (ABC, sobrepreço-vs-histórico, Benford, km/l, HHI,
   competitividade) e um **CRI por contrato** que alimenta o score de
   probabilidade de forma explicável.
7. **Tornar a série temporal cidadã de primeira classe.** Começar a empilhar
   snapshots desde a Fase 0 (cada coleta é um ponto futuro de série) e
   adicionar ao painel: índice de dezembro, ciclo de mandato, sazonalidade por
   órgão×elemento. Já está parcialmente no subsistema de Metas Fiscais;
   estender aos empenhos.
8. **Formalizar a doutrina anti-falso-positivo** (§6.6) como seção do
   plano-mestre: lista de exceções versionada, N mínimo, normalização por
   pares, fator justificativa, trava de `confiancaResolucao`, feedback loop de
   calibração. O risco reputacional do §12 merece contramedida explícita.
9. **Explicabilidade obrigatória de todo score** — decomposição em fatores
   visível na UI e no dossiê. Acrescentar como 7º princípio inegociável (§2) ou
   como requisito do §7.
10. **Marcar dependências de fase com honestidade.** Benford/HHI/competitividade
    só amadurecem com histórico e com nº de licitantes (scraping de editais).
    O plano deve deixar claro o que entrega valor na Fase 1 (resolução de
    entidades, grafo de sócios via BrasilAPI, ABC de fornecedores, cruzamento
    DOM×Portal, série a partir do que houver) e o que é Fase 2/3.

### Os insights de maior valor (priorização para o ORÁCULO)

Por relação valor/viajabilidade, na ordem em que entregam resultado:

1. **Resolução de fornecedor em dois níveis (grupo/estabelecimento)** —
   destrava tudo; viável já com os dados de empenho.
2. **Grafo de sócios via BrasilAPI** — `SOCIO_COMUM` e componentes conexos
   (G01, G06) são o diferencial declarado do projeto e a BrasilAPI já está
   pronta.
3. **Cruzamento DOM × Portal** — fonte mais madura (DOM já indexado), pega
   inconsistência de publicidade vs. execução.
4. **ABC e HHI de fornecedores** — transformam "R$ 55,7M em dispensa" da
   análise preliminar em indicador monitorável.
5. **Série de preço unitário do próprio município** (sobrepreço sem depender de
   SINAPI) — referência mais barata e disponível para o detector de obras/saúde.
6. **Fim de exercício / ciclo de mandato** — padrão temporal de alto sinal, e
   2024 foi ano eleitoral.
7. **TSE × contratos (G03)** e **folha × CNPJ (G04)** — altíssima severidade,
   mas dependem de conectores de Fase 2; preparar o grafo desde já para
   recebê-los.

---

## Disclaimer

> Este documento descreve técnicas de análise estatística e de correlação de
> dados públicos. Todos os modelos, consultas de grafo e scores aqui propostos
> produzem **indícios e padrões estatisticamente atípicos** que podem (ou não)
> indicar irregularidades. Nada aqui constitui acusação, prova de improbidade
> ou de ilícito. Correlação não é causa; coincidência de atributos (endereço,
> sócio, nome) não é, por si, prova de conluio. Todo indício deve passar por
> revisão humana e ser apurado pelas instituições competentes (TCE-SP,
> Ministério Público, Controladoria) antes de qualquer juízo de valor.

---

## Fontes (técnicas de detecção consultadas)

- [Detection of fraud in public procurement using data-driven methods: a systematic mapping study — EPJ Data Science / Springer](https://link.springer.com/article/10.1140/epjds/s13688-025-00569-3)
- [Public Sector Entity Resolution and Fraud Detection — Senzing](https://senzing.com/public-sector-entity-resolution/)
- [Stop contract and procurement fraud — SAS](https://www.sas.com/en_us/insights/articles/risk-fraud/stop-contract-and-procurement-fraud.html)
- [Fraud use cases for graph analytics — Linkurious](https://linkurious.com/blog/fraud-use-cases-graph-analytics/)
- [Public Procurement Collusion Identification Based on GraphSAGE — Springer](https://link.springer.com/chapter/10.1007/978-3-031-82427-2_3)
- [A machine learning approach to detect collusion in public procurement with limited information — Springer](https://link.springer.com/article/10.1007/s42001-024-00293-4)
- [Computational Antitrust: Evidence From 25 Antitrust Agencies (BRAVA) — Network Law Review](https://www.networklawreview.org/computational-antitrust-evidence/)
- [What Is Benford's Law and Why Do Fraud Examiners Use It? — ACFE](https://www.acfe.com/acfe-insights-blog/blog-detail?s=what-is-benfords-law-and-why-fraud-examiners-use-it)
- [Benford's law — Wikipedia](https://en.wikipedia.org/wiki/Benford%27s_law)
- [Using the Herfindahl-Hirschman Index (HHI) in Procurement — Gatewit](https://gatewit.com/2025/11/22/using-herfindahl-hirschman-index-hhi-in-procurement-a-complete-guide/)
- [Corruption Risk in Contracting Markets: A Network Science Perspective (single bidding) — Wachs et al., arXiv](https://arxiv.org/pdf/1909.08664)
- [Pattern Mining for Anomaly Detection in Graphs: Application to Fraud in Public Procurement — arXiv](https://arxiv.org/pdf/2306.10857)
