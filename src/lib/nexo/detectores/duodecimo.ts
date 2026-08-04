import { formatBRL } from '../normalizar';
import type { Detector } from './tipos';

const TETO_POPULACAO: { max: number; teto: number }[] = [
  { max: 100_000, teto: 7 },
  { max: 300_000, teto: 6 },
  { max: 500_000, teto: 5 },
  { max: 3_000_000, teto: 4.5 },
  { max: 8_000_000, teto: 4 },
  { max: Infinity, teto: 3.5 },
];

function tetoDuodecimo(populacao: number): number {
  for (const faixa of TETO_POPULACAO) {
    if (populacao <= faixa.max) return faixa.teto;
  }
  return 3.5;
}

export const detectorDuodecimo: Detector = {
  id: 'MF-18',
  nome: 'Duodécimo (repasse ao legislativo)',
  categoria: 'Metas fiscais e LRF',
  detectar(ctx) {
    const POP_MARILIA = 240_000;
    const teto = tetoDuodecimo(POP_MARILIA);

    const estimativaRCL = ctx.totalEmpenhado * 0.7;
    const limiteEstimado = estimativaRCL * (teto / 100);

    return [
      {
        detectorId: 'MF-18',
        detectorNome: 'Duodécimo (repasse ao legislativo)',
        categoria: 'Metas fiscais e LRF',
        titulo: `Limite duodécimo: ${teto}% da RCL (Marília: ${POP_MARILIA.toLocaleString('pt-BR')} hab.)`,
        descricao:
          `Marília (~${POP_MARILIA.toLocaleString('pt-BR')} hab.) enquadra-se na ` +
          `faixa de até 300.000 habitantes: limite de ${teto}% da RCL para ` +
          `repasses à Câmara Municipal (CF Art. 29-A). ` +
          `RCL estimada: ${formatBRL(estimativaRCL)}. ` +
          `Limite estimado: ${formatBRL(limiteEstimado)}.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `duodecimo-${ctx.exercicio}`,
        sujeitoRotulo: `Duodécimo ${ctx.exercicio}`,
        classificacao: 'informativo',
        scores: {
          confiabilidade: 90,
          probabilidadeIrregularidade: 5,
        },
        fundamentoLegal: [
          `CF Art. 29-A (limite de ${teto}% para duodécimo)`,
          'CF Art. 168 (entrega dos repasses até dia 20)',
        ],
        evidencias: [
          { resumo: `População: ${POP_MARILIA.toLocaleString('pt-BR')} hab. (IBGE)` },
          { resumo: `Faixa: até 300.000 hab. — limite ${teto}%` },
          { resumo: `RCL estimada: ${formatBRL(estimativaRCL)} (70% do total empenhado)` },
          { resumo: `Limite estimado de repasse: ${formatBRL(limiteEstimado)}`, valor: limiteEstimado },
        ],
        explicacao:
          `O Art. 29-A da CF limita os repasses à Câmara Municipal conforme ` +
          `a faixa populacional. Para Marília (~240.000 hab.), o limite é ` +
          `${teto}% da RCL do exercício anterior. ` +
          `ATENÇÃO: este alerta usa estimativas (RCL ≈ 70% do total empenhado). ` +
          `A apuração exata exige a RCL do SICONFI (RREO Anexo 01) e os ` +
          `repasses efetivamente realizados à Câmara, que não estão neste ` +
          `contexto. O alerta é informativo — consulte o SICONFI para ` +
          `aferição precisa.`,
        valorEnvolvido: limiteEstimado,
      },
    ];
  },
};
