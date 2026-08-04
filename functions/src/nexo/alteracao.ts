/**
 * Detecção de ALTERAÇÃO RETROATIVA — `onNexoDetectarAlteracoes`
 * (expansão Fase 3 do plano-mestre).
 *
 * "Apontar se os dados foram alterados DEPOIS de publicados." Um ato público
 * (empenho, contrato, licitação) que muda de valor/objeto/datas/fornecedor
 * APÓS já ter sido coletado é um INDÍCIO FORTE a apurar: o registro mudou no
 * sistema-fonte (SMARAPD / Dados Abertos) depois de exposto. Não é prova de
 * irregularidade — pode ser correção legítima, retificação, complemento — mas
 * é exatamente o tipo de movimento que merece o olhar humano.
 *
 * ── COMO FUNCIONA ─────────────────────────────────────────────────────────
 * Para cada coleção-chave (`nexo_empenhos`, `nexo_contratos_municipais`,
 * `nexo_licitacoes`), o cron:
 *   1. lê cada registro e extrai seus CAMPOS MATERIAIS (valor, objeto, datas,
 *      fornecedor) — só o que importa juridicamente, ignorando metadados de
 *      coleta (`_coletadoEm`, etc.) que mudam a cada ciclo sem mudar o ato;
 *   2. calcula um HASH determinístico desses campos (createHash de
 *      `node:crypto`, sobre JSON com chaves ORDENADAS → estável, invariante à
 *      ordem das propriedades);
 *   3. confronta com o hash guardado em `nexo_snapshots` (1 doc por registro):
 *        - registro NUNCA visto  → grava o snapshot (primeira coleta), NÃO
 *          sinaliza alteração (a primeira coleta jamais é "mudança");
 *        - hash IGUAL ao guardado → nada mudou, só atualiza `visto`;
 *        - hash DIFERENTE         → o ato MUDOU depois de visto: grava em
 *          `nexo_alteracoes` o indício (hashAntes/hashDepois + qual campo
 *          material divergiu) e avança o snapshot para o novo hash.
 *
 * ── COLEÇÕES ──────────────────────────────────────────────────────────────
 *   nexo_snapshots   { docRef, colecao, docId, hash, materiais, primeiroVisto,
 *                      ultimoHash, visto, _exercicio }
 *       → memória de "como o registro estava da última vez". `hash` é o vigente;
 *         `ultimoHash` é o anterior (antes da última mudança detectada).
 *   nexo_alteracoes  { colecao, docId, docRef, campoMudou?, camposMudaram[],
 *                      hashAntes, hashDepois, detectadoEm, _exercicio }
 *       → o INDÍCIO a apurar. Doc novo a cada alteração detectada (histórico).
 *
 * É "indício a apurar", NUNCA acusação. O texto e os campos refletem isso.
 *
 * Cadência: diária (06h05 BRT) — após as coletas matinais (contratos 05h35,
 * licitações 05h45, coleta SMARAPD), para hashear o estado JÁ atualizado do dia.
 *
 * Self-contained: o projeto `functions/` não importa de `src/`. Usa `db`/`admin`
 * de `../shared/admin` e `gravarSyncState` de `./sync-state`.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { createHash } from "node:crypto";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

/** Coleção que guarda o último hash conhecido de cada registro. */
const COLECAO_SNAPSHOTS = "nexo_snapshots";
/** Coleção que registra os indícios de alteração retroativa detectados. */
const COLECAO_ALTERACOES = "nexo_alteracoes";

/**
 * Coleções-chave monitoradas. Cada uma tem o seu extrator de campos materiais
 * (as fontes têm formatos diferentes; o que é "material" varia por tipo de ato).
 */
const COLECOES_MONITORADAS = [
  "nexo_empenhos",
  "nexo_contratos_municipais",
  "nexo_licitacoes",
] as const;
type ColecaoMonitorada = (typeof COLECOES_MONITORADAS)[number];

/** Campos materiais normalizados de um registro — a "substância" do ato. */
type Materiais = Record<string, string>;

// ── Normalizadores ───────────────────────────────────────────────────────────

/** String trimada e estável (`""` para null/undefined). */
function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** Só dígitos (CNPJ/CPF) — invariante à formatação da fonte. */
function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

/**
 * Normaliza um valor monetário para uma string canônica e comparável. Aceita
 * number ou string BR (`1.234,56`) / ISO (`1234.56`). Devolve com 2 casas, sem
 * separador de milhar, para que `1234`, `1234.00` e `"1.234,00"` hasheiem igual
 * (não queremos ruído de formatação sinalizando "alteração").
 */
function normValor(v: unknown): string {
  if (v == null || v === "") return "";
  let n: number;
  if (typeof v === "number") {
    n = v;
  } else {
    const s = String(v).trim();
    const limpo = s.includes(",")
      ? s.replace(/\./g, "").replace(",", ".")
      : s;
    n = Number(limpo.replace(/[^\d.-]/g, ""));
  }
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

/**
 * Normaliza uma data para `YYYY-MM-DD` quando reconhecível; senão devolve a
 * string trimada (preserva o conteúdo sem inventar formato). Tolera
 * `YYYY-MM-DD[ T]HH:MM:SS` e `DD/MM/YYYY`. Mudanças só de HORA não devem
 * sinalizar — por isso reduzimos ao dia.
 */
function normData(v: unknown): string {
  const s = str(v);
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return s;
}

/** Texto livre (objeto/descrição) colapsado — espaço e caixa não são "material". */
function normTexto(v: unknown): string {
  return str(v).replace(/\s+/g, " ").toLowerCase();
}

/**
 * Primeiro campo presente entre os candidatos (case-sensitive, como vêm da
 * fonte). As coleções guardam tanto os campos crus do SMARAPD/Dados Abertos
 * quanto os canônicos `_`-prefixados; tentamos ambos.
 */
function campo(d: Record<string, unknown>, ...nomes: string[]): unknown {
  for (const n of nomes) {
    const v = d[n];
    if (v != null && v !== "") return v;
  }
  return undefined;
}

// ── Extração dos campos materiais por coleção ────────────────────────────────

/**
 * EMPENHO: valor (`_valor`/ValorEmpenho/…), fornecedor (`_fornecedor`/`_cnpj`),
 * objeto/histórico e a data de emissão. Os empenhos guardam os campos crus do
 * SMARAPD; cobrimos as variações de nome conhecidas.
 */
function materiaisEmpenho(d: Record<string, unknown>): Materiais {
  return {
    valor: normValor(
      campo(d, "_valor", "ValorEmpenho", "ValorEmpenhado", "Valor", "ValorPago"),
    ),
    fornecedor: normTexto(
      campo(d, "_fornecedor", "NomeFornecedor", "Fornecedor", "NomeBeneficiario"),
    ),
    cnpj: soDigitos(campo(d, "_cnpj", "CPFCNPJ", "CNPJ", "CpfCnpj")),
    objeto: normTexto(
      campo(d, "Historico", "Descricao", "Objeto", "DescricaoEmpenho"),
    ),
    data: normData(
      campo(d, "DataEmpenho", "Data", "DataEmissao", "DataLancamento"),
    ),
  };
}

/** CONTRATO MUNICIPAL: valor, objeto, fornecedor (nome+CNPJ) e a vigência. */
function materiaisContrato(d: Record<string, unknown>): Materiais {
  return {
    valor: normValor(campo(d, "valor", "_valor", "valorContrato")),
    fornecedor: normTexto(
      campo(d, "nomeContratada", "_fornecedor", "fornecedor"),
    ),
    cnpj: soDigitos(campo(d, "cnpjContratada", "_cnpj", "cnpj")),
    objeto: normTexto(campo(d, "objeto", "descricao")),
    vigenciaInicio: normData(campo(d, "vigenciaInicio", "dataInicioVigencia")),
    vigenciaFim: normData(
      campo(d, "vigenciaFim", "dataFimVigencia", "dataVigencia"),
    ),
  };
}

/** LICITAÇÃO: objeto, modalidade, situação, data de abertura e valor estimado. */
function materiaisLicitacao(d: Record<string, unknown>): Materiais {
  return {
    objeto: normTexto(campo(d, "objeto", "titulo", "descricao")),
    modalidade: normTexto(campo(d, "modalidade", "_modalidade")),
    situacao: normTexto(campo(d, "situacao")),
    dataAbertura: normData(
      campo(d, "dataAbertura", "dataRealizacao", "dataPostagem"),
    ),
    valorEstimado: normValor(campo(d, "valorEstimado", "valor", "valorReferencia")),
  };
}

/** Despacha para o extrator material da coleção. */
function extrairMateriais(
  colecao: ColecaoMonitorada,
  d: Record<string, unknown>,
): Materiais {
  switch (colecao) {
    case "nexo_empenhos":
      return materiaisEmpenho(d);
    case "nexo_contratos_municipais":
      return materiaisContrato(d);
    case "nexo_licitacoes":
      return materiaisLicitacao(d);
  }
}

// ── Hash determinístico ──────────────────────────────────────────────────────

/**
 * Hash SHA-256 dos campos materiais. As chaves são ORDENADas antes de
 * serializar (`JSON.stringify(obj, keysOrdenadas)`), tornando o hash invariante
 * à ordem de inserção das propriedades — determinístico e estável entre ciclos.
 * Só os campos materiais entram: metadados de coleta nunca contaminam o hash.
 */
function hashMateriais(m: Materiais): string {
  const chaves = Object.keys(m).sort();
  return createHash("sha256")
    .update(JSON.stringify(m, chaves))
    .digest("hex");
}

/**
 * Compara dois conjuntos de materiais e devolve os campos que divergiram. Usado
 * para enriquecer o indício com `campoMudou`/`camposMudaram` — ajuda o humano a
 * ir direto ao que mudou (ex.: "o VALOR subiu depois de publicado").
 */
function camposDivergentes(antes: Materiais, depois: Materiais): string[] {
  const chaves = new Set([...Object.keys(antes), ...Object.keys(depois)]);
  const mudaram: string[] = [];
  for (const k of chaves) {
    if ((antes[k] ?? "") !== (depois[k] ?? "")) mudaram.push(k);
  }
  return mudaram.sort();
}

// ── Snapshot store ───────────────────────────────────────────────────────────

/**
 * ID determinístico do snapshot — `{colecao}__{docId}`. 1 doc de snapshot por
 * registro monitorado; reexecutar o cron sobrescreve, nunca duplica.
 */
function idSnapshot(colecao: ColecaoMonitorada, docId: string): string {
  return `${colecao}__${docId}`.replace(/[^\w.-]/g, "_");
}

/** Linha do plano de gravação resultante da varredura de uma coleção. */
interface Plano {
  /** Snapshots a (re)gravar com o hash vigente. */
  snapshots: {
    id: string;
    colecao: ColecaoMonitorada;
    docId: string;
    docRef: string;
    hash: string;
    hashAnterior: string | null;
    materiais: Materiais;
    primeiraVez: boolean;
    exercicio: number | null;
  }[];
  /** Indícios de alteração retroativa a registrar. */
  alteracoes: {
    colecao: ColecaoMonitorada;
    docId: string;
    docRef: string;
    hashAntes: string;
    hashDepois: string;
    camposMudaram: string[];
    exercicio: number | null;
  }[];
  /** Registros lidos da coleção neste ciclo. */
  lidos: number;
  /** Registros vistos pela primeira vez (não geram indício). */
  novos: number;
}

/** Lê o `_exercicio` de um registro, quando presente (para escopo da consulta). */
function exercicioDe(d: Record<string, unknown>): number | null {
  const v = d._exercicio;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Varre uma coleção monitorada: lê cada registro, calcula o hash dos materiais e
 * confronta com o snapshot guardado. Devolve o PLANO de escrita (snapshots a
 * gravar + indícios a registrar) — a varredura é só leitura; a gravação é
 * separada e em lote.
 */
async function varrerColecao(colecao: ColecaoMonitorada): Promise<Plano> {
  const plano: Plano = {
    snapshots: [],
    alteracoes: [],
    lidos: 0,
    novos: 0,
  };

  // STREAMING em lotes de 300 (fix do OOM em prod): o `.get()` antigo carregava
  // a coleção INTEIRA (docs gordos com o bruto da coleta) de uma vez — estourava
  // os 512 MiB em `nexo_empenhos`. Agora cada doc é reduzido aos `materiais`
  // (campos enxutos) + hash assim que chega e o bruto vira lixo coletável; só o
  // lote corrente fica vivo, e o getAll dos snapshots roda por lote (≤300).
  interface ItemLote {
    docId: string;
    materiais: Materiais;
    hash: string;
    exercicio: number | null;
  }
  let lote: ItemLote[] = [];

  const processarLote = async (): Promise<void> => {
    if (lote.length === 0) return;
    const fatia = lote;
    lote = [];
    const refs = fatia.map((s) =>
      db.collection(COLECAO_SNAPSHOTS).doc(idSnapshot(colecao, s.docId)),
    );
    // snapId → { hash guardado, materiais guardados }. Lidos UMA vez — os
    // materiais antigos servem para enriquecer `camposMudaram` sem reler o doc.
    const snapAtuais = new Map<
      string,
      { hash: string; materiais?: Materiais }
    >();
    const got = await db.getAll(...refs);
    for (const s of got) {
      if (!s.exists) continue;
      const d = s.data();
      const mat = d?.materiais;
      snapAtuais.set(s.id, {
        hash: str(d?.hash),
        materiais:
          mat && typeof mat === "object" ? (mat as Materiais) : undefined,
      });
    }
    for (const item of fatia) confrontar(item, snapAtuais);
  };

  const confrontar = (
    item: ItemLote,
    snapAtuais: Map<string, { hash: string; materiais?: Materiais }>,
  ): void => {
    const { docId, materiais, hash, exercicio } = item;
    const snapId = idSnapshot(colecao, docId);
    const snapAntigo = snapAtuais.get(snapId);
    const hashGuardado = snapAntigo?.hash ?? null;
    const docRef = `${colecao}/${docId}`;

    if (hashGuardado === null) {
      // PRIMEIRA COLETA deste registro — registra o snapshot, JAMAIS sinaliza
      // alteração. Não há "antes" para comparar.
      plano.novos++;
      plano.snapshots.push({
        id: snapId,
        colecao,
        docId,
        docRef,
        hash,
        hashAnterior: null,
        materiais,
        primeiraVez: true,
        exercicio,
      });
      return;
    }

    if (hashGuardado === hash) {
      // Nada material mudou — só atualiza o carimbo `visto` (merge leve).
      plano.snapshots.push({
        id: snapId,
        colecao,
        docId,
        docRef,
        hash,
        hashAnterior: hashGuardado,
        materiais,
        primeiraVez: false,
        exercicio,
      });
      return;
    }

    // HASH MUDOU num registro JÁ VISTO → indício forte de alteração retroativa.
    // Para detalhar QUAIS campos divergiram, comparamos contra os `materiais`
    // que o próprio snapshot guardou (lidos no mesmo getAll acima — sem reler).
    // Snapshot antigo sem `materiais` (versões pré-este-cron) ⇒ `camposMudaram`
    // vazio; o hashAntes/hashDepois já provam a mudança. Auto-corrige no próximo
    // ciclo, que regrava o snapshot já com `materiais`.
    plano.alteracoes.push({
      colecao,
      docId,
      docRef,
      hashAntes: hashGuardado,
      hashDepois: hash,
      camposMudaram: snapAntigo?.materiais
        ? camposDivergentes(snapAntigo.materiais, materiais)
        : [],
      exercicio,
    });
    plano.snapshots.push({
      id: snapId,
      colecao,
      docId,
      docRef,
      hash,
      hashAnterior: hashGuardado,
      materiais,
      primeiraVez: false,
      exercicio,
    });
  };

  const stream = db
    .collection(colecao)
    .stream() as AsyncIterable<FirebaseFirestore.QueryDocumentSnapshot>;

  if (colecao === "nexo_empenhos") {
    // EMPENHOS: identidade por GRUPO natural, não por docId. O docId da coleta
    // embute um hash do CONTEÚDO (linhas distintas do fornecedoranalitico
    // compartilham NroEmpenho) — qualquer mudança na fonte cria docId NOVO e o
    // antigo é purgado, então o confronto por docId NUNCA via alteração
    // retroativa em empenho (cegueira estrutural; auditoria 2026-06-09).
    // Agrupamos por exercício+nº+CNPJ e hasheamos o MULTISET das linhas do
    // grupo: linha editada/removida/adicionada muda o hash do grupo → indício.
    const grupos = new Map<string, GrupoEmpenho>();
    for await (const doc of stream) {
      plano.lidos++;
      const data = doc.data();
      const materiais = materiaisEmpenho(data);
      const chave = chaveGrupoEmpenho(data);
      if (!chave) {
        // Sem chave natural — mantém o confronto por docId (comportamento
        // antigo; segue cego para esses, mas são a exceção e ficam honestos).
        lote.push({
          docId: doc.id,
          materiais,
          hash: hashMateriais(materiais),
          exercicio: exercicioDe(data),
        });
        if (lote.length >= 300) await processarLote();
        continue;
      }
      const g = grupos.get(chave) ?? {
        exercicio: exercicioDe(data),
        cnpj: String(materiais.cnpj ?? ""),
        fornecedor: String(materiais.fornecedor ?? ""),
        soma: 0,
        parcelas: 0,
        hashesLinhas: [],
      };
      g.parcelas++;
      g.soma += Number(materiais.valor || 0);
      if (!g.fornecedor) g.fornecedor = String(materiais.fornecedor ?? "");
      g.hashesLinhas.push(hashMateriais(materiais));
      grupos.set(chave, g);
    }
    for (const [chave, g] of grupos) {
      const materiais = materiaisDoGrupo(g);
      lote.push({
        docId: `g_${chave}`,
        materiais,
        hash: hashMateriais(materiais),
        exercicio: g.exercicio,
      });
      if (lote.length >= 300) await processarLote();
    }
    await processarLote();
    return plano;
  }

  for await (const doc of stream) {
    plano.lidos++;
    const data = doc.data();
    const materiais = extrairMateriais(colecao, data);
    lote.push({
      docId: doc.id,
      materiais,
      hash: hashMateriais(materiais),
      exercicio: exercicioDe(data),
    });
    if (lote.length >= 300) await processarLote();
  }
  await processarLote();

  return plano;
}

// ── Agrupamento natural de empenhos ──────────────────────────────────────────

/** Acumulador de um grupo natural (exercício+nº empenho+CNPJ) de empenhos. */
interface GrupoEmpenho {
  exercicio: number | null;
  cnpj: string;
  fornecedor: string;
  soma: number;
  parcelas: number;
  hashesLinhas: string[];
}

/**
 * Chave NATURAL do grupo — mesmos campos candidatos que `idDocumento` da
 * coleta usa como prefixo, sem o hash de conteúdo. Null quando o registro não
 * tem identificador natural (cai no confronto por docId).
 */
function chaveGrupoEmpenho(d: Record<string, unknown>): string | null {
  const nro = campo(
    d,
    "ID",
    "Id",
    "Codigo",
    "NroEmpenho",
    "NumeroEmpenho",
    "NumEmpenho",
  );
  if (nro == null) return null;
  const ex = exercicioDe(d);
  const cnpj = soDigitos(campo(d, "_cnpj", "CPFCNPJ", "CNPJ", "CpfCnpj"));
  return `${ex ?? "x"}_${String(nro).replace(/[^\w-]/g, "_")}_${cnpj || "semdoc"}`;
}

/**
 * Materiais do GRUPO: agregados legíveis (total/parcelas/fornecedor) para o
 * `camposMudaram` apontar o que mudou nos casos comuns, mais o digest
 * order-invariante do multiset de linhas (`conteudo`) que captura QUALQUER
 * mudança textual/data de qualquer linha.
 */
function materiaisDoGrupo(g: GrupoEmpenho): Materiais {
  return {
    parcelas: String(g.parcelas),
    valorTotal: g.soma.toFixed(2),
    fornecedor: g.fornecedor,
    cnpj: g.cnpj,
    conteudo: createHash("sha256")
      .update([...g.hashesLinhas].sort().join("|"))
      .digest("hex"),
  };
}

/**
 * Purga LIMITADA dos snapshots de empenho no formato ANTIGO (por docId —
 * `nexo_empenhos__{exercicio}-...`, sempre iniciando em dígito, portanto
 * lexicograficamente antes do prefixo novo `nexo_empenhos__g_`). Eram órfãos
 * permanentes (docId com hash de conteúdo morre a cada mudança na fonte) e
 * com a migração para grupos nunca mais são confrontados. Cap por ciclo para
 * não estourar o orçamento do cron; termina em poucos dias.
 */
async function purgarSnapshotsAntigosEmpenhos(cap: number): Promise<number> {
  const snap = await db
    .collection(COLECAO_SNAPSHOTS)
    .where(admin.firestore.FieldPath.documentId(), ">=", "nexo_empenhos__")
    .where(admin.firestore.FieldPath.documentId(), "<", "nexo_empenhos__g_")
    .limit(cap)
    .select()
    .get();
  let batch = db.batch();
  let n = 0;
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    n++;
    if (n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
  return n;
}

// ── Persistência ─────────────────────────────────────────────────────────────

/**
 * Grava os snapshots e os indícios de um plano, em lotes de 400 operações.
 *   - snapshot novo  → `primeiroVisto` set-once, `hash`, `materiais`, `visto`;
 *   - snapshot visto → atualiza `hash`/`materiais`/`visto` e guarda `ultimoHash`
 *     (o hash anterior) quando houve mudança;
 *   - indício        → SEMPRE doc NOVO (auto-id) — histórico de alterações, uma
 *     linha por detecção, nunca sobrescreve uma anterior.
 */
async function gravarPlano(plano: Plano): Promise<void> {
  const now = admin.firestore.FieldValue.serverTimestamp();
  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (ops > 0) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  for (const s of plano.snapshots) {
    const doc: Record<string, unknown> = {
      docRef: s.docRef,
      colecao: s.colecao,
      docId: s.docId,
      hash: s.hash,
      materiais: s.materiais,
      visto: now,
      _exercicio: s.exercicio,
    };
    if (s.primeiraVez) {
      doc.primeiroVisto = now;
      doc.ultimoHash = null;
    } else if (s.hashAnterior && s.hashAnterior !== s.hash) {
      // Só avança `ultimoHash` quando de fato mudou — assim ele aponta para o
      // hash imediatamente anterior à última alteração detectada.
      doc.ultimoHash = s.hashAnterior;
    }
    batch.set(db.collection(COLECAO_SNAPSHOTS).doc(s.id), doc, { merge: true });
    ops++;
    if (ops >= 400) await flush();
  }

  for (const a of plano.alteracoes) {
    const doc: Record<string, unknown> = {
      colecao: a.colecao,
      docId: a.docId,
      docRef: a.docRef,
      hashAntes: a.hashAntes,
      hashDepois: a.hashDepois,
      camposMudaram: a.camposMudaram,
      // `campoMudou`: atalho para o primeiro campo divergente (null se a fonte
      // não permitiu detalhar). O hashAntes/hashDepois já comprovam a mudança.
      campoMudou: a.camposMudaram[0] ?? null,
      detectadoEm: now,
      _exercicio: a.exercicio,
      // Linguagem de INDÍCIO, jamais de acusação — o registro mudou DEPOIS de
      // coletado; cabe ao humano apurar se foi correção legítima ou não.
      _natureza: "indicio_a_apurar",
    };
    // ID DETERMINÍSTICO da transição `{colecao}__{docId}__{hashAntes}__{hashDepois}`
    // (hashes truncados — colisão desprezível). Uma linha por transição DISTINTA:
    //   • um retry da MESMA detecção REGRAVA o mesmo doc (idempotente) em vez de
    //     (a) duplicar ou (b) sumir caso o snapshot já tenha avançado entre os
    //     commits de snapshots e de indícios — elimina os DOIS riscos da gravação
    //     em duas etapas;
    //   • uma alteração NOVA (par de hashes diferente) gera um doc novo → o
    //     histórico append-only de transições distintas é preservado.
    // (`detectadoEm` pode ser re-carimbado por um retry do MESMO ciclo — inócuo,
    // mesmo dia; um ciclo futuro não re-detecta a transição, pois o snapshot já
    // avançou além de `hashAntes`.)
    const idAlteracao = `${a.colecao}__${a.docId}__${a.hashAntes.slice(0, 16)}__${a.hashDepois.slice(0, 16)}`.replace(
      /[^\w.-]/g,
      "_",
    );
    batch.set(db.collection(COLECAO_ALTERACOES).doc(idAlteracao), doc, {
      merge: true,
    });
    ops++;
    if (ops >= 400) await flush();
  }

  await flush();
}

// ── Cron diário ──────────────────────────────────────────────────────────────

export const onNexoDetectarAlteracoes = onSchedule(
  {
    // 06h35 — DEPOIS do enriquecimento de contratos (06h05): rodar no mesmo
    // horário fazia o hash material ler um estado não-determinístico da mesma
    // coleção (corrida de escrita/leitura → falso indício de alteração).
    schedule: "35 6 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    // 1 GiB: mesmo com a varredura em streaming (lotes de 300), o PLANO acumula
    // materiais+hash de todos os registros da coleção — em `nexo_empenhos` isso
    // passava perto dos 512 MiB (OOM em prod, 2026-06-09).
    memory: "1GiB",
    // Hardening (#13): no máximo UMA execução simultânea — dois ciclos
    // concorrentes poderiam ler o mesmo snapshot "antigo" e gravar indícios
    // duplicados para a mesma alteração. Serializar elimina a corrida.
    maxInstances: 1,
    // Retry IDEMPOTENTE de ponta a ponta: tanto o snapshot (docId `{colecao}__
    // {docId}`) quanto o indício (docId `{colecao}__{docId}__{hashAntes}__
    // {hashDepois}`) têm id determinístico gravado com `merge`. Reexecutar após
    // falha REGRAVA os mesmos docs — não duplica indício nem o perde caso o
    // snapshot já tenha avançado entre os commits parciais do plano.
    retryCount: 1,
    maxRetrySeconds: 1800,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    let totalLidos = 0;
    let totalNovos = 0;
    let totalAlteracoes = 0;
    let falhas = 0;
    let ultimoErro: string | null = null;
    const porColecao: Record<string, number> = {};

    for (const colecao of COLECOES_MONITORADAS) {
      try {
        const plano = await varrerColecao(colecao);
        await gravarPlano(plano);

        totalLidos += plano.lidos;
        totalNovos += plano.novos;
        totalAlteracoes += plano.alteracoes.length;
        porColecao[colecao] = plano.alteracoes.length;

        logger.info(
          `NEXO Alterações — ${colecao}: ${plano.lidos} registros, ` +
            `${plano.novos} novos (primeira coleta), ` +
            `${plano.alteracoes.length} alterações retroativas detectadas`,
        );
      } catch (err) {
        falhas++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.error(`NEXO Alterações — falha na coleção ${colecao}`, err);
      }
    }

    // Migração dos snapshots de empenho para o esquema por GRUPO: purga
    // gradual dos órfãos do formato antigo (cap por ciclo). Falha aqui não
    // derruba o cron.
    let orfaosPurgados = 0;
    try {
      orfaosPurgados = await purgarSnapshotsAntigosEmpenhos(20_000);
      if (orfaosPurgados > 0) {
        logger.info(
          `NEXO Alterações — ${orfaosPurgados} snapshots órfãos (formato ` +
            `antigo de empenho) purgados neste ciclo`,
        );
      }
    } catch (err) {
      logger.warn("NEXO Alterações — purga de snapshots órfãos falhou", err);
    }

    const sucesso = falhas < COLECOES_MONITORADAS.length;
    await gravarSyncState({
      syncId: "alteracoes",
      fonte: "nexo-snapshots",
      colecao: COLECAO_ALTERACOES,
      cadencia: "diario",
      sucesso,
      degradado: falhas > 0,
      erro: falhas > 0 ? ultimoErro : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        colecoesMonitoradas: COLECOES_MONITORADAS.length,
        colecoesComFalha: falhas,
        registrosVarridos: totalLidos,
        primeirasColetas: totalNovos,
        alteracoesDetectadas: totalAlteracoes,
        alteracoesPorColecao: porColecao,
        snapshotsOrfaosPurgados: orfaosPurgados,
      },
    });
    logger.info(
      `NEXO Alterações — concluído: ${totalLidos} registros varridos, ` +
        `${totalNovos} primeiras coletas (não sinalizadas), ` +
        `${totalAlteracoes} alterações retroativas (indícios a apurar), ` +
        `${falhas} falhas`,
    );
  },
);
