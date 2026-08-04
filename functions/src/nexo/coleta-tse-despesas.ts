/**
 * FORNECEDORES DE CAMPANHA — despesas contratadas por candidatos (TSE).
 *
 * Cruza quem PRESTOU SERVIÇO a campanhas eleitorais de SP com os fornecedores
 * da Prefeitura: o elo é o CNPJ (`_cnpj`, mesmo campo dos empenhos). Spec em
 * docs/spec-fornecedores-campanha.md.
 *
 * ── ENQUADRAMENTO (mesmo das doações — LEIA) ─────────────────────────────────
 * Prestar serviço a campanha é ATO LÍCITO E PÚBLICO (Lei 9.504/97; o TSE
 * publica para dar transparência). Coincidir como fornecedor de campanha E da
 * Prefeitura NÃO é ilícito por si — é VÍNCULO A APURAR, classificação máxima
 * 'atencao', nunca 'critico'.
 *
 * ── FONTE ────────────────────────────────────────────────────────────────────
 * O MESMO ZIP das doações (prestacao_de_contas_eleitorais_candidatos_AAAA.zip)
 * contém `despesas_contratadas_candidatos_AAAA_SP.csv`. Baixamos só essa
 * entrada via range-GET do central directory (helpers de coleta-tse-doacoes).
 *
 * ── RECORTE v1 ───────────────────────────────────────────────────────────────
 * Só fornecedor PJ (CNPJ 14 dígitos — dado público; PF exigiria docHash, fase
 * 2). SP inteira, anos de layout moderno (2020/2024). AGREGADO por
 * fornecedor × candidato × ano × município (docId determinístico, idempotente).
 */
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { createHash } from "node:crypto";
import { db, admin } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import { hashDoc, mascararDoc } from "./pii";
import {
  baixarEntradaZipPorRange,
  parseLinhaCsv,
  linhasLatin1,
  limparTse,
  criarResolvedorColunas,
} from "./coleta-tse-doacoes";

const COLECAO = "nexo_fornecedores_campanha";

function urlZip(ano: number): string {
  return (
    "https://cdn.tse.jus.br/estatistica/sead/odsele/prestacao_contas/" +
    `prestacao_de_contas_eleitorais_candidatos_${ano}.zip`
  );
}

function parseValorBr(v: string): number {
  const s = (v ?? "").trim();
  if (!s) return 0;
  const num = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(num) ? num : 0;
}

function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

interface AgregadoFornecedor {
  /** CNPJ cru (14 díg.) quando PJ; "" quando PF (LGPD — só hash/máscara). */
  cnpj: string;
  /** hashDoc do documento — elo de linkage p/ PF e PJ (casa com docHash do grafo). */
  docHash: string;
  /** Documento mascarado p/ exibição (ex.: ***.456.789-**). */
  docMasc: string;
  /** 'PJ' | 'PF'. */
  tipoFornecedor: string;
  nomeFornecedor: string;
  candidato: string;
  partido: string;
  cargo: string;
  municipio: string;
  ano: number;
  valorTotal: number;
  nDespesas: number;
}

interface ResultadoAnoDespesas {
  ano: number;
  linhasCsv: number;
  agregados: number;
  persistidos: number;
  erro: string | null;
}

/**
 * Coleta e agrega as despesas contratadas de um ano (SP). Devolve o mapa
 * agregado por fornecedor×candidato×ano×município.
 */
async function coletarDespesasAno(ano: number): Promise<{
  agregados: Map<string, AgregadoFornecedor>;
  linhasCsv: number;
}> {
  const { dados } = await baixarEntradaZipPorRange(urlZip(ano), [
    new RegExp(`^despesas_contratadas_candidatos_${ano}_SP\\.csv$`, "i"),
  ]);

  const agregados = new Map<string, AgregadoFornecedor>();
  let header: ((...nomes: string[]) => number) | null = null;
  let iDoc = -1;
  let iNome = -1;
  let iCand = -1;
  let iPart = -1;
  let iCargo = -1;
  let iUe = -1;
  let iValor = -1;
  let linhasCsv = 0;

  for (const linha of linhasLatin1(dados)) {
    if (!linha.trim()) continue;
    const cells = parseLinhaCsv(linha);
    if (!header) {
      header = criarResolvedorColunas(cells);
      iDoc = header("NR_CPF_CNPJ_FORNECEDOR", "NR_CNPJ_CPF_FORNECEDOR");
      iNome = header("NM_FORNECEDOR", "NM_FORNECEDOR_RFB");
      iCand = header("NM_CANDIDATO");
      iPart = header("SG_PARTIDO");
      iCargo = header("DS_CARGO");
      iUe = header("NM_UE");
      iValor = header("VR_DESPESA_CONTRATADA", "VR_DESPESA");
      if (iDoc < 0 || iCand < 0 || iValor < 0) {
        throw new Error(
          `Header do CSV de despesas ${ano} sem colunas essenciais ` +
            `(doc=${iDoc}, candidato=${iCand}, valor=${iValor}).`,
        );
      }
      continue;
    }
    linhasCsv++;
    const doc = soDigitos(cells[iDoc]);
    // PJ (CNPJ 14 díg. — público, cru) e PF (CPF 11 díg. — SÓ hash+máscara,
    // nunca o CPF cru; mesmo padrão LGPD das doações). Outros tamanhos: lixo.
    const ehPJ = doc.length === 14;
    const ehPF = doc.length === 11;
    if (!ehPJ && !ehPF) continue;
    const valor = parseValorBr(cells[iValor] ?? "");
    if (valor <= 0) continue;
    const candidato = limparTse(cells[iCand]);
    const municipio = iUe >= 0 ? limparTse(cells[iUe]) : "";
    if (!candidato) continue;

    const chave = `${doc}|${candidato}|${ano}|${municipio}`;
    const atual = agregados.get(chave);
    if (atual) {
      atual.valorTotal += valor;
      atual.nDespesas++;
    } else {
      agregados.set(chave, {
        cnpj: ehPJ ? doc : "",
        docHash: hashDoc(doc),
        docMasc: mascararDoc(doc),
        tipoFornecedor: ehPJ ? "PJ" : "PF",
        nomeFornecedor: iNome >= 0 ? limparTse(cells[iNome]) : "",
        candidato,
        partido: iPart >= 0 ? limparTse(cells[iPart]) : "",
        cargo: iCargo >= 0 ? limparTse(cells[iCargo]) : "",
        municipio,
        ano,
        valorTotal: valor,
        nDespesas: 1,
      });
    }
  }
  return { agregados, linhasCsv };
}

/** Persiste os agregados em lotes de 400, docId determinístico (idempotente). */
async function persistirAgregados(
  agregados: Map<string, AgregadoFornecedor>,
): Promise<number> {
  const now = admin.firestore.FieldValue.serverTimestamp();
  let batch = db.batch();
  let n = 0;
  for (const [chave, a] of agregados) {
    const docId = createHash("sha1").update(chave).digest("hex").slice(0, 24);
    batch.set(
      db.collection(COLECAO).doc(docId),
      {
        ...a,
        _cnpj: a.cnpj,
        _exercicio: a.ano,
        _fonte: "tse_despesas",
        _coletadoEm: now,
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

async function ingerirAnoDespesas(ano: number): Promise<ResultadoAnoDespesas> {
  const inicio = Date.now();
  const base: ResultadoAnoDespesas = {
    ano,
    linhasCsv: 0,
    agregados: 0,
    persistidos: 0,
    erro: null,
  };
  try {
    const { agregados, linhasCsv } = await coletarDespesasAno(ano);
    base.linhasCsv = linhasCsv;
    base.agregados = agregados.size;
    base.persistidos = await persistirAgregados(agregados);
    await gravarSyncState({
      syncId: `tse_despesas-${ano}`,
      fonte: "tse_despesas",
      colecao: COLECAO,
      cadencia: "diario", // disparo manual; cadência informativa p/ o painel
      sucesso: true,
      erro: null,
      duracaoMs: Date.now() - inicio,
      extra: { exercicio: ano, registros: agregados.size, linhasCsv },
    });
    logger.info(
      `NEXO — despesas de campanha ${ano}: ${linhasCsv} linhas CSV → ` +
        `${agregados.size} agregados fornecedor×candidato persistidos.`,
    );
  } catch (err) {
    base.erro = err instanceof Error ? err.message : String(err);
    logger.error(`NEXO — falha nas despesas de campanha ${ano}`, err);
    await gravarSyncState({
      syncId: `tse_despesas-${ano}`,
      fonte: "tse_despesas",
      colecao: COLECAO,
      cadencia: "diario",
      sucesso: false,
      erro: base.erro,
      duracaoMs: Date.now() - inicio,
      extra: { exercicio: ano },
    });
  }
  return base;
}

/**
 * GET /onNexoBackfillTseDespesasHttp?anos=2024,2020
 *   Header: x-backfill-secret: <SEGREDO>
 *
 * Backfill sob demanda dos fornecedores de campanha (sem cron — a prestação de
 * contas só muda quando o TSE republica). Anos aceitos: 2020/2024 (layout
 * moderno; 2016/2012/2022 ficam para a fase 2).
 */
export const onNexoBackfillTseDespesasHttp = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 1800,
    memory: "2GiB",
    maxInstances: 1,
    invoker: "public",
  },
  async (req, res) => {
    const provided = String(req.headers["x-backfill-secret"] ?? "");
    const expected = process.env.DIARIO_BACKFILL_SECRET || "";
    if (!expected || provided !== expected) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const anos = [
      ...new Set(
        String(req.query.anos ?? "2024,2022,2020")
          .split(/[,\s]+/)
          .map((s) => Number(s))
          // Layout moderno repadronizado (2020+). 2016/2012 têm ZIP/entradas
          // próprios do layout antigo — fase futura.
          .filter((n) => n === 2020 || n === 2022 || n === 2024),
      ),
    ];
    if (anos.length === 0) {
      res.status(400).json({ error: "anos aceitos: 2020, 2022, 2024" });
      return;
    }
    const resultados: ResultadoAnoDespesas[] = [];
    for (const ano of anos) resultados.push(await ingerirAnoDespesas(ano));
    res.json({
      ok: resultados.every((r) => !r.erro),
      resultados,
    });
  },
);
