/**
 * DOADORES DE CAMPANHA — receitas eleitorais do TSE (dados abertos).
 *
 * Cruza quem FINANCIOU candidatos de São Paulo com o resto do grafo NEXO: o
 * mesmo CPF/CNPJ que doou pra uma campanha pode ser sócio de um fornecedor da
 * Prefeitura, ou o próprio fornecedor. O elo é o `docHashDoador` (hashDoc do
 * documento do doador, de `./pii`) — casa com `docHash` de empenhos, sócios e
 * sanções no motor de linkage. NUNCA persiste o CPF cru (LGPD).
 *
 * ── ENQUADRAMENTO (LEIA ANTES DE USAR ESTES DADOS) ───────────────────────────
 * Doação de campanha é ATO LÍCITO e PÚBLICO por definição (Lei 9.504/97; o TSE
 * publica justamente para dar transparência). Coincidir como doador de campanha
 * E como fornecedor/sócio NÃO é, por si só, ilícito, irregularidade ou
 * improbidade. Esta coleção é INSUMO INVESTIGATIVO, não acusação:
 *   • NADA aqui afirma ou sugere infração; NÃO há juízo de Lei 8.429/92
 *     (improbidade) nem de qualquer outro tipo — isso depende de apuração com
 *     contraditório que este pipeline não faz e não pode fazer.
 *   • Qualquer detector/painel que consuma `nexo_doacoes_tse` deve rotular o
 *     achado como VÍNCULO A APURAR, com classificação NO MÁXIMO `'atencao'`
 *     (nunca `'critico'`), e texto que deixe explícito "doação lícita; relação a
 *     verificar; sem acusação".
 *   • Casamento por NOME (sem CPF/CNPJ batendo) é frágil (homônimos) e deve ser
 *     tratado como `'informativo'` apenas — nunca como vínculo confirmado.
 *   • ENTE PÚBLICO NÃO É DOADOR FISCALIZÁVEL: recursos do próprio candidato,
 *     do partido, do Fundo Partidário/FEFC e de órgãos públicos são descartados
 *     na ingestão (ver `ehDoadorEntePublicoOuFundo`) — não viram doc, não entram
 *     no grafo, espelhando a regra P0 do NEXO de excluir Prefeitura/órgãos.
 *
 * ── DE ONDE VEM (endpoint REAL, confirmado por inspeção em jun/2026) ──────────
 * O Portal de Dados Abertos do TSE (CKAN) publica, por ano eleitoral, o dataset
 * `prestacao-de-contas-eleitorais-AAAA`. O recurso "Prestação de contas de
 * candidatos" é UM único ZIP nacional no CDN:
 *
 *   https://cdn.tse.jus.br/estatistica/sead/odsele/prestacao_contas/
 *     prestacao_de_contas_eleitorais_candidatos_AAAA.zip
 *
 * Dentro do ZIP, as RECEITAS vêm separadas por UF em arquivos CSV:
 *   `receitas_candidatos_AAAA_SP.csv`  (é o que nos interessa — UF=SP)
 *   `receitas_candidatos_AAAA_BRASIL.csv` (consolidado nacional — ignorado)
 *   `receitas_candidatos_doador_originario_AAAA_SP.csv` (origem do doador
 *      originário; outro recorte — ignorado aqui)
 *
 * Tamanhos REAIS (Content-Length em jun/2026):
 *   2024 (Municipais): ZIP 1,29 GB; `receitas_candidatos_2024_SP.csv` = 263 MB
 *      descompactado (34 MB comprimido, DEFLATE).
 *   2022 (Gerais):     ZIP 376 MB.
 *   2020 (Municipais): ZIP 1,29 GB.
 *
 * ── ANOS ANTIGOS (2012/2016 — layout PRÉ-repadronização) ─────────────────────
 * O TSE NÃO repadronizou a prestação de contas antiga: ZIP e entradas têm nomes
 * próprios e o header é em português corrido (parsing validado nesta base em
 * `scripts/eleicoes/baixa_receitas.mjs`/`gera_doadores.mjs`):
 *   2016: `prestacao_contas_final_2016.zip` (1,1 GB), entrada
 *      `receitas_candidatos_prestacao_contas_final_2016_SP.txt`
 *      (fallback `_brasil.txt` se o recorte por UF não existir).
 *   2012: `prestacao_final_2012.zip` (671 MB), entrada
 *      `receitas_candidatos_2012_SP.txt` (fallback `_brasil`).
 *   Headers antigos: "CPF/CNPJ do doador", "Nome do doador (Receita Federal)",
 *   "Valor receita" (vírgula decimal), "Sigla  Partido" (com espaço DUPLO),
 *   "Numero UE"… — mesmos latin-1/`;`/aspas. Por isso TODAS as colunas são
 *   resolvidas pelo CABEÇALHO com lista de nomes possíveis, nunca por índice.
 *   FILTRO dos anos antigos: UE DO CANDIDATO = 66818 (Marília), não a UF —
 *   CUIDADO: existe também "Sigla UE doador", que pode ser 66818 numa linha de
 *   candidato de OUTRA cidade; filtrar por ela contaminaria a base. (Nos anos
 *   modernos mantemos SP inteira, como sempre foi.)
 *
 * ── COMO BAIXAMOS SEM PUXAR 1,29 GB ──────────────────────────────────────────
 * O CDN do TSE suporta `Accept-Ranges: bytes` (HTTP Range, 206 Partial Content
 * — VERIFICADO). Em vez de baixar o ZIP inteiro, lemos só o que precisamos:
 *
 *   1. Range-GET da CAUDA (~últimos 4 MB) → contém o End Of Central Directory
 *      e o central directory inteiro (só ~10 KB / 112 entradas no de 2024).
 *      Os ZIPs do TSE são < 4 GB, então o CD é de 32 bits (sem ZIP64).
 *   2. Parseamos o CD, achamos só a entrada `receitas_candidatos_AAAA_SP.csv`
 *      (offset do local header, tamanho comprimido, método).
 *   3. Range-GET só dos bytes daquela entrada (34 MB no de 2024), inflamos com
 *      `zlib.inflateRawSync` (DEFLATE) e varremos o CSV linha a linha.
 *
 * Resultado: ~38 MB de download e 263 MB inflados na memória — cabe numa
 * function de 1 GiB. Baixar 1,29 GB num cron de 60 s seria inviável; por isso o
 * caminho principal é um onCall ADMIN de backfill (`onNexoBackfillTseDoacoes`),
 * acionado sob demanda. NÃO há cron pesado: os dados de prestação de contas só
 * mudam quando o TSE republica (raro, pós-eleição), então re-rodar o backfill à
 * mão quando o `Last-Modified` muda é suficiente e barato.
 *
 * ── O QUE TEM NO CSV (header REAL do `receitas_candidatos_2024_SP.csv`) ───────
 * 60 colunas, `;`-delimitado, aspas `"`, encoding LATIN-1 (ISO-8859-1), decimal
 * com vírgula (ex.: `"136,50"`). As que usamos (índice confirmado no header):
 *   AA_ELEICAO (ano), SG_UF (UF do prestador), NM_UE (município/unidade
 *   eleitoral), DS_CARGO (cargo), NM_CANDIDATO, SG_PARTIDO,
 *   NR_CPF_CNPJ_DOADOR (doc do doador), NM_DOADOR, VR_RECEITA (valor).
 * Lemos por NOME de coluna (a partir do header), não por índice fixo, pra
 * sobreviver a uma eventual reordenação entre anos.
 *
 * ── PERSISTÊNCIA ─────────────────────────────────────────────────────────────
 * `nexo_doacoes_tse`, 1 doc por receita, docId DETERMINÍSTICO (idempotente —
 * re-rodar SOBRESCREVE, nunca duplica). Campos:
 *   { docHashDoador, docMasc, nomeDoador, candidato, cargo, partido, ano, uf,
 *     municipio, valor, _fonte:'tse', ... }
 *
 * Self-contained: igual ao resto de `functions/nexo`, não importa de `src/`;
 * usa só `node:zlib`, `node:crypto` e o `./pii` local.
 */
import { onCall, HttpsError, onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import { hashDoc, mascararDoc } from "./pii";
import { chaveFraca, cpf6De } from "./chaves";

// ── Constantes da fonte ──────────────────────────────────────────────────────

/** Base do CDN do TSE onde ficam os ZIP de prestação de contas. */
const TSE_CDN_BASE =
  "https://cdn.tse.jus.br/estatistica/sead/odsele/prestacao_contas";

/**
 * Monta a URL do ZIP nacional de candidatos para um ano eleitoral. Os anos
 * antigos (pré-repadronização) têm nome de ZIP PRÓPRIO — o padrão
 * `prestacao_de_contas_eleitorais_candidatos_{ano}` só vale de 2018 em diante.
 */
function urlZipCandidatos(ano: number): string {
  const nome =
    ano === 2016
      ? "prestacao_contas_final_2016"
      : ano === 2012
        ? "prestacao_final_2012"
        : `prestacao_de_contas_eleitorais_candidatos_${ano}`;
  return `${TSE_CDN_BASE}/${nome}.zip`;
}

/**
 * Padrões (em ORDEM DE PREFERÊNCIA) da entrada de receitas dentro do ZIP.
 * Anos modernos: `receitas_candidatos_{ano}_{UF}.csv` — nome exato. (NÃO o
 * `_doador_originario_`, que é outro recorte; o `$` do padrão descarta esse.)
 * Anos antigos (2012/2016): TXT com nome próprio; preferimos o recorte da UF e
 * caímos para o consolidado `_brasil` se o recorte por UF não existir no ZIP
 * (mesma regra do script validado `scripts/eleicoes/baixa_receitas.mjs`).
 */
function padroesEntradaReceitas(ano: number, uf: string): RegExp[] {
  const u = uf.toUpperCase();
  if (ano === 2016) {
    return [
      new RegExp(
        `^receitas_candidatos_prestacao_contas_final_2016_${u}\\.txt$`,
        "i",
      ),
      /^receitas_candidatos_prestacao_contas_final_2016_brasil\.txt$/i,
    ];
  }
  if (ano === 2012) {
    return [
      new RegExp(`^receitas_candidatos_2012_${u}\\.(txt|csv)$`, "i"),
      /^receitas_candidatos_2012_brasil\.(txt|csv)$/i,
    ];
  }
  return [new RegExp(`^receitas_candidatos_${ano}_${u}\\.csv$`, "i")];
}

/** UF foco da fiscalização (Marília-SP). */
const UF_ALVO = "SP";

/**
 * Código TSE da unidade eleitoral de Marília-SP. Nos ANOS ANTIGOS filtramos por
 * ele (UE do CANDIDATO) em vez da UF — ver bloco "ANOS ANTIGOS" no topo.
 */
const UE_ALVO = "66818";

// ── Exclusão de ente público / recurso público (espelha perfil-entidades.ts) ──
//
// Doador que NÃO é terceiro fiscalizável: o próprio candidato, o partido, o
// Fundo Partidário/FEFC, e órgãos públicos. Esses NÃO podem virar um "doador"
// linkável a fornecedor — seria falso (recurso público/próprio não é doação de
// terceiro) e politicamente temerário. Espelha a regra P0 do NEXO de excluir
// Prefeitura/órgãos da lista de fornecedores.

/**
 * Termos inequívocos de ente público no NOME do doador (sobre o nome
 * normalizado, sem acento, caixa-alta). Mesma família de `RE_ORGAO_PUBLICO` em
 * `perfil-entidades.ts`, acrescida de termos típicos de prestação de contas
 * eleitoral (partido, diretório, fundo partidário, FEFC).
 */
const RE_DOADOR_NAO_FISCALIZAVEL =
  /\b(PREFEITURA|MUNICIPIO DE|CAMARA MUNICIPAL|FUNDO MUNICIPAL|INSTITUTO DE PREVIDENCIA|IPREMM|AUTARQUIA|FUNDACAO PUBLICA|SECRETARIA MUNICIPAL|SERVICO AUTONOMO|SAAE|DAEM|DAEMA|ESTADO DE SAO PAULO|UNIAO FEDERAL|TESOURO (NACIONAL|MUNICIPAL)|PARTIDO|DIRETORIO (NACIONAL|ESTADUAL|MUNICIPAL|REGIONAL)|FUNDO PARTIDARIO|FUNDO ESPECIAL DE FINANCIAMENTO|FEFC|COMISSAO PROVISORIA)\b/;

/**
 * Valores de `DS_ORIGEM_RECEITA`/`DS_FONTE_RECEITA`/`DS_ESPECIE_RECEITA` (TSE)
 * que indicam recurso PRÓPRIO/PÚBLICO — não é doação de terceiro. Casados por
 * substring sobre o texto normalizado (sem acento, caixa-alta).
 */
const RE_ORIGEM_NAO_FISCALIZAVEL =
  /(RECURSOS? PROPRIOS|RECURSO PROPRIO|FUNDO PARTIDARIO|FUNDO ESPECIAL|FINANCIAMENTO PUBLICO|RECURSOS DE PARTIDO|RECURSOS DE OUTROS CANDIDATOS|PROPRIO CANDIDATO)/;

/** CNPJs (só dígitos) de entes públicos — espelha `perfil-entidades.ts`. */
const ENTES_PUBLICOS = new Set<string>([
  "44477909000100", // Prefeitura Municipal de Marília
  "59989830000136", // IPREMM — RPPS de Marília
]);

/** Tira acento e normaliza para casar com as regex acima. */
function normNome(v: unknown): string {
  return (v == null ? "" : String(v))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `true` quando a "receita" NÃO é uma doação de terceiro fiscalizável: doador é
 * órgão público / partido / fundo público, ou o documento é de um ente público
 * conhecido, ou a ORIGEM declarada é recurso próprio/público. Essas linhas são
 * DESCARTADAS na ingestão (não viram doc, não entram no grafo).
 */
function ehDoadorEntePublicoOuFundo(
  nomeDoador: string,
  docDigitos: string,
  origem: string,
): boolean {
  if (docDigitos && ENTES_PUBLICOS.has(docDigitos)) return true;
  if (docDigitos.length >= 8 && ENTES_PUBLICOS.has(docDigitos.slice(0, 8) + "000100")) {
    return true;
  }
  if (RE_DOADOR_NAO_FISCALIZAVEL.test(normNome(nomeDoador))) return true;
  if (origem && RE_ORIGEM_NAO_FISCALIZAVEL.test(normNome(origem))) return true;
  return false;
}

/**
 * Anos eleitorais com municipais de SP (escopo do NEXO) + 2022 (gerais) se o
 * operador pedir. Default do backfill: as duas municipais mais recentes.
 */
const ANOS_PADRAO = [2024, 2020];

/** Anos aceitos pelo backfill (sanidade do parâmetro). */
const ANO_MIN = 2002;
const ANO_MAX = 2100;

const TIMEOUT_TAIL_MS = 30_000;
const TIMEOUT_ENTRADA_MS = 300_000; // 34 MB comprimido — folga generosa.

/** Quanto da cauda do ZIP baixar pra pegar o central directory inteiro. */
const TAIL_BYTES = 4_000_000;

/**
 * UA de browser — o CDN do TSE costuma recusar clients sem UA (mesmo padrão de
 * `coleta-dom.ts`).
 */
const HTTP_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
};

// ── HTTP com Range ───────────────────────────────────────────────────────────

/** Lê o Content-Length total do ZIP (HEAD). Lança em erro de rede/HTTP. */
async function tamanhoTotal(url: string): Promise<number> {
  const res = await fetch(url, {
    method: "HEAD",
    headers: HTTP_HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_TAIL_MS),
  });
  if (!res.ok) {
    throw new Error(`HEAD ${url} → HTTP ${res.status}`);
  }
  const len = Number(res.headers.get("content-length"));
  if (!Number.isFinite(len) || len <= 0) {
    throw new Error(`HEAD ${url} sem Content-Length utilizável`);
  }
  return len;
}

/**
 * Range-GET absoluto `[inicio, fim]` (inclusivo) → Buffer. Exige 206 (Partial
 * Content): se o servidor responder 200 ele ignorou o Range e mandaria o ZIP
 * inteiro, o que NÃO queremos baixar — então tratamos 200 como erro.
 */
async function getRange(
  url: string,
  inicio: number,
  fim: number,
  timeoutMs: number,
): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { ...HTTP_HEADERS, Range: `bytes=${inicio}-${fim}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 200) {
    throw new Error(
      `${url} ignorou o header Range (HTTP 200); abortando para não ` +
        "baixar o ZIP inteiro",
    );
  }
  if (res.status !== 206) {
    throw new Error(`Range-GET ${url} → HTTP ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ── Parsing do ZIP (central directory de 32 bits, sem ZIP64) ─────────────────

export interface EntradaZip {
  nome: string;
  /** Método de compressão: 0 = stored, 8 = deflate. */
  metodo: number;
  tamComprimido: number;
  tamDescomprimido: number;
  /** Offset absoluto do LOCAL file header dentro do ZIP. */
  offsetLocal: number;
}

const SIG_EOCD = 0x06054b50; // PK\x05\x06 — End Of Central Directory.
const SIG_CD = 0x02014b50; // PK\x01\x02 — Central Directory file header.
const SIG_LOCAL = 0x04034b50; // PK\x03\x04 — Local file header.

/**
 * Acha o EOCD varrendo a cauda de trás pra frente. Retorna o offset do EOCD
 * dentro do buffer `tail`, ou -1.
 */
function acharEocd(tail: Buffer): number {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Parseia o central directory a partir da CAUDA do ZIP. `tailStartAbs` é o
 * offset absoluto (no ZIP completo) onde `tail` começa, pra converter os
 * offsets do CD (que são absolutos) em índices dentro de `tail`.
 *
 * Se o CD não couber inteiro na cauda baixada (ZIP gigante com CD enorme), o
 * chamador deve baixar uma cauda maior — sinalizamos isso lançando.
 */
function parseCentralDirectory(
  tail: Buffer,
  tailStartAbs: number,
): EntradaZip[] {
  const eocd = acharEocd(tail);
  if (eocd < 0) {
    throw new Error("ZIP sem EOCD na cauda (cauda pequena demais ou ZIP64?)");
  }
  const totalEntradas = tail.readUInt16LE(eocd + 10);
  const cdOffsetAbs = tail.readUInt32LE(eocd + 16);
  // 0xFFFFFFFF nesses campos indica ZIP64 — os ZIP do TSE são < 4 GB, então
  // não esperamos isso; se acontecer, falhamos explicitamente (honesto).
  if (cdOffsetAbs === 0xffffffff) {
    throw new Error("ZIP64 detectado (CD > 4 GB); parser não suporta");
  }
  const cdInicioNaTail = cdOffsetAbs - tailStartAbs;
  if (cdInicioNaTail < 0) {
    throw new Error(
      "Central directory fora da cauda baixada; aumente TAIL_BYTES",
    );
  }

  const entradas: EntradaZip[] = [];
  let p = cdInicioNaTail;
  for (let n = 0; n < totalEntradas; n++) {
    if (p + 46 > tail.length || tail.readUInt32LE(p) !== SIG_CD) {
      throw new Error(
        `Central directory truncado na entrada ${n}/${totalEntradas}; ` +
          "aumente TAIL_BYTES",
      );
    }
    const metodo = tail.readUInt16LE(p + 10);
    const tamComprimido = tail.readUInt32LE(p + 20);
    const tamDescomprimido = tail.readUInt32LE(p + 24);
    const nameLen = tail.readUInt16LE(p + 28);
    const extraLen = tail.readUInt16LE(p + 30);
    const commentLen = tail.readUInt16LE(p + 32);
    const offsetLocal = tail.readUInt32LE(p + 42);
    const nome = tail.toString("latin1", p + 46, p + 46 + nameLen);
    entradas.push({
      nome,
      metodo,
      tamComprimido,
      tamDescomprimido,
      offsetLocal,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entradas;
}

/**
 * Baixa só os bytes de UMA entrada do ZIP e devolve seu CSV descomprimido como
 * Buffer. Lê o local header (cujos `nameLen`/`extraLen` podem diferir do CD)
 * pra achar onde os dados comprimidos começam, e inflar com DEFLATE.
 */
async function baixarEInflarEntrada(
  url: string,
  e: EntradaZip,
): Promise<Buffer> {
  // O local header tem 30 bytes fixos + nameLen + extraLen (variáveis e
  // possivelmente != do CD). Baixamos o header + os dados comprimidos numa
  // única faixa, com folga de 4 KB para o cabeçalho/extra.
  const HEADER_FOLGA = 4_096;
  const inicio = e.offsetLocal;
  const fim = e.offsetLocal + 30 + HEADER_FOLGA + e.tamComprimido;
  const buf = await getRange(url, inicio, fim, TIMEOUT_ENTRADA_MS);

  if (buf.readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error(`Local header inválido para ${e.nome}`);
  }
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataInicio = 30 + nameLen + extraLen;
  const comprimido = buf.subarray(dataInicio, dataInicio + e.tamComprimido);

  if (e.metodo === 0) {
    return Buffer.from(comprimido); // stored (sem compressão)
  }
  if (e.metodo === 8) {
    return inflateRawSync(comprimido); // deflate
  }
  throw new Error(`Método de compressão não suportado (${e.metodo}) em ${e.nome}`);
}

/**
 * Fachada reutilizável do download seletivo (usada aqui e por
 * `coleta-tse-candidatos.ts`): HEAD → cauda/central directory → acha a PRIMEIRA
 * entrada que casa com os padrões (testados em ORDEM DE PREFERÊNCIA, sobre o
 * basename) → Range-GET só dela → infla. Nunca baixa o ZIP inteiro. Lança com
 * uma amostra dos nomes do ZIP quando nada casa (diagnóstico de layout).
 */
export async function baixarEntradaZipPorRange(
  url: string,
  padroes: RegExp[],
): Promise<{ entrada: EntradaZip; dados: Buffer; tamanhoZip: number }> {
  const total = await tamanhoTotal(url);
  const tailStart = Math.max(0, total - TAIL_BYTES);
  const tail = await getRange(url, tailStart, total - 1, TIMEOUT_TAIL_MS);
  const entradas = parseCentralDirectory(tail, tailStart);

  let entrada: EntradaZip | undefined;
  for (const re of padroes) {
    entrada = entradas.find((e) => re.test(e.nome.split("/").pop() ?? ""));
    if (entrada) break;
  }
  if (!entrada) {
    const amostra = entradas
      .map((e) => e.nome)
      .slice(0, 15)
      .join(", ");
    throw new Error(
      `Nenhuma entrada do ZIP ${url} casa com ` +
        `${padroes.map(String).join(" | ")}. Entradas vistas: ` +
        `${amostra || "(nenhuma)"}`,
    );
  }
  const dados = await baixarEInflarEntrada(url, entrada);
  return { entrada, dados, tamanhoZip: total };
}

// ── Parsing do CSV TSE (`;`-delimitado, aspas, latin-1, decimal vírgula) ──────

/**
 * Quebra uma linha CSV no padrão TSE: campos `;`-separados, cada um entre
 * aspas duplas, com `""` representando aspas literais — respeita `;` DENTRO de
 * aspas (nomes antigos como `"EMPRESA X; FILIAL Y"` não quebram o parse).
 * Exportado para `coleta-tse-candidatos.ts` (mesmo dialeto).
 */
export function parseLinhaCsv(linha: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = linha.length;
  while (i <= n) {
    if (i < n && linha[i] === '"') {
      // Campo entre aspas.
      i++;
      let val = "";
      while (i < n) {
        if (linha[i] === '"') {
          if (i + 1 < n && linha[i + 1] === '"') {
            val += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          val += linha[i++];
        }
      }
      out.push(val);
    } else {
      // Campo sem aspas (números podem vir sem aspas no TSE).
      let val = "";
      while (i < n && linha[i] !== ";") val += linha[i++];
      out.push(val);
    }
    if (i < n && linha[i] === ";") {
      i++;
      if (i === n) out.push(""); // ; no fim → campo vazio final
    } else {
      break;
    }
  }
  return out;
}

/**
 * Itera as LINHAS de um Buffer latin-1 sem materializar o arquivo inteiro como
 * uma única string: os TXT antigos do TSE chegam a centenas de MB e o
 * consolidado `_brasil` (fallback) passaria do limite de string do V8
 * (~512M chars) num `toString()` único. Decodifica linha a linha (quebra em
 * `\n`, descarta `\r` final). Exportado para `coleta-tse-candidatos.ts`.
 */
export function* linhasLatin1(buf: Buffer): Generator<string> {
  let inicio = 0;
  while (inicio < buf.length) {
    let fim = buf.indexOf(0x0a, inicio); // \n
    if (fim < 0) fim = buf.length;
    let fimLinha = fim;
    if (fimLinha > inicio && buf[fimLinha - 1] === 0x0d) fimLinha--; // \r
    yield buf.toString("latin1", inicio, fimLinha);
    inicio = fim + 1;
  }
}

/**
 * Limpa os valores-sentinela do TSE que significam "vazio" (`#NULO#`, `#NE#`,
 * `-1`, `-4` — muito comuns nos arquivos antigos). Retorna "" nesses casos.
 */
export function limparTse(v: unknown): string {
  const s = (v == null ? "" : String(v)).trim();
  if (!s || s === "#NULO#" || s === "#NE#" || s === "-1" || s === "-4") return "";
  return s;
}

/**
 * Normaliza uma célula de CABEÇALHO para comparação entre layouts: sem acento,
 * caixa-alta, pontuação vira espaço, espaços colapsados. Assim
 * `"Sigla  Partido"` (espaço DUPLO, real no TSE 2012/2016), `"SG_PARTIDO"` e
 * `"CPF/CNPJ do doador"` viram formas estáveis e comparáveis.
 */
function normHeader(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Resolvedor de colunas pelo CABEÇALHO com LISTA de nomes possíveis (o layout
 * varia por ano: `NR_CPF_CNPJ_DOADOR` em 2018+, "CPF/CNPJ do doador" em
 * 2012/2016). Procura primeiro por igualdade EXATA em TODOS os nomes e só
 * depois por substring — a passada exata primeiro é o que evita cair em
 * armadilhas tipo "Sigla UE doador" quando o alvo é a UE DO CANDIDATO (mesma
 * estratégia validada em `scripts/eleicoes/gera_doadores.mjs`). Retorna o
 * índice da coluna ou -1. Exportado para `coleta-tse-candidatos.ts`.
 */
export function criarResolvedorColunas(
  headerCells: string[],
): (...nomes: string[]) => number {
  const norm = headerCells.map(normHeader);
  return (...nomes: string[]): number => {
    for (const nm of nomes) {
      const i = norm.indexOf(normHeader(nm));
      if (i >= 0) return i;
    }
    for (const nm of nomes) {
      const alvo = normHeader(nm);
      if (!alvo) continue;
      const i = norm.findIndex((h) => h.includes(alvo));
      if (i >= 0) return i;
    }
    return -1;
  };
}

/** Converte valor monetário BR (`"1.234,56"` ou `"136,50"`) em número. */
function parseValorBr(v: string): number {
  const s = (v ?? "").trim();
  if (!s) return 0;
  const num = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(num) ? num : 0;
}

/** Só os dígitos do documento. */
function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

/** Converte data BR (`dd/MM/yyyy`) para ISO `yyyy-MM-dd`, ou null. */
function parseDataBr(v: string): string | null {
  const m = (v ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

interface Doacao {
  docHashDoador: string;
  docMasc: string;
  nomeDoador: string;
  candidato: string;
  cargo: string;
  partido: string;
  ano: number;
  uf: string;
  municipio: string;
  valor: number;
  /** Campos auxiliares de proveniência/idempotência. */
  sqReceita: string;
  dataReceita: string | null;
  numReciboDoacao: string;
  /**
   * 6 dígitos do miolo do CPF do doador PF (`cpf.slice(3,9)`) — componente do
   * `chaveFraca`. NÃO identifica sozinho. "" para doador PJ (CNPJ).
   */
  cpf6: string;
  /**
   * Chave fraca doador↔sócio = `hashDoc(normNome(nome)+"|"+cpf6)`. ÚNICA forma
   * de casar com o sócio da Receita (CPF cheio data-blocked dos dois lados).
   * Indício a apurar, nunca acusação. "" para doador PJ ou sem nome.
   */
  chaveFraca: string;
  /** Raiz do CNPJ (8 díg) quando doador é PJ — chave de entity-resolution. "" p/ PF. */
  cnpjRaiz: string;
}

/**
 * Constrói um docId DETERMINÍSTICO por receita. Preferimos a chave natural do
 * TSE `SQ_RECEITA` (sequencial único da receita); como fallback (linhas sem
 * SQ_RECEITA) hasheamos o conjunto identificador da linha. Prefixado por ano+UF
 * pra legibilidade e pra nunca colidir entre cargas.
 */
function docIdReceita(
  ano: number,
  uf: string,
  sqReceita: string,
  d: Doacao,
): string {
  if (sqReceita && /^\d+$/.test(sqReceita)) {
    return `tse_${ano}_${uf}_${sqReceita}`;
  }
  const chave = [
    ano,
    uf,
    d.docHashDoador,
    d.candidato,
    d.valor,
    d.dataReceita ?? "",
    d.numReciboDoacao,
  ].join("|");
  const h = createHash("sha256").update(chave).digest("hex").slice(0, 24);
  return `tse_${ano}_${uf}_h${h}`;
}

/**
 * Varre o CSV/TXT de receitas (Buffer latin-1) e devolve as doações do recorte
 * alvo. Lê por NOME de coluna a partir do header, com LISTA de nomes possíveis
 * por coluna — robusto a reordenação entre anos E aos rótulos antigos de
 * 2012/2016. O LAYOUT é detectado pelo próprio header (presença de
 * `NR_CPF_CNPJ_DOADOR` = moderno), não pelo ano — se o TSE repadronizar o
 * histórico, isto continua certo. Recorte:
 *   • moderno: UF inteira (todo candidato de SP), como sempre foi;
 *   • antigo:  UE DO CANDIDATO = 66818 (Marília) — ver bloco no topo (existe
 *     "Sigla UE doador" no mesmo arquivo; filtrar por ela seria contaminação).
 */
function extrairDoacoes(
  csv: Buffer,
  ano: number,
  uf: string,
): Doacao[] {
  const linhas = linhasLatin1(csv);
  const primeira = linhas.next();
  if (primeira.done) return [];

  const headerCells = parseLinhaCsv(primeira.value);
  const col = criarResolvedorColunas(headerCells);

  // Cada coluna com seus nomes possíveis: moderno primeiro, antigos depois.
  const iAno = col("AA_ELEICAO", "ANO_ELEICAO", "Ano eleição");
  const iUf = col("SG_UF", "UF");
  const iMunic = col("NM_UE", "Nome da UE", "Municipio");
  const iCargo = col("DS_CARGO", "Cargo");
  const iCand = col("NM_CANDIDATO", "Nome candidato");
  const iPartido = col("SG_PARTIDO", "Sigla  Partido"); // espaço duplo real
  const iDoc = col("NR_CPF_CNPJ_DOADOR", "CPF/CNPJ do doador");
  const iNomeDoador = col("NM_DOADOR", "Nome do doador");
  const iNomeDoadorRfb = col(
    "NM_DOADOR_RFB",
    "Nome do doador (Receita Federal)",
  );
  const iValor = col("VR_RECEITA", "Valor receita");
  const iSqReceita = col("SQ_RECEITA");
  const iData = col("DT_RECEITA", "Data da receita");
  const iRecibo = col(
    "NR_RECIBO_DOACAO",
    "Numero Recibo Eleitoral",
    "Numero do recibo eleitoral",
  );
  // UE do CANDIDATO — a passada EXATA do resolvedor é o que impede cair em
  // "Sigla UE doador"/"Numero UE doador" (armadilha real dos layouts antigos).
  const iUeCand = col("SG_UE", "Numero UE", "Sigla da UE");
  // Colunas de classificação da origem (qualquer uma que exista é usada para
  // detectar recurso próprio/público — não é doação de terceiro fiscalizável).
  const iOrigem = col("DS_ORIGEM_RECEITA", "Fonte recurso");
  const iFonte = col("DS_FONTE_RECEITA", "Descricao da receita");
  const iEspecie = col("DS_ESPECIE_RECEITA", "Tipo receita");
  const iNatureza = col("DS_NATUREZA_RECEITA", "Especie recurso");

  // Layout detectado pelo header, não pelo ano (à prova de repadronização).
  const moderno = col("NR_CPF_CNPJ_DOADOR") >= 0;

  // Sanidade: as colunas essenciais precisam existir, senão o layout mudou.
  if (iDoc < 0 || iValor < 0 || iCand < 0) {
    throw new Error(
      "Header do CSV de receitas TSE sem colunas esperadas " +
        "(CPF/CNPJ do doador / valor / candidato); layout pode ter mudado. " +
        `Header visto: ${headerCells.slice(0, 12).join(" | ")}`,
    );
  }
  if (!moderno && iUeCand < 0) {
    throw new Error(
      "Layout antigo do TSE sem coluna de UE do candidato (Numero UE/Sigla " +
        "da UE) — sem ela não dá pra filtrar Marília com segurança; abortando " +
        "para não ingerir o estado/país inteiro por engano",
    );
  }

  const out: Doacao[] = [];
  for (const linha of linhas) {
    if (!linha) continue;
    // Pré-filtro BARATO dos anos antigos: linha de Marília contém "66818" em
    // algum campo; quem nem contém a substring não precisa ser parseada (o TXT
    // tem centenas de milhares de linhas de outras cidades). Falso-positivo
    // (ex.: "66818" dentro de um CPF) é eliminado pela checagem de coluna.
    if (!moderno && !linha.includes(UE_ALVO)) continue;

    const c = parseLinhaCsv(linha);
    if (c.length < headerCells.length - 2) continue; // linha truncada/lixo

    let ufLinha: string;
    if (moderno) {
      ufLinha = (iUf >= 0 ? c[iUf] : uf).trim().toUpperCase();
      if (ufLinha !== uf.toUpperCase()) continue; // garante UF=SP
    } else {
      // Antigo: recorte por UE DO CANDIDATO = Marília (nunca a UE do doador).
      if (soDigitos(c[iUeCand]) !== UE_ALVO) continue;
      ufLinha = (iUf >= 0 ? limparTse(c[iUf]).toUpperCase() : "") ||
        uf.toUpperCase();
    }

    const docDig = soDigitos(limparTse(iDoc >= 0 ? c[iDoc] : ""));
    // Nome do doador: no layout antigo preferimos o nome da RECEITA FEDERAL
    // (mais estável p/ chaveFraca — o lado sócio também vem da Receita), com
    // fallback pro declarado; no moderno mantemos NM_DOADOR (compatibilidade
    // com a chaveFraca dos docs já persistidos de 2020/2024).
    const nomeDeclarado = limparTse(iNomeDoador >= 0 ? c[iNomeDoador] : "");
    const nomeRfb = limparTse(iNomeDoadorRfb >= 0 ? c[iNomeDoadorRfb] : "");
    const nomeDoador = moderno ? nomeDeclarado : nomeRfb || nomeDeclarado;

    // EXCLUI ente público / recurso próprio / partido / fundo público: não é
    // doador terceiro fiscalizável; não vira doc, não entra no grafo (regra P0).
    const origemTxt = [iOrigem, iFonte, iEspecie, iNatureza]
      .filter((i) => i >= 0)
      .map((i) => c[i] ?? "")
      .join(" | ");
    if (ehDoadorEntePublicoOuFundo(nomeDoador, docDig, origemTxt)) continue;

    // 6 dígitos do miolo do CPF (PF) — `cpf.slice(3,9)` via `cpf6De`; "" se PJ.
    // É o que casa com o sócio (a Receita só expõe esses 6 do CPF do sócio).
    const cpf6 = cpf6De(docDig);
    // Doador PJ: raiz do CNPJ (8 díg) para entity-resolution; PF não tem.
    const cnpjRaiz = docDig.length === 14 ? docDig.slice(0, 8) : "";

    const doacao: Doacao = {
      docHashDoador: hashDoc(docDig),
      docMasc: mascararDoc(docDig),
      nomeDoador,
      candidato: limparTse(iCand >= 0 ? c[iCand] : ""),
      cargo: limparTse(iCargo >= 0 ? c[iCargo] : ""),
      partido: limparTse(iPartido >= 0 ? c[iPartido] : ""),
      ano: iAno >= 0 ? Number(soDigitos(c[iAno])) || ano : ano,
      uf: ufLinha,
      municipio: limparTse(iMunic >= 0 ? c[iMunic] : "") ||
        (moderno ? "" : "MARÍLIA"),
      valor: parseValorBr(iValor >= 0 ? c[iValor] : ""),
      sqReceita: limparTse(iSqReceita >= 0 ? c[iSqReceita] : ""),
      dataReceita: parseDataBr(iData >= 0 ? c[iData] : ""),
      numReciboDoacao: limparTse(iRecibo >= 0 ? c[iRecibo] : ""),
      cpf6,
      chaveFraca: chaveFraca(nomeDoador, cpf6),
      cnpjRaiz,
    };
    out.push(doacao);
  }
  return out;
}

// ── Persistência ─────────────────────────────────────────────────────────────

/** Tamanho do lote de escrita (limite do batch do Firestore é 500). */
const BATCH_SIZE = 450;

/**
 * Grava as doações em `nexo_doacoes_tse` em lotes. docId determinístico +
 * `merge` → re-rodar SOBRESCREVE, nunca duplica. Retorna a contagem gravada.
 */
async function persistirDoacoes(
  doacoes: Doacao[],
  ano: number,
  uf: string,
): Promise<number> {
  const col = db.collection("nexo_doacoes_tse");
  let gravados = 0;
  for (let i = 0; i < doacoes.length; i += BATCH_SIZE) {
    const fatia = doacoes.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const d of fatia) {
      const id = docIdReceita(ano, uf, d.sqReceita, d);
      batch.set(
        col.doc(id),
        {
          docHashDoador: d.docHashDoador,
          docMasc: d.docMasc,
          nomeDoador: d.nomeDoador,
          candidato: d.candidato,
          cargo: d.cargo,
          partido: d.partido,
          ano: d.ano,
          uf: d.uf,
          municipio: d.municipio,
          valor: d.valor,
          dataReceita: d.dataReceita,
          numReciboDoacao: d.numReciboDoacao,
          sqReceita: d.sqReceita,
          // Chaves canônicas de junção (seção 2.1). `chaveFraca` casa doador PF
          // com sócio da Receita; `_cnpjRaiz` casa doador PJ por raiz de CNPJ.
          chaveFraca: d.chaveFraca,
          cpf6: d.cpf6,
          _cnpjRaiz: d.cnpjRaiz,
          // id canônico carimbado já na ingestão: PJ → raiz do CNPJ; PF → a
          // própria chave fraca (pseudônimo estável, já que o CPF é data-blocked).
          _entidadeId: d.cnpjRaiz || d.chaveFraca || null,
          _fonte: "tse",
          // Guardrail carregado no PRÓPRIO dado: doação é lícita; coincidência
          // doador↔fornecedor/sócio é vínculo A APURAR, sem acusação, sem juízo
          // de improbidade (Lei 8.429/92); detector/painel não deve passar de
          // 'atencao'. Match por nome (sem CPF) é só 'informativo'.
          _enquadramento: "doacao-licita-vinculo-a-apurar",
          _classificacaoMax: "atencao",
          _coletadoEm: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    await batch.commit();
    gravados += fatia.length;
  }
  return gravados;
}

// ── Orquestração de um ano ───────────────────────────────────────────────────

interface ResultadoAno {
  ano: number;
  uf: string;
  doacoes: number;
  gravados: number;
  tamanhoZip: number;
  csvBytes: number;
}

/**
 * Coleta as doações de um ano eleitoral para o recorte alvo: HEAD → cauda/CD →
 * acha a entrada de receitas (nome moderno OU antigo, preferindo o recorte da
 * UF) → baixa só ela → infla → parseia → persiste. Lança em qualquer falha
 * (o chamador decide como reportar).
 */
export async function coletarAno(ano: number, uf: string): Promise<ResultadoAno> {
  const url = urlZipCandidatos(ano);
  const { entrada, dados: csv, tamanhoZip } = await baixarEntradaZipPorRange(
    url,
    padroesEntradaReceitas(ano, uf),
  );
  logger.info(
    `NEXO TSE doações — ${ano}: entrada '${entrada.nome}' ` +
      `(${(csv.length / 1e6).toFixed(0)} MB inflados)`,
  );
  const doacoes = extrairDoacoes(csv, ano, uf);
  const gravados = await persistirDoacoes(doacoes, ano, uf);

  return {
    ano,
    uf,
    doacoes: doacoes.length,
    gravados,
    tamanhoZip,
    csvBytes: csv.length,
  };
}

// ── Validação do parâmetro de anos ───────────────────────────────────────────

function normalizarAnos(input: unknown): number[] {
  let anos: number[];
  if (Array.isArray(input)) {
    anos = input.map((a) => Number(a));
  } else if (input != null && input !== "") {
    anos = [Number(input)];
  } else {
    anos = [...ANOS_PADRAO];
  }
  const limpos = [...new Set(anos)].filter(
    (a) => Number.isInteger(a) && a >= ANO_MIN && a <= ANO_MAX,
  );
  if (limpos.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      `Nenhum ano válido em ${JSON.stringify(input)} (intervalo ${ANO_MIN}-${ANO_MAX}).`,
    );
  }
  return limpos.sort((a, b) => b - a);
}

// ── onCall ADMIN de backfill — caminho PRINCIPAL ─────────────────────────────

interface BackfillReq {
  anos?: number[];
  ano?: number;
  uf?: string;
}

/**
 * `onNexoBackfillTseDoacoes` — callable ADMIN que faz a coleta sob demanda.
 *
 * Uso (admin):
 *   httpsCallable(fns, 'onNexoBackfillTseDoacoes')({ anos: [2024, 2020] });
 *   httpsCallable(fns, 'onNexoBackfillTseDoacoes')({ ano: 2022, uf: 'SP' });
 *
 * Auth: custom claim `admin === true` OU `users/{uid}.role === 'admin'`
 * (mesmo padrão de `onDiarioBackfillDirect`). `memory: 1GiB` porque o CSV de SP
 * infla pra ~263 MB; `timeoutSeconds: 540` (máx) porque inflar + parsear +
 * gravar centenas de milhares de receitas leva minutos.
 */
export const onNexoBackfillTseDoacoes = onCall(
  {
    region: "us-central1",
    // 1800s/2GiB: o default [2024,2020] grava ~336k docs em ~750 commits
    // sequenciais (~300-500s só de commits) e o pico de memória do inflate+
    // toString do CSV de 263 MB passa de 800 MB — 540s/1GiB era borderline e
    // uma morte por timeout/OOM pula o gravarSyncState final (carga parcial
    // cega; auditoria 2026-06-09). onCall v2 aceita até 3600s.
    timeoutSeconds: 1800,
    memory: "2GiB",
    maxInstances: 1,
    cors: true,
  },
  async (req) => {
    if (!req.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Autenticação necessária para o backfill de doações TSE.",
      );
    }
    const isAdminClaim = req.auth.token.admin === true;
    if (!isAdminClaim) {
      const snap = await db.doc(`users/${req.auth.uid}`).get();
      const role = (snap.data() as { role?: string } | undefined)?.role;
      if (role !== "admin") {
        throw new HttpsError(
          "permission-denied",
          "Apenas administradores podem rodar o backfill de doações TSE.",
        );
      }
    }

    const data = (req.data ?? {}) as BackfillReq;
    const anos = normalizarAnos(data.anos ?? data.ano);
    const uf = (data.uf ?? UF_ALVO).toUpperCase();

    logger.info("NEXO TSE doações — backfill iniciado", {
      uid: req.auth.uid,
      anos,
      uf,
    });

    const inicio = Date.now();
    const resultados: ResultadoAno[] = [];
    const erros: { ano: number; erro: string }[] = [];

    for (const ano of anos) {
      try {
        const r = await coletarAno(ano, uf);
        resultados.push(r);
        logger.info(
          `NEXO TSE doações — ${ano}/${uf}: ${r.doacoes} doações, ` +
            `${r.gravados} gravadas (ZIP ${(r.tamanhoZip / 1e6).toFixed(0)} MB, ` +
            `CSV ${(r.csvBytes / 1e6).toFixed(0)} MB)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        erros.push({ ano, erro: msg });
        logger.error(`NEXO TSE doações — falha em ${ano}/${uf}`, err);
      }
    }

    const totalGravados = resultados.reduce((s, r) => s + r.gravados, 0);
    await gravarSyncState({
      syncId: "tse_doacoes",
      fonte: "tse",
      colecao: "nexo_doacoes_tse",
      cadencia: "diario", // disparo manual; cadência informativa para o painel
      sucesso: resultados.length > 0,
      degradado: erros.length > 0,
      erro: erros.length > 0 ? erros.map((e) => `${e.ano}: ${e.erro}`).join("; ") : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        uf,
        anosSolicitados: anos,
        anosColetados: resultados.map((r) => r.ano),
        doacoesGravadas: totalGravados,
      },
    });

    return {
      ok: erros.length === 0,
      uf,
      resultados,
      erros,
      totalGravados,
      duracaoMs: Date.now() - inicio,
    };
  },
);

// ── Wrapper HTTP do backfill (automação sem usuário logado) ──────────────────

/** Mesmo segredo/header do onNexoBackfillHttp — não cria segredo novo. */
const BACKFILL_SECRET_DOACOES = defineSecret("DIARIO_BACKFILL_SECRET");

/**
 * `onNexoBackfillTseDoacoesHttp` — mesmo miolo do onCall admin, mas invocável
 * por automação com `x-backfill-secret` (o onCall exige um usuário Firebase
 * logado com claim admin, o que impede disparo por script/agent). UM ano por
 * invocação (`?ano=2016&uf=SP`) para manter cada execução pequena e o erro de
 * um ano não engolir os outros.
 */
export const onNexoBackfillTseDoacoesHttp = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 1800,
    memory: "2GiB",
    maxInstances: 1,
    secrets: [BACKFILL_SECRET_DOACOES],
    invoker: "public",
  },
  async (req, res) => {
    const provided = String(req.headers["x-backfill-secret"] ?? "");
    const expected = BACKFILL_SECRET_DOACOES.value();
    if (!expected || provided !== expected) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ano = Number(String(req.query.ano ?? "").trim());
    if (!Number.isInteger(ano) || ano < 2012 || ano > 2030) {
      res.status(400).json({ error: "Parâmetro 'ano' obrigatório (ex.: ?ano=2016)." });
      return;
    }
    const uf = String(req.query.uf ?? UF_ALVO).toUpperCase();
    logger.info("NEXO TSE doações — backfill HTTP iniciado", { ano, uf });
    try {
      const r = await coletarAno(ano, uf);
      res.json({ ok: true, ano, uf, resultado: r });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`NEXO TSE doações — backfill HTTP ${ano} falhou: ${msg}`);
      res.status(500).json({ ok: false, ano, uf, erro: msg });
    }
  },
);

// ── Cron RARO (opcional) — só re-checa o ano corrente ────────────────────────

/**
 * `onNexoSyncTseDoacoes` — cron MENSAL que re-coleta apenas o ano eleitoral
 * corrente (se houver eleição neste ano) para a UF alvo. É raro de propósito:
 * prestação de contas só muda quando o TSE republica. Anos ANTERIORES não são
 * tocados pelo cron — esses são responsabilidade do onCall de backfill (carga
 * histórica feita à mão). Em ano SEM eleição, não faz nada.
 *
 * `maxInstances: 1` e doc IDs determinísticos tornam o retry idempotente.
 */
export const onNexoSyncTseDoacoes = onSchedule(
  {
    schedule: "0 5 1 * *", // 05:00 do dia 1 de cada mês
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    // 2 GiB: o CSV de receitas 2024/SP tem 263 MB descomprimido — inflate
    // (Buffer) + toString (UTF-16, ~2×) coexistem no pico ≈ 800 MB; 1 GiB
    // ficava no limite.
    memory: "2GiB",
    maxInstances: 1,
    retryCount: 1,
  },
  async () => {
    const inicio = Date.now();
    const anoAtual = new Date().getFullYear();

    // ANOS-ALVO. O pleito que importa para o gestor MUNICIPAL atual é o último
    // ano de eleição municipal (…2020, 2024, 2028…) — sem ele o XS-DOADOR fica
    // sem dado para sempre (o cron antigo só olhava o ano corrente; em 2026 o
    // ZIP ainda nem existe e 2024 nunca seria coletado — visto em prod
    // 2026-06-09). O ano corrente entra quando for ano eleitoral (par).
    const ultimoMunicipal = anoAtual - ((((anoAtual - 2024) % 4) + 4) % 4);
    const anosAlvo = [...new Set([ultimoMunicipal, ...(anoAtual % 2 === 0 ? [anoAtual] : [])])];

    const coletados: { ano: number; gravados: number; motivo?: string }[] = [];
    const falhas: { ano: number; erro: string }[] = [];
    let degradado = false;
    // P2-18 — motivos de degradação que NÃO são `falhas` duras (ex.: ZIP do ano
    // corrente ainda inexistente antes da eleição). Sem isso o `erro` ficava
    // vazio mesmo com `degradado:true`, impossível de diagnosticar no painel.
    const motivosDegradado: string[] = [];

    for (const ano of anosAlvo) {
      // Ano histórico JÁ coletado → pula (idempotência barata: evita re-baixar
      // ~34 MB/mês; republicação do TSE é coberta pelo onCall de backfill).
      if (ano !== anoAtual) {
        const jaTem = await db
          .collection("nexo_doacoes_tse")
          .where("ano", "==", ano)
          .limit(1)
          .get();
        if (!jaTem.empty) {
          coletados.push({ ano, gravados: 0, motivo: "ja-coletado" });
          continue;
        }
      }
      try {
        const r = await coletarAno(ano, UF_ALVO);
        coletados.push({ ano, gravados: r.gravados });
        logger.info(
          `NEXO TSE doações — cron ${ano}/${UF_ALVO}: ${r.gravados} gravadas`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // ZIP do ano corrente pode ainda não existir antes da eleição — isso é
        // "degradado", não falha de código.
        const inexistente = /HTTP 40[34]/.test(msg);
        degradado = true;
        if (!inexistente || ano !== anoAtual) {
          falhas.push({ ano, erro: msg });
        } else {
          // ZIP do ano corrente ainda não publicado (pré-eleição): degradação
          // ESPERADA, não falha — mas registra o motivo p/ o painel não ficar mudo.
          motivosDegradado.push(
            `${ano}: ZIP de prestação de contas ainda não publicado pelo TSE (${msg})`,
          );
        }
        logger.warn(`NEXO TSE doações — cron ${ano} sem coleta: ${msg}`);
      }
    }

    await gravarSyncState({
      syncId: "tse_doacoes",
      fonte: "tse",
      colecao: "nexo_doacoes_tse",
      cadencia: "diario",
      sucesso: falhas.length === 0,
      degradado: degradado || falhas.length > 0,
      // P2-18 — popula `erro` também quando a degradação é "esperada" (motivos
      // sem falha dura), para o painel nunca exibir `degradado` com erro vazio.
      erro:
        falhas.length > 0
          ? falhas.map((f) => `${f.ano}: ${f.erro}`).join("; ")
          : motivosDegradado.length > 0
            ? motivosDegradado.join("; ")
            : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        uf: UF_ALVO,
        anosAlvo,
        coletas: coletados,
        falhas: falhas.length,
        motivosDegradado,
      },
    });
  },
);

/**
 * `onNexoBackfillChaveFraca` — patch idempotente que preenche `chaveFraca`+`cpf6`
 * nos docs de `nexo_doacoes_tse` gravados por versão ANTIGA da coleta (sem as
 * chaves canônicas). NÃO re-baixa o TSE: `cpf6` (6 dígitos do miolo do CPF) vem
 * do próprio `docMasc` já gravado (`***.XXX.XXX-**` expõe exatamente
 * `cpf.slice(3,9)`), e `nomeDoador` já está no doc. Reconstrói a MESMA chaveFraca
 * que a coleta atual gravaria — a única ponte PF sócio↔doador.
 *
 * SALT: NÃO declara `secrets:["NEXO_PII_SALT"]`. sócios e doações já gravados
 * usam o SALT_FALLBACK (o segredo não está setado em nenhuma function); bindar o
 * segredo aqui RE-CHAVEARIA e o hash deixaria de casar com o lado sócio.
 *
 * LGPD: grava só `cpf6` (miolo, padrão já usado no projeto) e `chaveFraca`
 * (hash irreversível). NUNCA o CPF cru. Doador PJ → cpf6="" → pulado.
 *
 * Idempotente: só escreve quando chaveFraca/cpf6 divergem do recomputado. Admin.
 */
export const onNexoBackfillChaveFraca = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 1800,
    memory: "512MiB",
    maxInstances: 1,
    cors: true,
  },
  async (req) => {
    if (!req.auth) {
      throw new HttpsError("unauthenticated", "Autenticação necessária.");
    }
    if (req.auth.token.admin !== true) {
      const snap = await db.doc(`users/${req.auth.uid}`).get();
      const role = (snap.data() as { role?: string } | undefined)?.role;
      if (role !== "admin") {
        throw new HttpsError(
          "permission-denied",
          "Apenas administradores podem rodar o backfill de chaveFraca.",
        );
      }
    }

    const col = db.collection("nexo_doacoes_tse");
    const PAGE = 2000;
    const COMMIT = 450;
    let cursor: admin.firestore.QueryDocumentSnapshot | null = null;
    let scan = 0,
      pf = 0,
      pj = 0,
      atualizados = 0,
      jaOk = 0;

    for (;;) {
      let q = col.orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;

      let batch = db.batch();
      let ops = 0;
      for (const doc of snap.docs) {
        scan++;
        const d = doc.data() as {
          docMasc?: unknown;
          nomeDoador?: unknown;
          chaveFraca?: unknown;
          cpf6?: unknown;
        };
        const cpf6 = cpf6De(d.docMasc); // PF → 6 dígitos; PJ/"" → ""
        if (!cpf6) {
          pj++;
          continue;
        } // doador PJ: sem chaveFraca de PF
        pf++;
        const cf = chaveFraca(d.nomeDoador, cpf6); // hashDoc(normNome(nome)+"|"+cpf6)
        if (!cf) continue; // sem nome → não fabrica chave
        if (d.chaveFraca === cf && d.cpf6 === cpf6) {
          jaOk++;
          continue;
        }
        batch.set(doc.ref, { chaveFraca: cf, cpf6 }, { merge: true });
        atualizados++;
        if (++ops >= COMMIT) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }
      if (ops > 0) await batch.commit();
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < PAGE) break;
    }

    logger.info("NEXO backfill chaveFraca concluído", {
      scan,
      pf,
      pj,
      atualizados,
      jaOk,
    });
    return { ok: true, scan, pf, pj, atualizados, jaOk };
  },
);
