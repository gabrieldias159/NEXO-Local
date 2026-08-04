/**
 * Conector da RECEITA — módulo `balancetereceita` / visão `Arrecadacoes` do
 * SMARAPD (receita por conta/mês: previsão e arrecadado).
 *
 * USO SERVER-SIDE APENAS — ver observações em `sources/smarapd.ts`. Chamar
 * sempre de API routes (`/api/nexo/*`).
 *
 * ── Schema real da API (validado em 2026-05-22) ──────────────────────────────
 * Cada registro de `balancetereceita`/`Arrecadacoes` é UMA conta de receita no
 * exercício, com a arrecadação aberta em 12 COLUNAS mensais — não em uma linha
 * por mês. Campos confirmados por chamada real ao portal:
 *   NaturezaReceita  — código da conta (ex.: "1.1.1.4.51.1.1.00.00")
 *   Janeiro … Dezembro — valor arrecadado de cada mês ("9.999,99")
 *   TotalArrecadado  — soma anual do arrecadado
 *   TotalPrevisto    — previsão da LOA para a conta
 *   ID, Id           — identificadores internos
 * NÃO existe campo de descrição da rubrica nem campo `Mes`/`Conta`. A descrição
 * legível (`DescricaoReceita`) só está no módulo `folha_pagamento_detalhes`/
 * `ReceitaAnalitica` — coletada à parte e cruzada por `NaturezaReceita`.
 *
 * Este conector "explode" cada registro em 13 `ReceitaNorm`: 12 mensais (mes
 * 1–12, carregando só o arrecadado do mês) + 1 anual (mes 0, carregando só o
 * previsto). Essa separação evita dupla contagem quando a rota e os detectores
 * somam `previsto`/`arrecadado` por conta.
 *
 * O módulo só tem dados a partir de 2026 (`balancetereceita` foi disponibilizado
 * pelo portal nesse exercício); exercícios anteriores retornam vazio — o que é
 * tratado como "sem dados publicados", não como falha de coleta.
 */
import { filterModuloAllPages } from './smarapd';
import { parseValorBR } from '../normalizar';

/** Um registro de receita normalizado — uma conta de receita num mês. */
export interface ReceitaNorm {
  /** Código da conta/rubrica de receita (ex.: "1.1.1.3.03.1.1"). */
  conta: string;
  /** Descrição da rubrica de receita. */
  descricao: string;
  /** Mês de competência (1–12), ou 0 quando o registro é um total anual. */
  mes: number;
  exercicio: number;
  /** Valor previsto/orçado para a rubrica (LOA), quando informado. */
  previsto: number;
  /** Valor efetivamente arrecadado/realizado no período. */
  arrecadado: number;
  /** Família da receita inferida da descrição/conta — usada nos detectores. */
  familia: ReceitaFamilia;
}

export type ReceitaFamilia =
  | 'tributaria'
  | 'transferencia'
  | 'contribuicao'
  | 'patrimonial'
  | 'servicos'
  | 'divida-ativa'
  | 'outras';

/** Resultado da coleta — registros + metadados de diagnóstico. */
export interface ColetaReceita {
  registros: ReceitaNorm[];
  totalBrutos: number;
  erro: string | null;
}

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

/**
 * Converte um valor de mês cru (número, nome ou "01") para 1–12.
 * Retorna 0 quando não é parseável (registro de total anual, p.ex.).
 */
const MESES_PT: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, 'março': 3, abril: 4, maio: 5,
  junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10,
  novembro: 11, dezembro: 12,
};

function parseMes(v: unknown): number {
  if (typeof v === 'number') return v >= 1 && v <= 12 ? Math.trunc(v) : 0;
  if (typeof v !== 'string') return 0;
  const s = v.trim().toLowerCase();
  if (!s) return 0;
  const nome = MESES_PT[s];
  if (nome) return nome;
  const n = Number(s.replace(/\D/g, ''));
  return Number.isFinite(n) && n >= 1 && n <= 12 ? n : 0;
}

/** Infere a família da receita a partir da conta e da descrição. */
export function classificarFamilia(conta: string, descricao: string): ReceitaFamilia {
  const t = `${conta} ${descricao}`.toLowerCase();
  if (/d[ií]vida\s+ativa/.test(t)) return 'divida-ativa';
  if (/transfer[êe]nci|fpm|cota.?parte|icms|fundeb|conv[êe]nio|sus\b/.test(t)) {
    return 'transferencia';
  }
  if (/contribui[çc]/.test(t)) return 'contribuicao';
  if (/patrimonial|aluguel|juros|rendiment|dividendo/.test(t)) return 'patrimonial';
  if (/servi[çc]o/.test(t)) return 'servicos';
  if (/tribut|imposto|\biss\b|\biptu\b|\bitbi\b|\birrf\b|taxa/.test(t)) {
    return 'tributaria';
  }
  // Receita corrente cujo código começa em "1.1" costuma ser tributária.
  if (/^1\.1\b/.test(conta.trim())) return 'tributaria';
  if (/^1\.7\b/.test(conta.trim())) return 'transferencia';
  return 'outras';
}

/** Colunas mensais do registro de `balancetereceita`, na ordem 1–12. */
const COLUNAS_MES: readonly string[] = [
  'Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

/** Projeção de campos para leitura otimizada de `nexo_receita` no Firestore. */
export const CAMPOS_RECEITA: string[] = [
  'NaturezaReceita', 'Conta', 'CodigoReceita', 'CodReceita', 'Rubrica', 'ContaReceita',
  'DescricaoReceita', 'Descricao', 'DescricaoConta', 'NomeConta', 'Especificacao', 'Receita',
  'Exercicio', 'Ano', 'TotalPrevisto', 'ValorPrevisto',
  ...COLUNAS_MES,
  '_coletadoEm',
];

/**
 * Normaliza registros crus do módulo `balancetereceita` para `ReceitaNorm`.
 *
 * Cada registro vira ATÉ 13 `ReceitaNorm`:
 *  - até 12 mensais (mes 1–12) — só meses com arrecadação > 0; carregam o
 *    arrecadado do mês e `previsto: 0`;
 *  - 1 anual (mes 0) — carrega `previsto` (TotalPrevisto da LOA) e
 *    `arrecadado: 0`, emitido quando há previsão.
 *
 * Manter `previsto` e `arrecadado` em registros distintos evita dupla contagem:
 * somar `arrecadado` por conta dá o total mensal; somar `previsto` dá a LOA.
 *
 * O parâmetro `descricoes` mapeia `NaturezaReceita` → descrição legível (vinda
 * do módulo `ReceitaAnalitica`); quando ausente, a descrição fica vazia e a UI
 * exibe o código da conta.
 *
 * Defensivo: além do schema `balancetereceita`, ainda reconhece o formato
 * antigo (linha por mês, campos `Conta`/`Mes`/`ValorArrecadado`) via aliases —
 * assim uma mudança de schema do portal não zera a página sem aviso.
 */
export function normalizarReceitas(
  brutos: Record<string, unknown>[],
  exercicio: number,
  descricoes?: Map<string, string>,
): ReceitaNorm[] {
  const out: ReceitaNorm[] = [];

  for (const rec of brutos) {
    const conta = pickStr(
      rec,
      'NaturezaReceita', 'Conta', 'CodigoReceita', 'CodReceita', 'Codigo',
      'Rubrica', 'ContaReceita', 'CodigoConta',
    );
    // Descrição: ou vem do cruzamento com ReceitaAnalitica, ou de um campo
    // textual do próprio registro (schemas alternativos), ou fica vazia.
    const descricao =
      (conta && descricoes?.get(conta)) ||
      pickStr(
        rec,
        'DescricaoReceita', 'Descricao', 'DescricaoConta', 'NomeConta',
        'Especificacao', 'Receita',
      );
    const anoRec = Number(pick(rec, 'Exercicio', 'Ano')) || exercicio;
    const familia = classificarFamilia(conta, descricao);

    // Detecta o schema `balancetereceita`: 12 colunas mensais nomeadas.
    const temColunasMensais = COLUNAS_MES.some((m) => rec[m] !== undefined);

    if (temColunasMensais) {
      if (!conta) continue;
      // Registro anual: carrega só a previsão da LOA.
      const previsto = parseValorBR(pick(rec, 'TotalPrevisto', 'ValorPrevisto'));
      if (previsto !== 0) {
        out.push({
          conta, descricao, mes: 0, exercicio: anoRec,
          previsto, arrecadado: 0, familia,
        });
      }
      // Registros mensais: cada coluna com arrecadação > 0 vira um ReceitaNorm.
      COLUNAS_MES.forEach((nomeMes, idx) => {
        const arrecadado = parseValorBR(rec[nomeMes]);
        if (arrecadado === 0) return;
        out.push({
          conta, descricao, mes: idx + 1, exercicio: anoRec,
          previsto: 0, arrecadado, familia,
        });
      });
      continue;
    }

    // Schema alternativo/legado: uma linha por mês com valores próprios.
    const mes = parseMes(
      pick(rec, 'Mes', 'MesReferencia', 'MesArrecadacao', 'NomeMes', 'Competencia'),
    );
    const previsto = parseValorBR(
      pick(
        rec,
        'ValorPrevisto', 'Previsto', 'Previsao', 'ValorOrcado', 'Orcado',
        'PrevisaoAtualizada', 'PrevisaoInicial', 'TotalPrevisto',
      ),
    );
    const arrecadado = parseValorBR(
      pick(
        rec,
        'ValorArrecadado', 'Arrecadado', 'ValorRealizado', 'Realizado',
        'ValorArrecadacao', 'Arrecadacao', 'ValorReceita', 'Valor',
        'TotalArrecadado',
      ),
    );
    if ((conta || descricao) && (previsto !== 0 || arrecadado !== 0)) {
      out.push({ conta, descricao, mes, exercicio: anoRec, previsto, arrecadado, familia });
    }
  }

  return out;
}

/**
 * Coleta o mapa `NaturezaReceita` → descrição legível do módulo
 * `folha_pagamento_detalhes`/`ReceitaAnalitica`. É best-effort: se falhar,
 * devolve mapa vazio e a página exibe os códigos de conta — nunca derruba a
 * coleta principal da receita.
 */
async function coletarDescricoesReceita(
  exercicio: number,
  opts: { maxPaginas?: number; delayMs?: number },
): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  try {
    const brutos = await filterModuloAllPages(
      {
        chaveModulo: 'folha_pagamento_detalhes',
        nomeVisao: 'ReceitaAnalitica',
        exercicio,
        periodicidade: 'ANUAL',
        quantidadeRegistros: 500,
      },
      { maxPaginas: opts.maxPaginas ?? 30, delayMs: opts.delayMs ?? 120 },
    );
    for (const rec of brutos) {
      const conta = pickStr(rec, 'NaturezaReceita', 'Conta', 'CodigoReceita');
      const desc = pickStr(rec, 'DescricaoReceita', 'Descricao');
      if (conta && desc && !mapa.has(conta)) mapa.set(conta, desc);
    }
  } catch {
    // Enriquecimento opcional — silencioso. A receita funciona sem descrição.
  }
  return mapa;
}

/**
 * Coleta a receita por conta/mês do exercício no SMARAPD.
 * Nunca lança — devolve `{ erro }` para a rota decidir o status HTTP.
 */
export async function coletarReceita(
  exercicio: number,
  opts: { maxPaginas?: number; delayMs?: number } = {},
): Promise<ColetaReceita> {
  const { maxPaginas = 40, delayMs = 120 } = opts;
  try {
    const brutos = await filterModuloAllPages(
      {
        chaveModulo: 'balancetereceita',
        nomeVisao: 'Arrecadacoes',
        exercicio,
        periodicidade: 'ANUAL',
        quantidadeRegistros: 500,
      },
      { maxPaginas, delayMs },
    );
    // Cruza as descrições legíveis só quando há receita a descrever — evita
    // varrer o módulo analítico (grande) à toa em exercícios sem dados.
    const descricoes =
      brutos.length > 0
        ? await coletarDescricoesReceita(exercicio, { delayMs })
        : new Map<string, string>();
    return {
      registros: normalizarReceitas(brutos, exercicio, descricoes),
      totalBrutos: brutos.length,
      erro: null,
    };
  } catch (err) {
    return {
      registros: [],
      totalBrutos: 0,
      erro: err instanceof Error ? err.message : 'erro desconhecido',
    };
  }
}

/** Total arrecadado de uma lista de receitas. */
export function somaArrecadado(receitas: ReceitaNorm[]): number {
  return receitas.reduce((s, r) => s + r.arrecadado, 0);
}

/** Total previsto de uma lista de receitas. */
export function somaPrevisto(receitas: ReceitaNorm[]): number {
  return receitas.reduce((s, r) => s + r.previsto, 0);
}
