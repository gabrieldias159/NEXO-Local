# NEXO — Auditoria de QUALIDADE DOS INDÍCIOS (detectores + pipeline)

> **Addendum 2026-07-27 — verificação empírica contra dados reais (NEXO local/emulador) + novos fixes.**
> Reexecutei esta auditoria com o NEXO rodando local (`nexo/local-emulador`) contra
> dados REAIS coletados do Portal da Transparência (não amostra). Achados:
>
> **Itens do plano §7 já corrigidos desde 02/07** (confirmado no código atual):
> #1/#4/#12 (filtro central de ente público em `detectores/index.ts` — pega
> TODOS os detectores na saída, não por-arquivo), #3 (denylist de objeto
> genérico, `OBJETOS_GENERICOS`), #5 (piso de exibição `PISO_EXIBICAO_CONFIANCA`
> em `/api/nexo/alertas`), #7 parcial (`confiancaIndicio` com corroboração
> entre detectores, também em `/api/nexo/alertas`). FR-08 (`fornecedores-comp.ts`)
> já exigia CNPJ de 14 dígitos.
>
> **NOVO achado CRÍTICO (não estava neste documento): fan-out de liquidação
> infla `valorEmpenhado`.** A fonte SMARAPD (`fornecedoranalitico`) publica UMA
> LINHA POR EVENTO DE LIQUIDAÇÃO do mesmo empenho (não uma linha por empenho);
> `ValorEmpenho` vem repetido, idêntico, em cada linha. `normalizarEmpenhosFornecedor`
> (`src/lib/nexo/normalizar.ts`) somava isso sem agrupar — comprovado empiricamente:
> um fornecedor com pagamento parcelado (concessionária de energia) chegava a
> **R$ 1,6 BILHÃO** de "total empenhado" em 2025 quando o valor real (51 empenhos
> distintos) era R$ 6,57 milhões — **fator de inflação 244x**. Alimentava
> DIRETAMENTE fracionamento (LC-01..05), concentração (FN-01) e as anomalias
> estatísticas (AN-01/03/04) — tudo que soma `ctx.empenhos`. A MESMA causa-raiz já
> tinha sido corrigida do lado de `functions/src/nexo/perfil-entidades.ts`
> (canonicaliza por fornecedor|UG|NroEmpenho) — protegendo só o Painel de
> Risco/Dossiê, não os detectores. **FIX:** `canonicalizarEmpenhos()` nova em
> `normalizar.ts` — agrupa por `cpfCnpj|UG|NroEmpenho`, toma o MAIOR
> `valorEmpenhado` (nunca soma), SOMA `valorPago` (esse sim é incremental por
> liquidação). Verificado ao vivo via `/api/nexo/analise`: o total agregado da
> cidade caiu para ~R$1,78 bi (dentro do orçamento real de Marília), consistente.
>
> **Item #2 do plano (CPF de folha/servidor como "fornecedor") — CONFIRMADO em
> escala e CORRIGIDO.** ~25% dos registros de `nexo_empenhos` (17.632 de 68.801)
> têm CPF como documento — indivíduos com 190-244 "empenhos" cada, todos abaixo
> do teto de dispensa (claramente subsídio/diária, não compra fatiada). Novo
> helper `cnpjValido()` em `entidades.ts` (CNPJ 14 díg. + dígito verificador,
> diferente de `docValido` que aceita CPF OU CNPJ); aplicado em `fracionamento.ts`
> (LC-01), `licitacoes-extra.ts` (LC-02/03/04/05), `setoriais.ts` (FC-01/SA-08/
> SA-11/FR-11) — a lista exata do plano §7 item 1/2. **Mais 2 detectores achados
> pela verificação ao vivo que o plano de 02/07 não cobria:** AN-04
> (`anomalia-teto.ts`, valor colado no teto) e XS-07 (`cross-comp.ts`, empenho
> sem contrato) também deixavam CPF passar como "fornecedor" — corrigidos com o
> mesmo `cnpjValido()`. Confirmado NÃO aplicar a mesma regra a detectores onde
> CPF é a unidade CORRETA (DE-01/diárias — o beneficiário É uma pessoa).
>
> **Residual conhecido (rotulagem, não bug):** OR-03 ("empenho sem liquidação")
> ainda pode apontar um CPF como `sujeitoTipo:'fornecedor'` — mas o SINAL é
> legítimo (dinheiro empenhado a alguém e nunca liquidado é indício válido,
> seja CNPJ ou CPF); o correto é usar `sujeitoTipo:'servidor'` para CPF em vez
> de excluir. Não corrigido agora (baixo volume, é polimento de rótulo).
>
> **Itens do plano §7 ainda abertos:** #6 (dedupe/consolidação de alertas do
> mesmo sujeito — hoje só conta corroboração pro score, não funde linhas), #8
> (allowlist concessionária/monopólio), #9/#10 (enriquecimento e histórico
> entre exercícios), #11 (expandir `ENTES_PUBLICOS_MARILIA`).
>
> ⚠️ **Estes fixes (fan-out + CNPJ válido) estão em `src/lib/nexo/` — código
> COMPARTILHADO com produção.** O bug do fan-out também afeta o NEXO em
> produção hoje (não é específico do modo local). Recomendação: cherry-pick
> para `main` + deploy, independente do trabalho de NEXO local.

> Nota operacional: esta auditoria foi solicitada como `docs/nexo-qualidade-indicios-auditoria.md`,
> mas a sessão está em **plan mode** — só é permitido editar este arquivo de plano.
> O conteúdo abaixo é o relatório completo (pronto para ser movido para
> `docs/nexo-qualidade-indicios-auditoria.md` quando o plano for aprovado e a
> edição de código/docs for liberada). NÃO houve alteração de código.

Data: 2026-07-02 · Escopo: `src/lib/nexo/detectores/**`, pipeline de indícios
(`detectar`/`analise`/`alertas`), `entidades.ts`, `procedencia.ts`,
`prioridade.ts`, `score-risco.ts`, `functions/src/nexo/{deteccao,cruzamentos}.ts`.

---

## 0. Sumário da causa-raiz do caso reportado

O dono relatou o detector de **FRACIONAMENTO** apontando a própria
**"PREFEITURA MUNICIPAL"** como fornecedor. **Confirmado e localizado.**

O filtro de ente público (`ehEntidadePublica`, `RE_ORGAO_PUBLICO`,
`ENTES_PUBLICOS_MARILIA`) EXISTE em `src/lib/nexo/entidades.ts` e É aplicado na
maioria dos detectores de fornecedor — **mas a FAMÍLIA de fracionamento
(LC-01..LC-05) e os detectores setoriais (FC/SA/FR-11/FR-08) NÃO o importam nem
o chamam.** O agrupamento é feito por `e.cpfCnpj` cru, então o CNPJ da
Prefeitura (repasses/transferências intra-governamentais, folha lançada como
"fornecedor", RAP entre órgãos) entra como um "fornecedor" com dezenas de
empenhos abaixo do teto → dispara fracionamento espúrio.

Arquivo:linha exatos no §2.

---

## 1. Tabela por detector

Legenda de "Filtro EP": aplica `ehEntidadePublica` na entrada? ✅ sim / ❌ não.

### 1.1 Licitações e compras (família fracionamento — foco do bug)

| Detector | Arquivo | Gatilho | Threshold | Filtro EP | Falsos-positivos conhecidos | Correção proposta |
|---|---|---|---|---|---|---|
| **LC-01 Fracionamento** | `fracionamento.ts` | Empenhos por dispensa ao MESMO `cpfCnpj`, janela 90d, soma > teto | `JANELA_DIAS=90`, `MIN_OCORRENCIAS=3`, teto = `getLimiteDispensa` | ❌ | **PREFEITURA/entes como fornecedor** (repasse, folha, RAP intra-governo); CPF de servidor/pensionista; grupos genéricos | Aplicar `ehEntidadePublica(e.cpfCnpj, e.fornecedorNome)` no loop de agrupamento (l.111-116) e no filtro `candidatos` (l.123-125); excluir CPF de folha; exigir materialidade mínima |
| **LC-02 Fracionamento por objeto** | `licitacoes-extra.ts` | `cpfCnpj`+objeto igual, cada < teto, soma > teto | ≥3 ocorrências | ❌ | Ente público; objeto genérico ("diversos"); mesmo `cpfCnpj` sem doc válido | `ehEntidadePublica` + `docValido` + denylist de objeto genérico (reusar `OBJETOS_GENERICOS` do AN-01) |
| **LC-03 Fracionamento entre secretarias** | `licitacoes-extra.ts` | mesmo objeto do mesmo `cpfCnpj` em ≥2 UGs, soma > teto | UGs ≥ 2 | ❌ | Ente público; objeto genérico; concessionária de serviço público (água/energia) | `ehEntidadePublica` + denylist objeto + allowlist de monopólio natural |
| **LC-04 Valor colado no teto** | `licitacoes-extra.ts` (`bandaDetector`) | ≥2 empenhos em 90-100% do teto | banda 0.9-1.0, min 2 | ❌ | Ente público; concessionária; item tabelado | `ehEntidadePublica` na entrada de `bandaDetector` |
| **LC-05 Sequência abaixo do limite** | `licitacoes-extra.ts` (`bandaDetector`) | ≥4 empenhos em 80-99% do teto | banda 0.8-0.99, min 4 | ❌ | idem LC-04 | idem LC-04 (o fix cobre os dois — mesma função) |

### 1.2 Detectores setoriais (também sem filtro)

| Detector | Arquivo | Gatilho | Threshold | Filtro EP | Falsos-positivos | Correção |
|---|---|---|---|---|---|---|
| **FC-01 Posto concentrado** | `setoriais.ts` | 1 `cpfCnpj` ≥60% do combustível | total ≥ R$50k, share ≥60% | ❌ | Ente público; contrato único legítimo (pregão de combustível costuma ter 1 vencedor) | `ehEntidadePublica`; rebaixar a "informativo" quando há contrato licitado |
| **SA-08 Fornecedor de saúde concentrado** | `setoriais.ts` | 1 `cpfCnpj` ≥30% da despesa de saúde | total ≥ R$100k, share ≥30% | ❌ | Ente público (repasse fundo/consórcio de saúde); OSS/consórcio intermunicipal | `ehEntidadePublica` + allowlist de consórcio/OSS de saúde |
| **SA-11 Locação recorrente na saúde** | `setoriais.ts` | ≥4 empenhos de locação (saúde) mesmo `cpfCnpj` | 4 empenhos | ❌ | Ente público; locação legítima recorrente | `ehEntidadePublica` |
| **FR-11 Vencedor em várias secretarias** | `setoriais.ts` | 1 `cpfCnpj` em ≥4 UGs | 4 UGs | ❌ | Ente público; concessionária (água/energia/telefonia atende todas as UGs) | `ehEntidadePublica` + allowlist de concessionária/monopólio |
| **FR-08 CNAE incompatível (proxy)** | `fornecedores-comp.ts` | 1 `cpfCnpj` em ≥4 "ramos" textuais distintos | ≥4 ramos | ❌ | Proxy fraca por natureza (confiabilidade já 42); atacadista/varejista amplo é legítimo | `ehEntidadePublica`; manter piso "informativo"; enriquecer com CNAE real antes de subir a "atenção" |

### 1.3 Detectores que JÁ aplicam o filtro (referência — o padrão correto)

| Detector | Arquivo | Gatilho | Filtro EP | Observações de qualidade |
|---|---|---|---|---|
| FN-01 Concentração de fornecedor | `concentracao.ts` | ≥20% do total empenhado | ✅ | Bom modelo de código (l.28). "Concentração não é irregularidade" já no texto |
| AN-01 Outlier de preço | `anomalia-preco.ts` | Iglewicz-Hoaglin \|Z\|>3.5 | ✅ (l.89) | Melhor detector em qualidade: exclui objeto genérico, MAD=0 degenerado, e cap `TOP_K=60` |
| AN-03 Concentração órgão→fornecedor | `anomalia-concentracao.ts` | top-share ≥50% OU HHI ≥2500 | ✅ (l.49) | Pisos de volume/nº empenhos evitam ruído de baixo valor |
| AN-04 Valor próximo do teto | `anomalia-teto.ts` | 10% finais abaixo do teto | ✅ (l.53) | Sobrepõe-se conceitualmente a LC-04/LC-05 (ver §6 dedupe) |
| FR-06 Múltiplos CNPJs mesma raiz | `grupo-cnpj.ts` | ≥2 estabelecimentos mesma raiz | ✅ (l.29) | — |
| BN-01 Lei de Benford | `benford-det.ts` | MAD de Nigrini, n≥80 | ✅ (l.65) | Sempre `atencao`, nunca crítico. Bom |
| FR-04 / FR-04E Sanção fed./est. × empenho | `sancoes-det.ts` / `sancoes-estaduais-det.ts` | sanção vigente + empenho | ✅ (`fornecedoresParaSancoes` l.206) | Cross-source oficial: melhor confiabilidade do sistema (85-90) |
| MF-10 Restos a pagar antigos | `restos.ts` | RAP > 2 anos sem baixa, soma ≥R$50k | ✅ (l.40) | — |
| OR-03 Empenho sem liquidação | `liquidacao.ts` | > 90 dias sem liquidar, ≥R$10k | ✅ (l.43) | — |
| OR-07 Anulações recorrentes | `orcamento.ts` | ≥2 anulações mesmo fornecedor | ✅ (l.23) | — |
| OR-08 Empenhos fim de exercício | `orcamento.ts` | ≥30% em dezembro | n/a (sujeito=órgão) | — |
| OR-09 Reforço atípico | `orcamento.ts` | ≥3 reforços no mesmo empenho | n/a (sujeito=empenho) | — |

### 1.4 Detectores de catálogo (`*-cat.ts`)

Dezenas de IDs (LC-08..LC-25, OB-*, FS-*, ED-*, FR-*, DIV-*, XS-*) estão
implementados mas retornam `[]` porque dependem de fonte que o `ContextoAnalise`
não carrega (texto de edital, datas de sessão, QSA/abertura de CNPJ, planilha de
itens). Não geram ruído hoje (degradam honestamente), mas quando forem ligados
devem herdar o MESMO guard de ente público + piso de qualidade — hoje o padrão
não está garantido por construção (é opt-in por detector).

---

## 2. O bug do fracionamento com ente público — causa-raiz e fix

### Causa-raiz (arquivo:linha)

`src/lib/nexo/detectores/fracionamento.ts`:
- **l.110-116** — agrupamento por fornecedor sem guard:
  ```
  for (const e of ctx.empenhos) {
    if (!e.cpfCnpj || !e.data || e.valorEmpenhado <= 0) continue;   // ← falta ehEntidadePublica
    const arr = porFornecedor.get(e.cpfCnpj) ?? [];
    ...
  }
  ```
- **l.123-125** — filtro `candidatos` também sem guard.

O arquivo **não importa** `ehEntidadePublica` de `../entidades` (confirmado: não
aparece na busca por `ehEntidadePublica` no arquivo). O mesmo vale para
`licitacoes-extra.ts` (LC-02..LC-05) e `setoriais.ts` (FC/SA/FR-11) e
`fornecedores-comp.ts` (FR-08).

**Por que o filtro não chega ao detector:** ele é aplicado *ponto a ponto* em
cada detector que "lembrou" de chamá-lo (FN-01, AN-01, AN-03, AN-04, FR-06,
BN-01, FR-04, MF-10, OR-03, OR-07) e no ranking de `/api/nexo/analise` (l.407),
mas **não há um ponto único** (ex.: sanitização do `ctx.empenhos`/`ctx.despesas`
na montagem do `ContextoAnalise`) que garanta a exclusão para TODOS. É um
guard por convenção, não por construção — daí o vazamento nos que esqueceram.

O espelho em `functions/src/nexo/cruzamentos.ts` tem `RX_ENTE_PUBLICO` +
`ehEntePublico` (l.124-133) e o aplica em `fornecedoresPorRaiz`/`sociosDeDocs` —
ou seja, o lado functions cobre os cruzamentos, mas NÃO cobre os detectores
LC/FC/SA (que rodam do lado `src`, chamados por `/api/nexo/detectar`).

### Fix (2 camadas)

**Fix pontual (S — corrige o reportado já):** importar e chamar
`ehEntidadePublica(doc, nome)` no loop de entrada de:
`fracionamento.ts` (l.111-116 e 123-125), `licitacoes-extra.ts` (LC-02/03 e
`bandaDetector`), `setoriais.ts` (FC-01/SA-08/SA-11/FR-11) e
`fornecedores-comp.ts` (FR-08) — idêntico ao que `concentracao.ts:28` já faz.

**Fix estrutural (M — impede recaída):** sanitizar o `ContextoAnalise` na origem.
Em `rodarDetectores` (ou nas rotas `detectar`/`analise`, antes de montar o ctx),
pré-filtrar `empenhos`/`despesas`/`restosAPagar` removendo entes públicos e
guardando o subconjunto público num campo separado (`ctx.transferencias`) para
os detectores que legitimamente queiram olhá-lo. Assim o default é seguro e o
guard vira invariante — inclusive para os detectores de catálogo futuros.

**Casos correlatos a tratar no mesmo fix (o dono citou explicitamente):**
- **Transferências entre órgãos** — repasse Prefeitura→IPREMM/Câmara/fundos:
  cobertos por `ENTES_PUBLICOS_MARILIA` + `RE_ORGAO_PUBLICO`, mas a denylist é um
  "SEED conservador" (comentário em `entidades.ts:12`); expandir com CNPJs
  confirmados por natureza jurídica 1xxx (Receita) e PNCP.
- **Restos a pagar** — MF-10 já filtra; garantir que o fix estrutural não
  reintroduza RAP intra-governo.
- **Folha classificada como "compra"** — pagamento a servidor (CPF) aparece em
  empenho/despesa e vira "fornecedor". Hoje NENHUM guard remove CPF de folha dos
  detectores de fracionamento. Propor: excluir sujeitos cujo elemento de despesa
  é de pessoal (3.1.90.11/13 etc.) ou cujo `cpfCnpj` tem 11 dígitos + objeto de
  folha. Alternativamente, os detectores de fracionamento de compra deveriam
  operar SÓ sobre CNPJ de 14 dígitos válido (`docValido`), o que já elimina folha
  e lixo numérico de uma vez.

---

## 3. Barra de qualidade — score de confiança por indício

Hoje há um **score triplo** (`confiabilidade`, `probabilidadeIrregularidade`,
`probabilidadeEnquadramento`) combinado por média geométrica em
`prioridade.ts:scorePrioridade`, e o ranking usa `compararPotencial`. **Porém:**
- `confiabilidade` é um número HARD-CODED por detector (ex.: 42, 66, 78) — não
  reflete a força real do join daquele indício específico.
- **Não existe PISO**: `/api/nexo/alertas` só filtra por `status`/`classificacao`
  e ordena por potencial, capando em `LIMITE_PAINEL=300` (motivo: payload). Não
  há corte por qualidade — indícios fracos são despejados (até 300, por potencial).
- **Não há dedupe por sujeito** entre detectores (só `chaveDeteccao` por
  detector+sujeito+episódio) — o mesmo CNPJ pode gerar LC-01 + LC-04 + AN-04 +
  FN-01 e ocupar 4 linhas quase idênticas.

### Proposta: `confiancaIndicio` (0-100) computada, com 4 fatores

Substituir o `confiabilidade` fixo por um score DERIVADO no momento da detecção
(ou num pós-processador único em `rodarDetectores`), multiplicativo:

1. **Força do join** (peso alto): documento completo válido (`docValido`, 14
   díg. CNPJ ou 11 CPF real) = 1.0; nome-normalizado exato = 0.7; proxy textual
   (regex de objeto, ex.: FR-08/setoriais) = 0.4; join fraco (nome+cpf6,
   cruzamentos) = 0.3.
2. **Origem do dado**: fonte oficial cruzada (CGU/TCE/PNCP — FR-04/04E) = 1.0;
   single-source portal (SMARAPD, maioria) = 0.75; heurística/estatística
   agregada (Benford, outlier) = 0.6.
3. **Corroboração cruzada**: +bônus se o MESMO sujeito é flagado por N
   detectores independentes (ex.: fracionamento + valor-colado + concentração no
   mesmo órgão) — vínculo real sobe; indício isolado fica no nível base.
4. **Materialidade R$**: `valorEnvolvido` normalizado contra piso de relevância
   por categoria (não linear — log). Abaixo do piso, penaliza.

`confiancaIndicio = 100 · f_join · f_origem · (1 + f_corrob) · f_material`, com teto 100.

### Piso de exibição (o que o dono pediu)

- **Piso duro de RUÍDO ESTRUTURAL** (não é score — é invariante): ente público,
  objeto genérico, contrato licitado, CPF de folha, doc inválido → **nunca vira
  indício** (é o §2).
- **Piso de score** para o resto: `scorePrioridade < PISO_EXIBICAO` (sugestão
  inicial 25-30, calibrar com o backlog real) → **não exibir por padrão**;
  mandar para uma aba "ruído/baixa confiança" com toggle (transparência: não
  some, mas não polui a worklist). Rebaixar automaticamente a `informativo`
  quando `confiancaIndicio < 40`.
- Aplicar o piso **na rota `/api/nexo/alertas`** (server-side, antes do cap de
  300) e no cron `deteccao.ts` como flag `_baixaConfianca:true` (persistir, não
  descartar — permite auditar a calibração).

---

## 4. Enriquecimento dinâmico ("ser dinâmico")

Hoje os detectores rodam sobre dados **estáticos** coletados (`nexo_empenhos`,
`nexo_despesas`, etc.). O único enriquecimento existente é:
- em `/api/nexo/analise` (l.430-484): os **top-6 fornecedores** do ranking
  recebem `getCnpj` (QSA/flags cadastrais) → gera FN-*/FR-09. Não chega aos
  detectores de fracionamento.
- cross-source (sanções/leniência/sócios/doações/TCE) anexado ao `ctx`, mas só
  consumido pelos detectores cross (FR-04/04E/05, XS-*).

`procedencia.ts` **NÃO classifica qualidade** do indício — ele monta o LINK da
prova documental (SMARAPD/PNCP/DOM). O nome sugere "procedência de qualidade"
mas é rastro probatório (para onde clicar), não rótulo de confiança. Ou seja:
não há hoje um classificador de origem/qualidade que filtre/rotule indícios.

### O que agregar a CADA indício antes de mostrar

Um indício deveria nascer com **contexto comparativo** já embutido (parte já
existe no AN-01/AN-03 — generalizar para todos):

- **Comparativo**: "valor X é N× a mediana do grupo (objeto/elemento)"; "share
  de Y% vs média de Z% dos pares do mesmo órgão". (AN-01/AN-03 já fazem; LC-*
  não.)
- **Frequência/recorrência**: "padrão ocorreu K vezes no exercício" e
  **histórico entre exercícios** (o mesmo CNPJ fraciona todo ano?) — hoje cada
  execução é isolada por exercício; cruzar `nexo_alertas` de anos anteriores.
- **Entidade enriquecida** (join tardio, assíncrono): CNAE real (valida FR-08),
  porte/capital social (valida FR-09), data de abertura (CNPJ novo pré-certame),
  QSA (grupo econômico), situação cadastral, sanção vigente. Chamar `getCnpj`
  para TODO sujeito de indício médio/alto — não só o top-6 do ranking.
- **"Por que é suspeito" objetivo**: cada indício já tem `explicacao`, mas
  falta a linha "o que tornaria isto legítimo" (ex.: contrato licitado, fornecedor
  único de insumo) para o auditor descartar rápido — reduz o custo do falso positivo.
- **Corroboração**: listar os OUTROS detectores que apontam o mesmo sujeito
  (fecha o dedupe do §6 e vira sinal de confiança do §3).

---

## 5. Estado do pipeline de indícios (como nasce e chega à UI)

1. **Cômputo**: cron `functions/deteccao.ts` → `POST /api/nexo/detectar`
   (`detectar/route.ts`) lê `nexo_*` do Firestore, normaliza, chama
   `rodarDetectores(ctx)` (`detectores/index.ts`) → ~67 detectores.
2. **Ordenação**: `rodarDetectores` já ordena por `compararPotencial` (score
   triplo, média geométrica). Detector que lança não derruba os demais.
3. **Enriquecimento**: `enriquecerProcedencia` (link de prova) +
   `enriquecerCrivoLegal` (norma) por alerta.
4. **Persistência**: `persistirAlertas` (`deteccao.ts:240`) faz upsert em
   `nexo_alertas` por `chaveDeteccao` = `sha1(detectorId|exercicio|sujeitoTipo|sujeitoId|discriminador)`.
   Dedupe = por detector+sujeito+episódio; **incrementa `ocorrencias`**;
   reconciliação marca `ativo:false` os que sumiram. **Sem descarte por qualidade.**
5. **Leitura/UI**: `GET /api/nexo/alertas` (`alertas/route.ts`) — snapshot-first,
   filtra por `status`/`classificacao`/`ativo`, ordena por potencial, capa em
   `LIMITE_PAINEL=300`. **Sem piso de qualidade; sem dedupe cross-detector.**

**Onde há score de confiança/severidade:** `scores.*` (por detector, valores
fixos) + `scorePrioridade`/`scoreRiscoEntidade`. **Onde faltam:** (a) confiança
computada por join real; (b) piso de exibição; (c) dedupe por sujeito.

---

## 6. Achados adicionais de ruído (top-5 fontes)

1. **Ente público como fornecedor** — LC-01..05, FC-01, SA-08, SA-11, FR-11,
   FR-08 sem `ehEntidadePublica` (o bug reportado). *Impacto: alto, muito visível.*
2. **CPF de folha/servidor tratado como fornecedor** — nenhum detector de
   fracionamento restringe a CNPJ válido; folha entra como dispensa fracionada.
3. **Sobreposição de detectores (falta dedupe)** — o mesmo CNPJ colado no teto
   dispara LC-04 **e** AN-04 **e** (se ≥ teto) LC-01; painel infla com 3-4 linhas
   redundantes do mesmo fato. Consolidar por sujeito.
4. **Proxies textuais fracas exibidas como indício "de atenção"** — FR-08
   (heterogeneidade de objeto ≠ CNAE incompatível) e regex de objeto genérico
   ("diversos"/"geral") em LC-02/03 sem a denylist que o AN-01 já tem.
5. **Concessionária/monopólio natural** (água, energia, telefonia) inflando
   concentração/vencedor-várias-UGs (FN-01, FR-11, SA-08) — legítimo por natureza;
   falta allowlist para rebaixar a "informativo".

---

## 7. Plano priorizado (esforço S/M/L × impacto)

| # | Correção | Esforço | Impacto | Notas |
|---|---|---|---|---|
| 1 | `ehEntidadePublica` em LC-01..05, FC-01, SA-08, SA-11, FR-11, FR-08 (fix pontual) | **S** | **Alto** | Corrige o caso reportado. ~6 arquivos, 1 import + 1 linha cada. Cobrir com teste (existe `invariante-fornecedor.test.ts`) |
| 2 | Restringir detectores de fracionamento a `docValido` de 14 díg. (mata folha/CPF/lixo) | **S** | **Alto** | Elimina folha-como-compra sem lista |
| 3 | Denylist de objeto genérico em LC-02/LC-03 (reusar `OBJETOS_GENERICOS` do AN-01) | **S** | **Médio** | Corta proxy textual fraca |
| 4 | Sanitizar `ContextoAnalise` na origem (guard estrutural, campo `transferencias` separado) | **M** | **Alto** | Impede recaída; protege detectores de catálogo futuros |
| 5 | Piso de exibição + aba "baixa confiança" na rota `/api/nexo/alertas` | **M** | **Alto** | Barra de qualidade visível; começar com `PISO_EXIBICAO≈25-30`, calibrar |
| 6 | Dedupe/consolidação por sujeito (agrupar LC/AN/FN do mesmo CNPJ+órgão) | **M** | **Alto** | Reduz volume do painel e vira sinal de corroboração |
| 7 | `confiancaIndicio` computada (4 fatores) substituindo `confiabilidade` fixo | **M** | **Médio-Alto** | Base do piso e do ranking honesto |
| 8 | Allowlist de concessionária/monopólio → rebaixar a "informativo" | **S** | **Médio** | água/energia/telefonia/consórcio de saúde |
| 9 | Enriquecimento `getCnpj` para todo sujeito de indício médio/alto (não só top-6) | **L** | **Médio** | CNAE valida FR-08; abertura valida LC-22; assíncrono/cacheado |
| 10 | Contexto comparativo + histórico entre exercícios em todos os detectores | **L** | **Médio** | Generalizar o que AN-01/AN-03 já fazem; cruzar `nexo_alertas` de anos anteriores |
| 11 | Expandir `ENTES_PUBLICOS_MARILIA` por natureza jurídica 1xxx (Receita) + PNCP | **M** | **Médio** | Reduz falso negativo do filtro (denylist é "SEED conservador") |
| 12 | Garantir guard por construção nos `*-cat.ts` antes de ligá-los | **M** | **Preventivo** | Hoje o guard é opt-in por detector |

**Ordem sugerida:** 1 → 2 → 3 (quick-wins que matam ~top-2 fontes de ruído hoje)
→ 4 → 5 → 6 (estrutura da barra de qualidade) → 7..12.
