/**
 * GRAFO SOCIETÁRIO do NEXO — `onNexoColetaSocios` (Fase 4/5 do plano-mestre).
 *
 * Para cada CNPJ de FORNECEDOR da Prefeitura de Marília, busca o QSA (Quadro de
 * Sócios e Administradores) e os dados cadastrais na Receita Federal via
 * `minhareceita.org/{cnpj}` (espelho público da base aberta da Receita, SEM
 * auth) e persiste em `nexo_socios` — 1 doc por CNPJ. Isso é a matéria-prima do
 * grafo societário: depois um cron de grafo cruza `cpfHash` entre CNPJs para
 * achar sócios em comum (o clássico "as três empresas que disputaram o pregão
 * têm o mesmo dono" — conluio em licitação).
 *
 * ── DE ONDE VÊM OS CNPJs (COBERTURA 100%) ─────────────────────────────────────
 * Dos fornecedores já conhecidos da base: `nexo_entidades` (o RAIO-X construído
 * por `perfil-entidades.ts`, que já EXCLUI entes públicos do tipo 'empresa') é a
 * fonte primária — pega TODOS os de tipo 'empresa' com CNPJ válido, sem teto de
 * candidatos. (Antes limitávamos aos top-N por `totalEmpenhado`, o que congelava
 * a cobertura em ~centenas de CNPJs: fornecedor pequeno NUNCA entrava no lote.
 * Item 4 do plano de perfilamento: a cobertura tem que chegar a 100%, porque
 * sócio em comum / mesmo endereço vale para QUALQUER fornecedor, não só os
 * grandes.) Se `nexo_entidades` ainda não foi populado, cai no fallback de
 * varrer `nexo_empenhos` agrupando por `_cnpj` (mesmo método de
 * `coleta-sancoes.ts`).
 *
 * ── ORÇAMENTO POR EXECUÇÃO (o cron varre até cobrir tudo) ─────────────────────
 * 100% de cobertura NÃO significa 100% num único run: cada execução gasta no
 * máximo `MAX_CNPJS` chamadas (orçamento educado pra fonte comunitária). A
 * seleção é um "cursor" estável derivado do próprio estado em `nexo_socios`:
 *   1º) CNPJs NUNCA coletados (sem doc), do maior `totalEmpenhado` pro menor —
 *       prioriza o que mais importa enquanto o backlog existe;
 *   2º) CNPJs com coleta FALHA anterior ou VENCIDOS pelo TTL, do mais antigo
 *       `_coletadoEm` pro mais novo — refresh justo, ninguém "fura fila".
 * Como cada run persiste `_coletadoEm` no que consultou, o run seguinte
 * naturalmente continua de onde parou (sem cursor externo pra manter): em
 * ~ceil(backlog / MAX_CNPJS) dias a base inteira está coberta, e daí em diante
 * o cron só renova ~1/TTL_DIAS da base por dia.
 *
 * ── TTL (não re-buscar diário) ────────────────────────────────────────────────
 * O QSA muda raramente; bater na Receita todo dia pra cada CNPJ é desperdício e
 * desrespeita a fonte. Cada doc carrega `_coletadoEm`; um CNPJ só é re-buscado se
 * faltam ≥ `TTL_DIAS` (~30d) desde a última coleta BEM-SUCEDIDA. CNPJs já frescos
 * são pulados — então o lote diário cobre, na prática, só os CNPJs novos ou
 * vencidos, e a base inteira fica coberta em poucos ciclos sem nunca re-bater no
 * que já está fresco.
 *
 * ── ENDEREÇO / E-MAIL / TELEFONE + `endNorm` (grupo econômico) ────────────────
 * A resposta da minhareceita traz o CADASTRO da empresa na RFB — endereço da
 * sede, e-mail e telefones. São dados cadastrais PÚBLICOS de pessoa jurídica
 * (base aberta do CNPJ), não PII de pessoa física — persistimos como vieram
 * (limpos). O pulo do gato é o `endNorm`: chave DETERMINÍSTICA de junção por
 * endereço (logradouro+número+CEP normalizados a [A-Z0-9]) — duas "empresas
 * concorrentes" registradas na MESMA sala comercial colidem no `endNorm`, e é
 * assim que o detector de grupo econômico/cartel as encontra sem fuzzy match.
 *
 * ── FILA / RATE-LIMIT (backoff + jitter) ──────────────────────────────────────
 * `minhareceita.org` é um serviço comunitário gratuito; varrer centenas de CNPJs
 * de rajada o derrubaria (e nos bloquearia). Então: lote PEQUENO por ciclo
 * (`MAX_CNPJS`), pausa base entre chamadas com JITTER aleatório (dessincroniza,
 * não bate em intervalo fixo) e BACKOFF exponencial com teto em 429/5xx
 * (recua e tenta de novo algumas vezes antes de desistir do CNPJ). 404 = CNPJ
 * inexistente na base aberta (não é erro — grava ausência de cobertura).
 *
 * ── LGPD: NUNCA grava CPF cru ─────────────────────────────────────────────────
 * O sócio tem CPF (dado pessoal). Mesmo que a Receita já devolva o CPF
 * PARCIALMENTE mascarado (`***112108**`), NÃO persistimos o número como veio:
 * passamos por `hashDoc` (chave de junção determinística e irreversível, pra
 * cruzar sócios entre CNPJs) e `mascararDoc` (exibição). O valor cru recebido é
 * DESCARTADO. Mesma regra-mãe de `pii.ts`. (Na prática a base aberta já entrega
 * o CPF mascarado por padrão; ainda assim tratamos como se fosse cru por
 * princípio — defense in depth.)
 *
 * ── ME / MEI podem não ter QSA ────────────────────────────────────────────────
 * Microempresa / MEI normalmente não declaram quadro societário formal — o `qsa`
 * vem vazio. Isso NÃO é falha: gravamos o doc com `socios: []`, `temQsa: false` e
 * a `cobertura` (com/sem QSA) vira MÉTRICA no `nexo_sync_state`, não um erro.
 *
 * ── IDEMPOTÊNCIA ──────────────────────────────────────────────────────────────
 * docId = o próprio CNPJ (14 díg). `set(..., { merge: true })` é UPSERT;
 * reexecutar o cron após falha SOBRESCREVE o doc daquele CNPJ, nunca duplica.
 *
 * Cron DIÁRIO em lote pequeno, `maxInstances: 1`.
 *
 * Self-contained: o projeto `functions/` não importa de `src/`. Reusa só
 * `db`/`admin` de `../shared/admin`, `gravarSyncState` e `hashDoc`/`mascararDoc`
 * de `./pii`. A validação Módulo 11 é re-implementada local (sem dependência).
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";
import { hashDoc, mascararDoc } from "./pii";
import { chaveFraca, cpf6De } from "./chaves";

/** Coleção de destino — 1 doc por CNPJ. */
const COLECAO = "nexo_socios";
/** Base da API pública da Receita (espelho aberto, sem auth). */
const API_BASE = "https://minhareceita.org";
/** Timeout de cada requisição HTTP. */
const TIMEOUT_MS = 20_000;
/**
 * TTL da coleta: um CNPJ só é re-buscado se a última coleta bem-sucedida tem ≥
 * este nº de dias. QSA muda raramente; ~30d evita re-bater diário na fonte.
 */
const TTL_DIAS = 30;
/**
 * ORÇAMENTO de CNPJs por execução (não é mais "teto do ranking": os candidatos
 * agora são TODOS os fornecedores, e este número só dita quantos cada run
 * consome do backlog). 200/dia a `minhareceita.org` (fonte comunitária gratuita)
 * é educado — a `pausaEntreCnpjs` (0,8s base + jitter ≈ 1,1s média) dilui o lote
 * em ~3,5 min de chamadas, bem dentro do `timeoutSeconds:540` do cron, e o
 * BACKOFF + abort-on-429 protegem a fonte se ela começar a barrar. Se a Receita
 * reclamar, baixar este número é o ajuste seguro (a cobertura só demora mais);
 * o rate-limit/backoff abaixo NÃO foram afrouxados.
 */
const MAX_CNPJS = 200;
/** Pausa base entre CNPJs (ms) — somada a um JITTER aleatório por chamada. */
const DELAY_BASE_MS = 800;
/** Jitter máximo (ms) somado à pausa base — dessincroniza as chamadas. */
const JITTER_MS = 600;
/** Tentativas por CNPJ em erro transitório (429/5xx/rede) antes de desistir. */
const MAX_TENTATIVAS = 4;
/** Backoff inicial (ms) — dobra a cada retry, com jitter, até MAX_BACKOFF_MS. */
const BACKOFF_BASE_MS = 1_500;
/** Teto do backoff exponencial (ms). */
const MAX_BACKOFF_MS = 20_000;
/** Teto de sócios por doc — proteção contra QSA anômalo (doc gigante). */
const MAX_SOCIOS = 200;

// ── Normalizadores ───────────────────────────────────────────────────────────

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const s = v.includes(",") ? v.replace(/\./g, "").replace(",", ".") : v;
    const n = Number(s.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Primeiro valor não-vazio entre as chaves dadas (string trimada). */
function primeiro(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && v !== "") return String(v).trim();
  }
  return "";
}

/** Normaliza uma data (`YYYY-MM-DD...`, `DD/MM/YYYY`) para `YYYY-MM-DD`, ou "". */
function toIsoDate(v: unknown): string {
  const s = str(v);
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return "";
}

/** Raiz do CNPJ (8 primeiros dígitos). */
function cnpjRaiz(doc: unknown): string {
  return soDigitos(doc).slice(0, 8);
}

/** String limpa (trim) ou `null` — campos cadastrais vazios viram null, não "". */
function strOuNull(v: unknown): string | null {
  const s = str(v);
  return s || null;
}

/** Remove acentos (NFD + strip de combining marks) — "AVENIDA SÃO" → "AVENIDA SAO". */
function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * `endNorm` — chave de junção de GRUPO ECONÔMICO por endereço. Normalização
 * AGRESSIVA e determinística de logradouro+número+CEP: uppercase, sem acento,
 * só [A-Z0-9] (some espaço, vírgula, "Nº", pontuação — as variações de grafia
 * que quebrariam um join exato), CEP só dígitos. O resultado é UMA string:
 * mesmo endereço cadastral ⇒ mesma chave ⇒ `where("endNorm","==",...)` acha as
 * "concorrentes" registradas na mesma sala sem fuzzy match.
 *
 * Exige logradouro E CEP: sem o CEP a rua colide entre cidades ("RUA A" existe
 * em todo lugar) e sem a rua o CEP de logradouro único agruparia vizinhos —
 * chave fraca demais gera falso grupo econômico, então nesses casos devolve
 * `null` (sem chave é melhor que chave errada).
 */
function endNormDe(logradouro: string, numero: string, cep: string): string | null {
  const norm = (s: string): string =>
    semAcento(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const log = norm(logradouro);
  const num = norm(numero);
  const cepDig = soDigitos(cep);
  if (!log || !cepDig) return null;
  return `${log}${num}${cepDig}`;
}

// ── Validação Módulo 11 (CNPJ) — re-implementada local, sem dependência ──────

function digitosTodosIguais(d: string): boolean {
  return /^(\d)\1+$/.test(d);
}

/** CNPJ (14 díg) válido por dígito verificador (Módulo 11). */
function cnpjValido(d: string): boolean {
  if (d.length !== 14 || digitosTodosIguais(d)) return false;
  const calc = (ate: number): number => {
    const pesos =
      ate === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * pesos[i];
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

// ── Sócio normalizado (SEM CPF cru — só hash + máscara) ──────────────────────

interface SocioNorm {
  /** Hash determinístico e irreversível do CPF/CNPJ do sócio — chave de junção. */
  cpfHash: string;
  /** Máscara visual do doc do sócio — pra exibir, nunca o número cru. */
  cpfMasc: string;
  nome: string;
  qualificacao: string;
  /**
   * 6 dígitos do MIOLO do CPF (a fonte só expõe isso — `***112108**`). NÃO é PII
   * que identifica sozinho; é o componente do `chaveFraca`. "" para sócio PJ.
   */
  cpf6: string;
  /**
   * Chave fraca sócio↔doador = `hashDoc(normNome(nome)+"|"+cpf6)`. ÚNICA forma de
   * casar com o doador do TSE (CPF cheio é data-blocked dos dois lados). Indício
   * a apurar, nunca identificação forte. "" quando falta nome ou cpf6.
   */
  chaveFraca: string;
}

interface QsaNorm {
  cnpj: string;
  cnpjRaiz: string;
  razaoSocial: string;
  naturezaJuridica: string;
  dataAbertura: string;
  capital: number;
  porte: string;
  /** MEI? (informa cobertura: MEI/ME raramente têm QSA). */
  mei: boolean;
  /**
   * Endereço cadastral da SEDE na RFB (dado público de PJ). Campos limpos ou
   * `null` (nunca "") — o consumidor distingue "não informado" de vazio.
   */
  endereco: {
    logradouro: string | null;
    numero: string | null;
    complemento: string | null;
    bairro: string | null;
    municipio: string | null;
    uf: string | null;
    cep: string | null;
  };
  /** Chave de junção de grupo econômico por endereço — ver `endNormDe`. */
  endNorm: string | null;
  /** E-mail cadastral na RFB (dado público de PJ) — minúsculo, ou null. */
  email: string | null;
  /** Telefones cadastrais (DDD+número, só dígitos), ou null. */
  telefone1: string | null;
  telefone2: string | null;
  socios: SocioNorm[];
}

/**
 * Normaliza um sócio do QSA pra forma SEM PII crua. A Receita devolve o CPF do
 * sócio JÁ parcialmente mascarado (`***112108**`); ainda assim tratamos o valor
 * como se fosse cru e SEMPRE passamos por `hashDoc`/`mascararDoc` — o valor
 * recebido é descartado, nunca persistido. (Defense in depth: se a fonte um dia
 * passar a entregar o CPF inteiro, este código continua não vazando.)
 */
function normalizarSocio(rec: Record<string, unknown>): SocioNorm {
  // `cnpj_cpf_do_socio` pode ser CPF (sócio PF) ou CNPJ (sócio PJ); ambos vão
  // pelo mesmo pipeline de hash/máscara. `cpf_representante_legal` é fallback.
  const docCru = primeiro(rec, "cnpj_cpf_do_socio", "cpf_representante_legal");
  const nome = primeiro(rec, "nome_socio", "nome_representante_legal");
  // A base aberta já entrega o CPF do sócio mascarado (`***112108**`) → só os 6
  // dígitos do miolo sobrevivem. `cpf6De` os extrai; o valor cru é DESCARTADO.
  const cpf6 = cpf6De(docCru);
  return {
    cpfHash: hashDoc(docCru),
    cpfMasc: mascararDoc(docCru),
    nome,
    qualificacao: primeiro(
      rec,
      "qualificacao_socio",
      "qualificacao_representante_legal",
    ),
    cpf6,
    chaveFraca: chaveFraca(nome, cpf6),
  };
}

/**
 * Normaliza a resposta da Receita pra forma persistível. Tolerante a variações
 * de chave (a base aberta usa snake_case; toleramos camelCase por garantia).
 */
function normalizarQsa(cnpj: string, json: Record<string, unknown>): QsaNorm {
  const qsaBruto = Array.isArray(json.qsa)
    ? (json.qsa as Record<string, unknown>[])
    : [];
  const socios = qsaBruto
    .slice(0, MAX_SOCIOS)
    .map(normalizarSocio)
    // Sócio sem nome nem doc não agrega nada ao grafo — descarta.
    .filter((s) => s.nome || s.cpfHash);

  const meiFlag = primeiro(json, "opcao_pelo_mei", "opcaoPeloMei").toUpperCase();

  // Endereço cadastral: a minhareceita separa o TIPO do logradouro
  // ("descricao_tipo_de_logradouro": "AVENIDA") do nome ("PAULISTA") —
  // recompomos ("AVENIDA PAULISTA") pra exibição E pro `endNorm`, senão a
  // chave dependeria de qual metade a fonte preencheu.
  const tipoLog = primeiro(json, "descricao_tipo_de_logradouro");
  const nomeLog = primeiro(json, "logradouro");
  const logradouro = [tipoLog, nomeLog].filter(Boolean).join(" ");
  const numero = primeiro(json, "numero");
  const cep = soDigitos(primeiro(json, "cep"));
  // Telefones: `ddd_telefone_1/2` já vêm concatenados (DDD+número); guardamos
  // só os dígitos. E-mail em minúsculo — join case-insensitive de graça.
  const email = primeiro(json, "email").toLowerCase();

  return {
    cnpj,
    cnpjRaiz: cnpjRaiz(cnpj),
    razaoSocial: primeiro(json, "razao_social", "razaoSocial", "nome_fantasia"),
    naturezaJuridica: primeiro(
      json,
      "natureza_juridica",
      "naturezaJuridica",
    ),
    dataAbertura: toIsoDate(
      primeiro(json, "data_inicio_atividade", "dataInicioAtividade"),
    ),
    capital: toNum(primeiro(json, "capital_social", "capitalSocial")),
    porte: primeiro(json, "porte"),
    mei: meiFlag === "SIM" || meiFlag === "S" || meiFlag === "TRUE",
    endereco: {
      logradouro: strOuNull(logradouro),
      numero: strOuNull(numero),
      complemento: strOuNull(primeiro(json, "complemento")),
      bairro: strOuNull(primeiro(json, "bairro")),
      municipio: strOuNull(primeiro(json, "municipio")),
      uf: strOuNull(primeiro(json, "uf")),
      cep: strOuNull(cep),
    },
    endNorm: endNormDe(logradouro, numero, cep),
    email: strOuNull(email),
    telefone1: strOuNull(soDigitos(primeiro(json, "ddd_telefone_1", "telefone1"))),
    telefone2: strOuNull(soDigitos(primeiro(json, "ddd_telefone_2", "telefone2"))),
    socios,
  };
}

// ── Cliente HTTP com backoff + jitter ────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pausa entre CNPJs: base + jitter aleatório (dessincroniza as chamadas). */
function pausaEntreCnpjs(): Promise<void> {
  return sleep(DELAY_BASE_MS + Math.floor(Math.random() * JITTER_MS));
}

/** Resultado de uma consulta: o QSA, ou "não encontrado" (404 = sem cobertura). */
type ResultadoConsulta =
  | { tipo: "ok"; qsa: QsaNorm }
  | { tipo: "naoEncontrado" };

/**
 * Consulta `minhareceita.org/{cnpj}` com retry/backoff exponencial + jitter em
 * erro transitório (429 / 5xx / rede / timeout). 404 → `naoEncontrado` (CNPJ
 * fora da base aberta; não é erro). 4xx não-404 (ex.: 400 CNPJ malformado) e o
 * esgotamento das tentativas LANÇAM — o chamador conta como falha do CNPJ e
 * segue para o próximo.
 */
async function consultarReceita(cnpj: string): Promise<ResultadoConsulta> {
  const url = `${API_BASE}/${cnpj}`;
  let ultimoErro: unknown = null;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.status === 404) return { tipo: "naoEncontrado" };

      // Transitórios: 429 (rate-limit) e 5xx → backoff e tenta de novo.
      if (res.status === 429 || res.status >= 500) {
        ultimoErro = new Error(`Receita HTTP ${res.status} (transitório)`);
      } else if (!res.ok) {
        // 4xx não-404: erro permanente do CNPJ — não adianta repetir.
        throw new Error(`Receita HTTP ${res.status} para CNPJ ${cnpj}`);
      } else {
        const json = (await res.json()) as Record<string, unknown>;
        return { tipo: "ok", qsa: normalizarQsa(cnpj, json) };
      }
    } catch (err) {
      // Erro de rede / timeout / 5xx marcado acima → transitório, faz backoff.
      ultimoErro = err;
      // Erro permanente (4xx não-404) já foi lançado acima e não cai aqui via
      // `throw`; o `catch` o re-propaga somente após sair do loop. Para não
      // engolir o permanente, re-lança imediatamente se for ele.
      if (err instanceof Error && /HTTP 4\d\d/.test(err.message)) throw err;
    }

    // Backoff exponencial com jitter, exceto após a última tentativa.
    if (tentativa < MAX_TENTATIVAS) {
      const espera = Math.min(
        BACKOFF_BASE_MS * 2 ** (tentativa - 1),
        MAX_BACKOFF_MS,
      );
      await sleep(espera + Math.floor(Math.random() * JITTER_MS));
    }
  }

  throw ultimoErro instanceof Error
    ? ultimoErro
    : new Error(`Receita: falha após ${MAX_TENTATIVAS} tentativas (${cnpj})`);
}

// ── Seleção dos CNPJs-alvo (cobertura 100% + orçamento por run) ──────────────

/** Candidato = CNPJ de fornecedor + peso pra priorizar o backlog inicial. */
interface Candidato {
  cnpj: string;
  totalEmpenhado: number;
}

/**
 * TODOS os CNPJs de fornecedor candidatos (sem teto — a cobertura-alvo é 100%;
 * quem limita o run é o orçamento `MAX_CNPJS`, na seleção). Fonte primária:
 * `nexo_entidades` (RAIO-X já sem entes públicos) filtrando tipo 'empresa' com
 * CNPJ válido; `select()` traz só os campos usados (a coleção tem docs gordos —
 * não pagamos o perfil inteiro pra ler um CNPJ e um número). Se vier vazio
 * (perfil ainda não rodou), cai no fallback de agrupar `nexo_empenhos` por
 * `_cnpj` (mesmo método de `coleta-sancoes.ts`).
 */
async function coletarCandidatos(): Promise<Candidato[]> {
  // Primário: nexo_entidades, empresas — a base toda, só os campos necessários.
  try {
    const snap = await db
      .collection("nexo_entidades")
      .where("tipo", "==", "empresa")
      .select("cnpj", "doc", "_cnpj", "totalEmpenhado")
      .get();
    const candidatos: Candidato[] = [];
    const vistos = new Set<string>();
    for (const doc of snap.docs) {
      const d = doc.data();
      const cnpj = soDigitos(primeiro(d, "cnpj", "doc", "_cnpj"));
      if (cnpj.length === 14 && cnpjValido(cnpj) && !vistos.has(cnpj)) {
        vistos.add(cnpj);
        candidatos.push({ cnpj, totalEmpenhado: toNum(d.totalEmpenhado) });
      }
    }
    if (candidatos.length > 0) return candidatos;
  } catch (err) {
    // Índice ausente ou coleção vazia → tenta o fallback. Loga e segue.
    logger.warn(
      "NEXO Sócios — nexo_entidades indisponível; usando fallback nexo_empenhos",
      err,
    );
  }

  // Fallback: agrupa nexo_empenhos por _cnpj somando valor (= coleta-sancoes).
  const snap = await db.collection("nexo_empenhos").get();
  const acc = new Map<string, number>();
  for (const doc of snap.docs) {
    const d = doc.data();
    const cnpj = soDigitos(d._cnpj);
    if (cnpj.length !== 14 || !cnpjValido(cnpj)) continue;
    const valor = typeof d._valor === "number" ? d._valor : 0;
    acc.set(cnpj, (acc.get(cnpj) ?? 0) + valor);
  }
  return [...acc.entries()].map(([cnpj, totalEmpenhado]) => ({
    cnpj,
    totalEmpenhado,
  }));
}

/** Estado da última coleta de um CNPJ em `nexo_socios` (pro cursor de seleção). */
interface EstadoColeta {
  coletadoEmMs: number;
  ok: boolean;
}

/**
 * Lê o estado de coleta de TODA a `nexo_socios` numa query só, com `select()`
 * de apenas 2 campos — mais barato e simples que N/30 queries `in` agora que os
 * candidatos são a base inteira (o `in` chunked fazia sentido com top-400; com
 * milhares de CNPJs seriam centenas de round-trips pra ler menos que isso).
 */
async function lerEstadoColeta(): Promise<Map<string, EstadoColeta>> {
  const snap = await db.collection(COLECAO).select("_coletadoEm", "_ok").get();
  const estado = new Map<string, EstadoColeta>();
  for (const doc of snap.docs) {
    const ts = doc.get("_coletadoEm");
    const ms =
      ts && typeof (ts as admin.firestore.Timestamp).toMillis === "function"
        ? (ts as admin.firestore.Timestamp).toMillis()
        : 0;
    // `_ok !== false` = última coleta bem-sucedida (docs antigos sem o campo
    // contam como ok — mesmo critério do filtro por TTL anterior).
    estado.set(doc.id, { coletadoEmMs: ms, ok: doc.get("_ok") !== false });
  }
  return estado;
}

/**
 * Seleciona os alvos do run dentro do orçamento `MAX_CNPJS`. A fila é um cursor
 * IMPLÍCITO e estável derivado do estado persistido (nenhum cursor externo a
 * manter — o próprio `_coletadoEm` gravado hoje empurra o CNPJ pro fim da fila
 * de amanhã):
 *   1º) NUNCA coletados (sem doc em `nexo_socios`), por `totalEmpenhado` desc —
 *       enquanto há backlog, o fornecedor grande entra primeiro;
 *   2º) FALHA anterior (`_ok: false`) ou TTL vencido, por `_coletadoEm` asc —
 *       o mais antigo renova primeiro (round-robin justo, ninguém apodrece).
 * Desempate final por CNPJ (ordem total determinística: dois runs no mesmo
 * estado escolhem o mesmo lote — reexecução após falha é idempotente).
 * Retorna também o tamanho do backlog (pra métrica de cobertura no sync_state).
 */
function selecionarAlvos(
  candidatos: Candidato[],
  estado: Map<string, EstadoColeta>,
): { alvos: string[]; pendentes: number } {
  const limiteMs = Date.now() - TTL_DIAS * 24 * 60 * 60 * 1000;
  const nuncaColetados: Candidato[] = [];
  const vencidos: { cnpj: string; coletadoEmMs: number }[] = [];

  for (const c of candidatos) {
    const e = estado.get(c.cnpj);
    if (!e) {
      nuncaColetados.push(c);
    } else if (!e.ok || e.coletadoEmMs < limiteMs) {
      vencidos.push({ cnpj: c.cnpj, coletadoEmMs: e.coletadoEmMs });
    }
    // fresco (ok e dentro do TTL) → pula; não re-bate na fonte.
  }

  nuncaColetados.sort(
    (a, b) => b.totalEmpenhado - a.totalEmpenhado || (a.cnpj < b.cnpj ? -1 : 1),
  );
  vencidos.sort(
    (a, b) => a.coletadoEmMs - b.coletadoEmMs || (a.cnpj < b.cnpj ? -1 : 1),
  );

  const fila = [
    ...nuncaColetados.map((c) => c.cnpj),
    ...vencidos.map((v) => v.cnpj),
  ];
  return { alvos: fila.slice(0, MAX_CNPJS), pendentes: fila.length };
}

// ── Persistência (upsert idempotente por CNPJ) ───────────────────────────────

/**
 * Grava o QSA de um CNPJ em `nexo_socios` (doc id = CNPJ). `temQsa: false` para
 * ME/MEI sem quadro societário — é cobertura, não erro. `_ok: true` marca coleta
 * bem-sucedida (entra no cálculo do TTL).
 */
async function persistirQsa(qsa: QsaNorm): Promise<void> {
  await db
    .collection(COLECAO)
    .doc(qsa.cnpj)
    .set(
      {
        _cnpj: qsa.cnpj,
        cnpjRaiz: qsa.cnpjRaiz,
        // Campos de sistema canônicos (convenção `_` da seção 2.1): chave de
        // entity-resolution por raiz de CNPJ (filial→grupo). Para empresa, o id
        // canônico É a raiz do CNPJ.
        _cnpjRaiz: qsa.cnpjRaiz,
        _entidadeId: qsa.cnpjRaiz,
        // Índice de juncão a nível de doc: as chaves fracas dos sócios PF deste
        // CNPJ (array-contains casa CNPJ↔doador sem varrer o array de sócios).
        chavesFracas: qsa.socios.map((s) => s.chaveFraca).filter(Boolean),
        razaoSocial: qsa.razaoSocial,
        naturezaJuridica: qsa.naturezaJuridica,
        dataAbertura: qsa.dataAbertura || null,
        capital: qsa.capital,
        porte: qsa.porte || null,
        mei: qsa.mei,
        // Cadastro público de PJ na RFB (item 4 do plano de perfilamento):
        // endereço completo + e-mail + telefones. Não é PII de PF — as
        // invariantes LGPD (hash/máscara) continuam valendo só pros sócios.
        endereco: qsa.endereco,
        // Chave de grupo econômico por endereço (logradouro+número+CEP
        // normalizados) — `where("endNorm","==",...)` acha empresas na mesma
        // sala. null quando o cadastro não tem logradouro+CEP.
        endNorm: qsa.endNorm,
        email: qsa.email,
        telefone1: qsa.telefone1,
        telefone2: qsa.telefone2,
        socios: qsa.socios,
        temQsa: qsa.socios.length > 0,
        nSocios: qsa.socios.length,
        _fonte: "qsa",
        _ok: true,
        _coletadoEm: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

/**
 * Grava marcador de CNPJ NÃO ENCONTRADO na base aberta (404). Não é erro de
 * coleta — é cobertura. Carrega `_coletadoEm` pra respeitar o TTL e `_ok: true`
 * (a consulta concluiu): re-tentar todo dia um CNPJ ausente seria desperdício.
 */
async function persistirAusencia(cnpj: string): Promise<void> {
  await db
    .collection(COLECAO)
    .doc(cnpj)
    .set(
      {
        _cnpj: cnpj,
        cnpjRaiz: cnpjRaiz(cnpj),
        _cnpjRaiz: cnpjRaiz(cnpj),
        _entidadeId: cnpjRaiz(cnpj),
        chavesFracas: [],
        socios: [],
        temQsa: false,
        nSocios: 0,
        semCobertura: true,
        _fonte: "qsa",
        _ok: true,
        _coletadoEm: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

// ── Cron diário ──────────────────────────────────────────────────────────────

export const onNexoColetaSocios = onSchedule(
  {
    // 08h15 BRT — DEPOIS do perfil de entidades (07h45), pra que nexo_entidades
    // esteja fresco quando escolhermos os CNPJs-alvo por totalEmpenhado.
    schedule: "15 8 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    // Hardening (#13): no máximo UMA execução simultânea — um disparo
    // atrasado/retry NÃO pode concorrer e duplicar as chamadas à Receita
    // (rate-limit) nem reescrever os docs em paralelo.
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: docId = CNPJ, gravado com `merge`;
    // reexecutar após falha SOBRESCREVE o doc daquele CNPJ, nunca duplica.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();

    // 1) Candidatos = TODOS os fornecedores com CNPJ válido → seleção com
    // cursor implícito (nunca-coletados primeiro, depois vencidos) dentro do
    // orçamento MAX_CNPJS. `pendentes` = backlog total (métrica de cobertura).
    let alvos: string[] = [];
    let pendentes = 0;
    let totalCandidatos = 0;
    try {
      const candidatos = await coletarCandidatos();
      totalCandidatos = candidatos.length;
      const estado = await lerEstadoColeta();
      ({ alvos, pendentes } = selecionarAlvos(candidatos, estado));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO Sócios — falha ao selecionar CNPJs-alvo", err);
      await gravarSyncState({
        syncId: "socios",
        fonte: "qsa",
        colecao: COLECAO,
        cadencia: "diario",
        sucesso: false,
        erro: msg,
        duracaoMs: Date.now() - inicio,
        extra: { cnpjsConsultados: 0 },
      });
      return;
    }

    if (alvos.length === 0) {
      // Tudo dentro do TTL — nada a coletar hoje. Ciclo OK (não é falha).
      logger.info("NEXO Sócios — nenhum CNPJ vencido pelo TTL; nada a coletar.");
      await gravarSyncState({
        syncId: "socios",
        fonte: "qsa",
        colecao: COLECAO,
        cadencia: "diario",
        sucesso: true,
        duracaoMs: Date.now() - inicio,
        erro: null,
        extra: {
          cnpjsConsultados: 0,
          totalCandidatos,
          motivo: "todos-frescos-no-ttl",
        },
      });
      return;
    }

    let consultados = 0; // concluídos (ok + sem cobertura)
    let comQsa = 0; // tiveram quadro societário
    let semCobertura = 0; // 404 na base aberta
    let semQsa = 0; // existem mas QSA vazio (ME/MEI)
    let falhas = 0;
    let ultimoErro: string | null = null;
    let abortouRateLimit = false;

    for (const [i, cnpj] of alvos.entries()) {
      if (i > 0) await pausaEntreCnpjs();
      try {
        const r = await consultarReceita(cnpj);
        if (r.tipo === "naoEncontrado") {
          await persistirAusencia(cnpj);
          semCobertura++;
          consultados++;
          continue;
        }
        await persistirQsa(r.qsa);
        consultados++;
        if (r.qsa.socios.length > 0) comQsa++;
        else semQsa++;
      } catch (err) {
        falhas++;
        ultimoErro = err instanceof Error ? err.message : String(err);
        logger.error(`NEXO Sócios — falha no CNPJ ${cnpj}: ${ultimoErro}`);
        // Rate-limit persistente (esgotou o backoff em 429): a fonte está nos
        // barrando — aborta o ciclo inteiro pra não piorar; o resto fica pra
        // amanhã (TTL garante que serão re-tentados).
        if (/HTTP 429/.test(ultimoErro)) {
          abortouRateLimit = true;
          logger.warn(
            "NEXO Sócios — rate-limit persistente da Receita; abortando ciclo.",
          );
          break;
        }
      }
    }

    // Cobertura de QSA é MÉTRICA, não erro: ME/MEI sem quadro societário é o
    // esperado. O ciclo é "sucesso" se conseguimos consultar ao menos um CNPJ.
    const coberturaQsa =
      consultados > 0 ? Math.round((comQsa / consultados) * 1000) / 1000 : 0;
    const sucesso = consultados > 0;

    await gravarSyncState({
      syncId: "socios",
      fonte: "qsa",
      colecao: COLECAO,
      cadencia: "diario",
      sucesso,
      // Degradado se houve falha de CNPJ ou abortamos por rate-limit, mas algo
      // foi coletado — o painel sinaliza sem marcar o ciclo todo como falho.
      degradado: (falhas > 0 || abortouRateLimit) && consultados > 0,
      erro: falhas > 0 ? ultimoErro : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        cnpjsAlvo: alvos.length,
        cnpjsConsultados: consultados,
        cnpjsComQsa: comQsa,
        cnpjsSemQsa: semQsa,
        cnpjsSemCobertura: semCobertura,
        cnpjsComFalha: falhas,
        coberturaQsa, // 0..1: fração dos consultados que tinham quadro societário
        // Cobertura da BASE (item 4): quantos fornecedores existem, quantos
        // ainda estavam na fila ANTES deste run e quantos sobram pro próximo —
        // o painel enxerga a varredura convergindo pra 100%.
        totalCandidatos,
        backlogAntes: pendentes,
        backlogDepois: Math.max(0, pendentes - consultados),
        abortouRateLimit,
      },
    });

    logger.info(
      `NEXO Sócios — concluído: ${consultados} CNPJs consultados ` +
        `(${comQsa} com QSA, ${semQsa} sem QSA/ME-MEI, ${semCobertura} sem cobertura), ` +
        `${falhas} falhas, cobertura QSA ${(coberturaQsa * 100).toFixed(1)}%, ` +
        `backlog ${Math.max(0, pendentes - consultados)}/${totalCandidatos}`,
    );
  },
);
