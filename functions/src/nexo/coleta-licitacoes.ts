/**
 * Cron de ingestão de LICITAÇÕES / EDITAIS / DISPENSAS — `onNexoSyncLicitacoes`
 * (expansão Fase 3 do plano-mestre).
 *
 * Coleta os processos licitatórios da Prefeitura de Marília na fonte PRIMÁRIA de
 * Dados Abertos do portal institucional e persiste em `nexo_licitacoes`. Para
 * CADA processo, registra também o documento-fonte no catálogo
 * `nexo_documentos` (TUDO LINKADO), com `numeroProcesso` como chave de linkage
 * que costura o edital/dispensa ao EMPENHO e ao CONTRATO.
 *
 * ── A CHAVE QUE LIGA TUDO ─────────────────────────────────────────────────
 * O `numeroProcesso` é a CHAVE que conecta a licitação ao EMPENHO e ao
 * CONTRATO. É o eixo do cruzamento "licitação × empenho × contrato": dispensa
 * sem empenho, empenho sem licitação, fracionamento de dispensa, etc.
 *
 * ── DUAS CATEGORIAS, DUAS NATUREZAS ───────────────────────────────────────
 * O portal separa os processos em DUAS categorias de dados abertos, ambas com
 * o MESMO formato de registro:
 *   - `licitacoes`    → EDITAIS de licitação formal (Pregão Eletrônico,
 *                       Concorrência, Tomada de Preços, Leilão, Concurso…).
 *   - `compra-direta` → contratações diretas: "Dispensa", "Inexigibilidade",
 *                       "ADESÃO A ATA DE REGISTRO DE PREÇOS".
 * Coletamos AS DUAS e gravamos na MESMA coleção `nexo_licitacoes`, derivando o
 * `tipo` (`edital` | `dispensa` | `inexigibilidade` | `adesao`) da `modalidade`.
 *
 * ── FORMA REAL DA FONTE (confirmada por WebFetch em 2026-06) ──────────────
 * GET https://www.marilia.sp.gov.br/portal/dados-abertos/{licitacoes|compra-direta}/{ano}
 *   → `{ dados: [ { ... } ] }`. Cada objeto expõe APENAS:
 *     titulo (string), numeroEdital (number), numeroProcesso (number),
 *     modalidade (string), situacao (string), descricao (string, com entidades
 *     HTML), dataPostagem, dataRealizacao, dataAtualizacao.
 *
 *   ⚠ O dados-abertos NÃO expõe `objeto`, `valorEstimado` nem `dataAbertura`
 *   como campos próprios. Mapeamos por aproximação HONESTA:
 *     - `objeto`        ← `titulo` (fallback `descricao` saneada de HTML);
 *     - `dataAbertura`  ← `dataRealizacao` (a sessão/abertura) normalizada p/ YYYY-MM-DD;
 *     - `valorEstimado` ← null (a fonte NÃO o expõe — gancho de enriquecimento).
 *
 * Cadência: diária (05h45 BRT) — logo após contratos (05h35), para que ambos os
 * lados do par licitação×contrato fiquem frescos no mesmo ciclo matinal.
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
  type TipoDocumento,
} from "./documentos";

/** Coleção de destino — processos licitatórios (fonte Dados Abertos). */
const COLECAO = "nexo_licitacoes";
/** Fonte canônica para `_fonte` e para a chave `fonte` do documento. */
const FONTE = "dados-abertos";
/** Órgão emissor — sempre a Prefeitura (alvo único do NEXO). */
const ORGAO = "Prefeitura Municipal de Marília";

/** Base do portal institucional (Dados Abertos em /dados-abertos/{cat}/{ano}). */
const PORTAL_BASE = "https://www.marilia.sp.gov.br/portal";
const TIMEOUT_MS = 25_000;

/**
 * Categorias de dados abertos que alimentam `nexo_licitacoes`. `licitacoes`
 * traz os EDITAIS formais; `compra-direta` traz dispensas/inexigibilidades/
 * adesões. Mesmo formato de registro nas duas.
 */
const CATEGORIAS = ["licitacoes", "compra-direta"] as const;
type Categoria = (typeof CATEGORIAS)[number];

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

/** `null` se vazio/ausente; senão a string trimada (preserva "não veio"). */
function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s ? s : null;
}

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

/**
 * Decodifica as entidades HTML mais comuns que o portal devolve em `descricao`
 * (ç, ã, á, etc.) e remove tags, para um `objeto`/`titulo` legível. Best-effort
 * — não pretende ser um parser de HTML completo.
 */
function limparHtml(v: unknown): string {
  let s = str(v);
  if (!s) return "";
  s = s.replace(/<[^>]+>/g, " ");
  const ent: Record<string, string> = {
    "&aacute;": "á", "&eacute;": "é", "&iacute;": "í", "&oacute;": "ó",
    "&uacute;": "ú", "&acirc;": "â", "&ecirc;": "ê", "&ocirc;": "ô",
    "&atilde;": "ã", "&otilde;": "õ", "&ccedil;": "ç", "&agrave;": "à",
    "&Aacute;": "Á", "&Eacute;": "É", "&Iacute;": "Í", "&Oacute;": "Ó",
    "&Uacute;": "Ú", "&Acirc;": "Â", "&Ecirc;": "Ê", "&Ocirc;": "Ô",
    "&Atilde;": "Ã", "&Otilde;": "Õ", "&Ccedil;": "Ç", "&Agrave;": "À",
    "&ordm;": "º", "&ordf;": "ª", "&nbsp;": " ", "&amp;": "&",
    "&quot;": '"', "&lt;": "<", "&gt;": ">", "&#39;": "'",
  };
  s = s.replace(/&[a-zA-Z#0-9]+;/g, (m) => ent[m] ?? m);
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Normaliza uma data do portal (`YYYY-MM-DD HH:MM:SS` ou `DD/MM/YYYY`) para
 * `YYYY-MM-DD`. `null` quando ausente/irreconhecível.
 */
function toIsoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  // `2025-12-05 08:00:00` → pega o prefixo de data.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // `05/12/2025` → reordena.
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

// ── Licitação normalizada ────────────────────────────────────────────────────

/** Tipo derivado da modalidade — eixo da distinção edital × contratação direta. */
type TipoLicitacao = "edital" | "dispensa" | "inexigibilidade" | "adesao";

interface Licitacao {
  numeroProcesso: string;
  numeroEdital: string;
  modalidade: string;
  /** Objeto/descrição — derivado de titulo (fallback descricao saneada). */
  objeto: string | null;
  situacao: string | null;
  /** Data de abertura/realização da sessão, em YYYY-MM-DD. */
  dataAbertura: string | null;
  /** Valor estimado — a fonte NÃO o expõe; gancho de enriquecimento (null). */
  valorEstimado: number | null;
  /** Classificação derivada da modalidade. */
  tipo: TipoLicitacao;
}

/**
 * Deriva o `tipo` a partir da `modalidade` textual. Dispensa/inexigibilidade/
 * adesão são contratações DIRETAS; o resto (Pregão, Concorrência, etc.) é
 * `edital` de licitação formal.
 */
function classificarModalidade(modalidade: string): TipoLicitacao {
  const m = modalidade.toLowerCase();
  if (m.includes("inexig")) return "inexigibilidade";
  if (m.includes("dispensa")) return "dispensa";
  if (m.includes("ades")) return "adesao";
  return "edital";
}

/** Mapeia um registro bruto do dados-abertos para a licitação normalizada. */
function normalizarLicitacao(d: Record<string, unknown>): Licitacao {
  const modalidade = str(d.modalidade);
  // `objeto`: a fonte não expõe campo próprio; o `titulo` é a melhor descrição,
  // com `descricao` (HTML) saneada como fallback.
  const objeto =
    strOrNull(d.objeto) ??
    strOrNull(d.titulo) ??
    strOrNull(limparHtml(d.descricao));
  // `valorEstimado`: ausente na fonte — fica null (gancho de enriquecimento).
  const valorBruto = d.valorEstimado ?? d.valor ?? d.valorReferencia;
  return {
    numeroProcesso: str(d.numeroProcesso),
    numeroEdital: str(d.numeroEdital),
    modalidade,
    objeto,
    situacao: strOrNull(d.situacao),
    // `dataAbertura` ← `dataRealizacao` (a sessão/abertura); fallback postagem.
    dataAbertura: toIsoDate(d.dataAbertura ?? d.dataRealizacao ?? d.dataPostagem),
    valorEstimado: valorBruto == null ? null : toNum(valorBruto) || null,
    tipo: classificarModalidade(modalidade),
  };
}

// ── Fetch da fonte primária ──────────────────────────────────────────────────

/**
 * GET de uma categoria/exercício no dados-abertos. Lista vazia na sentinela
 * "Nenhum registro encontrado." Lança em erro de rede/HTTP.
 */
async function getCategoria(
  categoria: Categoria,
  ano: number,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${PORTAL_BASE}/dados-abertos/${categoria}/${ano}`, {
    headers: HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Dados Abertos ${categoria}/${ano} HTTP ${res.status}`);
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
 * URL da listagem do portal para a categoria — usada como `url` do documento e
 * gancho de navegação. Marília NÃO expõe URL canônica por número de processo no
 * dados-abertos; o deep-link forte exige o `{id}` interno (onda de enriquecimento).
 */
function urlListagem(categoria: Categoria): string {
  // Forma POSICIONAL do SiGoverno — `/portal/editais/{tipo}` (1 = licitação,
  // 4 = Compra Direta), verificada ao vivo (HTTP 200). As rotas antigas
  // `/portal/licitacoes` e `/portal/compras-diretas` NUNCA existiram (404) —
  // todo "Documento-fonte" persistido apontava pro vazio (visto pelo dono em
  // prod, 2026-06-10). Espelha `urlListagemLicitacoes`/`urlListagemCompras
  // Diretas` de src/lib/nexo/links-doc.ts (functions não importa de src/).
  return categoria === "compra-direta"
    ? `${PORTAL_BASE}/editais/4`
    : `${PORTAL_BASE}/editais/1`;
}

/** Mapeia o `tipo` da licitação para o tipo canônico do catálogo de documentos. */
function tipoDocumento(t: TipoLicitacao): TipoDocumento {
  // O catálogo distingue `dispensa` e `inexigibilidade`; adesão e edital formal
  // entram como `edital` (peça licitatória).
  if (t === "dispensa") return "dispensa";
  if (t === "inexigibilidade") return "inexigibilidade";
  return "edital";
}

/**
 * Monta o `DocumentoPublico` do catálogo `nexo_documentos` para uma licitação.
 * As `chavesLinkage` são [processo, licitacao] — o `numeroProcesso` é o que
 * costura ao empenho e ao contrato.
 */
function documentoDaLicitacao(
  l: Licitacao,
  categoria: Categoria,
): DocumentoPublico {
  const chaves: DocumentoPublico["chavesLinkage"] = [];
  if (l.numeroProcesso) chaves.push({ tipo: "processo", valor: l.numeroProcesso });
  if (l.numeroEdital) chaves.push({ tipo: "licitacao", valor: l.numeroEdital });

  return {
    tipo: tipoDocumento(l.tipo),
    orgao: ORGAO,
    data: l.dataAbertura,
    numeroProcesso: l.numeroProcesso || null,
    url: urlListagem(categoria),
    // O dados-abertos não dá deep-link de PDF do edital; token vive no detalhe.
    pdfUrl: null,
    hash: null,
    chavesLinkage: chaves,
    fonte: FONTE,
    titulo:
      l.objeto ??
      `${l.modalidade} ${l.numeroEdital}`.trim() ??
      `Processo ${l.numeroProcesso}`,
  };
}

// ── Persistência ─────────────────────────────────────────────────────────────

/**
 * ID determinístico — `{exercicio}-{categoria}-{numeroProcesso|edital}`. Inclui
 * a categoria porque `numeroProcesso` reinicia por categoria a cada ano
 * (licitação 127 e compra-direta 127 coexistem). Reexecutar o cron com `merge`
 * SOBRESCREVE, nunca duplica (retry idempotente).
 */
function idLicitacao(
  l: Licitacao,
  categoria: Categoria,
  exercicio: number,
): string {
  const base = l.numeroProcesso || l.numeroEdital || "sem-id";
  return `${exercicio}-${categoria}-${base}`.replace(/[^\w-]/g, "_");
}

/** Persiste as licitações em `nexo_licitacoes`, em lotes de 400. */
async function persistirLicitacoes(
  exercicio: number,
  categoria: Categoria,
  licitacoes: Licitacao[],
): Promise<{ count: number; ids: Set<string> }> {
  let batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const ids = new Set<string>();
  let n = 0;
  for (const l of licitacoes) {
    const id = idLicitacao(l, categoria, exercicio);
    if (ids.has(id)) continue;
    ids.add(id);
    batch.set(
      db.collection(COLECAO).doc(id),
      {
        numeroProcesso: l.numeroProcesso,
        numeroEdital: l.numeroEdital,
        modalidade: l.modalidade,
        objeto: l.objeto,
        situacao: l.situacao,
        dataAbertura: l.dataAbertura,
        valorEstimado: l.valorEstimado,
        // `tipo` só faz sentido para contratação direta; para edital formal é
        // null (a modalidade já o descreve). Marcamos quando dispensa/inexig/adesão.
        tipo: l.tipo === "edital" ? null : l.tipo,
        _exercicio: exercicio,
        _categoria: categoria,
        _fonte: FONTE,
        // Eixo de cruzamento com empenho/contrato — exposto cru p/ índice/consulta.
        _numeroProcesso: l.numeroProcesso,
        _modalidade: l.modalidade,
        _tipo: l.tipo,
        // Gancho: valorEstimado ausente na fonte ⇒ aguarda enriquecimento.
        _enriquecimentoValor: l.valorEstimado == null,
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
 * Remove de `nexo_licitacoes` os registros do exercício+categoria ausentes do
 * snapshot atual. Só roda em coleta ÍNTEGRA (não parcial) — numa coleta parcial
 * apagaria registros válidos que não foram relidos.
 */
async function purgarObsoletos(
  exercicio: number,
  categoria: Categoria,
  idsAtuais: Set<string>,
): Promise<number> {
  const snap = await db
    .collection(COLECAO)
    .where("_exercicio", "==", exercicio)
    .where("_categoria", "==", categoria)
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

export const onNexoSyncLicitacoes = onSchedule(
  {
    schedule: "45 5 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    // Hardening (#13): no máximo UMA execução simultânea — evita que um disparo
    // atrasado/retry concorra com a execução em andamento e refaça a coleta.
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: licitações têm doc ID determinístico
    // (`{exercicio}-{categoria}-{numeroProcesso}`) com `merge`, e o catálogo
    // `nexo_documentos` usa docId determinístico — reexecutar após falha
    // SOBRESCREVE, nunca duplica.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    const anos = exerciciosAlvo();
    let totalLicitacoes = 0;
    let totalDispensas = 0;
    let totalRemovidos = 0;
    let totalDocumentos = 0;
    let totalSemValor = 0;
    let falhas = 0;
    let tentativas = 0;
    let ultimoErro: string | null = null;

    for (const ano of anos) {
      for (const categoria of CATEGORIAS) {
        tentativas++;
        try {
          const brutos = await getCategoria(categoria, ano);
          const licitacoes = brutos.map(normalizarLicitacao);

          const { count, ids } = await persistirLicitacoes(
            ano,
            categoria,
            licitacoes,
          );
          totalLicitacoes += count;
          totalDispensas += licitacoes.filter((l) => l.tipo !== "edital").length;
          totalSemValor += licitacoes.filter((l) => l.valorEstimado == null).length;

          // Catálogo de documentos (TUDO LINKADO) — 1 documento por processo,
          // com chaves [processo, licitacao]. Idempotente (docId estável).
          const documentos = licitacoes.map((l) =>
            documentoDaLicitacao(l, categoria),
          );
          totalDocumentos += await registrarDocumentosLote(documentos);

          // Coleta de uma única requisição (não paginada) — íntegra ⇒ pode purgar.
          totalRemovidos += await purgarObsoletos(ano, categoria, ids);

          logger.info(
            `NEXO Licitações — ${categoria}/${ano}: ${count} registros, ` +
              `${documentos.length} documentos catalogados`,
          );
        } catch (err) {
          falhas++;
          ultimoErro = err instanceof Error ? err.message : String(err);
          logger.error(
            `NEXO Licitações — falha em ${categoria}/${ano}`,
            err,
          );
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const sucesso = falhas < tentativas;
    await gravarSyncState({
      syncId: "licitacoes",
      fonte: FONTE,
      colecao: COLECAO,
      cadencia: "diario",
      sucesso,
      degradado: falhas > 0,
      erro: falhas > 0 ? ultimoErro : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        coletasTentadas: tentativas,
        coletasComFalha: falhas,
        registros: totalLicitacoes,
        dispensasInexigibilidades: totalDispensas,
        removidos: totalRemovidos,
        documentosCatalogados: totalDocumentos,
        // Quantas licitações aguardam enriquecimento de valor estimado.
        pendentesValorEstimado: totalSemValor,
      },
    });
    logger.info(
      `NEXO Licitações — concluído: ${totalLicitacoes} registros ` +
        `(${totalDispensas} dispensas/inexigibilidades), ` +
        `${totalDocumentos} documentos, ${totalRemovidos} obsoletos removidos, ` +
        `${totalSemValor} sem valor estimado, ${falhas} falhas`,
    );
  },
);
