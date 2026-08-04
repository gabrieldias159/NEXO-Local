/**
 * Cron de ingestão de SANÇÕES ESTADUAIS (SP) — `onNexoSyncSancoesEstaduais`.
 *
 * Fecha a esfera ESTADUAL do cruzamento sanção × vínculo-vivo (hoje só a esfera
 * FEDERAL existe, em `coleta-sancoes.ts` → `nexo_sancoes`). Coleta a "Relação de
 * Apenados" do Tribunal de Contas do Estado de São Paulo (TCE-SP) — o cadastro
 * estadual de empresas/pessoas IMPEDIDAS de licitar/contratar (apenações por
 * art. 87 da Lei 8.666/93, art. 7º da Lei 10.520/02, art. 156 da Lei 14.133/21,
 * declaração de inidoneidade etc.), publicado mensalmente no D.O.E. e exposto
 * por uma API pública do próprio TCE-SP.
 *
 * Persiste em `nexo_sancoes_estaduais`, no MESMO shape de `nexo_sancoes`
 * (1 doc por CNPJ, com `sancoes[]` de campos `cadastro/cnpjSancionado/
 * nomeSancionado/tipoSancao/dataInicio/dataFim/orgaoSancionador`) acrescido de
 * `esfera: 'estadual'`. Assim o `indice-sancao-consolidada` funde federal +
 * estadual por CNPJ-raiz sem caso especial.
 *
 * Cadência: a cada 12 horas.
 *
 * ── DUAS VARREDURAS COMPLEMENTARES (ambas → docs por CNPJ, idempotentes) ──────
 *  1. POR FORNECEDOR (espelha `coleta-sancoes.ts`): lê os CNPJs dos fornecedores
 *     de Marília de `nexo_empenhos` (maior valor primeiro) e consulta o apenado
 *     daquele CNPJ — pega o fornecedor de Marília apenado por QUALQUER órgão do
 *     Estado (ex.: empresa que também atende outra prefeitura e foi apenada lá).
 *  2. POR APENADOR DE MARÍLIA: consulta `apenadorNome=MARILIA` — pega quem foi
 *     apenado por um ÓRGÃO de Marília (Prefeitura, Câmara, autarquias, UNESP de
 *     Marília etc.), inclusive empresas que ainda não aparecem em `nexo_empenhos`.
 * As duas escrevem no MESMO doc por CNPJ com `merge`, então um CNPJ que cai nas
 * duas é coletado uma vez só (o conjunto de apenações é deduplicado por `id` da
 * apenação no TCE).
 *
 * ── FONTE REAL (sondada e confirmada em jun/2026) ────────────────────────────
 * App público (AngularJS):  https://www4.tce.sp.gov.br/apenados/publico/#/
 * API REST que ele consome (sem captcha na consulta):
 *   GET .../apenados/webapi/P/impedimento?apenadoCnpj={14digitos}
 *   GET .../apenados/webapi/P/impedimento?apenadorNome={texto}
 * Retorna `application/json` — array de objetos:
 *   {
 *     "apenador":   { "codigoMainframe":"0000000555", "nome":"PREFEITURA ...", "id":505 },
 *     "apenado":    { "apenada":"ACB CONSTRUTORA EIRELI EPP", "cnpj":"31280208000135",
 *                     "cpf":null, "rg":null, "id":315242 },
 *     "processo":   "",
 *     "tipoApenacao": { "hyperlink":"http://...", "judicial":false,
 *                       "descricao":"Art. 87, inciso IV da Lei 8.666/93 – ...", "id":4 },
 *     "razao":      "DESISTÊNCIA DO CONTRATO ...",
 *     "inicio":     [2020, 9, 28],   // [ano, mês(1-based), dia]  — ou null
 *     "termino":    null,            // idem
 *     "reabilitacao": null,
 *     "id":         127434
 *   }
 * Observações confirmadas na sondagem:
 *   • o filtro `apenadoCnpj` é por DÍGITOS (CNPJ formatado retorna `[]`);
 *   • a consulta SEM nenhum filtro retorna HTTP 400 ("pelo menos um campo ...");
 *   • datas vêm como array `[ano, mês, dia]` com mês 1-based;
 *   • `apenado.cpf`/`apenado.rg` PODEM vir preenchidos (pessoa física) — NUNCA
 *     persistimos CPF/RG cru (LGPD); só guardamos o CNPJ e a apenação. Como a
 *     coleta é por CNPJ de fornecedor / por apenador de Marília, o foco é PJ.
 *
 * ── CGE-SP e-Sanções — FONTE NÃO DISPONÍVEL (degradação honesta) ──────────────
 * O e-Sanções da CGE-SP NÃO tem, hoje, endpoint público estável acessível desta
 * function (host não resolve na sondagem de jun/2026). NÃO inventamos endpoint:
 * gravamos um `nexo_sync_state` PRÓPRIO marcando a fonte como degradada/pendente
 * e seguimos com o TCE-SP. Ver `acaoDoDono` no manifest de entrega.
 *
 * Self-contained: o projeto `functions/` NÃO importa de `src/`. Replica os
 * helpers necessários (soDigitos, normalização, máscara defensiva) e usa só o
 * `fetch` global do runtime.
 *
 * Idempotência: doc por CNPJ (docId = o próprio CNPJ), `set({merge:true})`;
 * cron `maxInstances:1`; re-rodar SOBRESCREVE o conjunto de apenações do CNPJ.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

// ── Constantes da fonte ──────────────────────────────────────────────────────

/**
 * Base DIRETA da API pública de Apenados do TCE-SP (consumida pelo app
 * `publico/`). ATENÇÃO: o TCE-SP devolve HTTP 200 (~34 KB por `apenadorNome=
 * MARILIA`) deste ambiente BR, mas HTTP 403 dos ranges de IP do us-central1
 * (mesma classe de geo/IP-block do PNCP). Como esta function roda em
 * us-central1, a chamada DIRETA falha em prod — por isso roteamos pelo PROXY
 * regional (southamerica-east1, IP brasileiro). Esta base só é usada se o proxy
 * NÃO estiver configurado (ex.: dev local em IP BR), como degradação.
 */
const TCE_APENADOS_BASE = "https://www4.tce.sp.gov.br/apenados/webapi/P";

/**
 * Proxy regional BR (`onPncpProxy`, southamerica-east1) — mesma function que
 * destrava o PNCP, agora multi-host por allowlist (`host=tce-sp-apenados`). O
 * cron roteia por aqui para sair por IP brasileiro e fugir do 403 geo do
 * us-central1. Lido de `process.env.PNCP_PROXY_URL` (mesmo nome do app no
 * apphosting.yaml) com fallback ao host REAL do Cloud Run; configurável no
 * deploy das functions caso a URL do proxy mude.
 */
const PROXY_URL = (
  process.env.PNCP_PROXY_URL ?? "https://onpncpproxy-7hnbf6ypka-rj.a.run.app"
).replace(/\/+$/, "");

/**
 * Segredo compartilhado das rotas/proxy de cômputo (`x-nexo-secret`). Mesmo
 * segredo do backfill do Diário — já provisionado no Secret Manager; sem novo
 * segredo. Sem ele, o cron NÃO autentica no proxy e o ciclo degrada honesto.
 */
const PROXY_SECRET = defineSecret("DIARIO_BACKFILL_SECRET");

/** Coleção de destino — mesmo shape de `nexo_sancoes` + `esfera:'estadual'`. */
const COLECAO = "nexo_sancoes_estaduais";

const TIMEOUT_MS = 30_000;

/** Pausa entre chamadas — gentileza com o servidor do TCE-SP. */
const DELAY_MS = 300;

/**
 * Primeiro exercício monitorado retroativamente — espelha `ANO_BASE` de
 * `coleta-sancoes.ts`. A coleta de CNPJs de fornecedores segue o mesmo escopo
 * (exercício corrente até este ano).
 */
const ANO_BASE = 2025;

/**
 * Teto de CNPJs de fornecedor por execução. A 12h, varrer todos estouraria o
 * timeout; cobrimos os de maior valor primeiro e o resto na janela seguinte (o
 * upsert por CNPJ é idempotente). Espelha `MAX_CNPJS` de `coleta-sancoes.ts`.
 */
const MAX_CNPJS = 600;

/**
 * UA de browser — o portal do TCE-SP costuma recusar clients sem UA (mesmo
 * padrão de `coleta-contas-irregulares.ts`). O `Referer` do app público evita
 * recusas do WAF na API.
 */
const HTTP_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
  Accept: "application/json",
  Referer: "https://www4.tce.sp.gov.br/apenados/publico/",
};

// ── Helpers genéricos (replicados — `functions/` não importa de `src/`) ───────

function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

/**
 * Extrai o CNPJ (14 dígitos) de um campo que pode vir "sujo" — em alguns
 * registros do TCE o campo `cnpj` traz CPF+CNPJ concatenados
 * (ex.: "35081433845 30589446000164"). Pega o ÚLTIMO bloco de 14 dígitos.
 * Retorna "" se não houver 14 dígitos contíguos.
 */
function extrairCnpj14(v: unknown): string {
  const matches = String(v ?? "").match(/\d{14}/g);
  return matches && matches.length > 0 ? matches[matches.length - 1] : "";
}

/** Tira acento e normaliza (caixa-alta, espaço único). */
function normNome(v: unknown): string {
  return (v == null ? "" : String(v))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Converte a data do TCE — array `[ano, mês(1-based), dia]` — para `yyyy-MM-dd`,
 * ou null. Tolera também string ISO/BR por robustez a mudanças de formato.
 */
function parseDataTce(v: unknown): string | null {
  if (Array.isArray(v) && v.length >= 3) {
    const [a, m, d] = v;
    const ano = Number(a);
    const mes = Number(m);
    const dia = Number(d);
    if (
      Number.isInteger(ano) &&
      Number.isInteger(mes) &&
      Number.isInteger(dia) &&
      ano >= 1900 &&
      mes >= 1 &&
      mes <= 12 &&
      dia >= 1 &&
      dia <= 31
    ) {
      const mm = String(mes).padStart(2, "0");
      const dd = String(dia).padStart(2, "0");
      return `${ano}-${mm}-${dd}`;
    }
    return null;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  }
  return null;
}

// ── Tipos ─────────────────────────────────────────────────────────────────────

/**
 * Apenação NORMALIZADA — MESMO shape de `SancaoNorm` de `coleta-sancoes.ts`
 * (cadastro/cnpjSancionado/nomeSancionado/tipoSancao/dataInicio/dataFim/
 * orgaoSancionador/fundamentacao) + `idApenacao` (id estável do TCE, p/ dedup).
 */
interface ApenacaoNorm {
  /** Marcador da fonte estadual — análogo aos cadastros CEIS/CNEP/CEPIM. */
  cadastro: "TCE-SP-APENADOS";
  cnpjSancionado: string;
  nomeSancionado: string;
  tipoSancao: string;
  dataInicio: string | null;
  dataFim: string | null;
  orgaoSancionador: string;
  fundamentacao: string;
  /** `id` da apenação no TCE-SP — chave de dedup quando duas varreduras coincidem. */
  idApenacao: number | null;
}

/** Subconjunto tipado do registro cru da API de Apenados. */
interface RegistroApenadoCru {
  apenador?: { nome?: unknown } | null;
  apenado?: { apenada?: unknown; cnpj?: unknown } | null;
  processo?: unknown;
  tipoApenacao?: { descricao?: unknown } | null;
  razao?: unknown;
  inicio?: unknown;
  termino?: unknown;
  id?: unknown;
}

// ── Validação ESTRUTURAL (WAF/erro pode devolver 200 com lixo) ────────────────

/**
 * `true` quando o JSON tem a CARA da Relação de Apenados — array cujos itens (se
 * houver) expõem `apenado` com `cnpj`/`apenada` e `tipoApenacao`. Array vazio é
 * VÁLIDO (CNPJ sem apenação). Protege contra o WAF servir HTML/erro como 200.
 */
function estruturaValida(json: unknown): json is RegistroApenadoCru[] {
  if (!Array.isArray(json)) return false;
  if (json.length === 0) return true;
  const amostra = json[0] as Record<string, unknown> | null;
  if (!amostra || typeof amostra !== "object") return false;
  const apenado = amostra.apenado as Record<string, unknown> | undefined;
  const tem =
    (apenado != null &&
      ("cnpj" in apenado || "apenada" in apenado || "cpf" in apenado)) ||
    "tipoApenacao" in amostra ||
    "apenador" in amostra;
  return tem;
}

/**
 * Normaliza um registro cru da API para `ApenacaoNorm`. `cnpjPreferido` (quando
 * informado, na varredura por fornecedor) força o CNPJ alvo, evitando que um
 * campo `cnpj` sujo do TCE desloque o doc; na varredura por apenador, deriva o
 * CNPJ do próprio registro.
 */
function normalizarApenacao(
  rec: RegistroApenadoCru,
  cnpjPreferido?: string,
): ApenacaoNorm | null {
  const apenado = rec.apenado ?? null;
  const cnpj =
    (cnpjPreferido && cnpjPreferido.length === 14 ? cnpjPreferido : "") ||
    extrairCnpj14(apenado?.cnpj);
  // Sem CNPJ de empresa, o registro é de pessoa física (CPF/RG) — fora do escopo
  // (não persistimos PII crua). Descarta.
  if (cnpj.length !== 14) return null;

  const idNum = Number(rec.id);
  return {
    cadastro: "TCE-SP-APENADOS",
    cnpjSancionado: cnpj,
    nomeSancionado:
      apenado?.apenada == null ? "" : String(apenado.apenada).trim(),
    tipoSancao:
      rec.tipoApenacao?.descricao == null
        ? "Apenação TCE-SP"
        : String(rec.tipoApenacao.descricao).trim() || "Apenação TCE-SP",
    dataInicio: parseDataTce(rec.inicio),
    dataFim: parseDataTce(rec.termino),
    orgaoSancionador:
      rec.apenador?.nome == null ? "" : String(rec.apenador.nome).trim(),
    fundamentacao: rec.razao == null ? "" : String(rec.razao).trim(),
    idApenacao: Number.isInteger(idNum) ? idNum : null,
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * Monta a URL + headers da consulta de Apenados, roteando pelo PROXY regional
 * (southamerica-east1) quando há `PROXY_URL` + segredo — caminho normal em prod,
 * pois o us-central1 leva 403 geo do TCE-SP. Sem proxy/segredo (ex.: dev em IP
 * BR), cai no fetch DIRETO como degradação. O cliente NÃO escolhe URL livre: só
 * envia `host=tce-sp-apenados` (rótulo); o proxy resolve a base FIXA + valida o
 * path (anti-SSRF). Os filtros (`apenadoCnpj`/`apenadorNome`) viram query params
 * repassados pelo proxy.
 */
function montarRequisicao(
  filtro: "apenadoCnpj" | "apenadorNome",
  valor: string,
  segredo: string,
): { url: string; headers: Record<string, string> } {
  if (PROXY_URL && segredo) {
    const url = new URL(PROXY_URL);
    url.searchParams.set("host", "tce-sp-apenados");
    url.searchParams.set("path", "/impedimento");
    url.searchParams.set(filtro, valor);
    // O proxy aplica UA/Referer próprios; o cron só precisa autenticar.
    return { url: url.toString(), headers: { "x-nexo-secret": segredo } };
  }
  // Degradação: fetch direto (só funciona de IP brasileiro).
  const url = new URL(`${TCE_APENADOS_BASE}/impedimento`);
  url.searchParams.set(filtro, valor);
  return { url: url.toString(), headers: HTTP_HEADERS };
}

/**
 * Consulta a API de Apenados do TCE-SP por UM par de filtros (chave→valor) —
 * via PROXY regional BR (default em prod) ou direto (degradação) — e devolve os
 * registros crus já validados estruturalmente. Lança em erro de rede/HTTP ou
 * estrutura inválida (o chamador decide degradar).
 */
async function consultarApenados(
  filtro: "apenadoCnpj" | "apenadorNome",
  valor: string,
  segredo: string,
): Promise<RegistroApenadoCru[]> {
  const { url, headers } = montarRequisicao(filtro, valor, segredo);
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 400 "pelo menos um campo ..." não deve acontecer (sempre mandamos filtro),
  // mas se acontecer tratamos como "sem resultado" pra não derrubar o ciclo.
  if (res.status === 400) return [];
  if (!res.ok) {
    throw new Error(`TCE-SP Apenados ${filtro} → HTTP ${res.status}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`TCE-SP Apenados ${filtro} → resposta não-JSON (WAF?)`);
  }
  if (!estruturaValida(json)) {
    throw new Error(
      `TCE-SP Apenados ${filtro} → estrutura inesperada (layout mudou ou WAF)`,
    );
  }
  return json;
}

// ── CNPJs dos fornecedores de Marília (espelha `coleta-sancoes.ts`) ───────────

/**
 * Exercícios monitorados: do corrente até o ano-base, em ordem decrescente.
 * Espelha `exerciciosMonitorados()` de `coleta-sancoes.ts` — self-contained.
 */
function exerciciosMonitorados(): number[] {
  const atual = new Date().getFullYear();
  const anos: number[] = [];
  for (let a = atual; a >= ANO_BASE; a--) anos.push(a);
  return anos;
}

/**
 * CNPJs distintos dos fornecedores de Marília (`nexo_empenhos`), ordenados por
 * valor empenhado desc, limitados a `MAX_CNPJS`. PROJEÇÃO + STREAMING (igual a
 * `coleta-sancoes.ts`): `.select()` no servidor + `.stream()` — NUNCA `.get()`
 * da coleção inteira (evita OOM). Campos `_cnpj`/`_valor`/`_exercicio` são da
 * engine de coleta SMARAPD.
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

// ── Persistência (1 doc por CNPJ — MESMO shape de `nexo_sancoes`) ─────────────

/**
 * Persiste as apenações de um CNPJ em `nexo_sancoes_estaduais`. Doc por CNPJ —
 * re-coletar SOBRESCREVE o conjunto daquele CNPJ (idempotente). CNPJ verificado
 * SEM apenação também grava (`sancionado:false`) para o painel saber que foi
 * checado e está limpo na esfera estadual.
 *
 * `apenacoes` chega já deduplicado por `idApenacao` (uma apenação que aparece nas
 * duas varreduras entra uma vez só).
 */
async function persistirApenacoes(
  cnpj: string,
  apenacoes: ApenacaoNorm[],
): Promise<void> {
  await db
    .collection(COLECAO)
    .doc(cnpj)
    .set(
      {
        _fonte: "sancoes_estaduais_tce_sp",
        esfera: "estadual",
        _cnpj: cnpj,
        cnpj,
        sancionado: apenacoes.length > 0,
        qtdSancoes: apenacoes.length,
        cadastros: [...new Set(apenacoes.map((a) => a.cadastro))],
        // MESMO shape de `nexo_sancoes.sancoes[]` (cadastro/cnpjSancionado/
        // nomeSancionado/tipoSancao/dataInicio/dataFim/orgaoSancionador) — o
        // `indice-sancao-consolidada` funde federal+estadual sem caso especial.
        sancoes: apenacoes.map((a) => ({
          cadastro: a.cadastro,
          cnpjSancionado: a.cnpjSancionado,
          nomeSancionado: a.nomeSancionado,
          tipoSancao: a.tipoSancao,
          dataInicio: a.dataInicio,
          dataFim: a.dataFim,
          orgaoSancionador: a.orgaoSancionador,
          fundamentacao: a.fundamentacao,
          esfera: "estadual",
          idApenacao: a.idApenacao,
        })),
        // Enquadramento carimbado (indício, nunca acusação): apenação no TCE-SP é
        // impedimento administrativo de licitar/contratar — não é juízo penal nem
        // de improbidade. Vigência aferida por DATA (dataInicio/dataFim) a jusante.
        _enquadramento:
          "impedimento-administrativo-tce-sp-a-verificar-nao-acusacao",
        _verificadoEm: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

/** Agrupa apenações por CNPJ e deduplica por `idApenacao` (fallback: assinatura). */
function agruparPorCnpj(
  apenacoes: ApenacaoNorm[],
  acc: Map<string, Map<string, ApenacaoNorm>>,
): void {
  for (const a of apenacoes) {
    if (!acc.has(a.cnpjSancionado)) acc.set(a.cnpjSancionado, new Map());
    const porId = acc.get(a.cnpjSancionado)!;
    const chave =
      a.idApenacao != null
        ? `id:${a.idApenacao}`
        : `sig:${a.tipoSancao}|${a.dataInicio}|${a.orgaoSancionador}`;
    if (!porId.has(chave)) porId.set(chave, a);
  }
}

// ── Cron a cada 12h ───────────────────────────────────────────────────────────

export const onNexoSyncSancoesEstaduais = onSchedule(
  {
    // CUSTO: era `every 12 hours` (2×/dia). Fonte estadual (TCE-SP/CGE-SP) muda
    // devagar; 1×/dia basta e corta metade da leitura de CNPJs. Roda 11:15.
    schedule: "15 11 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    // Pior caso real: MAX_CNPJS(600) consultas + 1 varredura por apenador, com
    // pausas de gentileza ≈ 600 × (fetch + 300ms) ≈ 6 min. Folga generosa.
    timeoutSeconds: 900,
    memory: "512MiB",
    // Hardening: no máximo UMA execução simultânea — um disparo atrasado/retry
    // não concorre com a execução em andamento (docId determinístico + merge
    // torna o retry idempotente).
    maxInstances: 1,
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
    // Segredo p/ autenticar no proxy regional BR (`x-nexo-secret`). Sem novo
    // segredo: reusa o do backfill do Diário.
    secrets: [PROXY_SECRET],
  },
  async () => {
    const inicio = Date.now();

    // Segredo do proxy. Em prod (us-central1) o TCE-SP devolve 403 geo no fetch
    // direto, então o proxy é o caminho real; sem segredo, o ciclo só teria
    // chance de sucesso de um IP BR (dev), e degradamos honesto.
    const segredo = (PROXY_SECRET.value() ?? "").trim();
    if (!segredo && !PROXY_URL) {
      logger.warn(
        "NEXO Sanções estaduais — sem PROXY_URL nem segredo; do us-central1 o " +
          "TCE-SP responde 403 (geo/IP-block). Tentando fetch direto mesmo " +
          "assim (só funciona de IP BR).",
      );
    }

    // Acumulador CNPJ → (chaveDedup → apenação). Une as duas varreduras.
    const porCnpj = new Map<string, Map<string, ApenacaoNorm>>();
    let falhas = 0;
    let ultimoErro: string | null = null;

    // ── Varredura 2 (primeiro, é barata: 1 chamada) — apenador de Marília ─────
    // Pega quem foi apenado por um ÓRGÃO de Marília, mesmo que ainda não conste
    // em nexo_empenhos. Filtra por "MARILIA" delimitado no nome do apenador para
    // descartar eventual ruído do filtro textual do TCE.
    try {
      const crus = await consultarApenados("apenadorNome", "MARILIA", segredo);
      const norm: ApenacaoNorm[] = [];
      for (const rec of crus) {
        const a = normalizarApenacao(rec);
        if (a && /\bMARILIA\b/.test(normNome(a.orgaoSancionador))) norm.push(a);
      }
      agruparPorCnpj(norm, porCnpj);
      logger.info(
        `NEXO Sanções estaduais — varredura por apenador MARILIA: ` +
          `${crus.length} registros, ${norm.length} com CNPJ de Marília`,
      );
    } catch (err) {
      falhas++;
      ultimoErro = err instanceof Error ? err.message : String(err);
      logger.warn(
        `NEXO Sanções estaduais — varredura por apenador falhou: ${ultimoErro}`,
      );
    }

    // ── Varredura 1 — por CNPJ de fornecedor de Marília ───────────────────────
    let cnpjsFornecedores: string[] = [];
    try {
      cnpjsFornecedores = await coletarCnpjsFornecedores();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        "NEXO Sanções estaduais — falha ao ler CNPJs de nexo_empenhos",
        err,
      );
      // Se nem a varredura por apenador rendeu nada, o ciclo é uma falha dura.
      if (porCnpj.size === 0) {
        await gravarSyncState({
          syncId: "sancoes_estaduais",
          fonte: "sancoes_estaduais_tce_sp",
          colecao: COLECAO,
          cadencia: "diario",
          sucesso: false,
          erro: msg,
          duracaoMs: Date.now() - inicio,
          extra: { cnpjsConsultados: 0 },
        });
        return;
      }
      // Senão, segue só com o que a varredura por apenador trouxe (degradado).
      falhas++;
      ultimoErro = msg;
    }

    let consultadosFornecedor = 0;
    for (const cnpj of cnpjsFornecedores) {
      try {
        const crus = await consultarApenados("apenadoCnpj", cnpj, segredo);
        const norm: ApenacaoNorm[] = [];
        for (const rec of crus) {
          const a = normalizarApenacao(rec, cnpj);
          if (a) norm.push(a);
        }
        agruparPorCnpj(norm, porCnpj);
        // Garante doc (mesmo SEM apenação) p/ marcar o CNPJ como verificado/limpo.
        if (!porCnpj.has(cnpj)) porCnpj.set(cnpj, new Map());
        consultadosFornecedor++;
      } catch (err) {
        falhas++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.warn(
          `NEXO Sanções estaduais — falha ao consultar CNPJ ${cnpj}: ${ultimoErro}`,
        );
        // Erro pontual de um CNPJ não derruba o ciclo; segue para o próximo.
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    // ── Persistência (1 doc por CNPJ, merge) ──────────────────────────────────
    let gravados = 0;
    let sancionados = 0;
    let totalApenacoes = 0;
    for (const [cnpj, porId] of porCnpj.entries()) {
      const apenacoes = [...porId.values()];
      try {
        await persistirApenacoes(cnpj, apenacoes);
        gravados++;
        if (apenacoes.length > 0) sancionados++;
        totalApenacoes += apenacoes.length;
      } catch (err) {
        falhas++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.error(
          `NEXO Sanções estaduais — falha ao persistir CNPJ ${cnpj}`,
          err,
        );
      }
    }

    await gravarSyncState({
      syncId: "sancoes_estaduais",
      fonte: "sancoes_estaduais_tce_sp",
      colecao: COLECAO,
      cadencia: "diario",
      // Sucesso se gravou ao menos um doc; degradado se houve qualquer falha
      // pontual (CNPJ/varredura) ou se a CGE-SP segue indisponível.
      sucesso: gravados > 0,
      degradado: falhas > 0,
      erro: falhas > 0 ? ultimoErro : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        cnpjsConsultados: consultadosFornecedor,
        cnpjsGravados: gravados,
        cnpjsSancionados: sancionados,
        apenacoes: totalApenacoes,
        falhas,
        // Caminho usado: proxy regional BR (default em prod) ou fetch direto.
        viaProxy: Boolean(PROXY_URL && segredo),
        // CGE-SP e-Sanções permanece sem fonte pública estável acessível: a
        // esfera estadual aqui cobre o TCE-SP (apenados). Ver acaoDoDono.
        cgeEsancoesDisponivel: false,
      },
    });

    // Estado PRÓPRIO e honesto da sub-fonte CGE-SP (não inventamos endpoint):
    // fica visível no painel como "pendente de fonte", sem mascarar como vazio.
    await gravarSyncState({
      syncId: "sancoes_estaduais_cge",
      fonte: "sancoes_estaduais_cge_sp",
      colecao: COLECAO,
      cadencia: "diario",
      sucesso: true, // não ter fonte pública não é uma "falha" do nosso ciclo
      degradado: true,
      erro:
        "CGE-SP e-Sanções sem endpoint público estável acessível (jun/2026); " +
        "esfera estadual coberta pelo TCE-SP. Ver acaoDoDono.",
      duracaoMs: 0,
      extra: { fonteDisponivel: false },
    });

    logger.info(
      `NEXO Sanções estaduais — concluído: ${gravados} CNPJs gravados, ` +
        `${sancionados} sancionados, ${totalApenacoes} apenações, ${falhas} falhas`,
    );
  },
);
