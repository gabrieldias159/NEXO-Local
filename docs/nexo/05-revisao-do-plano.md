# NEXO — Revisão Crítica e Aprofundamento Estratégico do Plano

**Documento 05 · Revisão do Plano-Mestre**
Câmara Municipal de Marília/SP — Gabinete Vereador Fefin
Autor: ORÁCULO (Chefe de Inteligência de Dados) · 2026-05-21 · v1.0

> Este documento revisa criticamente `docs/nexo-plano-mestre.md` (v1.0),
> `docs/nexo-equipe.md`, e os três documentos técnicos de origem. Não substitui
> o plano-mestre — **emenda-o**. Onde houver conflito, vale o que está aqui,
> até que o plano-mestre seja atualizado para v1.1.

---

## 0. Como ler este documento

Quatro blocos, na ordem pedida:

1. **Validação crítica** — lacunas, erros, riscos subestimados, problemas de
   sequenciamento. Seção 1.
2. **Novas features** — funcionalidades que o plano não tem, priorizadas por
   valor × esforço. Seção 2.
3. **Validação de faseamento** — crítica do roadmap Fases 0–3 e quick wins.
   Seção 3.
4. **Governança & risco** — trilho jurídico, LGPD, segurança de acesso, risco
   reputacional, conferido contra a norma vigente. Seção 4.

Fecha com um **plano-mestre v1.1 proposto** (seção 5) e um **resumo executivo**
(seção 6).

Convenção de severidade dos achados: **[BLOQUEADOR]** corrige antes de Fase 0 ·
**[ALTO]** corrige na Fase 0/1 · **[MÉDIO]** ajustar quando tocar a área ·
**[INFO]** observação para o backlog.

---

## 1. Validação crítica do plano-mestre

O plano-mestre v1.0 é sólido na visão e no trilho jurídico, e a destilação das
transcrições do advogado em catálogo de detectores é o maior acerto do projeto.
Mas há erros factuais, lacunas estruturais e otimismos de sequenciamento que,
se não corrigidos agora, custam caro depois. Vão na ordem do impacto.

### 1.1 [BLOQUEADOR] Os limites de dispensa de 2026 estão errados no plano

O plano-mestre §1 afirma, como "correção herdada das transcrições", que os
limites de dispensa de 2026 são **R$ 62.725,59** (compras/serviços) e
**R$ 125.451,15** (obras/engenharia).

**Esses valores estão incorretos.** O **Decreto nº 12.807/2025**, publicado no
DOU em 30/12/2025 e vigente desde 01/01/2026, fixou:

| Hipótese (Lei 14.133/2021 art. 75) | Limite 2026 correto |
|---|---|
| Inc. I — obras e serviços de engenharia | **R$ 130.984,20** |
| Inc. II — demais compras e serviços | **R$ 65.492,11** |
| Serviços técnicos de natureza intelectual | R$ 392.952,63 |
| Grande vulto | R$ 261.968.421,04 |

O plano corrigiu a constante de 2024 (R$ 57.500) mas registrou números de 2026
que não batem com o decreto vigente. **A causa-raiz é exatamente o anti-padrão
que o próprio plano alerta** — usar valores de cabeça em vez da tabela oficial.
Isso é grave: o limite é o coração do detector P1 (fracionamento). Errar em
R$ 2.766 por contratação produz **falso positivo e falso negativo sistemáticos**
no detector mais usado do sistema.

**Ação:** VÉRTEX monta a `tabela de limites por exercício` lendo dos **decretos
federais** (2024 = Dec. 11.871/2023; 2026 = Dec. 12.807/2025; e o que vier para
2027), não das transcrições. Cada linha da tabela guarda: exercício, inciso,
valor, número do decreto, data de publicação, URL. O detector cita o decreto na
evidência. Backlog Fase 0 #7 vira **#1-bis (bloqueador)**.

### 1.2 [BLOQUEADOR] Filtro server-side da API SMARAPD retornou 400 — e o plano não dimensionou a consequência

`transparencia-api-reference.md` §8 e `analise-preliminar.md` §9 registram que
o array `Filtros` no `POST /modulovisao/filter` devolve **400 Bad Request**.
Consequência real, não cosmética:

- **Toda detecção exige varredura completa.** Para cruzar 90 dias de dispensas
  é preciso baixar o módulo inteiro. `fornecedor` = 15.558 registros/ano ÷ 100
  por página = **156 requisições**; a 2 req/s isso é ~78 s só de um módulo, num
  exercício. Multiplicado por módulos × exercícios da série histórica, a janela
  de coleta cresce rápido.
- **A re-detecção não pode reconsultar a API.** Tem que rodar 100% sobre o
  snapshot no Firestore. O plano já prevê snapshots brutos — bom — mas não diz
  explicitamente que **o motor de detecção nunca toca a rede**. Precisa virar
  regra de arquitetura: detector lê Firestore, ponto.
- **Custo de leitura do Firestore.** Re-detecção em lote varrendo `nexo_empenhos`
  inteiro, diariamente, é dezenas de milhares de document reads por execução.
  Sem uma camada de agregados (ver feature F8) isso vira conta no fim do mês.

**Ação:** FANTASMA deve, na Fase 0, (a) fazer um teste de exaustão do parâmetro
`QuantidadeRegistros` — o doc diz "500 por página" num lugar e "100 confirmado"
em outro; resolver essa contradição vale 5× no tempo de coleta; (b) testar
variações do `Filtros` (talvez a sintaxe esteja errada, não o recurso ausente —
testar `FiltroRedirecionaVisao` já funciona, então o backend aceita *algum*
filtro). O plano deve assumir o pior (sem filtro) mas não desistir sem testar.

### 1.3 [ALTO] O plano não tem camada de detecção de mudança (diff temporal)

A frase-guia do projeto é "linha do tempo auditável" e "identificar padrões
**antes que desapareçam**". O `modulo_investiga.md` §2A e o prompt original
pedem explicitamente "controle de versão" e "detecção de mudanças". **O plano-
mestre v1.0 perdeu isso.** Ele guarda snapshots brutos (bom) mas não descreve
nenhum processo que **compare snapshot N com snapshot N-1** e gere um evento.

Isso é uma lacuna grave, porque os achados mais valiosos são *deltas*:

- Um empenho que **mudou de valor** entre duas coletas.
- Um contrato que **ganhou um aditivo** desde ontem.
- Um edital cuja data de sessão **foi alterada** depois de publicado.
- Um registro de despesa que **sumiu** do portal (retroação silenciosa de dado
  público é, por si só, uma red flag).
- Um servidor que **saiu da folha** entre dois meses (gatilho do cruzamento
  "saiu da folha mas recebe como PJ").

**Ação:** adicionar a camada **[1.5] Diff** entre Snapshot e Normalização. Cada
conector, ao gravar um snapshot, compara o hash de cada chave natural com o
hash anterior; chaves novas / alteradas / removidas viram registros em
`nexo_mudancas`. Vários detectores passam a consumir `nexo_mudancas` em vez de
varrer tudo — o que **também ataca o problema 1.2** (re-detecção incremental
barata). Esta é a correção arquitetural mais importante deste documento.

### 1.4 [ALTO] Resolução de entidades está atribuída mas não tem lugar no pipeline

`nexo-equipe.md` dá a PRISMA o mandato de "resolução de entidades: deduplicar
fornecedores, secretarias, servidores". O `modulo_investiga.md` §4 inteiro
depende disso ("Secretaria da Saúde" = "Fundo Municipal de Saúde" = "SMS";
fornecedor por CNPJ raiz × razão social × sócios). **Mas o pipeline de 8
camadas do §4.1 não tem uma etapa de resolução de entidades.** Ela está
implícita em "Normalização", que é pouco — resolução de entidades é um passo
com estado próprio (tabelas de apelidos, blocking, scoring de match).

Sem isso, três coisas quebram:
- O detector de fracionamento "pulverizado entre secretarias" não funciona se
  cada secretaria aparece com 4 grafias.
- O grafo de correlações vira ruído (mesmo sócio com nome em 3 formatos = 3
  nós).
- "HU com 3 CNPJs" (achado real da análise preliminar) precisa de CNPJ raiz
  para ser tratado como uma entidade com 3 estabelecimentos.

**Ação:** inserir camada **[2.5] Resolução de Entidades** entre Normalização e
Indexação. Coleções `nexo_entidades_orgao`, `nexo_entidades_fornecedor` (chave
= CNPJ raiz 8 dígitos), `nexo_entidades_pessoa`. Manter um dicionário de
apelidos curado por LASTRO. Toda referência nas demais coleções aponta para o
ID canônico da entidade, não para a string crua.

### 1.5 [ALTO] Não há definição de quem usa o sistema nem de modelo de acesso

O plano descreve uma "war room" e fala em "revisão humana obrigatória", mas
**nunca define os papéis de usuário**. Quem entra no `/nexo`? Só o vereador? A
assessoria toda? Quem pode promover alerta a investigação? Quem marca falso
positivo? O `oficioexpress` é multi-tenant (a memória do projeto fala em
"cross-tenant") — o NEXO precisa de uma resposta explícita.

Isso não é detalhe de UI: é **pré-requisito de governança** (seção 4.3) e de
**trilha de auditoria** (feature F4). Sem papéis definidos, "revisão humana
obrigatória" é uma frase sem dono.

**Ação:** o plano v1.1 deve fixar pelo menos três papéis — **Leitor**
(vê painéis e dossiês), **Analista** (promove alerta→investigação, edita
dossiê, marca falso positivo), **Chefe de Gabinete/Vereador** (aprova dossiê,
autoriza geração de requerimento). Toda ação sensível registra autor. Ver 4.3.

### 1.6 [ALTO] O ciclo termina no requerimento — falta o ciclo de vida pós-protocolo

O plano vai brilhantemente de alerta → investigação → dossiê → requerimento. E
**para aí.** Mas a fiscalização real continua: o requerimento é **protocolado**,
a Prefeitura **responde (ou não responde no prazo)**, a resposta **confirma ou
derruba** o indício, e isso **deveria realimentar o score** do fornecedor/órgão.

Sem fechar esse loop:
- O sistema nunca aprende que um indício foi confirmado ou refutado (o
  feedback loop da Fase 3 é só "útil/inútil", o que é mais raso).
- Não há como medir a **eficácia do gabinete** (quantos requerimentos viraram
  resposta, quantos indícios se confirmaram).
- Não há gatilho para o caso clássico: **Prefeitura não respondeu no prazo do
  art. 32 da LOM / prazo da LAI** — que é, em si, um novo indício e munição
  política.

**Ação:** estender o ciclo para `alerta → investigação → dossiê → requerimento
→ protocolo → resposta → desfecho (confirmado | refutado | sem resposta |
parcial)`. O desfecho ajusta o histórico da entidade. Ver feature F9.

### 1.7 [MÉDIO] Inconsistências internas e dívidas de nomenclatura

- **Limite de R$ 57.900 vs R$ 57.500.** `analise-preliminar.md` §7 usa
  R$ 57.900; o detector A02 e o plano usam R$ 57.500. Nenhum dos dois importa
  mais (ver 1.1), mas mostra que valores legais foram digitados à mão em três
  documentos. A tabela única resolve — e os docs antigos devem ser marcados
  como superados.
- **Duas numerações de detectores convivem.** A arquitetura v1.0 usa A01–H08;
  o plano-mestre usa P1–P6; a api-reference usa A01–H02 com *outro* significado
  para os mesmos códigos (A04 = "alto % dispensa" na api-reference, mas A04 =
  "prazo de publicação" na arquitetura). **Isso vai gerar bug.** Travar UM
  esquema de IDs (sugestão: `P{n}-D{nn}`, processador-detector) e reescrever os
  outros docs como referência cruzada.
- **`despesa_viagem`/`passagenslocomocao` é um módulo confirmado e não está
  mapeado a nenhum processador.** Passagens e locomoção é par natural de
  diárias (P6) e de frota (P3). Incluir.
- **`patrimonio_mobiliario` e `seguranca/publicidadedigital` retornaram 0
  registros.** O plano não diz o que fazer com módulos vazios — devem entrar
  numa watchlist de "módulo a monitorar: pode ser populado no futuro", não ser
  esquecidos.
- **Modalidade é código numérico** (`50`, `90`) sem tabela de-para. Isso está
  listado como limitação mas **não vira item de backlog**. Sem o de-para, todo
  detector que filtra por modalidade (P1, P5, e o cálculo de % dispensa) está
  cego. É item de Fase 0.

### 1.8 [MÉDIO] Riscos reais subestimados ou ausentes na seção 12

A seção 12 do plano lista 5 riscos. Faltam, no mínimo:

- **Falso negativo é tão grave quanto falso positivo, e é invisível.** O plano
  só se preocupa com falso positivo (risco reputacional). Mas um sistema que
  *não vê* uma irregularidade dá ao gabinete uma falsa sensação de cobertura.
  Mitigação: documentar explicitamente a **cobertura** de cada detector (o que
  ele pega e o que ele *não* pega) e nunca afirmar "está tudo limpo".
- **Risco de captura/manipulação da fonte.** Se a Prefeitura percebe que o
  gabinete monitora o portal, pode **degradar o portal** (tirar campo, atrasar
  publicação, mudar layout). O diff temporal (1.3) é justamente a defesa: ele
  *detecta* a degradação e a transforma em achado.
- **Risco de dado correto mas interpretação errada.** Um "empenho sem
  liquidação" pode ser só timing contábil. O sistema precisa de **regras de
  supressão / janela de carência** para não gritar sobre o que é normal. Sem
  isso, o painel vira ruído e o gabinete para de olhar.
- **Risco de sobrecarga do analista.** Se o sistema gera 200 alertas/semana e
  o gabinete tem 1 pessoa, o sistema falhou mesmo funcionando. A priorização
  (seção 7 do plano) precisa de um **teto operacional**: "no máximo N itens
  críticos por semana sobem para revisão; o resto fica na fila ranqueada".
- **Risco eleitoral/temporal.** 2026 é ano eleitoral. Um sistema de
  fiscalização operado por um gabinete contra o Executivo, em ano de eleição,
  **será lido como instrumento político** independentemente da qualidade
  técnica. Isso é risco real e merece uma resposta de governança (seção 4.5),
  não só uma nota.
- **Continuidade / bus factor.** Todo o conhecimento de engenharia reversa da
  API está na cabeça de quem fez. Se a API mudar e essa pessoa não estiver
  disponível, o sistema apaga. Mitigação: os snapshots brutos + os docs de
  reverse engineering precisam ser tratados como ativo crítico versionado.

### 1.9 [MÉDIO] Lacunas de fontes e de cobertura

- **PNCP não está no plano.** A Lei 14.133/2021 (art. 54, 94) torna a
  publicação no **Portal Nacional de Contratações Públicas** condição de
  *eficácia* do contrato. O PNCP tem API pública e dados estruturados. Isso é
  ouro: permite o cruzamento "contrato pago em Marília **sem publicação no
  PNCP**" — que não é só indício de irregularidade, é indício de
  **ineficácia do próprio contrato**. O `modulo_investiga.md` cita PNCP; o
  plano-mestre o omitiu. **Incluir como fonte Tier A/B.**
- **AUDESP/TCE-SP transparência.** O `modulo_investiga.md` aponta o portal de
  transparência do TCE-SP (`transparencia.tce.sp.gov.br`), que expõe dados de
  licitações e contratos da Fase IV de forma mais estruturada que o site do
  TCE. Pode ser uma fonte menos frágil que o scraping do site principal.
- **e-SIC / Ouvidoria / 1Doc.** O `modulo_investiga.md` dedica um módulo
  inteiro a protocolos, e-SIC e ouvidoria (taxa de resposta, temas
  recorrentes, pedidos sem resposta). O plano-mestre cortou isso. É uma perda:
  o painel de transparência do 1Doc de Marília tem dados estruturados, e
  "queda na taxa de resposta a pedidos de informação" é um indicador de gestão
  barato e politicamente potente. **Recolocar como subsistema de Fase 2.**
- **Frota e combustível (P3) não tem fonte confirmada.** O catálogo tem o
  processador P3 inteiro, mas nem a api-reference nem a análise preliminar
  acharam um módulo de abastecimento/frota no SMARAPD. P3 depende de dados que
  **talvez não existam publicamente** — e nesse caso o caminho é **LAI/
  requerimento para obter os dados**, não scraping. O plano precisa ser honesto:
  P3 é um processador *latente*, que só liga quando a fonte for obtida. O mesmo
  vale para P4 (almoxarifado/estoque de saúde — entrada física não é pública).
- **Editais em PDF exigem extração de texto + OCR.** O plano lista "scraping
  de editais" como Fase 2 sem dimensionar que muitos editais são PDF
  escaneado. Sem OCR, metade dos detectores de "edital direcionado" não tem
  insumo. Dimensionar.

### 1.10 [INFO] Pontos fortes que devem ser preservados

Para equilíbrio: o trilho jurídico (§2) é exemplar e deve ser blindado, não
mexido. A decisão de três scores separados (em vez de um número único) é
tecnicamente correta e juridicamente defensável. A migração de Empresas
Sancionadas para dentro do NEXO é acerto. O subsistema de Metas Fiscais como
monitoramento contínuo — e não consulta avulsa — é a melhor ideia do plano
depois do catálogo de detectores, porque ataca a causa nº 1 de rejeição de
contas com a fonte mais estável que existe (SICONFI). Nada disso deve ser
tocado.

---

## 2. Novas features — catálogo priorizado

Vinte features que o plano v1.0 não tem ou tem só implícitas. Cada uma com
**valor** (impacto para o gabinete), **esforço** (custo de construção) e a
**janela** sugerida. Ordenadas dentro de cada bloco por valor × esforço.

Notação: valor e esforço em ALTO / MÉDIO / BAIXO. "Quick win" = valor ALTO +
esforço BAIXO/MÉDIO.

### Bloco A — Quick wins (fazer cedo, retorno imediato)

**F1 · Digest do ORÁCULO — briefing periódico do que está errado na coisa pública**
*Valor: ALTO · Esforço: MÉDIO · Janela: Fase 1*
Esta é a feature que o usuário pediu nominalmente: um **assistente/copiloto que
conta ao vereador o que está acontecendo**. Concretamente: um resumo gerado
automaticamente — diário curto e semanal completo — que pega os alertas e
mudanças do período, **prioriza**, e escreve em linguagem natural de gabinete:
"Esta semana: 3 indícios críticos novos (1 de fracionamento na Saúde, R$ X; 1
contrato sem publicação no PNCP; 1 RGF a 5 dias do prazo). 2 investigações
aguardam sua aprovação. O fornecedor Y subiu de risco. Sugiro priorizar Z."
Entrega como tela inicial do `/nexo` **e** como e-mail/push. Na Fase 1 pode ser
template determinístico (sem IA); na Fase 3 a Claude API escreve a narrativa
com prompt caching. É a cara do produto — transforma "painel que você precisa
abrir" em "assessor que te procura".

**F2 · Sistema de notificações multicanal com digest configurável**
*Valor: ALTO · Esforço: MÉDIO · Janela: Fase 1*
O plano cita "dispara notificação" para score crítico mas não tem sistema de
notificação. Precisa de: canais (in-app, e-mail, push/WhatsApp se viável),
**preferência por usuário** (o vereador quer só o digest semanal; o analista
quer cada crítico na hora), **agrupamento** (não 20 e-mails, um digest), e
**deduplicação** (o mesmo indício não notifica 5×). Sem agrupamento, o sistema
de notificação vira spam e é silenciado — matando o valor de F1.

**F3 · Tabela viva de prazos legais com contagem regressiva**
*Valor: ALTO · Esforço: BAIXO · Janela: Fase 1 (parte do subsistema fiscal)*
O plano já cita o "rastreador de prazos RREO/RGF". Generalizar: uma tela única
com **toda contagem regressiva** que importa — RREO (30 dias após o bimestre),
RGF (30 dias após o quadrimestre), prazos de resposta a requerimentos do
gabinete, prazos de LAI. Vermelho/amarelo/verde. É barato (são datas e regras)
e é a feature que mais cedo "pega" alguma coisa, porque prazo perdido é
objetivo, não interpretável — exatamente o que as transcrições chamam de "linha
vermelha".

**F4 · Trilha de auditoria do próprio NEXO**
*Valor: ALTO · Esforço: BAIXO · Janela: Fase 0*
O plano audita a Prefeitura mas **não audita a si mesmo**. Toda ação humana no
sistema — promover alerta, editar dossiê, marcar falso positivo, gerar
requerimento, exportar — precisa de log imutável (quem, quando, o quê, valor
antes/depois). Razões: (a) se o gabinete leva um indício a público, precisa
provar a cadeia de custódia da decisão; (b) protege o gabinete de acusação de
manipulação; (c) é barata na Fase 0 e impossível de retrofitar depois. Coleção
`nexo_auditoria`, append-only, sem update/delete nas rules.

**F5 · Exportação de dossiê em PDF com cadeia de evidências**
*Valor: ALTO · Esforço: MÉDIO · Janela: Fase 1*
O plano gera requerimento mas não gera **o dossiê em si como documento**. O
gabinete vai querer levar o dossiê para a tribuna, para a imprensa, para o MP/
TCE. Precisa de um PDF profissional: capa, resumo, linha do tempo, evidências
com fonte+URL+hash+data de coleta, os 3 scores explicados, hipótese legal,
disclaimer obrigatório. Cada evidência com seu hash visível = **prova de que o
dado existia naquela data**. É o entregável físico do projeto.

**F6 · Watchlist — acompanhar entidade sob a ótica do gabinete**
*Valor: ALTO · Esforço: BAIXO · Janela: Fase 1*
Permitir ao analista "fixar" um fornecedor, uma secretaria, um contrato ou um
servidor numa lista de observação. Qualquer mudança ou novo alerta sobre item
da watchlist **fura a fila** e entra no digest com destaque. É barato (é um
flag + um filtro) e muda o uso diário: o gabinete quase sempre tem 5–10 alvos
"quentes"; a watchlist faz o sistema trabalhar para eles.

### Bloco B — Alto valor, esforço médio (núcleo da experiência)

**F7 · Linha do tempo da gestão (timeline mestre)**
*Valor: ALTO · Esforço: MÉDIO · Janela: Fase 1–2*
A frase-guia é "linha do tempo auditável" — mas o plano não tem **uma tela de
linha do tempo**. Construir uma timeline navegável da gestão municipal: no eixo,
os fatos (edital publicado, contrato assinado, aditivo, empenho, pagamento,
norma alterada no SAPL, ato no DOM, indício gerado, requerimento protocolado).
Filtrável por secretaria, fornecedor, contrato. É onde o "nexo" do nome
acontece visualmente: o usuário *vê* a sequência licitação→contrato→empenho→
aditivo→nova contratação e enxerga o padrão. Diferencial de produto.

**F8 · Camada de agregados / painéis materializados**
*Valor: ALTO · Esforço: MÉDIO · Janela: Fase 1*
Resposta direta ao problema de custo de leitura (1.2). Coleções
`nexo_agregados_*` recalculadas pelos jobs: total empenhado por fornecedor/mês,
% por modalidade, ranking de risco, KPIs do painel. A UI lê agregados (poucos
docs), nunca varre coleções cruas. Sem isso, cada abertura do painel custa
milhares de reads. Tecnicamente obrigatório, não opcional — por isso está em
Fase 1.

**F9 · Ciclo de vida pós-protocolo + medição de eficácia**
*Valor: ALTO · Esforço: MÉDIO · Janela: Fase 2*
Fecha a lacuna 1.6. Estados após o requerimento: protocolado → respondido /
sem resposta no prazo / resposta parcial → desfecho (confirmado / refutado /
inconclusivo). Gera dois valores: (a) gatilho automático "Prefeitura não
respondeu no prazo" — novo indício; (b) painel de eficácia do gabinete (taxa
de resposta obtida, indícios confirmados, valor total questionado). Esse painel
é munição de prestação de contas do mandato.

**F10 · Comparação plurianual e detecção de tendência**
*Valor: ALTO · Esforço: MÉDIO · Janela: Fase 2*
O plano tem série histórica só no subsistema fiscal. Generalizar para todo o
sistema: gasto desta secretaria vs. anos anteriores; nº de dispensas
deste exercício vs. exercícios passados; concentração de fornecedor ao longo do
tempo. O detector "queda > 10% em saúde/educação no ano eleitoral" (C03 da
arquitetura) **só existe se houver comparação plurianual** — hoje está no
catálogo sem infra que o sustente. SICONFI dá os anos anteriores de graça.

**F11 · Modo de acompanhamento por secretaria**
*Valor: ALTO · Esforço: MÉDIO · Janela: Fase 2*
Uma visão dedicada por secretaria (Saúde, Educação, Infraestrutura...): orçado
vs. executado, fornecedores concentrados, indícios abertos, contratos
emergenciais, obras, prazos. Espelha a estrutura real do controle parlamentar
— o vereador pensa "o que a Saúde está fazendo de errado", não "me mostre o
detector P4". Reaproveita a resolução de entidades de órgão (1.4).

**F12 · Busca semântica sobre o acervo**
*Valor: MÉDIO · Esforço: MÉDIO · Janela: Fase 3*
Indexar com embeddings o texto livre — descrições de empenho, objetos de
edital, históricos, conteúdo do DOM, normas do SAPL. Permite perguntar "onde
mais aparece coleta de lixo terceirizada" ou "contratos com cláusula X" sem
saber o termo exato cadastrado. Cuidado: é Fase 3 porque depende de volume de
dados acumulado e de orçamento de embeddings; entregar antes é prematuro.

**F13 · Painel de obras com georreferência**
*Valor: MÉDIO · Esforço: ALTO · Janela: Fase 2–3*
Mapa de Marília com as obras: status, valor, % físico vs. financeiro, aditivos.
O cruzamento "CEP da obra = CEP de fornecedor" (H07) fica visual. Esforço alto
porque depende do conector de obras (frágil) e de geocodificação; valor real
mas não primeiro da fila.

### Bloco C — Estratégicas / maior esforço

**F14 · Copiloto investigativo conversacional (Claude API)**
*Valor: ALTO · Esforço: ALTO · Janela: Fase 3*
Além do digest (F1), um assistente com quem o analista *conversa*: "resuma a
investigação 142", "monte a minuta de requerimento", "quais outros fornecedores
têm o mesmo padrão da M Construções", "explique por que este score é 78". Roda
sobre os dados já estruturados + RAG sobre jurisprudência TCE-SP e normas SAPL.
**Restrição dura:** o copiloto trabalha só sobre dados do sistema, sempre cita
fonte, e **nunca conclui por ilícito** — herda o trilho jurídico §2 no system
prompt. Prompt caching obrigatório (catálogo de detectores + normas no cache).

**F15 · Detecção estatística de anomalia (não só regras)**
*Valor: ALTO · Esforço: ALTO · Janela: Fase 2–3*
Mandato da PRISMA. Os detectores P1–P6 são regras com threshold; pegam o que
se sabe procurar. Faltam modelos que achem o **outlier que ninguém previu**:
empenho fora da distribuição sazonal do elemento de despesa, fornecedor cuja
curva de faturamento destoa dos pares, secretaria com padrão de gasto atípico.
Saída sempre como "ponto estatisticamente atípico — requer apuração", nunca
como veredito. Complementa as regras, não as substitui.

**F16 · Grafo de relacionamentos interativo**
*Valor: ALTO · Esforço: ALTO · Janela: Fase 2*
Já está no plano como camada [6] e coleções `nexo_grafo_*`, mas sem a **tela**.
A visualização do grafo (fornecedor–sócio–contador–endereço–servidor–contrato)
é o que torna cruzamento societário compreensível para um não-técnico. Vale
ALTO; esforço ALTO pela qualidade de dados que exige (resolução de entidades
tem que estar madura primeiro). Manter em Fase 2, depois de 1.4.

**F17 · Modo cidadão / transparência pública (eventual)**
*Valor: MÉDIO · Esforço: ALTO · Janela: pós-Fase 3, decisão política*
Uma versão pública e read-only de partes do NEXO — indicadores fiscais,
ranking de modalidades, indícios *já* levados a requerimento. Transforma a
ferramenta de gabinete em plataforma de transparência cidadã, com ganho
reputacional grande. **Mas exige decisão política e jurídica explícita**:
publicar indícios é exposição; só os já amadurecidos e protocolados deveriam
aparecer, com disclaimer reforçado. Não construir antes de o sistema interno
estar maduro e o trilho jurídico provado na prática. É visão, não roadmap
imediato.

**F18 · Alerta de conduta vedada em período eleitoral**
*Valor: ALTO · Esforço: MÉDIO · Janela: Fase 1 (2026 é ano eleitoral)*
Subdetector temporal que liga nos períodos sensíveis da Lei 9.504/97:
nomeações nos 3 meses pré-eleição, aumento de publicidade institucional,
despesa com shows/eventos custeada por emenda, promoção pessoal em ato oficial.
O plano já cita esses padrões dispersos em P6; consolidá-los num **modo
eleitoral** que se ativa por calendário dá foco a um risco que é agudo
**agora**.

**F19 · Catálogo de cobertura — "o que o NEXO vê e o que não vê"**
*Valor: MÉDIO · Esforço: BAIXO · Janela: Fase 1*
Resposta ao risco de falso negativo (1.8). Uma página honesta que lista cada
detector, o que ele cobre, qual fonte usa, e **o que está fora do alcance**
(ex.: "almoxarifado de saúde — sem fonte pública, depende de LAI"). Protege o
gabinete de concluir "está tudo limpo" e orienta quais requerimentos abrir
para *obter* os dados que faltam. Barato e honesto.

**F20 · Biblioteca de minutas e modelos por categoria**
*Valor: MÉDIO · Esforço: BAIXO · Janela: Fase 1–2*
O plano gera "uma" minuta de requerimento. Evoluir para uma biblioteca
versionada de modelos por tipo de indício (fracionamento, sobrepreço, diária
sem prestação de contas, contrato sem PNCP...), revisados pelo advogado e
reutilizáveis. Cada modelo já com a lista de documentos a pedir. Reduz o tempo
dossiê→requerimento de horas para minutos e padroniza a qualidade jurídica.

### Tabela-resumo de priorização

| # | Feature | Valor | Esforço | Janela | Prioridade |
|---|---|---|---|---|---|
| F4 | Trilha de auditoria do NEXO | ALTO | BAIXO | Fase 0 | **1** |
| F3 | Tabela viva de prazos legais | ALTO | BAIXO | Fase 1 | **2** |
| F6 | Watchlist de entidades | ALTO | BAIXO | Fase 1 | **3** |
| F1 | Digest do ORÁCULO (briefing) | ALTO | MÉDIO | Fase 1 | **4** |
| F8 | Camada de agregados | ALTO | MÉDIO | Fase 1 | **5** |
| F2 | Notificações multicanal | ALTO | MÉDIO | Fase 1 | **6** |
| F5 | Exportação de dossiê PDF | ALTO | MÉDIO | Fase 1 | **7** |
| F18 | Modo conduta vedada eleitoral | ALTO | MÉDIO | Fase 1 | **8** |
| F19 | Catálogo de cobertura | MÉDIO | BAIXO | Fase 1 | 9 |
| F7 | Linha do tempo da gestão | ALTO | MÉDIO | Fase 1–2 | 10 |
| F11 | Acompanhamento por secretaria | ALTO | MÉDIO | Fase 2 | 11 |
| F9 | Ciclo pós-protocolo + eficácia | ALTO | MÉDIO | Fase 2 | 12 |
| F10 | Comparação plurianual | ALTO | MÉDIO | Fase 2 | 13 |
| F20 | Biblioteca de minutas | MÉDIO | BAIXO | Fase 1–2 | 14 |
| F16 | Grafo interativo | ALTO | ALTO | Fase 2 | 15 |
| F15 | Detecção estatística | ALTO | ALTO | Fase 2–3 | 16 |
| F14 | Copiloto conversacional | ALTO | ALTO | Fase 3 | 17 |
| F12 | Busca semântica | MÉDIO | MÉDIO | Fase 3 | 18 |
| F13 | Painel de obras georref. | MÉDIO | ALTO | Fase 2–3 | 19 |
| F17 | Modo cidadão | MÉDIO | ALTO | pós-F3 | 20 |

**As 8 melhores apostas (valor × esforço):** F4, F3, F6, F1, F8, F2, F5, F18.
Todas cabem em Fase 0/1 e, juntas, transformam o NEXO de "detector que você
abre" em "assessor que te procura, com prova na mão e prazo no relógio".

---

## 3. Validação do faseamento

O escopo é "Completo" — todas as fases são compromisso. A crítica abaixo
não tira escopo; reorganiza a sequência para reduzir risco e antecipar valor.

### 3.1 Problemas do roadmap v1.0

1. **Fase 0 não entrega nada visível.** Reescrever client, criar schemas,
   subir conectores — tudo infra. Um patrocinador (o vereador) que não vê nada
   por semanas perde confiança no projeto. Faltam **provas de vida** na Fase 0.
2. **Fase 1 está sobrecarregada.** Os 6 processadores + score triplo + ciclo
   alerta→investigação + painel + lista + dossiê + subsistema fiscal completo +
   enriquecimento CNPJ + cruzamento DOM×Portal + integração com requerimentos.
   É praticamente o produto inteiro numa fase. Vai escorregar.
3. **A camada de diff (1.3) e a resolução de entidades (1.4) não aparecem em
   nenhuma fase** — e várias coisas da Fase 1 dependem delas.
4. **Quick wins estão soterrados.** O subsistema fiscal é declarado "entrega
   rápida" mas está em Fase 1 junto de tudo. O rastreador de prazos (F3) — o
   item mais barato e mais cedo útil — poderia entregar valor na primeira
   semana e está no meio do bolo.
5. **A correção dos limites de dispensa (1.1) é bloqueador e não tem fase.**

### 3.2 Roadmap revisado proposto

Mantém o escopo Completo; muda a ordem e cria pontos de entrega visível.

**Fase 0 — Fundação + primeira prova de vida** *(reduzida e mais honesta)*
- [BLOQUEADOR] Tabela de limites por exercício, lida dos decretos federais.
- Reescrever `smarapd-client.ts` → `src/lib/nexo/sources/smarapd.ts`, com o
  teste de exaustão de `QuantidadeRegistros` e de `Filtros` (1.2).
- Tabela de-para de modalidade (código → nome).
- Schemas Zod + coleções + `rules` + índices, **já incluindo `nexo_mudancas`,
  `nexo_entidades_*` e `nexo_auditoria`** (F4).
- Conector de coleta SMARAPD + snapshot bruto com hash + **camada de diff
  [1.5]** desde o primeiro conector.
- Layout/shell de `/nexo` + papéis de usuário (1.5).
- Migrar Empresas Sancionadas + item de menu.
- **Prova de vida:** o subsistema de **Metas Fiscais** entregue *já na Fase 0*
  — só depende do SICONFI (API limpa, sem scraping, sem detecção complexa) e
  dá ao vereador, na primeira entrega, gauges reais + o **rastreador de prazos
  (F3)**. É a forma mais barata de mostrar que o NEXO funciona.

**Fase 1 — Detecção núcleo + experiência de war room**
- Resolução de entidades [2.5] (fornecedor por CNPJ raiz, órgão, pessoa).
- Processadores **P1, P5, P6** primeiro (operam só sobre SMARAPD, fonte
  pronta), depois P2 quando houver obras. P3 e P4 declarados *latentes* até a
  fonte existir (1.9).
- Score triplo + ciclo alerta→investigação.
- Painel de Situação = o **Digest do ORÁCULO (F1)** como home.
- Notificações (F2), watchlist (F6), agregados (F8), exportação PDF (F5).
- Modo conduta vedada eleitoral (F18) — prioridade por ser ano eleitoral.
- Catálogo de cobertura (F19).
- Enriquecimento CNPJ + cruzamento DOM×Portal.
- Integração com Requerimentos + biblioteca de minutas (F20).

**Fase 2 — Profundidade + correlação**
- Conector de folha + detectores de terceirizados/fantasma (P-folha).
- Conector de obras + P2 completo; conector de editais/contratos + PNCP.
- e-SIC/Ouvidoria/1Doc como subsistema (1.9).
- CEIS/CNEP + TCE-SP/AUDESP.
- Grafo de correlações + tela do grafo (F16).
- Ciclo pós-protocolo + painel de eficácia (F9).
- Comparação plurianual (F10), acompanhamento por secretaria (F11).
- Linha do tempo da gestão (F7) consolidada.

**Fase 3 — Referências de preço + IA**
- SINAPI/SICRO/Banco de Preços → sobrepreço.
- Copiloto conversacional (F14) + RAG jurisprudência/normas.
- Detecção estatística de anomalia (F15).
- Busca semântica (F12).
- Feedback loop (alimentado pelo desfecho real do F9, não só "útil/inútil").
- Avaliar modo cidadão (F17) — decisão política à parte.

### 3.3 Quick wins — o que entregar primeiro

Em ordem de "valor entregue por semana de trabalho":

1. **Rastreador de prazos fiscais (F3)** — datas + regras, sem coleta pesada.
2. **Metas Fiscais via SICONFI** — uma API estável, gauges + tendência.
3. **Trilha de auditoria (F4)** — barata e impossível de retrofitar; fazer já.
4. **Tabela de limites + de-para de modalidade** — destrava todo o resto.
5. **Empresas Sancionadas migrada** — já existe, só mudar de lugar.
6. **Diff temporal no primeiro conector** — pequeno se feito desde o início,
   caríssimo se enxertado depois.

Os três primeiros podem estar no ar antes de qualquer detector existir — e já
dão ao gabinete um painel real de fiscalização fiscal.

---

## 4. Governança e risco

### 4.1 Trilho jurídico — está bom, com três reparos

O §2 do plano e o §7 da arquitetura tratam bem a regra "indício, nunca
acusação", a Lei 14.230/2021 (improbidade exige dolo) e a presunção de
inocência. Reparos:

- **[ALTO] A "probabilidade de enquadramento legal" é o ponto mais perigoso do
  sistema.** Um score que diz "85% de chance de enquadrar no art. 10 da LIA" é
  munição contra o próprio gabinete — a defesa do gestor dirá que o sistema
  "pré-julga". **Recomendação:** renomear para **"aderência a elementos
  objetivos da norma"** e nunca exibir como porcentagem de "vai dar cadeia".
  Exibir como checklist: "elementos presentes nos dados: conduta ✓, agente ✓,
  ato ✓, valor ✓; elemento subjetivo (dolo): NÃO AVALIÁVEL POR DADOS". Deixa
  explícito que o sistema mapeia fatos, não conclui crime.
- **[MÉDIO] Validação jurídica do catálogo.** Cada detector tem `fundamentoLegal[]`
  preenchido por engenheiro de regras (VÉRTEX). O advogado (Alessandro Calil ou
  o jurídico do gabinete) deve **revisar e assinar** o catálogo antes da Fase 1
  ir ao ar. Catálogo de detectores é peça jurídica, não só técnica.
- **[MÉDIO] O disclaimer precisa estar em três lugares**, não só no rodapé:
  (a) na tela, sempre visível; (b) em todo PDF exportado; (c) **no topo de cada
  minuta de requerimento gerada** — para que o texto que vai à Prefeitura já
  nasça com a linguagem de indício, não de acusação.

### 4.2 LGPD — subdimensionada no plano

O plano trata LGPD como "mascarar dados pessoais da folha na UI". É necessário
mas insuficiente. Pontos a endereçar:

- **Base legal explícita.** O tratamento de dados pessoais (servidores na
  folha, sócios de empresas, beneficiários de diárias) precisa de base legal
  declarada. Para um gabinete parlamentar em função fiscalizatória, a base
  plausível é o **exercício regular de direito / cumprimento de função pública**
  e o interesse legítimo, sobre **dados já tornados públicos** pela própria
  Administração. Isso deve estar **escrito** num registro de tratamento, não
  só pressuposto.
- **Finalidade, necessidade, minimização.** O plano cita os princípios. Operá-
  los significa: coletar só o campo que um detector usa (não baixar CPF se
  nenhum detector precisa de CPF), e definir **retenção** — por quanto tempo o
  snapshot bruto com dado pessoal fica guardado.
- **Mascaramento na origem, não só na UI.** O plano diz "mascarado na UI".
  Melhor: dados pessoais sensíveis mascarados/segregados **no armazenamento**,
  com o valor cheio só num campo de acesso restrito e auditado. Mascarar só na
  renderização deixa o dado cru exposto a quem tem acesso ao Firestore.
- **A folha é a área de maior risco LGPD.** O cruzamento "servidor com mesmo
  sobrenome do gestor" (nepotismo) trata dado pessoal para inferir relação
  familiar — é sensível. Deve ter revisão humana reforçada e nunca expor o
  nome completo num alerta automático sem o analista abrir.
- A fiscalização da LGPD cabe à **ANPD**; o gabinete deveria ter um registro
  mínimo de operações de tratamento, proporcional ao porte, pronto para
  eventual questionamento.

### 4.3 Segurança de acesso

O plano não tem seção de segurança de acesso. Mínimo necessário:

- **Papéis (1.5)**: Leitor / Analista / Chefe-Vereador, com `firestore.rules`
  que façam valer — não confiar na UI para esconder.
- **`firestore.rules` para `nexo_*`** restringindo leitura ao tenant/gabinete
  e escrita aos jobs (service account) — usuário comum **não escreve** em
  coleção de dados coletados, só em campos de anotação/status. A memória do
  projeto registra histórico de bug "cross-tenant" — esse risco precisa de
  teste explícito para o NEXO.
- **`nexo_auditoria` append-only** nas rules (sem update, sem delete).
- **Coleções com dado pessoal** (folha) com regra mais estrita que o resto.
- Os **jobs de coleta** rodam com service account de privilégio mínimo.
- Lembrete operacional: `rules`/`indexes`/`functions` exigem deploy manual
  (skill `firebase-deploy`) — uma regra escrita e não deployada é uma regra que
  não existe.

### 4.4 Risco reputacional — o ativo mais frágil do projeto

Um sistema de fiscalização vale pela sua credibilidade. Um único falso positivo
levado a público destrói anos de trabalho. Defesas, além da revisão humana:

- **Nada vai a público sem passar pelo desfecho de revisão humana** e, para
  itens críticos, pela aprovação do Chefe-Vereador (papel de 4.3).
- **Regras de supressão / carência** (1.8): o sistema não grita sobre o que é
  normal (timing contábil, restos a pagar dentro do ciclo).
- **Sempre o número e a fonte, nunca o adjetivo.** "R$ X em 7 dispensas ao
  mesmo CNPJ em 84 dias, somando 140% do limite do Decreto 12.807/2025" — e
  não "esquema de fracionamento".
- **Catálogo de cobertura (F19)**: nunca afirmar "está tudo limpo".

### 4.5 Risco político — 2026 é ano eleitoral

Um gabinete fiscalizando o Executivo em ano eleitoral será acusado de
perseguição política — é inevitável e independe da qualidade técnica.
Recomendações de governança:

- **Disciplina de método como blindagem.** A resposta à acusação de "caça às
  bruxas" é a regra de ouro do próprio plano: todo indício nasce de dado,
  documento, comparação e repetição. A trilha de auditoria (F4) e a cadeia de
  evidências com hash (F5) são a prova de que o método foi seguido.
- **O sistema aponta o fato, o gabinete faz a política.** O NEXO produz
  indício técnico com fonte; a decisão de o que fazer com ele (requerimento,
  tribuna, MP) é humana e política, e fica registrada como tal.
- **Não usar o sistema para o que ele não é.** O NEXO é fiscalização de dados
  públicos — não é, e não pode virar, ferramenta de influência ou de
  microtargeting (o próprio charter da equipe já trava isso; manter travado).
- **Modo cidadão (F17) é pós-eleição.** Publicar indícios em ano eleitoral
  amplifica o risco de leitura político-partidária; manter interno até o
  método estar provado.

### 4.6 Risco técnico de continuidade

- Os documentos de engenharia reversa da API e os snapshots brutos são
  **ativos críticos** — versionados, com backup, tratados como o coração do
  projeto. Se a API mudar, eles são a única memória.
- A API SMARAPD não tem SLA nem contrato. O plano já mitiga com snapshots; some
  a isso o **diff (1.3)**, que detecta a degradação da fonte como um evento, e
  o **mirror** (`transparencia-marilia.smarapd.com.br`) como fallback de coleta.

---

## 5. Plano-mestre v1.1 — emendas propostas

Resumo do que muda no `nexo-plano-mestre.md` para a v1.1:

1. **§1** — corrigir os limites de dispensa de 2026 para R$ 65.492,11 e
   R$ 130.984,20 (Decreto 12.807/2025). Substituir "correção herdada das
   transcrições" por "valores oficiais do decreto federal vigente".
2. **§4.1** — inserir duas camadas no pipeline: **[1.5] Diff** (detecção de
   mudança snapshot a snapshot) e **[2.5] Resolução de Entidades**.
3. **§4.3** — definir papéis de usuário (Leitor / Analista / Chefe-Vereador) e
   o layout da home como Digest do ORÁCULO (F1).
4. **§5** — acrescentar coleções `nexo_mudancas`, `nexo_entidades_orgao/
   _fornecedor/_pessoa`, `nexo_auditoria`, `nexo_agregados_*`,
   `nexo_notificacoes`, `nexo_watchlist`.
5. **§3** — incluir PNCP, TCE-SP/AUDESP transparência e e-SIC/1Doc como fontes;
   marcar P3 (frota) e P4 (almoxarifado) como processadores *latentes* sem
   fonte pública confirmada; dimensionar OCR para editais.
6. **§6** — travar um único esquema de IDs de detector (`P{n}-D{nn}`); mapear
   `despesa_viagem` a P3/P6; criar a tabela de-para de modalidade; criar
   watchlist de módulos vazios.
7. **§7** — renomear "probabilidade de enquadramento legal" para "aderência a
   elementos objetivos da norma"; exibir como checklist, nunca como % de
   ilícito; declarar o elemento subjetivo (dolo) como não avaliável por dados.
8. **§9** — estender o ciclo para incluir protocolo → resposta → desfecho;
   adicionar exportação de dossiê em PDF e biblioteca de minutas.
9. **§10** — substituir o roadmap pelo da seção 3.2 acima (Metas Fiscais como
   prova de vida na Fase 0; Fase 1 aliviada; diff e resolução de entidades
   posicionadas).
10. **§12** — acrescentar os riscos da seção 1.8 (falso negativo, captura da
    fonte, interpretação errada, sobrecarga do analista, risco eleitoral, bus
    factor) e a seção de segurança de acesso (4.3) e o aprofundamento de LGPD
    (4.2).
11. **Novo §13 — Governança** — consolidar trilho jurídico reparado (4.1),
    LGPD (4.2), segurança de acesso (4.3), risco reputacional e eleitoral
    (4.4/4.5), validação jurídica do catálogo e registro de tratamento.

---

## 6. Resumo executivo

### Lacunas mais críticas

1. **Limites de dispensa de 2026 errados no plano** [BLOQUEADOR]. O correto,
   pelo Decreto 12.807/2025, é **R$ 65.492,11** (compras/serviços) e
   **R$ 130.984,20** (obras). Os valores no plano (R$ 62.725,59 / R$ 125.451,15)
   estão errados e contaminam o detector mais usado. Corrigir antes da Fase 0
   com tabela lida dos decretos.
2. **Falta a camada de diff temporal** [ALTO]. O plano guarda snapshots mas não
   compara versões — perde os achados mais valiosos (valor que mudou, aditivo
   novo, dado que sumiu) e perde a re-detecção incremental barata. É a correção
   arquitetural mais importante.
3. **Resolução de entidades sem lugar no pipeline** [ALTO]. Está no mandato da
   PRISMA mas não é uma etapa. Sem ela, fracionamento entre secretarias, grafo
   e "HU com 3 CNPJs" não funcionam.
4. **Filtro server-side da API dá 400** [BLOQUEADOR de capacidade]. Força
   varredura completa; o plano não dimensionou o custo de coleta nem de leitura
   do Firestore. Exige teste de exaustão de paginação e camada de agregados.
5. **Sem papéis de usuário nem segurança de acesso** [ALTO]. "Revisão humana
   obrigatória" não tem dono; faltam `rules` por papel e auditoria.
6. **O ciclo termina no requerimento** [ALTO]. Falta protocolo → resposta →
   desfecho — e com isso o sistema nunca aprende nem mede a própria eficácia.
7. **Numeração de detectores ambígua e valores legais digitados à mão** em três
   documentos — fonte garantida de bug.

### Melhores features novas (valor × esforço)

| Feature | Valor | Esforço | Por quê |
|---|---|---|---|
| **F4 Trilha de auditoria do NEXO** | ALTO | BAIXO | Protege o gabinete; impossível retrofitar; Fase 0 |
| **F3 Tabela viva de prazos legais** | ALTO | BAIXO | Quick win nº 1; prazo perdido é objetivo |
| **F6 Watchlist de entidades** | ALTO | BAIXO | Faz o sistema trabalhar para os alvos quentes do gabinete |
| **F1 Digest do ORÁCULO (briefing)** | ALTO | MÉDIO | A feature que o usuário pediu — assessor que te procura |
| **F8 Camada de agregados** | ALTO | MÉDIO | Sem ela, cada painel custa milhares de reads |
| **F2 Notificações multicanal** | ALTO | MÉDIO | Sem agrupamento o digest vira spam e é silenciado |
| **F5 Exportação de dossiê PDF** | ALTO | MÉDIO | O entregável físico — tribuna, imprensa, MP/TCE |
| **F18 Modo conduta vedada eleitoral** | ALTO | MÉDIO | Risco agudo agora (2026) |
| **F9 Ciclo pós-protocolo + eficácia** | ALTO | MÉDIO | Fecha o loop; mede o mandato |
| **F14 Copiloto conversacional (IA)** | ALTO | ALTO | O copiloto pleno — Fase 3, sobre dados já estruturados |

Quem manda no roadmap são as 8 primeiras: todas em Fase 0/1, juntas convertem o
NEXO de painel em assessor.

### Recomendações de ajuste do plano-mestre

1. **Corrigir já os limites de dispensa** e montar a tabela de limites por
   exercício a partir dos decretos federais — não das transcrições.
2. **Inserir duas camadas no pipeline:** diff temporal e resolução de
   entidades. É o reparo arquitetural central.
3. **Aliviar a Fase 1 e dar prova de vida à Fase 0:** entregar o subsistema de
   Metas Fiscais (SICONFI) + rastreador de prazos já na Fase 0 — barato,
   estável, visível.
4. **Definir papéis de usuário e segurança de acesso** com `firestore.rules`
   por papel e `nexo_auditoria` append-only.
5. **Renomear "probabilidade de enquadramento legal"** para "aderência a
   elementos objetivos da norma", exibida como checklist — nunca como % de
   ilícito. É o reparo jurídico mais importante.
6. **Estender o ciclo até o desfecho** (protocolo → resposta → confirmado/
   refutado/sem resposta) e usar o desfecho como feedback real.
7. **Incluir PNCP como fonte** e ser honesto sobre P3/P4 — processadores
   latentes enquanto não houver fonte pública; o caminho para obtê-la é a
   própria LAI/requerimento.
8. **Aprofundar LGPD** (base legal escrita, minimização, mascaramento na
   origem, retenção) e adicionar um §13 de Governança consolidando o trilho
   jurídico, segurança e o risco eleitoral de 2026.
9. **Travar um único esquema de IDs de detector** e a tabela de-para de
   modalidade — dois bugs latentes eliminados de graça.
10. **Tratar falso negativo como risco de primeira classe:** catálogo de
    cobertura (F19) e a regra de nunca afirmar "está tudo limpo".

---

## Fontes normativas consultadas

- Decreto nº 12.807/2025 — atualização dos valores da Lei 14.133/2021, vigência
  01/01/2026 (limites de dispensa: R$ 65.492,11 e R$ 130.984,20).
  https://elicitacao.com.br/2026/01/15/valores-de-licitacao-em-2026/ ·
  https://zenite.com.br/2026/01/05/comunicado-no-47-25-decreto-altera-valores-da-lei-14-133-para-compras-publicas/
- Lei 14.133/2021, arts. 54, 75 e 94 — publicidade e obrigatoriedade do PNCP
  como condição de eficácia do contrato.
  https://www.gov.br/pncp/pt-br/pncp
- Lei de Responsabilidade Fiscal (LC 101/2000), arts. 52 e 55 — prazo de 30
  dias para publicação de RREO (bimestral) e RGF (quadrimestral).
  https://www.tcm.ba.gov.br/informacoes/prazos/
- LGPD (Lei 13.709/2018) — princípios do art. 6º; fiscalização pela ANPD;
  tratamento por órgão público para execução de função pública.
  https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm ·
  https://www.serpro.gov.br/lgpd/governo/quem-vai-regular-e-fiscalizar-lgpd

---

## Disclaimer

> Este documento é peça de planejamento interno do Gabinete. As referências a
> indícios, padrões de risco e hipóteses de enquadramento descrevem capacidades
> do sistema NEXO — não constituem acusação, prova de improbidade ou de ilícito.
> Todo indício gerado pelo sistema deve ser investigado pelas instituições
> competentes (TCE-SP, Ministério Público, Controladoria) antes de qualquer
> juízo de valor.
