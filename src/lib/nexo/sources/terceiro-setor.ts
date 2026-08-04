/**
 * Conector do subsistema CONVÊNIOS E TERCEIRO SETOR — NEXO.
 *
 * Coleta dois módulos da API SMARAPD do Portal da Transparência de Marília:
 *  1. `despesas_subvencoes` / visão `subvencoes` — repasses a OSC/OSS
 *     (subvenções, auxílios e contribuições do terceiro setor).
 *  2. `emendas_parlamentares` / visão `EmendasParlamentares` — emendas
 *     parlamentares e seu estágio de execução.
 *
 * USO SERVER-SIDE APENAS — a API SMARAPD exige `User-Agent` e bloqueia CORS.
 * Chamar somente de API routes (`/api/nexo/*`) ou Cloud Functions.
 *
 * A API devolve nomes de campo com capitalização variável entre módulos e
 * valores em formato brasileiro — a normalização abaixo é defensiva: tenta
 * vários nomes de campo por valor e nunca lança em registro malformado.
 *
 * Ver docs/nexo/02-catalogo-de-monitoramentos.md §12 (TS-01..TS-09) e §6
 * (DE-10 emenda). Apenas dados públicos.
 */
import { filterModuloAllPages } from './smarapd';
import { parseValorBR, parseDataBR, soDigitos } from '../normalizar';

// ── Helpers de leitura defensiva ─────────────────────────────────────────────

function pick(rec: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (rec[k] != null && rec[k] !== '') return rec[k];
  }
  return undefined;
}

function pickStr(rec: Record<string, unknown>, ...keys: string[]): string {
  const v = pick(rec, ...keys);
  return v == null ? '' : String(v).trim();
}

// ── Subvenções / repasses ao terceiro setor ──────────────────────────────────

export interface SubvencaoNorm {
  id: string;
  /** CNPJ/CPF do beneficiário — apenas dígitos. */
  beneficiarioDoc: string;
  beneficiarioNome: string;
  numeroEmpenho: string;
  exercicio: number;
  /** Data do repasse/empenho em ISO `yyyy-MM-dd`, ou null se não parseável. */
  data: string | null;
  /** Valor empenhado/concedido (R$). */
  valor: number;
  /** Valor efetivamente pago (R$). */
  valorPago: number;
  /** Objeto / finalidade da subvenção. */
  objeto: string;
  /** Tipo do repasse — subvenção, auxílio, contribuição. */
  tipo: string;
  /** Unidade gestora / órgão concedente. */
  unidadeGestora: string;
  /** Lei/decreto autorizador, quando informado. */
  leiAutorizadora: string;
}

/**
 * Normaliza registros do módulo `despesas_subvencoes` / `subvencoes`.
 *
 * Schema real validado em 2026-05-22: o módulo expõe um registro por empenho
 * com `NroEmpenho`, `Modalidade`, `NomeFornecedor`, `DataEmp`, `ValorEmpenhado`,
 * `ValorLiquidado`, `ValorPago`, `Programa`, `UnidadeOrcamentaria`, `ID`. Não há
 * CNPJ do beneficiário, objeto textual livre nem lei autorizadora — o `objeto`
 * é aproximado pelo `Programa` orçamentário. Os aliases extras permanecem como
 * defesa contra mudança de schema. O módulo só tem dados de 2013 a 2021.
 */
export function normalizarSubvencoes(
  brutos: Record<string, unknown>[],
  exercicio: number,
): SubvencaoNorm[] {
  return brutos.map((rec, idx) => ({
    id: String(
      pick(rec, 'ID', 'Id', 'NroEmpenho', 'NumeroEmpenho') ?? `subv-${exercicio}-${idx}`,
    ),
    beneficiarioDoc: soDigitos(
      pick(rec, 'CNPJ', 'CPFCNPJ', 'CpfCnpj', 'CnpjBeneficiario', 'CpfCnpjFornecedor'),
    ),
    beneficiarioNome: pickStr(
      rec,
      'NomeFornecedor',
      'NomeBeneficiario',
      'Beneficiario',
      'Fornecedor',
      'NomeEntidade',
      'RazaoSocial',
    ),
    numeroEmpenho: pickStr(rec, 'NroEmpenho', 'NumeroEmpenho', 'NumEmpenho'),
    exercicio: Number(pick(rec, 'Exercicio', 'ExercEmpenho')) || exercicio,
    data: parseDataBR(
      pick(rec, 'DataEmp', 'DataMovEmp', 'DataMovimentoEmpenho', 'DataEmpenho', 'DataRepasse', 'Data'),
    ),
    valor: parseValorBR(
      pick(rec, 'ValorEmpenhado', 'ValorEmpenho', 'ValorConcedido', 'ValorRepasse', 'Valor'),
    ),
    valorPago: parseValorBR(pick(rec, 'ValorPago', 'ValorLiquidoPago')),
    objeto: pickStr(rec, 'Objeto', 'Finalidade', 'Evento', 'Historico', 'Descricao', 'Programa'),
    tipo: pickStr(rec, 'TipoSubvencao', 'TipoRepasse', 'Tipo', 'Modalidade', 'Elemento'),
    unidadeGestora: pickStr(rec, 'UnidadeOrcamentaria', 'UG', 'UnidadeGestora', 'Orgao'),
    leiAutorizadora: pickStr(rec, 'LeiAutorizadora', 'Lei', 'Decreto', 'AtoLegal'),
  }));
}

// ── Emendas parlamentares ────────────────────────────────────────────────────

export interface EmendaNorm {
  id: string;
  /** Número/identificação da emenda. */
  numero: string;
  exercicio: number;
  /** Vereador/autor da emenda. */
  autor: string;
  /** Objeto / destinação da emenda. */
  objeto: string;
  /** Beneficiário (entidade/órgão), quando informado. */
  beneficiarioNome: string;
  /** CNPJ/CPF do beneficiário — apenas dígitos. */
  beneficiarioDoc: string;
  /** Valor previsto/destinado pela emenda (R$). */
  valorPrevisto: number;
  /** Valor empenhado (R$). */
  valorEmpenhado: number;
  /** Valor liquidado (R$). */
  valorLiquidado: number;
  /** Valor pago (R$). */
  valorPago: number;
  /** true quando a emenda é impositiva (execução obrigatória). */
  impositiva: boolean;
  /** Situação textual da emenda, conforme o portal. */
  situacao: string;
  /** Data de referência (publicação/empenho), ISO `yyyy-MM-dd` ou null. */
  data: string | null;
  unidadeGestora: string;
}

/**
 * Heurística de classificação como impositiva. O portal nem sempre traz um
 * flag dedicado — inferimos por campo booleano explícito ou por texto.
 */
function inferirImpositiva(rec: Record<string, unknown>): boolean {
  const flag = pick(rec, 'Impositiva', 'EhImpositiva', 'Obrigatoria');
  if (typeof flag === 'boolean') return flag;
  const txt = `${pickStr(rec, 'Impositiva', 'EhImpositiva', 'Obrigatoria')} ${pickStr(
    rec,
    'TipoEmenda',
    'Tipo',
    'Modalidade',
    'Natureza',
  )}`.toLowerCase();
  if (/n[aã]o\s*impositiv/.test(txt)) return false;
  return /impositiv|obrigat/.test(txt);
}

/**
 * Normaliza registros do módulo `emendas_parlamentares` / `EmendasParlamentares`.
 *
 * Schema real validado em 2026-05-22: o módulo é, na prática, a lista de
 * EMPENHOS associados a emendas — campos `NroEmpenho`, `Modalidade`,
 * `NomeFornecedor`, `DataEmp`, `ValorEmpenhado`, `ValorLiquidado`, `ValorPago`,
 * `Programa`, `UnidadeOrcamentaria`, `ID`. O portal NÃO expõe número da emenda,
 * autor/vereador, objeto livre, valor previsto nem flag de impositividade.
 * Por isso `numero` usa o nº do empenho, `objeto` aproxima pelo `Programa`,
 * `valorPrevisto` fica 0 (dado ausente — não inventar) e `impositiva` só é true
 * se algum campo explícito aparecer. Aliases extras = defesa de schema.
 */
export function normalizarEmendas(
  brutos: Record<string, unknown>[],
  exercicio: number,
): EmendaNorm[] {
  return brutos.map((rec, idx) => {
    // O portal não publica o valor previsto/destinado da emenda — só o
    // empenhado. Mantém 0 quando o campo não existe: dado ausente, não zero.
    const valorPrevisto = parseValorBR(
      pick(rec, 'ValorEmenda', 'ValorPrevisto', 'ValorDestinado', 'ValorDotacao'),
    );
    const valorEmpenhado = parseValorBR(
      pick(rec, 'ValorEmpenhado', 'ValorEmpenho', 'Valor'),
    );
    return {
      id: String(
        pick(rec, 'ID', 'Id', 'NroEmenda', 'NumeroEmenda', 'NroEmpenho') ??
          `emenda-${exercicio}-${idx}`,
      ),
      numero: pickStr(
        rec,
        'NroEmenda', 'NumeroEmenda', 'Numero', 'Emenda', 'Codigo', 'NroEmpenho',
      ),
      exercicio: Number(pick(rec, 'Exercicio', 'AnoEmenda')) || exercicio,
      autor: pickStr(
        rec,
        'Autor',
        'NomeAutor',
        'Vereador',
        'NomeVereador',
        'Parlamentar',
        'NomeParlamentar',
      ),
      objeto: pickStr(
        rec, 'Objeto', 'Finalidade', 'Destinacao', 'Descricao', 'Evento', 'Programa',
      ),
      beneficiarioNome: pickStr(
        rec,
        'NomeBeneficiario',
        'Beneficiario',
        'NomeEntidade',
        'NomeFornecedor',
        'Entidade',
      ),
      beneficiarioDoc: soDigitos(
        pick(rec, 'CNPJ', 'CPFCNPJ', 'CpfCnpj', 'CnpjBeneficiario'),
      ),
      valorPrevisto,
      valorEmpenhado,
      valorLiquidado: parseValorBR(pick(rec, 'ValorLiquidado', 'ValorLiquidacao')),
      valorPago: parseValorBR(pick(rec, 'ValorPago', 'ValorLiquidoPago')),
      impositiva: inferirImpositiva(rec),
      situacao: pickStr(rec, 'Situacao', 'Status', 'Estagio', 'SituacaoEmenda'),
      data: parseDataBR(
        pick(rec, 'DataEmp', 'DataMovEmp', 'DataEmpenho', 'DataPublicacao', 'DataEmenda', 'Data'),
      ),
      unidadeGestora: pickStr(rec, 'UnidadeOrcamentaria', 'UG', 'UnidadeGestora', 'Orgao'),
    };
  });
}

// ── Coleta agregada ──────────────────────────────────────────────────────────

export interface ColetaTerceiroSetor {
  subvencoes: SubvencaoNorm[];
  emendas: EmendaNorm[];
  coleta: {
    subvencoesRegistros: number;
    emendasRegistros: number;
    erroSubvencoes: string | null;
    erroEmendas: string | null;
  };
}

/**
 * Coleta subvenções e emendas do exercício, varrendo todas as páginas de
 * cada módulo. Falha de um módulo não derruba o outro — cada erro é reportado
 * separadamente para o chamador decidir o status HTTP.
 */
export async function coletarTerceiroSetor(
  exercicio: number,
  opts: { maxPaginas?: number; delayMs?: number } = {},
): Promise<ColetaTerceiroSetor> {
  const { maxPaginas = 100, delayMs = 200 } = opts;

  let subvencoes: SubvencaoNorm[] = [];
  let emendas: EmendaNorm[] = [];
  let erroSubvencoes: string | null = null;
  let erroEmendas: string | null = null;

  try {
    const brutos = await filterModuloAllPages(
      {
        chaveModulo: 'despesas_subvencoes',
        nomeVisao: 'subvencoes',
        exercicio,
        periodicidade: 'ANUAL',
      },
      { maxPaginas, delayMs },
    );
    subvencoes = normalizarSubvencoes(brutos, exercicio);
  } catch (err) {
    erroSubvencoes = err instanceof Error ? err.message : 'erro desconhecido';
  }

  try {
    const brutos = await filterModuloAllPages(
      {
        chaveModulo: 'emendas_parlamentares',
        nomeVisao: 'EmendasParlamentares',
        exercicio,
        periodicidade: 'ANUAL',
      },
      { maxPaginas, delayMs },
    );
    emendas = normalizarEmendas(brutos, exercicio);
  } catch (err) {
    erroEmendas = err instanceof Error ? err.message : 'erro desconhecido';
  }

  return {
    subvencoes,
    emendas,
    coleta: {
      subvencoesRegistros: subvencoes.length,
      emendasRegistros: emendas.length,
      erroSubvencoes,
      erroEmendas,
    },
  };
}
