/**
 * SCORE DE RISCO PERSISTIDO E EXPLICÁVEL por entidade — `onNexoScoreEntidades`.
 *
 * Hoje o `scoreRiscoEntidade` (src/lib/nexo/score-risco.ts) calcula um score POR
 * ALERTA, em tempo de request, e nunca é materializado por ENTIDADE. Este cron
 * fecha essa lacuna: lê as coleções `nexo_*` já populadas pelos coletores/perfil
 * e MATERIALIZA, uma vez por dia, UM doc por entidade em `nexo_scores` — o
 * "raio-x de risco" do fornecedor: quão prioritário ele é para apuração, e
 * POR QUÊ (fatores explicáveis), sem recálculo na UI.
 *
 * ── PRINCÍPIO INVIOLÁVEL (LGPD / jurídico) ───────────────────────────────────
 * O score é um ÍNDICE DE PRIORIZAÇÃO DE APURAÇÃO — um "indício a apurar", NUNCA
 * uma acusação, prova de improbidade ou de ilícito. Cada fator carrega sua
 * `evidencia` (o dado objetivo que o sustenta) para que qualquer número seja
 * auditável e expurgável. Nenhum fator é renderizável como "% de crime".
 *   • O CPF/CNPJ é gravado EXATAMENTE como a fonte já o armazena (mascarado por
 *     `documento` — ver `mascararDoc`); não derivamos PII nova aqui.
 *   • Fatores de natureza societária/doação política (quando existirem) são
 *     LIMITADOS por teto a "atenção" — decisão do dono: nunca elevam sozinhos a
 *     "alto"/"crítico". Aqui não consumimos doação como fator; deixamos o teto
 *     documentado para quando uma onda futura adicionar fator societário.
 *
 * ── ENTES PÚBLICOS NÃO PONTUAM ───────────────────────────────────────────────
 * Regra de qualidade nº 1 do dono: a Prefeitura/Câmara/SAAE/IPREMM NÃO são
 * "fornecedores". `nexo_entidades` já as marca como `tipo: 'orgao'`. Aqui
 * pontuamos SOMENTE `tipo: 'empresa'` — órgãos (e pessoas físicas) ficam fora
 * do ranking de risco de fornecedor.
 *
 * ── FÓRMULA (explicável, aditiva com teto em 100) ────────────────────────────
 * O score é a SOMA das contribuições de cada fator, saturada em [0, 100]. Optamos
 * por aditivo (e não pela média geométrica do `prioridade.ts`, que opera sobre as
 * 3 pernas de UM indício) porque aqui agregamos SINAIS HETEROGÊNEOS de uma
 * entidade (sanção + alertas + flags + volume): cada um soma evidência
 * independente, e a explicação "este fator contribuiu com X pontos" é direta e
 * auditável. A filosofia de `scoreRiscoEntidade` é preservada nos PESOS por
 * severidade dos alertas (crítico ≫ suspeita ≫ atenção) — a mesma régua que
 * ordena os indícios nas telas.
 *
 * Cada fator = { id, rotulo, peso, valorBruto, contribuicao, evidencia }.
 *   • peso        — peso máximo do fator em pontos (a const PESOS, tunável).
 *   • valorBruto  — o dado objetivo medido (nº de sanções, nº de alertas, R$…).
 *   • contribuicao— pontos efetivamente somados (≤ peso), já saturado.
 *   • evidencia   — texto curto auditável do PORQUÊ daquela contribuição.
 *
 * ── NÍVEIS (faixas do score) ─────────────────────────────────────────────────
 *   baixo   [0, 25)   • medio  [25, 50)   • alto  [50, 75)   • critico [75, 100]
 *
 * ── DEGRADAÇÃO GRACIOSA ───────────────────────────────────────────────────────
 * Cada coleção/campo de entrada é opcional: se `nexo_alertas`/`nexo_sancoes`
 * faltarem ou falharem, o fator correspondente simplesmente não contribui (o
 * score cai, honestamente, em vez de quebrar). Por ENTIDADE, um erro de cálculo
 * é capturado e a entidade é pulada — o cron NUNCA cai por um doc ruim.
 *
 * ── IDEMPOTÊNCIA ──────────────────────────────────────────────────────────────
 * docId = `entidadeId` (o `_id` canônico de `nexo_entidades`). `set(merge:true)`
 * é UPSERT; o score é RECOMPUTADO do zero a cada ciclo — reexecutar SOBRESCREVE,
 * nunca duplica.
 *
 * Self-contained: o projeto `functions/` NÃO importa de `src/`. Usa só `db`/
 * `admin` de `../shared/admin` e `gravarSyncState`. Cron diário às 08h30 BRT —
 * DEPOIS de `perfil-entidades` (07h45) para que `nexo_entidades` esteja fresco.
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

/** Coleção de destino — 1 doc por entidade (o raio-x de RISCO). */
const COLECAO = "nexo_scores";
/** Coleção-fonte: o raio-x das entidades já consolidado. */
const COLECAO_ENTIDADES = "nexo_entidades";
/** Teto de docs lidos por coleção — proteção de memória/tempo. */
const MAX_DOCS = 60_000;

/**
 * Versão dos pesos — gravada em cada doc (`_versaoPesos`). Incremente ao mudar a
 * fórmula/PESOS para que a UI e os históricos saibam que a régua mudou.
 */
const VERSAO_PESOS = 1;

/**
 * PESOS (tunáveis) — contribuição MÁXIMA de cada fator em pontos. A soma dos
 * máximos pode exceder 100 de propósito: o score satura em 100, então uma
 * entidade com vários sinais fortes "estoura o teto" e fica em 'critico' — o que
 * é o comportamento desejado (não diluir o pior caso).
 */
const PESOS = {
  /** Sanção vigente (inidoneidade/impedimento) — o sinal mais forte. */
  sancao: 40,
  /** Sanção: bônus por sanção MÚLTIPLA (reincidência), por sanção extra. */
  sancaoExtra: 5,
  /** Alertas ativos: contribuição por severidade (somada, com teto próprio). */
  alertaCritico: 22,
  alertaSuspeita: 12,
  alertaAtencao: 5,
  alertaInformativo: 1,
  /** Teto da contribuição TOTAL dos alertas (evita que volume domine sozinho). */
  alertasTeto: 45,
  /** Flag `sem-processo` (empenho sem contrato/licitação) — indício formal. */
  flagSemProcesso: 12,
  /** Flag `acima-limite` (volume relevante) — sinal de materialidade, não culpa. */
  flagAcimaLimite: 8,
  /** Concentração/volume: escala log do totalEmpenhado (materialidade). */
  volume: 10,
  /**
   * TETO de fatores de natureza societária/doação política (decisão do dono):
   * sozinhos NUNCA elevam acima de 'atencao'. Não consumimos esse fator hoje
   * (nenhuma doação alimenta o score), mas a const fixa o contrato p/ ondas
   * futuras: `min(contribuicaoSocietaria, TETO_SOCIETARIO)`.
   */
  tetoSocietario: 24,
} as const;

/** Limiar (R$) a partir do qual o volume começa a contribuir (escala log). */
const VOLUME_PISO = 100_000;
/** Volume (R$) que satura a contribuição de volume no `PESOS.volume`. */
const VOLUME_TETO = 50_000_000;

/** Faixas de nível pelo score final. */
type Nivel = "baixo" | "medio" | "alto" | "critico";
function nivelDoScore(score: number): Nivel {
  if (score >= 75) return "critico";
  if (score >= 50) return "alto";
  if (score >= 25) return "medio";
  return "baixo";
}

/** Um fator explicável do score — a unidade auditável da régua. */
interface Fator {
  /** Identificador estável do fator. */
  id: string;
  /** Rótulo curto para a UI. */
  rotulo: string;
  /** Peso máximo do fator (pontos) — de PESOS. */
  peso: number;
  /** Dado objetivo medido (nº/R$/bool como número). */
  valorBruto: number;
  /** Pontos efetivamente somados ao score (≤ peso, já saturado). */
  contribuicao: number;
  /** Texto curto auditável do PORQUÊ desta contribuição. */
  evidencia: string;
}

// ── Normalizadores (self-contained; espelham perfil-entidades.ts) ─────────────

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

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** Raiz do CNPJ (8 primeiros dígitos). CPF (11 díg) não tem raiz. */
function cnpjRaiz(doc: unknown): string {
  const d = soDigitos(doc);
  return d.length === 14 ? d.slice(0, 8) : d;
}

/**
 * Mascara um documento para exibição/persistência derivada, preservando o
 * formato já gravado pela fonte. CPF vira `***.456.789-**`; CNPJ mantém a raiz
 * e mascara o miolo. Documento curto/lixo vira ofuscado.
 * Não inventamos PII: só reduzimos o que já existe em `nexo_entidades`.
 */
function mascararDoc(doc: unknown): string | null {
  const d = soDigitos(doc);
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.***/****-**`;
  }
  return d ? `${d.slice(0, 2)}***` : null;
}

/** Converte um Timestamp/string Firestore em ISO (ou null). */
function comoIso(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v || null;
  if (typeof v === "object" && v !== null && "toDate" in v) {
    try {
      return (v as { toDate(): Date }).toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

// ── Bucketização dos alertas ATIVOS por entidade ─────────────────────────────

/** Contagem de alertas ativos de uma entidade, por severidade. */
interface AlertasDaEntidade {
  critico: number;
  suspeita: number;
  atencao: number;
  informativo: number;
  total: number;
  /** ISO da detecção mais recente entre os alertas da entidade (recência). */
  ultimaDeteccaoEm: string | null;
}

function novoBucketAlertas(): AlertasDaEntidade {
  return {
    critico: 0,
    suspeita: 0,
    atencao: 0,
    informativo: 0,
    total: 0,
    ultimaDeteccaoEm: null,
  };
}

/**
 * Chave de associação alerta→entidade. O alerta carrega `sujeitoId` (CNPJ/CPF/
 * código) + `sujeitoRotulo` (nome). O doc de `nexo_entidades` é keyed pelo `_id`
 * canônico (CNPJ-raiz quando o doc é válido). Para casar SEM reimplementar a
 * validação Módulo 11, indexamos por DUAS chaves possíveis:
 *   • a raiz do sujeitoId (casa entidades com CNPJ válido, cujo `_id` é a raiz);
 *   • o sujeitoRotulo normalizado (fallback p/ entidades sem doc válido, cujo
 *     `_id` é o rótulo do nome).
 * No lado da entidade geramos as MESMAS duas chaves e tentamos as duas. É
 * best-effort: alertas cujo sujeito não casa nenhuma entidade são ignorados
 * (não há entidade a pontuar) — o score degrada honestamente.
 */
function rotuloCanonico(nome: unknown): string {
  return str(nome)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\b(LTDA|EIRELI|EPP|MEI|ME|S\/?A|SA|SS|EI)\b\.?/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.,\-\s]+$/, "")
    .trim();
}

/**
 * Lê TODOS os alertas ativos (`ativo == true`) uma única vez e os agrupa por
 * CHAVE DE SUJEITO (raiz do doc e/ou rótulo do nome). Devolve um mapa
 * chave → contagem por severidade. Sem `orderBy` (não exige índice composto):
 * só o filtro de igualdade `ativo == true`, que o Firestore atende com índice
 * de campo único automático.
 */
async function lerAlertasPorSujeito(): Promise<
  Map<string, AlertasDaEntidade>
> {
  const snap = await db
    .collection("nexo_alertas")
    .where("ativo", "==", true)
    .limit(MAX_DOCS)
    .get();

  const mapa = new Map<string, AlertasDaEntidade>();
  const bump = (chave: string, sev: string, iso: string | null) => {
    if (!chave) return;
    let b = mapa.get(chave);
    if (!b) {
      b = novoBucketAlertas();
      mapa.set(chave, b);
    }
    if (sev === "critico") b.critico++;
    else if (sev === "suspeita") b.suspeita++;
    else if (sev === "atencao") b.atencao++;
    else b.informativo++;
    b.total++;
    if (iso && (!b.ultimaDeteccaoEm || iso > b.ultimaDeteccaoEm)) {
      b.ultimaDeteccaoEm = iso;
    }
  };

  for (const d of snap.docs) {
    const data = d.data();
    const sujeitoId = data.sujeitoId ?? data.entidadeId ?? data.sujeito;
    const sujeitoRotulo = data.sujeitoRotulo ?? data.nome;
    const sev = str(data.classificacao) || "informativo";
    const iso = comoIso(data.ultimaDeteccaoEm ?? data.detectadoEm);

    // Mesma severidade contabilizada SOB AS DUAS chaves possíveis da entidade;
    // a associação na hora de pontuar usa a primeira que casar (raiz antes do
    // rótulo), então não há dupla contagem por entidade (ver `alertasDaEntidade`).
    const raiz = cnpjRaiz(sujeitoId);
    if (raiz) bump(`doc:${raiz}`, sev, iso);
    const rot = rotuloCanonico(sujeitoRotulo);
    if (rot) bump(`nome:${rot}`, sev, iso);
  }
  return mapa;
}

/**
 * Resolve o bucket de alertas de UMA entidade, preferindo a chave por doc (raiz)
 * e caindo no rótulo do nome — exatamente a precedência do `_id` canônico. Casa
 * com a mesma entidade só uma vez (não soma as duas chaves).
 */
function alertasDaEntidade(
  porSujeito: Map<string, AlertasDaEntidade>,
  ent: Record<string, unknown>,
): AlertasDaEntidade {
  const doc = ent.doc ?? ent.cnpj ?? ent.cpf ?? ent._id;
  const raiz = cnpjRaiz(doc);
  if (raiz) {
    const porDoc = porSujeito.get(`doc:${raiz}`);
    if (porDoc) return porDoc;
  }
  const rot = rotuloCanonico(ent.nome ?? ent._id);
  if (rot) {
    const porNome = porSujeito.get(`nome:${rot}`);
    if (porNome) return porNome;
  }
  return novoBucketAlertas();
}

// ── Sanções (por raiz do CNPJ) ───────────────────────────────────────────────

/**
 * Lê `nexo_sancoes` (keyed por CNPJ, sem `_exercicio`) e indexa por RAIZ do CNPJ
 * → { sancionado, nSancoes }. Espelha `perfil-entidades.lerSancoes`. A entidade
 * já traz `sancionado`/`nSancoes` de `perfil-entidades`, mas relemos a fonte
 * para o fator não depender de o perfil ter cruzado a sanção naquele ciclo
 * (degradação independente): usamos o MAIOR sinal entre os dois.
 */
async function lerSancoesPorRaiz(): Promise<
  Map<string, { sancionado: boolean; nSancoes: number }>
> {
  const snap = await db.collection("nexo_sancoes").limit(MAX_DOCS).get();
  const mapa = new Map<string, { sancionado: boolean; nSancoes: number }>();
  for (const d of snap.docs) {
    const data = d.data();
    const cnpj = soDigitos(data.cnpj ?? data._cnpj ?? d.id);
    if (!cnpj) continue;
    const raiz = cnpjRaiz(cnpj);
    const sancionado = data.sancionado === true;
    const n = toNum(data.qtdSancoes);
    const prev = mapa.get(raiz);
    mapa.set(raiz, {
      sancionado: sancionado || (prev?.sancionado ?? false),
      nSancoes: (prev?.nSancoes ?? 0) + n,
    });
  }
  return mapa;
}

// ── Cálculo do score de uma entidade ─────────────────────────────────────────

/** Resultado do cálculo de uma entidade. */
interface ScoreEntidade {
  score: number;
  nivel: Nivel;
  fatores: Fator[];
  nAlertas: number;
  ultimaDeteccaoEm: string | null;
}

/** sat(x) → [0, teto]. */
function sat(x: number, teto: number): number {
  return Math.max(0, Math.min(teto, x));
}

/** Arredonda a 1 casa (pontos não precisam de mais precisão). */
function r1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * Calcula o score composto [0,100] de UMA entidade `tipo: 'empresa'` a partir dos
 * fatores explicáveis disponíveis. Cada fator é incluído MESMO quando contribui
 * 0 (transparência: a UI mostra "sanção: 0 pts — sem sanção vigente"), salvo o
 * de volume que só aparece quando há volume.
 */
function calcularScore(
  ent: Record<string, unknown>,
  alertas: AlertasDaEntidade,
  sancao: { sancionado: boolean; nSancoes: number } | undefined,
): ScoreEntidade {
  const fatores: Fator[] = [];

  // ── Fator 1: SANÇÃO VIGENTE ────────────────────────────────────────────────
  // Combina o sinal do perfil (ent.sancionado) com a fonte relida (sancao),
  // pegando o maior — degradação independente das duas origens.
  const sancionado = ent.sancionado === true || sancao?.sancionado === true;
  const nSancoes = Math.max(toNum(ent.nSancoes), sancao?.nSancoes ?? 0);
  {
    let contrib = 0;
    let evidencia = "Sem sanção vigente registrada (CGU/CEIS/CNEP).";
    if (sancionado) {
      const extras = Math.max(0, nSancoes - 1);
      contrib = sat(PESOS.sancao + extras * PESOS.sancaoExtra, PESOS.sancao + 20);
      evidencia =
        nSancoes > 1
          ? `Sanção vigente com ${nSancoes} registros (reincidência) — indício a apurar.`
          : "Sanção vigente registrada (CGU/CEIS/CNEP) — indício a apurar.";
    }
    fatores.push({
      id: "sancao",
      rotulo: "Sanção vigente",
      peso: PESOS.sancao,
      valorBruto: sancionado ? Math.max(1, nSancoes) : 0,
      contribuicao: r1(contrib),
      evidencia,
    });
  }

  // ── Fator 2: ALERTAS ATIVOS (por severidade) ───────────────────────────────
  {
    const bruto =
      alertas.critico * PESOS.alertaCritico +
      alertas.suspeita * PESOS.alertaSuspeita +
      alertas.atencao * PESOS.alertaAtencao +
      alertas.informativo * PESOS.alertaInformativo;
    const contrib = sat(bruto, PESOS.alertasTeto);
    const partes: string[] = [];
    if (alertas.critico) partes.push(`${alertas.critico} crítico(s)`);
    if (alertas.suspeita) partes.push(`${alertas.suspeita} suspeita(s)`);
    if (alertas.atencao) partes.push(`${alertas.atencao} atenção`);
    if (alertas.informativo) partes.push(`${alertas.informativo} informativo(s)`);
    fatores.push({
      id: "alertas",
      rotulo: "Alertas ativos",
      peso: PESOS.alertasTeto,
      valorBruto: alertas.total,
      contribuicao: r1(contrib),
      evidencia: alertas.total
        ? `${alertas.total} alerta(s) ativo(s): ${partes.join(", ")}.`
        : "Nenhum alerta ativo associado.",
    });
  }

  // ── Fator 3: FLAGS DA ENTIDADE ─────────────────────────────────────────────
  const flags: string[] = Array.isArray(ent.flags)
    ? (ent.flags as unknown[]).map(str).filter(Boolean)
    : [];
  {
    const semProcesso = flags.includes("sem-processo");
    const acimaLimite = flags.includes("acima-limite");
    const contrib =
      (semProcesso ? PESOS.flagSemProcesso : 0) +
      (acimaLimite ? PESOS.flagAcimaLimite : 0);
    const partes: string[] = [];
    if (semProcesso) {
      partes.push("empenho sem contrato/licitação localizável (sem-processo)");
    }
    if (acimaLimite) partes.push("volume acima do limite de relevância");
    fatores.push({
      id: "flags",
      rotulo: "Sinais do perfil",
      peso: PESOS.flagSemProcesso + PESOS.flagAcimaLimite,
      valorBruto: (semProcesso ? 1 : 0) + (acimaLimite ? 1 : 0),
      contribuicao: r1(contrib),
      evidencia: partes.length
        ? `Flags: ${partes.join("; ")}.`
        : "Sem flags de risco no perfil.",
    });
  }

  // ── Fator 4: CONCENTRAÇÃO / VOLUME (materialidade, escala log) ──────────────
  const totalEmpenhado = toNum(ent.totalEmpenhado);
  {
    let contrib = 0;
    if (totalEmpenhado > VOLUME_PISO) {
      // Escala logarítmica entre PISO e TETO → [0, PESOS.volume].
      const frac =
        Math.log(totalEmpenhado / VOLUME_PISO) /
        Math.log(VOLUME_TETO / VOLUME_PISO);
      contrib = sat(frac * PESOS.volume, PESOS.volume);
    }
    fatores.push({
      id: "volume",
      rotulo: "Materialidade (volume empenhado)",
      peso: PESOS.volume,
      valorBruto: Math.round(totalEmpenhado * 100) / 100,
      contribuicao: r1(contrib),
      evidencia:
        totalEmpenhado > 0
          ? `Total empenhado de R$ ${totalEmpenhado.toLocaleString("pt-BR", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })} — materialidade (não é culpa).`
          : "Sem volume empenhado registrado.",
    });
  }

  // Score = soma das contribuições, saturada em [0, 100].
  const score = r1(
    sat(
      fatores.reduce((s, f) => s + f.contribuicao, 0),
      100,
    ),
  );

  return {
    score,
    nivel: nivelDoScore(score),
    fatores,
    nAlertas: alertas.total,
    ultimaDeteccaoEm: alertas.ultimaDeteccaoEm,
  };
}

// ── Persistência (upsert idempotente por entidadeId, em lotes de 400) ────────

async function persistir(
  docs: { ent: Record<string, unknown>; calc: ScoreEntidade }[],
): Promise<number> {
  if (docs.length === 0) return 0;
  const now = admin.firestore.FieldValue.serverTimestamp();
  let batch = db.batch();
  let n = 0;
  for (const { ent, calc } of docs) {
    const entidadeId = str(ent._id) || str(ent.id);
    if (!entidadeId) continue;
    batch.set(
      db.collection(COLECAO).doc(entidadeId),
      {
        entidadeId,
        tipo: str(ent.tipo) || "empresa",
        nome: str(ent.nome) || null,
        // PII: grava o documento JÁ MASCARADO (nunca o CPF/CNPJ cru aqui).
        documento: mascararDoc(ent.doc ?? ent.cnpj ?? ent.cpf),
        score: calc.score,
        nivel: calc.nivel,
        fatores: calc.fatores,
        nAlertas: calc.nAlertas,
        ultimaDeteccaoEm: calc.ultimaDeteccaoEm,
        // Aviso canônico embutido: o score é índice de PRIORIZAÇÃO, não acusação.
        _disclaimer:
          "Índice de priorização de apuração — indício a apurar, NUNCA acusação " +
          "ou prova de irregularidade. A investigação cabe a TCE-SP/MP/Controladoria.",
        _versaoPesos: VERSAO_PESOS,
        _fonte: "score-entidades",
        atualizadoEm: now,
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
  return n;
}

// ── Cron diário ──────────────────────────────────────────────────────────────

export const onNexoScoreEntidades = onSchedule(
  {
    // 08h30 BRT — DEPOIS de perfil-entidades (07h45), para pontuar sobre o
    // raio-x recém-reconstruído do dia (e depois dos coletores de sanção/socios).
    schedule: "30 8 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
    // No máximo UMA execução simultânea — evita que um retry concorra e
    // reescreva os scores duas vezes ao mesmo tempo.
    maxInstances: 1,
    // Retry idempotente: docId determinístico (entidadeId) com merge, score
    // RECOMPUTADO do zero — reexecutar após falha SOBRESCREVE, nunca duplica.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    await rodarScoreEntidades();
  },
);

/**
 * Núcleo reutilizável do cron de score — extraído do handler para poder rodar
 * FORA do Cloud Scheduler (pipeline de inteligência local). Idêntico ao cron.
 */
export async function rodarScoreEntidades(): Promise<void> {
    const inicio = Date.now();
    let falhaFatal: string | null = null;
    let degradado = false;

    // Sinais auxiliares: best-effort, degradam sem derrubar o ciclo.
    let alertasPorSujeito = new Map<string, AlertasDaEntidade>();
    try {
      alertasPorSujeito = await lerAlertasPorSujeito();
    } catch (err) {
      degradado = true;
      logger.warn(
        "NEXO Score — nexo_alertas indisponível; pontuando sem o fator de alertas",
        err,
      );
    }

    let sancoesPorRaiz = new Map<
      string,
      { sancionado: boolean; nSancoes: number }
    >();
    try {
      sancoesPorRaiz = await lerSancoesPorRaiz();
    } catch (err) {
      degradado = true;
      logger.warn(
        "NEXO Score — nexo_sancoes indisponível; usando só o sinal do perfil",
        err,
      );
    }

    // Lê as ENTIDADES tipo 'empresa' — órgãos e pessoas físicas ficam fora do
    // ranking de risco de fornecedor (regra de qualidade nº 1 do dono).
    let entidades: Record<string, unknown>[] = [];
    try {
      const snap = await db
        .collection(COLECAO_ENTIDADES)
        .where("tipo", "==", "empresa")
        .limit(MAX_DOCS)
        .get();
      entidades = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    } catch (err) {
      falhaFatal = err instanceof Error ? err.message : String(err);
      logger.error("NEXO Score — falha ao ler nexo_entidades (fatal)", err);
    }

    const calculados: { ent: Record<string, unknown>; calc: ScoreEntidade }[] =
      [];
    let pulados = 0;
    const porNivel: Record<Nivel, number> = {
      baixo: 0,
      medio: 0,
      alto: 0,
      critico: 0,
    };

    if (!falhaFatal) {
      for (const ent of entidades) {
        try {
          const raiz = cnpjRaiz(ent.doc ?? ent.cnpj ?? ent.cpf ?? ent._id);
          const sancao = raiz ? sancoesPorRaiz.get(raiz) : undefined;
          const alertas = alertasDaEntidade(alertasPorSujeito, ent);
          const calc = calcularScore(ent, alertas, sancao);
          calculados.push({ ent, calc });
          porNivel[calc.nivel]++;
        } catch (err) {
          // Degrada por-entidade: um doc ruim NUNCA derruba o ciclo.
          pulados++;
          degradado = true;
          logger.warn(
            `NEXO Score — entidade ${str(ent._id)} pulada por erro de cálculo`,
            err,
          );
        }
      }
    }

    let gravados = 0;
    if (!falhaFatal) {
      try {
        gravados = await persistir(calculados);
      } catch (err) {
        falhaFatal = err instanceof Error ? err.message : String(err);
        logger.error("NEXO Score — falha ao persistir nexo_scores", err);
      }
    }

    const sucesso = !falhaFatal;
    await gravarSyncState({
      syncId: "score_entidades",
      fonte: "score-entidades",
      colecao: COLECAO,
      cadencia: "diario",
      sucesso,
      degradado: sucesso && degradado,
      erro: falhaFatal,
      duracaoMs: Date.now() - inicio,
      extra: {
        entidadesLidas: entidades.length,
        scoresGravados: gravados,
        puladas: pulados,
        porNivel,
        versaoPesos: VERSAO_PESOS,
      },
    });

    logger.info(
      `NEXO Score — concluído: ${gravados} scores ` +
        `(crítico ${porNivel.critico}, alto ${porNivel.alto}, ` +
        `médio ${porNivel.medio}, baixo ${porNivel.baixo}), ` +
        `${pulados} puladas${degradado ? " [degradado]" : ""}`,
    );
}
