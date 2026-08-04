# NEXO — Plano-Mestre da Nova Infra

Sintese unica e priorizada das auditorias (ingestao, performance, cruzamento,
detectores, investigativo, ux/jobs, observabilidade), das sondas (portal/WAF,
gerente/briefing, novas fontes) e dos tres designs (dados, jobs, inteligencia).
Tudo verificado contra codigo real (arquivo:linha) e dados reais (gcloud /
Firestore REST), em 16/06/2026.

Regras vigentes: nao dar git push; commits ASCII sem parenteses/aspas/acentos;
honestidade radical (data-blocked rotulado, nunca fingido); `functions/` NAO
importa de `src/`; App Hosting deploya SO o app Next (functions/rules/indexes
exigem `firebase deploy --only ...` separado); o app NAO tem firebase-admin (le
Firestore por REST com token do usuario via `lerColecaoNexo`).

---

## 1. DIAGNOSTICO EXECUTIVO

### 1.1 O que esta QUEBRADO (com evidencia)

- **Deploy de functions PENDENTE — bloqueia quase tudo.** Os fixes 5a060b7
  (idDocSeguro), d9d1e43 (_exercicio), 703f091 (orcamento por orgao) sao commits
  locais; App Hosting nao sobe functions. Prova dura: `perfil_entidades` rodou
  HOJE e ainda falha com `documentPath ... "BANESPA/ SANTANDER" ... even number
  of components` (errosConsec=9, `ultimoSucessoEm` vazio). `nexo_entidades`=474 /
  `nexo_scores`=238 congelados de runs antigos.
- **gerente HTTP 404 -> briefings=0.** Raiz confirmada: a function `onnexogerente`
  foi deployada ANTES de `NEXO_APP_URL` entrar no `functions/.env:6`; usa o
  fallback hardcoded `oficioexpress.web.app` (`gerente.ts:36`) que e o Hosting
  legado estatico (404 em /api/*). O host real
  `studio--studio-8612233125-caa0a.us-central1.hosted.app/api/nexo/gerente`
  responde 401 (rota existe, so faltava o secret). Mesma cadeia do advogado JA
  esta correta em prod -> os provedores de IA estao configurados; falta so
  redeploy. `_gerente.coletadoEm` congelado 10/06.
- **advogado: 257 falhas consecutivas, pareceres=0.** `ADVOGADO_TIMEOUT_MS=120s`
  (`advogado.ts:46`) < `maxDuration=300` da rota; e/ou a rota nao estava
  deployada. `10/10 lote(s) com erro: operation aborted`. Roda 24x/dia sem
  entregar nada.
- **gerente OOM a cada 30 min.** `lerTopAlertas` (`gerente.ts:168-184`) faz
  `nexo_alertas.where(ativo==true).get()` SEM `.select()`/`limit` -> carrega ~60k
  alertas gordos para `.slice(0,12)`. `Memory limit of 512 MiB exceeded`. Morre
  antes do `gravarSyncState`; scheduler reporta code 13.
- **empenho<->contrato = 0 arestas; empenho<->licitacao = 0** (confirmado:
  `nexo_links` empenho-tce=177.868, doc=27.152, processo-dom=153, contrato=0,
  licitacao=0). Tres bugs somados: (a) usa `NroProcessoAdminEmpenho` que vem
  vazio `" / 2026"` em 100% da amostra — o util e `ProcessoLicitatorio`; (b)
  `chaveProcesso` compara string crua: contrato `"47"` vs empenho `"21 / 2022"`
  nunca igualam; (c) numero puro de 2 digitos colide em massa (`"002"` casa 318
  empenhos). Simulacao com num+ano casa ~166/630 (2026) e ~402/738 (2025).
- **XS-DOADOR = 0 apesar de 155.754 doacoes TSE.** Impossibilidade matematica de
  chave: QSA da Receita publica so 6 digitos do CPF do socio ->
  `hashDoc("017128")`; TSE traz CPF cheio -> `hashDoc(11 digitos)`. Nunca
  colidem (`coleta-socios.ts:206` vs `coleta-tse-doacoes.ts:552`). O secret
  `NEXO_PII_SALT` nao existe -> ambos usam o mesmo SALT_FALLBACK, logo o hash E
  comparavel; o problema e o INPUT diferente.
- **dossie casa aresta por `soDigitos(chave)==CNPJ`** (`dossie/[id]/route.ts:1203`)
  — a chave e `EMP-0000000259-2026` ou `21/2022`, nunca CNPJ;
  `soDigitos("EMP-0000000259-2026")` da 14 digitos e passa por "CNPJ" por
  acidente -> falso-positivo silencioso. A teia por CNPJ do dossie e ruido.
- **enriquecimento_contratos: bug de `/`, NAO WAF.** Sonda provou portal saudavel
  (HTTP 200 nas 3 rotas). O `/` no nome da contratada vira `%2F`, o router
  posicional re-decodifica e 404a; o cron classifica como bloqueio e da `break`
  no 1o contrato -> 0 enriquecidos, `bloqueadoPeloPortal=true` falso. Segundo bug:
  matcher `204` vs `204/TC/2024` nunca casa (precisa do segmento numerico
  inicial `^\D*(\d+)`). Resultado: contratos comCNPJ=0, comObjeto=0 ->
  0/474 entidades com nContratos>0 -> flag `sem-processo` 100% falsa.
- **sancoes_estaduais (TCE-SP) = 0, mas e geo/IP-block, NAO fonte morta.** A API
  `www4.tce.sp.gov.br/apenados/...` responde HTTP 200 deste ambiente (34 KB por
  `apenadorNome=MARILIA`); o 403 e nos ranges de IP do us-central1. Mesmo padrao
  do PNCP (mitigado pelo proxy southamerica-east1 `onpncpproxy-...-rj.a.run.app`,
  `apphosting.yaml:80`). Falta rotear o cron de sancoes estaduais pelo proxy.
- **X2 polui 85% dos indicios sem sinal fiscal.** Amostra: 100% dos X2 sao
  "ausencia" (so-smarapd/so-tce), ZERO divergencia de valor. A divergencia de
  VALOR (alto sinal) produz zero pela mesma classe de bug de chave do linkage.
  Infla `nexo_alertas` a 67.452 e empurra os DS reais para baixo.

### 1.2 O que esta LENTO (medido via runQuery REST hoje)

`lerColecaoNexo` (`firestore-read.ts:139-164`) faz UM `:runQuery` e `await
res.json()` do corpo INTEIRO — sem `limit`, cursor ou streaming. Custo linear no
tamanho do exercicio. Medicoes reais (payload no fio + latencia so do Firestore,
antes de normalizar/detectar — os tempos on-request sao PIORES):

| Rota | Leitura | docs | bytes | latencia |
|---|---|---|---|---|
| /api/nexo/alertas | nexo_alertas 2025 SEM projecao | 46.797 | 306,8 MB | 20.704 ms |
| /api/nexo/grafo | nexo_links 2025 (proj 5 campos) | 111.055 | 118,0 MB | 24.082 ms |
| /api/nexo/dossie | nexo_doacoes_tse INTEIRA | 155.754 | 237,1 MB | 41.315 ms |
| /api/nexo/dossie | nexo_links 2025+2026 | ~205k | ~218 MB | ~41 s |
| /api/nexo/empenhos | nexo_empenhos 2025 com projecao (padrao BOM) | 43.687 | 39,5 MB | 7.950 ms |

Causa raiz: o filtro real (`docHashDoador`, `chave==cnpj`) NAO esta nos campos
indexaveis de `lerColecaoNexo` (so `_exercicio`/`_fonte`/`_cnpj`), entao a colecao
inteira vem e o filtro acontece em memoria. App Hosting/Cloud Run tem teto de
resposta nao-streamada (~32 MB, doc em `detectar/route.ts:239`) + timeout de
request -> os payloads gigantes estouram. O cache existente
(`grafo/route.ts:202`, `dossie/route.ts:386`) e por-instancia e some no cold
start. Nao existe `nexo_snapshots`/`nexo_tarefas` de materializacao (grep
confirmou — a unica `nexo_snapshots` e a de hash do `alteracao.ts`).

### 1.3 O que esta INCOMPLETO

- **Caps truncados:** `pagamentos-2025=60000` (maxPag120, teto exato),
  `patrimonio-2026=20000` (maxPag40, teto exato) -> dados CORTADOS sem ninguem
  saber. ~50 modulos SMARAPD gravam `nexo_sync_state` direto (`coleta.ts:332-425`),
  bypassando `gravarSyncState` -> sem `statusSaude`/`cadencia`/`truncado`: cegos
  ao painel de saude.
- **Cobertura temporal:** contratos/licitacoes so 2025-2026. `nexo_doacoes_tse`
  TODOS de 2024 (2020/2022 = 0). `nexo_socios`=257 (~0,4% dos fornecedores;
  MAX_CNPJS=60/dia + TTL).
- **nVinculos enviesado** (`perfil-entidades.ts:489-514` so mapeia lado-empenho
  de empenho-tce). Familias inteiras do catalogo em stub honesto (data-blocked).
- **Sem RANKING agregado doador<->politico<->empresa** (o entregavel central do
  dono nao existe materializado; score nao usa fator doador).
- **Sem fila de tarefas / snapshot / TTL / historico / notificacao** — greenfield,
  mas com molde forte fora do NEXO (`QuickEditJobTracker`, `quickEditJobs`,
  `nexo_briefings`).

---

## 2. ARQUITETURA-ALVO

Tres camadas. Principio transversal: **a chave de juncao precisa ser campo
indexavel de igualdade** (`_exercicio`/`_cnpj`/`_cnpjRaiz`/`_entidadeId`/
`chaveFraca`), e **o calculo pesado vira snapshot materializado** (abrir =
instantaneo), reusando o padrao ja vivo `cron-computa->grava / app-so-le`.

### 2.1 Camada de DADOS

Convencao de campos de sistema (prefixo `_`) em TODA colecao `nexo_*`:

| campo | semantica | regra |
|---|---|---|
| `_exercicio` | ano fiscal | SEMPRE (bug d9d1e43 provou que faltava) |
| `_fonte` | modulo curto | = ModuloSpec.nome |
| `_cnpj` | so digitos | quando ha fornecedor |
| `_cnpjRaiz` | 8 digitos (filial->grupo) | NOVO, chave de entity-resolution |
| `_entidadeId` | id canonico | NOVO, carimbado na INGESTAO (nao so no perfil) |
| `_hashEntrada` | sha1 dos campos-fonte | NOVO, deteccao de alteracao + skip-recompile |

Chaves canonicas DUPLICADAS nos dois lados (regra functions!=src):
`functions/src/nexo/chaves.ts` + `src/lib/nexo/chaves.ts` (verbatim, teste de
igualdade no CI):
- `chaveProcesso({num,ano})` — `num` = `^\D*(\d+)` sem zeros a esquerda; `ano` =
  `\d{4}` apos `/`. Empenho usa `ProcessoLicitatorio` (primario); contrato usa
  `numeroProcesso` + ano de vigencia.
- `chaveFraca(nome,cpf6) = hashDoc(normNome(nome)+"|"+cpf6)` — UNICA forma de
  ligar socio<->doador (CPF cheio do socio e data-blocked: a fonte so da 6
  digitos do miolo; do TSE extrai `cpf.slice(3,9)`).
- `chaveEmpenho(seq,ano)=EMP-{pad10}-{ano}` (ja funciona — manter).

### 2.2 Camada de PROCESSAMENTO/JOBS + SNAPSHOTS

```
[Botao Compilar] --create--> nexo_tarefas/{chave} (status:'pendente')
       |                       [client SDK; rule create-only do dono]
  onDocumentCreated (worker gen2)
       v
  worker: status='rodando' -> fetch APP/api/nexo/<tipo>?compute=1
       |   (x-nexo-secret + token de servico; a ROTA le Firestore REST e computa)
       v
  worker grava nexo_snapshots/{chave}:{epoch}  (payload + geradoEm + expiraEm + delta)
  worker: nexo_tarefas status='pronto', snapshotId
       |
  onSnapshot no client -> NexoTarefaTracker -> toast "pronto, abrir"
       v
[Abrir painel] GET /api/nexo/<tipo> -> le snapshot pronto -> INSTANTANEO
```

Decisao central: o worker NAO reimplementa `montar*`/`montarGrafo`/`paraAlerta`
(evita centenas de linhas duplicadas). Chama a rota EXISTENTE em modo
`?compute=1` (sem cache, payload puro, gateado por `x-nexo-secret`) e persiste. A
rota ganha modo de LEITURA snapshot-first (default) — mudanca minima e
retrocompativel. Molde ja vivo: `deteccao.ts` (cron chama rota, grava alertas) e
`gerente.ts` (cron chama rota, grava briefing).

Contratos de dados:

`nexo_tarefas/{chave}` — docId = `{tipo}:{alvo}:{exercicio}` (dedupe):
```
{ tipo:'dossie'|'grafo'|'alertas'|'risco'|'ranking', alvo, exercicio,
  status:'pendente'|'processando'|'pronto'|'erro'|'expirado',
  origem:'manual'|'nightly', solicitadoPor:uid,
  criadoEm, iniciadoEm, concluidoEm, expiraEm(=concluido+3d),
  snapshotId, progresso, erro, tentativas, _versaoWorker }
```

`nexo_snapshots/{chave}:{concluidoEm-epoch}` — N versoes por chave (historico):
```
{ chave, tipo, alvo, exercicio, geradoEm, expiraEm,
  _versaoEsquema, _hashEntrada,           // se igual ao anterior -> nao recompila
  payloadInline?:obj,                      // se <900KB (dossie/risco/ranking)
  payloadStorage?:'gs://.../nexo-snapshots/{id}.json.gz',  // grafo/alertas (>1MB)
  resumoDelta:{novos,removidos,deltaValor}|null,  // null = primeira (nao fingir)
  tamanhoBytes, nDocsLidos }
```

TTL 3 dias: policy NATIVA do Firestore no campo `expiraEm` (config de banco via
`gcloud firestore fields ttls update`, NAO deployavel por push) + cron de
varredura `onNexoTarefasTtl` como rede de seguranca (molde
`functions/src/video/job-cleanup.ts`). O nightly re-enfileira snapshots que
expiram em <12h para a UI nunca ficar sem dado.

Rules (override create-only do dono, antes do catch-all `nexo_*` em
`firestore.rules:335`, espelha `quickEditJobs:194`):
```
match /nexo_tarefas/{id} {
  allow read: if isActiveUser();
  allow create: if isActiveUser()
    && request.resource.data.solicitadoPor == request.auth.uid
    && request.resource.data.status == 'pendente';
  allow update, delete: if false;   // so o worker (Admin SDK) avanca status
}
// nexo_snapshots cai no catch-all: read isActiveUser, write:false. OK.
```

UI: `NexoTarefaTracker` (copia de `QuickEditJobTracker.tsx`) montado 1x no
`nexo-shell.tsx`; botao Compilar troca fetch sincrono por `criarTarefa()` (cria
doc `pendente` via client SDK); badge "atualizado ha X - expira em 3 dias"
(reusa `tempoRelativo` de `coleta/page.tsx:102`); painel de tarefas (novo item
NAV grupo Operacao) + historico/diff via `resumoDelta`.

### 2.3 Camada de INTELIGENCIA / CRUZAMENTO

`nexo_cruzamentos/{sha1}` — arestas tipadas com proveniencia/confianca
EXPLICAVEL (distinto do `nexo_links` tecnico):
```
{ tipo:'socio-doador'|'empresa-doador'|'empenho-contrato'|'socio-comum'|'contrato-dom',
  ladoA:{kind,valor,rotulo,docMasc?}, ladoB:{...},
  confianca:'forte'|'media'|'fraca'|'informativo',
  baseConfianca:['nome+cpf6','cardinalidade<=2'],   // auditavel
  valorAncora:min(doado,empenhado), classificacaoMax:'atencao',
  _exercicio,_fonte,_cnpj, geradoEm, _versaoEsquema }
```

`nexo_ranking_vinculo/{id}` — o ENTREGAVEL: 1 doc por pessoa/empresa com vinculo
doador<->contrato, ordenavel por `potencial=min(totalDoado,totalEmpenhado)`,
`classificacaoMax:'atencao'`.

Indices por-entidade (matam o timeout do dossie sem materializar tudo):
`nexo_doacoes_por_chave/{chaveFraca}`, `nexo_vinculos_por_cnpj/{raiz}`,
`nexo_alertas_por_entidade/{id}` — escritos pelo cron de perfil; `lerColecaoNexo`
busca por igualdade -> 237 MB viram <50 KB.

Detectores destravados: XS-DOADOR via `chaveFraca` (maior ROI); X2 separado em
X2-valor (sempre ativo) e X2-ausencia (rebaixado a informativo / agregado por
orgao) -> corta ~67k para ~15-20k alertas, resolve timeout na origem; novos
AN-05 (Z-robusto serie-historica 6 anos), Benford por-orgao, fracionamento
multi-anual, Gini/Lorenz por secretaria — todos sem fonte nova.

---

## 3. ROADMAP — FRENTES PARALELIZAVEIS

Esforco: P (<=0,5d) / M (1-2d) / G (3d+). Ordenado por impacto/risco.
Worktrees disjuntos por conjunto de arquivos para evitar conflito.

### FRENTE 0 — DEPLOY desbloqueador (QUICK-WIN, pre-requisito de quase tudo)
- Objetivo: subir os fixes ja commitados e a env correta para prod.
- Arquivos: NENHUM codigo novo. So `firebase deploy --only functions`
  (perfil-entidades, gerente, advogado, deteccao) + `gcloud scheduler jobs run
  firebase-schedule-onNexoGerente-us-central1`.
- Dependencia: nenhuma. Esforco: P. Risco: baixo (so testar perfil-entidades
  pos-deploy). Deploy: FUNCTIONS. Quick-win.
- Resolve sozinho: perfil/score congelados, gerente 404/briefings=0, advogado
  (apos ajuste F1).

### FRENTE 1 — Crons-LLM saudaveis (QUICK-WIN)
- Objetivo: gerente para de OOM; advogado para de abortar; cortar custo/cadencia.
- Arquivos (disjuntos): `functions/src/nexo/gerente.ts` (lerTopAlertas com
  .select()+limit; memory 512->1024; cadencia 30min->1x/dia; fallback hardcoded
  -> hosted.app), `functions/src/nexo/advogado.ts` (ADVOGADO_TIMEOUT_MS 120->300;
  LOTE 6->2-3; cadencia), `functions/src/nexo/deteccao.ts` (so fallback URL).
- Dependencia: F0 (deploy). Esforco: P. Risco: baixo. Deploy: FUNCTIONS.
  Quick-win. CORTAR cadencia ANTES de destravar para nao sangrar Gemini.

### FRENTE 2 — Enriquecimento de contratos (QUICK-WIN alto valor)
- Objetivo: destravar objeto/PDF/aditivos dos ~2.138 contratos (CNPJ via
  casamento por nome, nao do portal).
- Arquivos: `functions/src/nexo/enriquecimento-contratos.ts` (sanear `/` no
  deep-link 220-230; 404 de listagem = sem-match+continue, nao break 701-712;
  matcher por segmento numerico inicial 287-326; blindar extrairDocumento contra
  CNPJ do rodape 410-423; opcional capturar aditivos), `functions/src/nexo/
  coleta-contratos.ts` (deep-link gemeo 176-182).
- Dependencia: F0. Esforco: P-M. Risco: baixo. Deploy: FUNCTIONS + disparo
  manual scheduler. Quick-win.

### FRENTE 3 — Proxy BR para TCE-SP apenados (estrutural curto)
- Objetivo: destravar sancoes estaduais (0 -> milhares); habilita vinculo_vivo
  estadual e FR-04/05.
- Arquivos: `functions/src/nexo/coleta-sancoes-estaduais.ts:81,110` (rotear pelo
  proxy), `functions/src/nexo/pncp-proxy.ts` (estender p/ aceitar host TCE-SP) OU
  clonar a function; `apphosting.yaml:80` (ref do proxy).
- Dependencia: F0. Esforco: M. Risco: medio (depende do proxy southamerica-east1).
  Deploy: FUNCTIONS. Estrutural curto.

### FRENTE A — Chaves canonicas + reprocesso (RAIZ da inteligencia)
- Objetivo: criar `chaves.ts` (2 lados), gravar `chaveFraca`/`cpf6`/`_cnpjRaiz`/
  `_entidadeId` na ingestao.
- Arquivos: `functions/src/nexo/chaves.ts` (NOVO), `src/lib/nexo/chaves.ts`
  (NOVO espelho), `functions/src/nexo/coleta-socios.ts:203-217`,
  `functions/src/nexo/coleta-tse-doacoes.ts:551-566`.
- Dependencia: nenhuma (raiz). Esforco: M. Risco: medio (reprocesso de 155k+257
  docs). Deploy: FUNCTIONS. Estrutural.

### FRENTE B — Entity-resolver compartilhado
- Objetivo: mover resolucao de entidade para helper chamado por todo coletor;
  corrigir nVinculos (mapear tce_despesas/licitacoes); indices por-entidade.
- Arquivos: `functions/src/nexo/entidade-resolver.ts` (NOVO),
  `functions/src/nexo/perfil-entidades.ts:223,489-572`.
- Dependencia: A (convencao de campos). Esforco: M. Risco: medio. Deploy:
  FUNCTIONS + INDEXES. Estrutural.

### FRENTE C — Linkage empenho<->contrato/licitacao
- Objetivo: gerar as arestas que hoje sao 0 (esperado +166/2026, +402/2025).
- Arquivos: `functions/src/nexo/linkage.ts:105-128,362-396` (chaveProcesso por
  num+ano via ProcessoLicitatorio; `_cnpjRaiz` na aresta; confianca).
- Dependencia: A (chaveProcesso). Esforco: M. Risco: medio (colisao de num baixo
  — exigir num>=3 ou cardinalidade). Deploy: FUNCTIONS. Estrutural.

### FRENTE D — Detectores (XS-DOADOR + split X2 + DS novos)
- Objetivo: ligar o detector estrela; cortar 85% do ruido; analises DS sem fonte
  nova.
- Arquivos: `src/lib/nexo/detectores/doador-politico-det.ts` (chaveFraca),
  `src/lib/nexo/detectores/tce-divergencia-det.ts:185` (split X2),
  `src/lib/nexo/detectores/anomalia-serie-det.ts` (NOVO AN-05).
- Dependencia: A (chaveFraca). Esforco: M. Risco: medio (X2 split muda volume de
  alertas). Deploy: APP (push). Estrutural alto-impacto.

### FRENTE E — Infra de jobs/snapshots (worker + colecoes + rules + TTL)
- Objetivo: fila + worker + snapshots + TTL + nightly + limpeza.
- Arquivos: `functions/src/nexo/jobs-worker.ts`, `jobs-nightly.ts`,
  `jobs-ttl.ts` (NOVOS), `functions/src/index.ts` (export),
  `functions/src/nexo/jobs-tipos.ts` + `src/lib/nexo/jobs-tipos.ts` (NOVOS),
  `firestore.rules` (override antes da :335), `firestore.indexes.json`.
- Dependencia: nenhuma (le dados existentes). Esforco: G. Risco: medio (TTL
  nativo e config manual de banco). Deploy: FUNCTIONS + RULES + INDEXES + gcloud
  TTL. Estrutural — caminho critico que destrava F.

### FRENTE F — Rotas snapshot-first + ranking
- Objetivo: GET le snapshot (instantaneo); `?compute=1` gateado para o worker;
  rota ranking; corrigir montarVinculos do dossie.
- Arquivos: `src/app/api/nexo/{alertas,grafo,dossie/[id],risco}/route.ts`,
  `src/app/api/nexo/ranking-doadores/route.ts` (NOVO),
  `src/app/api/nexo/tarefas/route.ts` (NOVO),
  `src/app/api/nexo/dossie/[id]/route.ts:1203` (montarVinculos por entidade),
  `src/lib/nexo/firestore-read.ts` (filtro de igualdade extra se faltar).
- Dependencia: E (shape do payload/colecoes), B+C (dados de vinculo). Esforco: G.
  Risco: medio (retrocompat). Deploy: APP (push). Estrutural.

### FRENTE G — UI (tracker + botoes + badge + painel de tarefas + ranking)
- Objetivo: notificacao de conclusao, botao Compilar nao-bloqueante, historico.
- Arquivos: `src/components/nexo/NexoTarefaTracker.tsx` (NOVO copia de
  `QuickEditJobTracker.tsx`), `src/components/nexo/nexo-shell.tsx:93,204`,
  `src/app/nexo/{page,grafo/page,dossie/[id]/page}.tsx`,
  `src/app/nexo/tarefas/page.tsx` (NOVO), `src/app/nexo/ranking/page.tsx` (NOVO).
- Dependencia: E (tipos/chave — pode mockar), F (contrato de rota). Esforco: M.
  Risco: baixo. Deploy: APP (push). Estrutural.

### FRENTE H — Ingestao robusta + observabilidade SMARAPD
- Objetivo: trocar escritas diretas por gravarSyncState; flag truncado; subir
  caps; matriz cobertura; painel de saude.
- Arquivos: `functions/src/nexo/coleta.ts:41,64-81,332-425`,
  `functions/src/nexo/sync-state.ts:18,52` (cadencias 30min/1h, campo truncado),
  `src/app/api/nexo/saude-ingestao/route.ts` (matriz cobertura, truncamento).
- Dependencia: nenhuma. Esforco: M. Risco: baixo. Deploy: FUNCTIONS + APP.
  Estrutural baixo-risco (paraleliza desde ja).

**Ordem de disparo paralelo:**
- Onda 1 (imediata, independentes): F0 -> {F1, F2, F3, A, E, H}.
- Onda 2 (apos A): {B, C, D}. Apos E: comeca G (mockado).
- Onda 3: F (precisa E+B+C). Depois G consome F real.
- Caminho critico: F0 -> A -> {C,D} ; F0 -> E -> F -> G.

---

## 4. DATA-BLOCKED (honesto — rotular, nao fingir)

- **CPF cheio do socio:** a base aberta da Receita publica SO 6 digitos do miolo.
  Cruzamento socio<->doador sera SEMPRE probabilistico (nome+cpf6), nunca
  deterministico. Limite da fonte, nao bug.
- **Doacao de PJ pos-2015:** vedada (ADI 4650). Caminho "empresa doou" so vale
  para eleicoes <=2014. Inaplicavel a 2024 — rotular.
- **CNPJ da contratada no detalhe do contrato:** nao publicado; o unico CNPJ no
  HTML e o da prefeitura (rodape) — falso-positivo a blindar. CNPJ do fornecedor
  vem do CASAMENTO POR NOME com empenho/QSA, nao do portal.
- **Aditivos:** tokens existem em /portal/contrato/{id}; download de aditivos
  WAF-bloqueado deste ambiente (a sonda capturou o token mas nao confirmou
  download). Objeto/PDF do contrato SAO acessiveis.
- **Medicoes fisicas de obra:** nao publicadas.
- **e-Sancoes CGE-SP:** host nao resolve, sem endpoint estavel.
- **Portal Transparencia federal:** HTTP 401 sem chave-api-dados (tem chave em
  apphosting.yaml para CEIS/CNEP; nao e "aberto").
- **Folha individualizada / frota (km/tanque/cartao) / extrato bancario / e-SIC /
  SINAPI item / MROSC / foto / assessor-cargo (sem colecao de nomeacoes):**
  sem endpoint aberto -> bloqueiam familias inteiras do catalogo (FP-*, FC-*,
  OB-01..07, SA-01..07, LC itens). DOM full-text E rico e parseavel (nomeacoes/
  exoneracoes/designacoes com matricula) — a perna "assessor/cargo" e destravavel
  ampliando a regex de `coleta-dom.ts`, nao e data-blocked.
- **TTL nativo do Firestore:** exige config de banco (gcloud), nao vem por push.
- **Custo em R$/USD:** nao medido (exigiria abrir billing); estimativas por
  contagem de invocacoes/tokens apenas.
- **Tempos end-to-end das rotas Next em prod:** nao instrumentados; timeouts
  inferidos de payload+latencia do Firestore vs teto do App Hosting.
