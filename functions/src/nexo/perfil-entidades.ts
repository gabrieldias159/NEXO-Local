/**
 * RAIO-X DAS ENTIDADES do NEXO — `onNexoPerfilEntidades` (Fase 4/5 do
 * plano-mestre, tema-mãe "dado um nome de empresa, mostro TUDO dela na base da
 * prefeitura").
 *
 * Este cron NÃO coleta de fontes externas: ele LÊ as coleções `nexo_*` que os
 * coletores já populam e CONSTRÓI `nexo_entidades` — UM doc por entidade
 * (CNPJ-raiz / CPF / órgão), agregando TUDO o que está linkado àquela entidade:
 * empenhos, contratos, licitações, sanções e vínculos do grafo. É a base do
 * perfil consolidado: "quem é X na Prefeitura de Marília?".
 *
 * ── DOC DE SAÍDA (1 por entidade, em `nexo_entidades`) ────────────────────────
 *   {
 *     _id: idCanonico,                 // CNPJ-raiz (8) | CPF (11) | rótulo do nome
 *     tipo: 'empresa'|'pessoa'|'orgao',
 *     nome, doc(cnpj/cpf),             // melhor nome/doc observado
 *     totalEmpenhado, nEmpenhos,       // de nexo_empenhos
 *     nContratos, contratosAtivos,     // de nexo_contratos_municipais (vigentes)
 *     nLicitacoes,                     // de nexo_licitacoes (via CNPJ/links)
 *     sancionado(bool), nSancoes,      // de nexo_sancoes
 *     objetos:[strings],               // objetos de contrato/licitação
 *     secretarias:[UGs],               // unidades gestoras dos empenhos
 *     primeiroVisto, ultimoVisto,      // janela temporal (datas de empenho/contrato)
 *     flags:[ ... ],                   // 'sancionado', 'acima-limite', etc.
 *     _exercicios:[anos], _atualizadoEm
 *   }
 *
 * ── idCanonico (mesma regra de `src/lib/nexo/entidades.ts`) ───────────────────
 *   • CNPJ válido (Módulo 11) → CNPJ-RAIZ (8 díg): colapsa filiais do MESMO grupo.
 *   • CPF válido               → o CPF inteiro (11 díg): pessoa física isolada.
 *   • doc inválido/lixo do TCE → rótulo canônico do NOME (sem sufixo/acento/caixa).
 * Sem isso, "11.222.333/0001-81" e "11.222.333/0002-62" virariam DUAS entidades.
 *
 * ── ENTES PÚBLICOS NÃO SÃO 'empresa' ──────────────────────────────────────────
 * Problema de qualidade nº 1 do dono: a própria Prefeitura/Câmara/SAAE/IPREMM
 * apareciam como "fornecedor" (transferências intra-governamentais, repasse ao
 * RPPS, duodécimo, folha lançada como fornecedor). Re-implementamos aqui a
 * denylist mínima (CNPJ 44477909000100 da Prefeitura, 59989830000136 do IPREMM)
 * + a regex de nome inequívoco. Quem casar vira `tipo: 'orgao'`, NUNCA 'empresa'
 * — fica fora da lista de fornecedores/rankings, mas ainda perfilável.
 *
 * ── IDEMPOTÊNCIA ──────────────────────────────────────────────────────────────
 * O docId é o próprio `_id` canônico. O `set(..., { merge: true })` é um UPSERT:
 * reexecutar o cron NUNCA duplica. Como o perfil é RECONSTRUÍDO do zero a cada
 * ciclo (agregação completa por exercício), os campos agregados são gravados
 * inteiros (não incrementados) — não há drift por reexecução.
 *
 * Processa o exercício corrente e o anterior. Cron diário (07h45 BRT — DEPOIS do
 * linkage 07h15, para que `nexo_links` esteja fresco quando contarmos vínculos).
 *
 * Self-contained: o projeto `functions/` não importa de `src/`; só usa `db`/
 * `admin` de `../shared/admin` e `gravarSyncState`. A validação Módulo 11 é
 * re-implementada localmente (sem dependência de `cpf-cnpj-validator`).
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import {
  cnpjRaizDe,
  docValido,
  ehEntidadePublica,
  entidadeId as resolverEntidadeId,
  soDigitos,
  tipoEntidade as resolverTipoEntidade,
  type TipoEntidade,
} from "./entidade-resolver";

/** Coleção de destino — 1 doc por entidade (o RAIO-X). */
const COLECAO = "nexo_entidades";
/** Teto de docs lidos por coleção/exercício — proteção de memória/tempo. */
const MAX_DOCS_POR_COLECAO = 30_000;
/** Teto de strings de `objetos`/`secretarias` por entidade — evita doc gigante. */
const MAX_LISTA = 40;
/**
 * Limite (R$) acima do qual o total empenhado da entidade ganha a flag
 * `acima-limite`. Heurística grosseira de "fornecedor relevante" — NÃO é teto
 * legal de dispensa; só sinaliza volume para o painel priorizar.
 */
const LIMITE_VOLUME = 1_000_000;

// A denylist de entes públicos, a regex de nome, os normalizadores de nome/
// rótulo e a validação Módulo 11 agora vivem no resolver compartilhado
// (`./entidade-resolver`) — fonte única usada por TODO coletor. Importados acima.

// ── Normalizadores ───────────────────────────────────────────────────────────

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const s = v.includes(",") ? v.replace(/\./g, "").replace(",", ".") : v;
    const n = Number(s.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Primeiro valor não-vazio entre as chaves dadas (string trimada). */
function primeiro(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return "";
}

/**
 * Sanitiza o id canônico para um docId VÁLIDO do Firestore. O id de uma entidade
 * sem CNPJ/CPF válido é o rótulo do NOME (`rotuloCanonico`), que pode conter `/`
 * (ex.: "TRANSPORTES A / B") — e `/` é separador de path no Firestore, então
 * `.doc("A / B")` lança "documentPath must point to a valid document path" e
 * derruba TODO o batch (nenhuma entidade persistida → dossiê/score congelados).
 * Troca `/` por `-`, remove caracteres de controle, barra `.`/`..` isolados e
 * limita o tamanho. Ids de CNPJ-raiz/CPF (só dígitos) passam intactos.
 */
function idDocSeguro(id: string): string {
  const limpo = id.replace(/\//g, "-").trim();
  const base = limpo === "" || limpo === "." || limpo === ".." ? "(sem id)" : limpo;
  return base.slice(0, 256);
}

// `cnpjRaiz` (→ cnpjRaizDe), `docValido`, `ehEntidadePublica`, o tipo
// `TipoEntidade`, `tipoEntidade` (→ resolverTipoEntidade) e o `idCanonicoEntidade`
// (→ resolverEntidadeId) vêm do resolver compartilhado, importado no topo. Aliases
// locais preservam os call-sites originais sem reescrita.

/** Raiz do CNPJ (8 primeiros dígitos). CPF (11 dígitos) não tem raiz. */
const cnpjRaiz = cnpjRaizDe;

/** Chave canônica de agregação — delega ao resolver compartilhado. */
const idCanonicoEntidade = resolverEntidadeId;

/** Tipo da entidade — delega ao resolver compartilhado. */
const tipoEntidade = resolverTipoEntidade;

/** Normaliza uma data (`YYYY-MM-DD...`, `DD/MM/YYYY`) para `YYYY-MM-DD`, ou "". */
function toIsoDate(v: unknown): string {
  const s = str(v);
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return "";
}

// ── Acumulador por entidade ──────────────────────────────────────────────────

interface Perfil {
  id: string;
  tipo: TipoEntidade;
  /** Melhor nome observado (o mais longo costuma ser o mais completo). */
  nome: string;
  /** Melhor doc observado (CPF/CNPJ válido tem prioridade sobre lixo). */
  doc: string;
  docValido: boolean;
  totalEmpenhado: number;
  nEmpenhos: number;
  nContratos: number;
  contratosAtivos: number;
  nLicitacoes: number;
  nSancoes: number;
  sancionado: boolean;
  objetos: Set<string>;
  secretarias: Set<string>;
  exercicios: Set<number>;
  primeiroVisto: string;
  ultimoVisto: string;
  /** Vínculos do grafo (`nexo_links`) tocando docs desta entidade. */
  nVinculos: number;
}

function novoPerfil(id: string, tipo: TipoEntidade): Perfil {
  return {
    id,
    tipo,
    nome: "",
    doc: "",
    docValido: false,
    totalEmpenhado: 0,
    nEmpenhos: 0,
    nContratos: 0,
    contratosAtivos: 0,
    nLicitacoes: 0,
    nSancoes: 0,
    sancionado: false,
    objetos: new Set(),
    secretarias: new Set(),
    exercicios: new Set(),
    primeiroVisto: "",
    ultimoVisto: "",
    nVinculos: 0,
  };
}

/** Mapa idCanonico → perfil. Cria sob demanda, fixando o `tipo` na 1ª visão. */
type Perfis = Map<string, Perfil>;

function obter(
  perfis: Perfis,
  doc: unknown,
  nome: unknown,
): Perfil {
  const id = idCanonicoEntidade(doc, nome);
  let p = perfis.get(id);
  if (!p) {
    p = novoPerfil(id, tipoEntidade(doc, nome));
    perfis.set(id, p);
  }
  // Se uma visão posterior trouxer evidência de ente público (nome/doc), o tipo
  // é promovido a 'orgao' — nunca o contrário (uma vez órgão, sempre órgão).
  if (p.tipo !== "orgao" && ehEntidadePublica(doc, nome)) p.tipo = "orgao";
  return p;
}

/** Atualiza o melhor nome/doc: doc válido vence lixo; nome mais longo vence. */
function registrarIdentidade(p: Perfil, doc: unknown, nome: unknown): void {
  const d = soDigitos(doc);
  const valido = docValido(d);
  if (d && (valido && !p.docValido || (valido === p.docValido && !p.doc))) {
    p.doc = d;
    p.docValido = valido;
  }
  const n = str(nome);
  if (n && n.length > p.nome.length) p.nome = n;
}

/** Marca a janela temporal `primeiroVisto`/`ultimoVisto` com uma data ISO. */
function registrarData(p: Perfil, iso: string): void {
  if (!iso) return;
  if (!p.primeiroVisto || iso < p.primeiroVisto) p.primeiroVisto = iso;
  if (!p.ultimoVisto || iso > p.ultimoVisto) p.ultimoVisto = iso;
}

function addLista(set: Set<string>, valor: unknown): void {
  const s = str(valor);
  if (s && set.size < MAX_LISTA) set.add(s.slice(0, 200));
}

// ── Leitura das coleções de um exercício ─────────────────────────────────────

async function lerExercicio(
  colecao: string,
  exercicio: number,
): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const snap = await db
    .collection(colecao)
    .where("_exercicio", "==", exercicio)
    .limit(MAX_DOCS_POR_COLECAO)
    .get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

/**
 * Lê `nexo_sancoes` SEM filtro de exercício (a coleção é keyed por CNPJ e NÃO
 * carrega `_exercicio` — ver `coleta-sancoes.ts`). Devolve um mapa
 * CNPJ-raiz → { sancionado, nSancoes } para cruzar com os perfis. Como o
 * documento é por CNPJ de 14 díg, indexamos pela RAIZ (colapsa filiais).
 */
async function lerSancoes(): Promise<
  Map<string, { sancionado: boolean; nSancoes: number }>
> {
  const snap = await db
    .collection("nexo_sancoes")
    .limit(MAX_DOCS_POR_COLECAO)
    .get();
  const mapa = new Map<string, { sancionado: boolean; nSancoes: number }>();
  for (const d of snap.docs) {
    const data = d.data();
    const cnpj = soDigitos(primeiro(data, "cnpj", "_cnpj") || d.id);
    if (!cnpj) continue;
    const raiz = cnpjRaiz(cnpj);
    const sancionado = data.sancionado === true;
    const n = toNum(data.qtdSancoes);
    const prev = mapa.get(raiz);
    mapa.set(raiz, {
      sancionado: sancionado || (prev?.sancionado ?? false),
      nSancoes: (prev?.nSancoes ?? 0) + n,
    });
  }
  return mapa;
}

// ── Construção dos perfis de um exercício ────────────────────────────────────

/**
 * Agrega EMPENHOS na entidade: total empenhado, nº de empenhos, UG (secretaria),
 * janela temporal. A entidade é resolvida pelo (`_cnpj`/CNPJ) + nome do empenho.
 *
 * ── DEDUP DO FAN-OUT (`fornecedoranalitico`) ─────────────────────────────────
 * A fonte SMARAPD `fornecedoranalitico` devolve 1 empenho LÓGICO como N linhas
 * (1 por liquidação), e a coleta grava 1 doc por linha (docId embute hash do
 * conteúdo → cada linha vira doc). CADA linha REPETE o valor-cabecalho do
 * empenho em `_valor`/`ValorEmpenho` (o valor de linha fica em `ValorLiquidoPago`,
 * que NÃO usamos aqui). Somar `_valor` por doc inflava o total 100-250x — CPFL
 * (33.050.196/0001-88) somava R$2,67bi por doc vs ~R$33M reais (nEmpenhos 4360 vs
 * 323 empenhos distintos, prova por query em 2026-07-01). Agregamos por CHAVE
 * CANÔNICA do empenho — (perfil | UG | NroEmpenho) DENTRO do exercício corrente —
 * e somamos o valor-cabecalho UMA vez por chave; `nEmpenhos` passa a ser o nº de
 * chaves distintas. Como cada exercício é processado isolado e depois FUNDIDO
 * (`fundir`), a numeração de empenho que reinicia por ano não colide.
 * NÃO altera a coleção crua `nexo_empenhos` → os detectores de NÍVEL-DE-LINHA
 * (liquidação/restos/alteração em `alteracao.ts`/`deteccao.ts`) seguem intactos.
 */
function agregarEmpenhos(
  perfis: Perfis,
  empenhos: { id: string; data: Record<string, unknown> }[],
  exercicio: number,
): void {
  // Chave canônica do empenho → valor-cabecalho (1x). Identidade/datas/secretarias
  // continuam por doc (são idempotentes: Set + min/max de data, sem dupla contagem);
  // só total/contagem passam pela dedup.
  const empenhosCanonicos = new Map<string, { p: Perfil; valor: number }>();

  for (const e of empenhos) {
    const d = e.data;
    const doc = primeiro(d, "_cnpj", "CPFCNPJ", "CNPJ", "CpfCnpj");
    const nome = primeiro(d, "_fornecedor", "NomeFornecedor", "Fornecedor", "NomeBeneficiario");
    // Sem doc E sem nome não há entidade a perfilar — ignora.
    if (!soDigitos(doc) && !nome) continue;
    const p = obter(perfis, doc, nome);
    registrarIdentidade(p, doc, nome);
    p.exercicios.add(exercicio);

    addLista(p.secretarias, primeiro(d, "UG", "UnidadeGestora", "UnidadeOrcamentaria"));
    registrarData(
      p,
      toIsoDate(primeiro(d, "DataMovimentoEmpenho", "DataEmp", "DataMovEmp", "Data")),
    );

    const valor =
      typeof d._valor === "number"
        ? d._valor
        : toNum(d.ValorEmpenho ?? d.ValorEmpenhado ?? d.Valor ?? d._valor);

    // (perfil | UG | NroEmpenho): agrupa as N linhas de liquidação do MESMO
    // empenho. Sem NroEmpenho não há como agrupar → cai no docId (conta como 1
    // empenho isolado; comportamento antigo, sem perda). Toma o MAIOR valor por
    // chave — defensivo contra linha com valor 0/ausente; os valores-cabecalho
    // são idênticos por construção (prova: 0 chaves com valor inconsistente).
    const nro = primeiro(d, "NroEmpenho", "NumeroEmpenho", "NumEmpenho");
    const ug = primeiro(d, "UG", "UnidadeGestora");
    const chave = nro ? `${p.id}|${ug}|${nro}` : `doc:${e.id}`;
    const prev = empenhosCanonicos.get(chave);
    if (!prev) empenhosCanonicos.set(chave, { p, valor });
    else if (valor > prev.valor) prev.valor = valor;
  }

  // Soma o valor-cabecalho UMA vez por empenho canônico; nEmpenhos = nº de chaves.
  for (const { p, valor } of empenhosCanonicos.values()) {
    p.totalEmpenhado += valor;
    p.nEmpenhos++;
  }
}

/**
 * Agrega CONTRATOS municipais na entidade: nº de contratos, ativos (vigência em
 * aberto na data de hoje), objetos. Resolve pela contratada (CNPJ + nome).
 */
function agregarContratos(
  perfis: Perfis,
  contratos: { id: string; data: Record<string, unknown> }[],
  exercicio: number,
  hojeIso: string,
): void {
  for (const c of contratos) {
    const d = c.data;
    const doc = primeiro(d, "cnpjContratada", "_cnpj");
    const nome = primeiro(d, "nomeContratada", "_fornecedor");
    // Contrato sem contratada identificada (Dados Abertos vem com null) não tem
    // entidade — pula. O enriquecimento SMARAPD preencherá numa onda futura.
    if (!soDigitos(doc) && !nome) continue;
    const p = obter(perfis, doc, nome);
    registrarIdentidade(p, doc, nome);
    p.exercicios.add(exercicio);

    p.nContratos++;
    addLista(p.objetos, primeiro(d, "objeto"));
    const inicio = toIsoDate(primeiro(d, "vigenciaInicio"));
    const fim = toIsoDate(primeiro(d, "vigenciaFim"));
    registrarData(p, inicio);
    registrarData(p, fim);
    // Ativo: tem fim de vigência e ele é ≥ hoje (ou sem fim declarado mas com
    // início — vigência em aberto). Sem nenhuma data, não conta como ativo.
    const ativo = fim ? fim >= hojeIso : !!inicio;
    if (ativo) p.contratosAtivos++;
  }
}

/**
 * Agrega LICITAÇÕES na entidade. O Dados Abertos NÃO expõe a contratada da
 * licitação (só processo/objeto/modalidade), então a licitação SÓ é atribuída a
 * uma entidade quando o enriquecimento já preencheu `_cnpj`/`_fornecedor`.
 * Quando há, conta a licitação e cataloga o objeto; quando não, a licitação
 * permanece anônima (será associada via grafo `nexo_links`, não aqui).
 */
function agregarLicitacoes(
  perfis: Perfis,
  licitacoes: { id: string; data: Record<string, unknown> }[],
  exercicio: number,
): void {
  for (const l of licitacoes) {
    const d = l.data;
    const doc = primeiro(d, "_cnpj", "cnpjVencedor", "cnpjContratada");
    const nome = primeiro(d, "_fornecedor", "vencedor", "nomeVencedor");
    if (!soDigitos(doc) && !nome) continue; // licitação sem vencedor conhecido
    const p = obter(perfis, doc, nome);
    registrarIdentidade(p, doc, nome);
    p.exercicios.add(exercicio);
    p.nLicitacoes++;
    addLista(p.objetos, primeiro(d, "objeto"));
    registrarData(p, toIsoDate(primeiro(d, "dataAbertura")));
  }
}

/**
 * Conta os VÍNCULOS do grafo (`nexo_links`) por entidade. As arestas referenciam
 * docs por coleção/id, não por CNPJ — então montamos um índice docRef → idCanonico
 * a partir dos empenhos/contratos já agregados e contamos quantas arestas tocam
 * cada entidade. Best-effort: arestas a docs não-mapeados são ignoradas.
 */
async function agregarVinculos(
  perfis: Perfis,
  refDeEntidade: Map<string, string>,
  exercicio: number,
): Promise<void> {
  const snap = await db
    .collection("nexo_links")
    .where("_exercicio", "==", exercicio)
    .limit(MAX_DOCS_POR_COLECAO)
    .get();
  for (const d of snap.docs) {
    const data = d.data();
    const de = data._de as { colecao?: string; id?: string } | undefined;
    const para = data._para as { colecao?: string; id?: string } | undefined;
    const ids = new Set<string>();
    for (const ref of [de, para]) {
      if (!ref?.colecao || !ref?.id) continue;
      const idEnt = refDeEntidade.get(`${ref.colecao}|${ref.id}`);
      if (idEnt) ids.add(idEnt);
    }
    for (const idEnt of ids) {
      const p = perfis.get(idEnt);
      if (p) p.nVinculos++;
    }
  }
}

/**
 * Resolve o par (doc, nome) cru de UM doc-fonte para o seu `_entidadeId` canônico
 * usando os MESMOS aliases de campo que a respectiva função de agregação usa.
 * Centralizar aqui garante que o id do ÍNDICE de vínculos não divirja do id sob
 * o qual o doc foi agregado — divergência = vínculo perdido silenciosamente.
 */
const RESOLVERS_REF: Record<
  string,
  (d: Record<string, unknown>) => string
> = {
  // Empenho: MESMAS chaves de nome que `agregarEmpenhos` (incl. NomeBeneficiario).
  nexo_empenhos: (d) =>
    idCanonicoEntidade(
      primeiro(d, "_cnpj", "CPFCNPJ", "CNPJ", "CpfCnpj"),
      primeiro(d, "_fornecedor", "NomeFornecedor", "Fornecedor", "NomeBeneficiario"),
    ),
  // Contrato: MESMAS chaves que `agregarContratos`.
  nexo_contratos_municipais: (d) =>
    idCanonicoEntidade(
      primeiro(d, "cnpjContratada", "_cnpj"),
      primeiro(d, "nomeContratada", "_fornecedor"),
    ),
  // TCE despesa: o doc carrega `cnpj` + `nomeCredor` (ver coleta-tce-despesas.ts).
  // ANTES desta frente, arestas empenho↔tce_despesa (177.868 docs!) tocavam só o
  // lado-empenho do índice — o lado tce_despesa caía fora e o vínculo NÃO contava.
  nexo_tce_despesas: (d) =>
    idCanonicoEntidade(
      primeiro(d, "cnpj", "_cnpj"),
      primeiro(d, "nomeCredor", "_fornecedor"),
    ),
  // Licitação: MESMAS chaves que `agregarLicitacoes`.
  nexo_licitacoes: (d) =>
    idCanonicoEntidade(
      primeiro(d, "_cnpj", "cnpjVencedor", "cnpjContratada"),
      primeiro(d, "_fornecedor", "vencedor", "nomeVencedor"),
    ),
};

/**
 * Constrói todos os perfis de um exercício. Lê empenhos/contratos/licitações/
 * tce_despesas, agrega, cruza sanções e conta vínculos. Devolve o mapa
 * idCanonico → perfil.
 */
async function construirPerfis(
  exercicio: number,
  sancoesPorRaiz: Map<string, { sancionado: boolean; nSancoes: number }>,
): Promise<Perfis> {
  const [empenhos, contratos, licitacoes, tceDespesas] = await Promise.all([
    lerExercicio("nexo_empenhos", exercicio),
    lerExercicio("nexo_contratos_municipais", exercicio),
    lerExercicio("nexo_licitacoes", exercicio),
    // tce_despesas NÃO é agregado em coluna própria (já vem no empenho via TCE),
    // mas é ALVO de aresta no grafo — precisamos do seu id p/ mapear o vínculo.
    lerExercicio("nexo_tce_despesas", exercicio),
  ]);

  const perfis: Perfis = new Map();
  const hojeIso = new Date().toISOString().slice(0, 10);

  agregarEmpenhos(perfis, empenhos, exercicio);
  agregarContratos(perfis, contratos, exercicio, hojeIso);
  agregarLicitacoes(perfis, licitacoes, exercicio);

  // Índice docRef → idCanonico, p/ contar vínculos do grafo por entidade. Mapeia
  // TODAS as coleções que aparecem como lado de aresta em `nexo_links` e carregam
  // uma entidade (empenho, contrato, tce_despesa, licitação) — não só o lado-
  // empenho. `nexo_documentos`/`nexo_diario_dom` não têm fornecedor → não mapeadas
  // (uma aresta a elas conta pelo OUTRO lado, que é entidade).
  const refDeEntidade = new Map<string, string>();
  const indexarRefs = (
    colecao: string,
    docs: { id: string; data: Record<string, unknown> }[],
  ): void => {
    const resolver = RESOLVERS_REF[colecao];
    if (!resolver) return;
    for (const item of docs) {
      const idEnt = resolver(item.data);
      // Só mapeia se a entidade existe no perfil (o tce_despesa cujo credor não
      // gerou perfil — ex.: ente público filtrado — não cria vínculo fantasma).
      if (perfis.has(idEnt)) refDeEntidade.set(`${colecao}|${item.id}`, idEnt);
    }
  };
  indexarRefs("nexo_empenhos", empenhos);
  indexarRefs("nexo_contratos_municipais", contratos);
  indexarRefs("nexo_licitacoes", licitacoes);
  indexarRefs("nexo_tce_despesas", tceDespesas);

  try {
    await agregarVinculos(perfis, refDeEntidade, exercicio);
  } catch (err) {
    // Vínculos são um enriquecimento — se nexo_links falhar/não existir, o
    // perfil ainda vale. Loga e segue.
    logger.warn(`NEXO Perfil — vínculos do exercício ${exercicio} indisponíveis`, err);
  }

  // Cruza sanções (por raiz do CNPJ) com cada perfil de empresa.
  for (const p of perfis.values()) {
    if (!p.docValido || p.doc.length !== 14) continue;
    const s = sancoesPorRaiz.get(cnpjRaiz(p.doc));
    if (s) {
      p.sancionado = s.sancionado;
      p.nSancoes = s.nSancoes;
    }
  }

  return perfis;
}

// ── Flags derivadas ──────────────────────────────────────────────────────────

function derivarFlags(p: Perfil): string[] {
  const flags: string[] = [];
  if (p.sancionado) flags.push("sancionado");
  if (p.totalEmpenhado >= LIMITE_VOLUME) flags.push("acima-limite");
  if (p.contratosAtivos > 0) flags.push("contrato-ativo");
  if (p.tipo === "orgao") flags.push("ente-publico");
  if (!p.docValido) flags.push("doc-invalido");
  // Fornecedor com empenho mas SEM nenhum contrato/licitação registrado — pode
  // indicar compra fora de processo formal (sinal para o painel investigar).
  if (p.nEmpenhos > 0 && p.nContratos === 0 && p.nLicitacoes === 0) {
    flags.push("sem-processo");
  }
  return flags;
}

// ── Mescla de perfis entre exercícios (corrente + anterior) ──────────────────

/**
 * Funde o perfil de um exercício no acumulador GLOBAL (multi-exercício). O doc
 * final de `nexo_entidades` consolida todos os exercícios processados num único
 * RAIO-X por entidade — somando contagens/valores e unindo listas/janelas.
 */
function fundir(global: Perfis, parcial: Perfis): void {
  for (const [id, p] of parcial) {
    const g = global.get(id);
    if (!g) {
      global.set(id, p);
      continue;
    }
    // Tipo: 'orgao' é absorvente.
    if (p.tipo === "orgao") g.tipo = "orgao";
    if (p.nome.length > g.nome.length) g.nome = p.nome;
    if (p.docValido && !g.docValido) {
      g.doc = p.doc;
      g.docValido = true;
    } else if (!g.doc && p.doc) {
      g.doc = p.doc;
    }
    g.totalEmpenhado += p.totalEmpenhado;
    g.nEmpenhos += p.nEmpenhos;
    g.nContratos += p.nContratos;
    g.contratosAtivos += p.contratosAtivos;
    g.nLicitacoes += p.nLicitacoes;
    g.nVinculos += p.nVinculos;
    // Sanção é estado atual da entidade (não soma por exercício) — OR/MAX.
    g.sancionado = g.sancionado || p.sancionado;
    g.nSancoes = Math.max(g.nSancoes, p.nSancoes);
    for (const o of p.objetos) addLista(g.objetos, o);
    for (const s of p.secretarias) addLista(g.secretarias, s);
    for (const ex of p.exercicios) g.exercicios.add(ex);
    registrarData(g, p.primeiroVisto);
    registrarData(g, p.ultimoVisto);
  }
}

// ── 2ª passada: recupera CNPJ AUSENTE por nome exato (join INTERNO) ──────────

/** Normalização ESTRITA p/ casar nomes (NFD + maiúsculas + espaços), COM sufixo. */
function normNomeEstrito(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Funde cada entidade NAME-ONLY (empresa sem CNPJ válido — flag `doc-invalido`)
 * na sua GÊMEA que JÁ tem CNPJ, quando o nome normalizado bate EXATAMENTE e é
 * INEQUÍVOCO (um único CNPJ p/ aquele nome). A mesma empresa costuma aparecer
 * SEM doc nos empenhos e COM doc nos contratos/licitações → recupera o CNPJ
 * ausente e DEDUPLICA o ranking. Só JOIN INTERNO por nome exato (sem lookup
 * externo, sem fuzzy): num sistema de fiscalização, CNPJ errado seria grave.
 * Devolve os `id` (crus) das gêmeas fundidas — seus docs órfãos são removidos.
 */
function mesclarNomeOnly(global: Perfis): string[] {
  const porNome = new Map<string, Perfil>(); // nome → perfil COM CNPJ
  const ambiguo = new Set<string>(); // nome com >1 CNPJ distinto → NÃO funde
  for (const p of global.values()) {
    if (!p.docValido || p.doc.length !== 14 || p.tipo !== "empresa") continue;
    const k = normNomeEstrito(p.nome);
    if (k.length < 6) continue; // nome curto/genérico → risco de falso-match
    const ex = porNome.get(k);
    if (ex) {
      if (ex.doc !== p.doc) ambiguo.add(k);
    } else {
      porNome.set(k, p);
    }
  }
  const fundidas: string[] = [];
  for (const [id, p] of global) {
    if (p.docValido || p.tipo !== "empresa" || !p.nome) continue; // só name-only empresa
    const k = normNomeEstrito(p.nome);
    if (k.length < 6 || ambiguo.has(k)) continue;
    const alvo = porNome.get(k);
    if (!alvo || alvo.id === id) continue;
    // Funde agregados (registros distintos: empenho sem-doc vs contrato com-doc —
    // sem dupla contagem). Tudo é recomputado a cada run, então é idempotente.
    alvo.totalEmpenhado += p.totalEmpenhado;
    alvo.nEmpenhos += p.nEmpenhos;
    alvo.nContratos += p.nContratos;
    alvo.contratosAtivos += p.contratosAtivos;
    alvo.nLicitacoes += p.nLicitacoes;
    alvo.nVinculos += p.nVinculos;
    alvo.sancionado = alvo.sancionado || p.sancionado;
    alvo.nSancoes = Math.max(alvo.nSancoes, p.nSancoes);
    for (const o of p.objetos) addLista(alvo.objetos, o);
    for (const s of p.secretarias) addLista(alvo.secretarias, s);
    for (const ex of p.exercicios) alvo.exercicios.add(ex);
    registrarData(alvo, p.primeiroVisto);
    registrarData(alvo, p.ultimoVisto);
    if (p.nome.length > alvo.nome.length) alvo.nome = p.nome;
    global.delete(id);
    fundidas.push(p.id);
  }
  return fundidas;
}

/** Remove docs órfãos (gêmeas name-only fundidas) de `nexo_entidades`. */
async function removerEntidades(ids: string[]): Promise<void> {
  let batch = db.batch();
  let n = 0;
  for (const id of ids) {
    batch.delete(db.collection(COLECAO).doc(idDocSeguro(id)));
    if (++n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
}

// ── Persistência (upsert idempotente por _id, em lotes de 400) ───────────────

async function persistirPerfis(perfis: Perfis): Promise<number> {
  if (perfis.size === 0) return 0;
  const now = admin.firestore.FieldValue.serverTimestamp();
  let batch = db.batch();
  let n = 0;
  for (const p of perfis.values()) {
    const flags = derivarFlags(p);
    const docId = idDocSeguro(p.id);
    batch.set(
      db.collection(COLECAO).doc(docId),
      {
        _id: docId,
        tipo: p.tipo,
        nome: p.nome,
        doc: p.doc || null,
        docValido: p.docValido,
        // Conveniência p/ consulta: cnpj/cpf separados conforme o tamanho.
        cnpj: p.doc.length === 14 ? p.doc : null,
        cpf: p.doc.length === 11 ? p.doc : null,
        cnpjRaiz: p.doc.length === 14 ? cnpjRaiz(p.doc) : null,
        totalEmpenhado: Math.round(p.totalEmpenhado * 100) / 100,
        nEmpenhos: p.nEmpenhos,
        nContratos: p.nContratos,
        contratosAtivos: p.contratosAtivos,
        nLicitacoes: p.nLicitacoes,
        nVinculos: p.nVinculos,
        sancionado: p.sancionado,
        nSancoes: p.nSancoes,
        objetos: [...p.objetos],
        secretarias: [...p.secretarias],
        primeiroVisto: p.primeiroVisto || null,
        ultimoVisto: p.ultimoVisto || null,
        flags,
        // Campos de sistema canônicos (seção 2.1): chaves de igualdade que os
        // índices por-entidade e os demais coletores usam para JOIN sem varrer a
        // coleção. `_entidadeId` é o id canônico CRU (= `p.id`, pode conter `/`,
        // NÃO o docId saneado) — quem consulta por `where('_entidadeId','==',id)`
        // usa o mesmo id que o resolver produz. `_cnpjRaiz` colapsa filiais.
        _entidadeId: p.id,
        _cnpjRaiz: p.doc.length === 14 ? cnpjRaiz(p.doc) : null,
        _exercicios: [...p.exercicios].sort((a, b) => b - a),
        _fonte: "perfil-entidades",
        _atualizadoEm: now,
      },
      { merge: true },
    );
    n++;
    if (n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
  return n;
}

/** Exercícios cobertos: o corrente e o anterior. */
function exerciciosAlvo(): number[] {
  const atual = new Date().getFullYear();
  return [atual, atual - 1];
}

// ── Cron diário ──────────────────────────────────────────────────────────────

export const onNexoPerfilEntidades = onSchedule(
  {
    // 07h45 BRT — DEPOIS do linkage (07h15), para contar vínculos sobre o grafo
    // já reconstruído do dia, e depois dos coletores da madrugada/manhã.
    schedule: "45 7 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
    // Hardening (#13): no máximo UMA execução simultânea — evita que um disparo
    // atrasado/retry concorra com a execução em andamento e reescreva os perfis
    // duas vezes ao mesmo tempo.
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: cada perfil tem docId determinístico
    // (o `_id` canônico) gravado com `merge`, e os agregados são RECONSTRUÍDOS
    // do zero por ciclo — reexecutar após falha SOBRESCREVE, nunca duplica.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    await rodarPerfilEntidades();
  },
);

/**
 * Núcleo reutilizável do cron de perfil de entidades — extraído do handler para
 * poder rodar FORA do Cloud Scheduler (ex.: pipeline de inteligência local no
 * emulador). Comportamento idêntico ao do cron.
 */
export async function rodarPerfilEntidades(): Promise<void> {
    const inicio = Date.now();
    const anos = exerciciosAlvo();
    const global: Perfis = new Map();
    let falhas = 0;
    let ultimoErro: string | null = null;
    const porExercicio: Record<string, number> = {};

    // Sanções são lidas UMA vez (coleção pequena, sem `_exercicio`).
    let sancoesPorRaiz = new Map<
      string,
      { sancionado: boolean; nSancoes: number }
    >();
    try {
      sancoesPorRaiz = await lerSancoes();
    } catch (err) {
      // Sanções são enriquecimento — segue sem elas se a leitura falhar.
      logger.warn("NEXO Perfil — sanções indisponíveis; seguindo sem elas", err);
    }

    for (const ano of anos) {
      try {
        const parcial = await construirPerfis(ano, sancoesPorRaiz);
        porExercicio[String(ano)] = parcial.size;
        fundir(global, parcial);
        logger.info(
          `NEXO Perfil — ${ano}: ${parcial.size} entidades agregadas`,
        );
      } catch (err) {
        falhas++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.error(`NEXO Perfil — falha no exercício ${ano}`, err);
      }
    }

    // 2ª passada: recupera CNPJ ausente fundindo gêmeas name-only por nome exato
    // (também deduplica o ranking). Os docs órfãos das fundidas são removidos.
    let mescladosIds: string[] = [];
    try {
      mescladosIds = mesclarNomeOnly(global);
      if (mescladosIds.length) {
        logger.info(
          `NEXO Perfil — ${mescladosIds.length} entidades name-only fundidas na gêmea com CNPJ (recupera CNPJ ausente + dedup).`,
        );
      }
    } catch (err) {
      logger.warn("NEXO Perfil — mescla por nome falhou; seguindo sem ela", err);
    }

    let gravados = 0;
    try {
      gravados = await persistirPerfis(global);
      if (mescladosIds.length) await removerEntidades(mescladosIds);
    } catch (err) {
      falhas++;
      ultimoErro = err instanceof Error ? err.message : String(err);
      logger.error("NEXO Perfil — falha ao persistir nexo_entidades", err);
    }

    // Estatística informativa: quantas entidades por tipo.
    let empresas = 0;
    let pessoas = 0;
    let orgaos = 0;
    let sancionadas = 0;
    for (const p of global.values()) {
      if (p.tipo === "empresa") empresas++;
      else if (p.tipo === "pessoa") pessoas++;
      else orgaos++;
      if (p.sancionado) sancionadas++;
    }

    const sucesso = falhas < anos.length + 1 && gravados > 0;
    await gravarSyncState({
      syncId: "perfil_entidades",
      fonte: "perfil-entidades",
      colecao: COLECAO,
      cadencia: "diario",
      sucesso,
      degradado: falhas > 0,
      erro: falhas > 0 ? ultimoErro : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        exerciciosTentados: anos.length,
        exerciciosComFalha: falhas,
        entidades: gravados,
        empresas,
        pessoas,
        orgaos,
        sancionadas,
        porExercicio,
      },
    });
    logger.info(
      `NEXO Perfil — concluído: ${gravados} entidades ` +
        `(${empresas} empresas, ${pessoas} pessoas, ${orgaos} órgãos, ` +
        `${sancionadas} sancionadas), ${falhas} falhas`,
    );
}
