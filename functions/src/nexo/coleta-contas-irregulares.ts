/**
 * CONTAS JULGADAS IRREGULARES (TCE-SP, Ficha Limpa / LC 64/90) — lado JULGADOS
 * do cruzamento XS-14.
 *
 * O Tribunal de Contas do Estado de São Paulo publica, mensalmente, a "Relação
 * de responsáveis por contas julgadas irregulares" — a lista que ele encaminha
 * à Justiça Eleitoral em cumprimento ao art. 1º, I, "g" e § 4º-A da LC 64/1990
 * (Lei das Inelegibilidades), alterada pela LC 135/2010 (Ficha Limpa). É um
 * arquivo público, estadual, em XLSX (e PDF), com responsáveis (gestores /
 * ordenadores de despesa) cujas contas foram julgadas irregulares com trânsito
 * em julgado no TCE-SP.
 *
 * Este coletor baixa o XLSX de "Contas anuais julgadas irregulares", FILTRA os
 * registros cuja ORIGEM é um órgão de MARÍLIA (Prefeitura, Câmara, autarquias,
 * empresas e fundações municipais) e persiste em `nexo_contas_irregulares` —
 * o conjunto "responsáveis com contas julgadas irregulares no TCE", que o
 * detector XS-14 cruza contra fornecedores/sócios da Prefeitura.
 *
 * ── ⚠ ENQUADRAMENTO (LEIA ANTES DE USAR ESTES DADOS) ─────────────────────────
 * "Contas julgadas irregulares no TCE" NÃO É, por si só, INELEGIBILIDADE. A
 * inelegibilidade da alínea "g" é decisão da JUSTIÇA ELEITORAL, que ainda afere
 * requisitos próprios (dolo, ressarcimento, suspensão judicial, prazo de 8 anos
 * etc.) e admite que o responsável recorra. A lista do TCE é apenas o INSUMO que
 * a Justiça Eleitoral usa. Portanto, qualquer detector/painel que consuma
 * `nexo_contas_irregulares`:
 *   • NUNCA afirma que a pessoa é inelegível ou "Ficha Suja" — só que consta na
 *     relação do TCE como "responsável com contas julgadas irregulares, a
 *     verificar";
 *   • NÃO faz juízo de improbidade (Lei 8.429/92) nem de qualquer outro tipo;
 *   • trata coincidência responsável↔fornecedor/sócio como VÍNCULO A APURAR.
 *
 * ── ⚠ CPF É ANONIMIZADO NA FONTE ─────────────────────────────────────────────
 * O TCE-SP publica o CPF MASCARADO por LGPD, no formato `NNN.XXX.XXX-NN` — só os
 * 3 primeiros dígitos e os 2 dígitos verificadores; os 6 do meio são `XXX.XXX`.
 * Logo NÃO temos o CPF cru e NÃO dá pra gerar um `hashDoc` do CPF completo que
 * case 1:1 com os hashes de fornecedores/sócios. Guardamos:
 *   • `cpfMasc`     — a máscara como veio (`NNN.XXX.XXX-NN`), só pra exibição;
 *   • `cpfParcial`  — a "impressão digital" `{3 primeiros}-{2 DV}` (ex.: `124-54`),
 *                     uma chave FRACA de corroboração (há colisões — milhares de
 *                     CPFs compartilham pre3+DV), nunca um identificador único;
 *   • `cpfHash`     — `hashDoc(cpfParcial)` (de `./pii`), determinístico sobre a
 *                     impressão digital. É hash de um dado JÁ anonimizado: NÃO é o
 *                     hash do CPF cru (não existe CPF cru aqui), serve só pra
 *                     cruzar a impressão digital sem persistir nem o `124...54`.
 * NUNCA persistimos CPF cru — não temos. O detector XS-14 casa primordialmente
 * por NOME (com aviso de homonímia) e usa `cpfParcial` apenas como corroboração.
 *
 * ── DE ONDE VEM (URL REAL, confirmada por inspeção em jun/2026) ───────────────
 * Página oficial:
 *   https://www.tce.sp.gov.br/relacao-de-responsaveis-por-contas-julgadas-irregulares
 * O arquivo "Contas anuais julgadas irregulares (xlsx)" tem o NOME com a data de
 * publicação embutida (muda todo mês), p.ex. (jun/2026):
 *   https://www.tce.sp.gov.br/sites/default/files/portal/
 *     contas irregulares de 01-01-1900 a 01-06-2026_Contas_Anuais_CPF_anonimizado.xlsx
 * Como o nome muda, o coletor DESCOBRE a URL atual raspando a âncora na página
 * oficial (procura href que contenha `Contas_Anuais` e `CPF_anonimizado.xlsx`),
 * com a URL conhecida acima como FALLBACK. Confirmado: 84 linhas de órgãos de
 * Marília na carga de jun/2026 (Prefeitura, Câmara, DAEM, EMDURB, AMAE, IPREMM,
 * Fundação de Ensino Superior, Faculdade de Medicina, etc.).
 *
 * ── LAYOUT DO XLSX (confirmado) ──────────────────────────────────────────────
 * Planilha 1, cabeçalho na 4ª linha de dados úteis (detectado por conter "CPF").
 * Colunas: C=Responsável(nome) · D=CPF(`NNN.XXX.XXX-NN`) · E=Processo TC ·
 * F=Matéria · G=Origem(órgão) · H=Trânsito em Julgado · I=Exercício · J=Matéria.
 * (Coluna A é uma lista decorativa de nomes — IGNORADA.) Encoding do XML interno
 * é UTF-8. Lemos por NOME de coluna do cabeçalho (robusto a reordenação).
 *
 * ── PARSE DO XLSX SEM DEPENDÊNCIA ────────────────────────────────────────────
 * Um .xlsx é um ZIP. Em vez de puxar uma lib de planilha, o coletor lê o ZIP com
 * `node:zlib` (mesma técnica de `coleta-tse-doacoes.ts`): extrai
 * `xl/sharedStrings.xml` e `xl/worksheets/sheet1.xml` e parseia o XML mínimo de
 * células (`<c>`/`<v>`/`<is>`). O arquivo é pequeno (~460 KB), então baixamos
 * inteiro (sem Range).
 *
 * ── PERSISTÊNCIA ─────────────────────────────────────────────────────────────
 * `nexo_contas_irregulares`, 1 doc por registro, docId DETERMINÍSTICO
 * (idempotente — re-rodar SOBRESCREVE, nunca duplica). Campos:
 *   { nome, cpfHash, cpfMasc, cpfParcial, processoTC, exercicio, origem,
 *     materia, transitoJulgado, nomeNorm, _fonte:'tce-ficha-limpa', ... }
 * Snapshot completo por carga: após gravar, PURGA os docs ausentes do snapshot
 * atual (responsável removido da lista do TCE some da nossa base).
 *
 * Self-contained: o projeto `functions/` não importa de `src/`; usa só
 * `node:zlib` (inflateRawSync) e o `./pii` local (hashDoc/mascararDoc).
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { inflateRawSync } from "node:zlib";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import { hashDoc } from "./pii";

// ── Constantes da fonte ──────────────────────────────────────────────────────

/** Página oficial onde ficam os links (com a data de publicação no nome). */
const PAGINA_TCE =
  "https://www.tce.sp.gov.br/relacao-de-responsaveis-por-contas-julgadas-irregulares";

/**
 * URL de FALLBACK do XLSX de "Contas anuais julgadas irregulares" (jun/2026).
 * O caminho principal DESCOBRE a URL atual raspando a página (o nome embute a
 * data e muda mensalmente); este valor só entra se a raspagem falhar.
 */
const URL_CONTAS_ANUAIS_FALLBACK =
  "https://www.tce.sp.gov.br/sites/default/files/portal/" +
  "contas%20irregulares%20de%2001-01-1900%20a%2001-06-2026_Contas_Anuais_CPF_anonimizado.xlsx";

/** Coleção de destino. */
const COLECAO = "nexo_contas_irregulares";

const TIMEOUT_MS = 60_000;

/**
 * UA de browser — o portal do TCE-SP costuma recusar clients sem UA (mesmo
 * padrão de `coleta-dom.ts` / `coleta-tse-doacoes.ts`).
 */
const HTTP_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
};

// ── Filtro de MARÍLIA (município alvo único do NEXO) ─────────────────────────
//
// A coluna `Origem` é o ÓRGÃO (não o município isolado), p.ex.:
//   "PREFEITURA MUNICIPAL DE MARILIA", "CAMARA MUNICIPAL DE MARILIA",
//   "DEPARTAMENTO DE AGUA E ESGOTO DE MARILIA", "EMPRESA MUNICIPAL DE
//   MOBILIDADE URBANA DE MARILIA EMDURB", "INSTITUTO DE PREVIDENCIA DO
//   MUNICIPIO DE MARILIA", "FACULDADE DE MEDICINA DE MARILIA", etc.
// Filtramos por "MARILIA" no nome normalizado do órgão. CUIDADO com falsos
// positivos: municípios cujo nome CONTÉM "marilia" como substring NÃO existem em
// SP (não há "Marília do X"); mas, por segurança, exigimos a palavra MARILIA
// delimitada (\b) — assim "CABRALIA"/"LUCELIA"/"ELIAS" (que contêm "LIA") não
// passam, e só órgãos efetivamente "...DE MARILIA" entram.

const RE_MARILIA = /\bMARILIA\b/;

/** Tira acento e normaliza (caixa-alta, espaço único) — base do filtro/dedup. */
function normNome(v: unknown): string {
  return (v == null ? "" : String(v))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** `true` quando a ORIGEM é um órgão do município de Marília. */
function origemEhMarilia(origem: string): boolean {
  return RE_MARILIA.test(normNome(origem));
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** Baixa o corpo inteiro de uma URL como Buffer. Lança em erro de rede/HTTP. */
async function baixarBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: HTTP_HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/** Baixa o HTML da página como string (UTF-8). */
async function baixarHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { ...HTTP_HEADERS, Accept: "text/html,*/*" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

/**
 * DESCOBRE a URL atual do XLSX de "Contas anuais" raspando a página oficial.
 * Procura uma âncora cujo href contenha `Contas_Anuais` e termine em
 * `CPF_anonimizado.xlsx` (case-insensitive). Como o nome embute a data de
 * publicação (`..._a_01-06-2026_...`), NÃO confiamos no fallback codificado a
 * menos que a raspagem não encontre nada.
 *
 * Retorna uma URL absoluta (resolve relativas contra o host do TCE-SP), ou null.
 */
function acharUrlContasAnuais(html: string): string | null {
  // Captura todos os href (aspas simples ou duplas).
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(
    (m) => m[1],
  );
  const candidato = hrefs.find((h) => {
    const dec = (() => {
      try {
        return decodeURIComponent(h);
      } catch {
        return h;
      }
    })();
    return (
      /Contas_Anuais/i.test(dec) &&
      /CPF_anonimizado\.xlsx(?:[?#]|$)/i.test(dec) &&
      // exclui a variante "_FE_..._Contas_Anuais" (imputação de débito, outro
      // recorte): só queremos o principal "..._Contas_Anuais_CPF_anonimizado".
      !/_FE_/i.test(dec)
    );
  });
  if (!candidato) return null;
  try {
    return new URL(candidato, "https://www.tce.sp.gov.br/").toString();
  } catch {
    return null;
  }
}

/**
 * Resolve a URL do XLSX: tenta raspar a página oficial; se falhar (rede ou
 * âncora não encontrada), cai no fallback codificado. Retorna a URL e a origem
 * (`pagina` | `fallback`) pra registrar no sync-state — assim o painel sabe se a
 * carga usou a URL fresca ou a embutida (que pode estar defasada).
 */
async function resolverUrlXlsx(): Promise<{
  url: string;
  origem: "pagina" | "fallback";
  avisoRaspagem: string | null;
}> {
  try {
    const html = await baixarHtml(PAGINA_TCE);
    const url = acharUrlContasAnuais(html);
    if (url) return { url, origem: "pagina", avisoRaspagem: null };
    return {
      url: URL_CONTAS_ANUAIS_FALLBACK,
      origem: "fallback",
      avisoRaspagem:
        "âncora 'Contas_Anuais_CPF_anonimizado.xlsx' não encontrada na página; " +
        "usando URL de fallback (pode estar defasada)",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      url: URL_CONTAS_ANUAIS_FALLBACK,
      origem: "fallback",
      avisoRaspagem: `falha ao raspar a página (${msg}); usando URL de fallback`,
    };
  }
}

// ── Parse do XLSX (ZIP → sharedStrings + sheet1) ─────────────────────────────

const SIG_EOCD = 0x06054b50; // PK\x05\x06 — End Of Central Directory.
const SIG_CD = 0x02014b50; // PK\x01\x02 — Central Directory file header.
const SIG_LOCAL = 0x04034b50; // PK\x03\x04 — Local file header.

interface EntradaZip {
  nome: string;
  metodo: number; // 0=stored, 8=deflate
  tamComprimido: number;
  offsetLocal: number;
}

/** Acha o EOCD varrendo de trás pra frente. Retorna o offset, ou -1. */
function acharEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/** Lê o central directory de um ZIP de 32 bits (sem ZIP64). */
function lerCentralDirectory(buf: Buffer): EntradaZip[] {
  const eocd = acharEocd(buf);
  if (eocd < 0) throw new Error("XLSX/ZIP sem EOCD (arquivo corrompido?)");
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) {
    throw new Error("ZIP64 detectado; parser não suporta (inesperado pro XLSX)");
  }
  const entradas: EntradaZip[] = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CD) {
      throw new Error(`Central directory truncado na entrada ${n}/${total}`);
    }
    const metodo = buf.readUInt16LE(p + 10);
    const tamComprimido = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offsetLocal = buf.readUInt32LE(p + 42);
    const nome = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entradas.push({ nome, metodo, tamComprimido, offsetLocal });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entradas;
}

/** Extrai uma entrada do ZIP (já totalmente carregado em `buf`) como Buffer. */
function extrairEntrada(buf: Buffer, e: EntradaZip): Buffer {
  if (buf.readUInt32LE(e.offsetLocal) !== SIG_LOCAL) {
    throw new Error(`Local header inválido para ${e.nome}`);
  }
  const nameLen = buf.readUInt16LE(e.offsetLocal + 26);
  const extraLen = buf.readUInt16LE(e.offsetLocal + 28);
  const dataInicio = e.offsetLocal + 30 + nameLen + extraLen;
  const comprimido = buf.subarray(dataInicio, dataInicio + e.tamComprimido);
  if (e.metodo === 0) return Buffer.from(comprimido);
  if (e.metodo === 8) return inflateRawSync(comprimido);
  throw new Error(`Método de compressão não suportado (${e.metodo}) em ${e.nome}`);
}

/** Lê uma entrada do XLSX por nome (path dentro do ZIP), como texto UTF-8. */
function lerTextoEntrada(buf: Buffer, entradas: EntradaZip[], nome: string): string {
  const e = entradas.find((x) => x.nome === nome);
  if (!e) throw new Error(`Entrada '${nome}' ausente no XLSX`);
  return extrairEntrada(buf, e).toString("utf8");
}

// ── XML mínimo do XLSX ───────────────────────────────────────────────────────

/** Desescapa as entidades XML que aparecem em texto de planilha. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&"); // por último, pra não reintroduzir entidades
}

/**
 * Parseia `sharedStrings.xml` → array de strings. Cada `<si>` pode conter um
 * `<t>` único ou vários (`<r><t>...`); concatenamos todos os `<t>` do `<si>`.
 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const reSi = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = reSi.exec(xml)) !== null) {
    const inner = m[1];
    let texto = "";
    const reT = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let mt: RegExpExecArray | null;
    while ((mt = reT.exec(inner)) !== null) texto += unescapeXml(mt[1]);
    out.push(texto);
  }
  return out;
}

/** Letra(s) da coluna a partir da referência da célula (ex.: "D4" → "D"). */
function colDaRef(ref: string): string {
  const m = /^([A-Z]+)/.exec(ref);
  return m ? m[1] : "";
}

/**
 * Parseia uma planilha (`sheetN.xml`) em linhas; cada linha é um mapa
 * coluna→valor (ex.: `{ C: "ACHYLES...", D: "124.XXX.XXX-54", ... }`).
 * Resolve `t="s"` via sharedStrings e `t="inlineStr"`/`<is>` via texto local.
 */
function parseSheet(xml: string, shared: string[]): Record<string, string>[] {
  const linhas: Record<string, string>[] = [];
  const reRow = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let mr: RegExpExecArray | null;
  while ((mr = reRow.exec(xml)) !== null) {
    const rowXml = mr[1];
    const linha: Record<string, string> = {};
    const reCell = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let mc: RegExpExecArray | null;
    while ((mc = reCell.exec(rowXml)) !== null) {
      const attrs = mc[1] ?? mc[3] ?? "";
      const inner = mc[2] ?? "";
      const refMatch = /\br\s*=\s*"([^"]+)"/.exec(attrs);
      if (!refMatch) continue;
      const col = colDaRef(refMatch[1]);
      const tMatch = /\bt\s*=\s*"([^"]+)"/.exec(attrs);
      const tipo = tMatch ? tMatch[1] : "";
      let valor = "";
      if (tipo === "s") {
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const idx = vm ? Number(vm[1]) : NaN;
        valor = Number.isInteger(idx) && shared[idx] != null ? shared[idx] : "";
      } else if (tipo === "inlineStr") {
        const tm = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        valor = tm ? unescapeXml(tm[1]) : "";
      } else {
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        valor = vm ? unescapeXml(vm[1]) : "";
      }
      linha[col] = valor;
    }
    if (Object.keys(linha).length > 0) linhas.push(linha);
  }
  return linhas;
}

// ── Extração dos registros de Marília ────────────────────────────────────────

/** Só os dígitos de um valor. */
function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

/**
 * "Impressão digital" parcial do CPF anonimizado `NNN.XXX.XXX-NN`:
 * `{3 primeiros}-{2 DV}` (ex.: `124-54`). Chave FRACA de corroboração (colide).
 * Retorna "" quando a máscara não tem ao menos pre3 e dv2 reconhecíveis.
 */
function cpfParcialDeMasc(cpfMasc: string): string {
  const m = /^(\d{3})\.?[X.*]{0,3}\.?[X.*]{0,3}-?(\d{2})\s*$/i.exec(
    (cpfMasc ?? "").trim(),
  );
  if (m) return `${m[1]}-${m[2]}`;
  // Fallback genérico: pega os 3 primeiros dígitos e os 2 últimos do que houver.
  const dig = soDigitos(cpfMasc);
  if (dig.length >= 5) return `${dig.slice(0, 3)}-${dig.slice(-2)}`;
  return "";
}

/** Converte exercício (ano) para number, ou null. */
function parseExercicio(v: unknown): number | null {
  const n = Number(soDigitos(v));
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null;
}

interface RegistroContaIrregular {
  nome: string;
  nomeNorm: string;
  cpfMasc: string;
  cpfParcial: string;
  cpfHash: string;
  processoTC: string;
  exercicio: number | null;
  origem: string;
  materia: string;
  transitoJulgado: string;
}

/**
 * Localiza a linha de CABEÇALHO (a que contém uma célula "CPF") e mapeia os
 * RÓTULOS de coluna → letra, pra ler por nome (robusto a deslocamento de
 * coluna). Devolve null se não achar um cabeçalho plausível.
 */
function mapearColunas(
  linhas: Record<string, string>[],
): { idxHeader: number; col: Record<string, string> } | null {
  for (let i = 0; i < Math.min(linhas.length, 12); i++) {
    const linha = linhas[i];
    const entradas = Object.entries(linha);
    const temCpf = entradas.some(([, v]) => normNome(v) === "CPF");
    if (!temCpf) continue;
    const col: Record<string, string> = {};
    for (const [c, v] of entradas) {
      const rotulo = normNome(v);
      if (!rotulo) continue;
      // Mapeia o PRIMEIRO rótulo de cada tipo (a coluna A "Responsável"
      // decorativa vem antes da C "Responsável" real; o nome real é o que tem
      // CPF/Processo ao lado — então preferimos a coluna que tem vizinhos).
      if (rotulo === "RESPONSAVEL" && !col.nome) col.nome = c;
      else if (rotulo === "CPF") col.cpf = c;
      else if (rotulo.startsWith("PROCESSO")) col.processo = c;
      else if (rotulo === "ORIGEM") col.origem = c;
      else if (rotulo.startsWith("TRANSITO")) col.transito = c;
      else if (rotulo.startsWith("EXERCICIO")) col.exercicio = c;
      else if (rotulo.startsWith("MATERIA") && !col.materia) col.materia = c;
    }
    // O nome "Responsável" REAL é a coluna imediatamente à esquerda do CPF
    // (C, com D=CPF). A coluna A é decorativa; corrigimos pra coluna anterior ao
    // CPF quando ambas existem.
    if (col.cpf) {
      const colAnterior = String.fromCharCode(col.cpf.charCodeAt(0) - 1);
      if (linha[colAnterior] != null) col.nome = colAnterior;
    }
    if (col.cpf || col.nome) return { idxHeader: i, col };
  }
  return null;
}

/**
 * Extrai os registros de MARÍLIA do XLSX já parseado em linhas. Filtra por
 * `origemEhMarilia`. Anonimização do CPF é preservada (só máscara/parcial/hash).
 */
function extrairMarilia(linhas: Record<string, string>[]): RegistroContaIrregular[] {
  const mapa = mapearColunas(linhas);
  if (!mapa) {
    throw new Error(
      "Cabeçalho do XLSX não reconhecido (sem coluna 'CPF'); layout pode ter mudado",
    );
  }
  const { idxHeader, col } = mapa;
  const out: RegistroContaIrregular[] = [];
  for (let i = idxHeader + 1; i < linhas.length; i++) {
    const linha = linhas[i];
    // Linha esparsa do XLSX omite células vazias — `linha[letra]` pode ser
    // undefined e `.trim()` direto derrubava o ciclo inteiro (visto em prod no
    // 1º run, 2026-06-09). Leitura SEMPRE via helper null-safe.
    const cel = (letra?: string): string =>
      letra ? String(linha[letra] ?? "").trim() : "";
    const nome = cel(col.nome);
    const origem = cel(col.origem);
    if (!nome && !origem) continue;
    if (!origemEhMarilia(origem)) continue;

    const cpfMasc = cel(col.cpf);
    const cpfParcial = cpfParcialDeMasc(cpfMasc);
    out.push({
      nome,
      nomeNorm: normNome(nome),
      cpfMasc,
      cpfParcial,
      // hashDoc da IMPRESSÃO DIGITAL parcial (dado já anonimizado) — NUNCA do
      // CPF cru (não existe CPF cru aqui). Vazio → hash de "" (estável).
      cpfHash: cpfParcial ? hashDoc(cpfParcial) : "",
      processoTC: cel(col.processo),
      exercicio: parseExercicio(cel(col.exercicio)),
      origem,
      materia: cel(col.materia),
      transitoJulgado: cel(col.transito),
    });
  }
  return out;
}

// ── Persistência ─────────────────────────────────────────────────────────────

const BATCH_SIZE = 450;

/** ID determinístico de um registro — processoTC + exercício + parcial/nome. */
function docId(r: RegistroContaIrregular): string {
  const proc = soDigitos(r.processoTC) || "semproc";
  const ex = r.exercicio ?? "0";
  const disc = r.cpfParcial.replace(/\D/g, "") || r.nomeNorm.slice(0, 24);
  return `ci_${proc}_${ex}_${disc}`.replace(/[^\w-]/g, "_");
}

/** Grava os registros em lotes; docId determinístico + merge (idempotente). */
async function persistir(
  registros: RegistroContaIrregular[],
): Promise<{ count: number; ids: Set<string> }> {
  const col = db.collection(COLECAO);
  const ids = new Set<string>();
  let count = 0;
  for (let i = 0; i < registros.length; i += BATCH_SIZE) {
    const fatia = registros.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const r of fatia) {
      const id = docId(r);
      if (ids.has(id)) continue;
      ids.add(id);
      batch.set(
        col.doc(id),
        {
          nome: r.nome,
          nomeNorm: r.nomeNorm,
          cpfHash: r.cpfHash,
          cpfMasc: r.cpfMasc,
          cpfParcial: r.cpfParcial,
          processoTC: r.processoTC,
          exercicio: r.exercicio,
          origem: r.origem,
          materia: r.materia,
          transitoJulgado: r.transitoJulgado,
          _fonte: "tce-ficha-limpa",
          // Guardrails carregados no PRÓPRIO dado (espelha nexo_doacoes_tse):
          // contas irregulares no TCE NÃO é inelegibilidade (decisão da Justiça
          // Eleitoral). Detector/painel não passa de 'atencao'; match só por nome
          // é 'informativo' (homonímia). SEM juízo de improbidade (Lei 8.429/92).
          _enquadramento: "contas-irregulares-tce-a-verificar-nao-inelegibilidade",
          _classificacaoMax: "atencao",
          _cpfAnonimizadoNaFonte: true,
          _coletadoEm: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      count++;
    }
    await batch.commit();
  }
  return { count, ids };
}

/** Purga os docs de `nexo_contas_irregulares` ausentes do snapshot atual. */
async function purgarObsoletos(idsAtuais: Set<string>): Promise<number> {
  const snap = await db.collection(COLECAO).where("_fonte", "==", "tce-ficha-limpa").get();
  let batch = db.batch();
  let removidos = 0;
  for (const doc of snap.docs) {
    if (idsAtuais.has(doc.id)) continue;
    batch.delete(doc.ref);
    removidos++;
    if (removidos % BATCH_SIZE === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (removidos % BATCH_SIZE !== 0) await batch.commit();
  return removidos;
}

// ── Orquestração de uma coleta ───────────────────────────────────────────────

interface ResultadoColeta {
  url: string;
  origemUrl: "pagina" | "fallback";
  avisoRaspagem: string | null;
  registrosMarilia: number;
  gravados: number;
  removidos: number;
  bytesXlsx: number;
}

/**
 * Executa uma coleta completa: resolve URL → baixa XLSX → parseia → filtra
 * Marília → persiste → purga obsoletos. Lança em qualquer falha dura (o
 * chamador decide como reportar).
 */
async function coletar(): Promise<ResultadoColeta> {
  const { url, origem, avisoRaspagem } = await resolverUrlXlsx();
  const buf = await baixarBuffer(url);

  // Sanidade: um XLSX começa com "PK" (assinatura de ZIP). Se o portal devolveu
  // uma página de erro HTML em vez do arquivo, falhamos com mensagem clara.
  if (buf.length < 4 || buf.readUInt16LE(0) !== 0x4b50) {
    throw new Error(
      `Resposta de ${url} não é um XLSX/ZIP (assinatura PK ausente; ` +
        "o portal pode ter devolvido HTML de erro)",
    );
  }

  const entradas = lerCentralDirectory(buf);
  const sharedXml = (() => {
    try {
      return lerTextoEntrada(buf, entradas, "xl/sharedStrings.xml");
    } catch {
      return ""; // planilha sem strings compartilhadas — raro, mas tolerável
    }
  })();
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];

  // Acha a 1ª planilha (sheet1.xml; se não existir, a primeira sheetN.xml).
  const sheetEntrada =
    entradas.find((e) => e.nome === "xl/worksheets/sheet1.xml") ??
    entradas.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.nome));
  if (!sheetEntrada) throw new Error("XLSX sem planilha (xl/worksheets/sheetN.xml)");
  const sheetXml = extrairEntrada(buf, sheetEntrada).toString("utf8");

  const linhas = parseSheet(sheetXml, shared);
  const registros = extrairMarilia(linhas);
  const { count, ids } = await persistir(registros);
  const removidos = await purgarObsoletos(ids);

  return {
    url,
    origemUrl: origem,
    avisoRaspagem,
    registrosMarilia: registros.length,
    gravados: count,
    removidos,
    bytesXlsx: buf.length,
  };
}

// ── onCall ADMIN de backfill — caminho PRINCIPAL ─────────────────────────────

/**
 * `onNexoBackfillContasIrregulares` — callable ADMIN que faz a coleta sob
 * demanda.
 *
 * Uso (admin):
 *   httpsCallable(fns, 'onNexoBackfillContasIrregulares')({});
 *
 * Auth: custom claim `admin === true` OU `users/{uid}.role === 'admin'`
 * (mesmo padrão de `onNexoBackfillTseDoacoes`).
 */
export const onNexoBackfillContasIrregulares = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 1,
    cors: true,
  },
  async (req) => {
    if (!req.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Autenticação necessária para o backfill de contas irregulares.",
      );
    }
    const isAdminClaim = req.auth.token.admin === true;
    if (!isAdminClaim) {
      const snap = await db.doc(`users/${req.auth.uid}`).get();
      const role = (snap.data() as { role?: string } | undefined)?.role;
      if (role !== "admin") {
        throw new HttpsError(
          "permission-denied",
          "Apenas administradores podem rodar o backfill de contas irregulares.",
        );
      }
    }

    logger.info("NEXO contas irregulares — backfill iniciado", {
      uid: req.auth.uid,
    });

    const inicio = Date.now();
    try {
      const r = await coletar();
      await gravarSyncState({
        syncId: "contas_irregulares",
        fonte: "tce-ficha-limpa",
        colecao: COLECAO,
        // `Cadencia` não tem "mensal"; usamos "quinzenal" (cadência mais lenta
        // disponível) como rótulo informativo do painel — o cron real é mensal.
        cadencia: "quinzenal",
        sucesso: true,
        degradado: r.origemUrl === "fallback",
        erro: r.avisoRaspagem,
        duracaoMs: Date.now() - inicio,
        extra: {
          url: r.url,
          origemUrl: r.origemUrl,
          registrosMarilia: r.registrosMarilia,
          gravados: r.gravados,
          removidos: r.removidos,
          bytesXlsx: r.bytesXlsx,
        },
      });
      logger.info(
        `NEXO contas irregulares — backfill OK: ${r.gravados} de Marília ` +
          `(${r.removidos} obsoletos removidos; URL via ${r.origemUrl})`,
      );
      return {
        ok: true,
        ...r,
        duracaoMs: Date.now() - inicio,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await gravarSyncState({
        syncId: "contas_irregulares",
        fonte: "tce-ficha-limpa",
        colecao: COLECAO,
        cadencia: "quinzenal",
        sucesso: false,
        degradado: true,
        erro: msg,
        duracaoMs: Date.now() - inicio,
      });
      logger.error("NEXO contas irregulares — backfill falhou", err);
      throw new HttpsError("internal", `Coleta falhou: ${msg}`);
    }
  },
);

// ── Cron RARO — re-coleta mensal ─────────────────────────────────────────────

/**
 * `onNexoSyncContasIrregulares` — cron MENSAL. A lista do TCE é atualizada
 * mensalmente; re-coletamos uma vez por mês (dia 5, 06h10 BRT — folga após a
 * publicação típica do dia 1). RARO de propósito: a fonte muda devagar.
 *
 * `maxInstances: 1` e docIds determinísticos tornam o retry idempotente. Falha
 * de rede vira estado degradado no sync-state, não derruba o codebase.
 */
export const onNexoSyncContasIrregulares = onSchedule(
  {
    schedule: "10 6 5 * *", // 06:10 do dia 5 de cada mês
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 1,
    retryCount: 1,
  },
  async () => {
    const inicio = Date.now();
    try {
      const r = await coletar();
      await gravarSyncState({
        syncId: "contas_irregulares",
        fonte: "tce-ficha-limpa",
        colecao: COLECAO,
        cadencia: "quinzenal",
        sucesso: true,
        degradado: r.origemUrl === "fallback",
        erro: r.avisoRaspagem,
        duracaoMs: Date.now() - inicio,
        extra: {
          url: r.url,
          origemUrl: r.origemUrl,
          registrosMarilia: r.registrosMarilia,
          gravados: r.gravados,
          removidos: r.removidos,
        },
      });
      logger.info(
        `NEXO contas irregulares — cron OK: ${r.gravados} de Marília ` +
          `(${r.removidos} removidos; URL via ${r.origemUrl})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`NEXO contas irregulares — cron sem coleta: ${msg}`);
      await gravarSyncState({
        syncId: "contas_irregulares",
        fonte: "tce-ficha-limpa",
        colecao: COLECAO,
        cadencia: "quinzenal",
        sucesso: false,
        degradado: true,
        erro: msg,
        duracaoMs: Date.now() - inicio,
      });
    }
  },
);
