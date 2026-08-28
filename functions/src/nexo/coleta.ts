/**
 * Engine de ingestão do NEXO.
 *
 * Coleta os módulos do Portal da Transparência de Marília (plataforma SMARAPD)
 * e persiste nas coleções `nexo_*` do Firestore, com hash de conteúdo por
 * fonte/exercício — só reescreve quando os dados mudaram.
 *
 * Exporta:
 *   - `onNexoColetaDiaria`  — cron diário (04h15 BRT). Ingere TODOS os módulos
 *      para os exercícios monitorados (exercício corrente + retroativo 2025).
 *   - `onNexoBackfillHttp`  — endpoint HTTP protegido por segredo. Dispara a
 *      ingestão de um conjunto de anos/módulos sob demanda (seed retroativo).
 *
 * Self-contained: o projeto `functions/` não importa de `src/lib/nexo/`.
 * Ver docs/nexo-plano-mestre.md §8 (coleta agendada).
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { createHash } from "crypto";

import { admin, db } from "../shared/admin";
import { rodarDeteccao } from "./deteccao";
import { gravarSyncState } from "./sync-state";

const SMARAPD_BASE =
  "https://transparencia.marilia.sp.gov.br/paiportalserver";

// A API SMARAPD exige User-Agent de browser — sem ele responde HTTP 400.
const SMARAPD_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://transparencia.marilia.sp.gov.br/",
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
};

/** Primeiro exercício monitorado retroativamente. */
const ANO_BASE = 2025;

/** Especificação de um módulo SMARAPD a ingerir. */
interface ModuloSpec {
  /** Nome curto/estável da fonte (usado em `_fonte` e em `nexo_sync_state`). */
  nome: string;
  /** Coleção Firestore de destino (prefixo `nexo_` — ver firestore.rules). */
  colecao: string;
  /** `ChaveModulo` da API SMARAPD. */
  chave: string;
  /** `NomeVisao` da API SMARAPD. */
  visao: string;
  /**
   * Teto de páginas por exercício (cada página = 500 registros). Quando a fonte
   * reporta mais páginas que `maxPag`, a coleta é TRUNCADA (dados cortados) e o
   * `nexo_sync_state` recebe `truncado: true` — sinal honesto de cobertura
   * incompleta no painel de saúde. Caps de `pagamentos`/`patrimonio` foram
   * subidos com folga (240/100) por terem batido o teto exato (60000/20000).
   */
  maxPag: number;
}

/**
 * Catálogo de ingestão — os 16 módulos úteis da API SMARAPD (ver
 * `src/lib/nexo/sources/smarapd.ts` → `SMARAPD_MODULOS`). Cobre execução
 * orçamentária, folha, diárias, receita, terceiro setor, publicidade,
 * passagens e patrimônio — tudo o que os 172 monitoramentos do catálogo
 * consomem do portal municipal.
 */
export const MODULOS: ModuloSpec[] = [
  { nome: "empenhos", colecao: "nexo_empenhos", chave: "fornecedor", visao: "fornecedoranalitico", maxPag: 140 },
  { nome: "despesas", colecao: "nexo_despesas", chave: "DespesaAgrupada", visao: "DespesaseInvestimentos", maxPag: 120 },
  { nome: "pagamentos", colecao: "nexo_pagamentos", chave: "pagamentos", visao: "pagamentoaservidores", maxPag: 240 },
  { nome: "movimento_empenho", colecao: "nexo_movimento_empenho", chave: "despesas_sinteticas", visao: "MovimentoEmpenho", maxPag: 80 },
  { nome: "diarias", colecao: "nexo_diarias", chave: "diarias", visao: "diarias", maxPag: 25 },
  { nome: "restos", colecao: "nexo_restos", chave: "restoapagar", visao: "restoapagar", maxPag: 20 },
  { nome: "modalidades", colecao: "nexo_modalidades", chave: "quadro_de_renda_local", visao: "EmpenhoModalidade", maxPag: 10 },
  { nome: "receita", colecao: "nexo_receita", chave: "balancetereceita", visao: "Arrecadacoes", maxPag: 20 },
  { nome: "despesa_sintetica", colecao: "nexo_despesa_sintetica", chave: "despesa_sintetica", visao: "DespesaSintetica", maxPag: 60 },
  { nome: "subvencoes", colecao: "nexo_subvencoes", chave: "despesas_subvencoes", visao: "subvencoes", maxPag: 25 },
  { nome: "emendas", colecao: "nexo_emendas", chave: "emendas_parlamentares", visao: "EmendasParlamentares", maxPag: 25 },
  { nome: "publicidade", colecao: "nexo_publicidade", chave: "despesas_de_pagamentos", visao: "publicidade", maxPag: 20 },
  { nome: "publicidade_digital", colecao: "nexo_publicidade_digital", chave: "seguranca", visao: "publicidadedigital", maxPag: 15 },
  { nome: "passagens", colecao: "nexo_passagens", chave: "despesa_viagem", visao: "passagenslocomocao", maxPag: 25 },
  // 2026: a fonte devolve 307 paginas (~153.500 bens). O teto de 100 cortava
  // em 50.000 e marcava `truncado: true` — dois tercos do inventario ficavam
  // de fora, e qualquer contagem de bens por tipo saia errada para menos.
  // 360 da folga para o crescimento do patrimonio sem novo corte.
  { nome: "patrimonio", colecao: "nexo_patrimonio", chave: "patrimonio_mobiliario", visao: "patrimonio", maxPag: 360 },
  { nome: "covid", colecao: "nexo_covid", chave: "despesa_covid", visao: "despesacovid", maxPag: 15 },
];

interface ModuloResp {
  QuantidadePaginas?: number;
  Valores?: Record<string, unknown>[];
}

async function filterModulo(
  chaveModulo: string,
  nomeVisao: string,
  exercicio: number,
  pagina: number,
): Promise<ModuloResp> {
  const body = {
    ChaveModulo: chaveModulo,
    NomeVisao: nomeVisao,
    Exercicio: exercicio,
    Periodicidade: "ANUAL",
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
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`SMARAPD HTTP ${res.status}`);
  return (await res.json()) as ModuloResp;
}

/**
 * Varre as páginas de um módulo num exercício. Falha numa página intermediária
 * devolve o que já foi coletado (coleta parcial registrada em log) — não
 * derruba a ingestão das demais.
 */
async function coletarModulo(
  m: ModuloSpec,
  exercicio: number,
): Promise<{
  registros: Record<string, unknown>[];
  parcial: boolean;
  truncado: boolean;
}> {
  const out: Record<string, unknown>[] = [];
  const primeira = await filterModulo(m.chave, m.visao, exercicio, 1);
  out.push(...(primeira.Valores ?? []));
  const paginasFonte = primeira.QuantidadePaginas ?? 1;
  const total = Math.min(paginasFonte, m.maxPag);
  // A fonte reportou mais páginas do que o cap deixa coletar → dados CORTADOS.
  const truncado = paginasFonte > m.maxPag;
  if (truncado) {
    logger.warn(
      `NEXO — ${m.nome}/${exercicio}: TRUNCADO no cap maxPag=${m.maxPag} ` +
        `(fonte reportou ${paginasFonte} páginas). Subir o cap para cobrir tudo.`,
    );
  }
  let parcial = false;
  for (let p = 2; p <= total; p++) {
    await new Promise((r) => setTimeout(r, 120));
    try {
      const resp = await filterModulo(m.chave, m.visao, exercicio, p);
      out.push(...(resp.Valores ?? []));
    } catch (err) {
      parcial = true;
      logger.warn(
        `NEXO — ${m.nome}/${exercicio}: falha na página ${p}/${total}, ` +
          `coleta parcial com ${out.length} registros. ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }
  }
  return { registros: out, parcial, truncado };
}

/**
 * Hash de MULTISET dos registros brutos — usado para idempotência/detecção de
 * mudança em `nexo_sync_state`. É INVARIANTE À ORDEM: a fonte SMARAPD pode
 * devolver os mesmos registros em ordem diferente entre coletas (paginação,
 * reordenação interna), e isso NÃO deve disparar um falso "mudou".
 *
 * Implementação: hash de cada registro individualmente (chaves canonicalizadas
 * por `JSON.stringify(rec, Object.keys(rec).sort())`, igual a `idDocumento`,
 * para ser estável à ordem das PROPRIEDADES), depois ordena os hashes e os
 * concatena num hash final. Sortear os hashes torna o resultado independente da
 * ordem dos REGISTROS. Função pura dos dados — sem aleatoriedade nem relógio.
 *
 * Observação: registros duplicados contam (multiset), não set — duas linhas
 * idênticas produzem dois hashes iguais que ambos entram na combinação, então
 * a multiplicidade faz parte da identidade do conteúdo.
 */
function hashConteudo(registros: Record<string, unknown>[]): string {
  const hashes = registros
    .map((rec) =>
      createHash("sha1")
        .update(JSON.stringify(rec, Object.keys(rec).sort()))
        .digest("hex"),
    )
    .sort();
  const combinado = createHash("sha1");
  for (const h of hashes) combinado.update(h);
  return combinado.digest("hex");
}

function parseValorBR(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v !== "string") return 0;
  const n = Number(v.replace(/[R$\s.]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function campo(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    if (rec[k] != null && rec[k] !== "") return String(rec[k]);
  }
  return "";
}

/**
 * ID estável do documento. Usa o identificador natural do registro quando
 * existe; senão, um hash do conteúdo — assim a deduplicação funciona mesmo
 * em módulos sem campo de ID e a ordem de paginação não gera duplicatas.
 */
function idDocumento(
  rec: Record<string, unknown>,
  exercicio: number,
): string {
  const natural = campo(
    rec,
    "ID",
    "Id",
    "Codigo",
    "NroEmpenho",
    "NumeroEmpenho",
    "NumEmpenho",
    "NroEmenda",
    "NumeroEmenda",
  );
  // O ID combina a chave natural (quando existe) com um hash do CONTEÚDO. A
  // chave natural sozinha NÃO basta: módulos como `fornecedoranalitico` trazem
  // várias linhas com o mesmo `NroEmpenho` — usá-la pura colapsaria registros
  // distintos (perda de dado). O hash (chaves canonicalizadas para ser estável
  // à ordem de propriedades) garante que linhas distintas coexistam e que a
  // re-coleta de um registro idêntico dedupe corretamente.
  const hash = createHash("sha1")
    .update(JSON.stringify(rec, Object.keys(rec).sort()))
    .digest("hex")
    .slice(0, 16);
  const base = natural ? `${natural}-${hash}` : hash;
  return `${exercicio}-${base}`.replace(/[^\w-]/g, "_");
}

/** Persiste registros numa coleção `nexo_*`, em lotes de 400. */
async function persistir(
  m: ModuloSpec,
  registros: Record<string, unknown>[],
  exercicio: number,
): Promise<{ count: number; ids: Set<string> }> {
  let batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ids = new Set<string>();
  let n = 0;
  for (const reg of registros) {
    const id = idDocumento(reg, exercicio);
    // Colisão de ID dentro do mesmo lote (registros idênticos) — ignora a 2ª.
    if (ids.has(id)) continue;
    ids.add(id);
    batch.set(
      db.collection(m.colecao).doc(id),
      {
        ...reg,
        _exercicio: exercicio,
        _fonte: m.nome,
        _cnpj: campo(reg, "CPFCNPJ", "CNPJ", "CpfCnpj").replace(/\D/g, ""),
        _fornecedor: campo(reg, "NomeFornecedor", "Fornecedor", "NomeBeneficiario"),
        _valor: parseValorBR(
          reg.ValorEmpenho ?? reg.ValorEmpenhado ?? reg.Valor ?? reg.ValorPago,
        ),
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

/**
 * Remove da coleção os documentos do mesmo exercício/fonte que não constam
 * mais no snapshot atual — evita acúmulo de dados obsoletos.
 */
async function purgarObsoletos(
  m: ModuloSpec,
  exercicio: number,
  idsAtuais: Set<string>,
): Promise<number> {
  const snap = await db
    .collection(m.colecao)
    .where("_exercicio", "==", exercicio)
    .where("_fonte", "==", m.nome)
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

interface ResultadoFonte {
  modulo: string;
  exercicio: number;
  registros: number;
  persistidos: number;
  removidos: number;
  mudou: boolean;
  parcial: boolean;
  truncado: boolean;
  erro: string | null;
}

/**
 * Ingere um módulo num exercício: coleta → compara hash → persiste/purga se
 * mudou → grava o estado de sincronização. Cada ingestão é isolada — uma
 * falha não derruba as demais.
 */
async function ingerirFonte(
  m: ModuloSpec,
  exercicio: number,
): Promise<ResultadoFonte> {
  const syncId = `${m.nome}-${exercicio}`;
  const inicio = Date.now();
  const base: ResultadoFonte = {
    modulo: m.nome,
    exercicio,
    registros: 0,
    persistidos: 0,
    removidos: 0,
    mudou: false,
    parcial: false,
    truncado: false,
    erro: null,
  };
  try {
    const { registros, parcial, truncado } = await coletarModulo(m, exercicio);
    base.registros = registros.length;
    base.parcial = parcial;
    base.truncado = truncado;

    // Hash do conteúdo coletado nesta execução; quando PARCIAL, NÃO gravamos o
    // hash definitivo (fica null) para a próxima execução recoletar o módulo
    // inteiro. Mantemos a leitura do hash anterior para detectar mudança.
    const hash = hashConteudo(registros);
    const syncRef = db.collection("nexo_sync_state").doc(syncId);
    const anterior = await syncRef.get();
    const hashAnterior = anterior.exists
      ? (anterior.data()?.hashConteudo as string | undefined)
      : undefined;
    base.mudou = hashAnterior !== hash;

    // `hashGravado` é o hash que persistiremos: null em coleta parcial (força
    // recoleta), senão o hash atual. Idempotência continua via `nexo_sync_state`.
    let hashGravado: string | null = hash;

    if (parcial) {
      // Coleta PARCIAL (uma página falhou). Persiste — em merge, aditivo — o
      // que veio, mas NÃO purga: os IDs das páginas não lidas não estão em
      // `ids` e seriam apagados como "obsoletos", destruindo dado válido
      // (achado CRÍTICO do Codex). E NÃO grava o hash definitivo.
      if (registros.length > 0) {
        const { count } = await persistir(m, registros, exercicio);
        base.persistidos = count;
      }
      hashGravado = null;
    } else if (base.mudou) {
      // Coleta ÍNTEGRA e com mudança. Persiste e purga — inclusive quando o
      // snapshot legítimo está vazio (a purga limpa documentos antigos que a
      // fonte deixou de retornar).
      const { count, ids } =
        registros.length > 0
          ? await persistir(m, registros, exercicio)
          : { count: 0, ids: new Set<string>() };
      base.persistidos = count;
      base.removidos = await purgarObsoletos(m, exercicio, ids);
    }
    // else: coleta íntegra, sem mudança — só recarimba o estado (abaixo).

    // Observabilidade unificada: todo estado por módulo passa por
    // `gravarSyncState` (calcula `statusSaude`/`errosConsecutivos`/`cadencia`).
    // PARCIAL ou TRUNCADO → degradado (a coleta concluiu, mas com cobertura
    // incompleta); erro fatal cai no catch abaixo com `sucesso: false`.
    await gravarSyncState({
      syncId,
      fonte: m.nome,
      colecao: m.colecao,
      cadencia: "diario",
      sucesso: true,
      degradado: parcial || truncado,
      truncado,
      erro: null,
      duracaoMs: Date.now() - inicio,
      extra: {
        exercicio,
        registros: registros.length,
        hashConteudo: hashGravado,
        mudou: base.mudou,
        parcial,
      },
    });

    logger.info(
      `NEXO — ${m.nome}/${exercicio}: ${registros.length} registros` +
        (base.mudou
          ? `, ${base.persistidos} persistidos, ${base.removidos} obsoletos removidos`
          : " (sem mudança)") +
        (parcial ? " [PARCIAL]" : "") +
        (truncado ? " [TRUNCADO]" : ""),
    );
  } catch (err) {
    base.erro = err instanceof Error ? err.message : String(err);
    logger.error(`NEXO — falha na ingestão de ${m.nome}/${exercicio}`, err);
    await gravarSyncState({
      syncId,
      fonte: m.nome,
      colecao: m.colecao,
      cadencia: "diario",
      sucesso: false,
      erro: base.erro,
      duracaoMs: Date.now() - inicio,
      extra: { exercicio, registros: base.registros },
    });
  }
  return base;
}

/** Exercícios monitorados: do corrente até o ano-base, em ordem decrescente. */
export function anosMonitorados(): number[] {
  const atual = new Date().getFullYear();
  const anos: number[] = [];
  for (let a = atual; a >= ANO_BASE; a--) anos.push(a);
  return anos;
}

/**
 * Ingere o conjunto pedido de módulos × exercícios com concorrência limitada.
 * As tarefas são enfileiradas com o exercício corrente primeiro (prioridade);
 * `deadline` (timestamp epoch ms) interrompe o enfileiramento antes de o
 * runtime estourar o timeout da função — o trabalho já persistido permanece e
 * a próxima execução continua (a deduplicação por hash pula o que não mudou).
 */
export async function ingerirLote(
  modulos: ModuloSpec[],
  anos: number[],
  opts: { concorrencia?: number; deadline?: number } = {},
): Promise<ResultadoFonte[]> {
  const { concorrencia = 4, deadline } = opts;
  const tarefas: { m: ModuloSpec; ano: number }[] = [];
  for (const ano of anos) {
    for (const m of modulos) tarefas.push({ m, ano });
  }

  const resultados: ResultadoFonte[] = [];
  let proxima = 0;
  let interrompido = false;

  async function worker(): Promise<void> {
    while (proxima < tarefas.length) {
      if (deadline && Date.now() > deadline) {
        interrompido = true;
        return;
      }
      const t = tarefas[proxima++];
      resultados.push(await ingerirFonte(t.m, t.ano));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concorrencia, tarefas.length) }, () =>
      worker(),
    ),
  );
  if (interrompido) {
    logger.warn(
      `NEXO — lote interrompido pelo deadline: ${resultados.length}/` +
        `${tarefas.length} ingestões concluídas; o restante segue na próxima execução`,
    );
  }
  return resultados;
}

// ── Segredo compartilhado ────────────────────────────────────────────────────

/**
 * Segredo compartilhado lido de `process.env.DIARIO_BACKFILL_SECRET`.
 * Em produção é injetado via `secrets:` na definição da função; no emulador
 * vem do `.env` local.
 */

// ── Cron diário ──────────────────────────────────────────────────────────────

export const onNexoColetaDiaria = onSchedule(
  {
    schedule: "15 4 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 1800,
    memory: "4GiB",
    // Hardening (#13): no máximo UMA execução simultânea do cron — evita que um
    // disparo atrasado/retry concorra com a execução em andamento e duplique
    // trabalho de coleta. (Lease/lock distribuído fica para onda posterior.)
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: a ingestão é deduplicada por hash
    // em `nexo_sync_state`, então reexecutar o cron após uma falha é seguro.
    // Reentrega o disparo em caso de erro, com backoff exponencial limitado.
    retryCount: 3,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    const anos = anosMonitorados();
    logger.info(
      `NEXO — coleta diária iniciada (${MODULOS.length} módulos × ` +
        `exercícios ${anos.join(", ")})`,
    );
    // Deadline 300s antes do timeout de 1800s — garante que nenhuma escrita
    // seja morta no meio pelo runtime.
    const resultados = await ingerirLote(MODULOS, anos, {
      concorrencia: 4,
      deadline: inicio + 1_500_000,
    });
    const erros = resultados.filter((r) => r.erro).length;
    const mudaram = resultados.filter((r) => r.mudou).length;
    logger.info(
      `NEXO — coleta diária concluída: ${resultados.length} ingestões, ` +
        `${mudaram} com mudança, ${erros} com erro`,
    );

    // ── Fase 2: detecção pré-computada ──────────────────────────────────────
    // APÓS a ingestão, roda o ciclo de detecção para cada exercício. Falha
    // aqui é logada mas NÃO derruba o cron — a coleta já foi persistida.
    let detErros = 0;
    let detAlertas = 0;
    let detResolvidos = 0;
    let detErroMsg: string | null = null;
    try {
      const deteccoes = await rodarDeteccao(anos, process.env.DIARIO_BACKFILL_SECRET || "");
      detErros = deteccoes.filter((d) => d.erro).length;
      detAlertas = deteccoes.reduce((s, d) => s + d.persistidos, 0);
      detResolvidos = deteccoes.reduce((s, d) => s + d.resolvidos, 0);
      detErroMsg = deteccoes.find((d) => d.erro)?.erro ?? null;
      logger.info(
        `NEXO — detecção concluída: ${detAlertas} alertas persistidos, ` +
          `${detResolvidos} reconciliados, ${detErros} exercícios com erro`,
      );
    } catch (err) {
      detErros = anos.length;
      detErroMsg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO — ciclo de detecção falhou (coleta preservada)", err);
    }

    // ── Fase 4/5: observabilidade da coleta diária ──────────────────────────
    // Grava um estado de saúde agregado do cron diário (separado dos estados
    // por módulo que `ingerirFonte` já escreve). Alimenta o painel de saúde.
    await gravarSyncState({
      syncId: "_coleta_diaria",
      fonte: "smarapd",
      colecao: "nexo_*",
      cadencia: "diario",
      // O cron "deu certo" se a coleta concluiu — erros isolados de módulo
      // viram estado `degradado`, não `falha` (cada módulo tem seu próprio doc).
      sucesso: true,
      degradado: erros > 0 || detErros > 0,
      erro: detErroMsg ?? (erros > 0 ? `${erros} módulo(s) com erro` : null),
      duracaoMs: Date.now() - inicio,
      extra: {
        ingestoes: resultados.length,
        modulosComErro: erros,
        modulosMudaram: mudaram,
        deteccaoAlertas: detAlertas,
        deteccaoResolvidos: detResolvidos,
        deteccaoErros: detErros,
      },
    });
  },
);

// ── Backfill HTTP sob demanda ────────────────────────────────────────────────

/**
 * GET /onNexoBackfillHttp?anos=2025,2026&modulos=all
 *   Header: x-backfill-secret: <SEGREDO>
 *
 * Dispara a ingestão imediata (seed retroativo) sem esperar o cron. `modulos`
 * aceita `all` ou uma lista csv de nomes de módulo (ver MODULOS). Responde com
 * o resumo por módulo/exercício.
 */
export const onNexoBackfillHttp = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 3600,
    memory: "4GiB",
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
    // Sem teto de exercícios por chamada: o deadline (3300s antes do timeout)
    // já interrompe o enfileiramento quando o runtime vai estourar — o trabalho
    // já persistido permanece e a próxima execução retoma (idempotência por hash
    // em `nexo_sync_state`). Floor 2013 = objetivo de histórico do F1.
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
        error:
          "Parâmetro 'anos' obrigatório (csv, ex.: anos=2025,2026; faixa 2013-2100).",
      });
      return;
    }

    const modulosParam = String(req.query.modulos ?? "all").toLowerCase();
    const modulos =
      modulosParam === "all"
        ? MODULOS
        : MODULOS.filter((m) =>
            modulosParam.split(/[,\s]+/).includes(m.nome),
          );
    if (modulos.length === 0) {
      res.status(400).json({
        error: `Nenhum módulo válido. Disponíveis: ${MODULOS.map((m) => m.nome).join(", ")}`,
      });
      return;
    }

    logger.info("NEXO — backfill HTTP iniciado.", {
      anos,
      modulos: modulos.map((m) => m.nome),
    });
    // Deadline 300s antes do timeout de 3600s.
    const resultados = await ingerirLote(modulos, anos, {
      concorrencia: 4,
      deadline: Date.now() + 3_300_000,
    });
    res.status(200).json({
      ok: true,
      ingestoes: resultados.length,
      comErro: resultados.filter((r) => r.erro).length,
      resultados,
    });
  },
);
