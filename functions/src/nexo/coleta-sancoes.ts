/**
 * Cron de ingestão de SANÇÕES FEDERAIS — `onNexoSyncSancoes` (Fase 3).
 *
 * Lê os CNPJs dos fornecedores da Prefeitura de Marília (de `nexo_empenhos`) e
 * cruza cada um com os cadastros federais de inidôneos da CGU:
 *   - CEIS  — Cadastro de Empresas Inidôneas e Suspensas;
 *   - CNEP  — Cadastro Nacional de Empresas Punidas (Lei Anticorrupção);
 *   - CEPIM — Cadastro de Entidades Privadas Impedidas.
 * Persiste as sanções encontradas em `nexo_sancoes`.
 *
 * Cadência: a cada 6 horas.
 *
 * TOKEN: a API da CGU exige o header `chave-api-dados`, lido da variável de
 * ambiente `PORTAL_TRANSPARENCIA_TOKEN`. SEM o token, a função NÃO falha —
 * grava no `nexo_sync_state` um estado "pendente de token"
 * (`statusSaude: 'degradado'`) e encerra sem consultar nada. Não é declarado
 * como `defineSecret` de propósito: o token é opcional e um secret obrigatório
 * bloquearia o deploy de todo o codebase de functions enquanto não existisse.
 *
 * Self-contained: re-implementa o fetch à API CGU (não importa de `src/`).
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

const CGU_BASE = "https://api.portaldatransparencia.gov.br/api-de-dados";
const TIMEOUT_MS = 25_000;
/** Pausa entre chamadas — respeita o rate-limit da API CGU (~90 req/min). */
const DELAY_MS = 350;
/** Teto de páginas por cadastro/CNPJ. */
const MAX_PAGINAS = 10;
/**
 * Primeiro exercício monitorado retroativamente — espelha `ANO_BASE` em
 * `coleta.ts`. O NEXO monitora do exercício corrente até este ano (corrente +
 * retroativo); a coleta de CNPJs segue o mesmo escopo.
 */
const ANO_BASE = 2025;
/**
 * Teto de CNPJs por execução. A 6h × 3 cadastros, varrer todos os fornecedores
 * estouraria o timeout; o ciclo cobre os de maior valor primeiro e o resto na
 * janela seguinte (o upsert por CNPJ é idempotente).
 */
const MAX_CNPJS = 400;

type Cadastro = "CEIS" | "CNEP" | "CEPIM";

interface SancaoNorm {
  cadastro: Cadastro;
  cnpjSancionado: string;
  nomeSancionado: string;
  tipoSancao: string;
  dataInicio: string | null;
  dataFim: string | null;
  orgaoSancionador: string;
  fundamentacao: string;
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

function pickObj(
  rec: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | null {
  for (const k of keys) {
    const v = rec[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return null;
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

function normalizarSancao(
  rec: Record<string, unknown>,
  cadastro: Cadastro,
): SancaoNorm {
  const pessoa =
    pickObj(rec, "pessoa", "sancionado", "pessoaJuridica") ?? rec;
  const orgao = pickObj(rec, "orgaoSancionador", "orgao", "origem") ?? rec;
  const cnpjBruto =
    pickStr(pessoa, "cnpjFormatado", "cnpj", "codigoFormatado", "cpfCnpj") ||
    pickStr(rec, "cnpjSancionado", "codigoSancionado", "cnpj");
  return {
    cadastro,
    cnpjSancionado: soDigitos(cnpjBruto),
    nomeSancionado:
      pickStr(pessoa, "nome", "razaoSocial", "nomeSancionado") ||
      pickStr(rec, "nomeSancionado", "nome"),
    tipoSancao:
      pickStr(rec, "tipoSancao", "tipo", "descricaoResumida") || cadastro,
    dataInicio: parseData(
      pick(rec, "dataInicioSancao", "dataPublicacaoSancao", "dataInicio"),
    ),
    dataFim: parseData(pick(rec, "dataFimSancao", "dataFinalSancao", "dataFim")),
    orgaoSancionador:
      pickStr(orgao, "nome", "razaoSocial", "descricao") ||
      pickStr(rec, "orgaoSancionador"),
    fundamentacao: pickStr(
      rec,
      "fundamentacao",
      "textoPublicacao",
      "descricaoFundamentacao",
    ),
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

/** Varre todas as páginas de um cadastro para um CNPJ. Lança em erro de API. */
async function consultarCadastro(
  endpoint: "ceis" | "cnep" | "cepim",
  cadastro: Cadastro,
  cnpj: string,
  token: string,
): Promise<SancaoNorm[]> {
  const out: SancaoNorm[] = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const url = new URL(`${CGU_BASE}/${endpoint}`);
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
      throw new Error(`Portal da Transparência ${endpoint} HTTP ${res.status}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      break;
    }
    const registros = extrairRegistros(json);
    if (registros.length === 0) break;
    // GUARD anti "todo mundo sancionado": a API CGU, em alguns casos, IGNORA o
    // filtro `cnpjSancionado` e devolve a lista inteira do cadastro (paginada
    // até o teto), o que marcava CADA fornecedor como sancionado com ~300
    // registros. Só aceitamos o registro cujo CNPJ realmente casa o consultado
    // — pela RAIZ de 8 dígitos (tolera matriz/filial e diferenças de formatação).
    // Sem CNPJ no registro (ex.: sanção de PF) → descartado nesta consulta por CNPJ.
    const raizAlvo = cnpj.slice(0, 8);
    let casaram = 0;
    for (const rec of registros) {
      const norm = normalizarSancao(rec, cadastro);
      if (norm.cnpjSancionado.length >= 8 && norm.cnpjSancionado.slice(0, 8) === raizAlvo) {
        out.push(norm);
        casaram++;
      }
    }
    // Se a página inteira veio sem casar (filtro ignorado pela API), não adianta
    // paginar mais: são registros de outros CNPJs. Encerra a varredura deste CNPJ.
    if (casaram === 0) break;
    if (registros.length < 15) break;
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  return out;
}

/**
 * Exercícios monitorados: do corrente até o ano-base, em ordem decrescente.
 * O ano corrente é lido do relógio do sistema em runtime (cron real) — espelha
 * `anosMonitorados()` em `coleta.ts`, mantendo este arquivo self-contained.
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
 * Restringe a leitura aos exercícios monitorados (corrente + retroativo) via
 * `.where("_exercicio", "in", ...)` — evita o full-scan da coleção inteira a
 * cada ciclo de 6h. Filtro `in` em campo único é servido pelo índice
 * single-field automático; nenhum índice composto é necessário.
 */
async function coletarCnpjsFornecedores(): Promise<string[]> {
  // PROJEÇÃO + STREAMING (fix do OOM em prod, 2026-06-09): o `.get()` antigo
  // carregava TODOS os docs de `nexo_empenhos` (com o bruto da coleta) só para
  // extrair `_cnpj`/`_valor` — estourava os 512 MiB. O `select()` faz a projeção
  // no servidor (cada doc volta com ~2 campos) e o stream nunca segura a
  // coleção inteira.
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
 * Persiste as sanções de um CNPJ em `nexo_sancoes`. Doc por CNPJ — re-coletar
 * SOBRESCREVE o conjunto de sanções daquele CNPJ (idempotente). CNPJ sem
 * sanção também grava um doc (`sancionado: false`) para o painel saber que foi
 * verificado e está limpo.
 */
async function persistirSancoes(
  cnpj: string,
  sancoes: SancaoNorm[],
): Promise<void> {
  await db
    .collection("nexo_sancoes")
    .doc(cnpj)
    .set(
      {
        _fonte: "sancoes_federais",
        _cnpj: cnpj,
        cnpj,
        sancionado: sancoes.length > 0,
        qtdSancoes: sancoes.length,
        cadastros: [...new Set(sancoes.map((s) => s.cadastro))],
        sancoes,
        _verificadoEm: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

// ── Cron a cada 6h ───────────────────────────────────────────────────────────

export const onNexoSyncSancoes = onSchedule(
  {
    // CUSTO: era `every 6 hours` (4×/dia). Cada ciclo relê os CNPJs de
    // `nexo_empenhos` dos exercícios monitorados (1 read/doc, `select` não
    // reduz a contagem) — o maior read recorrente. CEIS/CNEP muda devagar;
    // 1×/dia corta ~75% dessa leitura sem perda prática. Roda 10:30, após o
    // enriquecimento matinal que atualiza os CNPJs de fornecedores.
    schedule: "30 10 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    // Token da API CGU (header `chave-api-dados`) injetado do Secret Manager
    // como process.env.PORTAL_TRANSPARENCIA_TOKEN. Com o secret provisionado, o
    // ciclo deixa de ficar "pendente de token" e passa a coletar de fato
    // CEIS/CNEP/CEPIM. Se o secret estiver vazio, o guard abaixo ainda pula
    // o ciclo sem falhar (token continua "opcional" no runtime).
    secrets: ["PORTAL_TRANSPARENCIA_TOKEN"],
    // 1800s: o pior caso real é MAX_CNPJS(400) × 3 cadastros × (fetch + pausas
    // de rate-limit) ≈ 16 min — os 540s antigos davam DEADLINE_EXCEEDED no
    // Cloud Scheduler antes de o ciclo terminar (visto em prod, 2026-06-09).
    timeoutSeconds: 1800,
    memory: "512MiB",
    // Hardening (#13): no máximo UMA execução simultânea — evita que um disparo
    // atrasado/retry concorra com a execução em andamento e refaça as consultas
    // à API CGU. (Lease/lock distribuído fica para onda posterior.)
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: cada CNPJ tem doc ID determinístico
    // (o próprio CNPJ) gravado com `merge`, então reexecutar o cron após falha
    // SOBRESCREVE o conjunto de sanções daquele CNPJ, nunca duplica.
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
        "NEXO Sanções — PORTAL_TRANSPARENCIA_TOKEN ausente; pulando ciclo.",
      );
      await gravarSyncState({
        syncId: "sancoes",
        fonte: "sancoes_federais",
        colecao: "nexo_sancoes",
        cadencia: "6h",
        sucesso: true, // não consultar por falta de token não é uma "falha"
        degradado: true,
        erro: "pendente de token (PORTAL_TRANSPARENCIA_TOKEN não configurado)",
        duracaoMs: Date.now() - inicio,
        extra: { tokenConfigurado: false, cnpjsConsultados: 0 },
      });
      return;
    }

    const alvos: { endpoint: "ceis" | "cnep" | "cepim"; cadastro: Cadastro }[] =
      [
        { endpoint: "ceis", cadastro: "CEIS" },
        { endpoint: "cnep", cadastro: "CNEP" },
        { endpoint: "cepim", cadastro: "CEPIM" },
      ];

    let cnpjs: string[] = [];
    try {
      cnpjs = await coletarCnpjsFornecedores();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO Sanções — falha ao ler CNPJs de nexo_empenhos", err);
      await gravarSyncState({
        syncId: "sancoes",
        fonte: "sancoes_federais",
        colecao: "nexo_sancoes",
        cadencia: "6h",
        sucesso: false,
        erro: msg,
        duracaoMs: Date.now() - inicio,
        extra: { tokenConfigurado: true, cnpjsConsultados: 0 },
      });
      return;
    }

    let consultados = 0;
    let sancionados = 0;
    let totalSancoes = 0;
    let falhas = 0;
    let ultimoErro: string | null = null;

    for (const cnpj of cnpjs) {
      const sancoes: SancaoNorm[] = [];
      let erroCnpj = false;
      for (const [i, alvo] of alvos.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
        try {
          sancoes.push(
            ...(await consultarCadastro(
              alvo.endpoint,
              alvo.cadastro,
              cnpj,
              token,
            )),
          );
        } catch (err) {
          erroCnpj = true;
          ultimoErro = err instanceof Error ? err.message : String(err);
          // 401/403/429 são erros globais — aborta o ciclo inteiro.
          if (/HTTP 40[13]|429/.test(ultimoErro)) {
            falhas++;
            logger.error(
              "NEXO Sanções — erro global, abortando ciclo",
              ultimoErro,
            );
            await gravarSyncState({
              syncId: "sancoes",
              fonte: "sancoes_federais",
              colecao: "nexo_sancoes",
              cadencia: "6h",
              sucesso: false,
              erro: ultimoErro,
              duracaoMs: Date.now() - inicio,
              extra: {
                tokenConfigurado: true,
                cnpjsConsultados: consultados,
                cnpjsSancionados: sancionados,
                registros: totalSancoes,
              },
            });
            return;
          }
        }
      }
      try {
        await persistirSancoes(cnpj, sancoes);
        consultados++;
        if (sancoes.length > 0) sancionados++;
        totalSancoes += sancoes.length;
      } catch (err) {
        falhas++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.error(`NEXO Sanções — falha ao persistir CNPJ ${cnpj}`, err);
      }
      if (erroCnpj) falhas++;
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    // P1-D — "0 sancionados em N consultados" com lado federal VAZIO é
    // SUSPEITO, não "ok": casa com o histórico do bug "900" (a API CGU às vezes
    // ignora o filtro `cnpjSancionado`, e o nosso guard anti-"todo mundo
    // sancionado" então descarta tudo, zerando o resultado). Quando varremos um
    // volume relevante de CNPJs e NENHUM bateu uma única sanção, o mais provável
    // é a query/filtro CGU estar quebrada — marcamos DEGRADADO com motivo
    // honesto em vez de gravar um "ok" enganoso que propaga p/ vinculo_vivo.
    // (Limiar conservador: só dispara em varredura grande — município pequeno
    // pode legitimamente ter poucos/zero fornecedores sancionados; >=50
    // consultados sem nenhum registro é que cheira a filtro ignorado.)
    const LIMIAR_SUSPEITA_ZERO = 50;
    const zeroFederalSuspeito =
      sancionados === 0 &&
      totalSancoes === 0 &&
      consultados >= LIMIAR_SUSPEITA_ZERO;
    const erroZero = zeroFederalSuspeito
      ? `0 sanções federais em ${consultados} CNPJs consultados (CEIS/CNEP/CEPIM) — ` +
        `lado federal vazio; provável filtro CGU 'cnpjSancionado' ignorado/quebrado (rever query).`
      : null;
    await gravarSyncState({
      syncId: "sancoes",
      fonte: "sancoes_federais",
      colecao: "nexo_sancoes",
      cadencia: "6h",
      sucesso: consultados > 0,
      degradado: falhas > 0 || zeroFederalSuspeito,
      erro: falhas > 0 ? ultimoErro : erroZero,
      duracaoMs: Date.now() - inicio,
      extra: {
        tokenConfigurado: true,
        cnpjsConsultados: consultados,
        cnpjsSancionados: sancionados,
        registros: totalSancoes,
        cnpjsComFalha: falhas,
        zeroFederalSuspeito,
      },
    });
    logger.info(
      `NEXO Sanções — concluído: ${consultados} CNPJs verificados, ` +
        `${sancionados} sancionados, ${totalSancoes} sanções, ${falhas} falhas`,
    );
  },
);
