import { formatBRL } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

export const detectorIndiceLiquidez: Detector = {
  id: 'MF-17',
  nome: 'Índice de liquidez',
  categoria: 'Metas fiscais e LRF',
  detectar(ctx) {
    const totalRAP = ctx.restosAPagar.reduce((s, r) => s + r.valor, 0);
    if (totalRAP <= 0) return [];

    const proxyPassivoCirculante = totalRAP;
    const proxyDisponibilidades = ctx.totalEmpenhado * 0.15;
    const iliquidez = proxyPassivoCirculante > 0 ? proxyDisponibilidades / proxyPassivoCirculante : 0;

    const restosNaoPagos = ctx.restosAPagar.filter((r) => r.valor > 0).length;

    const alertas: AlertaDetectado[] = [];

    if (iliquidez < 1.5) {
      const classificacao = iliquidez < 0.5 ? 'critico' : iliquidez < 1 ? 'suspeita' : 'atencao';
      alertas.push({
        detectorId: 'MF-17',
        detectorNome: 'Índice de liquidez',
        categoria: 'Metas fiscais e LRF',
        titulo: `IL estimado em ${iliquidez.toFixed(2)} — possível dificuldade de caixa`,
        descricao:
          `Índice de liquidez estimado em ${iliquidez.toFixed(2)} ` +
          `(disponibilidades estimadas / restos a pagar). ` +
          `Passivo circulante proxy: ${formatBRL(proxyPassivoCirculante)} ` +
          `(restos a pagar). IL < 1 indica possível insuficiência de caixa ` +
          `para cobrir obrigações de curto prazo. Possível indício a apurar.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `indice-liquidez-${ctx.exercicio}`,
        sujeitoRotulo: `Índice de liquidez ${ctx.exercicio}`,
        classificacao,
        scores: {
          confiabilidade: 52,
          probabilidadeIrregularidade: Math.min(85, Math.round((1.5 - iliquidez) * 40 + 30)),
        },
        fundamentoLegal: [
          'LRF (LC 101/2000) art. 1º §1º (gestão fiscal equilibrada)',
          'LRF art. 48-A (transparência fiscal)',
        ],
        evidencias: [
          { resumo: `Índice de liquidez estimado: ${iliquidez.toFixed(2)}` },
          { resumo: `Restos a pagar (proxy passivo): ${formatBRL(proxyPassivoCirculante)}`, valor: proxyPassivoCirculante },
          { resumo: `Disponibilidades estimadas (15% empenhado): ${formatBRL(proxyDisponibilidades)}`, valor: proxyDisponibilidades },
          { resumo: `Quantidade de restos em aberto: ${restosNaoPagos}`, valor: restosNaoPagos },
        ],
        explicacao:
          'O índice de liquidez (IL = Ativo Circulante / Passivo Circulante) ' +
          'mede a capacidade de pagar obrigações de curto prazo. ' +
          'ESTIMATIVA: as disponibilidades de caixa são estimadas em 15% do ' +
          'total empenhado (proxy conservador, baseado em média empírica de ' +
          'municípios de porte similar). O passivo circulante usa o total de ' +
          'restos a pagar como proxy. IL < 1 indica que o passivo supera as ' +
          'disponibilidades — possível desequilíbrio de caixa a apurar. ' +
          'IMPORTANTE: o cálculo exato exige Balanço Patrimonial (SICONFI ' +
          'DCA) e RGF Anexo 6. Esta é uma estimativa conservadora.',
        valorEnvolvido: proxyPassivoCirculante,
      });
    }

    return alertas;
  },
};
