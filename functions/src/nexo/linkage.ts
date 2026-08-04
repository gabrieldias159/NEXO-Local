/**
 * MOTOR DE LINKAGE do NEXO — `onNexoLinkage` (Fase 3/4 do plano-mestre, tema-mãe
 * "TUDO LINKADO").
 *
 * Este cron NÃO coleta de fontes externas: ele LÊ as coleções `nexo_*` que os
 * coletores já populam e CONSTRÓI o grafo de vínculos em `nexo_links` — um doc
 * por aresta. É a peça que costura empenho ↔ contrato ↔ licitação ↔ despesa
 * declarada ao TCE ↔ edição do DOM ↔ documento-fonte do catálogo, de modo que
 * cada achado/alerta possa apontar para o papel que o prova.
 *
 * ── ARESTAS PERSISTIDAS (cada match vira um doc em `nexo_links`) ──────────────
 *   • empenho.ProcessoLicitatorio  ↔ contrato.numeroProcesso (+ano=_exercicio)
 *        → tipo 'empenho-contrato',  confiança forte/media (chaveTipo 'processo')
 *   • empenho.ProcessoLicitatorio  ↔ licitacao.numeroProcesso/numeroEdital
 *        → tipo 'empenho-licitacao', confiança forte/media (chaveTipo 'processo')
 *   • empenho(nrEmpenho norm + cnpj) ↔ tce_despesa(nrEmpenho + cnpj)
 *        → tipo 'empenho-tce',       confiança 'forte'   (chaveTipo 'empenho')
 *   • processo (de empenho/contrato/licitacao) ↔ dom.chavesProcesso
 *        → tipo 'processo-dom',      confiança 'media'   (chaveTipo 'processo')
 *   • qualquer chave ↔ nexo_documentos.chavesIndex
 *        → tipo 'doc',               confiança conforme a chave
 *
 * ── CASAMENTO ESTÁVEL (a regra de ouro) ──────────────────────────────────────
 * O número de empenho e o de processo são NORMALIZADOS exatamente do MESMO jeito
 * nos dois lados antes de indexar: tira pontos de milhar, zero-pad consistente
 * (empenho) e barra preservada (processo). Se as duas pontas não passarem pela
 * mesma função, a chave não casa — por isso `chaveEmpenho()` reproduz o formato
 * `EMP-{seq pad10}-{ano}` de `coleta-tce-despesas.ts`, e `chaveProcesso()`
 * reproduz o `normProcesso()` de `coleta-dom.ts` (strip de espaços e pontos).
 *
 * ── IDEMPOTÊNCIA ─────────────────────────────────────────────────────────────
 * O `docId` é determinístico — sha1(de.colecao|de.id|para.colecao|para.id|tipo).
 * O `set(..., { merge: true })` é um UPSERT: reexecutar o cron NUNCA duplica
 * arestas. (A direção é canonicalizada por par de coleções para que A→B e B→A
 * produzam a MESMA aresta — ver `montarAresta`.)
 *
 * Processa o exercício corrente e o anterior. Cron diário (07h15 BRT — após os
 * coletores diários de contratos/licitações/DOM e as ingestões da madrugada).
 *
 * Self-contained: o projeto `functions/` não importa de `src/`; só usa `db`/
 * `admin` de `../shared/admin`, `gravarSyncState` e `createHash` de `node:crypto`.
 */
import { createHash } from "node:crypto";

import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
// Chave de processo CANÔNICA (espelho verbatim de `src/lib/nexo/chaves.ts`):
// `{num}/{ano}` com `num` sem zeros à esquerda e `ano` de 4 dígitos. É o que
// faz o contrato `"47"` (+ `_exercicio` 2025) casar com o empenho
// `"21 / 2022"` — coisa que a comparação de string crua NUNCA fazia.
import { chaveProcesso } from "./chaves";

/** Coleção-grafo: 1 doc por aresta de vínculo. */
const COLECAO = "nexo_links";
/** Largura do zero-pad da sequência do empenho — DEVE casar com coleta-tce-despesas.ts. */
const EMPENHO_PAD = 10;
/** Teto de docs lidos por coleção/exercício — proteção de memória/tempo. */
const MAX_DOCS_POR_COLECAO = 20_000;

/**
 * Mínimo de dígitos do NÚMERO do processo para casar SEM checagem de
 * cardinalidade. Número curto (`"2"`, `"47"`) reinicia por ano/categoria e
 * colide em massa — no diagnóstico, `"002"` batia 318 empenhos. Abaixo deste
 * piso só casamos se a cardinalidade do bucket for baixa (ver `LIMIAR_*`).
 */
const MIN_DIGITOS_PROC = 3;
/**
 * Cardinalidade máxima TOLERADA num casamento por número curto (< MIN_DIGITOS).
 * Se QUALQUER lado tem mais alvos que isto, o número é ambíguo demais — não
 * gera aresta (seria ruído, não vínculo). 1×1 / 1×2 ainda é defensável.
 */
const LIMIAR_CARDINALIDADE_CURTA = 2;

/** Tipo de aresta entre dois documentos do grafo. */
type TipoLink =
  | "empenho-contrato"
  | "empenho-licitacao"
  | "empenho-tce"
  | "processo-dom"
  | "doc";

/** Dimensão da chave que produziu o vínculo. */
type ChaveTipo = "processo" | "empenho" | "contrato" | "cnpj";

/** Força do vínculo. */
type Confianca = "forte" | "media" | "fraca";

/** Referência a um documento numa coleção `nexo_*`. */
interface Ref {
  colecao: string;
  id: string;
}

// ── Normalizadores (campos crus → tipos limpos) ──────────────────────────────

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

function primeiro(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return "";
}

/**
 * Extrai os 4 dígitos de ANO embutidos num nº de processo cru, se houver
 * (`"21 / 2022"` → `"2022"`). Retorna "" quando o bruto não traz ano — aí o
 * chamador cai no `_exercicio` do documento como fonte do ano.
 */
function anoEmbutido(raw: unknown): string {
  return str(raw).match(/\b(19|20)\d{2}\b/)?.[0] ?? "";
}

/**
 * Constrói a chave de processo CANÔNICA `{num}/{ano}` a partir de um número de
 * processo cru e do exercício do documento como fonte-padrão do ano.
 *
 * Por que num+ano e não a string crua (o bug que zerava as arestas): o contrato
 * grava `numeroProcesso="47"` SEM ano (o ano é o `_exercicio` do doc) e o
 * empenho grava `ProcessoLicitatorio="21 / 2022"` COM ano embutido. A chave
 * antiga comparava `"47"` ≠ `"21/2022"` literalmente → zero match. Aqui:
 *   • `num`  = 1º grupo de dígitos sem zeros à esquerda (via `chaveProcesso`);
 *   • `ano`  = ano embutido no bruto (se houver) OU o `_exercicio` do doc.
 * Assim os dois lados convergem para `{num}/{ano}` e casam.
 *
 * Retorna "" para entradas sem dígito — chave vazia NÃO entra no índice.
 */
function chaveProc(raw: unknown, exercicio: number): string {
  return chaveProcesso({ num: raw, ano: anoEmbutido(raw) || exercicio });
}

/**
 * Conta os dígitos do NÚMERO (parte antes da barra) de uma chave `{num}/{ano}`.
 * Usado pelo guarda de cardinalidade: número < `MIN_DIGITOS_PROC` é curto e
 * colide fácil.
 */
function digitosNum(chave: string): number {
  const num = chave.split("/")[0] ?? "";
  return num.replace(/\D/g, "").length;
}

/**
 * Decide se uma chave de processo PODE virar aresta dadas as cardinalidades dos
 * dois lados (quantos refs casam essa chave em cada índice). Regra do plano:
 * número com ≥ `MIN_DIGITOS_PROC` dígitos casa sempre; número curto só casa se
 * ambos os lados forem rasos (≤ `LIMIAR_CARDINALIDADE_CURTA`), evitando que um
 * `"2"`/`"47"` que reinicia por ano cruze dezenas de docs de anos/categorias
 * distintos. Retorna a confiança explicável da aresta resultante, ou null se o
 * casamento deve ser DESCARTADO.
 */
function avaliarProc(
  chave: string,
  cardA: number,
  cardB: number,
): { confianca: Confianca; motivo: string } | null {
  const nd = digitosNum(chave);
  if (nd >= MIN_DIGITOS_PROC) {
    // Número longo: casamento estável. Cardinalidade alta só rebaixa confiança.
    const amplo = cardA > 4 || cardB > 4;
    return {
      confianca: amplo ? "media" : "forte",
      motivo: amplo
        ? `processo ${chave} (${nd} dig) com ${cardA}x${cardB} alvos — possivel reuso de numero`
        : `processo ${chave} (${nd} dig), ${cardA}x${cardB} alvos`,
    };
  }
  // Número curto: só passa se ambos os lados forem rasos.
  if (cardA <= LIMIAR_CARDINALIDADE_CURTA && cardB <= LIMIAR_CARDINALIDADE_CURTA) {
    return {
      confianca: "media",
      motivo: `processo curto ${chave} (${nd} dig) admitido por baixa cardinalidade ${cardA}x${cardB}`,
    };
  }
  return null; // número curto + cardinalidade alta = colisão provável, descarta.
}

/** Raiz do CNPJ (8 primeiros dígitos) — colapsa filiais no mesmo grupo. */
function cnpjRaiz(doc: unknown): string {
  const d = soDigitos(doc);
  return d.length >= 8 ? d.slice(0, 8) : "";
}

/**
 * Normaliza um nº de EMPENHO para a chave de linkage SMARAPD×TCE. Reproduz
 * `normalizarNrEmpenho()` de `coleta-tce-despesas.ts`: casa a sequência (1º
 * grupo de dígitos) e, se houver, o ano (4 dígitos), zera-padda a sequência e
 * compõe `EMP-{seq pad10}-{ano}`. Tira pontos de milhar implicitamente (só
 * dígitos contam). Se o bruto não traz ano, usa o exercício do documento — por
 * isso o SMARAPD (que tem `_exercicio`) casa com o TCE (que embute `-2025`).
 *
 * Retorna "" quando não há sequência de dígitos.
 */
function chaveEmpenho(bruto: unknown, exercicio: number): string {
  const limpo = str(bruto);
  const m = limpo.match(/(\d+)(?:\D+(\d{4}))?/);
  const seq = m?.[1] ?? "";
  if (!seq) return "";
  const ano = m?.[2] ?? String(exercicio);
  const seqPad = seq.padStart(EMPENHO_PAD, "0");
  return `EMP-${seqPad}-${ano}`;
}

// ── docId determinístico + montagem da aresta ────────────────────────────────

/**
 * Ordena o par de refs canonicamente (por `colecao|id`) para que a MESMA aresta
 * lógica entre dois docs sempre gere o mesmo `docId`, independentemente de qual
 * lado foi descoberto primeiro — evita gravar A→B e B→A como dois docs.
 */
function ordenarPar(a: Ref, b: Ref): [Ref, Ref] {
  const ka = `${a.colecao}|${a.id}`;
  const kb = `${b.colecao}|${b.id}`;
  return ka <= kb ? [a, b] : [b, a];
}

/** sha1(de.colecao|de.id|para.colecao|para.id|tipo) — chave do upsert idempotente. */
function docIdAresta(de: Ref, para: Ref, tipo: TipoLink): string {
  const identidade = [de.colecao, de.id, para.colecao, para.id, tipo].join("|");
  return createHash("sha1").update(identidade).digest("hex");
}

/** Uma aresta pronta para gravar (já com docId e payload). */
interface Aresta {
  id: string;
  doc: Record<string, unknown>;
}

/**
 * Monta a aresta (doc de `nexo_links`) entre dois refs. Canonicaliza a direção
 * pelo par ordenado, de modo que `_de`/`_para` sejam estáveis para o mesmo
 * vínculo. Carimba `_geradoEm: serverTimestamp`.
 */
function montarAresta(
  a: Ref,
  b: Ref,
  tipo: TipoLink,
  chave: string,
  chaveTipo: ChaveTipo,
  confianca: Confianca,
  exercicio: number,
  extra?: { cnpjRaiz?: string; motivo?: string },
): Aresta {
  const [de, para] = ordenarPar(a, b);
  const doc: Record<string, unknown> = {
    _de: { colecao: de.colecao, id: de.id },
    _para: { colecao: para.colecao, id: para.id },
    tipo,
    chave,
    chaveTipo,
    confianca,
    _exercicio: exercicio,
    _geradoEm: admin.firestore.FieldValue.serverTimestamp(),
  };
  // `_cnpjRaiz` na aresta = chave de entity-resolution (filial→grupo): permite
  // ao dossiê/grafo agregar todas as arestas de um fornecedor por raiz sem
  // reabrir os docs das pontas. Só carimba quando há CNPJ (8+ dig).
  if (extra?.cnpjRaiz) doc._cnpjRaiz = extra.cnpjRaiz;
  // `_motivo` = confiança EXPLICÁVEL (por que casou e com que cardinalidade) —
  // honestidade radical: a aresta carrega a justificativa, não só o rótulo.
  if (extra?.motivo) doc._motivo = extra.motivo;
  return { id: docIdAresta(de, para, tipo), doc };
}

// ── Leitura das coleções de um exercício ─────────────────────────────────────

/** Lê os docs de uma coleção `nexo_*` filtrados por `_exercicio`. */
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
 * Lê o catálogo `nexo_documentos` SEM filtro de exercício. O catálogo é keyed
 * pela IDENTIDADE do documento (sha1 das chaves), NÃO carrega `_exercicio` (ver
 * `documentos.ts` → `montarPayload`), então filtrar por exercício devolveria
 * ZERO docs e mataria todo o braço de vínculo `'doc'`. O casamento por
 * `chavesIndex` é exercício-agnóstico: um nº de processo bate seja qual for o
 * ano do papel. A consulta é capada por `MAX_DOCS_POR_COLECAO`.
 */
async function lerCatalogo(): Promise<
  { id: string; data: Record<string, unknown> }[]
> {
  const snap = await db
    .collection("nexo_documentos")
    .limit(MAX_DOCS_POR_COLECAO)
    .get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

/**
 * Lê uma coleção SEM filtro de exercício. Para contratos/licitações: são
 * pequenas (<2,7k docs) e seu processo é referenciado por empenhos de QUALQUER
 * ano (restos/arrasto). A chave canônica `{num}/{ano}` carrega o ano do próprio
 * doc, então o casamento cross-ano fica correto. Capado por MAX_DOCS_POR_COLECAO.
 */
async function lerTodos(
  colecao: string,
): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const snap = await db.collection(colecao).limit(MAX_DOCS_POR_COLECAO).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

/**
 * Índice multivalor: chave normalizada → lista de refs que a possuem. Vários
 * empenhos podem compartilhar o mesmo processo; vários docs do catálogo a mesma
 * chave. O índice é a base do join "todos × todos" por chave coincidente.
 */
type Indice = Map<string, Ref[]>;

function addIndice(idx: Indice, chave: string, ref: Ref): void {
  if (!chave) return;
  const lista = idx.get(chave);
  if (lista) lista.push(ref);
  else idx.set(chave, [ref]);
}

// ── Construção das arestas de um exercício ───────────────────────────────────

/**
 * Constrói TODAS as arestas de um exercício. Lê as 5 coleções, monta os índices
 * por chave normalizada e faz os joins. Retorna a lista de arestas (deduplicada
 * por docId dentro do próprio exercício).
 */
async function construirArestas(exercicio: number): Promise<Aresta[]> {
  const [empenhos, contratos, licitacoes, tceDespesas, documentos] =
    await Promise.all([
      lerExercicio("nexo_empenhos", exercicio),
      // Contratos/licitações: TODOS os anos (cross-year). 87% dos empenhos citam
      // processos de anos ANTERIORES (restos/arrasto); a chave `{num}/{ano}` já
      // carrega o ano embutido, então o casamento cross-ano é correto e os guards
      // (MIN_DIGITOS/cardinalidade) seguem protegendo. Coleções pequenas (~2,6k).
      lerTodos("nexo_contratos_municipais"),
      lerTodos("nexo_licitacoes"),
      lerExercicio("nexo_tce_despesas", exercicio),
      // Catálogo SEM filtro de exercício (não carrega `_exercicio`) — ver `lerCatalogo`.
      lerCatalogo(),
    ]);

  // DOM não tem `_exercicio` confiável por janela incremental, mas os coletores
  // gravam `_exercicio` derivado da data da edição — leio por ele também.
  const dom = await lerExercicio("nexo_diario_dom", exercicio);

  // ── Índices por chave normalizada ──────────────────────────────────────────
  // Processo: o eixo central. Empenho indexa o processo ADMINISTRATIVO (admin),
  // contrato/licitação o seu numeroProcesso.
  const idxProcContrato: Indice = new Map();
  const idxProcLicitacao: Indice = new Map();
  // Processo licitatório do empenho (campo distinto do admin) → licitação.
  const idxProcLicitacaoNum: Indice = new Map(); // licitacao por numeroProcesso E numeroEdital
  // Empenho normalizado + cnpj → empenho (lado SMARAPD do par com o TCE).
  const idxEmpenhoTce: Indice = new Map();
  // Qualquer chave (tipo:valor) do catálogo de documentos.
  const idxDocCatalogo: Indice = new Map();
  // Processo presente no DOM (chavesProcesso = ["tipo:valor", ...]).
  const idxProcDom: Indice = new Map();

  // Contratos: indexa numeroProcesso como chave CANÔNICA `{num}/{ano}`. O ano
  // é o `_exercicio` do contrato (o `numeroProcesso` vem SEM ano da fonte) —
  // só assim o `"47"` do contrato 2025 vira `47/2025` e casa com o empenho.
  for (const c of contratos) {
    const ref: Ref = { colecao: "nexo_contratos_municipais", id: c.id };
    const anoDoc = Number(c.data._exercicio) || exercicio;
    const proc = chaveProc(
      primeiro(c.data, "numeroProcesso", "_numeroProcesso"),
      anoDoc,
    );
    addIndice(idxProcContrato, proc, ref);
  }

  // Licitações: indexa numeroProcesso E numeroEdital como `{num}/{ano}` (ambos
  // podem ser o "processo" que o empenho referencia como licitatório). Ano = o
  // `_exercicio` da licitação.
  for (const l of licitacoes) {
    const ref: Ref = { colecao: "nexo_licitacoes", id: l.id };
    const anoDoc = Number(l.data._exercicio) || exercicio;
    const proc = chaveProc(
      primeiro(l.data, "numeroProcesso", "_numeroProcesso"),
      anoDoc,
    );
    const edital = chaveProc(primeiro(l.data, "numeroEdital"), anoDoc);
    addIndice(idxProcLicitacaoNum, proc, ref);
    if (edital && edital !== proc) addIndice(idxProcLicitacaoNum, edital, ref);
    // Espelho separado por processo p/ a aresta processo-dom (todas as fontes
    // de processo entram nesse índice mais abaixo).
    addIndice(idxProcLicitacao, proc, ref);
  }

  // TCE despesas: indexa a chave `nrEmpenho__cnpj` (o doc já a tem como
  // `_chaveLinkage`, mas recomponho para garantir o MESMO formato dos dois lados).
  for (const t of tceDespesas) {
    const ref: Ref = { colecao: "nexo_tce_despesas", id: t.id };
    const nrEmp = chaveEmpenho(
      primeiro(t.data, "nrEmpenho", "nrEmpenhoBruto"),
      exercicio,
    );
    const cnpj = soDigitos(primeiro(t.data, "cnpj", "_cnpj"));
    if (nrEmp) addIndice(idxEmpenhoTce, `${nrEmp}__${cnpj || "sem-doc"}`, ref);
  }

  // Catálogo de documentos: indexa cada chave de `chavesIndex` (já "tipo:valor"
  // canônico). Normalizo o VALOR conforme o tipo para casar com o lado-empenho.
  for (const d of documentos) {
    const ref: Ref = { colecao: "nexo_documentos", id: d.id };
    const chavesIndex = Array.isArray(d.data.chavesIndex)
      ? (d.data.chavesIndex as unknown[])
      : [];
    for (const raw of chavesIndex) {
      const canon = str(raw).toLowerCase();
      const sep = canon.indexOf(":");
      if (sep <= 0) continue;
      const tipo = canon.slice(0, sep);
      const valor = canon.slice(sep + 1);
      if (!valor) continue;
      // Renormaliza o valor para o MESMO formato do lado-empenho/processo.
      let chaveNorm = "";
      let chaveTipo: ChaveTipo = "processo";
      if (tipo === "cnpj") {
        chaveNorm = soDigitos(valor);
        chaveTipo = "cnpj";
      } else if (tipo === "contrato") {
        chaveNorm = chaveProc(valor, exercicio);
        chaveTipo = "contrato";
      } else {
        // processo | licitacao | dispensa | inexigibilidade | dom … → processo.
        chaveNorm = chaveProc(valor, exercicio);
        chaveTipo = "processo";
      }
      if (!chaveNorm) continue;
      // A chave do índice embute o chaveTipo p/ não cruzar cnpj com processo.
      addIndice(idxDocCatalogo, `${chaveTipo}:${chaveNorm}`, ref);
    }
  }

  // DOM: indexa cada nº de processo de `chavesProcesso` (["tipo:valor", ...]).
  for (const g of dom) {
    const ref: Ref = { colecao: "nexo_diario_dom", id: g.id };
    const chaves = Array.isArray(g.data.chavesProcesso)
      ? (g.data.chavesProcesso as unknown[])
      : [];
    for (const raw of chaves) {
      const canon = str(raw);
      const sep = canon.indexOf(":");
      const valor = sep >= 0 ? canon.slice(sep + 1) : canon;
      const proc = chaveProc(valor, exercicio);
      addIndice(idxProcDom, proc, ref);
    }
  }

  // ── Joins (empenho é o lado iterado) ────────────────────────────────────────
  const vistos = new Set<string>();
  const arestas: Aresta[] = [];
  const empurrar = (a: Aresta) => {
    if (vistos.has(a.id)) return;
    vistos.add(a.id);
    arestas.push(a);
  };

  for (const e of empenhos) {
    const refEmp: Ref = { colecao: "nexo_empenhos", id: e.id };

    // Processo LICITATÓRIO do empenho — a chave PRIMÁRIA do linkage. É o campo
    // que o SMARAPD de fato preenche; o `NroProcessoAdminEmpenho` vinha vazio
    // (`" / 2026"`) em 100% da amostra e por isso zerava as arestas. Ano =
    // embutido no bruto (`"21 / 2022"`) ou o `_exercicio` do empenho.
    const procLicit = chaveProc(
      primeiro(e.data, "ProcessoLicitatorio", "NroLicitacao"),
      exercicio,
    );
    // Processo administrativo (secundário/fallback) — raramente preenchido.
    const procAdmin = chaveProc(
      primeiro(
        e.data,
        "NroProcessoAdminEmpenho",
        "NroProcessoAdmin",
        "ProcessoAdministrativo",
      ),
      exercicio,
    );
    // Número de empenho normalizado (mesmo formato do TCE) + cnpj.
    const nrEmp = chaveEmpenho(
      primeiro(e.data, "NroEmpenho", "NumeroEmpenho", "NumEmpenho"),
      exercicio,
    );
    const cnpjEmp = soDigitos(
      primeiro(e.data, "_cnpj", "CPFCNPJ", "CNPJ", "CpfCnpj"),
    );
    const raizEmp = cnpjRaiz(cnpjEmp);

    // 1) empenho ↔ contrato por processo (licitatório primário, admin fallback).
    //    Cardinalidade GUARDADA: número curto só casa em bucket raso; número
    //    longo casa sempre, mas rebaixa p/ media se o número for muito reusado.
    for (const proc of procAdmin && procAdmin !== procLicit
      ? [procLicit, procAdmin]
      : [procLicit]) {
      if (!proc) continue;
      const alvos = idxProcContrato.get(proc) ?? [];
      if (alvos.length === 0) continue;
      const v = avaliarProc(proc, 1, alvos.length);
      if (!v) continue;
      for (const refC of alvos) {
        empurrar(
          montarAresta(
            refEmp, refC, "empenho-contrato",
            proc, "processo", v.confianca, exercicio,
            { cnpjRaiz: raizEmp, motivo: v.motivo },
          ),
        );
      }
    }

    // 2) empenho ↔ licitação por processo (licitatório primário, admin fallback).
    //    Mesmo guarda de cardinalidade. Casa contra numeroProcesso/numeroEdital.
    for (const proc of procAdmin && procAdmin !== procLicit
      ? [procLicit, procAdmin]
      : [procLicit]) {
      if (!proc) continue;
      const alvos = idxProcLicitacaoNum.get(proc) ?? [];
      if (alvos.length === 0) continue;
      const v = avaliarProc(proc, 1, alvos.length);
      if (!v) continue;
      for (const refL of alvos) {
        empurrar(
          montarAresta(
            refEmp, refL, "empenho-licitacao",
            proc, "processo", v.confianca, exercicio,
            { cnpjRaiz: raizEmp, motivo: v.motivo },
          ),
        );
      }
    }

    // 3) empenho ↔ tce_despesa por (nrEmpenho normalizado + cnpj) → forte.
    if (nrEmp) {
      const chave = `${nrEmp}__${cnpjEmp || "sem-doc"}`;
      for (const refT of idxEmpenhoTce.get(chave) ?? []) {
        empurrar(
          montarAresta(
            refEmp, refT, "empenho-tce",
            nrEmp, "empenho", "forte", exercicio,
            { cnpjRaiz: raizEmp, motivo: `empenho ${nrEmp} + cnpj` },
          ),
        );
      }
    }

    // 4) empenho.processo ↔ DOM → media (o DOM cita o nº de processo no texto).
    for (const proc of [procAdmin, procLicit]) {
      if (!proc) continue;
      for (const refD of idxProcDom.get(proc) ?? []) {
        empurrar(
          montarAresta(
            refEmp, refD, "processo-dom",
            proc, "processo", "media", exercicio,
          ),
        );
      }
    }

    // 5) empenho ↔ documento-fonte do catálogo → confiança conforme a chave.
    //    Processo: forte; cnpj: fraca (mesmo CNPJ não prova o mesmo gasto).
    for (const proc of [procAdmin, procLicit]) {
      if (!proc) continue;
      for (const refDoc of idxDocCatalogo.get(`processo:${proc}`) ?? []) {
        empurrar(
          montarAresta(
            refEmp, refDoc, "doc",
            proc, "processo", "forte", exercicio,
          ),
        );
      }
    }
    if (cnpjEmp) {
      for (const refDoc of idxDocCatalogo.get(`cnpj:${cnpjEmp}`) ?? []) {
        empurrar(
          montarAresta(
            refEmp, refDoc, "doc",
            cnpjEmp, "cnpj", "fraca", exercicio,
            { cnpjRaiz: raizEmp, motivo: "mesmo CNPJ (indicio fraco)" },
          ),
        );
      }
    }
  }

  // ── Joins do lado PROCESSO entre DOM e contrato/licitação ──────────────────
  // Costura a edição do DOM ao contrato/licitação que cita o MESMO processo,
  // independentemente de existir empenho casando (o DOM↔processo é media).
  for (const [proc, refsDom] of idxProcDom) {
    if (!proc) continue;
    const alvos = [
      ...(idxProcContrato.get(proc) ?? []),
      ...(idxProcLicitacao.get(proc) ?? []),
    ];
    for (const refD of refsDom) {
      for (const refAlvo of alvos) {
        empurrar(
          montarAresta(
            refAlvo, refD, "processo-dom",
            proc, "processo", "media", exercicio,
          ),
        );
      }
    }
  }

  // ── Joins do catálogo de documentos com contrato/licitação por processo ────
  for (const [chave, refsDoc] of idxDocCatalogo) {
    if (!chave.startsWith("processo:")) continue;
    const proc = chave.slice("processo:".length);
    if (!proc) continue;
    const alvos = [
      ...(idxProcContrato.get(proc) ?? []),
      ...(idxProcLicitacao.get(proc) ?? []),
    ];
    for (const refDoc of refsDoc) {
      for (const refAlvo of alvos) {
        // Não linka o doc consigo mesmo (catálogo×catálogo nunca acontece aqui,
        // mas o contrato/licitação pode ser a própria fonte do doc — ainda é um
        // vínculo útil "este contrato é descrito por este documento").
        if (refAlvo.colecao === refDoc.colecao && refAlvo.id === refDoc.id) {
          continue;
        }
        empurrar(
          montarAresta(
            refAlvo, refDoc, "doc",
            proc, "processo", "forte", exercicio,
          ),
        );
      }
    }
  }

  return arestas;
}

// ── Persistência (upsert idempotente em lotes de 400) ────────────────────────

async function persistirArestas(arestas: Aresta[]): Promise<number> {
  if (arestas.length === 0) return 0;
  let batch = db.batch();
  let n = 0;
  for (const a of arestas) {
    batch.set(db.collection(COLECAO).doc(a.id), a.doc, { merge: true });
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

export const onNexoLinkage = onSchedule(
  {
    // 07h15 BRT — depois dos coletores diários (contratos 05h35, licitações
    // 05h45, DOM 06h45) e das ingestões SMARAPD da madrugada, para construir o
    // grafo sobre dados frescos.
    schedule: "15 7 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
    // Hardening (#13): no máximo UMA execução simultânea — evita que um disparo
    // atrasado/retry concorra com a execução em andamento e reconstrua o grafo
    // duas vezes ao mesmo tempo.
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: cada aresta tem docId determinístico
    // (sha1 das pontas + tipo) com `merge`, então reexecutar após falha
    // SOBRESCREVE, nunca duplica.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    await rodarLinkage();
  },
);

/**
 * Núcleo reutilizável do cron de linkage — extraído do handler para poder rodar
 * FORA do Cloud Scheduler (pipeline de inteligência local). Idêntico ao cron.
 */
export async function rodarLinkage(): Promise<void> {
    const inicio = Date.now();
    const anos = exerciciosAlvo();
    let totalLinks = 0;
    let falhas = 0;
    let ultimoErro: string | null = null;
    const porExercicio: Record<string, number> = {};

    for (const ano of anos) {
      try {
        const arestas = await construirArestas(ano);
        const gravados = await persistirArestas(arestas);
        totalLinks += gravados;
        porExercicio[String(ano)] = gravados;
        logger.info(`NEXO Linkage — ${ano}: ${gravados} vínculos em nexo_links`);
      } catch (err) {
        falhas++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.error(`NEXO Linkage — falha no exercício ${ano}`, err);
      }
    }

    const sucesso = falhas < anos.length;
    await gravarSyncState({
      syncId: "linkage",
      fonte: "linkage",
      colecao: COLECAO,
      cadencia: "diario",
      sucesso,
      degradado: falhas > 0,
      erro: falhas > 0 ? ultimoErro : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        exerciciosTentados: anos.length,
        exerciciosComFalha: falhas,
        vinculos: totalLinks,
        porExercicio,
      },
    });
    logger.info(
      `NEXO Linkage — concluído: ${totalLinks} vínculos, ${falhas} falhas`,
    );
}
