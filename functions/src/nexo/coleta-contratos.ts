/**
 * Cron de ingestão de CONTRATOS MUNICIPAIS — `onNexoSyncContratos`
 * (expansão Fase 3 do plano-mestre).
 *
 * Coleta os contratos da Prefeitura de Marília na fonte PRIMÁRIA de Dados
 * Abertos do portal institucional e persiste em `nexo_contratos_municipais`.
 * Para CADA contrato, registra também o documento-fonte no catálogo
 * `nexo_documentos` (TUDO LINKADO) com as chaves de linkage que costuram o
 * contrato ao empenho.
 *
 * ── A CHAVE QUE LIGA TUDO ─────────────────────────────────────────────────
 * O `numeroProcesso` é a CHAVE que conecta o contrato ao EMPENHO (e à
 * licitação). É o eixo do cruzamento "empenho × contrato": empenho sem
 * contrato, contrato sem empenho, valor divergente, etc.
 *
 * ── FORMA REAL DA FONTE (confirmada por WebFetch em 2026-06) ──────────────
 * GET https://www.marilia.sp.gov.br/portal/dados-abertos/contratos/{ano}
 *   → `{ dados: [ { ... } ] }`. Cada objeto expõe APENAS:
 *     numeroContrato (number), numeroProcesso (string), nomeContratada
 *     (string | NULL — frequentemente null), valorContrato (number),
 *     dataAssinatura, dataInicioVigencia, dataFimVigencia, dataVigencia,
 *     tipoLicitacao, situacao, tipo.
 *
 *   ⚠ O dados-abertos NÃO expõe `objeto` nem `cnpjContratada`. Ambos ficam
 *   `null` aqui — e, junto com `nomeContratada` quando vier null, são supridos
 *   pelo ENRIQUECIMENTO via página de detalhe do SMARAPD
 *   `https://www.marilia.sp.gov.br/portal/contrato/{id}` (ver TODO abaixo).
 *
 * ── ENRIQUECIMENTO SMARAPD (gancho, NÃO implementado aqui) ────────────────
 * A página `/portal/contrato/{id}` traz objeto, contratada (nome), CNPJ,
 * vigência, assinatura e os tokens de download do PDF (contrato + aditivos).
 * MAS o `{id}` é um inteiro sequencial INTERNO do portal — NÃO derivável de
 * `numeroContrato`/`numeroProcesso`; só descoberto scrapeando a listagem
 * `/portal/contratos` e casando por número + processo + contratada. Por isso
 * o scraping fica para uma onda posterior; aqui só deixamos o gancho:
 * `_enriquecimentoSmarapd: { necessario, motivo, urlListagem, urlBuscaDeepLink }`.
 *
 * Cadência: diária (05h35 BRT).
 *
 * Self-contained: o projeto `functions/` não importa de `src/` — re-implementa
 * o fetch ao dados-abertos. Reusa `registrarDocumentosLote` (catálogo) e
 * `gravarSyncState` (observabilidade), ambos do próprio `functions/`.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import {
  registrarDocumentosLote,
  type DocumentoPublico,
} from "./documentos";

/** Coleção de destino — contratos municipais (fonte Dados Abertos). */
const COLECAO = "nexo_contratos_municipais";
/** Fonte canônica para `_fonte` e para a chave `fonte` do documento. */
const FONTE = "dados-abertos";
/** Órgão emissor — sempre a Prefeitura (alvo único do NEXO). */
const ORGAO = "Prefeitura Municipal de Marília";

/** Base do portal institucional (Dados Abertos em /dados-abertos/{cat}/{ano}). */
const PORTAL_BASE = "https://www.marilia.sp.gov.br/portal";
const TIMEOUT_MS = 25_000;

/** UA de browser — o portal recusa/varia para clients sem UA reconhecível. */
const HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
};

// ── Normalizadores ───────────────────────────────────────────────────────────

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** `null` se vazio/ausente; senão a string trimada (preserva semântica de "não veio"). */
function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s ? s : null;
}

/** Converte valor BR (`1.234,56`) ou numérico para number; 0 em falha. */
function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const s = v.includes(",")
      ? v.replace(/\./g, "").replace(",", ".")
      : v;
    const n = Number(s.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

// ── Contrato municipal normalizado ───────────────────────────────────────────

interface ContratoMunicipal {
  numeroContrato: string;
  numeroProcesso: string;
  /** Objeto/descrição — o dados-abertos NÃO expõe; supridor é o SMARAPD. */
  objeto: string | null;
  /** CNPJ da contratada — o dados-abertos NÃO expõe; supridor é o SMARAPD. */
  cnpjContratada: string | null;
  /** Nome da contratada — frequentemente null no dados-abertos. */
  nomeContratada: string | null;
  valor: number;
  vigenciaInicio: string | null;
  vigenciaFim: string | null;
}

/**
 * Mapeia um registro bruto do dados-abertos para o contrato normalizado.
 * `objeto` e `cnpjContratada` são SEMPRE null nesta fonte (não os expõe);
 * permanecem como ganchos para o enriquecimento SMARAPD.
 */
function normalizarContrato(d: Record<string, unknown>): ContratoMunicipal {
  return {
    numeroContrato: str(d.numeroContrato),
    numeroProcesso: str(d.numeroProcesso),
    // Ausentes na fonte primária — preenchidos no enriquecimento SMARAPD.
    objeto: strOrNull(d.objeto ?? d.descricao),
    cnpjContratada: (() => {
      const dig = soDigitos(d.cnpjContratada ?? d.cnpj ?? d.documentoContratada);
      return dig || null;
    })(),
    nomeContratada: strOrNull(d.nomeContratada),
    valor: toNum(d.valorContrato),
    vigenciaInicio: strOrNull(d.dataInicioVigencia),
    vigenciaFim: strOrNull(d.dataFimVigencia ?? d.dataVigencia),
  };
}

// ── Fetch da fonte primária ──────────────────────────────────────────────────

/**
 * GET dos contratos de um exercício no dados-abertos. Lista vazia em
 * sentinela "Nenhum registro encontrado." Lança em erro de rede/HTTP.
 */
async function getContratos(
  ano: number,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${PORTAL_BASE}/dados-abertos/contratos/${ano}`, {
    headers: HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Dados Abertos contratos/${ano} HTTP ${res.status}`);
  }
  const json = (await res.json()) as { dados?: unknown };
  const dados = Array.isArray(json.dados) ? json.dados : [];
  // Sentinela de vazio: [["Nenhum registro encontrado."]].
  if (dados.length === 1 && Array.isArray(dados[0])) return [];
  return dados.filter(
    (d): d is Record<string, unknown> =>
      !!d && typeof d === "object" && !Array.isArray(d),
  );
}

// ── Linkage / documento-fonte ────────────────────────────────────────────────

/**
 * URL da listagem do portal e deep-link de busca pré-preenchida — usados como
 * `url` do documento e como gancho de enriquecimento. Marília NÃO expõe URL
 * canônica por número de contrato; o link forte (`/portal/contrato/{id}`) exige
 * descobrir o `{id}` interno, o que fica para a onda de enriquecimento.
 */
/**
 * Sanea um valor que vira UM segmento posicional da URL de busca do portal. A
 * barra é o separador de segmentos: um `numero`/`processo` cru como `128/TC/2023`
 * ou `38.716/2021` injetaria segmentos EXTRAS e desalinharia os filtros (o portal
 * lê por POSIÇÃO). Troca a barra (e demais delimitadores de path) por espaço
 * ANTES de `encodeURIComponent` — gêmeo de `enriquecimento-contratos.sanearSegmento`.
 */
function sanearSegmento(v: string): string {
  return v
    .replace(/[/\\#?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function urlBuscaContrato(c: ContratoMunicipal): string {
  // Sanea a barra ANTES de encodar (bug de barra, não WAF): barra crua/`%2F`
  // quebra a contagem de segmentos posicionais do portal.
  const contratada = encodeURIComponent(sanearSegmento(c.nomeContratada ?? "0") || "0");
  const numero = encodeURIComponent(sanearSegmento(c.numeroContrato) || "0");
  const processo = encodeURIComponent(sanearSegmento(c.numeroProcesso) || "0");
  // Filtros posicionais aceitos pela busca do portal (location.href no JS).
  return `${PORTAL_BASE}/contratos/1/0/${contratada}/${numero}/${processo}/0/9/0/0/0/0/0/0/0`;
}

/**
 * Monta o `DocumentoPublico` do catálogo `nexo_documentos` para um contrato.
 * As `chavesLinkage` são [numeroProcesso, numeroContrato, cnpj] (omitidas as
 * vazias) — o `numeroProcesso` é o que costura ao empenho.
 */
function documentoDoContrato(c: ContratoMunicipal): DocumentoPublico {
  const chaves: DocumentoPublico["chavesLinkage"] = [];
  if (c.numeroProcesso) chaves.push({ tipo: "processo", valor: c.numeroProcesso });
  if (c.numeroContrato) chaves.push({ tipo: "contrato", valor: c.numeroContrato });
  if (c.cnpjContratada) chaves.push({ tipo: "cnpj", valor: c.cnpjContratada });

  return {
    tipo: "contrato",
    orgao: ORGAO,
    data: c.vigenciaInicio,
    numeroProcesso: c.numeroProcesso || null,
    url: urlBuscaContrato(c),
    // O dados-abertos não dá deep-link de PDF; o token vive em /portal/contrato/{id}.
    pdfUrl: null,
    hash: null,
    chavesLinkage: chaves,
    fonte: FONTE,
    titulo: c.objeto ?? c.nomeContratada ?? `Contrato ${c.numeroContrato}`,
  };
}

// ── Persistência ─────────────────────────────────────────────────────────────

/**
 * ID determinístico do contrato — `{exercicio}-{numeroContrato|processo}`.
 * Reexecutar o cron com `merge` SOBRESCREVE, nunca duplica (retry idempotente).
 */
function idContrato(c: ContratoMunicipal, exercicio: number): string {
  const base = c.numeroContrato || c.numeroProcesso || "sem-id";
  return `${exercicio}-${base}`.replace(/[^\w-]/g, "_");
}

/**
 * Gancho de enriquecimento SMARAPD — marcado quando faltam objeto, CNPJ ou
 * nome. NÃO scrapeia agora; só registra o que falta e como obter
 * (`/portal/contrato/{id}`, com `{id}` a descobrir na listagem).
 */
function enriquecimentoSmarapd(
  c: ContratoMunicipal,
): Record<string, unknown> | null {
  const faltantes: string[] = [];
  if (!c.nomeContratada) faltantes.push("nomeContratada");
  if (!c.cnpjContratada) faltantes.push("cnpjContratada");
  if (!c.objeto) faltantes.push("objeto");
  if (faltantes.length === 0) return null;
  return {
    necessario: true,
    faltantes,
    motivo:
      "Dados Abertos não expõe objeto/CNPJ e por vezes vem com nomeContratada=null; " +
      "obter na página de detalhe do SMARAPD.",
    // TODO(enriquecimento): descobrir o {id} INTERNO do portal scrapeando
    // /portal/contratos (casar por numeroContrato + numeroProcesso + contratada),
    // então fazer GET de /portal/contrato/{id} para extrair objeto, contratada,
    // CNPJ e os tokens de download do PDF (contrato + aditivos). NÃO derivável
    // dos nossos campos — não implementar scraping aqui.
    urlListagem: `${PORTAL_BASE}/contratos`,
    urlBuscaDeepLink: urlBuscaContrato(c),
    urlDetalheTemplate: `${PORTAL_BASE}/contrato/{id}`,
  };
}

/** Persiste os contratos em `nexo_contratos_municipais`, em lotes de 400. */
async function persistirContratos(
  exercicio: number,
  contratos: ContratoMunicipal[],
): Promise<{ count: number; ids: Set<string> }> {
  let batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ids = new Set<string>();
  let n = 0;
  for (const c of contratos) {
    const id = idContrato(c, exercicio);
    if (ids.has(id)) continue;
    ids.add(id);
    // Campos que o ENRIQUECIMENTO SMARAPD preenche (objeto/cnpj/nome e os
    // espelhos _cnpj/_fornecedor) só entram no payload quando a FONTE primária
    // trouxe valor. O Dados Abertos devolve null para eles — e merge:true com
    // null/'' EXPLÍCITO sobrescreve: a coleta das 05h35 apagava todo dia o que
    // o cron das 06h05 tinha enriquecido, e `lerPendentes` (ok===true) nunca
    // re-enriquecia — perda permanente (auditoria 2026-06-09).
    const doc: Record<string, unknown> = {
      numeroContrato: c.numeroContrato,
      numeroProcesso: c.numeroProcesso,
      valor: c.valor,
      vigenciaInicio: c.vigenciaInicio,
      vigenciaFim: c.vigenciaFim,
      _exercicio: exercicio,
      _fonte: FONTE,
      // Eixo de cruzamento com o empenho — exposto cru p/ índice/consulta.
      _numeroProcesso: c.numeroProcesso,
      _valor: c.valor,
      // Gancho do enriquecimento SMARAPD (null quando nada falta).
      _enriquecimentoSmarapd: enriquecimentoSmarapd(c),
      _coletadoEm: now,
    };
    if (c.objeto) doc.objeto = c.objeto;
    if (c.cnpjContratada) {
      doc.cnpjContratada = c.cnpjContratada;
      doc._cnpj = c.cnpjContratada;
    }
    if (c.nomeContratada) {
      doc.nomeContratada = c.nomeContratada;
      doc._fornecedor = c.nomeContratada;
    }
    batch.set(db.collection(COLECAO).doc(id), doc, { merge: true });
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
 * Remove de `nexo_contratos_municipais` os contratos do exercício ausentes do
 * snapshot atual. Só roda em coleta ÍNTEGRA (não parcial) — numa coleta parcial
 * apagaria contratos válidos que não foram relidos.
 */
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

/** Exercícios cobertos: o corrente e o anterior. */
function exerciciosAlvo(): number[] {
  const atual = new Date().getFullYear();
  return [atual, atual - 1];
}

// ── Cron diário ──────────────────────────────────────────────────────────────

export const onNexoSyncContratos = onSchedule(
  {
    schedule: "35 5 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    // Hardening (#13): no máximo UMA execução simultânea — evita que um disparo
    // atrasado/retry concorra com a execução em andamento e refaça a coleta.
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: contratos têm doc ID determinístico
    // (`{exercicio}-{numeroContrato}`) com `merge`, e o catálogo `nexo_documentos`
    // usa docId determinístico — reexecutar após falha SOBRESCREVE, nunca duplica.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    const anos = exerciciosAlvo();
    let totalContratos = 0;
    let totalRemovidos = 0;
    let totalDocumentos = 0;
    let totalEnriquecerPendente = 0;
    let falhas = 0;
    let ultimoErro: string | null = null;

    for (const ano of anos) {
      try {
        const brutos = await getContratos(ano);
        const contratos = brutos.map(normalizarContrato);

        const { count, ids } = await persistirContratos(ano, contratos);
        totalContratos += count;

        // Catálogo de documentos (TUDO LINKADO) — 1 documento por contrato,
        // com chaves [processo, contrato, cnpj]. Idempotente (docId estável).
        const documentos = contratos.map(documentoDoContrato);
        totalDocumentos += await registrarDocumentosLote(documentos);

        totalEnriquecerPendente += contratos.filter(
          (c) => !c.nomeContratada || !c.cnpjContratada || !c.objeto,
        ).length;

        // Coleta de uma única requisição (não paginada) — íntegra ⇒ pode purgar.
        totalRemovidos += await purgarObsoletos(ano, ids);

        logger.info(
          `NEXO Contratos — ${ano}: ${count} contratos, ` +
            `${documentos.length} documentos catalogados`,
        );
      } catch (err) {
        falhas++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.error(`NEXO Contratos — falha no exercício ${ano}`, err);
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    const sucesso = falhas < anos.length;
    await gravarSyncState({
      syncId: "contratos_municipais",
      fonte: FONTE,
      colecao: COLECAO,
      cadencia: "diario",
      sucesso,
      degradado: falhas > 0,
      erro: falhas > 0 ? ultimoErro : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        exerciciosTentados: anos.length,
        exerciciosComFalha: falhas,
        registros: totalContratos,
        removidos: totalRemovidos,
        documentosCatalogados: totalDocumentos,
        // Quantos contratos aguardam enriquecimento SMARAPD (nome/CNPJ/objeto).
        pendentesEnriquecimentoSmarapd: totalEnriquecerPendente,
      },
    });
    logger.info(
      `NEXO Contratos — concluído: ${totalContratos} contratos, ` +
        `${totalDocumentos} documentos, ${totalRemovidos} obsoletos removidos, ` +
        `${totalEnriquecerPendente} aguardando enriquecimento SMARAPD, ` +
        `${falhas} falhas`,
    );
  },
);
