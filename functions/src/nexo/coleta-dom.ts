/**
 * Cron de ingestão do DOM full-text — `onNexoColetaDom` (Fase 3 do plano-mestre).
 *
 * Coleta o Diário Oficial do Município de Marília via Querido Diário (Open
 * Knowledge Brasil), indexado por território IBGE (3529005), e persiste cada
 * edição em `nexo_diario_dom`. Para cada edição também REGISTRA um documento no
 * catálogo `nexo_documentos` (via `registrarDocumento`), com `tipo:'dom-edicao'`
 * — é assim que o DOM entra no grafo "TUDO LINKADO".
 *
 * O elo DOM ↔ empenho é o número de PROCESSO / DISPENSA / INEXIGIBILIDADE: o
 * coletor baixa o texto extraído (`.txt`) de cada edição e varre por esses
 * números via regex, jogando-os em `chavesLinkage`. O motor de linkage
 * (`nexo_links`) casa essas chaves com as do empenho (que carrega o mesmo nº de
 * processo) e costura a edição do DOM ao gasto correspondente.
 *
 * Endpoint (confirmado por inspeção em jun/2026):
 *   GET https://api.queridodiario.ok.org.br/gazettes
 *       ?territory_ids=3529005
 *       &published_since=YYYY-MM-DD&published_until=YYYY-MM-DD
 *       &size=<n>&offset=<n>
 *   → { total_gazettes, gazettes: [{ date, edition, is_extra_edition,
 *        url, txt_url, territory_id, ... }] }
 *   Paginação por `size` + `offset`; `total_gazettes` é o total do filtro.
 *
 * Incremental por data: usa o último `ate` bem-sucedido gravado em
 * `nexo_sync_state` como ponto de partida (com folga de re-overlap para edições
 * que entrem no índice com atraso); na primeira execução cai no lookback padrão.
 *
 * Cadência: diária. `maxInstances: 1` — nunca duas execuções concorrentes.
 *
 * Self-contained: re-implementa o fetch ao Querido Diário (não importa de
 * `src/`). Idempotente: doc ID determinístico por edição + `merge`, e o catálogo
 * usa o `docId` determinístico de `registrarDocumento`.
 */
import { createHash } from "node:crypto";

import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import { registrarDocumento, type ChaveLinkage } from "./documentos";

/** Base da API pública do Querido Diário (sem autenticação). */
const QD_BASE = "https://api.queridodiario.ok.org.br";
/** Marília-SP — código IBGE do território no Querido Diário. */
const MARILIA_IBGE = "3529005";
const MARILIA_ORGAO = "Prefeitura Municipal de Marília";

const TIMEOUT_MS = 25_000;
/** Tamanho de página da listagem (teto do Querido Diário é 100). */
const PAGE_SIZE = 100;
/** Teto de páginas por ciclo — proteção contra loop em filtro muito largo. */
const MAX_PAGINAS = 50;
/**
 * Lookback (dias) usado quando não há cursor anterior. 14 dias cobre o
 * intervalo entre uma estreia e o backfill manual sem buracos.
 */
const LOOKBACK_DIAS = 14;
/**
 * Folga (dias) que recuamos a partir do último `ate` bem-sucedido. Edições
 * podem entrar no índice do Querido Diário com alguns dias de atraso; o overlap
 * é seguro porque a gravação é idempotente (UPSERT por edição).
 */
const OVERLAP_DIAS = 3;

/** UA de browser — algumas camadas de CDN recusam clients sem UA. */
const QD_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
};

/** Edição do DOM como vem do Querido Diário (campos que usamos). */
interface QdGazette {
  date?: string;
  edition?: string | number;
  is_extra_edition?: boolean;
  url?: string;
  txt_url?: string;
  territory_id?: string;
}

interface QdResposta {
  total_gazettes?: number;
  gazettes?: QdGazette[];
}

/** Edição normalizada para persistência/catalogação. */
interface EdicaoDom {
  /** Data da edição (YYYY-MM-DD). */
  data: string;
  /** Número da edição, quando exposto. */
  edicao: string | null;
  edicaoExtra: boolean;
  /** URL do PDF oficial (a prova). */
  urlPdf: string;
  /** URL do texto extraído (.txt), quando disponível. */
  txtUrl: string | null;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** Lista uma página de edições do DOM por intervalo de publicação. */
async function listarPagina(
  desde: string,
  ate: string,
  offset: number,
): Promise<QdResposta> {
  const url = new URL(`${QD_BASE}/gazettes`);
  url.searchParams.set("territory_ids", MARILIA_IBGE);
  url.searchParams.set("published_since", desde);
  url.searchParams.set("published_until", ate);
  url.searchParams.set("size", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));

  const res = await fetch(url.toString(), {
    headers: QD_HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Querido Diário /gazettes HTTP ${res.status}`);
  return (await res.json()) as QdResposta;
}

/**
 * Varre todas as páginas de edições no intervalo (limitado por `MAX_PAGINAS`).
 * Uma falha em página intermediária devolve o que já veio, marcando parcial —
 * o cursor incremental não avança numa coleta parcial.
 */
async function coletarEdicoes(
  desde: string,
  ate: string,
): Promise<{ edicoes: EdicaoDom[]; parcial: boolean }> {
  const out: EdicaoDom[] = [];
  let parcial = false;
  let total = Infinity;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const offset = pagina * PAGE_SIZE;
    if (offset >= total) break;
    try {
      const resp = await listarPagina(desde, ate, offset);
      total = Number(resp.total_gazettes ?? 0);
      const lote = resp.gazettes ?? [];
      for (const g of lote) {
        const data = String(g.date ?? "").slice(0, 10);
        const urlPdf = String(g.url ?? "");
        if (!data || !urlPdf) continue;
        out.push({
          data,
          edicao:
            g.edition != null && g.edition !== "" ? String(g.edition) : null,
          edicaoExtra: g.is_extra_edition === true,
          urlPdf,
          txtUrl: g.txt_url ? String(g.txt_url) : null,
        });
      }
      // Página vazia antes do total declarado: nada mais a paginar.
      if (lote.length === 0) break;
    } catch (err) {
      parcial = true;
      logger.warn(
        `NEXO DOM — falha na página offset=${offset} ` +
          `(${desde}..${ate}); coleta parcial com ${out.length} edições. ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { edicoes: out, parcial };
}

/**
 * Baixa o texto extraído (.txt) de uma edição. Best-effort: edições sem texto
 * (ou cujo download falhe) voltam string vazia — a edição ainda é catalogada,
 * só sem as chaves de processo. Limita o tamanho lido para não estourar memória.
 */
const TXT_TIMEOUT_MS = 30_000;
const TXT_MAX_BYTES = 8 * 1024 * 1024; // 8 MB de texto cobre edições grandes.

async function baixarTexto(txtUrl: string | null): Promise<string> {
  if (!txtUrl) return "";
  try {
    const res = await fetch(txtUrl, {
      headers: { "User-Agent": QD_HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(TXT_TIMEOUT_MS),
    });
    if (!res.ok) return "";
    const buf = await res.arrayBuffer();
    const slice =
      buf.byteLength > TXT_MAX_BYTES ? buf.slice(0, TXT_MAX_BYTES) : buf;
    return Buffer.from(slice).toString("utf8");
  } catch (err) {
    logger.debug(
      `NEXO DOM — texto indisponível (${txtUrl}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return "";
  }
}

// ── Extração de chaves de linkage (DOM ↔ empenho) ────────────────────────────

/**
 * Padrões de número de PROCESSO administrativo/licitatório e de DISPENSA/
 * INEXIGIBILIDADE no corpo do DOM. Capturam o identificador logo após o rótulo,
 * tolerando "nº", "n.", "no", ":" e espaços. O número costuma vir como
 * `12345/2026`, `12.345/2026` ou `123/26`.
 *
 * `g` + `i` para varrer todas as ocorrências, case-insensitive.
 */
const NUM_DEPOIS_DO_ROTULO =
  "[\\s:.\\-nNºo°]*\\s*(\\d{1,6}(?:[.]\\d{3})*\\s*[/]\\s*\\d{2,4})";

const RX_PROCESSO = new RegExp(
  `processo(?:\\s+(?:administrativo|licitat[óo]rio|n[º°o.]?))?${NUM_DEPOIS_DO_ROTULO}`,
  "gi",
);
const RX_DISPENSA = new RegExp(
  `dispensa(?:\\s+de\\s+licita[çc][ãa]o)?${NUM_DEPOIS_DO_ROTULO}`,
  "gi",
);
const RX_INEXIGIBILIDADE = new RegExp(
  `inexigibilidade(?:\\s+de\\s+licita[çc][ãa]o)?${NUM_DEPOIS_DO_ROTULO}`,
  "gi",
);

/** Teto de chaves por edição — evita catalogar um índice de centenas de nºs. */
const MAX_CHAVES_POR_EDICAO = 200;

/** Normaliza um nº de processo capturado: tira espaços, mantém dígitos e `/`. */
function normProcesso(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/[.]/g, "");
}

/**
 * Varre o texto da edição e extrai chaves de linkage por nº de processo /
 * dispensa / inexigibilidade. Desduplica por (tipo:valor). É essas chaves que,
 * casadas com as do empenho, ligam o DOM ao gasto.
 */
function extrairChaves(texto: string): ChaveLinkage[] {
  if (!texto) return [];
  const vistos = new Set<string>();
  const chaves: ChaveLinkage[] = [];

  const colher = (rx: RegExp, tipo: string) => {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(texto)) !== null) {
      const valor = normProcesso(m[1] ?? "");
      if (!valor) continue;
      const canon = `${tipo}:${valor}`;
      if (vistos.has(canon)) continue;
      vistos.add(canon);
      chaves.push({ tipo, valor });
      if (chaves.length >= MAX_CHAVES_POR_EDICAO) return;
    }
  };

  colher(RX_PROCESSO, "processo");
  if (chaves.length < MAX_CHAVES_POR_EDICAO) colher(RX_DISPENSA, "dispensa");
  if (chaves.length < MAX_CHAVES_POR_EDICAO)
    colher(RX_INEXIGIBILIDADE, "inexigibilidade");

  return chaves;
}

// ── Extração de NOMEAÇÕES / EXONERAÇÕES / DESIGNAÇÕES (perna assessor/cargo) ──
//
// Destrava a perna "assessor/cargo público" do cruzamento que o plano dava como
// data-blocked (§4): o DOM full-text TRAZ os atos de pessoal e é parseável. Aqui
// extraímos, do texto da edição, atos de NOMEAÇÃO/EXONERAÇÃO/DESIGNAÇÃO com o
// nome do servidor, cargo/função, secretaria e matrícula quando presentes, e
// gravamos em `nexo_nomeacoes` (docId determinístico, idempotente).
//
// HONESTIDADE: o layout do DOM varia (Portaria, Decreto, texto corrido). A regex
// é ROBUSTA mas não onisciente — só extraímos o que o texto traz; campos
// ausentes ficam null (degradação honesta, NUNCA inventamos vínculo). Cada ato
// guarda um TRECHO da fonte (`trecho`) para auditoria humana do parse.

/** Tipo do ato de pessoal extraído. */
type TipoAto = "nomeacao" | "exoneracao" | "designacao";

interface AtoPessoal {
  tipo: TipoAto;
  /** Nome do servidor (em caixa-alta, como aparece no DOM). */
  nome: string;
  /** Cargo/função quando o texto traz ("para o cargo de ..."). */
  cargo: string | null;
  /** Matrícula/registro funcional quando presente. */
  matricula: string | null;
  /** Secretaria/lotação quando presente. */
  secretaria: string | null;
  /** Nº do ato (Portaria/Decreto) quando presente. */
  ato: string | null;
  /** Trecho-fonte (limitado) para auditoria do parse. */
  trecho: string;
}

/**
 * Núcleo do nome próprio em maiúsculas: 2+ palavras (cada 2+ letras), tolerando
 * acentos e conectivos minúsculos (DA/DE/DO/DOS/E). Casa "JOAO DA SILVA SANTOS".
 */
const NOME_PROPRIO =
  "([A-ZÀ-Ý][A-ZÀ-Ý.]+(?:\\s+(?:DA|DE|DO|DAS|DOS|E|[A-ZÀ-Ý][A-ZÀ-Ý.]+)){1,5})";

/**
 * Verbos de ato de pessoal por tipo. O DOM usa formas como "Fica nomeado(a) o(a)
 * Sr(a). FULANO", "NOMEAR FULANO", "exonerar, a pedido, FULANO", "designar
 * FULANO". Capturamos o NOME logo após o verbo, tolerando artigos/pronomes de
 * tratamento ("o(a) Sr(a).", "a servidora").
 */
const PREFIXO_ALVO =
  "(?:\\s*,?\\s*a\\s+pedido\\s*,?)?\\s*(?:o|a|os|as|o\\(a\\)|a\\(o\\))?\\s*" +
  "(?:sr[a]?\\.?\\(?a?\\)?\\.?|senhor[a]?|servidor[a]?\\(?a?\\)?)?\\s*:?\\s*";

function rxAto(verbos: string): RegExp {
  return new RegExp(`(?:${verbos})${PREFIXO_ALVO}${NOME_PROPRIO}`, "gi");
}

const RX_NOMEACAO = rxAto("nomear|fica(?:m)?\\s+nomead[oa]s?|nome(?:ia|iam)");
const RX_EXONERACAO = rxAto(
  "exonerar|fica(?:m)?\\s+exonerad[oa]s?|exoner(?:a|am)",
);
const RX_DESIGNACAO = rxAto(
  "designar|fica(?:m)?\\s+designad[oa]s?|design(?:a|am)",
);

/** Cargo após "para o cargo de ..." / "para exercer a função de ...". */
const RX_CARGO =
  /para\s+(?:o\s+cargo\s+de|exercer\s+(?:o\s+cargo|a\s+fun[çc][ãa]o)\s+de|a\s+fun[çc][ãa]o\s+de)\s+([^,.;\n]{3,80})/i;
/** Matrícula / registro funcional. */
const RX_MATRICULA =
  /(?:matr[íi]cula|registro\s+funcional|reg\.?\s+func\.?)[\s:nº.\-]*([\d./-]{2,20})/i;
/** Secretaria / lotação. */
const RX_SECRETARIA =
  /(?:junto\s+[àa]\s+|na\s+|da\s+|lota[çc][ãa]o[\s:]+)?(secretaria\s+(?:municipal\s+)?d[eao]s?\s+[^,.;\n]{3,70})/i;
/** Nº do ato (Portaria/Decreto) — geralmente no início do bloco. */
const RX_ATO = /\b(portaria|decreto|resolu[çc][ãa]o)\s*n?[º°o.]*\s*([\d./-]{1,15})/i;

/** Teto de atos por edição — uma edição pode trazer uma lista grande. */
const MAX_ATOS_POR_EDICAO = 300;
/** Janela de contexto (chars) após o nome, onde caçamos cargo/matrícula/sec. */
const JANELA_CTX = 240;

function limpar(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function acharNa(janela: string, rx: RegExp, grupo = 1): string | null {
  const m = janela.match(rx);
  const v = m ? limpar(m[grupo] ?? "") : "";
  return v || null;
}

/**
 * Varre o texto da edição por atos de pessoal. Para cada match do verbo+nome,
 * olha uma JANELA à frente para extrair cargo/matrícula/secretaria/ato. Desdup
 * por (tipo:nome:cargo). Best-effort: se o nome não vier, pula (não inventa).
 */
function extrairNomeacoes(texto: string): AtoPessoal[] {
  if (!texto) return [];
  const vistos = new Set<string>();
  const atos: AtoPessoal[] = [];

  const colher = (rx: RegExp, tipo: TipoAto) => {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(texto)) !== null) {
      const nome = limpar(m[1] ?? "");
      // Filtra falsos positivos óbvios (nomes curtos demais ou só conectivos).
      if (!nome || nome.replace(/\s/g, "").length < 6) continue;
      const ini = m.index;
      const janela = texto.slice(ini, ini + JANELA_CTX);
      const ato: AtoPessoal = {
        tipo,
        nome,
        cargo: acharNa(janela, RX_CARGO),
        matricula: acharNa(janela, RX_MATRICULA),
        secretaria: acharNa(janela, RX_SECRETARIA),
        ato: (() => {
          const mm = janela.match(RX_ATO);
          return mm ? limpar(`${mm[1]} ${mm[2]}`) : null;
        })(),
        trecho: limpar(janela).slice(0, 200),
      };
      const canon = `${tipo}:${nome}:${ato.cargo ?? ""}`;
      if (vistos.has(canon)) continue;
      vistos.add(canon);
      atos.push(ato);
      if (atos.length >= MAX_ATOS_POR_EDICAO) return;
    }
  };

  colher(RX_NOMEACAO, "nomeacao");
  if (atos.length < MAX_ATOS_POR_EDICAO) colher(RX_EXONERACAO, "exoneracao");
  if (atos.length < MAX_ATOS_POR_EDICAO) colher(RX_DESIGNACAO, "designacao");

  return atos;
}

// ── Persistência ─────────────────────────────────────────────────────────────

/** Exercício (ano) derivado da data da edição. */
function exercicioDe(data: string): number {
  const ano = Number(data.slice(0, 4));
  return Number.isFinite(ano) && ano > 1900 ? ano : new Date().getFullYear();
}

/**
 * ID determinístico da edição em `nexo_diario_dom`. Prefere `<ano>_<edicao>`;
 * sem nº de edição, usa `<data>` (uma edição-extra sem número por dia é rara, e
 * o overlap idempotente cobre o caso comum).
 */
function idEdicao(e: EdicaoDom): string {
  const exercicio = exercicioDe(e.data);
  const base = e.edicao ? `${exercicio}_${e.edicao}` : `data_${e.data}`;
  return base.replace(/[^\w-]/g, "_");
}

/** Título informativo da edição para o catálogo. */
function tituloEdicao(e: EdicaoDom): string {
  const num = e.edicao ? `nº ${e.edicao}` : "(s/ número)";
  const extra = e.edicaoExtra ? " — edição extra" : "";
  return `DOM Marília ${num} de ${e.data}${extra}`;
}

/**
 * Persiste uma edição em `nexo_diario_dom` e a registra no catálogo
 * `nexo_documentos`. Retorna o nº de chaves de linkage extraídas (informativo).
 */
async function persistirEdicao(
  e: EdicaoDom,
  chaves: ChaveLinkage[],
): Promise<void> {
  const exercicio = exercicioDe(e.data);
  const now = admin.firestore.FieldValue.serverTimestamp();

  // 1) Edição em `nexo_diario_dom` (doc ID determinístico → UPSERT).
  await db
    .collection("nexo_diario_dom")
    .doc(idEdicao(e))
    .set(
      {
        data: e.data,
        edicao: e.edicao,
        edicaoExtra: e.edicaoExtra,
        urlPdf: e.urlPdf,
        txtUrl: e.txtUrl,
        // Espelha as chaves na própria edição (consulta direta sem ir ao
        // catálogo) — array de `tipo:valor` para array-contains.
        chavesProcesso: chaves.map((c) => `${c.tipo}:${c.valor}`),
        _exercicio: exercicio,
        _fonte: "querido-diario",
        _coletadoEm: now,
      },
      { merge: true },
    );

  // 2) Registro no catálogo (TUDO LINKADO). A edição entra como `dom-edicao`,
  //    com a chave própria (dom:<id>) + as chaves de processo extraídas.
  await registrarDocumento({
    tipo: "dom-edicao",
    orgao: MARILIA_ORGAO,
    data: e.data,
    numeroProcesso: null,
    url: e.urlPdf,
    pdfUrl: e.urlPdf,
    hash: null,
    fonte: "querido-diario",
    titulo: tituloEdicao(e),
    chavesLinkage: [
      { tipo: "dom", valor: idEdicao(e) },
      ...chaves,
    ],
  });
}

/**
 * docId determinístico de um ato de pessoal em `nexo_nomeacoes`:
 * `<edicaoId>_<sha1(tipo|nome|cargo)>` — estável por (edição, ato), idempotente.
 */
function idNomeacao(edicaoId: string, a: AtoPessoal): string {
  const h = createHash("sha1")
    .update([a.tipo, a.nome, a.cargo ?? ""].join("|"))
    .digest("hex")
    .slice(0, 16);
  return `${edicaoId}_${h}`;
}

/**
 * Persiste os atos de pessoal de uma edição em `nexo_nomeacoes` (lote único).
 * Escrita por cron/admin (rule write:false). Cada doc aponta para a edição-fonte
 * (`domEdicaoId`/`urlPdf`) p/ auditoria. NÃO cria vínculo — só o ato extraído.
 */
async function persistirNomeacoes(
  e: EdicaoDom,
  atos: AtoPessoal[],
): Promise<void> {
  if (atos.length === 0) return;
  const exercicio = exercicioDe(e.data);
  const edicaoId = idEdicao(e);
  const now = admin.firestore.FieldValue.serverTimestamp();
  let batch = db.batch();
  let n = 0;
  for (const a of atos) {
    const ref = db.collection("nexo_nomeacoes").doc(idNomeacao(edicaoId, a));
    batch.set(
      ref,
      {
        tipo: a.tipo,
        nome: a.nome,
        cargo: a.cargo,
        matricula: a.matricula,
        secretaria: a.secretaria,
        ato: a.ato,
        trecho: a.trecho,
        data: e.data,
        domEdicaoId: edicaoId,
        urlPdf: e.urlPdf,
        // Chave fraca de NOME apenas (sem CPF — o DOM não publica o CPF do
        // servidor): permite casar PROBABILISTICAMENTE por nome normalizado com
        // outras pernas, sempre como indício a apurar. NÃO é identificação.
        nomeNorm: a.nome
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .toUpperCase()
          .replace(/\s+/g, " ")
          .trim(),
        _exercicio: exercicio,
        _fonte: "dom-nomeacao",
        _coletadoEm: now,
      },
      { merge: true },
    );
    if (++n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
}

// ── Janela incremental ───────────────────────────────────────────────────────

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDias(base: string, dias: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return ymd(d);
}

/**
 * Determina a janela `[desde, ate]` a coletar. `ate` é sempre hoje (UTC).
 * `desde` é o último `ate` bem-sucedido recuado por `OVERLAP_DIAS`; sem cursor
 * anterior, cai no lookback padrão.
 */
async function janelaIncremental(): Promise<{ desde: string; ate: string }> {
  const ate = ymd(new Date());
  let desde = addDias(ate, -LOOKBACK_DIAS);
  try {
    const snap = await db.collection("nexo_sync_state").doc("dom").get();
    const cursor = snap.exists ? snap.data()?.cursorAte : null;
    if (typeof cursor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cursor)) {
      const candidato = addDias(cursor, -OVERLAP_DIAS);
      // Usa o cursor só se for mais recente que o lookback (não regride janela).
      if (candidato > desde) desde = candidato;
    }
  } catch (err) {
    logger.warn(
      "NEXO DOM — falha lendo cursor incremental; usando lookback padrão. " +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { desde, ate };
}

// ── Cron diário ──────────────────────────────────────────────────────────────

export const onNexoColetaDom = onSchedule(
  {
    // 06h45 BRT — após o índice do Querido Diário consolidar a véspera.
    schedule: "45 6 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    // Nunca duas execuções concorrentes (retry atrasado não refaz coleta).
    maxInstances: 1,
    // Retry idempotente: edição e catálogo têm doc ID determinístico + merge.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    const { desde, ate } = await janelaIncremental();
    logger.info(`NEXO DOM — coletando edições ${desde}..${ate}`);

    let edicoesPersistidas = 0;
    let totalChaves = 0;
    let totalNomeacoes = 0;
    let falhasEdicao = 0;
    let parcial = false;
    let erroFatal: string | null = null;

    try {
      const { edicoes, parcial: parcialColeta } = await coletarEdicoes(
        desde,
        ate,
      );
      parcial = parcialColeta;
      logger.info(`NEXO DOM — ${edicoes.length} edições no intervalo.`);

      for (const e of edicoes) {
        try {
          const texto = await baixarTexto(e.txtUrl);
          const chaves = extrairChaves(texto);
          await persistirEdicao(e, chaves);
          // Perna assessor/cargo: extrai nomeacoes/exoneracoes/designacoes do
          // mesmo texto e grava em nexo_nomeacoes (best-effort, degrada honesto).
          const atos = extrairNomeacoes(texto);
          await persistirNomeacoes(e, atos);
          totalNomeacoes += atos.length;
          edicoesPersistidas++;
          totalChaves += chaves.length;
        } catch (err) {
          falhasEdicao++;
          parcial = true;
          logger.error(
            `NEXO DOM — falha na edição ${idEdicao(e)} (${e.data})`,
            err,
          );
        }
        // Respira entre edições (download de texto + 2 escritas cada).
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch (err) {
      erroFatal = err instanceof Error ? err.message : String(err);
      logger.error("NEXO DOM — falha fatal na coleta", err);
    }

    const sucesso = erroFatal === null;
    const degradado = parcial || falhasEdicao > 0;

    await gravarSyncState({
      syncId: "dom",
      fonte: "querido-diario",
      colecao: "nexo_diario_dom",
      cadencia: "diario",
      sucesso,
      degradado,
      erro: erroFatal,
      duracaoMs: Date.now() - inicio,
      extra: {
        janelaDesde: desde,
        janelaAte: ate,
        // O cursor só avança em coleta ÍNTEGRA — numa coleta parcial,
        // reprocessar a mesma janela amanhã recupera as edições faltantes.
        ...(sucesso && !degradado ? { cursorAte: ate } : {}),
        edicoes: edicoesPersistidas,
        chavesExtraidas: totalChaves,
        nomeacoesExtraidas: totalNomeacoes,
        falhasEdicao,
        parcial,
      },
    });

    logger.info(
      `NEXO DOM — concluído: ${edicoesPersistidas} edições, ` +
        `${totalChaves} chaves de processo, ${totalNomeacoes} atos de pessoal, ` +
        `${falhasEdicao} falhas` +
        (parcial ? " [PARCIAL]" : ""),
    );
  },
);
