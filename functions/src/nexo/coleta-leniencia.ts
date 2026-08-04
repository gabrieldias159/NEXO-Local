/**
 * Cron de ingestão de ACORDOS DE LENIÊNCIA — `onNexoSyncLeniencia`.
 *
 * Lê os CNPJs dos fornecedores da Prefeitura de Marília (de `nexo_empenhos`) e
 * cruza cada um com o cadastro de Acordos de Leniência da CGU (Lei 12.846/2013,
 * arts. 16–17 — Lei Anticorrupção). Persiste o resultado em `nexo_leniencia`
 * (1 doc por CNPJ, idempotente; CNPJ verificado e limpo grava `comAcordo:false`,
 * espelhando o padrão de `nexo_sancoes`).
 *
 * Endpoint (confirmado no swagger público /v3/api-docs da CGU):
 *   GET /api-de-dados/acordos-leniencia?cnpjSancionado={cnpj}&pagina=N
 *   → AcordosLenienciaDTO[]: { id, dataInicioAcordo, dataFimAcordo,
 *     orgaoResponsavel, situacaoAcordo, sancoes: EmpresaSancionadaDTO[] }
 *   (o array `sancoes` traz as EMPRESAS abrangidas pelo acordo:
 *     { razaoSocial, nomeFantasia, cnpj, cnpjFormatado, ... }).
 *
 * Cadência: MENSAL (dia 3, 07:00 América/São Paulo) — acordos de leniência são
 * raros e mudam devagar; não justificam o ciclo de 6h das sanções.
 *
 * TOKEN: a API da CGU exige o header `chave-api-dados`, lido da variável de
 * ambiente `PORTAL_TRANSPARENCIA_TOKEN` (o MESMO token das sanções). SEM o
 * token, a função NÃO falha — grava no `nexo_sync_state` um estado "pendente
 * de token" (`statusSaude: 'degradado'`) e encerra sem consultar nada.
 *
 * Self-contained: re-implementa o fetch à API CGU (não importa de `src/`).
 * Molde: `coleta-sancoes.ts` (inclusive o fix de streaming na leitura dos
 * CNPJs — `select(..).stream()`, nunca `.get()` da coleção inteira).
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

const CGU_BASE = "https://api.portaldatransparencia.gov.br/api-de-dados";
const TIMEOUT_MS = 25_000;
/** Pausa entre chamadas — respeita o rate-limit da API CGU (~90 req/min). */
const DELAY_MS = 350;
/** Teto de páginas por CNPJ — um CNPJ raramente integra tantos acordos. */
const MAX_PAGINAS = 10;
/**
 * Primeiro exercício monitorado retroativamente — espelha `ANO_BASE` em
 * `coleta.ts`/`coleta-sancoes.ts`.
 */
const ANO_BASE = 2025;
/**
 * Teto de CNPJs por execução. Diferente das sanções (3 cadastros/CNPJ), aqui é
 * UMA chamada por CNPJ (~1s com a pausa de rate-limit) → 800 CNPJs ≈ 14 min,
 * com folga nos 1800s. Cobre os fornecedores de maior valor primeiro; o upsert
 * por CNPJ é idempotente.
 */
const MAX_CNPJS = 800;

/** Um acordo de leniência normalizado para `nexo_leniencia`. */
interface AcordoLenienciaNorm {
  /** ID do registro na CGU — habilita o deep-link de detalhe no portal. */
  idAcordo: string;
  /** CNPJ consultado/abrangido — apenas dígitos. */
  cnpjSancionado: string;
  /** Razão social da empresa abrangida (do array `sancoes` do DTO). */
  razaoSocial: string;
  /** Situação do acordo (ex.: "Acordo em vigência", "Acordo descumprido"). */
  situacaoAcordo: string;
  /** Órgão responsável pelo acordo (ex.: CGU/AGU). */
  orgaoResponsavel: string;
  /** Início da vigência em ISO `yyyy-MM-dd`, ou null. */
  dataInicio: string | null;
  /** Fim da vigência em ISO `yyyy-MM-dd`, ou null. */
  dataFim: string | null;
  /** Quantas empresas o acordo abrange (o DTO lista todas em `sancoes`). */
  qtdEmpresasAbrangidas: number;
}

function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

function pick(rec: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (rec[k] != null && rec[k] !== "") return rec[k];
  }
  return undefined;
}

function pickStr(rec: Record<string, unknown>, ...keys: string[]): string {
  const v = pick(rec, ...keys);
  return v == null ? "" : String(v).trim();
}

/** Converte data BR (`dd/MM/yyyy`) ou ISO para `yyyy-MM-dd`, ou null. */
function parseData(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

/**
 * Normaliza um registro cru do endpoint `acordos-leniencia` para o formato de
 * `nexo_leniencia`. A razão social vem do item de `sancoes` (empresas
 * abrangidas) cujo CNPJ casa com o consultado; fallback: primeiro item.
 * Leitura defensiva (vários nomes de campo) — nunca lança em malformado.
 */
function normalizarAcordo(
  rec: Record<string, unknown>,
  cnpjConsultado: string,
): AcordoLenienciaNorm {
  const empresas = Array.isArray(rec.sancoes)
    ? (rec.sancoes.filter(
        (e) => e && typeof e === "object" && !Array.isArray(e),
      ) as Record<string, unknown>[])
    : [];
  const daConsulta =
    empresas.find(
      (e) => soDigitos(pick(e, "cnpj", "cnpjFormatado")) === cnpjConsultado,
    ) ??
    empresas[0] ??
    {};
  return {
    idAcordo: pickStr(rec, "id"),
    cnpjSancionado: cnpjConsultado,
    razaoSocial: pickStr(
      daConsulta,
      "razaoSocial",
      "nomeFantasia",
      "nomeInformadoOrgaoResponsavel",
    ),
    situacaoAcordo: pickStr(rec, "situacaoAcordo", "situacao"),
    orgaoResponsavel: pickStr(rec, "orgaoResponsavel", "orgao"),
    dataInicio: parseData(pick(rec, "dataInicioAcordo", "dataInicio")),
    dataFim: parseData(pick(rec, "dataFimAcordo", "dataFim")),
    qtdEmpresasAbrangidas: empresas.length,
  };
}

function extrairRegistros(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    for (const k of ["content", "data", "registros", "lista"]) {
      if (Array.isArray(obj[k])) return obj[k] as Record<string, unknown>[];
    }
  }
  return [];
}

/** Varre todas as páginas de acordos para um CNPJ. Lança em erro de API. */
async function consultarAcordos(
  cnpj: string,
  token: string,
): Promise<AcordoLenienciaNorm[]> {
  const out: AcordoLenienciaNorm[] = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const url = new URL(`${CGU_BASE}/acordos-leniencia`);
    url.searchParams.set("cnpjSancionado", cnpj);
    url.searchParams.set("pagina", String(pagina));
    const res = await fetch(url.toString(), {
      headers: { "chave-api-dados": token, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 204) break;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Portal da Transparência rejeitou o token (HTTP ${res.status})`,
      );
    }
    if (res.status === 429) {
      throw new Error("Portal da Transparência: limite de requisições (429)");
    }
    if (!res.ok) {
      throw new Error(
        `Portal da Transparência acordos-leniencia HTTP ${res.status}`,
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      break;
    }
    const registros = extrairRegistros(json);
    if (registros.length === 0) break;
    for (const rec of registros) out.push(normalizarAcordo(rec, cnpj));
    if (registros.length < 15) break;
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  return out;
}

/**
 * Exercícios monitorados: do corrente até o ano-base, em ordem decrescente.
 * Espelha `anosMonitorados()` em `coleta.ts` (self-contained).
 */
function exerciciosMonitorados(): number[] {
  const atual = new Date().getFullYear();
  const anos: number[] = [];
  for (let a = atual; a >= ANO_BASE; a--) anos.push(a);
  return anos;
}

/**
 * Coleta os CNPJs distintos dos fornecedores de Marília a partir de
 * `nexo_empenhos`, ordenados por valor empenhado (maior primeiro). O campo
 * `_cnpj` é gravado pela engine de coleta SMARAPD.
 *
 * PROJEÇÃO + STREAMING (mesmo fix do OOM de `coleta-sancoes.ts`, 2026-06-09):
 * `select()` projeta no servidor (cada doc volta com ~2 campos) e o stream
 * nunca segura a coleção inteira em memória. O `.where("_exercicio","in",...)`
 * restringe aos exercícios monitorados — sem full-scan da coleção.
 */
async function coletarCnpjsFornecedores(): Promise<string[]> {
  const stream = db
    .collection("nexo_empenhos")
    .where("_exercicio", "in", exerciciosMonitorados())
    .select("_cnpj", "_valor")
    .stream() as AsyncIterable<FirebaseFirestore.QueryDocumentSnapshot>;
  const acc = new Map<string, number>();
  for await (const doc of stream) {
    const d = doc.data();
    const cnpj = soDigitos(d._cnpj);
    if (cnpj.length !== 14) continue; // só CNPJ de empresa
    const valor = typeof d._valor === "number" ? d._valor : 0;
    acc.set(cnpj, (acc.get(cnpj) ?? 0) + valor);
  }
  return [...acc.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cnpj]) => cnpj)
    .slice(0, MAX_CNPJS);
}

/**
 * Persiste os acordos de um CNPJ em `nexo_leniencia`. Doc por CNPJ —
 * re-coletar SOBRESCREVE o conjunto de acordos daquele CNPJ (idempotente).
 * CNPJ sem acordo também grava um doc (`comAcordo: false`) para o painel
 * saber que foi verificado e está limpo — espelha `nexo_sancoes`.
 */
async function persistirAcordos(
  cnpj: string,
  acordos: AcordoLenienciaNorm[],
): Promise<void> {
  await db
    .collection("nexo_leniencia")
    .doc(cnpj)
    .set(
      {
        _fonte: "leniencia_cgu",
        _cnpj: cnpj,
        cnpj,
        comAcordo: acordos.length > 0,
        qtdAcordos: acordos.length,
        situacoes: [
          ...new Set(acordos.map((a) => a.situacaoAcordo).filter(Boolean)),
        ],
        acordos,
        _verificadoEm: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

// ── Cron mensal ──────────────────────────────────────────────────────────────

export const onNexoSyncLeniencia = onSchedule(
  {
    schedule: "0 7 3 * *", // 07:00 do dia 3 de cada mês
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    // Token da API CGU (header `chave-api-dados`) injetado do Secret Manager
    // como process.env.PORTAL_TRANSPARENCIA_TOKEN — o MESMO secret das sanções.
    // Se o secret estiver vazio, o guard abaixo pula o ciclo sem falhar.
    secrets: ["PORTAL_TRANSPARENCIA_TOKEN"],
    // Pior caso real: MAX_CNPJS(800) × (fetch + pausa de rate-limit) ≈ 14 min,
    // com folga nos 1800s (mesmo teto do cron de sanções).
    timeoutSeconds: 1800,
    memory: "512MiB",
    // No máximo UMA execução simultânea — evita que um retry atrasado concorra
    // com a execução em andamento e refaça as consultas à API CGU.
    maxInstances: 1,
    // Retry idempotente: cada CNPJ tem doc ID determinístico (o próprio CNPJ)
    // gravado com `merge` — reexecutar sobrescreve, nunca duplica.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    const token = (process.env.PORTAL_TRANSPARENCIA_TOKEN ?? "").trim();

    // Sem token: estado "pendente de token", não falha.
    if (!token) {
      logger.warn(
        "NEXO Leniência — PORTAL_TRANSPARENCIA_TOKEN ausente; pulando ciclo.",
      );
      await gravarSyncState({
        syncId: "leniencia",
        fonte: "leniencia_cgu",
        colecao: "nexo_leniencia",
        // `Cadencia` não tem "mensal"; usamos "quinzenal" (cadência mais lenta
        // disponível) — mesmo precedente de coleta-contas-irregulares.ts.
        cadencia: "quinzenal",
        sucesso: true, // não consultar por falta de token não é uma "falha"
        degradado: true,
        erro: "pendente de token (PORTAL_TRANSPARENCIA_TOKEN não configurado)",
        duracaoMs: Date.now() - inicio,
        extra: { tokenConfigurado: false, cnpjsConsultados: 0 },
      });
      return;
    }

    let cnpjs: string[] = [];
    try {
      cnpjs = await coletarCnpjsFornecedores();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO Leniência — falha ao ler CNPJs de nexo_empenhos", err);
      await gravarSyncState({
        syncId: "leniencia",
        fonte: "leniencia_cgu",
        colecao: "nexo_leniencia",
        cadencia: "quinzenal",
        sucesso: false,
        erro: msg,
        duracaoMs: Date.now() - inicio,
        extra: { tokenConfigurado: true, cnpjsConsultados: 0 },
      });
      return;
    }

    let consultados = 0;
    let comAcordo = 0;
    let totalAcordos = 0;
    let falhas = 0;
    let ultimoErro: string | null = null;

    for (const cnpj of cnpjs) {
      let acordos: AcordoLenienciaNorm[] = [];
      let erroCnpj = false;
      try {
        acordos = await consultarAcordos(cnpj, token);
      } catch (err) {
        erroCnpj = true;
        ultimoErro = err instanceof Error ? err.message : String(err);
        // 401/403/429 são erros globais — aborta o ciclo inteiro.
        if (/HTTP 40[13]|429/.test(ultimoErro)) {
          falhas++;
          logger.error(
            "NEXO Leniência — erro global, abortando ciclo",
            ultimoErro,
          );
          await gravarSyncState({
            syncId: "leniencia",
            fonte: "leniencia_cgu",
            colecao: "nexo_leniencia",
            cadencia: "quinzenal",
            sucesso: false,
            erro: ultimoErro,
            duracaoMs: Date.now() - inicio,
            extra: {
              tokenConfigurado: true,
              cnpjsConsultados: consultados,
              cnpjsComAcordo: comAcordo,
              registros: totalAcordos,
            },
          });
          return;
        }
      }
      if (!erroCnpj) {
        try {
          await persistirAcordos(cnpj, acordos);
          consultados++;
          if (acordos.length > 0) comAcordo++;
          totalAcordos += acordos.length;
        } catch (err) {
          falhas++;
          ultimoErro = err instanceof Error ? err.message : String(err);
          logger.error(
            `NEXO Leniência — falha ao persistir CNPJ ${cnpj}`,
            err,
          );
        }
      } else {
        // Erro de rede pontual: NÃO grava o doc (não mascarar como "limpo").
        falhas++;
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    await gravarSyncState({
      syncId: "leniencia",
      fonte: "leniencia_cgu",
      colecao: "nexo_leniencia",
      cadencia: "quinzenal",
      sucesso: consultados > 0,
      degradado: falhas > 0,
      erro: falhas > 0 ? ultimoErro : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        tokenConfigurado: true,
        cnpjsConsultados: consultados,
        cnpjsComAcordo: comAcordo,
        registros: totalAcordos,
        cnpjsComFalha: falhas,
      },
    });
    logger.info(
      `NEXO Leniência — concluído: ${consultados} CNPJs verificados, ` +
        `${comAcordo} com acordo, ${totalAcordos} acordos, ${falhas} falhas`,
    );
  },
);
