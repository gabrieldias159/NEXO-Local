/**
 * Detector LC-06 — Peso de contratação direta.
 *
 * Mede quanto do valor empenhado foi por dispensa ou inexigibilidade — ou
 * seja, sem concorrência competitiva. Contratação direta é legal dentro das
 * hipóteses do art. 75 da Lei 14.133/2021, mas uma fatia anormal do gasto
 * merece verificação caso a caso.
 *
 * Catálogo: LC-06 "Peso de contratação direta" — regra
 * `(DISPENSA+DISPENSADA+INEXIGIBILIDADE) / total empenhado > 25%`. NÃO é o
 * LC-07 ("Inexigibilidade frágil"), que está em `licitacoes-comp.ts`.
 */
import { formatBRL } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

/** Modalidades que caracterizam contratação direta. */
const DIRETA = /DISPENSA|INEXIG/i;

export const detectorModalidade: Detector = {
  id: 'LC-06',
  nome: 'Peso de contratação direta',
  categoria: 'Licitações e compras',

  detectar(ctx) {
    if (ctx.modalidades.length === 0) return [];

    const total = ctx.modalidades.reduce((s, m) => s + m.valorEmpenhado, 0);
    if (total <= 0) return [];

    const direta = ctx.modalidades.filter((m) => DIRETA.test(m.modalidade));
    const valorDireta = direta.reduce((s, m) => s + m.valorEmpenhado, 0);
    const pct = (valorDireta / total) * 100;
    // Catálogo LC-06: a fatia de contratação direta só é anormal acima de 25%.
    if (pct <= 25) return [];

    const classificacao = pct >= 40 ? 'suspeita' : 'atencao';

    return [
      {
        detectorId: 'LC-06',
        detectorNome: 'Peso de contratação direta',
        categoria: 'Licitações e compras',
        titulo: 'Peso anormal de contratação direta no orçamento',
        descricao:
          `${pct.toFixed(1)}% do valor empenhado (${formatBRL(valorDireta)}) foi por ` +
          `dispensa ou inexigibilidade — sem concorrência competitiva.`,
        sujeitoTipo: 'orgao',
        sujeitoId: 'prefeitura-marilia',
        sujeitoRotulo: 'Prefeitura de Marília',
        classificacao,
        scores: {
          confiabilidade: 82,
          probabilidadeIrregularidade: Math.min(80, Math.round(35 + pct)),
        },
        fundamentoLegal: [
          'Lei 14.133/2021, art. 17, 28',
          'Lei 14.133/2021, art. 75',
          'Constituição Federal, art. 37 (princípio da licitação)',
        ],
        evidencias: direta.map((m) => ({
          resumo: `${m.modalidade}: ${formatBRL(m.valorEmpenhado)}`,
          valor: m.valorEmpenhado,
        })),
        explicacao:
          `A contratação direta (dispensa e inexigibilidade) responde por ` +
          `${pct.toFixed(1)}% do valor empenhado — acima do parâmetro de 25% do ` +
          `catálogo (LC-06). É legal dentro das hipóteses dos arts. 17 e 75, mas ` +
          `uma fatia anormal do gasto é possível indício a apurar: verifique a ` +
          `justificativa de cada contratação e se havia alternativa licitatória ` +
          `competitiva.`,
        valorEnvolvido: valorDireta,
      },
    ];
  },
};
