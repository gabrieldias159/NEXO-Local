/**
 * EIXO CENTRAL do NEXO — `onNexoMatVinculoVivo` (pedido 3 do plano-mestre,
 * §6 de `docs/nexo-hipersistema-conselho.md`).
 *
 * Cruza, por CNPJ-RAIZ, dois lados materializados pela própria base:
 *   • LADO SANÇÃO  — `nexo_sancoes` (federal: CEIS/CNEP/CEPIM, já coletado por
 *                    `coleta-sancoes.ts`). Esfera estadual/municipal ainda não
 *                    existe → degrada honesto (estado "pendente" no sync-state,
 *                    NUNCA inventa sanção).
 *   • LADO VÍNCULO VIVO — contrato VIGENTE (`vigenciaFim >= hoje`, ou sem fim
 *                    declarado mas com início) em `nexo_contratos_municipais`,
 *                    + empenho/pagamento RECENTE (movimento < 12 meses) em
 *                    `nexo_empenhos`. Lê AMBOS com `.select().stream()` projetado
 *                    — NUNCA `.get()` da coleção inteira (guarda de OOM).
 *
 * ── O QUE MATERIALIZA (`nexo_vinculo_vivo`, 1 doc por CNPJ sancionado COM vínculo)
 *   {
 *     _id: cnpjRaiz,                  // chave de junção (8 díg) — colapsa filiais
 *     cnpjRaiz, cnpjMasc, nome,       // CNPJ mascarado p/ exibição (LGPD)
 *     quadrante: 'vivo-sancao-vigente' | 'vivo-sancao-encerrada'
 *              | 'sem-vinculo-sancionado',
 *     vinculoVivo: boolean,           // tem contrato vigente OU empenho <12m
 *     sancaoFederalVigente: boolean,  // sanção com dataFim ausente/futura
 *     sancaoFederalEncerrada: boolean,
 *     cadastros: ['CEIS'|'CNEP'|'CEPIM'],
 *     piorClassificacao: 'critico'|'atencao'|'informativo',
 *     dataInicioSancao, dataFimSancao,
 *     valorEmpenhadoPosSancao, nEmpenhosPosSancao,  // empenho APÓS a sanção
 *     valorEmpenhadoPreSancao,  nEmpenhosPreSancao, // empenho ANTES (regular)
 *     contratosAtivos, valorContratosAtivos,
 *     provas: { empenhos:[refs], contratos:[refs] },  // rastro probatório
 *     esferasPendentes: ['estadual','municipal'],     // degradação honesta
 *     disclaimer, _fonte, _atualizadoEm
 *   }
 *
 * ── QUADRANTES (§6.3) ─────────────────────────────────────────────────────────
 *   • VIVO + SANÇÃO-VIGENTE     → 'vivo-sancao-vigente'   (crítico máximo)
 *   • VIVO + SANÇÃO-ENCERRADA   → 'vivo-sancao-encerrada' (atenção/histórico)
 *   • SEM-VÍNCULO + SANCIONADO  → 'sem-vinculo-sancionado'(informativo cadastro)
 * O 'crítico' EXIGE CNPJ-raiz idêntico (Módulo-11) + sanção com `dataFim`
 * ausente/futura (§6.4) — match só-por-nome NUNCA chega aqui (cruzamos por CNPJ).
 *
 * ── RETENÇÃO / EXPURGO (§6.4) ─────────────────────────────────────────────────
 * O quadrante é RECONSTRUÍDO do zero a cada ciclo: quando a sanção encerra, o
 * doc é rebaixado a 'vivo-sancao-encerrada' (nunca fossiliza em 'crítico'); e o
 * CNPJ que deixa de aparecer em `nexo_sancoes` é purgado do snapshot (sem delete
 * destrutivo de histórico — `_fonte` + ausência marcam reconciliação).
 *
 * ── IDEMPOTÊNCIA ──────────────────────────────────────────────────────────────
 * docId = CNPJ-raiz. `set(..., { merge: true })`; agregados RECONSTRUÍDOS por
 * ciclo (não incrementados) — reexecutar o cron SOBRESCREVE, nunca duplica.
 *
 * Cadência: diária (08h15 BRT — DEPOIS do perfil 07h45 e bem depois dos
 * coletores da madrugada/manhã + sanções a cada 6h).
 *
 * Self-contained: o projeto `functions/` NUNCA importa de `src/`. A validação
 * Módulo-11, a máscara de CNPJ e os normalizadores são re-implementados aqui
 * (espelham `perfil-entidades.ts` / `pii.ts`).
 */
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";
import { gravarSyncState } from "./sync-state";

/** Coleção de destino — 1 doc por CNPJ sancionado COM vínculo (o EIXO CENTRAL). */
const COLECAO = "nexo_vinculo_vivo";
/** Fonte canônica p/ `_fonte`. */
const FONTE = "vinculo-vivo";
/**
 * Janela (em meses) que define "vínculo VIVO" pelo lado empenho/pagamento:
 * empenho com movimento nos últimos 12 meses conta como vínculo ativo (§6.2).
 */
const JANELA_VINCULO_MESES = 12;
/** Teto de refs de prova (empenhos/contratos) por doc — evita doc gigante. */
const MAX_PROVAS = 25;
/**
 * Esferas de sanção AINDA não coletadas — carimbadas como pendentes p/ o painel
 * mostrar honestamente que o cruzamento roda só com o lado federal hoje (§6.5).
 */
const ESFERAS_PENDENTES = ["estadual", "municipal"] as const;
/** Disclaimer carimbado em TODO doc — indício, nunca acusação (§6.4 / LGPD). */
const DISCLAIMER =
  "Indício a apurar, não acusação. Cruzamento automático por CNPJ-raiz entre " +
  "sanção federal (CEIS/CNEP/CEPIM) e vínculo ativo com a Prefeitura. Convém " +
  "verificar a abrangência da sanção e eventual suspensão judicial/liminar " +
  "antes de qualquer conclusão. Esferas estadual e municipal ainda não " +
  "integradas (ausência não significa empresa limpa nessas esferas).";

// ── Normalizadores (self-contained; espelham perfil-entidades.ts / pii.ts) ────

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

/** Normaliza data (`YYYY-MM-DD...`, `DD/MM/YYYY`) para `YYYY-MM-DD`, ou "". */
function toIsoDate(v: unknown): string {
  const s = str(v);
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return "";
}

/** Raiz do CNPJ (8 primeiros dígitos). CPF (11 díg) não tem raiz. */
function cnpjRaiz(doc: unknown): string {
  const d = soDigitos(doc);
  return d.length === 14 ? d.slice(0, 8) : d;
}

// ── Validação Módulo 11 (CNPJ) — re-implementada local, sem dependência ───────

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

/**
 * Máscara visual de CNPJ p/ exibir sem expor a ordem/filial (espelha
 * `mascararDoc` de `pii.ts`). CNPJ não é PII, mas a junção/exibição mantém o
 * mesmo formato do resto do grafo. Recebe a RAIZ (8 díg) e devolve a máscara
 * com raiz pública + ordem mascarada.
 */
function mascararCnpjRaiz(raiz: string): string {
  const d = soDigitos(raiz);
  if (d.length >= 8) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/****-**`;
  }
  return d ? `${d}/****-**` : "";
}

// ── Exercícios monitorados (espelha coleta-sancoes.ts) ────────────────────────

/** Primeiro exercício retroativo monitorado (espelha `ANO_BASE` da coleta). */
const ANO_BASE = 2025;

/** Do exercício corrente até o ano-base, decrescente — escopo dos empenhos. */
function exerciciosMonitorados(): number[] {
  const atual = new Date().getFullYear();
  const anos: number[] = [];
  for (let a = atual; a >= ANO_BASE; a--) anos.push(a);
  return anos;
}

// ── LADO SANÇÃO — leitura de `nexo_sancoes` (coleção pequena, keyed por CNPJ) ─

/** Sanção federal consolidada por CNPJ-raiz. */
interface SancaoRaiz {
  cnpjRaiz: string;
  /** CNPJ(s) de 14 díg observados sob esta raiz (p/ casar empenho/contrato). */
  cnpjsCompletos: Set<string>;
  nome: string;
  cadastros: Set<string>;
  /** Data de início mais ANTIGA observada (limiar do "pós-sanção"). */
  dataInicio: string;
  /**
   * Data de fim mais TARDIA observada (null/"" = sem fim declarado = vigente).
   * Se QUALQUER sanção da raiz não tem fim, a raiz é tratada como vigente.
   */
  dataFim: string;
  semFimDeclarado: boolean;
  qtdSancoes: number;
}

/**
 * Lê `nexo_sancoes` (coleção pequena — 1 doc por CNPJ, sem `_exercicio`) e
 * consolida por CNPJ-RAIZ apenas os CNPJs com `sancionado === true`. Usa
 * `.select().stream()` projetado (mesma defesa de OOM dos coletores): só os
 * campos necessários trafegam, e o stream nunca segura a coleção inteira.
 *
 * `nexo_sancoes` (ver `coleta-sancoes.ts` → `persistirSancoes`) só carrega no
 * TOPO: `_fonte`/`_cnpj`/`cnpj`/`sancionado`/`qtdSancoes`/`cadastros`/`sancoes`.
 * NÃO há `nomeSancionado`/`dataInicioSancao`/`dataFimSancao` de topo — esses
 * vivem DENTRO de cada item de `sancoes[]` (`nomeSancionado`/`dataInicio`/
 * `dataFim` de `SancaoNorm`). Por isso projetamos só os campos que existem e
 * varremos `sancoes[]` para nome/datas (a projeção de array volta o array
 * inteiro; é a coleção pequena keyed por CNPJ, sem custo de OOM — mesmo padrão
 * de `perfil-entidades.lerSancoes`).
 */
async function lerSancoesPorRaiz(): Promise<Map<string, SancaoRaiz>> {
  const stream = db
    .collection("nexo_sancoes")
    .select("_cnpj", "cnpj", "sancionado", "qtdSancoes", "cadastros", "sancoes")
    .stream() as AsyncIterable<FirebaseFirestore.QueryDocumentSnapshot>;

  const mapa = new Map<string, SancaoRaiz>();
  for await (const doc of stream) {
    const d = doc.data();
    if (d.sancionado !== true) continue; // CNPJ verificado e LIMPO — ignora
    const cnpj = soDigitos(primeiro(d, "cnpj", "_cnpj") || doc.id);
    if (cnpj.length !== 14 || !cnpjValido(cnpj)) continue; // só CNPJ corroborado
    const raiz = cnpjRaiz(cnpj);

    // Nome e datas vivem DENTRO de cada item de `sancoes[]` (não no topo do
    // doc). Varre o array: nome mais longo vence; início mais antigo / fim mais
    // tardio resumem a janela; sanção sem `dataFim` marca `semFim` (vigente).
    const sancoes = Array.isArray(d.sancoes)
      ? (d.sancoes as Record<string, unknown>[])
      : [];
    let nomeSancao = "";
    let inicioMaisAntigo = "";
    let fimMaisTardio = "";
    let semFim = false;
    for (const s of sancoes) {
      const nome = primeiro(s, "nomeSancionado", "nome");
      if (nome && nome.length > nomeSancao.length) nomeSancao = nome;
      const ini = toIsoDate(s.dataInicio);
      const fim = toIsoDate(s.dataFim);
      if (ini && (!inicioMaisAntigo || ini < inicioMaisAntigo)) {
        inicioMaisAntigo = ini;
      }
      if (!fim) semFim = true; // sanção sem fim declarado → potencialmente vigente
      else if (!fimMaisTardio || fim > fimMaisTardio) fimMaisTardio = fim;
    }
    // Sem nenhuma data de fim observada (array vazio ou só itens sem fim) → sem
    // fim declarado → tratada como vigente (conservador).
    if (!fimMaisTardio) semFim = true;

    const cadastros = Array.isArray(d.cadastros)
      ? (d.cadastros as unknown[]).map((c) => str(c)).filter(Boolean)
      : [];

    const cur = mapa.get(raiz);
    if (cur) {
      cur.cnpjsCompletos.add(cnpj);
      for (const c of cadastros) cur.cadastros.add(c);
      cur.qtdSancoes += toNum(d.qtdSancoes);
      if (inicioMaisAntigo && (!cur.dataInicio || inicioMaisAntigo < cur.dataInicio)) {
        cur.dataInicio = inicioMaisAntigo;
      }
      if (fimMaisTardio && (!cur.dataFim || fimMaisTardio > cur.dataFim)) {
        cur.dataFim = fimMaisTardio;
      }
      cur.semFimDeclarado = cur.semFimDeclarado || semFim;
      if (nomeSancao && nomeSancao.length > cur.nome.length) cur.nome = nomeSancao;
    } else {
      mapa.set(raiz, {
        cnpjRaiz: raiz,
        cnpjsCompletos: new Set([cnpj]),
        nome: nomeSancao,
        cadastros: new Set(cadastros),
        dataInicio: inicioMaisAntigo,
        dataFim: fimMaisTardio,
        semFimDeclarado: semFim,
        qtdSancoes: toNum(d.qtdSancoes),
      });
    }
  }
  return mapa;
}

// ── LADO VÍNCULO VIVO — acumulador por raiz sancionada ───────────────────────

interface RefProva {
  colecao: string;
  id: string;
  valor: number;
  data: string;
}

interface VinculoAcc {
  /** Empenhos com movimento APÓS a data de início da sanção (a apurar). */
  valorEmpPos: number;
  nEmpPos: number;
  /** Empenhos com movimento ANTES da sanção (regular — contratação prévia). */
  valorEmpPre: number;
  nEmpPre: number;
  /** Empenho recente (< janela) — caracteriza vínculo vivo pelo lado empenho. */
  temEmpenhoRecente: boolean;
  contratosAtivos: number;
  valorContratosAtivos: number;
  provasEmpenhos: RefProva[];
  provasContratos: RefProva[];
  /** Melhor nome de fornecedor observado (complementa o nome da sanção). */
  nomeFornecedor: string;
}

function novoVinculo(): VinculoAcc {
  return {
    valorEmpPos: 0,
    nEmpPos: 0,
    valorEmpPre: 0,
    nEmpPre: 0,
    temEmpenhoRecente: false,
    contratosAtivos: 0,
    valorContratosAtivos: 0,
    provasEmpenhos: [],
    provasContratos: [],
    nomeFornecedor: "",
  };
}

function addProva(lista: RefProva[], ref: RefProva): void {
  if (lista.length < MAX_PROVAS) lista.push(ref);
}

/**
 * Varre `nexo_empenhos` dos exercícios monitorados com `.select().stream()`
 * projetado — NUNCA `.get()` da coleção inteira (guarda de OOM). Para cada
 * empenho de um CNPJ sob raiz SANCIONADA, classifica o movimento como PRÉ ou
 * PÓS data de início da sanção e acumula valor/contagem + ref de prova.
 *
 * Projeta os campos `_*` (carimbados pelo coletor) + as chaves de data do bruto
 * SMARAPD (`DataMovimentoEmpenho`/`DataEmp`/...) que `perfil-entidades.ts`
 * resolve — assim cada doc volta enxuto, sem o bruto inteiro do empenho.
 */
async function varrerEmpenhos(
  sancoes: Map<string, SancaoRaiz>,
  vinculos: Map<string, VinculoAcc>,
  limiarRecenteIso: string,
): Promise<void> {
  const stream = db
    .collection("nexo_empenhos")
    .where("_exercicio", "in", exerciciosMonitorados())
    .select(
      "_cnpj",
      "_valor",
      "_fornecedor",
      "DataMovimentoEmpenho",
      "DataEmp",
      "DataMovEmp",
      "DataEmpenho",
      "DataEmissao",
      "DataLancamento",
      "Data",
    )
    .stream() as AsyncIterable<FirebaseFirestore.QueryDocumentSnapshot>;

  for await (const doc of stream) {
    const d = doc.data();
    const cnpj = soDigitos(d._cnpj);
    if (cnpj.length !== 14) continue;
    const raiz = cnpjRaiz(cnpj);
    const sancao = sancoes.get(raiz);
    if (!sancao) continue; // empenho de fornecedor NÃO sancionado — ignora

    let v = vinculos.get(raiz);
    if (!v) {
      v = novoVinculo();
      vinculos.set(raiz, v);
    }
    const nomeForn = primeiro(d, "_fornecedor");
    if (nomeForn && nomeForn.length > v.nomeFornecedor.length) {
      v.nomeFornecedor = nomeForn;
    }

    const valor = typeof d._valor === "number" ? d._valor : toNum(d._valor);
    const dataMov = toIsoDate(
      primeiro(
        d,
        "DataMovimentoEmpenho",
        "DataEmp",
        "DataMovEmp",
        "DataEmpenho",
        "DataEmissao",
        "DataLancamento",
        "Data",
      ),
    );

    // Empenho com movimento na janela recente → caracteriza vínculo vivo.
    if (dataMov && dataMov >= limiarRecenteIso) v.temEmpenhoRecente = true;

    // PRÉ vs PÓS sanção: empenho cujo movimento é >= dataInicio da sanção é o
    // que importa apurar (contratação MANTIDA/feita já estando a empresa
    // sancionada). Sem data de início da sanção OU sem data do empenho, não dá
    // pra afirmar "pós" — conta conservador como PRÉ (não infla o crítico).
    const ehPos = !!(sancao.dataInicio && dataMov && dataMov >= sancao.dataInicio);
    if (ehPos) {
      v.valorEmpPos += valor;
      v.nEmpPos++;
    } else {
      v.valorEmpPre += valor;
      v.nEmpPre++;
    }
    addProva(v.provasEmpenhos, {
      colecao: "nexo_empenhos",
      id: doc.id,
      valor: Math.round(valor * 100) / 100,
      data: dataMov,
    });
  }
}

/**
 * Varre `nexo_contratos_municipais` dos exercícios monitorados com
 * `.select().stream()` projetado. Para cada contrato de um CNPJ sob raiz
 * SANCIONADA, conta os ATIVOS (vigência em aberto na data de hoje) e acumula
 * valor + ref de prova. Contrato sem `cnpjContratada` (Dados Abertos não expõe;
 * enriquecimento SMARAPD pendente) não casa por CNPJ — fica fora do cruzamento
 * por CNPJ até o enriquecimento preencher (degradação honesta, sem inventar).
 */
async function varrerContratos(
  sancoes: Map<string, SancaoRaiz>,
  vinculos: Map<string, VinculoAcc>,
  hojeIso: string,
): Promise<void> {
  const stream = db
    .collection("nexo_contratos_municipais")
    .where("_exercicio", "in", exerciciosMonitorados())
    .select(
      "_cnpj",
      "cnpjContratada",
      "_valor",
      "valor",
      "vigenciaInicio",
      "vigenciaFim",
      "nomeContratada",
    )
    .stream() as AsyncIterable<FirebaseFirestore.QueryDocumentSnapshot>;

  for await (const doc of stream) {
    const d = doc.data();
    const cnpj = soDigitos(primeiro(d, "_cnpj", "cnpjContratada"));
    if (cnpj.length !== 14) continue; // contrato sem CNPJ → não casa por CNPJ
    const raiz = cnpjRaiz(cnpj);
    const sancao = sancoes.get(raiz);
    if (!sancao) continue;

    let v = vinculos.get(raiz);
    if (!v) {
      v = novoVinculo();
      vinculos.set(raiz, v);
    }
    const nomeContr = primeiro(d, "nomeContratada");
    if (nomeContr && nomeContr.length > v.nomeFornecedor.length) {
      v.nomeFornecedor = nomeContr;
    }

    const inicio = toIsoDate(primeiro(d, "vigenciaInicio"));
    const fim = toIsoDate(primeiro(d, "vigenciaFim"));
    // Ativo: fim de vigência >= hoje; ou sem fim declarado mas com início
    // (vigência em aberto). Mesma regra de `perfil-entidades.ts`.
    const ativo = fim ? fim >= hojeIso : !!inicio;
    if (ativo) {
      const valor =
        typeof d._valor === "number" ? d._valor : toNum(primeiro(d, "valor"));
      v.contratosAtivos++;
      v.valorContratosAtivos += valor;
      addProva(v.provasContratos, {
        colecao: "nexo_contratos_municipais",
        id: doc.id,
        valor: Math.round(valor * 100) / 100,
        data: fim || inicio,
      });
    }
  }
}

// ── Quadrantes + classificação (§6.3 / §6.4) ──────────────────────────────────

type Quadrante =
  | "vivo-sancao-vigente"
  | "vivo-sancao-encerrada"
  | "sem-vinculo-sancionado";

type Classificacao = "critico" | "atencao" | "informativo";

/**
 * Sanção VIGENTE na data de referência: sem fim declarado, OU fim >= hoje.
 * Conservador (suporta suspensão judicial/liminar): na dúvida (sem fim), trata
 * como vigente — o painel carimba o disclaimer p/ verificação humana.
 */
function sancaoVigente(s: SancaoRaiz, hojeIso: string): boolean {
  if (s.semFimDeclarado) return true;
  if (!s.dataFim) return true; // nenhuma data de fim observada → assume vigente
  return s.dataFim >= hojeIso;
}

function derivarQuadrante(
  vivo: boolean,
  vigente: boolean,
): Quadrante {
  if (vivo && vigente) return "vivo-sancao-vigente";
  if (vivo && !vigente) return "vivo-sancao-encerrada";
  return "sem-vinculo-sancionado";
}

/**
 * Classificação do quadrante. O 'crítico' SÓ é atribuído a 'vivo-sancao-vigente'
 * — e o cruzamento é SEMPRE por CNPJ-raiz Módulo-11 corroborado (nunca por
 * nome), então o cap-por-nome da §6.4 é satisfeito por construção.
 */
function derivarClassificacao(q: Quadrante): Classificacao {
  if (q === "vivo-sancao-vigente") return "critico";
  if (q === "vivo-sancao-encerrada") return "atencao";
  return "informativo";
}

// ── Persistência (upsert idempotente por CNPJ-raiz, em lotes de 400) ──────────

interface ResultadoQuadrantes {
  gravados: number;
  vivoVigente: number;
  vivoEncerrada: number;
  semVinculo: number;
  valorPosTotal: number;
}

/**
 * Materializa `nexo_vinculo_vivo`: 1 doc por CNPJ-raiz SANCIONADO. Inclui também
 * os sancionados SEM vínculo (quadrante informativo) — o painel sabe que o CNPJ
 * está no cadastro federal mas hoje NÃO contrata. Reconstrução completa por
 * ciclo: o quadrante é recalculado (rebaixa de crítico→atenção quando a sanção
 * encerra; §6.4).
 */
async function materializar(
  sancoes: Map<string, SancaoRaiz>,
  vinculos: Map<string, VinculoAcc>,
  hojeIso: string,
): Promise<ResultadoQuadrantes> {
  const now = admin.firestore.FieldValue.serverTimestamp();
  let batch = db.batch();
  let n = 0;
  const res: ResultadoQuadrantes = {
    gravados: 0,
    vivoVigente: 0,
    vivoEncerrada: 0,
    semVinculo: 0,
    valorPosTotal: 0,
  };

  for (const [raiz, sancao] of sancoes) {
    const v = vinculos.get(raiz);
    const vivo = !!v && (v.contratosAtivos > 0 || v.temEmpenhoRecente);
    const vigente = sancaoVigente(sancao, hojeIso);
    const quadrante = derivarQuadrante(vivo, vigente);
    const classificacao = derivarClassificacao(quadrante);

    if (quadrante === "vivo-sancao-vigente") res.vivoVigente++;
    else if (quadrante === "vivo-sancao-encerrada") res.vivoEncerrada++;
    else res.semVinculo++;
    res.valorPosTotal += v?.valorEmpPos ?? 0;

    const nome = sancao.nome || v?.nomeFornecedor || "";

    batch.set(
      db.collection(COLECAO).doc(raiz),
      {
        _id: raiz,
        _fonte: FONTE,
        // `_cnpj` (8 díg raiz) — chave de junção uniforme do grafo; CNPJ-raiz
        // não é PII e já é pública. Filtros por `_cnpj`/`_fonte` na rota.
        _cnpj: raiz,
        cnpjRaiz: raiz,
        cnpjMasc: mascararCnpjRaiz(raiz),
        nome,
        quadrante,
        classificacao,
        vinculoVivo: vivo,
        sancaoFederalVigente: vigente,
        sancaoFederalEncerrada: !vigente,
        cadastros: [...sancao.cadastros].sort(),
        qtdSancoes: sancao.qtdSancoes,
        dataInicioSancao: sancao.dataInicio || null,
        dataFimSancao: sancao.dataFim || null,
        // Empenho PÓS-sanção (a apurar) vs PRÉ-sanção (regular) — §6.2.
        valorEmpenhadoPosSancao: Math.round((v?.valorEmpPos ?? 0) * 100) / 100,
        nEmpenhosPosSancao: v?.nEmpPos ?? 0,
        valorEmpenhadoPreSancao: Math.round((v?.valorEmpPre ?? 0) * 100) / 100,
        nEmpenhosPreSancao: v?.nEmpPre ?? 0,
        contratosAtivos: v?.contratosAtivos ?? 0,
        valorContratosAtivos:
          Math.round((v?.valorContratosAtivos ?? 0) * 100) / 100,
        // Rastro probatório — refs aos docs de origem (empenho/contrato).
        provas: {
          empenhos: v?.provasEmpenhos ?? [],
          contratos: v?.provasContratos ?? [],
        },
        // Degradação honesta: as esferas ainda não integradas (nunca inventa).
        esferaFederal: true,
        esferasPendentes: [...ESFERAS_PENDENTES],
        disclaimer: DISCLAIMER,
        _exerciciosMonitorados: exerciciosMonitorados(),
        _atualizadoEm: now,
      },
      { merge: true },
    );
    n++;
    res.gravados++;
    if (n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
  return res;
}

/**
 * Reconciliação: CNPJs antes em `nexo_vinculo_vivo` que SUMIRAM do snapshot
 * atual (sanção encerrada e expurgada da fonte, ou CNPJ removido de
 * `nexo_sancoes`). NÃO faz delete destrutivo do histórico: marca
 * `quadrante: 'sancao-removida'` + `vinculoVivo:false` p/ o painel saber que o
 * indício deixou de existir na fonte (expurgo honesto, §6.4).
 */
async function reconciliarRemovidos(
  raizesAtuais: Set<string>,
): Promise<number> {
  const snap = await db
    .collection(COLECAO)
    .where("_fonte", "==", FONTE)
    .select("_id")
    .get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  let batch = db.batch();
  let n = 0;
  for (const doc of snap.docs) {
    if (raizesAtuais.has(doc.id)) continue;
    batch.set(
      doc.ref,
      {
        quadrante: "sancao-removida",
        classificacao: "informativo",
        vinculoVivo: false,
        sancaoFederalVigente: false,
        _removidoEm: now,
        _atualizadoEm: now,
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

// ── Cron diário ───────────────────────────────────────────────────────────────

export const onNexoMatVinculoVivo = onSchedule(
  {
    // 08h15 BRT — DEPOIS do perfil (07h45) e do linkage (07h15), e bem depois
    // dos coletores da madrugada/manhã. As sanções (a cada 6h) já estão frescas.
    schedule: "15 8 * * *",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    // O cruzamento varre empenhos+contratos por streaming projetado (~2 campos
    // por doc) — 1GiB cobre o exercício 2025 real com folga (mesmo perfil do
    // `perfil-entidades.ts`, que também lê empenhos/contratos sob 1GiB).
    timeoutSeconds: 540,
    memory: "1GiB",
    // Hardening (#13): no máximo UMA execução simultânea — evita que um disparo
    // atrasado/retry concorra com a execução em andamento e reescreva os
    // quadrantes duas vezes ao mesmo tempo.
    maxInstances: 1,
    // Retry idempotente do Cloud Scheduler: cada doc tem docId determinístico (o
    // CNPJ-raiz) gravado com `merge`, e os agregados são RECONSTRUÍDOS do zero
    // por ciclo — reexecutar após falha SOBRESCREVE, nunca duplica.
    retryCount: 2,
    maxRetrySeconds: 3600,
    minBackoffSeconds: 60,
    maxBackoffSeconds: 600,
    maxDoublings: 3,
  },
  async () => {
    const inicio = Date.now();
    const hojeIso = new Date().toISOString().slice(0, 10);
    // Limiar do "vínculo vivo" pelo lado empenho — 12 meses atrás.
    const limiar = new Date();
    limiar.setMonth(limiar.getMonth() - JANELA_VINCULO_MESES);
    const limiarRecenteIso = limiar.toISOString().slice(0, 10);

    // ── LADO SANÇÃO (federal) ────────────────────────────────────────────────
    let sancoes: Map<string, SancaoRaiz>;
    try {
      sancoes = await lerSancoesPorRaiz();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO Vínculo Vivo — falha ao ler nexo_sancoes", err);
      await gravarSyncState({
        syncId: "vinculo_vivo",
        fonte: FONTE,
        colecao: COLECAO,
        cadencia: "diario",
        sucesso: false,
        erro: msg,
        duracaoMs: Date.now() - inicio,
        extra: { esferasIntegradas: ["federal"], esferasPendentes: [...ESFERAS_PENDENTES] },
      });
      return;
    }

    // Degradação honesta: SEM sanções federais coletadas (token CGU pendente, ou
    // ciclo de sanções ainda não rodou) → estado "pendente", NÃO falha, NÃO
    // inventa. O painel mostra "aguardando coleta de sanções".
    if (sancoes.size === 0) {
      logger.warn(
        "NEXO Vínculo Vivo — nexo_sancoes sem CNPJ sancionado; ciclo pendente.",
      );
      await gravarSyncState({
        syncId: "vinculo_vivo",
        fonte: FONTE,
        colecao: COLECAO,
        cadencia: "diario",
        sucesso: true, // não há o que cruzar não é falha
        degradado: true,
        erro: "pendente: nexo_sancoes sem CNPJ sancionado (lado federal vazio)",
        duracaoMs: Date.now() - inicio,
        extra: {
          esferasIntegradas: ["federal"],
          esferasPendentes: [...ESFERAS_PENDENTES],
          cnpjsSancionados: 0,
          quadranteCritico: 0,
        },
      });
      return;
    }

    // ── LADO VÍNCULO VIVO (empenhos + contratos, streaming projetado) ──────────
    const vinculos = new Map<string, VinculoAcc>();
    let falhas = 0;
    let ultimoErro: string | null = null;
    try {
      await varrerEmpenhos(sancoes, vinculos, limiarRecenteIso);
    } catch (err) {
      falhas++;
      ultimoErro = err instanceof Error ? err.message : String(err);
      logger.error("NEXO Vínculo Vivo — falha ao varrer nexo_empenhos", err);
    }
    try {
      await varrerContratos(sancoes, vinculos, hojeIso);
    } catch (err) {
      falhas++;
      ultimoErro = err instanceof Error ? err.message : String(err);
      logger.error("NEXO Vínculo Vivo — falha ao varrer contratos", err);
    }

    // ── CRUZAMENTO + materialização ────────────────────────────────────────────
    let resultado: ResultadoQuadrantes;
    try {
      resultado = await materializar(sancoes, vinculos, hojeIso);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("NEXO Vínculo Vivo — falha ao materializar quadrantes", err);
      await gravarSyncState({
        syncId: "vinculo_vivo",
        fonte: FONTE,
        colecao: COLECAO,
        cadencia: "diario",
        sucesso: false,
        erro: msg,
        duracaoMs: Date.now() - inicio,
        extra: {
          esferasIntegradas: ["federal"],
          esferasPendentes: [...ESFERAS_PENDENTES],
          cnpjsSancionados: sancoes.size,
        },
      });
      return;
    }

    // Expurgo honesto dos que sumiram do snapshot (sanção encerrada/removida).
    let reconciliados = 0;
    try {
      reconciliados = await reconciliarRemovidos(new Set(sancoes.keys()));
    } catch (err) {
      // Reconciliação é higiene — se falhar, o snapshot ainda foi materializado.
      logger.warn("NEXO Vínculo Vivo — reconciliação falhou; seguindo", err);
    }

    await gravarSyncState({
      syncId: "vinculo_vivo",
      fonte: FONTE,
      colecao: COLECAO,
      cadencia: "diario",
      // Sucesso desde que tenha materializado os quadrantes; varredura parcial
      // (uma das fontes falhou) marca `degradado`, não falha total.
      sucesso: resultado.gravados > 0 || sancoes.size > 0,
      degradado: falhas > 0,
      erro: falhas > 0 ? ultimoErro : null,
      duracaoMs: Date.now() - inicio,
      extra: {
        esferasIntegradas: ["federal"],
        esferasPendentes: [...ESFERAS_PENDENTES],
        cnpjsSancionados: sancoes.size,
        cnpjsComVinculo: vinculos.size,
        quadranteVivoVigente: resultado.vivoVigente,
        quadranteVivoEncerrada: resultado.vivoEncerrada,
        quadranteSemVinculo: resultado.semVinculo,
        valorEmpenhadoPosSancao: Math.round(resultado.valorPosTotal * 100) / 100,
        reconciliados,
        fontesComFalha: falhas,
      },
    });
    logger.info(
      `NEXO Vínculo Vivo — concluído: ${resultado.gravados} CNPJs sancionados ` +
        `materializados (${resultado.vivoVigente} VIVO+VIGENTE, ` +
        `${resultado.vivoEncerrada} VIVO+encerrada, ${resultado.semVinculo} sem-vínculo), ` +
        `${reconciliados} reconciliados, ${falhas} falhas`,
    );
  },
);
