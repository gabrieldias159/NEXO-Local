/**
 * Cron de ENRIQUECIMENTO de contratos municipais — `onNexoEnriqueceContratos`
 * (onda de enriquecimento SMARAPD da Fase 3 do plano-mestre).
 *
 * `coleta-contratos.ts` ingere os contratos da fonte PRIMÁRIA (Dados Abertos),
 * mas essa fonte vem MUTILADA: `objeto` e `cnpjContratada` são SEMPRE null e o
 * `nomeContratada` frequentemente também. O texto completo (nome + objeto +
 * CNPJ) e o PDF do contrato vivem na página de detalhe do SMARAPD em
 * `https://www.marilia.sp.gov.br/portal/contrato/{id}` — onde o `{id}` é um
 * inteiro sequencial INTERNO do portal, NÃO derivável do `numeroContrato`/
 * `numeroProcesso`. Esse cron fecha esse buraco.
 *
 * ── ESTRATÉGIA (confirmada por WebFetch/scrape em 2026-06) ────────────────
 * 1. Lê de `nexo_contratos_municipais` os docs com nome/objeto/CNPJ faltando
 *    (e ainda não enriquecidos com sucesso — idempotência).
 * 2. Para cada um, raspa a LISTAGEM `/portal/contratos/{pagina}/{...filtros
 *    posicionais...}` com o filtro pré-preenchido por contratada/número/
 *    processo (mesmo deep-link que `coleta-contratos` já registra). A listagem é
 *    HTML server-rendered: cada item é um `<a href="/portal/contrato/{id}">` com
 *    os campos "Número:", "Nº processo:" e "Contratada(s):" no corpo. Casamos por
 *    `numero` + `processo` para descobrir o `{id}` interno.
 * 3. GET de `/portal/contrato/{id}` e extrai do HTML: contratada (nome), objeto,
 *    CNPJ (quando o portal o expõe) e o token do PDF
 *    (`/portal/download/contratos/{token}/`, distinto de `contratos-aditivos`).
 * 4. Atualiza o doc do contrato (merge) e registra o documento-fonte no catálogo
 *    via `registrarDocumento` (tipo `'contrato'`, `pdfUrl`, chave de linkage de
 *    CNPJ) — TUDO LINKADO.
 *
 * ── IDEMPOTÊNCIA ──────────────────────────────────────────────────────────
 * O update é `merge` e o catálogo usa `docId` determinístico. Cada doc carrega
 * `_enriquecidoSmarapd.{ok,tentativas,...}`: reexecuções PULAM os já resolvidos
 * (`ok === true`) e só retentam os pendentes — o cron converge e nunca duplica.
 *
 * ── DEGRADAÇÃO HONESTA (WAF) ──────────────────────────────────────────────
 * O portal pode responder com bloqueio (Cloudflare/WAF, captcha, HTTP 403/429/
 * 503, ou HTML sem o esqueleto esperado). Nesse caso NÃO inventamos dado: o
 * contrato fica marcado `_enriquecidoSmarapd.pendente` com o motivo, e o
 * `sync_state` vai a `degradado`. Um UA de browser é usado para reduzir recusas,
 * mas nunca burlamos captcha.
 *
 * ── LGPD ──────────────────────────────────────────────────────────────────
 * Contratada pode ser PESSOA FÍSICA (CPF). Onde o documento é de pessoa,
 * gravamos `docHash = hashDoc(...)` (chave de junção pseudonimizada) e
 * `docMasc = mascararDoc(...)` (exibição) — NUNCA o número cru. CNPJ (pessoa
 * jurídica, dado público) é preservado cru para cruzamento, mas também recebe
 * hash/máscara para uniformizar o motor de linkage.
 *
 * Cadência: diária (06h05 BRT) — logo após `coleta-contratos` (05h35), para
 * enriquecer no mesmo ciclo matinal o que a coleta acabou de marcar pendente.
 *
 * Self-contained: o projeto `functions/` não importa de `src/`. Reusa
 * `registrarDocumento` (catálogo), `gravarSyncState` (observabilidade),
 * `hashDoc`/`mascararDoc` (PII) — todos do próprio `functions/`.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import { registrarDocumento, type DocumentoPublico } from "./documentos";
import { hashDoc, mascararDoc } from "./pii";

/** Coleção dos contratos municipais (preenchida por `coleta-contratos`). */
const COLECAO = "nexo_contratos_municipais";
/** Fonte canônica do documento-fonte enriquecido. */
const FONTE = "smarapd";
/** Órgão emissor — sempre a Prefeitura (alvo único do NEXO). */
const ORGAO = "Prefeitura Municipal de Marília";

/** Base do portal institucional SMARAPD. */
const PORTAL_BASE = "https://www.marilia.sp.gov.br/portal";
const TIMEOUT_MS = 25_000;

/**
 * Teto de contratos enriquecidos por execução. O scraping é educado (1 listagem
 * + 1 detalhe por contrato, com pausa); o teto protege a janela de 540s do cron
 * e o portal de carga. O restante fica pendente para a próxima execução diária
 * (o cron converge ao longo de alguns dias). Generoso o bastante para drenar o
 * acúmulo inicial sem estourar o tempo.
 */
const MAX_POR_EXECUCAO = 120;
/** Pausa educada entre requisições ao portal (anti-rate-limit, anti-WAF). */
const PAUSA_MS = 400;
/** Páginas de listagem varridas por contrato ao procurar o `{id}` (deep-link
 * já filtra; normalmente 1 página basta). */
const MAX_PAGINAS_BUSCA = 3;

/** UA de browser — o portal recusa/varia para clients sem UA reconhecível. */
const HEADERS: Record<string, string> = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
};

// ── Normalizadores ───────────────────────────────────────────────────────────

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** `null` se vazio; senão a string trimada. */
function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s ? s : null;
}

function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

/** Converte valor BR (`1.234,56`) ou numérico para number; null em falha. */
function toNumOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = str(v);
  if (!s) return null;
  const limpo = s.includes(",")
    ? s.replace(/\./g, "").replace(",", ".")
    : s;
  const n = Number(limpo.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Normaliza número/processo para casar entre a listagem e o doc (só `[\w/.-]`,
 * upper, sem espaços) — tolera `38.716/2021` vs `38716/2021`, `CG-1433/21` etc. */
function chaveNumero(v: unknown): string {
  return str(v)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^\w/.-]/g, "");
}

/** Variante só-dígitos da chave — fallback de match quando a pontuação diverge. */
function chaveDigitos(v: unknown): string {
  return soDigitos(v);
}

/**
 * Primeiro SEGMENTO numérico do valor, sem zeros à esquerda — o discriminante
 * estável entre listagem e doc. O número de contrato/processo varia muito de
 * forma (`128/TC/2023`, `0128`, `38.716/2021`, `CG-1433/21`), mas o inteiro
 * INICIAL é o que identifica o contrato; o resto (ano, sigla de comissão) é
 * decoração que diverge entre fontes. Ex.: `128/TC/2023` → `128`,
 * `38.716/2021` → `38716` (a barra separa o ano, o ponto é só milhar). "" se
 * não houver dígito.
 */
function segmentoNumericoInicial(v: unknown): string {
  // Pega tudo até a PRIMEIRA barra (que separa o ano/sufixo), tira não-dígitos,
  // remove zeros à esquerda. Sem barra: usa o primeiro grupo de dígitos.
  const bruto = str(v);
  const ateBarra = bruto.split("/")[0] ?? bruto;
  const dig = soDigitos(ateBarra) || soDigitos(bruto);
  return dig.replace(/^0+/, "");
}

/** Tabela mínima de entidades HTML que o portal devolve em texto. */
const ENTIDADES: Record<string, string> = {
  "&aacute;": "á", "&eacute;": "é", "&iacute;": "í", "&oacute;": "ó",
  "&uacute;": "ú", "&acirc;": "â", "&ecirc;": "ê", "&ocirc;": "ô",
  "&atilde;": "ã", "&otilde;": "õ", "&ccedil;": "ç", "&agrave;": "à",
  "&Aacute;": "Á", "&Eacute;": "É", "&Iacute;": "Í", "&Oacute;": "Ó",
  "&Uacute;": "Ú", "&Acirc;": "Â", "&Ecirc;": "Ê", "&Ocirc;": "Ô",
  "&Atilde;": "Ã", "&Otilde;": "Õ", "&Ccedil;": "Ç", "&Agrave;": "À",
  "&ordm;": "º", "&ordf;": "ª", "&nbsp;": " ", "&amp;": "&",
  "&quot;": '"', "&lt;": "<", "&gt;": ">", "&#39;": "'", "&ndash;": "–",
  "&mdash;": "—",
};

/** Decodifica entidades HTML, remove tags e colapsa espaços. Best-effort. */
function limparHtml(v: unknown): string {
  let s = str(v);
  if (!s) return "";
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTIDADES[m] ?? m);
  return s.replace(/\s+/g, " ").trim();
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** Erro que marca degradação por bloqueio do portal (WAF/HTTP/forma inválida). */
class BloqueioPortalError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BloqueioPortalError";
  }
}

/**
 * Recurso não encontrado (HTTP 404). Para a LISTAGEM significa "nenhum match
 * para este filtro" — NÃO é bloqueio de portal: deve virar sem-match + continue,
 * jamais abortar a varredura inteira. (Bug histórico: 404 caía no `!res.ok` e
 * subia como `BloqueioPortalError`, que setava `bloqueado=true` e dava `break`,
 * matando todos os contratos seguintes da passada.)
 */
class NaoEncontradoError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NaoEncontradoError";
  }
}

/**
 * GET de HTML do portal. Lança `BloqueioPortalError` em HTTP de bloqueio
 * (403/429/503) ou em HTML que aparenta ser página de WAF/captcha. Demais HTTP
 * != 200 também lançam (defensivo). Nunca devolve string vazia silenciosa.
 */
async function getHtml(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: HEADERS,
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new BloqueioPortalError(
      `falha de rede em ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 403 || res.status === 429 || res.status === 503) {
    throw new BloqueioPortalError(`HTTP ${res.status} (provável WAF) em ${url}`);
  }
  // 404 NÃO é bloqueio: é "recurso ausente" (listagem sem match / id inexistente).
  // O chamador decide se isso é sem-match (continue) ou pendência pontual.
  if (res.status === 404) {
    throw new NaoEncontradoError(`HTTP 404 em ${url}`);
  }
  if (!res.ok) {
    throw new BloqueioPortalError(`HTTP ${res.status} em ${url}`);
  }
  const html = await res.text();
  // Heurística de página de bloqueio: corpo curto + sinais de challenge.
  const baixo = html.toLowerCase();
  const pareceWaf =
    html.length < 2_000 &&
    /(cloudflare|captcha|access denied|attention required|just a moment|verifique que voc)/i.test(
      baixo,
    );
  if (pareceWaf) {
    throw new BloqueioPortalError(`HTML de bloqueio (WAF/captcha) em ${url}`);
  }
  return html;
}

// ── Parsing da LISTAGEM (descoberta do {id} interno) ─────────────────────────

/**
 * Sanea um valor que vai virar UM segmento posicional da URL de listagem.
 *
 * A barra é o separador de segmentos do portal: um `numero`/`processo` cru como
 * `128/TC/2023` ou `38.716/2021` injetaria segmentos EXTRAS no path posicional e
 * desalinharia todos os filtros seguintes (o portal lê por POSIÇÃO, não por
 * nome) — a busca então não filtra nada e a listagem volta gigante/errada. Por
 * isso trocamos a barra (e qualquer caractere que o portal trataria como
 * delimitador de path) por espaço ANTES de `encodeURIComponent`: o portal faz
 * match por prefixo numérico, então `38.716 2021` ainda casa o contrato certo
 * sem quebrar a contagem de segmentos. NUNCA deixamos o `/` cru e NUNCA o
 * deixamos virar `%2F` (que o roteador posicional também não decodifica de volta
 * para um único segmento de forma confiável).
 */
function sanearSegmento(v: string): string {
  return v
    .replace(/[/\\#?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * URL de listagem do portal com filtros POSICIONAIS pré-preenchidos por
 * contratada/número/processo. Mesma forma que `coleta-contratos.urlBuscaContrato`
 * (a busca lê estes segmentos via `location.href`). `0` = sem filtro.
 *
 * Segmentos: `/portal/contratos/{pagina}/0/{contratada}/{numero}/{processo}/0/9/0/0/0/0/0/0/0`.
 */
function urlListagemFiltrada(
  pagina: number,
  numero: string,
  processo: string,
  contratada: string | null,
): string {
  // Sanea a barra ANTES de encodar: barra crua/`%2F` quebra a contagem de
  // segmentos posicionais do portal (bug de barra, não WAF).
  const c = encodeURIComponent(sanearSegmento(contratada ?? "0") || "0");
  const n = encodeURIComponent(sanearSegmento(numero) || "0");
  const p = encodeURIComponent(sanearSegmento(processo) || "0");
  return `${PORTAL_BASE}/contratos/${pagina}/0/${c}/${n}/${p}/0/9/0/0/0/0/0/0/0`;
}

interface ItemListagem {
  id: string;
  numero: string;
  processo: string;
  contratada: string | null;
}

/**
 * Captura o valor de um campo rotulado dentro de um bloco de item da listagem,
 * ex.: `<strong>Número:</strong><span> 128/TC/2023</span>`. Tolera variações de
 * espaçamento/atributos. Devolve "" se não achar.
 */
function campoRotulado(bloco: string, rotulo: string): string {
  // <strong ...>Rotulo:</strong> ... <span ...> VALOR </span>
  const re = new RegExp(
    `<strong[^>]*>\\s*${rotulo}\\s*:?\\s*</strong>\\s*(?:<[^>]+>\\s*)*<span[^>]*>([^<]*)</span>`,
    "i",
  );
  const m = bloco.match(re);
  return m ? limparHtml(m[1]) : "";
}

/**
 * Extrai os itens de uma página de listagem. Cada item é um
 * `<a href="/portal/contrato/{id}"> ... </a>` (o bloco entre o anchor e o
 * próximo anchor de contrato), de onde lemos Número, Nº processo e Contratada.
 */
function parseListagem(html: string): ItemListagem[] {
  const itens: ItemListagem[] = [];
  // Localiza cada anchor de detalhe e fatia o bloco até o próximo anchor.
  const reAnchor = /<a\s+href="\/portal\/contrato\/(\d+)"\s*>/gi;
  const marcas: { id: string; inicio: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = reAnchor.exec(html)) !== null) {
    marcas.push({ id: m[1], inicio: m.index });
  }
  for (let i = 0; i < marcas.length; i++) {
    const inicio = marcas[i].inicio;
    const fim = i + 1 < marcas.length ? marcas[i + 1].inicio : html.length;
    const bloco = html.slice(inicio, fim);
    const numero = campoRotulado(bloco, "N(?:&uacute;|ú)mero");
    const processo =
      campoRotulado(bloco, "N(?:&ordm;|º)?\\s*processo") ||
      campoRotulado(bloco, "Processo");
    const contratada = strOrNull(campoRotulado(bloco, "Contratada\\(s\\)"));
    itens.push({ id: marcas[i].id, numero, processo, contratada });
  }
  return itens;
}

/**
 * Descobre o `{id}` interno do SMARAPD para um contrato, casando por número +
 * processo na listagem filtrada. Varre até `MAX_PAGINAS_BUSCA` páginas. Devolve
 * o item casado ou null (sem match — não enriquece, não inventa).
 */
async function descobrirId(
  numeroContrato: string,
  numeroProcesso: string,
  nomeContratada: string | null,
): Promise<ItemListagem | null> {
  // Match primário pelo SEGMENTO numérico inicial (tolera /TC/2023, sigla,
  // zeros à esquerda, ponto de milhar); chave cheia/só-dígitos como reforço.
  const numAlvoSeg = segmentoNumericoInicial(numeroContrato);
  const procAlvoSeg = segmentoNumericoInicial(numeroProcesso);
  const numAlvo = chaveNumero(numeroContrato);
  const procAlvo = chaveNumero(numeroProcesso);
  const numAlvoDig = chaveDigitos(numeroContrato);
  const procAlvoDig = chaveDigitos(numeroProcesso);

  for (let pagina = 1; pagina <= MAX_PAGINAS_BUSCA; pagina++) {
    const url = urlListagemFiltrada(
      pagina,
      numeroContrato,
      numeroProcesso,
      nomeContratada,
    );
    let html: string;
    try {
      html = await getHtml(url);
    } catch (err) {
      // 404 da LISTAGEM = filtro sem resultado ⇒ sem-match (null), NÃO bloqueio.
      // Qualquer outro erro (WAF/rede) sobe e o cron decide degradar.
      if (err instanceof NaoEncontradoError) return null;
      throw err;
    }
    const itens = parseListagem(html);
    if (itens.length === 0) return null; // sem resultados ⇒ nada a varrer

    for (const it of itens) {
      const itNumSeg = segmentoNumericoInicial(it.numero);
      const itProcSeg = segmentoNumericoInicial(it.processo);
      const numOk =
        // Segmento numérico inicial é o discriminante principal…
        (numAlvoSeg !== "" && itNumSeg === numAlvoSeg) ||
        // …com a chave cheia/só-dígitos como confirmação extra.
        (numAlvo !== "" && chaveNumero(it.numero) === numAlvo) ||
        (numAlvoDig !== "" && chaveDigitos(it.numero) === numAlvoDig);
      const procOk =
        procAlvo === "" ||
        (procAlvoSeg !== "" && itProcSeg === procAlvoSeg) ||
        chaveNumero(it.processo) === procAlvo ||
        (procAlvoDig !== "" && chaveDigitos(it.processo) === procAlvoDig);
      // Número é o discriminante forte; processo confirma quando disponível.
      if (numOk && procOk) return it;
    }

    // Página cheia (20 itens) e sem match ⇒ pode haver continuação; segue.
    if (itens.length < 20) break;
    await pausa();
  }
  return null;
}

// ── Parsing do DETALHE (`/portal/contrato/{id}`) ─────────────────────────────

interface DetalheContrato {
  nomeContratada: string | null;
  objeto: string | null;
  cnpj: string | null;
  /** CPF cru detectado (NÃO persistido cru — só para hash/máscara). */
  cpf: string | null;
  pdfToken: string | null;
  pdfUrl: string | null;
  valor: number | null;
  dataAssinatura: string | null;
  /**
   * Tokens de aditivos referenciados na página (`/portal/download/contratos-aditivos/{token}/`).
   * DATA-BLOCKED: a sonda capturou os tokens mas NÃO confirmou o download (WAF
   * deste ambiente). Persistimos só a URL/token como indício a apurar — nunca
   * fingimos que o aditivo foi baixado/processado. `[]` quando não há nenhum.
   */
  aditivos: { token: string; url: string }[];
}

/** Captura o conteúdo de uma `<div class="cnt_descricao">` que segue um
 * `<div class="cnt_titulo">RÓTULO</div>`. */
function descricaoApos(html: string, rotulo: string): string {
  const re = new RegExp(
    `<div[^>]*class="[^"]*cnt_titulo[^"]*"[^>]*>\\s*${rotulo}\\s*</div>\\s*<div[^>]*class="[^"]*cnt_descricao[^"]*"[^>]*>([\\s\\S]*?)</div>`,
    "i",
  );
  const m = html.match(re);
  return m ? limparHtml(m[1]) : "";
}

/** Captura o valor de uma linha da tabela de detalhes (sw_titulo_detalhe →
 * sw_descricao_detalhe). */
function detalheTabela(html: string, rotulo: string): string {
  const re = new RegExp(
    `<div[^>]*class="[^"]*sw_titulo_detalhe[^"]*"[^>]*>\\s*${rotulo}\\s*</div>\\s*<div[^>]*class="[^"]*sw_descricao_detalhe[^"]*"[^>]*>([\\s\\S]*?)</div>`,
    "i",
  );
  const m = html.match(re);
  return m ? limparHtml(m[1]) : "";
}

/**
 * Extrai os campos de enriquecimento do HTML do detalhe. Tudo best-effort: cada
 * campo é null quando o portal não o expõe (NÃO inventamos).
 */
function parseDetalhe(html: string): DetalheContrato {
  // Contratada: <strong class="cnt_titulo">Contratada(s):</strong>
  //             <span class="cnt_descricao">NOME</span>
  let nomeContratada: string | null = null;
  const mNome = html.match(
    /<strong[^>]*class="[^"]*cnt_titulo[^"]*"[^>]*>\s*Contratada\(s\):\s*<\/strong>\s*<span[^>]*class="[^"]*cnt_descricao[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
  );
  if (mNome) nomeContratada = strOrNull(limparHtml(mNome[1]));

  // Objeto: <div class="cnt_titulo">Objeto</div><div class="cnt_descricao">…</div>
  const objeto = strOrNull(descricaoApos(html, "Objeto"));

  // CNPJ / CPF: o portal nem sempre rotula; varremos o HTML por um documento
  // formatado. Preferimos o que aparece mais perto do bloco da contratada.
  const { cnpj, cpf } = extrairDocumento(html);

  // PDF do contrato (NÃO o de aditivos): /portal/download/contratos/{token}/.
  // O negative lookahead barra `/portal/download/contratos-aditivos/…`.
  let pdfToken: string | null = null;
  let pdfUrl: string | null = null;
  const mPdf = html.match(
    /href="(\/portal\/download\/contratos\/(?!aditivos)([^"/]+)\/?)"/i,
  );
  if (mPdf) {
    pdfToken = mPdf[2];
    pdfUrl = `${PORTAL_BASE.replace(/\/portal$/, "")}${mPdf[1]}`;
  }

  // Valor total / data de assinatura (informativos, da tabela de detalhes).
  const valor =
    toNumOrNull(detalheTabela(html, "Valor Total")) ??
    toNumOrNull(detalheTabela(html, "Contrato"));
  const dataAssinatura = isoData(detalheTabela(html, "Data da assinatura"));

  // Aditivos (OPCIONAL, data-blocked): só capturamos os tokens referenciados em
  // `/portal/download/contratos-aditivos/{token}/`. NÃO baixamos (WAF) — é
  // indício a apurar, persistido como link, nunca como conteúdo processado.
  const aditivos = extrairAditivos(html);

  return {
    nomeContratada, objeto, cnpj, cpf, pdfToken, pdfUrl, valor, dataAssinatura,
    aditivos,
  };
}

/**
 * Extrai os tokens de aditivos do HTML (`/portal/download/contratos-aditivos/{token}/`).
 * Best-effort, dedup. DATA-BLOCKED: token capturado ≠ aditivo baixado — só
 * devolvemos o link como indício a apurar.
 */
function extrairAditivos(html: string): { token: string; url: string }[] {
  const out: { token: string; url: string }[] = [];
  const vistos = new Set<string>();
  const re =
    /href="(\/portal\/download\/contratos-aditivos\/([^"/]+)\/?)"/gi;
  let m: RegExpExecArray | null;
  const baseRaiz = PORTAL_BASE.replace(/\/portal$/, "");
  while ((m = re.exec(html)) !== null) {
    const token = m[2];
    if (vistos.has(token)) continue;
    vistos.add(token);
    out.push({ token, url: `${baseRaiz}${m[1]}` });
  }
  return out;
}

/**
 * CNPJs (só dígitos) de entes públicos de Marília que aparecem no RODAPÉ de toda
 * página do portal (cabeçalho/rodapé institucional). NUNCA são a contratada —
 * são a própria Prefeitura/IPREMM. Sem esta denylist, `extrairDocumento` casaria
 * o PRIMEIRO CNPJ do HTML, que via de regra é o da Prefeitura no rodapé →
 * falso-positivo. (`functions/` não importa de `src/`; espelha
 * `perfil-entidades.ENTES_PUBLICOS_MARILIA`.)
 */
const CNPJS_ORGAO_DENYLIST = new Set<string>([
  "44477909000100", // Prefeitura Municipal de Marília
  "59989830000136", // IPREMM — RPPS de Marília
]);

/**
 * Procura um CNPJ (14 díg.) ou CPF (11 díg.) formatado no HTML. Devolve o CNPJ
 * se houver (pessoa jurídica, público); senão um CPF (pessoa física — tratado
 * via hash/máscara, nunca persistido cru). null/null quando nada confiável.
 *
 * BLINDAGEM: o CNPJ da Prefeitura (rodapé institucional) NÃO é o da contratada —
 * é ignorado (denylist + raiz). Varremos TODOS os CNPJs do texto e ficamos com o
 * primeiro que NÃO seja de ente público; só então caímos para CPF. Nunca
 * inventamos: se o único CNPJ presente for o do órgão, devolvemos cnpj=null.
 */
function extrairDocumento(html: string): { cnpj: string | null; cpf: string | null } {
  const texto = limparHtml(html);
  const reCnpj = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g;
  let m: RegExpExecArray | null;
  while ((m = reCnpj.exec(texto)) !== null) {
    const dig = soDigitos(m[0]);
    if (dig.length !== 14) continue;
    // Pula CNPJ de órgão (rodapé): denylist exata + raiz de 8 dígitos (filiais).
    if (CNPJS_ORGAO_DENYLIST.has(dig)) continue;
    const raiz = dig.slice(0, 8);
    if ([...CNPJS_ORGAO_DENYLIST].some((c) => c.slice(0, 8) === raiz)) continue;
    return { cnpj: dig, cpf: null };
  }
  const mCpf = texto.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/);
  if (mCpf) {
    const dig = soDigitos(mCpf[0]);
    if (dig.length === 11) return { cnpj: null, cpf: dig };
  }
  return { cnpj: null, cpf: null };
}

/** `DD/MM/YYYY` → `YYYY-MM-DD`; null se não reconhecer. */
function isoData(v: unknown): string | null {
  const s = str(v);
  const br = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

// ── Persistência do enriquecimento ───────────────────────────────────────────

interface ContratoPendente {
  id: string;
  numeroContrato: string;
  numeroProcesso: string;
  nomeContratada: string | null;
  objeto: string | null;
  cnpjContratada: string | null;
  vigenciaInicio: string | null;
}

/**
 * Lê os contratos que precisam de enriquecimento: algum de nome/objeto/CNPJ
 * faltando E ainda não resolvidos (`_enriquecidoSmarapd.ok != true`). Não dá
 * para fazer um `where` composto barato com OR de "qualquer campo null" + "ok
 * != true" sem índices dedicados; então filtramos `_fonte` (dados-abertos) no
 * servidor e o resto em memória — o universo é pequeno (centenas/exercício).
 */
async function lerPendentes(limite: number): Promise<ContratoPendente[]> {
  // Marcador estável que `coleta-contratos` grava quando algo falta:
  // `_enriquecimentoSmarapd != null`. Indexa o subconjunto a enriquecer.
  const snap = await db
    .collection(COLECAO)
    .where("_fonte", "==", "dados-abertos")
    .get();

  const pend: ContratoPendente[] = [];
  for (const doc of snap.docs) {
    const d = doc.data();

    const nome = strOrNull(d.nomeContratada);
    const objeto = strOrNull(d.objeto);
    const cnpj = strOrNull(d.cnpjContratada);
    // Só enriquece quem tem buraco real. A checagem de BURACO vem ANTES do
    // marcador `ok` de propósito (auto-cura): a coleta diária antiga apagava os
    // campos enriquecidos mantendo ok=true — pular por ok aqui deixava o doc
    // mutilado para sempre (auditoria 2026-06-09). Doc completo sai barato no
    // teste acima; doc com buraco é re-enriquecido mesmo que ok=true.
    if (nome && objeto && cnpj) continue;

    const numeroContrato = str(d.numeroContrato);
    const numeroProcesso = str(d.numeroProcesso);
    // Sem número não há como casar na listagem — pula (não dá pra resolver).
    if (!numeroContrato && !numeroProcesso) continue;

    pend.push({
      id: doc.id,
      numeroContrato,
      numeroProcesso,
      nomeContratada: nome,
      objeto,
      cnpjContratada: cnpj,
      vigenciaInicio: strOrNull(d.vigenciaInicio),
    });
    if (pend.length >= limite) break;
  }
  return pend;
}

/**
 * Aplica o resultado do enriquecimento ao doc do contrato (merge) e registra o
 * documento-fonte no catálogo. Só sobrescreve campos que ESTAVAM faltando — não
 * apaga dado bom já presente.
 */
async function aplicarEnriquecimento(
  pend: ContratoPendente,
  det: DetalheContrato,
  smarapdId: string,
): Promise<{ documentoId: string | null }> {
  const now = admin.firestore.FieldValue.serverTimestamp();

  const nomeFinal = pend.nomeContratada ?? det.nomeContratada;
  const objetoFinal = pend.objeto ?? det.objeto;
  const cnpjFinal = pend.cnpjContratada ?? det.cnpj;

  // Resolvido se preenchemos TODOS os buracos que tínhamos.
  const resolvido = !!nomeFinal && !!objetoFinal && !!cnpjFinal;

  const update: Record<string, unknown> = {
    _enriquecidoSmarapd: {
      ok: resolvido,
      pendente: !resolvido,
      smarapdId,
      // Campos efetivamente preenchidos por esta passada.
      preenchidos: {
        nomeContratada: !pend.nomeContratada && !!det.nomeContratada,
        objeto: !pend.objeto && !!det.objeto,
        cnpj: !pend.cnpjContratada && !!det.cnpj,
        pdf: !!det.pdfUrl,
      },
      motivo: resolvido
        ? null
        : "Detalhe SMARAPD não expôs todos os campos faltantes (ex.: CNPJ não publicado).",
      tentativaEm: now,
    },
    _enriquecidoEm: now,
  };
  if (nomeFinal) update.nomeContratada = nomeFinal;
  if (objetoFinal) update.objeto = objetoFinal;
  if (cnpjFinal) {
    update.cnpjContratada = cnpjFinal;
    update._cnpj = cnpjFinal;
  }
  if (nomeFinal) update._fornecedor = nomeFinal;
  if (det.pdfUrl) update.pdfContratoUrl = det.pdfUrl;
  if (det.valor != null) update.valorSmarapd = det.valor;
  if (det.dataAssinatura) update.dataAssinatura = det.dataAssinatura;
  // Aditivos (informativo, DATA-BLOCKED): só os links/tokens — download
  // WAF-bloqueado neste ambiente; rotulamos como indício a apurar, sem fingir
  // que o conteúdo do aditivo foi processado.
  if (det.aditivos.length > 0) {
    update.aditivosSmarapd = {
      links: det.aditivos,
      total: det.aditivos.length,
      baixado: false,
      motivo:
        "Tokens de aditivos capturados na página; download WAF-bloqueado " +
        "deste ambiente — indício a apurar, não conteúdo processado.",
    };
  }

  // LGPD: se a contratada for PESSOA FÍSICA (CPF detectado e sem CNPJ), NÃO
  // grava o CPF cru — só hash (junção) e máscara (exibição).
  if (det.cpf && !cnpjFinal) {
    update.docHash = hashDoc(det.cpf);
    update.docMasc = mascararDoc(det.cpf);
  } else if (cnpjFinal) {
    // CNPJ é público, mas hasheamos/mascaramos junto para uniformizar o linkage.
    update.docHash = hashDoc(cnpjFinal);
    update.docMasc = mascararDoc(cnpjFinal);
  }

  await db.collection(COLECAO).doc(pend.id).set(update, { merge: true });

  // Catálogo de documentos (TUDO LINKADO): registra o contrato-fonte com PDF e
  // CNPJ como chaves de linkage. `registrarDocumento` é idempotente (docId
  // determinístico). Só registramos quando há ALGO novo de valor (PDF ou CNPJ).
  let documentoId: string | null = null;
  if (det.pdfUrl || cnpjFinal) {
    const chaves: DocumentoPublico["chavesLinkage"] = [];
    if (pend.numeroProcesso)
      chaves.push({ tipo: "processo", valor: pend.numeroProcesso });
    if (pend.numeroContrato)
      chaves.push({ tipo: "contrato", valor: pend.numeroContrato });
    if (cnpjFinal) chaves.push({ tipo: "cnpj", valor: cnpjFinal });
    // Pessoa física: a chave de linkage usa o HASH (pseudonimizado), nunca o CPF.
    if (det.cpf && !cnpjFinal)
      chaves.push({ tipo: "docHash", valor: hashDoc(det.cpf) });

    const doc: DocumentoPublico = {
      tipo: "contrato",
      orgao: ORGAO,
      data: det.dataAssinatura ?? pend.vigenciaInicio,
      numeroProcesso: pend.numeroProcesso || null,
      url: `${PORTAL_BASE}/contrato/${smarapdId}`,
      pdfUrl: det.pdfUrl,
      hash: null,
      chavesLinkage: chaves,
      fonte: FONTE,
      titulo:
        objetoFinal ??
        nomeFinal ??
        `Contrato ${pend.numeroContrato || pend.numeroProcesso}`,
    };
    documentoId = await registrarDocumento(doc);
  }

  return { documentoId };
}

/** Marca um contrato como pendente após bloqueio/sem-match — sem inventar dado. */
async function marcarPendente(id: string, motivo: string): Promise<void> {
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection(COLECAO).doc(id).set(
    {
      _enriquecidoSmarapd: {
        ok: false,
        pendente: true,
        motivo,
        tentativaEm: now,
      },
    },
    { merge: true },
  );
}

function pausa(): Promise<void> {
  return new Promise((r) => setTimeout(r, PAUSA_MS));
}

// ── Cron diário ──────────────────────────────────────────────────────────────

export const onNexoEnriqueceContratos = onSchedule(
  {
    // 06h05 BRT — após `coleta-contratos` (05h35), mesma janela matinal.
    schedule: "5 6 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    // Hardening (#13): no máximo UMA execução simultânea — o scraping é stateful
    // (cursor de pendentes) e o portal não deve receber duas varreduras juntas.
    maxInstances: 1,
    // Retry idempotente: o update é `merge`, o catálogo usa docId determinístico
    // e os resolvidos (`ok===true`) são PULADOS — reexecutar após falha apenas
    // retoma os pendentes, nunca duplica nem regride.
    retryCount: 1,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 120,
    maxBackoffSeconds: 600,
    maxDoublings: 2,
  },
  async () => {
    const inicio = Date.now();
    let enriquecidos = 0;
    let pendentesMarcados = 0;
    let semMatch = 0;
    let documentosCatalogados = 0;
    let bloqueado = false;
    let ultimoErro: string | null = null;

    let pendentes: ContratoPendente[] = [];
    try {
      pendentes = await lerPendentes(MAX_POR_EXECUCAO);
    } catch (err) {
      ultimoErro = err instanceof Error ? err.message : String(err);
      logger.error("NEXO Enriquecimento — falha ao ler pendentes", err);
      await gravarSyncState({
        syncId: "enriquecimento_contratos",
        fonte: FONTE,
        colecao: COLECAO,
        cadencia: "diario",
        sucesso: false,
        degradado: true,
        erro: ultimoErro,
        duracaoMs: Date.now() - inicio,
        extra: { fase: "leitura_pendentes" },
      });
      return;
    }

    logger.info(
      `NEXO Enriquecimento — ${pendentes.length} contratos pendentes nesta passada`,
    );

    for (const pend of pendentes) {
      // Se o portal já se mostrou bloqueado, paramos de martelar: o restante
      // fica para a próxima execução (degradação honesta).
      if (bloqueado) break;
      try {
        const item = await descobrirId(
          pend.numeroContrato,
          pend.numeroProcesso,
          pend.nomeContratada,
        );
        await pausa();
        if (!item) {
          semMatch++;
          await marcarPendente(
            pend.id,
            "Não encontrado na listagem SMARAPD por número+processo " +
              "(possível defasagem da listagem ou número divergente).",
          );
          continue;
        }

        const html = await getHtml(`${PORTAL_BASE}/contrato/${item.id}`);
        await pausa();
        const det = parseDetalhe(html);
        // A listagem traz a contratada mesmo quando o detalhe não a rotula —
        // usa como fallback de nome.
        if (!det.nomeContratada && item.contratada) {
          det.nomeContratada = item.contratada;
        }

        const { documentoId } = await aplicarEnriquecimento(pend, det, item.id);
        if (documentoId) documentosCatalogados++;
        enriquecidos++;
      } catch (err) {
        if (err instanceof NaoEncontradoError) {
          // 404 PONTUAL (ex.: detalhe `/contrato/{id}` sumiu) — sem-match deste
          // contrato; NÃO é bloqueio. Continua a passada normalmente.
          semMatch++;
          await marcarPendente(
            pend.id,
            "Recurso SMARAPD retornou 404 (listagem/detalhe ausente): " +
              "sem match nesta passada, não é bloqueio.",
          );
          continue;
        }
        if (err instanceof BloqueioPortalError) {
          bloqueado = true;
          ultimoErro = err.message;
          logger.warn(
            `NEXO Enriquecimento — portal bloqueou (degradando): ${err.message}`,
          );
          await marcarPendente(
            pend.id,
            `Portal SMARAPD bloqueou/indisponível: ${err.message}`,
          );
          pendentesMarcados++;
        } else {
          ultimoErro = err instanceof Error ? err.message : String(err);
          logger.error(
            `NEXO Enriquecimento — falha no contrato ${pend.id}`,
            err,
          );
          await marcarPendente(
            pend.id,
            `Erro ao enriquecer: ${ultimoErro}`,
          );
          pendentesMarcados++;
        }
      }
    }

    // Degradado se houve bloqueio do portal, ou se sobraram pendentes a resolver.
    const degradado = bloqueado || pendentesMarcados > 0 || semMatch > 0;
    // Sucesso (não-falha) desde que tenhamos rodado: bloqueio é "degradado", não
    // "falha" — é estado honesto e esperado, não um erro do nosso lado.
    const sucesso = true;
    // P2-18 — quando degrada SEM exceção (só `semMatch`/`pendentesMarcados`),
    // `ultimoErro` era null e o painel via `degradado` com `erro` VAZIO (impossível
    // diagnosticar). Sintetiza um motivo honesto a partir das contagens da passada.
    const erroDegradado = degradado
      ? ultimoErro ??
        (bloqueado
          ? "Portal SMARAPD bloqueou/indisponível nesta passada."
          : `${pendentesMarcados} contrato(s) marcado(s) pendente(s), ` +
            `${semMatch} sem match na listagem SMARAPD (número/processo divergente ` +
            `ou listagem defasada) — restante segue na próxima execução.`)
      : null;
    await gravarSyncState({
      syncId: "enriquecimento_contratos",
      fonte: FONTE,
      colecao: COLECAO,
      cadencia: "diario",
      sucesso,
      degradado,
      erro: erroDegradado,
      duracaoMs: Date.now() - inicio,
      extra: {
        pendentesNaPassada: pendentes.length,
        enriquecidos,
        documentosCatalogados,
        semMatch,
        pendentesMarcados,
        bloqueadoPeloPortal: bloqueado,
      },
    });
    logger.info(
      `NEXO Enriquecimento — concluído: ${enriquecidos} enriquecidos, ` +
        `${documentosCatalogados} documentos catalogados, ${semMatch} sem match, ` +
        `${pendentesMarcados} marcados pendentes` +
        (bloqueado ? " [PORTAL BLOQUEOU]" : ""),
    );
  },
);
