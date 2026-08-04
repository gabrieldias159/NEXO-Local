/**
 * Detector AN-05 — ANOMALIA EM SÉRIE HISTÓRICA (Z-robusto, 6 anos) — NEXO.
 *
 * Estatística forense de SÉRIE TEMPORAL: para cada "série" (um órgão, ou um par
 * órgão×elemento de despesa) compara o valor empenhado do EXERCÍCIO CORRENTE
 * (`ctx.exercicio`, derivado de `ctx.empenhos`) contra a sua própria história dos
 * anos anteriores (até 6 anos, `ctx.serieHistorica`). O salto/queda é medido por
 * Z-ROBUSTO (mediana + MAD), não pela média/desvio clássicos — porque a média é
 * arrastada justamente pelo ano anômalo que queremos detectar, e a série de
 * orçamento público é curta e cheia de outliers legítimos (ano eleitoral, obra
 * pontual). O escore robusto:
 *
 *     z = 0.6745 * (x − mediana) / MAD,   MAD = mediana(|xi − mediana|)
 *
 * O fator 0.6745 normaliza o MAD para a escala do desvio-padrão sob
 * normalidade (Iglewicz–Hoaglin). |z| ≳ 3.5 é o corte usual de outlier. Quando o
 * MAD é zero (série constante), usa-se um piso baseado na mediana para não
 * dividir por zero nem disparar com variação irrisória.
 *
 * É um INDÍCIO A APURAR, NUNCA acusação. Um salto de gasto tem inúmeras
 * explicações legítimas: nova competência transferida ao órgão, obra/aquisição
 * pontual, recomposição inflacionária represada, mudança de classificação
 * contábil. Classificação no MÁXIMO 'atencao'. Convém confrontar com o
 * planejamento (LOA/LDO) e o objeto dos empenhos do ano.
 *
 * Sem `ctx.serieHistorica` (a infra de histórico ainda não foi anexada pelo
 * orquestrador), o detector degrada para [] honestamente — nunca um falso
 * negativo silencioso, nunca um número inventado. Não usa fonte nova: a série é
 * a própria base de empenhos dos exercícios já coletados.
 */
import { formatBRL } from '../normalizar';
import type {
  AlertaDetectado,
  ContextoAnalise,
  Detector,
  Evidencia,
} from './tipos';

const CATEGORIA = 'Anomalia estatística';

/** Constante de normalização do MAD para a escala do desvio (Iglewicz–Hoaglin). */
const K_MAD = 0.6745;
/** Corte de outlier no Z-robusto (|z| acima disto = anômalo). */
const CORTE_Z = 3.5;
/** Mínimo de anos de história (além do corrente) para a estatística ter sentido. */
const MIN_ANOS_HISTORIA = 3;
/** Janela máxima de história considerada (anos anteriores ao corrente). */
const MAX_ANOS = 6;
/** Piso de variação relativa quando o MAD é ~0 (série constante) — evita ruído. */
const PISO_VARIACAO_REL = 0.25; // 25%
/** Valor mínimo (R$) do ponto corrente para valer um alerta (corta migalha). */
const VALOR_MINIMO = 50_000;

/**
 * Ponto anual de UMA série: o total empenhado naquele órgão (ou órgão×elemento)
 * naquele exercício. O ORQUESTRADOR monta isto a partir das bases de empenho dos
 * exercícios já coletados (sem fonte nova) e anexa em `ctx.serieHistorica`.
 */
export interface PontoSerieAnual {
  /** Identificador estável da série (ex.: órgão, ou `orgao|elemento`). */
  serieId: string;
  /** Rótulo legível da série (nome do órgão / objeto). */
  rotulo: string;
  /** Exercício do ponto. */
  exercicio: number;
  /** Total empenhado da série naquele exercício (R$). */
  valor: number;
}

/**
 * Shim de FORWARD-COMPATIBILIDADE. O orquestrador ainda vai adicionar
 * `serieHistorica?: PontoSerieAnual[]` a `ContextoAnalise` (tipos.ts). Até lá,
 * este alias declara o campo OPCIONAL que CONSUMIMOS, sem editar tipos.ts e sem
 * quebrar o build. Quando entrar no tipo oficial, o `&` é inócuo — basta apagar.
 * COMO FIAR: orquestrador agrega os empenhos dos últimos ~6 exercícios por órgão
 * (e/ou órgão×elemento), produz um `PontoSerieAnual` por (série, ano) e popula
 * `ctx.serieHistorica`. O exercício corrente já está em `ctx.exercicio`.
 */
type ContextoComSerie = ContextoAnalise & {
  serieHistorica?: PontoSerieAnual[];
};

/** Mediana de uma lista NÃO vazia (ordena uma cópia). */
function mediana(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  const m = Math.floor(n / 2);
  return n % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

/**
 * Z-robusto (Iglewicz–Hoaglin) de `x` contra a base `hist`. Retorna `null`
 * quando não há base suficiente. Quando o MAD é ~0 (série praticamente
 * constante), cai num critério de variação relativa contra a mediana — um salto
 * grande sobre uma série estável É anômalo, mas evitamos disparar por centavos.
 */
export function zRobusto(
  x: number,
  hist: number[],
): { z: number; medianaHist: number; mad: number; modo: 'mad' | 'relativo' } | null {
  if (hist.length < MIN_ANOS_HISTORIA) return null;
  const med = mediana(hist);
  const mad = mediana(hist.map((h) => Math.abs(h - med)));
  if (mad > 1e-9) {
    return { z: (K_MAD * (x - med)) / mad, medianaHist: med, mad, modo: 'mad' };
  }
  // MAD ≈ 0 → série constante. Mede variação relativa contra a mediana.
  const base = Math.max(Math.abs(med), 1);
  const varRel = (x - med) / base;
  // Mapeia a variação relativa para um pseudo-z só p/ comparar com o corte:
  // |varRel| acima do piso vira um z ≥ corte proporcional ao excesso.
  const z =
    Math.abs(varRel) <= PISO_VARIACAO_REL
      ? 0
      : Math.sign(varRel) * (CORTE_Z + (Math.abs(varRel) - PISO_VARIACAO_REL) * 4);
  return { z, medianaHist: med, mad: 0, modo: 'relativo' };
}

interface SerieAgrupada {
  serieId: string;
  rotulo: string;
  /** ano → valor (último valor vence se houver duplicata no mesmo ano). */
  porAno: Map<number, number>;
}

/** Agrupa os pontos por série e por ano. */
function agruparSeries(pontos: PontoSerieAnual[]): Map<string, SerieAgrupada> {
  const por = new Map<string, SerieAgrupada>();
  for (const p of pontos) {
    if (!p.serieId) continue;
    const cur = por.get(p.serieId);
    if (cur) {
      cur.porAno.set(p.exercicio, p.valor);
      if (!cur.rotulo && p.rotulo) cur.rotulo = p.rotulo;
    } else {
      por.set(p.serieId, {
        serieId: p.serieId,
        rotulo: p.rotulo || p.serieId,
        porAno: new Map([[p.exercicio, p.valor]]),
      });
    }
  }
  return por;
}

/**
 * Núcleo testável do AN-05. Recebe a série histórica já montada e o exercício
 * corrente; para cada série com história suficiente, calcula o Z-robusto do ano
 * corrente e emite 1 alerta 'atencao' quando |z| ≥ corte e o valor é material.
 * Ordenado por |z| desc (maior anomalia primeiro). NÃO inventa pontos faltantes.
 */
export function analisarAnomaliaSerie(input: {
  exercicio: number;
  serieHistorica: PontoSerieAnual[];
}): AlertaDetectado[] {
  const { exercicio } = input;
  if (!exercicio) return [];
  const series = agruparSeries(input.serieHistorica);
  if (series.size === 0) return [];

  const out: { alerta: AlertaDetectado; absZ: number }[] = [];

  for (const s of series.values()) {
    const xCorr = s.porAno.get(exercicio);
    if (xCorr == null) continue; // sem ponto do ano corrente nesta série
    if (Math.abs(xCorr) < VALOR_MINIMO) continue; // corta migalha

    // História = anos ANTERIORES ao corrente, dentro da janela de MAX_ANOS.
    const anosHist = [...s.porAno.keys()]
      .filter((a) => a < exercicio && a >= exercicio - MAX_ANOS)
      .sort((a, b) => a - b);
    const hist = anosHist.map((a) => s.porAno.get(a) as number);

    const r = zRobusto(xCorr, hist);
    if (!r) continue;
    if (Math.abs(r.z) < CORTE_Z) continue;

    const sentido = r.z > 0 ? 'salto' : 'queda';
    const variacao =
      r.medianaHist !== 0
        ? ((xCorr - r.medianaHist) / Math.abs(r.medianaHist)) * 100
        : null;

    const evidencias: Evidencia[] = [
      {
        resumo:
          `Empenhado em ${exercicio}: ${formatBRL(xCorr)} — ${sentido} frente à ` +
          `mediana histórica de ${formatBRL(r.medianaHist)} ` +
          `(${anosHist.length} ano(s): ${anosHist.join(', ')})` +
          (variacao != null ? ` · ${variacao >= 0 ? '+' : ''}${variacao.toFixed(0)}%` : ''),
        valor: xCorr,
        data: `${exercicio}-12-31`,
        ref: 'SMARAPD',
      },
      ...anosHist.slice(-MAX_ANOS).map((a) => ({
        resumo: `${a}: ${formatBRL(s.porAno.get(a) as number)}`,
        valor: s.porAno.get(a) as number,
        data: `${a}-12-31`,
        ref: 'SMARAPD',
      })),
      {
        resumo:
          `Z-robusto (mediana+MAD, Iglewicz–Hoaglin): z=${r.z.toFixed(2)} ` +
          `(corte ${CORTE_Z}; modo ${r.modo === 'mad' ? 'MAD' : 'variação relativa (série constante)'}). ` +
          'Indício estatístico a apurar — não é, por si, irregularidade.',
        data: null,
        ref: 'AN-05',
      },
    ];

    out.push({
      absZ: Math.abs(r.z),
      alerta: {
        detectorId: 'AN-05',
        detectorNome: 'Anomalia em série histórica (Z-robusto, 6 anos)',
        categoria: CATEGORIA,
        titulo:
          `${sentido === 'salto' ? 'Salto' : 'Queda'} atípico de gasto em ${exercicio} — ${s.rotulo}`,
        descricao:
          `O empenho de ${s.rotulo} em ${exercicio} (${formatBRL(xCorr)}) destoa ` +
          `da própria série histórica (mediana ${formatBRL(r.medianaHist)} em ` +
          `${anosHist.length} ano(s) anteriores): Z-robusto ${r.z.toFixed(2)}, ` +
          `acima do corte ${CORTE_Z}. É um INDÍCIO ESTATÍSTICO A APURAR, não uma ` +
          'irregularidade. Saltos têm causas legítimas (nova competência, obra ' +
          'pontual, recomposição represada, reclassificação contábil). Convém ' +
          'confrontar com o planejamento (LOA/LDO) e o objeto dos empenhos.',
        sujeitoTipo: 'orgao',
        sujeitoId: s.serieId,
        sujeitoRotulo: s.rotulo,
        // Teto: 'atencao'. Anomalia estatística é sinal, nunca prova.
        classificacao: 'atencao',
        scores: {
          // Dado oficial (empenho), método robusto e transparente — confiabilidade
          // do CÁLCULO é boa; a probabilidade de IRREGULARIDADE é incerta (variação
          // de gasto é frequentemente legítima), por isso mediana-baixa.
          confiabilidade: 70,
          probabilidadeIrregularidade: 35,
        },
        fundamentoLegal: [
          'LRF LC 101/2000 (planejamento/transparência)',
          'CF art.37 (eficiência/economicidade)',
        ],
        evidencias,
        explicacao:
          'O gasto do órgão neste exercício foge da sua própria história recente, ' +
          'medido por Z-robusto (mediana + MAD) — escala que resiste a outliers e ' +
          'a séries curtas, ao contrário da média/desvio clássicos (que o próprio ' +
          'ano anômalo distorceria). É um SINAL ESTATÍSTICO a verificar, jamais ' +
          'uma acusação: variações fortes de empenho têm explicações legítimas ' +
          'frequentes (transferência de competência, obra ou aquisição pontual, ' +
          'recomposição inflacionária represada, mudança de classificação ' +
          'orçamentária). Convém confrontar o salto/queda com o planejamento ' +
          '(LOA/LDO) e com o objeto dos empenhos do ano. Requer análise humana.',
        valorEnvolvido: Math.abs(xCorr - r.medianaHist),
        discriminador: `an05:${s.serieId}:${exercicio}`,
      },
    });
  }

  return out.sort((a, b) => b.absZ - a.absZ).map((o) => o.alerta);
}

/**
 * Detector AN-05 no formato do pipeline (`rodarDetectores`). Degrada para []
 * honestamente quando a série histórica não foi anexada ao contexto (infra de
 * histórico inativa) — nunca um falso negativo silencioso nem número inventado.
 */
export const detectorAnomaliaSerie: Detector = {
  id: 'AN-05',
  nome: 'Anomalia em série histórica (Z-robusto, 6 anos)',
  categoria: CATEGORIA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const serie = (ctx as ContextoComSerie).serieHistorica ?? [];
    if (serie.length === 0) return []; // infra de histórico não anexada
    if (!ctx.exercicio) return [];
    return analisarAnomaliaSerie({
      exercicio: ctx.exercicio,
      serieHistorica: serie,
    });
  },
};
