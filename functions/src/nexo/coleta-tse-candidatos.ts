/**
 * CANDIDATOS DO TSE (consulta_cand) — o CPF do candidato como chave de JOIN.
 *
 * POR QUÊ: hoje a ficha de pessoa cruza candidato↔NEXO por NOME, e homônimo é
 * o risco nº 1 do cruzamento (docs/nexo-perfilamento-auditoria.md, item 3). O
 * `consulta_cand` do TSE publica o CPF COMPLETO do candidato
 * (`NR_CPF_CANDIDATO`) — dado tornado público pelo próprio TSE. Com ele o join
 * vira EXATO por `hashDoc`: candidato↔fornecedor-PF, candidato↔sócio (via
 * `cpf6`/`chaveFraca`), candidato↔doador, candidato↔beneficiário de diária —
 * o nome deixa de ser a chave primária.
 *
 * ── INVARIANTES LGPD (as MESMAS de `coleta-tse-doacoes.ts`) ──────────────────
 *   • NUNCA persiste CPF nem título de eleitor CRUS. Grava apenas:
 *       `cpfHash`     = hashDoc(cpf)      → junção irreversível;
 *       `cpfMasc`     = mascararDoc(cpf)  → exibição (***.XXX.XXX-**);
 *       `cpf6`        = cpf6De(cpf)       → miolo de 6 dígitos (padrão do
 *                                           projeto; casa com o sócio da RFB);
 *       `nrTituloHash`= hashDoc(título)   → junção com a base estática de
 *                                           eleições (que resolve identidade
 *                                           intra-TSE pelo título).
 *   • `chaveFraca` = hashDoc(normNome(nome)+"|"+cpf6) — indício a apurar,
 *     nunca identificação forte nem acusação (mesmo enquadramento do doador).
 *   • Candidatura é ato público por definição; ainda assim NADA aqui afirma
 *     irregularidade — a coleção é insumo de CRUZAMENTO, não de acusação.
 *
 * ── DE ONDE VEM ──────────────────────────────────────────────────────────────
 * https://cdn.tse.jus.br/estatistica/sead/odsele/consulta_cand/
 *   consulta_cand_{ano}.zip  (Brasil, ~60–120 MB)
 * Dentro: `consulta_cand_{ano}_SP.csv`. Diferente da prestação de contas, o
 * consulta_cand FOI repadronizado pelo TSE: headers MODERNOS
 * (SQ_CANDIDATO/NR_CPF_CANDIDATO/…) em TODOS os anos, latin-1, `;`, aspas.
 * Reusa o download por HTTP Range de `coleta-tse-doacoes.ts` — baixa só a
 * entrada SP, nunca o ZIP inteiro.
 *
 * ── RECORTE E DEDUP ──────────────────────────────────────────────────────────
 * Filtra `SG_UE = 66818` (Marília). Um candidato a prefeito pode ter DUAS
 * linhas no mesmo ano (1º e 2º turno); dedupe por `SQ_CANDIDATO` preferindo o
 * turno MAIOR (a situação `DS_SIT_TOT_TURNO` final é a que vale).
 *
 * ── PERSISTÊNCIA ─────────────────────────────────────────────────────────────
 * `nexo_candidatos_tse`, 1 doc por SQ_CANDIDATO por ano, docId determinístico
 * `{ano}_{sq}` — idempotente (re-rodar SOBRESCREVE, nunca duplica). Batches de
 * 400 (limite do Firestore é 500).
 *
 * ── AUTH ─────────────────────────────────────────────────────────────────────
 * HTTP admin com header `x-backfill-secret` = DIARIO_BACKFILL_SECRET (mesmo
 * segredo/header de `onNexoBackfillHttp` em `coleta.ts` — não cria segredo
 * novo). UM ano por invocação (`?ano=2024`): mantém cada execução pequena e o
 * erro de um ano não engole os outros.
 */
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import { hashDoc, mascararDoc } from "./pii";
import { chaveFraca, cpf6De, normNome } from "./chaves";
import {
  baixarEntradaZipPorRange,
  criarResolvedorColunas,
  limparTse,
  linhasLatin1,
  parseLinhaCsv,
} from "./coleta-tse-doacoes";

// ── Constantes da fonte ──────────────────────────────────────────────────────

/** Base do CDN do TSE onde ficam os ZIP de consulta de candidatos. */
const TSE_CONSULTA_CAND_BASE =
  "https://cdn.tse.jus.br/estatistica/sead/odsele/consulta_cand";

/** UF do recorte (a entrada dentro do ZIP é por UF). */
const UF_ALVO = "SP";

/** Código TSE da unidade eleitoral de Marília-SP (coluna SG_UE). */
const UE_ALVO = "66818";

/** Faixa de anos aceita (sanidade do parâmetro). */
const ANO_MIN = 2002;
const ANO_MAX = 2100;

/** Tamanho do lote de escrita (pedido do plano: 400; limite Firestore 500). */
const BATCH_SIZE = 400;

/** Mesmo segredo de backfill já provisionado no projeto (não cria outro). */
const BACKFILL_SECRET = defineSecret("DIARIO_BACKFILL_SECRET");

function urlZipConsultaCand(ano: number): string {
  return `${TSE_CONSULTA_CAND_BASE}/consulta_cand_${ano}.zip`;
}

/** Entrada alvo dentro do ZIP (`.txt` como fallback defensivo). */
function padroesEntradaConsultaCand(ano: number, uf: string): RegExp[] {
  const u = uf.toUpperCase();
  return [new RegExp(`^consulta_cand_${ano}_${u}\\.(csv|txt)$`, "i")];
}

/** Só os dígitos (mesmo padrão do resto do módulo nexo). */
function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

// ── Extração ─────────────────────────────────────────────────────────────────

interface CandidatoTse {
  /** SQ_CANDIDATO — chave natural do TSE dentro do ano. */
  sq: string;
  /** Ano da eleição (exercício). */
  ano: number;
  /** Nome civil como publicado (público). */
  nome: string;
  /** Nome normalizado (sem acento, caixa-alta) — chave de casamento por nome. */
  nomeNorm: string;
  /** Nome de urna. */
  urna: string;
  /** Número do candidato na urna. */
  nrCandidato: string;
  partido: string;
  cargo: string;
  /** DS_SIT_TOT_TURNO — situação final (ELEITO/NÃO ELEITO/SUPLENTE/…). */
  situacao: string;
  /** Turno da linha que prevaleceu no dedup (maior turno vence). */
  turno: number;
  /** hashDoc do CPF completo (NUNCA o CPF cru); null se o TSE não publicou. */
  cpfHash: string | null;
  /** Máscara visual do CPF; null se ausente. */
  cpfMasc: string | null;
  /** Miolo de 6 dígitos do CPF (`slice(3,9)`) — casa com o sócio da RFB. */
  cpf6: string;
  /** hashDoc(normNome(nome)+"|"+cpf6) — indício a apurar, nunca acusação. */
  chaveFraca: string;
  /** hashDoc do título de eleitor (NUNCA cru); null se ausente. */
  nrTituloHash: string | null;
}

/**
 * Varre o CSV do consulta_cand (Buffer latin-1) e devolve os candidatos da UE
 * alvo, deduplicados por SQ_CANDIDATO (maior turno vence). Colunas resolvidas
 * pelo header (repadronizado pelo TSE — nomes modernos em todos os anos).
 */
function extrairCandidatos(csv: Buffer, ano: number): CandidatoTse[] {
  const linhas = linhasLatin1(csv);
  const primeira = linhas.next();
  if (primeira.done) return [];

  const headerCells = parseLinhaCsv(primeira.value);
  const col = criarResolvedorColunas(headerCells);

  const iUe = col("SG_UE");
  const iSq = col("SQ_CANDIDATO");
  const iNome = col("NM_CANDIDATO");
  const iUrna = col("NM_URNA_CANDIDATO");
  const iNr = col("NR_CANDIDATO");
  const iPartido = col("SG_PARTIDO");
  const iCargo = col("DS_CARGO");
  const iSit = col("DS_SIT_TOT_TURNO");
  const iCpf = col("NR_CPF_CANDIDATO");
  const iTitulo = col("NR_TITULO_ELEITORAL_CANDIDATO");
  const iAno = col("ANO_ELEICAO", "AA_ELEICAO");
  const iTurno = col("NR_TURNO");

  // Sanidade: sem estas o arquivo não serve pro propósito (join por CPF).
  if (iUe < 0 || iSq < 0 || iNome < 0 || iCpf < 0) {
    throw new Error(
      "Header do consulta_cand sem colunas esperadas " +
        "(SG_UE/SQ_CANDIDATO/NM_CANDIDATO/NR_CPF_CANDIDATO); layout mudou? " +
        `Header visto: ${headerCells.slice(0, 12).join(" | ")}`,
    );
  }

  const porSq = new Map<string, CandidatoTse>();
  for (const linha of linhas) {
    if (!linha) continue;
    // Pré-filtro barato: linha de Marília contém "66818" em algum campo; o
    // resto do estado (centenas de milhares de linhas) nem é parseado.
    // Falso-positivo é eliminado pela checagem de coluna logo abaixo.
    if (!linha.includes(UE_ALVO)) continue;

    const c = parseLinhaCsv(linha);
    if (c.length < headerCells.length - 2) continue; // linha truncada/lixo
    if (soDigitos(c[iUe]) !== UE_ALVO) continue; // UE do CANDIDATO = Marília

    const sq = soDigitos(limparTse(c[iSq]));
    if (!sq) continue; // sem sequencial não há docId estável

    const nome = limparTse(iNome >= 0 ? c[iNome] : "");
    // CPF: só vale com 11 dígitos ("#NULO#"/"-4" viram ""). NUNCA persistido
    // cru — vira hash+máscara+miolo logo abaixo e o valor é descartado.
    const cpfDig = soDigitos(limparTse(c[iCpf]));
    const cpf = cpfDig.length === 11 ? cpfDig : "";
    const tituloDig = soDigitos(limparTse(iTitulo >= 0 ? c[iTitulo] : ""));
    const cpf6 = cpf6De(cpf);
    const turno = Number(soDigitos(iTurno >= 0 ? c[iTurno] : "")) || 1;

    const cand: CandidatoTse = {
      sq,
      ano: iAno >= 0 ? Number(soDigitos(c[iAno])) || ano : ano,
      nome,
      nomeNorm: normNome(nome),
      urna: limparTse(iUrna >= 0 ? c[iUrna] : ""),
      nrCandidato: limparTse(iNr >= 0 ? c[iNr] : ""),
      partido: limparTse(iPartido >= 0 ? c[iPartido] : ""),
      cargo: limparTse(iCargo >= 0 ? c[iCargo] : ""),
      situacao: limparTse(iSit >= 0 ? c[iSit] : ""),
      turno,
      cpfHash: cpf ? hashDoc(cpf) : null,
      cpfMasc: cpf ? mascararDoc(cpf) : null,
      cpf6,
      chaveFraca: chaveFraca(nome, cpf6),
      nrTituloHash: tituloDig ? hashDoc(tituloDig) : null,
    };

    // Dedup por SQ: prefeito no 2º turno tem duas linhas — a situação final é
    // a do turno MAIOR (em empate de turno, a última linha lida vence).
    const atual = porSq.get(sq);
    if (!atual || turno >= atual.turno) porSq.set(sq, cand);
  }
  return [...porSq.values()];
}

// ── Persistência ─────────────────────────────────────────────────────────────

/**
 * Grava em `nexo_candidatos_tse`, docId `{ano}_{sq}` + merge → idempotente.
 * Retorna a contagem gravada.
 */
async function persistirCandidatos(
  candidatos: CandidatoTse[],
  ano: number,
): Promise<number> {
  const colRef = db.collection("nexo_candidatos_tse");
  let gravados = 0;
  for (let i = 0; i < candidatos.length; i += BATCH_SIZE) {
    const fatia = candidatos.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const cand of fatia) {
      batch.set(
        colRef.doc(`${ano}_${cand.sq}`),
        {
          sq: cand.sq,
          ano: cand.ano,
          nome: cand.nome,
          nomeNorm: cand.nomeNorm,
          urna: cand.urna,
          nrCandidato: cand.nrCandidato,
          partido: cand.partido,
          cargo: cand.cargo,
          situacao: cand.situacao,
          turno: cand.turno,
          // Chaves de junção LGPD-safe — NUNCA o CPF/título crus (invariantes
          // no topo). cpfHash casa com `docHash` de empenhos/sanções/diárias;
          // cpf6/chaveFraca casam com o sócio da Receita; nrTituloHash casa com
          // a base estática de eleições.
          cpfHash: cand.cpfHash,
          cpfMasc: cand.cpfMasc,
          cpf6: cand.cpf6,
          chaveFraca: cand.chaveFraca,
          nrTituloHash: cand.nrTituloHash,
          _fonte: "tse-consulta-cand",
          _coletadoEm: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    await batch.commit();
    gravados += fatia.length;
  }
  return gravados;
}

// ── Orquestração de um ano ───────────────────────────────────────────────────

interface ResultadoAno {
  ano: number;
  uf: string;
  ue: string;
  candidatos: number;
  gravados: number;
  tamanhoZip: number;
  csvBytes: number;
}

async function coletarAno(ano: number): Promise<ResultadoAno> {
  const url = urlZipConsultaCand(ano);
  const { entrada, dados: csv, tamanhoZip } = await baixarEntradaZipPorRange(
    url,
    padroesEntradaConsultaCand(ano, UF_ALVO),
  );
  logger.info(
    `NEXO TSE candidatos — ${ano}: entrada '${entrada.nome}' ` +
      `(${(csv.length / 1e6).toFixed(0)} MB inflados)`,
  );
  const candidatos = extrairCandidatos(csv, ano);
  const gravados = await persistirCandidatos(candidatos, ano);
  return {
    ano,
    uf: UF_ALVO,
    ue: UE_ALVO,
    candidatos: candidatos.length,
    gravados,
    tamanhoZip,
    csvBytes: csv.length,
  };
}

// ── HTTP admin de backfill ───────────────────────────────────────────────────

/**
 * `onNexoBackfillTseCandidatos` — backfill HTTP sob demanda (um ano por vez).
 *
 * GET /onNexoBackfillTseCandidatos?ano=2024
 *   Header: x-backfill-secret: <DIARIO_BACKFILL_SECRET>
 *
 * 2 GiB / 1800 s: o CSV de SP infla para ~100-200 MB e a escrita de alguns
 * milhares de docs cabe com folga; `maxInstances: 1` + docId determinístico
 * tornam re-execução idempotente.
 */
export const onNexoBackfillTseCandidatos = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 1800,
    memory: "2GiB",
    maxInstances: 1,
    secrets: [BACKFILL_SECRET],
    invoker: "public",
  },
  async (req, res) => {
    const provided = String(req.headers["x-backfill-secret"] ?? "");
    const expected = BACKFILL_SECRET.value();
    if (!expected || provided !== expected) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const ano = Number(String(req.query.ano ?? "").trim());
    if (!Number.isInteger(ano) || ano < ANO_MIN || ano > ANO_MAX) {
      res.status(400).json({
        error:
          `Parâmetro 'ano' obrigatório (um ano por invocação, ex.: ?ano=2024; ` +
          `faixa ${ANO_MIN}-${ANO_MAX}).`,
      });
      return;
    }

    logger.info("NEXO TSE candidatos — backfill iniciado", { ano });
    const inicio = Date.now();
    try {
      const r = await coletarAno(ano);
      logger.info(
        `NEXO TSE candidatos — ${ano}: ${r.candidatos} candidatos de Marília, ` +
          `${r.gravados} gravados (ZIP ${(r.tamanhoZip / 1e6).toFixed(0)} MB)`,
      );
      await gravarSyncState({
        syncId: "tse_candidatos",
        fonte: "tse",
        colecao: "nexo_candidatos_tse",
        cadencia: "diario", // disparo manual; cadência informativa p/ o painel
        sucesso: true,
        erro: null,
        duracaoMs: Date.now() - inicio,
        extra: { ano, candidatos: r.candidatos, gravados: r.gravados },
      });
      res.status(200).json({ ok: true, ...r, duracaoMs: Date.now() - inicio });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`NEXO TSE candidatos — falha em ${ano}`, err);
      await gravarSyncState({
        syncId: "tse_candidatos",
        fonte: "tse",
        colecao: "nexo_candidatos_tse",
        cadencia: "diario",
        sucesso: false,
        erro: `${ano}: ${msg}`,
        duracaoMs: Date.now() - inicio,
        extra: { ano },
      });
      res.status(500).json({ ok: false, ano, erro: msg });
    }
  },
);
