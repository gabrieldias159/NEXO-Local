All references confirmed. I have enough verified detail. Notably I confirmed the analyses got the key facts exactly right (e.g. `index.ts:128` sort, `alertas/route.ts:195` sort, the 2-leg `scores` in `tipos.ts:36-39`, `grupo-cnpj.ts` raiz-8 vs `analise/route.ts:262-270` full-CNPJ, and the two existing Firestore indexes on `valorEnvolvido` but none on recency/score). Now I'll write the consolidated roadmap.

# NEXO — Roadmap de Melhorias (consolidado ORÁCULO · VERTEX · PRISMA · LASTRO · FANTASMA)

Diagnóstico unânime das 5 personas: **o motor de detecção é arquiteturalmente sólido e honesto, mas está alimentado por uma população suja e ordena tudo pelo proxy errado (R$).** Não existe **nenhuma** camada de resolução/sanitização de entidade no pipeline; a ordenação é sempre `b.valorEnvolvido - a.valorEnvolvido`; e o "score triplo" do plano-mestre é, no runtime, apenas duplo. Os três defeitos que o dono viu são reais e estão todos confirmados no código.

---

## P0 — Correções de Qualidade (fazer primeiro)

Problemas consolidados e deduplicados das 5 personas, com arquivo:linha verificado e fix concreto.

### P0-1 — A própria Prefeitura / órgãos públicos aparecem como FORNECEDOR (bug "Fornecedora: Prefeitura de Marília")
**Apontado por:** todas as 5 personas (consenso total).
**Onde (verificado):**
- `src/lib/nexo/detectores/concentracao.ts:24-31` — loop `for (const e of ctx.empenhos)` agrega por `e.cpfCnpj` cru, sem filtro.
- `src/app/api/nexo/analise/route.ts:262-270` — `mapa` do `topFornecedores` idem.
- `src/lib/nexo/detectores/grupo-cnpj.ts:26-36`; `fracionamento.ts`; `restos.ts`; `setoriais.ts`; `liquidacao.ts` — mesmo padrão.
- `src/lib/nexo/constants.ts:23` — `MARILIA.cnpjPrefeitura = '44477909000100'` existe, mas é usado **só** como `cnpjOrgao` de consulta PNCP. **Nunca** como exclusão. Confirmado: grep por `sanitiz|isOrgaoPublico|excludeCnpj` em `src/lib/nexo` = zero.

**Causa-raiz:** os normalizadores (`normalizar.ts:71-89`) aceitam qualquer `CPFCNPJ`/`NomeFornecedor` que a SMARAPD devolver, incluindo transferências intra-governamentais, repasses ao RPPS, duodécimo da Câmara, folha lançada como "fornecedor". Nenhuma camada classifica pessoa jurídica privada vs ente público.

**Fix (ADITIVO):** criar `src/lib/nexo/entidades.ts` como fonte única de verdade:

```ts
// src/lib/nexo/entidades.ts
import { MARILIA } from './constants';

// Seed — CONFIRMAR contra Receita/PNCP e popular incrementalmente.
export const ENTES_PUBLICOS_MARILIA = new Set<string>([
  MARILIA.cnpjPrefeitura,          // 44477909000100
  // IPREMM, Câmara, fundos, fundações, autarquias (SAAE/DAEM)...
]);
const RAIZES_PUBLICAS = new Set([...ENTES_PUBLICOS_MARILIA].map(c => c.slice(0, 8)));

export const RE_ORGAO_PUBLICO =
  /\b(PREFEITURA|MUNICIPIO DE|CAMARA MUNICIPAL|FUNDO MUNICIPAL|INSTITUTO DE PREVIDENCIA|IPREMM|AUTARQUIA|FUNDACAO|SECRETARIA MUNICIPAL|SAAE|DAEM)\b/;

export function normalizarNome(nome: string): string {
  return (nome ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}
export function cnpjRaiz(doc: string): string {
  return doc?.length === 14 ? doc.slice(0, 8) : doc; // CPF (11) não tem raiz
}
export function ehEntidadePublica(doc: string, nome: string): boolean {
  if (doc && (ENTES_PUBLICOS_MARILIA.has(doc) || RAIZES_PUBLICAS.has(cnpjRaiz(doc)))) return true;
  return RE_ORGAO_PUBLICO.test(normalizarNome(nome));
}
```

Aplicar **um guard de 1 linha** no início de cada loop por fornecedor:
```ts
if (ehEntidadePublica(e.cpfCnpj, e.fornecedorNome)) continue;
```
nos detectores acima e no `mapa` de `topFornecedores` (`analise/route.ts:263`).

**Defesa em profundidade** (FANTASMA): carimbar `_orgaoPublico:boolean` e `_docValido:boolean` na **ingestão** (`functions/src/nexo/coleta.ts`, persistir) para o filtro custar zero no serving. **Atenção:** `functions/` é self-contained e não importa de `src/lib` — a denylist precisa ser duplicada/sincronizada (documentar). Isso é P2; o guard em `src/lib` resolve o P0 imediato.

**Risco de regressão: BAIXO.** Só adiciona `continue` guardado; não toca em fórmulas de score nem na lógica de detecção. Único cuidado: a denylist precisa ser validada contra fonte oficial para não excluir um fornecedor privado por engano (a heurística de nome é conservadora — usa palavras inequívocas de ente público).

---

### P0-2 — Ordenação NUNCA é cronológica decrescente
**Apontado por:** todas as 5 personas.
**Onde (verificado):**
- `src/app/api/nexo/alertas/route.ts:195` — `alertas.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido)`
- `src/app/api/nexo/analise/route.ts:340` — idêntico.
- `src/lib/nexo/detectores/index.ts:128` — `return alertas.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido)`.

**Causa-raiz:** chave de ordenação única (valor financeiro) espalhada em 3 pontos. Os campos temporais `ultimaDeteccaoEm`/`primeiraDeteccaoEm` **existem** e são lidos (`alertas/route.ts:135-136`), mas nunca governam a ordem; a rota nem aceita parâmetro.

**Fix (ADITIVO):** em `alertas/route.ts`, aceitar `?ordem=recente|potencial|valor` e implementar comparadores, mantendo o `sort` atual como fallback de "valor":
```ts
const ordem = searchParams.get('ordem') ?? 'potencial'; // default vem do P0-3
const comparadores = {
  recente:   (a, b) => (b.ultimaDeteccaoEm ?? '').localeCompare(a.ultimaDeteccaoEm ?? '')
                       || (b.valorEnvolvido - a.valorEnvolvido),
  valor:     (a, b) => b.valorEnvolvido - a.valorEnvolvido,           // atual
  potencial: (a, b) => scorePrioridade(b) - scorePrioridade(a)        // P0-3
                       || (b.ultimaDeteccaoEm ?? '').localeCompare(a.ultimaDeteccaoEm ?? ''),
};
alertas.sort(comparadores[ordem] ?? comparadores.potencial);
```
Para listas datadas ao-vivo (fracionamento, diárias, anulação), considerar um campo `dataEpisodio` no `AlertaDetectado` (= última data da janela) para ordenar cronologicamente também fora dos alertas persistidos — isso é P1.

**Risco de regressão: BAIXO.** Adiciona ramo de ordenação sem remover o existente; quem chamava sem `?ordem` muda de comportamento (intencional, é o pedido do dono).

---

### P0-3 — Ranking por POTENCIAL não existe; ordena por R$ (e o "score triplo" é só duplo)
**Apontado por:** todas as 5 personas (é o ponto mais citado).
**Onde (verificado):**
- `src/lib/nexo/detectores/tipos.ts:35-39` — comentário diz "Score triplo — ver plano-mestre §7" mas `scores` tem **só** `confiabilidade` + `probabilidadeIrregularidade`. Falta a 3ª perna (prob. enquadramento).
- `src/lib/nexo/schemas.ts:154-157` e `src/app/api/nexo/alertas/route.ts:113-116` — espelham os 2 campos.
- `src/app/nexo/page.tsx:210-219` — `indiciosPrioritarios` ordena por `PESO_CLASSE` depois valor; **nunca** pelos scores numéricos.
- Não há função de score composto em lugar nenhum do `lib/nexo`.

**Causa-raiz:** a 3ª dimensão nunca foi adicionada ao tipo nem preenchida pelos ~50 detectores; e não existe agregador que combine as pernas. O sistema cai no proxy "valor" — colocando um contrato grande e legítimo (energia, 80% confiabilidade / baixa prob. irregularidade) acima de um indício pequeno mas crítico (empresa sancionada recebendo recurso).

**Fix (parte ADITIVA + parte sensível):**

(a) Tornar a 3ª perna opcional com default derivado — **não exige tocar os 50 detectores**:
```ts
// tipos.ts e schemas.ts
scores: {
  confiabilidade: number;
  probabilidadeIrregularidade: number;
  probabilidadeEnquadramento?: number;  // novo, opcional
};
```
Em `paraAlerta` (`alertas/route.ts:113`) ler com default: `probabilidadeEnquadramento: numero(scores.probabilidadeEnquadramento) || (fundamentoLegal.length > 0 ? 60 : 40)`.

(b) Criar `src/lib/nexo/prioridade.ts` (média geométrica penaliza quando uma perna é baixa — reduz falso positivo):
```ts
export function scorePrioridade(a: AlertaPersistido): number {
  const c  = (a.scores.confiabilidade ?? 0) / 100;
  const pi = (a.scores.probabilidadeIrregularidade ?? 0) / 100;
  const pe = (a.scores.probabilidadeEnquadramento ?? 50) / 100;
  const base = Math.cbrt(c * pi * pe) * 100;            // 0..100
  const recencia = a.ultimaDeteccaoEm ? 1 : 0.9;        // leve bônus de frescor
  return base * recencia;
}
```

(c) Usar `scorePrioridade` como **chave primária default** em `alertas/route.ts:195` e em `page.tsx:210-219` (`indiciosPrioritarios`).

**Risco de regressão: MÉDIO.** O campo opcional + a função são aditivos (baixo). O ponto sensível é **trocar a chave de sort** em 2 lugares que hoje produzem resultado ruim — é exatamente o que o dono quer mudar, mas muda a ordem visível para todos. Mitigar: manter `?ordem=valor` disponível e validar com um snapshot antes/depois.

---

### P0-4 — Duplicata de fornecedor: filiais e razão×fantasia viram N linhas
**Apontado por:** ORÁCULO, VERTEX, PRISMA, LASTRO, FANTASMA.
**Onde (verificado):**
- `src/app/api/nexo/analise/route.ts:265` e `concentracao.ts:26` — chaveiam por CNPJ **completo (14 díg.)**.
- `src/lib/nexo/detectores/grupo-cnpj.ts:28` — único que usa raiz (`slice(0,8)`), e isolado, só como detector FR-06.
- Nome pego cru (`normalizar.ts:78`), sem normalização de caixa/acento/sufixo.

**Causa-raiz:** não há chave canônica de entidade; cada detector reimplementa o agrupamento. Mesma empresa em 3 filiais = 3 linhas, diluindo o valor real e poluindo a curva ABC.

**Fix:** no `entidades.ts`, expor `resolverEntidade(empenho) → { idCanonico: cnpjRaiz||cpfCnpj, rotulo: normalizarNome(nome) sem LTDA/ME/EPP/EIRELI/SA }`. Migrar `topFornecedores` para agregar por `idCanonico`, colapsando filiais e exibindo nº de estabelecimentos. **Não fundir CPF (11 díg.) com CNPJ.** Manter FR-06 como o detector que evidencia a multi-filial.

**Risco de regressão: MÉDIO.** Muda a granularidade de agregação do ranking (mexe-em-código-que-funciona). Proteger com snapshot. Como mitigação de baixo risco, dá para entregar primeiro só a normalização de nome (dedup de grafia) e deixar o colapso por raiz como opção `?agregar=grupo`.

---

### P0-5 — Estornos/anulações inflam valor (empenho ≠ anulação)
**Apontado por:** ORÁCULO, VERTEX, PRISMA, LASTRO, FANTASMA.
**Onde (verificado):**
- `src/lib/nexo/normalizar.ts:8-24` — `EmpenhoNorm` **não carrega** `tipoEmpenho`; só `DespesaNorm` (linha ~285) tem.
- `concentracao.ts:24-31` e `analise/route.ts:248,263-270` somam `valorEmpenhado` cru sobre `ctx.empenhos` — sem distinguir empenho de anulação/reforço.
- `parseValorBR` (`normalizar.ts:27-35`) não preserva sinal de estorno.

**Causa-raiz:** o caminho de fornecedor/ranking roda sobre o módulo analítico (`fornecedoranalitico`), que perde o tipo de movimento na normalização. Onde `Math.abs()` é usado em detectores de despesa, a anulação negativa vira positivo somado.

**Fix:**
1. Adicionar `tipoEmpenho: string` ao `EmpenhoNorm` (mapear `pick(rec, 'TipEmpenho', 'TipoEmpenho')`, já lido em `normalizarDespesas`).
2. Helper `ehMovimentoExpansivo(e) = e.valorEmpenhado > 0 && !/anula|estorno|cancel/i.test(e.tipoEmpenho)`.
3. Na agregação do ranking/concentração, computar **líquido** = Σempenhos − Σanulações por sujeito (não `Math.abs`); descartar quem fica com líquido ≤ 0.
4. **Alternativa de menor risco** (LASTRO): derivar o net a partir do array `despesas` (que já tem `tipoEmpenho`) e usá-lo como base do ranking, sem mexer no `EmpenhoNorm`.

**Risco de regressão: MÉDIO.** O schema do norm é aditivo (baixo); mexer na agregação que funciona é o ponto sensível — snapshot obrigatório.

---

## P1 — Ciência de Dados (resolução de entidades, modelos, score triplo, grafo, falso positivo)

| # | Item | Valor | Esforço | Risco | Arquivos |
|---|------|-------|---------|-------|----------|
| 1 | **Camada de resolução de entidade compartilhada** (`entidades.ts`): `ehEntidadePublica`, `normalizarNome`, `cnpjRaiz`, `resolverEntidade`. Base de quase todos os P0. | alto | médio | baixo | `src/lib/nexo/entidades.ts` (novo) |
| 2 | **Score triplo materializado de verdade**: `probabilidadeEnquadramento` opcional + default derivado de `fundamentoLegal`+`classificacao`; detectores preenchem a 3ª perna **incrementalmente** sem big-bang nos 50. | alto | médio | baixo | `tipos.ts`, `schemas.ts`, `prioridade.ts` (novo) |
| 3 | **Média geométrica como combinador** (não produto puro nem soma): penaliza alerta com qualquer perna fraca → reduz falso positivo de cara. | alto | baixo | baixo | `src/lib/nexo/prioridade.ts` |
| 4 | **Enriquecer `CnpjInfo` com natureza jurídica** (BrasilAPI já é chamada em `cnpj.ts`): código `1xxx` = Administração Pública → confirma `ehEntidadePublica` por cadastro, evita falso positivo de "empresa recém-criada" sobre órgão público. | médio | baixo | baixo | `src/lib/nexo/sources/cnpj.ts`, `fornecedor-flags.ts` |
| 5 | **Curva ABC / concentração por GRUPO econômico** (raiz), sobre base líquida e sem entes públicos — em vez de CNPJ isolado. Classificar faixa A=80% acumulado. | alto | médio | médio | `concentracao.ts`, `entidades.ts`, `analise/route.ts` |
| 6 | **Cross-source de alta confiabilidade / baixo ruído**: fornecedor empenhado × CEIS/CNEP (sanção ativa recebendo recurso) e contrato PNCP × empenho SMARAPD divergente. Coincidência cross-source = pouco falso positivo. | médio | alto | nenhum | novos em `detectores/`, `sources/sancoes-federais.ts`, `coleta-pncp.ts` |
| 7 | **Endurecer detectores de alto ruído**: concentração de monopólio natural (energia/água/combustível com 1 distribuidor) por lista de CNAE/objeto esperado; exigir `n>=3` empenhos para não disparar com 1 contrato único legítimo. | médio | baixo | baixo | `concentracao.ts` (limiar 20%), `setoriais.ts`, `diarias.ts` |

Grafo de relacionamento (PRISMA) fica como evolução natural do item 1 (a `chaveEntidade` é o nó); não priorizar antes de P0 estar fechado.

---

## P2 — Fluxo de Dados & Infra (ordering/ranking no servidor, índices, persistência, performance, fontes novas)

| # | Item | Valor | Esforço | Risco | Arquivos |
|---|------|-------|---------|-------|----------|
| 1 | **Ordenação/corte no servidor** (orderBy + limit no `:runQuery`). Hoje `lerColecaoNexo` (`firestore-read.ts`) **não tem** orderBy/limit/startAfter — lê a coleção inteira do exercício e ordena/corta em JS. Estender `FiltroNexo` com `orderBy?` e `limit?`; `/api/nexo/alertas` emite `where(exercicio,ativo) + orderBy + limit(200)`. | alto | médio | baixo | `firestore-read.ts`, `alertas/route.ts` |
| 2 | **Índices Firestore para recência e score** (ADITIVO). Hoje `firestore.indexes.json:84-100` só tem `exercicio+ativo+valorEnvolvido` e `exercicio+status+valorEnvolvido` — desperdiçados, o REST nunca usa orderBy. Adicionar `(exercicio, ativo, ordenacaoTs DESC)`, `(exercicio, ativo, scorePrioridade DESC)`, `(exercicio, status, ordenacaoTs DESC)`. **Sem eles, orderBy server-side dá FAILED_PRECONDITION.** | alto | baixo | nenhum | `firestore.indexes.json` |
| 3 | **Persistir `scorePrioridade` e `ordenacaoTs`** (epoch de `ultimaDeteccaoEm`) no doc `nexo_alertas`, ao carimbar a chave. Habilita o orderBy do P2-1/P2-2. | médio | médio | baixo | `detectar/route.ts`, `functions/src/nexo/deteccao.ts` |
| 4 | **Materializar o ranking de fornecedores no cron** (igual aos alertas). Hoje `/api/nexo/analise` recomputa ranking + `getCnpj` (allSettled sobre 6 fornecedores, `analise/route.ts:285-339`) a cada request — lento e bate em fonte externa no caminho do usuário. Mover agregação (já com filtro de órgão público + netting + colapso por raiz) para o cron em `nexo_ranking_fornecedores/{exercicio}`; a rota só LÊ. | alto | médio | baixo | `functions/src/nexo/deteccao.ts`, `analise/route.ts` |
| 5 | **Sanitização na ingestão**: carimbar `_orgaoPublico`, `_docValido`, `_cnpjRaiz`, `_nomeCanonico` no `persistir` (custo amortizado na escrita). Habilita filtros server-side baratos. **Atenção:** `functions/` não importa `src/lib` → duplicar/sincronizar a denylist. | alto | médio | baixo | `functions/src/nexo/coleta.ts`, denylist espelhada |
| 6 | **Paginação real (`startAfter`)** nas rotas que devolvem coleção inteira. `/api/nexo/analise` lê todos os empenhos do exercício (dezenas de milhares) para um top-30 a cada request — fica caro conforme o backfill cresce. | médio | médio | baixo | `firestore-read.ts`, `analise/route.ts`, `receita/route.ts`, `folha/route.ts` |
| 7 | **Plugar fontes WF1 no pipeline pré-computado**: hoje `/contratos`, `/tce`, `/sancoes` coletam AO VIVO no GET. Estender `deteccao.ts` (`COLECOES_BRUTAS`) para ler `nexo_contratos_pncp`/`nexo_tce`/`nexo_sancoes` e cruzar com empenhos, gerando alertas unificados com `scorePrioridade`. | médio | alto | médio | `coleta-pncp.ts`, `coleta-tce.ts`, `coleta-sancoes.ts`, `deteccao.ts` |

Deploy de índices/functions é **separado** do App Hosting: `firebase deploy --only firestore:indexes` e `--only functions` (skill `firebase-deploy`).

---

## P3 — Novos Detectores (computáveis a partir das fontes já coletadas)

Priorizados por baixa taxa de falso positivo (exigem coincidência cross-source ou regra dura):

1. **Sancionado recebendo recurso** — fornecedor empenhado × CEIS/CNEP ativo (`sources/sancoes-federais.ts` já coleta). Alta confiabilidade, quase zero ruído.
2. **Empenho sem contrato PNCP correspondente** — empenho SMARAPD acima do teto de dispensa sem contrato no PNCP; ou contrato PNCP com valor/objeto divergente do empenho.
3. **Capital social incompatível** — já existe embrionário (FR-09, `analise/route.ts:316-338`); promover a detector formal e aplicar sobre a base líquida e dedup por raiz.
4. **Movimento líquido ≈ zero por empenha-anula-reemite** — padrão de empenho seguido de anulação e reemissão (sinaliza manobra de competência/fracionamento). Habilitado pelo `tipoEmpenho` do P0-5.
5. **Fornecedor exclusivo persistente** — único fornecedor de um objeto/CNAE por N exercícios sem competição (sinal de direcionamento), sobre a curva ABC por grupo (P1-5).

Registrar todos no `detectores/index.ts` e no catálogo, com `probabilidadeEnquadramento` preenchida (puxam o score triplo para frente).

---

## Sequenciamento recomendado

### Bloco A — ADITIVO seguro (fazer já, risco baixo, destrava o resto)
1. **`entidades.ts`** (P0-1, P1-1) — arquivo novo + guard de 1 linha por loop. Mata o bug "Fornecedora: Prefeitura" imediatamente. *Confirmar a denylist de CNPJs contra fonte oficial antes do merge.*
2. **3ª perna do score opcional + `prioridade.ts`** (P0-3a/b, P1-2/3) — campo opcional com default + função nova. Nada quebra; detectores existentes seguem válidos.
3. **`?ordem=` em `alertas/route.ts`** (P0-2) — adiciona ramos de sort sem remover o atual.
4. **`tipoEmpenho` no `EmpenhoNorm` + `ehMovimentoExpansivo`** (P0-5, parte 1) — só amplia o schema do norm e adiciona helper; ainda **sem** trocar a agregação.
5. **Índices Firestore de recência/score** (P2-2) — puramente aditivo; deploy `--only firestore:indexes`.

### Bloco B — MEXE-EM-CÓDIGO-QUE-FUNCIONA (precisa snapshot antes/depois)
6. **Trocar a chave de sort default** para `scorePrioridade` em `alertas/route.ts:195`, `analise/route.ts:340`, `index.ts:128` e `page.tsx:210-219` (P0-3c). Muda a ordem visível — é o pedido do dono, mas validar.
7. **Netting de anulação na agregação** do ranking/concentração (P0-5, parte 3). Snapshot obrigatório.
8. **Dedup/colapso por raiz** no `topFornecedores` e concentração (P0-4, P1-5). Muda granularidade — entregar atrás de `?agregar=grupo` primeiro se quiser reduzir risco.

### Bloco C — Infra & escala (depois que a qualidade estiver correta)
9. orderBy+limit server-side (P2-1) → materializar ranking no cron (P2-4) → sanitização na ingestão (P2-5) → paginação (P2-6).

### Bloco D — Expansão (sem risco de regressão sobre o que existe)
10. Novos detectores cross-source (P3) e fontes WF1 no pipeline (P2-7). São puramente aditivos (`riscoRegressao: nenhum`).

**Regra de ouro do sequenciamento:** Bloco A inteiro pode ir sem medo e já resolve visualmente os 3 reclamos do dono (Prefeitura some, ordena por recente/potencial). O Bloco B é onde mora o risco — cada item exige um teste de snapshot de alertas antes/depois (que hoje **não existe**; criar a suíte de regressão de `detectores/__tests__` é pré-requisito barato e de risco nulo, recomendado antes do Bloco B).

**Arquivos-chave (todos absolutos):**
- `C:\Users\Vereador\Documents\oficioexpress\src\lib\nexo\entidades.ts` (novo)
- `C:\Users\Vereador\Documents\oficioexpress\src\lib\nexo\prioridade.ts` (novo)
- `C:\Users\Vereador\Documents\oficioexpress\src\lib\nexo\detectores\tipos.ts` (linhas 36-39)
- `C:\Users\Vereador\Documents\oficioexpress\src\lib\nexo\detectores\concentracao.ts` (linhas 24-31)
- `C:\Users\Vereador\Documents\oficioexpress\src\lib\nexo\detectores\grupo-cnpj.ts` (linha 28)
- `C:\Users\Vereador\Documents\oficioexpress\src\lib\nexo\detectores\index.ts` (linha 128)
- `C:\Users\Vereador\Documents\oficioexpress\src\lib\nexo\normalizar.ts` (linhas 8-24, 71-89)
- `C:\Users\Vereador\Documents\oficioexpress\src\app\api\nexo\alertas\route.ts` (linhas 113-116, 195)
- `C:\Users\Vereador\Documents\oficioexpress\src\app\api\nexo\analise\route.ts` (linhas 248, 262-280, 340)
- `C:\Users\Vereador\Documents\oficioexpress\src\app\nexo\page.tsx` (linhas 210-219)
- `C:\Users\Vereador\Documents\oficioexpress\src\lib\nexo\firestore-read.ts` (sem orderBy/limit)
- `C:\Users\Vereador\Documents\oficioexpress\firestore.indexes.json` (linhas 84-100)
- `C:\Users\Vereador\Documents\oficioexpress\functions\src\nexo\deteccao.ts` e `coleta.ts`