/**
 * Detector estatístico AN-01 — Outlier de preço por elemento/objeto.
 *
 * Agrupa as despesas (módulo DespesaAgrupada, com objeto/elemento) por chave
 * de natureza (elemento + objeto) e, dentro de cada grupo homogêneo, mede o
 * escore modificado de Iglewicz–Hoaglin (mediana + MAD) de cada despesa. Itens
 * com |Z| > 3.5 são possível indício de sobrepreço/atipicidade A APURAR — nunca
 * acusação: um valor alto pode refletir item legítimo (quantidade maior,
 * especificação diferente) ou lacuna de dados.
 *
 * POR QUE robusto (mediana+MAD) e não média±σ: ver src/lib/nexo/estatistica/
 * robusto.ts — o próprio outlier contamina média/σ (mascaramento). Reusa
 * `avaliarOutlier` daquele módulo, não reinventa a estatística.
 *
 * Degrada honestamente: sem ctx.despesas (ou grupos pequenos) → retorna [].
 */
import { formatBRL, type DespesaNorm } from '../normalizar';
import { ehEntidadePublica } from '../entidades';
import { avaliarOutlier } from '../estatistica/robusto';
import { OBJETOS_GENERICOS } from '../calibragem';
import type { AlertaDetectado, Classificacao, Detector } from './tipos';

/** Mínimo de itens no grupo para a estatística robusta ter sentido. */
const MIN_GRUPO = 8;
/** Limiar canônico de Iglewicz–Hoaglin (modified z-score). */
const LIMIAR = 3.5;
/** Piso de valor para não sinalizar ruído de centavos. */
const VALOR_MINIMO = 5_000;
/** Mín. de valores DISTINTOS no grupo — evita MAD=0 degenerado (z-score ∞ espúrio). */
const MIN_DISTINTOS = 5;
/** Teto de alertas por execução — AN-01 sozinho chegava a ~42% do backlog. */
const TOP_K = 60;

/** Normaliza um texto para compor a chave de agrupamento (sem acentos/caixa). */
function chaveTexto(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export const detectorOutlierPreco: Detector = {
  id: 'AN-01',
  nome: 'Outlier de preço por elemento/objeto',
  categoria: 'Anomalia estatística',

  detectar(ctx): AlertaDetectado[] {
    // Degrada honestamente: sem o módulo de despesas, sem agrupamento por objeto.
    if (!Array.isArray(ctx.despesas) || ctx.despesas.length === 0) return [];

    const out: AlertaDetectado[] = [];

    // Agrupa por (elemento + objeto) — grupo homogêneo de mesma natureza.
    const grupos = new Map<string, DespesaNorm[]>();
    for (const d of ctx.despesas) {
      const valor = Math.abs(d.valorEmpenhado);
      if (valor <= 0) continue;
      // Reforço/anulação distorcem a distribuição de preço unitário — ignora.
      if (/REFOR|ANUL/i.test(d.tipoEmpenho)) continue;
      const elemento = chaveTexto(d.elemento);
      const objeto = chaveTexto(d.objeto);
      if (!elemento && !objeto) continue;
      // Objeto genérico/catch-all (ex.: "Geral") agrupa naturezas distintas →
      // comparação de preço inválida (falso positivo em massa). Pula.
      if (OBJETOS_GENERICOS.has(objeto)) continue;
      const chave = `${elemento}||${objeto}`;
      const arr = grupos.get(chave) ?? [];
      arr.push(d);
      grupos.set(chave, arr);
    }

    for (const [, lista] of grupos) {
      if (lista.length < MIN_GRUPO) continue;
      const valores = lista.map((d) => Math.abs(d.valorEmpenhado));
      // Grupo quase-constante (poucos valores distintos) → MAD≈0 → z-score ∞
      // espúrio (qualquer valor diferente vira "outlier"). Pula.
      if (new Set(valores).size < MIN_DISTINTOS) continue;

      for (const d of lista) {
        const valor = Math.abs(d.valorEmpenhado);
        if (valor < VALOR_MINIMO) continue;
        // Ente público (repasse intra-governamental) não vira alerta de preço.
        if (ehEntidadePublica(d.cpfCnpj, d.fornecedorNome)) continue;

        const res = avaliarOutlier(valor, valores, LIMIAR);
        // Só flaga outlier POR CIMA (sobrepreço) — escore positivo E FINITO
        // (MAD=0 produz ∞, que era contado como 99 e gerava falso positivo).
        if (!res.outlier || res.escore <= 0 || !Number.isFinite(res.escore)) continue;

        const med = res.mediana;
        const razao = med > 0 ? valor / med : Infinity;
        const escoreAbs = Number.isFinite(res.escore) ? Math.abs(res.escore) : 99;

        // Severidade por magnitude — teto em 'suspeita' (estatística não acusa).
        const classificacao: Classificacao =
          escoreAbs >= 7 || razao >= 4 ? 'suspeita' : 'atencao';

        const elementoRot = d.elemento || '(sem elemento)';
        const objetoRot = d.objeto || '(sem objeto)';
        const nome = d.fornecedorNome || d.cpfCnpj || 'fornecedor não identificado';

        out.push({
          detectorId: 'AN-01',
          detectorNome: 'Outlier de preço por elemento/objeto',
          categoria: 'Anomalia estatística',
          titulo: `Valor atípico em "${objetoRot}" — possível indício a apurar`,
          descricao:
            `Despesa de ${formatBRL(valor)} destoa do padrão do grupo ` +
            `"${elementoRot}" (mediana ${formatBRL(med)}; ${lista.length} itens). ` +
            `Escore robusto |Z|=${escoreAbs.toFixed(1)} (corte ${LIMIAR}). ` +
            `Possível indício a apurar.`,
          sujeitoTipo: 'empenho',
          sujeitoId: d.numeroEmpenho || d.id,
          sujeitoRotulo: `Empenho ${d.numeroEmpenho || d.id} — ${nome}`,
          classificacao,
          scores: {
            confiabilidade: ctx.amostra ? 55 : 70,
            probabilidadeIrregularidade: Math.min(72, 35 + Math.round(escoreAbs * 4)),
          },
          fundamentoLegal: [
            'Lei 14.133/2021, art. 23 (pesquisa de preços / preço de referência)',
          ],
          evidencias: [
            {
              resumo: `Valor da despesa: ${formatBRL(valor)}${d.objeto ? ` (${d.objeto})` : ''}`,
              valor,
              data: d.data,
            },
            {
              resumo:
                `Mediana do grupo "${elementoRot}": ${formatBRL(med)} ` +
                `(${razao === Infinity ? '∞' : `${razao.toFixed(1)}×`} a mediana)`,
              valor: med,
            },
          ],
          explicacao:
            'O escore modificado de Iglewicz–Hoaglin (mediana + MAD) é resistente a ' +
            'mascaramento por outliers, ao contrário de média±desvio-padrão. Um valor ' +
            'muito acima da mediana de itens da mesma natureza é possível indício de ' +
            'sobrepreço A APURAR — pode também refletir quantidade/especificação ' +
            'diferente, item agrupado ou lacuna de dados. Verificar a pesquisa de ' +
            'preços que embasou a contratação (Lei 14.133/2021 art. 23).',
          valorEnvolvido: valor,
          // Estável por empenho — não duplica entre execuções do monitor.
          discriminador: d.numeroEmpenho || d.id,
        });
      }
    }

    // Cap top-K por força do sinal — não afoga o painel com dezenas de outliers
    // fracos do mesmo run (mantém os de maior probabilidade/valor).
    if (out.length > TOP_K) {
      out.sort(
        (a, b) =>
          (b.scores?.probabilidadeIrregularidade ?? 0) -
            (a.scores?.probabilidadeIrregularidade ?? 0) ||
          (b.valorEnvolvido ?? 0) - (a.valorEnvolvido ?? 0),
      );
      out.length = TOP_K;
    }
    return out;
  },
};
