/**
 * NEXO — Conector do Diário Oficial de Marília (DOM).
 *
 * Lê as edições do DOM direto da API de dados-abertos da Prefeitura — a mesma
 * fonte primária usada por `/api/diario-oficial/recent`. Replica a estratégia
 * de fonte server-side: `listGazettesByYear` busca TODAS as edições de um ano
 * em um único JSON (com texto integral), sem lag e sem OCR.
 *
 * Aqui só os METADADOS das edições nos interessam — ano, número, data, se é
 * extra e o tamanho do texto. O texto integral é descartado para manter o
 * payload do NEXO enxuto; o parsing profundo de cada ato (DO-02, DO-04..DO-08)
 * fica como pendência documentada no detector.
 *
 * Usado por `/api/nexo/diario-sinais`.
 */
import {
  listGazettesByYear,
  parseDadosAbertosDate,
  type DadosAbertosGazette,
} from '@/lib/diario/marilia-dados-abertos-client';

/** Edição do DOM normalizada — só metadados, sem texto integral. */
export interface EdicaoDiarioNorm {
  /** ID canônico `${ano}_${edicao}`. */
  id: string;
  /** Ano de publicação (derivado da data, não confiando no parâmetro). */
  ano: number;
  /** Número da edição (string numérica original). */
  edicao: string;
  /** Número da edição como inteiro, ou null se não-numérico. */
  edicaoNum: number | null;
  /** Data/hora de publicação no formato original `YYYY-MM-DD HH:mm:ss`. */
  data: string;
  /** Instante de publicação em ISO 8601 (UTC). */
  dataIso: string;
  /** Dia da semana 0=domingo … 6=sábado (horário de São Paulo). */
  diaSemana: number;
  /** true quando publicada em sábado ou domingo. */
  fimDeSemana: boolean;
  /** true para edições extras/suplementares. */
  edicaoExtra: boolean;
  /**
   * Tamanho do texto integral em caracteres. Proxy de volume de atos da
   * edição — não há contagem de matérias estruturada na fonte, então o
   * detector DO-03 usa este número como aproximação defensiva.
   */
  textChars: number;
}

/**
 * Edição com o TEXTO INTEGRAL preservado — usada pelos detectores que fazem
 * parsing dos atos (DO-02, DO-04..DO-08). É um superconjunto de
 * `EdicaoDiarioNorm`; o campo `texto` traz a `descricao` crua da fonte.
 */
export interface EdicaoDiarioTexto extends EdicaoDiarioNorm {
  /** Texto integral da edição (campo `descricao` dos dados-abertos). */
  texto: string;
}

/** Resultado da coleta de edições do DOM. */
export interface ColetaDiario {
  edicoes: EdicaoDiarioNorm[];
  /** Anos efetivamente consultados na fonte. */
  anosConsultados: number[];
  /** true quando a coleta veio de uma janela parcial (algum ano falhou). */
  amostra: boolean;
  /** Mensagem de erro da fonte, ou null se a coleta foi completa. */
  erro: string | null;
}

/**
 * Normaliza defensivamente uma edição bruta de dados-abertos.
 * Retorna null quando a edição não tem data parseável — registro descartado.
 */
function normalizarEdicao(g: DadosAbertosGazette): EdicaoDiarioNorm | null {
  if (!g || typeof g.data !== 'string' || !g.data.trim()) return null;

  let date: Date;
  try {
    date = parseDadosAbertosDate(g.data);
  } catch {
    return null;
  }
  if (Number.isNaN(date.getTime())) return null;

  const ano = date.getFullYear();
  const edicao = String(g.edicao ?? '').trim();
  if (!edicao) return null;

  const edicaoNum = /^\d+$/.test(edicao) ? Number(edicao) : null;
  // getUTCDay porque parseDadosAbertosDate já devolve o instante UTC correto
  // do horário de São Paulo — getDay() reaplicaria o offset do servidor.
  const diaSemana = date.getUTCDay();

  return {
    id: `${ano}_${edicao}`,
    ano,
    edicao,
    edicaoNum,
    data: g.data,
    dataIso: date.toISOString(),
    diaSemana,
    fimDeSemana: diaSemana === 0 || diaSemana === 6,
    edicaoExtra: g.edicaoExtra === 'S',
    textChars: typeof g.descricao === 'string' ? g.descricao.length : 0,
  };
}

/**
 * Coleta as edições do DOM de um exercício, normalizadas.
 *
 * Para dar base estatística ao DO-03 (volume anormal), também puxa o ano
 * anterior — assim a média/desvio não fica refém de poucas edições no início
 * do ano. A flag `amostra` sinaliza quando algum ano falhou na fonte.
 */
export async function coletarEdicoesDiario(
  exercicio: number,
  opts: { incluirAnoAnterior?: boolean } = {},
): Promise<ColetaDiario> {
  const incluirAnoAnterior = opts.incluirAnoAnterior ?? true;
  const anos = incluirAnoAnterior ? [exercicio, exercicio - 1] : [exercicio];

  const edicoes: EdicaoDiarioNorm[] = [];
  const anosConsultados: number[] = [];
  let erro: string | null = null;
  let amostra = false;

  for (const ano of anos) {
    try {
      const brutas = await listGazettesByYear(ano);
      anosConsultados.push(ano);
      for (const g of brutas) {
        const n = normalizarEdicao(g);
        if (n) edicoes.push(n);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'erro desconhecido';
      // O exercício-alvo é obrigatório; o ano anterior é só base estatística.
      if (ano === exercicio) {
        erro = msg;
      } else {
        amostra = true;
      }
    }
  }

  // Falha total do exercício-alvo — a coleta inteira é considerada amostra.
  if (anosConsultados.length === 0) amostra = true;

  edicoes.sort((a, b) => b.dataIso.localeCompare(a.dataIso));

  return { edicoes, anosConsultados, amostra, erro };
}

/** Resultado da coleta de edições do DOM COM o texto integral preservado. */
export interface ColetaDiarioTexto {
  edicoes: EdicaoDiarioTexto[];
  anosConsultados: number[];
  amostra: boolean;
  erro: string | null;
}

/**
 * Coleta as edições de UM exercício do DOM mantendo o texto integral de cada
 * edição — base dos detectores de parsing de atos (DO-02, DO-04..DO-08).
 *
 * Diferente de `coletarEdicoesDiario`, NÃO puxa o ano anterior: os detectores
 * de ato olham apenas o exercício consultado. O payload é mais pesado (texto
 * integral), por isso a função é chamada só pela rota diario-sinais e o texto
 * nunca é serializado de volta ao cliente.
 */
export async function coletarTextosDiario(
  exercicio: number,
): Promise<ColetaDiarioTexto> {
  const edicoes: EdicaoDiarioTexto[] = [];
  const anosConsultados: number[] = [];
  let erro: string | null = null;

  try {
    const brutas = await listGazettesByYear(exercicio);
    anosConsultados.push(exercicio);
    for (const g of brutas) {
      const n = normalizarEdicao(g);
      if (!n) continue;
      edicoes.push({
        ...n,
        texto: typeof g.descricao === 'string' ? g.descricao : '',
      });
    }
  } catch (err) {
    erro = err instanceof Error ? err.message : 'erro desconhecido';
  }

  edicoes.sort((a, b) => b.dataIso.localeCompare(a.dataIso));

  return {
    edicoes,
    anosConsultados,
    amostra: anosConsultados.length === 0,
    erro,
  };
}
