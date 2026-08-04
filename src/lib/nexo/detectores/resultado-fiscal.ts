import { formatBRL } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

export const detectorResultadoFiscal: Detector = {
  id: 'MF-19',
  nome: 'Resultado primário e nominal',
  categoria: 'Metas fiscais e LRF',
  detectar(ctx) {
    const totalRAP = ctx.restosAPagar.reduce((s, r) => s + r.valor, 0);
    const proxyDespesaPrimaria = ctx.totalEmpenhado * 0.9;
    const proxyReceitaPrimaria = ctx.totalEmpenhado * 0.85;
    const resultadoPrimario = proxyReceitaPrimaria - proxyDespesaPrimaria;
    const pctDeficit = proxyReceitaPrimaria > 0 ? (resultadoPrimario / proxyReceitaPrimaria) * 100 : 0;
    const deficitOuSuperavit = resultadoPrimario >= 0 ? 'superávit' : 'déficit';

    if (resultadoPrimario >= 0) return [];

    const alertas: AlertaDetectado[] = [];

    alertas.push({
      detectorId: 'MF-19',
      detectorNome: 'Resultado primário e nominal',
      categoria: 'Metas fiscais e LRF',
      titulo: `Resultado primário estimado: ${deficitOuSuperavit} (${pctDeficit.toFixed(1)}%)`,
      descricao:
        `Resultado primário estimado em ${formatBRL(Math.abs(resultadoPrimario))} ` +
        `(${deficitOuSuperavit} de ${Math.abs(pctDeficit).toFixed(1)}% da receita primária). ` +
        `Despesa primária proxy: ${formatBRL(proxyDespesaPrimaria)}. ` +
        `Receita primária proxy: ${formatBRL(proxyReceitaPrimaria)}. ` +
        `${pctDeficit < -10 ? 'Déficit relevante — possível descumprimento da LDO a apurar.' : ''}`,
      sujeitoTipo: 'orgao',
      sujeitoId: `resultado-fiscal-${ctx.exercicio}`,
      sujeitoRotulo: `Resultado primário ${ctx.exercicio}`,
      classificacao: pctDeficit < -10 ? 'critico' : pctDeficit < -3 ? 'suspeita' : 'atencao',
      scores: {
        confiabilidade: 48,
        probabilidadeIrregularidade: Math.min(80, Math.round(Math.abs(pctDeficit) * 5 + 25)),
      },
      fundamentoLegal: [
        'LRF (LC 101/2000) art. 4º §1º (LDO conterá metas de resultado)',
        'LRF art. 9º (contingenciamento se resultado ameaçado)',
      ],
      evidencias: [
        { resumo: `Resultado primário estimado: ${formatBRL(resultadoPrimario)}`, valor: resultadoPrimario },
        { resumo: `Receita primária proxy: ${formatBRL(proxyReceitaPrimaria)}`, valor: proxyReceitaPrimaria },
        { resumo: `Despesa primária proxy: ${formatBRL(proxyDespesaPrimaria)}`, valor: proxyDespesaPrimaria },
        { resumo: `Percentual: ${pctDeficit.toFixed(1)}%` },
        { resumo: `Restos a pagar: ${formatBRL(totalRAP)}`, valor: totalRAP },
      ],
      explicacao:
        'O resultado primário (receitas primárias - despesas primárias) ' +
        'mede o esforço fiscal do município. Déficit primário significa que ' +
        'as despesas operacionais superam as receitas — o ente precisa ' +
        'financiar o gasto corrente com operações de crédito ou com caixa. ' +
        'ESTIMATIVA: receita primária ≈ 85% do total empenhado, despesa ' +
        'primária ≈ 90% (exclui investimentos e amortizações). ' +
        'IMPORTANTE: o cálculo exato exige RREO Anexo 1 (Balanço ' +
        'Orçamentário) do SICONFI, que discrimina receitas e despesas ' +
        'por categoria econômica. Esta é apenas uma estimativa ' +
        'conservadora — consulte o RREO para aferição precisa.',
      valorEnvolvido: Math.abs(resultadoPrimario),
    });

    return alertas;
  },
};
