/**
 * Cron de ingestão TCE-SP — DESPESAS POR EMPENHO — `onNexoSyncTceDespesas`.
 *
 * Coleta as despesas (empenhos) de Marília declaradas pela Prefeitura ao
 * Tribunal de Contas do Estado de São Paulo e persiste em DUAS coleções:
 *   - `nexo_tce_despesas` — UM DOCUMENTO POR EMPENHO (resumo), como antes.
 *   - `nexo_tce_despesas_eventos` — UM DOC POR EVENTO (spec §4.4): empenho,
 *     reforço, anulação, liquidação e pagamento com `_evento`/`valorEvento`.
 *
 * Diferente de `coleta-tce.ts` (que AGREGA por fornecedor para o cruzamento de
 * "quem recebe"), aqui a granularidade é o empenho individual — porque esta é a
 * SEGUNDA FONTE OFICIAL do MESMO empenho.
 *
 * Por que importa: a Prefeitura declara o empenho ao TCE-SP E o publica no seu
 * portal próprio (SMARAPD). Ter o mesmo empenho em duas fontes independentes
 * habilita o DETECTOR DE DIVERGÊNCIA SMARAPD×TCE (X2 do plano-mestre): mesmo
 * `nrEmpenho` + mesmo CNPJ, valores diferentes → subnotificação; ou empenho
 * presente num lado só → omissão. Por isso o linkage exige a chave
 * `nrEmpenho + cnpj` NORMALIZADA com zero-pad consistente (o número de empenho
 * e a UG têm formatos diferentes entre as fontes).
 *
 * A coleção de EVENTOS é a única fonte com `Valor Liquidado`/`Valor Pago`
 * EXPLÍCITOS por empenho (2014+ — 2013 retorna vazio, confirmado ao vivo). É a
 * base da liquidação/pagamento reais da série anual e do RAP (spec §4.4/§3.1).
 * O resumo por empenho fica INALTERADO para retrocompat com X2/linkage/perfil.
 *
 * NÃO registra documento no catálogo `nexo_documentos`: empenho declarado ao
 * TCE é DADO (valor/credor/data), não uma peça documental requerível.
 *
 * Cadência: quinzenal (dias 1 e 16, 06h05 BRT). 12 chamadas/ano por exercício
 * (uma por mês); o lado RESUMO reusa o "netting" de eventos de `coleta-tce.ts`
 * (descarta anulação/estorno, mantém só o empenhado); o lado EVENTOS captura
 * tudo. maxInstances:1. Backfill histórico: `onNexoBackfillTceDespesas`.
 *
 * Self-contained: re-implementa o fetch ao TCE-SP (não importa de `src/`).
 * API pública, sem autenticação. Slug do município = `marilia` (sem IBGE).
 * Forma do item (confirmada via WebFetch — array, sem envelope):
 *   { orgao, mes, evento, nr_empenho, id_fornecedor, nm_fornecedor,
 *     dt_emissao_despesa, vl_despesa }
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { createHash } from "crypto";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import { carimbarPrimeiraObservacao } from "./registro";

/** Base da API pública do Portal da Transparência Municipal do TCE-SP. */
const TCE_API = "https://transparencia.tce.sp.gov.br/api/json";
/** Slug de Marília na API do TCE-SP (confirmado via /municipios). */
const TCE_SLUG = "marilia";
const TIMEOUT_MS = 20_000;
const UA = "NEXO/1.0 (monitoramento de transparência pública; +nexo)";
/** Largura do zero-pad da sequência do empenho — chave estável p/ o linkage. */
const EMPENHO_PAD = 10;
/** Primeiro exercício com eventos TCE-SP (2013 retorna vazio — confirmado ao vivo). */
const TCE_ANO_MIN = 2014;

/**
 * Eventos de despesa que a API do TCE-SP expõe por linha (confirmado ao vivo:
 * jan/2014 e dez/2025). `empenho|reforco|anulacao` somam o EMPENHADO líquido
 * (`empenho + reforco − anulacao`); `liquidado|pago` são os valores reais que o
 * SMARAPD não expõe por empenho — base da liquidação/pagamento da série (spec
 * §4.4). Textos da fonte podem variar → `mapEvento` normaliza com fallback null.
 */
export type TipoEventoTce =
  | "empenho"
  | "reforco"
  | "anulacao"
  | "liquidado"
  | "pago";

/** Mapeia o texto do `evento` da fonte para o enum. Fallback null (honestidade). */
export function mapEvento(texto: string): TipoEventoTce | null {
  const t = texto.trim().toLowerCase();
  if (/anula/.test(t)) return "anulacao";
  if (/refor/.test(t)) return "reforco";
  if (/liquid/.test(t)) return "liquidado";
  if (/pag/.test(t)) return "pago";
  if (/empenh/.test(t)) return "empenho";
  return null;
}

/** Uma despesa (empenho) declarada ao TCE-SP, já normalizada para persistir. */
interface DespesaTceEmpenho {
  /** Número do empenho normalizado (sequência zero-padded + exercício). */
  nrEmpenho: string;
  /** Número do empenho como veio do TCE (auditabilidade do mapeamento). */
  nrEmpenhoBruto: string;
  /** Documento do credor, só dígitos (CNPJ 14 / CPF 11). */
  cnpj: string;
  nomeCredor: string;
  valor: number;
  /** Data de emissão (ISO `YYYY-MM-DD` quando parseável, senão o bruto). */
  data: string;
  /** Unidade gestora / órgão. */
  ug: string;
  _exercicio: number;
  _mes: number;
}

/**
 * UM evento de despesa do TCE-SP (spec §4.4) — 1 doc por evento em
 * `nexo_tce_despesas_eventos`. Distinto do resumo por empenho (`nexo_tce_despesas`,
 * que X2/linkage/perfil consomem e fica INALTERADO — decisão de retrocompat da F1).
 */
interface EventoTceDespesa {
  /** Evento normalizado (enum); null quando o texto da fonte não casa (honesto). */
  _evento: TipoEventoTce | null;
  /** Texto cru do evento da fonte (auditabilidade do mapeamento). */
  eventoBruto: string;
  /** Valor do evento (vl_despesa normalizado BR). */
  valorEvento: number;
  /** Número do empenho normalizado (chave estável p/ o linkage). */
  nrEmpenho: string;
  nrEmpenhoBruto: string;
  cnpj: string;
  nomeCredor: string;
  /** Órgão como veio da fonte. */
  orgao: string;
  /** Unidade gestora (mesmo valor de `orgao` — compat com o resumo). */
  ug: string;
  data: string;
  _exercicio: number;
  _mes: number;
}

function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

function pickStr(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return "";
}

/** Converte valor em formato BR (`1.234,56`) ou numérico para number. */
function parseValorBR(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v !== "string") return 0;
  const n = Number(v.replace(/[R$\s.]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/** Converte `DD/MM/YYYY` para `YYYY-MM-DD`; devolve o bruto se não casar. */
function parseDataBR(v: unknown): string {
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

/**
 * O campo `id_fornecedor` vem como `"CNPJ - PESSOA JURÍDICA - 5998...0136"`.
 * Extrai só o documento (dígitos finais). Defensiva — nunca lança.
 */
function extrairDoc(raw: string): string {
  const m = raw.match(/(\d{6,14})\s*$/);
  return m ? soDigitos(m[1]) : soDigitos(raw);
}

/**
 * Normaliza o número do empenho para a CHAVE de linkage SMARAPD×TCE.
 *
 * O TCE devolve `"102-2025"` (sequência-exercício). A sequência é zero-padded
 * para largura fixa e o exercício é anexado, produzindo uma chave que casa com
 * o número de empenho do portal próprio (SMARAPD) independentemente de zeros à
 * esquerda ou da formatação da UG. Forma: `EMP-{seq zero-pad}-{exercicio}`.
 */
function normalizarNrEmpenho(bruto: string, exercicio: number): string {
  const limpo = bruto.trim();
  // Casa a sequência (1º grupo de dígitos) e, se houver, o ano (4 dígitos).
  const m = limpo.match(/(\d+)(?:\D+(\d{4}))?/);
  const seq = m?.[1] ?? soDigitos(limpo) ?? "";
  const ano = m?.[2] ?? String(exercicio);
  const seqPad = (seq || "0").padStart(EMPENHO_PAD, "0");
  return `EMP-${seqPad}-${ano}`;
}

/** Chave determinística do par empenho+credor (também é o ID do doc). */
function chaveEmpenhoCnpj(nrEmpenho: string, cnpj: string): string {
  return `${nrEmpenho}__${cnpj || "sem-doc"}`.replace(/[^\w-]/g, "_");
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json, */*" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`TCE-SP HTTP ${res.status} em ${url}`);
  const txt = await res.text();
  if (!txt.trim()) return [];
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`TCE-SP devolveu resposta não-JSON em ${url}`);
  }
}

/**
 * Coleta as despesas de um exercício, empenho a empenho. Varre os 12 meses em
 * paralelo e tolera a falha de um mês sem derrubar o ciclo.
 *
 * Devolve DOIS lados (spec §4.4):
 *   - `despesas` — resumo por empenho (1 doc por par empenho+credor), usando o
 *     "netting" histórico de `coleta-tce.ts` (descarta anulação/estorno/cancel e
 *     exige o evento "empenhado" — a raiz "empenh" sozinha não basta). Mantido
 *     para retrocompat (X2/linkage/perfil).
 *   - `eventos` — TODOS os eventos da fonte (empenho/reforço/anulação/liquidação/
 *     pagamento), 1 linha por evento, com `_evento`/`valorEvento`. Alimenta a
 *     série anual com liquidação/pagamento reais (2014+).
 */
async function coletarDespesas(exercicio: number): Promise<{
  despesas: DespesaTceEmpenho[];
  eventos: EventoTceDespesa[];
  mesesColetados: number[];
  registrosBrutos: number;
  erro: string | null;
}> {
  const meses = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const despesas: DespesaTceEmpenho[] = [];
  const eventos: EventoTceDespesa[] = [];
  const mesesColetados: number[] = [];
  let registrosBrutos = 0;
  let erro: string | null = null;

  const respostas = await Promise.allSettled(
    meses.map(async (mes) => {
      const url = `${TCE_API}/despesas/${TCE_SLUG}/${exercicio}/${mes}`;
      return { mes, data: await fetchJson(url) };
    }),
  );

  for (const resposta of respostas) {
    if (resposta.status === "rejected") {
      if (!erro) {
        erro =
          resposta.reason instanceof Error
            ? resposta.reason.message
            : "erro desconhecido na coleta TCE-SP despesas";
      }
      continue;
    }
    const { mes, data } = resposta.value;
    const linhas: Record<string, unknown>[] = Array.isArray(data)
      ? (data as Record<string, unknown>[])
      : Array.isArray((data as { despesas?: unknown }).despesas)
        ? (data as { despesas: Record<string, unknown>[] }).despesas
        : [];
    mesesColetados.push(mes);
    registrosBrutos += linhas.length;

    for (const rec of linhas) {
      const nrEmpenhoBruto = pickStr(rec, "nr_empenho", "nro_empenho", "empenho");
      const idRaw = pickStr(rec, "id_fornecedor", "fornecedor_id");
      const nomeCredor = pickStr(
        rec,
        "nm_fornecedor",
        "fornecedor",
        "nome_fornecedor",
      );
      const eventoTexto = pickStr(rec, "evento", "tp_despesa").toLowerCase();
      // Sem número de empenho não há o que cruzar (a chave de linkage exige).
      if (!nrEmpenhoBruto) continue;

      const cnpj = extrairDoc(idRaw);
      const nrEmpenho = normalizarNrEmpenho(nrEmpenhoBruto, exercicio);
      const valor = parseValorBR(pickStr(rec, "vl_despesa", "valor", "vl_empenho"));
      const data = parseDataBR(
        pickStr(rec, "dt_emissao_despesa", "data", "dt_despesa"),
      );
      const ug = pickStr(rec, "orgao", "unidade", "ug");

      // Lado RESUMO (netting, comportamento histórico): só o empenhado entra —
      // anulação, estorno e cancelamento são descartados, senão a 2ª fonte
      // traria ruído contábil e divergiria do portal por motivo legítimo.
      if (eventoTexto) {
        const ehAnulacaoEstornoCancel = /anula|estorno|cancel/.test(eventoTexto);
        if (!ehAnulacaoEstornoCancel && eventoTexto.includes("empenh")) {
          despesas.push({
            nrEmpenho,
            nrEmpenhoBruto,
            cnpj,
            nomeCredor,
            valor,
            data,
            ug,
            _exercicio: exercicio,
            _mes: mes,
          });
        }
      }

      // Lado EVENTOS (spec §4.4): 1 doc por evento, TODO evento entra (inclusive
      // anulação e estorno — o `_hash` idempotente garante re-exec sem duplicar).
      // Texto desconhecido vira `_evento: null` honesto, nunca um evento errado.
      eventos.push({
        _evento: mapEvento(eventoTexto),
        eventoBruto: pickStr(rec, "evento", "tp_despesa"),
        valorEvento: valor,
        nrEmpenho,
        nrEmpenhoBruto,
        cnpj,
        nomeCredor,
        orgao: ug,
        ug,
        data,
        _exercicio: exercicio,
        _mes: mes,
      });
    }
  }

  return { despesas, eventos, mesesColetados, registrosBrutos, erro };
}

/**
 * Persiste as despesas em `nexo_tce_despesas`, em lotes de 400. ID do doc =
 * chave `nrEmpenho+cnpj` normalizada → re-coletar SOBRESCREVE (idempotente).
 * Quando o mesmo par aparece em mais de um registro do mês (parcelas), SOMA o
 * valor para refletir o total empenhado daquele par no exercício.
 */
async function persistirDespesas(
  despesas: DespesaTceEmpenho[],
): Promise<{ count: number; ids: Set<string> }> {
  // Agrega por chave dentro do snapshot (mesmo empenho+credor pode repetir).
  const acc = new Map<string, DespesaTceEmpenho>();
  for (const d of despesas) {
    const id = chaveEmpenhoCnpj(d.nrEmpenho, d.cnpj);
    const atual = acc.get(id);
    if (atual) {
      atual.valor += d.valor;
      if (!atual.nomeCredor && d.nomeCredor) atual.nomeCredor = d.nomeCredor;
      if (!atual.ug && d.ug) atual.ug = d.ug;
    } else {
      acc.set(id, { ...d });
    }
  }

  let batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ids = new Set<string>();
  let n = 0;
  for (const [id, d] of acc) {
    ids.add(id);
    batch.set(
      db.collection("nexo_tce_despesas").doc(id),
      {
        nrEmpenho: d.nrEmpenho,
        nrEmpenhoBruto: d.nrEmpenhoBruto,
        cnpj: d.cnpj,
        nomeCredor: d.nomeCredor,
        valor: d.valor,
        data: d.data,
        ug: d.ug,
        _exercicio: d._exercicio,
        _mes: d._mes,
        // Chave de linkage explícita p/ o detector de divergência SMARAPD×TCE.
        _chaveLinkage: id,
        _fonte: "tce_sp",
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
  return { count: n, ids };
}

/** Remove despesas do exercício ausentes do snapshot íntegro atual. */
async function purgarObsoletas(
  exercicio: number,
  idsAtuais: Set<string>,
): Promise<number> {
  const snap = await db
    .collection("nexo_tce_despesas")
    .where("_exercicio", "==", exercicio)
    .where("_fonte", "==", "tce_sp")
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

/**
 * ID determinístico de um EVENTO TCE-SP — hash do `_hash` (que já combina
 * `_evento`+nrEmpenho+valor+data) + exercício. Re-coletar o MESMO evento
 * SOBRESCREVE (merge), nunca duplica.
 */
function idEvento(e: EventoTceDespesa): string {
  const base = `${e._evento ?? "desconhecido"}|${e.nrEmpenho}|${e.valorEvento}|${e.data}`;
  const hash = createHash("sha1").update(base).digest("hex").slice(0, 16);
  return `${e._exercicio}-${hash}`;
}

/**
 * Persiste os EVENTOS em `nexo_tce_despesas_eventos` (1 doc por evento, spec
 * §4.4), em lotes de 400. ID = `_hash` determinístico → re-coletar é idempotente.
 * Cada doc carrega `_evento`/`valorEvento` + as chaves de empenho/credor/órgão +
 * `_chaveLinkage` (mesma forma do resumo) para o linkage e a série anual.
 */
async function persistirEventos(
  eventos: EventoTceDespesa[],
): Promise<{ count: number; ids: Set<string> }> {
  let batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ids = new Set<string>();
  let n = 0;
  for (const e of eventos) {
    const id = idEvento(e);
    if (ids.has(id)) continue; // linha duplicada no mesmo snapshot
    ids.add(id);
    batch.set(
      db.collection("nexo_tce_despesas_eventos").doc(id),
      {
        _evento: e._evento,
        eventoBruto: e.eventoBruto,
        valorEvento: e.valorEvento,
        nrEmpenho: e.nrEmpenho,
        nrEmpenhoBruto: e.nrEmpenhoBruto,
        cnpj: e.cnpj,
        nomeCredor: e.nomeCredor,
        orgao: e.orgao,
        ug: e.ug,
        data: e.data,
        _exercicio: e._exercicio,
        _mes: e._mes,
        // Chave de linkage explícita no MESMO formato do resumo — o grafo e a
        // série cruzam por `nrEmpenho__cnpj` sem re-normalizar.
        _chaveLinkage: chaveEmpenhoCnpj(e.nrEmpenho, e.cnpj),
        _hash: id,
        _fonte: "tce_sp_evento",
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
  return { count: n, ids };
}

/** Remove eventos do exercício ausentes do snapshot íntegro atual. */
async function purgarEventosObsoletos(
  exercicio: number,
  idsAtuais: Set<string>,
): Promise<number> {
  const snap = await db
    .collection("nexo_tce_despesas_eventos")
    .where("_exercicio", "==", exercicio)
    .where("_fonte", "==", "tce_sp_evento")
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

// ── Cron quinzenal ───────────────────────────────────────────────────────────

export const onNexoSyncTceDespesas = onSchedule(
  {
    // Dias 1 e 16, 06h05 BRT — cadência quinzenal (deslocada de coleta-tce.ts
    // às 05h45 e do SICONFI às 05h05 para não concorrerem).
    schedule: "5 6 1,16 * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    // Hardening (#13): no máximo UMA execução simultânea — evita que um disparo
    // atrasado/retry concorra com a execução em andamento e refaça a coleta.
    maxInstances: 1,
    // Retry idempotente: cada despesa tem doc ID determinístico
    // (`{nrEmpenho}__{cnpj}`) com `merge`, então reexecutar após falha
    // SOBRESCREVE, nunca duplica.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    const anoAtual = new Date().getFullYear();
    const anos = [anoAtual, anoAtual - 1];
    let totalDespesas = 0;
    let totalEventos = 0;
    let totalRemovidas = 0;
    let totalRemovidasEventos = 0;
    let falhas = 0;
    let parcial = false;
    let ultimoErro: string | null = null;

    for (const ano of anos) {
      try {
        const { despesas, eventos, mesesColetados, registrosBrutos, erro } =
          await coletarDespesas(ano);
        // Falha total (nenhum mês coletado) — não persiste/purga este exercício.
        if (mesesColetados.length === 0) {
          falhas++;
          ultimoErro = erro ?? "nenhum mês coletado";
          logger.error(
            `NEXO TCE-despesas — ${ano}: coleta vazia (${ultimoErro})`,
          );
          continue;
        }
        // Coleta PARCIAL (algum mês falhou) — NÃO persiste nem purga. O `valor`
        // do doc é a SOMA das parcelas do par empenho+CNPJ em todos os meses;
        // persistir com meses faltando sobrescreveria um total íntegro anterior
        // por uma soma subestimada e o detector X2 (SMARAPD×TCE) geraria falsa
        // "subnotificação ao TCE" com confiabilidade alta — corrupção que nós
        // mesmos criamos (auditoria 2026-06-09). Vale igualmente para os EVENTOS
        // (somados por tipo na série §4.4): snapshot parcial vira série viciada.
        // Espera a quinzena seguinte.
        if (mesesColetados.length < 12) {
          parcial = true;
          if (erro) ultimoErro = erro;
          logger.warn(
            `NEXO TCE-despesas — ${ano}: coleta PARCIAL ` +
              `(${mesesColetados.length}/12 meses) — nada persistido para não ` +
              `corromper totais agregados`,
          );
          continue;
        }
        const { count, ids } = await persistirDespesas(despesas);
        totalDespesas += count;
        const { count: countEventos, ids: idsEventos } =
          await persistirEventos(eventos);
        totalEventos += countEventos;
        // Coleta íntegra (12 meses) — pode purgar com segurança.
        totalRemovidas += await purgarObsoletas(ano, ids);
        totalRemovidasEventos += await purgarEventosObsoletos(ano, idsEventos);
        logger.info(
          `NEXO TCE-despesas — ${ano}: ${count} empenhos, ` +
            `${countEventos} eventos, 12/12 meses, ${registrosBrutos} registros`,
        );
      } catch (err) {
        falhas++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.error(`NEXO TCE-despesas — falha no exercício ${ano}`, err);
      }
    }

    const sucesso = falhas < anos.length;

    // Ciclo de vida: carimba `_registradoEm` (primeira observação, set-once) em
    // despesas/eventos sem data oficial — "apareceu hoje => registrado hoje".
    const registrados = await carimbarPrimeiraObservacao("nexo_tce_despesas");
    const registradosEventos = await carimbarPrimeiraObservacao(
      "nexo_tce_despesas_eventos",
    );

    await gravarSyncState({
      syncId: "tce_despesas",
      fonte: "tce_sp",
      colecao: "nexo_tce_despesas",
      cadencia: "quinzenal",
      sucesso,
      degradado: falhas > 0 || parcial,
      erro: falhas > 0 || parcial ? ultimoErro : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        exerciciosTentados: anos.length,
        exerciciosComFalha: falhas,
        registros: totalDespesas,
        eventos: totalEventos,
        registrados,
        registradosEventos,
        removidos: totalRemovidas,
        removidosEventos: totalRemovidasEventos,
        parcial,
      },
    });
    logger.info(
      `NEXO TCE-despesas — concluído: ${totalDespesas} empenhos, ` +
        `${totalEventos} eventos, ${totalRemovidas + totalRemovidasEventos} ` +
        `obsoletos removidos, ${falhas} falhas`,
    );
  },
);

// ── Backfill HTTP histórico (spec §4.4 item 4) ────────────────────────────────

/**
 * GET /onNexoBackfillTceDespesas?anos=2014,2015
 *   Header: x-backfill-secret: <SEGREDO>
 *
 * Dispara a coleta TCE-SP de despesas por EVENTO para exercícios históricos
 * (2014+) sob demanda — o cron quinzenal só cobre corrente+anterior. Idêntico ao
 * cron em regras de íntegra (12/12 meses para persistir/purgar); a retomada é
 * implícita: reexecutar após falha SOBRESCREVE (IDs determinísticos + merge).
 */
export const onNexoBackfillTceDespesas = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
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

    const anosParam = String(req.query.anos ?? "");
    const anos = [
      ...new Set(
        anosParam
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((s) => Number(s))
          .filter((n) => Number.isInteger(n) && n >= TCE_ANO_MIN && n <= 2100),
      ),
    ].sort((a, b) => b - a);
    if (anos.length === 0) {
      res.status(400).json({
        error: `Parâmetro 'anos' obrigatório (csv, ex.: anos=2014,2015; faixa ${TCE_ANO_MIN}-2100).`,
      });
      return;
    }

    logger.info("NEXO TCE-despesas — backfill histórico iniciado", { anos });
    const inicio = Date.now();
    const resultados: { ano: number; empenhos: number; eventos: number; erro: string | null }[] = [];

    for (const ano of anos) {
      try {
        const { despesas, eventos, mesesColetados, registrosBrutos, erro } =
          await coletarDespesas(ano);
        if (mesesColetados.length === 0) {
          resultados.push({ ano, empenhos: 0, eventos: 0, erro: erro ?? "coleta vazia" });
          logger.error(`NEXO TCE-despesas — backfill ${ano}: coleta vazia`);
          continue;
        }
        if (mesesColetados.length < 12) {
          resultados.push({
            ano,
            empenhos: 0,
            eventos: 0,
            erro: `coleta parcial (${mesesColetados.length}/12 meses)`,
          });
          logger.warn(
            `NEXO TCE-despesas — backfill ${ano}: parcial (${mesesColetados.length}/12)`,
          );
          continue;
        }
        const { count, ids } = await persistirDespesas(despesas);
        const { count: countEventos, ids: idsEventos } =
          await persistirEventos(eventos);
        await purgarObsoletas(ano, ids);
        await purgarEventosObsoletos(ano, idsEventos);
        resultados.push({ ano, empenhos: count, eventos: countEventos, erro: null });
        logger.info(
          `NEXO TCE-despesas — backfill ${ano}: ${count} empenhos, ` +
            `${countEventos} eventos, ${registrosBrutos} registros`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resultados.push({ ano, empenhos: 0, eventos: 0, erro: msg });
        logger.error(`NEXO TCE-despesas — backfill ${ano} falhou`, err);
      }
    }

    // Ciclo de vida: carimba primeira observação no backfill (docs históricos).
    const registrados = await carimbarPrimeiraObservacao("nexo_tce_despesas");
    const registradosEventos = await carimbarPrimeiraObservacao(
      "nexo_tce_despesas_eventos",
    );

    await gravarSyncState({
      syncId: "tce_despesas_backfill",
      fonte: "tce_sp",
      colecao: "nexo_tce_despesas_eventos",
      cadencia: "evento",
      sucesso: resultados.some((r) => !r.erro),
      degradado: resultados.some((r) => r.erro),
      erro: resultados.find((r) => r.erro)?.erro ?? null,
      duracaoMs: Date.now() - inicio,
      extra: {
        exerciciosTentados: anos.length,
        registrados,
        registradosEventos,
        resultados,
      },
    });

    res.status(200).json({
      ok: true,
      exercicios: resultados.length,
      comErro: resultados.filter((r) => r.erro).length,
      resultados,
    });
  },
);
