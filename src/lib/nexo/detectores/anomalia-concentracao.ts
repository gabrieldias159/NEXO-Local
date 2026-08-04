/**
 * Detector AN-03 — Concentração órgão → fornecedor.
 *
 * Diferente do FN-01 (concentração GLOBAL de um fornecedor no total empenhado),
 * este detector olha DENTRO de cada unidade gestora: mede o quão concentrado o
 * gasto de um órgão está num único fornecedor (top-share) e o quão concentrado
 * está o mercado daquele órgão como um todo (índice HHI). Um fornecedor que
 * abocanha fatia desproporcional dos empenhos de UM órgão é possível indício de
 * baixa competitividade/direcionamento A APURAR — nunca acusação: pode refletir
 * um contrato grande e legítimo (ex.: único fornecedor de um insumo).
 *
 * HHI (Herfindahl–Hirschman): soma dos quadrados das fatias percentuais. Vai de
 * ~0 (pulverizado) a 10.000 (monopólio). Acima de 2.500 = mercado concentrado
 * (referência clássica antitruste).
 *
 * Degrada honestamente: sem ctx.empenhos com unidade gestora → retorna [].
 */
import { formatBRL, type EmpenhoNorm } from '../normalizar';
import { ehEntidadePublica } from '../entidades';
import type { AlertaDetectado, Classificacao, Detector } from './tipos';

/** Mínimo de empenhos no órgão para a medida de concentração ter sentido. */
const MIN_EMPENHOS_ORGAO = 8;
/** Mínimo de fornecedores distintos — com 1 só não há "concentração" a medir. */
const MIN_FORNECEDORES = 3;
/** Top-share (fatia do maior fornecedor no órgão) que aciona o alerta. */
const LIMIAR_TOPSHARE = 50;
/** HHI a partir do qual o mercado do órgão é considerado concentrado. */
const LIMIAR_HHI = 2_500;
/** Piso de volume do órgão para não sinalizar ruído de baixo valor. */
const VOLUME_MINIMO = 50_000;

export const detectorConcentracaoOrgaoFornecedor: Detector = {
  id: 'AN-03',
  nome: 'Concentração órgão → fornecedor',
  categoria: 'Anomalia estatística',

  detectar(ctx): AlertaDetectado[] {
    if (!Array.isArray(ctx.empenhos) || ctx.empenhos.length === 0) return [];

    // Agrupa empenhos por unidade gestora; dentro dela, soma por fornecedor.
    const porOrgao = new Map<
      string,
      Map<string, { total: number; n: number; nome: string }>
    >();

    for (const e of ctx.empenhos) {
      if (!e.unidadeGestora || !e.cpfCnpj || e.valorEmpenhado <= 0) continue;
      if (ehEntidadePublica(e.cpfCnpj, e.fornecedorNome)) continue;
      const fornecedores = porOrgao.get(e.unidadeGestora) ?? new Map();
      const cur = fornecedores.get(e.cpfCnpj) ?? { total: 0, n: 0, nome: e.fornecedorNome };
      cur.total += e.valorEmpenhado;
      cur.n += 1;
      if (!cur.nome && e.fornecedorNome) cur.nome = e.fornecedorNome;
      fornecedores.set(e.cpfCnpj, cur);
      porOrgao.set(e.unidadeGestora, fornecedores);
    }

    const out: AlertaDetectado[] = [];

    for (const [ug, fornecedores] of porOrgao) {
      if (fornecedores.size < MIN_FORNECEDORES) continue;

      const entradas = [...fornecedores.entries()];
      const nEmpenhos = entradas.reduce((s, [, d]) => s + d.n, 0);
      if (nEmpenhos < MIN_EMPENHOS_ORGAO) continue;

      const volume = entradas.reduce((s, [, d]) => s + d.total, 0);
      if (volume < VOLUME_MINIMO) continue;

      // HHI: soma dos quadrados das fatias percentuais (0–10.000).
      const hhi = entradas.reduce((s, [, d]) => {
        const fatia = (d.total / volume) * 100;
        return s + fatia * fatia;
      }, 0);

      // Maior fornecedor (top-share) do órgão.
      const [topCnpj, topDados] = entradas.reduce((a, b) => (a[1].total >= b[1].total ? a : b));
      const topShare = (topDados.total / volume) * 100;

      // Aciona quando o líder concentra > limiar OU o mercado é concentrado (HHI).
      if (topShare < LIMIAR_TOPSHARE && hhi < LIMIAR_HHI) continue;

      const nome = topDados.nome || topCnpj;
      // Severidade por magnitude — teto em 'suspeita' (concentração não acusa).
      const classificacao: Classificacao =
        topShare >= 70 || hhi >= 5_000 ? 'suspeita' : 'atencao';

      out.push({
        detectorId: 'AN-03',
        detectorNome: 'Concentração órgão → fornecedor',
        categoria: 'Anomalia estatística',
        titulo: `Concentração de fornecedor na ${ug} — ${nome}`,
        descricao:
          `Na ${ug}, o fornecedor concentra ${topShare.toFixed(1)}% do valor ` +
          `empenhado (${formatBRL(topDados.total)} em ${topDados.n} de ${nEmpenhos} ` +
          `empenhos; ${fornecedores.size} fornecedores; HHI ${Math.round(hhi)})` +
          (ctx.amostra ? ' — sobre a amostra coletada.' : '.') +
          ' Possível indício de baixa competitividade a apurar.',
        sujeitoTipo: 'fornecedor',
        sujeitoId: topCnpj,
        sujeitoRotulo: nome,
        classificacao,
        scores: {
          confiabilidade: ctx.amostra ? 58 : 74,
          probabilidadeIrregularidade: Math.min(
            78,
            Math.round(30 + topShare * 0.4 + hhi / 250),
          ),
        },
        fundamentoLegal: [
          'Lei 14.133/2021, art. 5º (competitividade)',
          'Lei 14.133/2021, art. 11 (eficiência e melhor proposta)',
        ],
        evidencias: [
          {
            resumo:
              `Fornecedor líder na ${ug}: ${topShare.toFixed(1)}% ` +
              `(${formatBRL(topDados.total)} em ${topDados.n} empenhos)`,
            valor: topDados.total,
          },
          {
            resumo: `Concentração do órgão (HHI): ${Math.round(hhi)} de 10.000`,
            valor: Math.round(hhi),
          },
          {
            resumo: `Total empenhado da ${ug}: ${formatBRL(volume)} entre ${fornecedores.size} fornecedores`,
            valor: volume,
          },
        ],
        explicacao:
          'Mede a concentração de gasto DENTRO de uma unidade gestora: a fatia do ' +
          'maior fornecedor (top-share) e o índice HHI (Herfindahl–Hirschman) do ' +
          'mercado do órgão (acima de 2.500 = concentrado). Um fornecedor que ' +
          'abocanha fatia desproporcional dos empenhos de um órgão é possível indício ' +
          'de baixa competitividade ou direcionamento A APURAR — não é irregularidade ' +
          'por si: pode haver fornecedor único legítimo de um insumo. Verificar a ' +
          'competitividade real das contratações e a adequação da modalidade.',
        valorEnvolvido: topDados.total,
        // Estável por (órgão, fornecedor) — não duplica entre execuções.
        discriminador: `${ug}::${topCnpj}`,
      });
    }

    return out;
  },
};
