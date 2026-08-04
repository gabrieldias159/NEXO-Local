/**
 * CRUZAMENTOS MATERIALIZADOS do NEXO — `onNexoCruzamentos` (Onda 4, plano-mestre
 * §2.3, camada de INTELIGENCIA).
 *
 * Este cron NAO coleta de fontes externas: LE as colecoes `nexo_*` que os
 * coletores ja populam e MATERIALIZA dois entregaveis da camada de inteligencia,
 * distintos do `nexo_links` (que e o grafo TECNICO de arestas por chave):
 *
 *   1. `nexo_cruzamentos/{sha1}` — arestas TIPADAS com PROVENIENCIA e CONFIANCA
 *      EXPLICAVEL (schema do §2.3). Tipos materializados:
 *        • `socio-doador`     — um socio de fornecedor consta como doador (TSE).
 *                               PROBABILISTICO (nome+cpf6) → fraca/informativo;
 *                               ou por hash de doc (cpfHash==docHash) → media.
 *        • `empresa-doador`   — a propria empresa fornecedora consta como doadora
 *                               (hash do CNPJ == docHash do doador). So vale como
 *                               doacao LICITA de PJ ate 2014 (ADI 4650) — rotulado.
 *        • `empenho-contrato` — DERIVADO de `nexo_links` (tipo 'empenho-contrato'),
 *                               re-tipado com confianca herdada da aresta tecnica.
 *        • `socio-comum`      — dois fornecedores que compartilham o MESMO socio
 *                               (cpfHash em comum) — indicio de grupo economico.
 *
 *   2. `nexo_ranking_vinculo/{id}` — o ENTREGAVEL central: 1 doc por fornecedor
 *      (CNPJ-raiz) com vinculo doador↔contrato, ordenavel por
 *      `potencial = min(totalDoado, totalEmpenhado)`, `classificacaoMax:'atencao'`.
 *      E a versao materializada do que a rota /api/nexo/ranking-doadores computava
 *      ao vivo — o cron pre-computa, a rota passa a so LER.
 *
 * ── HONESTIDADE RADICAL (LGPD / juridico) ─────────────────────────────────────
 *   • doador↔socio e PROBABILISTICO (nome + 6 digitos do miolo do CPF, unico dado
 *     que Receita e TSE expoem em comum) → confianca 'fraca'/'informativo'. NUNCA
 *     identificacao forte. Homonimia + colisao dos 6 digitos e possivel.
 *   • doacao de PJ vedada desde 2015 (ADI 4650): `empresa-doador` so e licito
 *     para eleicoes <= 2014 — o doc carrega `obs` rotulando isso.
 *   • `classificacaoMax` <= 'atencao' SEMPRE. Doacao e ato LICITO; isto e POTENCIAL
 *     conflito A APURAR, nunca acusacao.
 *   • NENHUM CPF/CNPJ cru e persistido. Docs vao MASCARADOS (`mascararDoc`) e os
 *     joins usam HASH (`hashDoc`/`chaveFraca`). `docMasc` na ponta, `_docHash` so
 *     se precisar (aqui nem isso — basta a mascara + o hash ja anonimo).
 *
 * ── functions NAO importa de src ──────────────────────────────────────────────
 * Reimplementa a logica de cruzamento lendo `nexo_doacoes_tse`/`nexo_socios`/
 * `nexo_empenhos`/`nexo_contratos_municipais`/`nexo_links` via `admin db`, usando
 * `chaveFraca`/`cpf6De` de `./chaves` e `hashDoc`/`mascararDoc` de `./pii` (os
 * mesmos algoritmos do lado app, por construcao — espelho verbatim).
 *
 * ── IDEMPOTENCIA ──────────────────────────────────────────────────────────────
 * docId determinISTICO: cruzamento = sha1(tipo|ladoA|ladoB|exercicio); ranking =
 * `vinc_{exercicio}_{raiz}`. `set(..., {merge:true})` e UPSERT — reexecutar
 * SOBRESCREVE, nunca duplica. Antes de gravar o ranking de um exercicio, PURGA os
 * docs daquele exercicio que nao reapareceram (snapshot consistente).
 *
 * Cron DIARIO 08h45 BRT — DEPOIS de linkage (07h15), perfil (07h45), socios
 * (08h15) e score (08h30), para materializar sobre o grafo/QSA frescos do dia.
 * `maxInstances:1`. `gravarSyncState` ao fim.
 */
import { createHash } from "node:crypto";

import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import { chaveFraca, cpf6De } from "./chaves";
import { hashDoc, mascararDoc } from "./pii";

/** Colecao de arestas tipadas/explicaveis (distinta do nexo_links tecnico). */
const COL_CRUZAMENTOS = "nexo_cruzamentos";
/** Colecao do ENTREGAVEL: ranking doador↔contrato, 1 doc por fornecedor. */
const COL_RANKING = "nexo_ranking_vinculo";
/** Versao do esquema dos docs gravados — sobe se o shape mudar. */
const VERSAO_ESQUEMA = 1;

/** Teto de docs lidos por colecao/exercicio — protecao de memoria/tempo. */
const MAX_DOCS = 30_000;
/** Ultimo ano em que doacao de PJ era licita (ADI 4650 vedou a partir de 2015). */
const ANO_LIMITE_PJ = 2014;
/** Teto de arestas socio-comum por raiz — evita explosao combinatoria. */
const MAX_PARES_SOCIO_COMUM = 50;
/** Teto de politicos listados por item de ranking (contexto). */
const MAX_POLITICOS = 8;
/** Teto de itens de ranking persistidos por exercicio (foco na worklist). */
const MAX_RANKING = 500;

// ── Normalizadores (campos crus → tipos limpos) ──────────────────────────────

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
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

function primeiro(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return "";
}

/** Raiz do CNPJ (8 primeiros digitos) — colapsa filiais no mesmo grupo. */
function cnpjRaizDe(doc: unknown): string {
  const d = soDigitos(doc);
  return d.length >= 8 ? d.slice(0, 8) : "";
}

/**
 * Heuristica MINIMA de ente publico (espelho do espirito de `ehEntidadePublica`
 * do app — functions nao importa de src). Exclui Prefeitura/Camara/orgaos para
 * que NUNCA virem "fornecedor doador". Conservadora: na duvida, NAO exclui (o
 * cruzamento ja e indicio a apurar, e excluir demais esconderia vinculo real).
 */
const RX_ENTE_PUBLICO =
  /\b(prefeitura|municip|camara|c[aâ]mara|secretaria|fundo\s+municipal|autarquia|instituto\s+de\s+previd|minist[eé]rio|uni[aã]o|estado\s+de|fazenda\s+(nacional|p[uú]blica)|receita\s+federal|tribunal|fundacao\s+p[uú]blica|funda[çc][aã]o\s+p[uú]blica)\b/i;

function ehEntePublico(cnpj: string, nome: string): boolean {
  // CNPJ de orgao publico costuma comecar por natureza juridica 1xxx; mas a base
  // nao traz natureza confiavel aqui — usamos o NOME como sinal primario.
  if (RX_ENTE_PUBLICO.test(nome || "")) return true;
  void cnpj;
  return false;
}

// ── Leitura das colecoes (admin db, por exercicio quando aplicavel) ──────────

interface DocLido {
  id: string;
  data: Record<string, unknown>;
}

async function lerPorExercicio(
  colecao: string,
  exercicio: number,
): Promise<DocLido[]> {
  const snap = await db
    .collection(colecao)
    .where("_exercicio", "==", exercicio)
    .limit(MAX_DOCS)
    .get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

/**
 * Le `nexo_doacoes_tse` SEM filtro de `_exercicio` (a colecao indexa por `ano`,
 * NAO carrega `_exercicio` confiavel — ver coleta-tse-doacoes.ts). Doacoes sao
 * ano-agnosticas no cruzamento: um doador casa com um fornecedor seja qual for o
 * ano da eleicao. Capada por MAX_DOCS.
 */
async function lerDoacoes(): Promise<DocLido[]> {
  const snap = await db.collection("nexo_doacoes_tse").limit(MAX_DOCS).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

/** Le `nexo_socios` (QSA) — colecao pequena, sem `_exercicio`. */
async function lerSocios(): Promise<DocLido[]> {
  const snap = await db.collection("nexo_socios").limit(MAX_DOCS).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

/**
 * Le as arestas `empenho-contrato` ja materializadas em `nexo_links` para o
 * exercicio — o tipo `empenho-contrato` do nexo_cruzamentos e DERIVADO delas
 * (re-tipado com proveniencia explicavel), nao recomputado do zero.
 */
async function lerLinksEmpenhoContrato(exercicio: number): Promise<DocLido[]> {
  const snap = await db
    .collection("nexo_links")
    .where("_exercicio", "==", exercicio)
    .where("tipo", "==", "empenho-contrato")
    .limit(MAX_DOCS)
    .get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

// ── Modelos internos ──────────────────────────────────────────────────────────

type Confianca = "forte" | "media" | "fraca" | "informativo";

interface DoacaoCtx {
  docHash: string;
  docMasc: string;
  nomeDoador: string;
  candidato: string;
  ano: number;
  valor: number;
  /** chave fraca (nome+cpf6) — caminho probabilistico doador-PF↔socio. "" p/ PJ. */
  chaveFraca: string;
  /** doador e PJ (CNPJ)? Sinaliza a regra ADI 4650 (so licito <=2014). */
  ehPj: boolean;
}

interface SocioPessoa {
  cpfHash: string;
  cpfMasc: string;
  nome: string;
  chaveFraca: string;
}

interface FornecedorAgg {
  raiz: string;
  cnpj: string;
  nome: string;
  valorEmpenhado: number;
}

/** Converte docs crus de nexo_doacoes_tse em DoacaoCtx (sem doc cru). */
function doacoesDeDocs(docs: DocLido[]): DoacaoCtx[] {
  const out: DoacaoCtx[] = [];
  for (const { data: d } of docs) {
    const docHash = str(d.docHashDoador ?? d.docHash);
    if (!docHash) continue;
    const cf = str(d.chaveFraca);
    // PJ: tem _cnpjRaiz (8 dig) e nao tem chaveFraca de PF. PF: tem chaveFraca.
    const ehPj = soDigitos(d._cnpjRaiz).length === 8 && !cf;
    out.push({
      docHash,
      docMasc: str(d.docMasc),
      nomeDoador: str(d.nomeDoador),
      candidato: str(d.candidato),
      ano: Number(d.ano) || 0,
      valor: toNum(d.valor),
      chaveFraca: cf,
      ehPj,
    });
  }
  return out;
}

/** Converte docs crus de nexo_socios preservando cpfHash/chaveFraca por socio. */
function sociosDeDocs(
  docs: DocLido[],
): Map<string, { cnpj: string; razaoSocial: string; socios: SocioPessoa[] }> {
  const porRaiz = new Map<
    string,
    { cnpj: string; razaoSocial: string; socios: SocioPessoa[] }
  >();
  for (const { data: d } of docs) {
    const cnpj = soDigitos(primeiro(d, "_cnpj", "cnpj"));
    if (cnpj.length !== 14) continue;
    const razaoSocial = str(d.razaoSocial);
    if (ehEntePublico(cnpj, razaoSocial)) continue;
    const raiz =
      soDigitos(d._cnpjRaiz).length === 8
        ? soDigitos(d._cnpjRaiz)
        : cnpjRaizDe(cnpj);
    const sociosRaw = Array.isArray(d.socios) ? d.socios : [];
    const socios: SocioPessoa[] = [];
    for (const s of sociosRaw) {
      const r = (s ?? {}) as Record<string, unknown>;
      const p: SocioPessoa = {
        cpfHash: str(r.cpfHash),
        cpfMasc: str(r.cpfMasc),
        nome: str(r.nome),
        // chaveFraca pode vir crua do doc; se faltar, recompoe de nome+cpf6 (mas
        // o cpf6 nao e re-derivavel da mascara — entao so usa a crua quando ha).
        chaveFraca: str(r.chaveFraca) || chaveFraca(r.nome, cpf6De(r.cpf6)),
      };
      if (p.cpfHash || p.nome || p.chaveFraca) socios.push(p);
    }
    const cur = porRaiz.get(raiz);
    if (cur) cur.socios.push(...socios);
    else porRaiz.set(raiz, { cnpj, razaoSocial, socios });
  }
  return porRaiz;
}

/** Agrega empenhos por CNPJ-raiz (so PJ privada com CNPJ de 14 dig). */
function fornecedoresPorRaiz(empenhos: DocLido[]): Map<string, FornecedorAgg> {
  const por = new Map<string, FornecedorAgg>();
  for (const { data: e } of empenhos) {
    const cnpj = soDigitos(
      primeiro(e, "_cnpj", "CPFCNPJ", "CpfCnpj", "CNPJ", "CpfCnpjFornecedor"),
    );
    if (cnpj.length !== 14) continue;
    const nome = primeiro(e, "NomeFornecedor", "Fornecedor", "_fornecedor");
    if (ehEntePublico(cnpj, nome)) continue;
    const valor = toNum(primeiro(e, "ValorEmpenho", "ValorEmpenhado") || e._valor);
    const raiz = cnpjRaizDe(cnpj);
    const cur = por.get(raiz);
    if (cur) {
      cur.valorEmpenhado += valor;
      if (!cur.nome && nome) cur.nome = nome;
    } else {
      por.set(raiz, { raiz, cnpj, nome, valorEmpenhado: valor });
    }
  }
  return por;
}

// ── docId determinISTICO das arestas ──────────────────────────────────────────

function idCruzamento(
  tipo: string,
  ladoA: string,
  ladoB: string,
  exercicio: number,
): string {
  // Canonicaliza a direcao (A,B ordenados) p/ a MESMA aresta gerar o mesmo id.
  const [x, y] = ladoA <= ladoB ? [ladoA, ladoB] : [ladoB, ladoA];
  return createHash("sha1")
    .update([tipo, x, y, exercicio].join("|"))
    .digest("hex");
}

/** Lado de uma aresta de cruzamento (mascarado — nunca doc cru). */
interface Lado {
  kind: string;
  valor: string;
  rotulo: string;
  docMasc?: string;
}

interface Cruzamento {
  id: string;
  doc: Record<string, unknown>;
}

function montarCruzamento(input: {
  tipo: "socio-doador" | "empresa-doador" | "empenho-contrato" | "socio-comum";
  ladoA: Lado;
  ladoB: Lado;
  confianca: Confianca;
  baseConfianca: string[];
  valorAncora: number;
  exercicio: number;
  cnpjRaiz: string;
  obs?: string;
}): Cruzamento {
  const id = idCruzamento(
    input.tipo,
    `${input.ladoA.kind}:${input.ladoA.valor}`,
    `${input.ladoB.kind}:${input.ladoB.valor}`,
    input.exercicio,
  );
  const doc: Record<string, unknown> = {
    tipo: input.tipo,
    ladoA: input.ladoA,
    ladoB: input.ladoB,
    confianca: input.confianca,
    baseConfianca: input.baseConfianca,
    valorAncora: input.valorAncora,
    // Teto OBRIGATORIO: cruzamento de inteligencia e indicio A APURAR.
    classificacaoMax: "atencao",
    _exercicio: input.exercicio,
    _cnpjRaiz: input.cnpjRaiz || null,
    _fonte: "cruzamentos",
    _versaoEsquema: VERSAO_ESQUEMA,
    geradoEm: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (input.obs) doc.obs = input.obs;
  return { id, doc };
}

// ── Construcao dos cruzamentos + ranking de UM exercicio ──────────────────────

interface ResultadoExercicio {
  cruzamentos: Cruzamento[];
  ranking: { id: string; doc: Record<string, unknown> }[];
}

async function construirExercicio(
  exercicio: number,
  doacoes: DoacaoCtx[],
  sociosPorRaiz: Map<
    string,
    { cnpj: string; razaoSocial: string; socios: SocioPessoa[] }
  >,
): Promise<ResultadoExercicio> {
  const empenhos = await lerPorExercicio("nexo_empenhos", exercicio);
  const fornecedores = fornecedoresPorRaiz(empenhos);

  const cruzamentos: Cruzamento[] = [];
  const ranking: { id: string; doc: Record<string, unknown> }[] = [];

  // ── Indices de doacao por hash de doc e por chaveFraca (probabilistico) ─────
  const doacoesPorHash = new Map<string, DoacaoCtx[]>();
  const doacoesPorChaveFraca = new Map<string, DoacaoCtx[]>();
  const indexar = (m: Map<string, DoacaoCtx[]>, k: string, d: DoacaoCtx) => {
    const arr = m.get(k);
    if (arr) arr.push(d);
    else m.set(k, [d]);
  };
  for (const d of doacoes) {
    if (d.docHash) indexar(doacoesPorHash, d.docHash, d);
    if (d.chaveFraca) indexar(doacoesPorChaveFraca, d.chaveFraca, d);
  }

  // ── (A) socio-comum: dois fornecedores que compartilham o MESMO socio ───────
  // Index cpfHash → lista de raizes (fornecedores) que o tem como socio.
  const raizesPorCpfHash = new Map<string, { raiz: string; nome: string }[]>();
  for (const [raiz, info] of sociosPorRaiz) {
    if (!fornecedores.has(raiz)) continue; // so socios de fornecedores reais
    for (const p of info.socios) {
      const h = p.cpfHash.trim();
      if (!h) continue;
      const arr = raizesPorCpfHash.get(h);
      const ent = { raiz, nome: p.nome || p.cpfMasc || "socio" };
      if (arr) arr.push(ent);
      else raizesPorCpfHash.set(h, [ent]);
    }
  }
  let paresSocioComum = 0;
  for (const [, donos] of raizesPorCpfHash) {
    // Desduplica raizes (um socio pode aparecer 2x na mesma empresa).
    const raizesUnicas = Array.from(new Set(donos.map((d) => d.raiz)));
    if (raizesUnicas.length < 2) continue;
    const nomeSocio = donos[0]?.nome ?? "socio";
    for (let i = 0; i < raizesUnicas.length; i++) {
      for (let j = i + 1; j < raizesUnicas.length; j++) {
        if (paresSocioComum >= MAX_PARES_SOCIO_COMUM) break;
        const ra = raizesUnicas[i];
        const rb = raizesUnicas[j];
        const fa = fornecedores.get(ra);
        const fb = fornecedores.get(rb);
        if (!fa || !fb) continue;
        cruzamentos.push(
          montarCruzamento({
            tipo: "socio-comum",
            ladoA: { kind: "empresa", valor: ra, rotulo: fa.nome || fa.cnpj, docMasc: mascararDoc(fa.cnpj) },
            ladoB: { kind: "empresa", valor: rb, rotulo: fb.nome || fb.cnpj, docMasc: mascararDoc(fb.cnpj) },
            // cpfHash em comum = mesmo documento de socio → confianca FORTE no FATO
            // (o vinculo societario e factual), mas e indicio A APURAR de conluio.
            confianca: "forte",
            baseConfianca: ["cpfHash-comum"],
            valorAncora: Math.min(fa.valorEmpenhado, fb.valorEmpenhado),
            exercicio,
            cnpjRaiz: ra,
            obs:
              `Socio em comum (${nomeSocio}) entre dois fornecedores da ` +
              `Prefeitura — indicio de grupo economico/possivel conluio A APURAR. ` +
              `Compartilhar socio e licito; o sinal e para verificar disputa de ` +
              `licitacao entre ligadas.`,
          }),
        );
        paresSocioComum++;
      }
    }
  }

  // ── (B) empenho-contrato: DERIVADO de nexo_links (re-tipado/explicavel) ──────
  const links = await lerLinksEmpenhoContrato(exercicio);
  for (const { data: l } of links) {
    const de = (l._de ?? {}) as Record<string, unknown>;
    const para = (l._para ?? {}) as Record<string, unknown>;
    const idDe = str(de.id);
    const idPara = str(para.id);
    if (!idDe || !idPara) continue;
    const confLink = str(l.confianca);
    const conf: Confianca =
      confLink === "forte" ? "forte" : confLink === "media" ? "media" : "fraca";
    const raiz = soDigitos(l._cnpjRaiz);
    cruzamentos.push(
      montarCruzamento({
        tipo: "empenho-contrato",
        ladoA: { kind: str(de.colecao) || "nexo_empenhos", valor: idDe, rotulo: idDe },
        ladoB: { kind: str(para.colecao) || "nexo_contratos_municipais", valor: idPara, rotulo: idPara },
        confianca: conf,
        baseConfianca: [`chave-${str(l.chaveTipo) || "processo"}`],
        valorAncora: 0, // a aresta tecnica nao carrega valor; o ranking traz o valor.
        exercicio,
        cnpjRaiz: raiz,
        obs: str(l._motivo) || "derivado de nexo_links (empenho-contrato)",
      }),
    );
  }

  // ── (C) socio-doador + empresa-doador + RANKING (doador↔fornecedor) ─────────
  for (const [raiz, f] of fornecedores) {
    const vistos = new Set<DoacaoCtx>();
    const matches: { doacao: DoacaoCtx; confianca: Confianca; via: "empresa" | "socio"; quem: string }[] = [];

    // (C1) A propria empresa doou? hash(CNPJ) == docHash → empresa-doador.
    const hashCnpj = hashDoc(f.cnpj).trim();
    if (hashCnpj) {
      for (const d of doacoesPorHash.get(hashCnpj) ?? []) {
        if (vistos.has(d)) continue;
        vistos.add(d);
        matches.push({ doacao: d, confianca: "media", via: "empresa", quem: f.nome || f.cnpj });
      }
    }

    // (C2) Algum socio doou? cpfHash==docHash → media; chaveFraca → fraca.
    const info = sociosPorRaiz.get(raiz);
    for (const p of info?.socios ?? []) {
      const hash = p.cpfHash.trim();
      if (hash) {
        for (const d of doacoesPorHash.get(hash) ?? []) {
          if (vistos.has(d)) continue;
          vistos.add(d);
          matches.push({ doacao: d, confianca: "media", via: "socio", quem: p.nome || p.cpfMasc || "socio" });
        }
      }
      const cf = p.chaveFraca.trim();
      if (cf) {
        for (const d of doacoesPorChaveFraca.get(cf) ?? []) {
          if (vistos.has(d)) continue;
          vistos.add(d);
          matches.push({ doacao: d, confianca: "fraca", via: "socio", quem: p.nome || p.cpfMasc || "socio" });
        }
      }
    }

    if (matches.length === 0) continue;

    // Arestas de cruzamento (uma por doacao casada, ate um teto).
    for (const m of matches.slice(0, 8)) {
      const d = m.doacao;
      const tipo = m.via === "empresa" ? "empresa-doador" : "socio-doador";
      // empresa-doador: doacao de PJ so e licita <=2014 (ADI 4650). Acima disso,
      // ou o dado e de outra natureza, ou ha algo a apurar — rotular sempre.
      const obsPj =
        tipo === "empresa-doador" && d.ano > ANO_LIMITE_PJ
          ? ` ATENCAO: doacao de PJ e VEDADA desde 2015 (ADI 4650); doacao de ${d.ano} ` +
            `por PJ e anomala — verificar a natureza do registro.`
          : "";
      const confEfetiva: Confianca =
        // vinculo so-probabilistico (fraca) rebaixa a 'informativo'.
        m.confianca === "fraca" ? "informativo" : m.confianca;
      cruzamentos.push(
        montarCruzamento({
          tipo,
          ladoA: { kind: "empresa", valor: raiz, rotulo: f.nome || f.cnpj, docMasc: mascararDoc(f.cnpj) },
          ladoB: {
            kind: "doador",
            valor: d.docHash,
            rotulo: m.via === "empresa" ? (f.nome || f.cnpj) : m.quem,
            docMasc: d.docMasc || undefined,
          },
          confianca: confEfetiva,
          baseConfianca: [
            m.confianca === "fraca" ? "nome+cpf6" : "hash-documento",
            ...(d.candidato ? [`candidato:${d.candidato}`] : []),
          ],
          valorAncora: Math.min(d.valor, f.valorEmpenhado),
          exercicio,
          cnpjRaiz: raiz,
          obs:
            `${m.via === "empresa" ? "A empresa fornecedora" : `O socio ${m.quem}`} ` +
            `consta como doador (${d.candidato || "candidato"}, ${d.ano}) — DOACAO E ` +
            `ATO LICITO; potencial conflito A APURAR.` +
            (m.confianca === "fraca"
              ? ` Vinculo PROBABILISTICO (nome+6 digitos do CPF) — confirmar.`
              : "") +
            obsPj,
        }),
      );
    }

    // Doc de RANKING (1 por fornecedor com vinculo).
    const totalDoado = matches.reduce((s, m) => s + (m.doacao.valor || 0), 0);
    const totalEmpenhado = f.valorEmpenhado;
    const soFraca = matches.every((m) => m.confianca === "fraca");
    const politicos = Array.from(
      new Set(matches.map((m) => m.doacao.candidato).filter(Boolean)),
    ).slice(0, MAX_POLITICOS);
    const baseConfianca = Array.from(
      new Set(matches.map((m) => (m.confianca === "fraca" ? "nome+cpf6" : "hash-documento"))),
    );
    ranking.push({
      id: `vinc_${exercicio}_${raiz}`,
      doc: {
        _exercicio: exercicio,
        _cnpjRaiz: raiz,
        kind: "empresa",
        rotulo: f.nome || f.cnpj,
        docMasc: mascararDoc(f.cnpj),
        cnpj: f.cnpj,
        totalDoado,
        totalEmpenhado,
        // potencial = min(doado, empenhado): aproxima "quanto do dinheiro publico
        // pode ter ido a quem financiou a campanha". Indicio a apurar.
        potencial: Math.min(totalDoado, totalEmpenhado),
        politicos,
        // Teto: vinculo so-probabilistico rebaixa a 'informativo'.
        classificacaoMax: soFraca ? "informativo" : "atencao",
        baseConfianca,
        _fonte: "cruzamentos",
        _versaoEsquema: VERSAO_ESQUEMA,
        geradoEm: admin.firestore.FieldValue.serverTimestamp(),
      },
    });
  }

  return { cruzamentos, ranking };
}

// ── Persistencia (upsert em lotes; ranking com purga por exercicio) ──────────

async function persistirCruzamentos(itens: Cruzamento[]): Promise<number> {
  if (itens.length === 0) return 0;
  let batch = db.batch();
  let n = 0;
  for (const it of itens) {
    batch.set(db.collection(COL_CRUZAMENTOS).doc(it.id), it.doc, { merge: true });
    n++;
    if (n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
  return n;
}

/**
 * Grava o ranking de UM exercicio e PURGA os docs daquele exercicio que nao
 * reapareceram (snapshot consistente: um fornecedor que deixou de casar como
 * doador some do ranking, nao fica fantasma). Limita a MAX_RANKING por potencial.
 */
async function persistirRanking(
  exercicio: number,
  itens: { id: string; doc: Record<string, unknown> }[],
): Promise<number> {
  const ordenados = itens
    .slice()
    .sort(
      (a, b) =>
        (Number(b.doc.potencial) || 0) - (Number(a.doc.potencial) || 0) ||
        (Number(b.doc.totalEmpenhado) || 0) - (Number(a.doc.totalEmpenhado) || 0),
    )
    .slice(0, MAX_RANKING);
  const idsNovos = new Set(ordenados.map((i) => i.id));

  // Purga: ids existentes do exercicio que nao reapareceram.
  const existentes = await db
    .collection(COL_RANKING)
    .where("_exercicio", "==", exercicio)
    .limit(MAX_DOCS)
    .get();
  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (ops > 0) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };
  for (const doc of existentes.docs) {
    if (!idsNovos.has(doc.id)) {
      batch.delete(doc.ref);
      if (++ops % 400 === 0) await flush();
    }
  }
  for (const it of ordenados) {
    batch.set(db.collection(COL_RANKING).doc(it.id), it.doc, { merge: true });
    if (++ops % 400 === 0) await flush();
  }
  await flush();
  return ordenados.length;
}

/** Exercicios cobertos: o corrente e o anterior. */
function exerciciosAlvo(): number[] {
  const atual = new Date().getFullYear();
  return [atual, atual - 1];
}

// ── Cron diario ──────────────────────────────────────────────────────────────

export const onNexoCruzamentos = onSchedule(
  {
    // 08h45 BRT — DEPOIS de linkage (07h15), perfil (07h45), socios (08h15) e
    // score (08h30), para materializar sobre o grafo/QSA frescos do dia.
    schedule: "45 8 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
    // Nunca duas execucoes concorrentes (retry atrasado nao reconstroi em paralelo).
    maxInstances: 1,
    // Retry idempotente: docId determinISTICO + merge; reexecutar SOBRESCREVE.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    const anos = exerciciosAlvo();

    // Doacoes (ano-agnosticas) e socios (QSA) sao lidos UMA vez (sem _exercicio).
    let doacoes: DoacaoCtx[] = [];
    let sociosPorRaiz = new Map<
      string,
      { cnpj: string; razaoSocial: string; socios: SocioPessoa[] }
    >();
    try {
      doacoes = doacoesDeDocs(await lerDoacoes());
    } catch (err) {
      logger.warn("NEXO Cruzamentos — doacoes indisponiveis; seguindo sem elas", err);
    }
    try {
      sociosPorRaiz = sociosDeDocs(await lerSocios());
    } catch (err) {
      logger.warn("NEXO Cruzamentos — socios indisponiveis; seguindo sem eles", err);
    }

    let totalCruzamentos = 0;
    let totalRanking = 0;
    let falhas = 0;
    let ultimoErro: string | null = null;
    const porExercicio: Record<string, { cruzamentos: number; ranking: number }> = {};

    for (const ano of anos) {
      try {
        const { cruzamentos, ranking } = await construirExercicio(
          ano,
          doacoes,
          sociosPorRaiz,
        );
        const nC = await persistirCruzamentos(cruzamentos);
        const nR = await persistirRanking(ano, ranking);
        totalCruzamentos += nC;
        totalRanking += nR;
        porExercicio[String(ano)] = { cruzamentos: nC, ranking: nR };
        logger.info(
          `NEXO Cruzamentos — ${ano}: ${nC} arestas, ${nR} itens de ranking`,
        );
      } catch (err) {
        falhas++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.error(`NEXO Cruzamentos — falha no exercicio ${ano}`, err);
      }
    }

    const sucesso = falhas < anos.length;
    // Degradado honesto: sem doacoes, o braco doador↔contrato fica inativo (nao e
    // ausencia de vinculo — e a base de doacoes que nao foi carregada).
    const degradado = falhas > 0 || doacoes.length === 0;

    await gravarSyncState({
      syncId: "cruzamentos",
      fonte: "cruzamentos",
      colecao: COL_CRUZAMENTOS,
      cadencia: "diario",
      sucesso,
      degradado,
      erro: falhas > 0 ? ultimoErro : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        exerciciosTentados: anos.length,
        exerciciosComFalha: falhas,
        doacoesLidas: doacoes.length,
        sociosFornecedores: sociosPorRaiz.size,
        cruzamentos: totalCruzamentos,
        ranking: totalRanking,
        porExercicio,
      },
    });

    logger.info(
      `NEXO Cruzamentos — concluido: ${totalCruzamentos} arestas, ` +
        `${totalRanking} itens de ranking, ${falhas} falhas` +
        (doacoes.length === 0 ? " [SEM DOACOES — braco doador inativo]" : ""),
    );
  },
);
