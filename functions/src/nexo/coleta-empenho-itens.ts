/**
 * Backfill de ITENS DE EMPENHO — `onNexoBackfillEmpenhoItensHttp`
 * (módulo `empenho_sintetico` / `itensempenho` da API SMARAPD).
 *
 * Coleta o dump FLAT de itens de empenho de um exercício e persiste em
 * `nexo_empenho_itens` — a granularidade mais fina do gasto (descrição,
 * quantidade, valor unitário, valor total por item).
 *
 * ── PARTICULARIDADE VALIDADA (Fase 0, 2026) ─────────────────────────────────
 * Sem `FiltroRedirecionaVisao`, o módulo `itensempenho` devolve o ANO INTEIRO
 * (2026 = 936.945 itens / 1.874 páginas a 500/pg). A dump flat NÃO traz campo
 * de vínculo com o empenho pai (sem fornecedor/nº empenho/CNPJ) — serve para
 * ANÁLISE DE ITEM (série de preço por descrição, Benford, sobrepreço unitário,
 * opacidade). O raio-x de UM empenho usa o drill-down on-demand (outra rota).
 * Ver docs/spec-empenho-itens.md §2.4/§4.1.
 *
 * Self-contained: o projeto `functions/` não importa de `src/`. Reusa
 * `gravarSyncState` do próprio `functions/`.
 *
 * Disparo: GET /onNexoBackfillEmpenhoItensHttp?anos=2026
 *   Header: x-backfill-secret: <SEGREDO>   (process.env.DIARIO_BACKFILL_SECRET)
 */
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { createHash } from "crypto";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

const SMARAPD_BASE =
  "https://transparencia.marilia.sp.gov.br/paiportalserver";
const SMARAPD_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://transparencia.marilia.sp.gov.br/",
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
};

const COLECAO = "nexo_empenho_itens";
const FONTE = "empenho_itens";
/** Páginas máx por exercício a 500/pg (2026 = 1.874; folga p/ crescimento). */
const MAX_PAG = 2400;
/** Atraso entre páginas — pacote p/ não derrubar o portal WAF. */
const DELAY_MS = 160;
/** 3h de timeout para a varredura de ~1.874 páginas/ano. */
const TIMEOUT_S = 3600 * 3;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Converte valor BR (`1.234,56`) ou numérico para number; 0 em falha. */
function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const s = v.includes(",") ? v.replace(/\./g, "").replace(",", ".") : v;
    const n = Number(s.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Descrição normalizada: minúscula, sem acento, espaços colapsados. */
function normalizarDescricao(v: unknown): string {
  const s = (v == null ? "" : String(v)).toLowerCase();
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Hash do conteúdo (chaves canonicalizadas) — fallback de dedup sem GUID. */
function hashRegistro(rec: Record<string, unknown>): string {
  return createHash("sha1")
    .update(JSON.stringify(rec, Object.keys(rec).sort()))
    .digest("hex")
    .slice(0, 16);
}

// ── Fetch paginado ───────────────────────────────────────────────────────────

interface PaginaItens {
  QuantidadePaginas: number;
  Valores: Record<string, unknown>[];
}

async function paginaItens(exercicio: number, pagina: number): Promise<PaginaItens> {
  const body = {
    ChaveModulo: "empenho_sintetico",
    NomeVisao: "itensempenho",
    Exercicio: exercicio,
    Periodicidade: "",
    Periodo: null,
    Filtros: [],
    Ordenacao: [],
    Pagina: pagina,
    QuantidadeRegistros: 500,
    FiltroRedirecionaVisao: { Campo: null, Valor: null, TipoValor: null },
    UrlExportacao: "",
  };
  const res = await fetch(`${SMARAPD_BASE}/modulovisao/filter`, {
    method: "POST",
    headers: SMARAPD_HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`SMARAPD itensempenho HTTP ${res.status}`);
  return (await res.json()) as PaginaItens;
}

/**
 * Varre TODAS as páginas do exercício. Retorna registros crus + flags de
 * cobertura (parcial/truncado). Comportamento idêntico ao coletor flat do
 * `coleta.ts`.
 */
async function coletarItens(
  exercicio: number,
): Promise<{ registros: Record<string, unknown>[]; parcial: boolean; truncado: boolean }> {
  const out: Record<string, unknown>[] = [];
  const primeira = await paginaItens(exercicio, 1);
  out.push(...(primeira.Valores ?? []));
  const paginasFonte = primeira.QuantidadePaginas ?? 1;
  const total = Math.min(paginasFonte, MAX_PAG);
  const truncado = paginasFonte > MAX_PAG;
  if (truncado) {
    logger.warn(
      `NEXO ${FONTE}/${exercicio}: TRUNCADO no cap ${MAX_PAG} páginas ` +
        `(fonte reportou ${paginasFonte})`,
    );
  }
  let parcial = false;
  for (let p = 2; p <= total; p++) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    try {
      const resp = await paginaItens(exercicio, p);
      out.push(...(resp.Valores ?? []));
    } catch (err) {
      parcial = true;
      logger.warn(
        `NEXO ${FONTE}/${exercicio}: falha na página ${p}/${total}, ` +
          `coleta parcial com ${out.length} registros. ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }
  }
  return { registros: out, parcial, truncado };
}

// ── Persistência ─────────────────────────────────────────────────────────────

/** Item normalizado persistido em `nexo_empenho_itens`. */
interface ItemEmpenho {
  id: string;
  doc: Record<string, unknown>;
}

/** Mapeia um registro cru do itensempenho para o item normalizado. */
function normalizarItem(
  reg: Record<string, unknown>,
  exercicio: number,
): ItemEmpenho {
  // Chave natural estável: GUID `Id` (o `ID` sequencial é reemissível).
  const guid = String(reg.Id ?? "");
  const base = guid || hashRegistro(reg);
  const id = `${exercicio}-${base}`.replace(/[^\w-]/g, "_");
  return {
    id,
    doc: {
      Descricao: reg.Descricao ?? "",
      Quantidade: toNum(reg.Quantidade),
      ValorUnitario: toNum(reg.ValorUnitario),
      ValorTotal: toNum(reg.ValorTotal),
      ID: reg.ID ?? null,
      Id: guid || null,
      _descricaoNormal: normalizarDescricao(reg.Descricao),
      _exercicio: exercicio,
      _fonte: FONTE,
      _coletadoEm: admin.firestore.FieldValue.serverTimestamp(),
    },
  };
}

/** Persiste itens em `nexo_empenho_itens`, em lotes de 400 (merge/adicional). */
async function persistirItens(
  exercicio: number,
  registros: Record<string, unknown>[],
): Promise<{ count: number; ids: Set<string> }> {
  let batch = db.batch();
  const ids = new Set<string>();
  let n = 0;
  for (const reg of registros) {
    const item = normalizarItem(reg, exercicio);
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    batch.set(db.collection(COLECAO).doc(item.id), item.doc, { merge: true });
    n++;
    if (n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
  return { count: n, ids };
}

/** Remove do exercício/fonte os itens ausentes do snapshot atual (run íntegra). */
async function purgarObsoletos(
  exercicio: number,
  idsAtuais: Set<string>,
): Promise<number> {
  const snap = await db
    .collection(COLECAO)
    .where("_exercicio", "==", exercicio)
    .where("_fonte", "==", FONTE)
    .get();
  let batch = db.batch();
  let removidos = 0;
  for (const doc of snap.docs) {
    if (idsAtuais.has(doc.id)) continue;
    batch.delete(doc.ref);
    removidos++;
    if (removidos % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (removidos % 400 !== 0) await batch.commit();
  return removidos;
}

// ── Endpoint ─────────────────────────────────────────────────────────────────

export const onNexoBackfillEmpenhoItensHttp = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: TIMEOUT_S,
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

    // Exercícios alvo: csv (ex.: "anos=2025,2026") OU "anos=<ano-atual>".
    let anosParam = String(req.query.anos ?? "");
    if (!anosParam.trim()) anosParam = String(new Date().getFullYear());
    const anos = [
      ...new Set(
        anosParam
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((s) => Number(s))
          .filter((n) => Number.isInteger(n) && n >= 2013 && n <= 2100),
      ),
    ];
    if (anos.length === 0) {
      res.status(400).json({
        error: "Parâmetro 'anos' inválido (csv, faixa 2013-2100).",
      });
      return;
    }

    logger.info(`NEXO ${FONTE} — backfill iniciado`, { anos });

    const resultados: {
      exercicio: number;
      registros: number;
      persistidos: number;
      removidos: number;
      parcial: boolean;
      truncado: boolean;
      erro: string | null;
    }[] = [];

    for (const ano of anos) {
      const inicio = Date.now();
      const base = {
        exercicio: ano,
        registros: 0,
        persistidos: 0,
        removidos: 0,
        parcial: false,
        truncado: false,
        erro: null as string | null,
      };
      try {
        const { registros, parcial, truncado } = await coletarItens(ano);
        base.registros = registros.length;
        base.parcial = parcial;
        base.truncado = truncado;

        if (parcial) {
          // Coleta PARCIAL: persiste (merge/adicional) o que veio, NÃO purga, e
          // sinaliza degradado no sync state (próxima execução recoleta tudo).
          if (registros.length > 0) {
            base.persistidos = (await persistirItens(ano, registros)).count;
          }
        } else {
          const { count, ids } = await persistirItens(ano, registros);
          base.persistidos = count;
          base.removidos = await purgarObsoletos(ano, ids);
        }

        await gravarSyncState({
          syncId: `${FONTE}-${ano}`,
          fonte: FONTE,
          colecao: COLECAO,
          cadencia: "diario",
          sucesso: true,
          degradado: parcial || truncado,
          truncado,
          erro: null,
          duracaoMs: Date.now() - inicio,
          extra: {
            exercicio: ano,
            itens: registros.length,
            paginas: Math.ceil(registros.length / 500),
            parcial,
          },
        });
        logger.info(
          `NEXO ${FONTE}/${ano}: ${registros.length} itens, ` +
            `${base.persistidos} persistidos, ${base.removidos} obsoletos` +
            (parcial ? " [PARCIAL]" : "") + (truncado ? " [TRUNCADO]" : ""),
        );
      } catch (err) {
        base.erro = err instanceof Error ? err.message : String(err);
        await gravarSyncState({
          syncId: `${FONTE}-${ano}`,
          fonte: FONTE,
          colecao: COLECAO,
          cadencia: "diario",
          sucesso: false,
          erro: base.erro,
          duracaoMs: Date.now() - inicio,
          extra: { exercicio: ano },
        });
        logger.error(`NEXO ${FONTE}/${ano} falhou`, err);
      }
      resultados.push(base);
    }

    res.status(200).json({
      ok: true,
      colecao: COLECAO,
      itens: resultados.reduce((s, r) => s + r.registros, 0),
      resultados,
    });
  },
);