import type { AlertaDetectado, Detector } from './tipos';

interface ItemVerificacao {
  chave: string;
  rotulo: string;
  fundamento: string;
  verificar(ctx: { totalEmpenhado: number; exercicio: number; despesas: { objeto: string; elemento: string }[] }): boolean;
}

const ITENS: ItemVerificacao[] = [
  {
    chave: 'coleta_ativa',
    rotulo: 'Coleta SMARAPD ativa no exercício',
    fundamento: 'LAI art. 8º',
    verificar: (ctx) => ctx.totalEmpenhado > 0,
  },
  {
    chave: 'despesas_detalhadas',
    rotulo: 'Despesas com objeto, elemento e data',
    fundamento: 'LAI art. 8º, §1º, IV',
    verificar: (ctx) => ctx.despesas.length > 0,
  },
  {
    chave: 'empenhos_detalhados',
    rotulo: 'Dados de empenhos (fornecedor, valor, data)',
    fundamento: 'LRF art. 48-A',
    verificar: (ctx) => ctx.totalEmpenhado > 0,
  },
  {
    chave: 'restos_a_pagar_visiveis',
    rotulo: 'Restos a pagar disponíveis',
    fundamento: 'LRF art. 55, III',
    verificar: (ctx) => ctx.despesas.filter((d) => /resto|rap/i.test(d.objeto) || /92|91/i.test(d.elemento)).length > 0,
  },
  {
    chave: 'diarias_transparentes',
    rotulo: 'Diárias com beneficiário, data e valor',
    fundamento: 'LAI art. 8º',
    verificar: (ctx) => ctx.despesas.filter((d) => /di[áa]ria/i.test(d.objeto) || /14/i.test(d.elemento)).length > 0,
  },
];

export const detectorChecklistTransparencia: Detector = {
  id: 'TP-01',
  nome: 'Checklist transparência LAI',
  categoria: 'Transparência e LAI',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const resultados = ITENS.map((item) => ({
      ...item,
      presente: item.verificar(ctx),
    }));
    const conformidade = Math.round((resultados.filter((r) => r.presente).length / resultados.length) * 100);

    const ausentes = resultados.filter((r) => !r.presente);
    for (const item of ausentes) {
      out.push({
        detectorId: 'TP-01',
        detectorNome: 'Item de transparência ausente',
        categoria: 'Transparência e LAI',
        titulo: `Item não verificado: ${item.rotulo}`,
        descricao:
          `O item "${item.rotulo}" (${item.fundamento}) não pôde ser verificado ` +
          'com os dados disponíveis — possível ausência no portal de transparência ' +
          'a apurar.',
        sujeitoTipo: 'orgao',
        sujeitoId: `transparencia-${item.chave}`,
        sujeitoRotulo: item.rotulo,
        classificacao: 'atencao',
        scores: { confiabilidade: 50, probabilidadeIrregularidade: 25 },
        fundamentoLegal: [item.fundamento],
        evidencias: [{ resumo: `Item não evidenciado nos dados disponíveis` }],
        valorEnvolvido: 0,
        explicacao:
          `A LAI e a LRF exigem a disponibilização de ${item.rotulo.toLowerCase()} ` +
          `em transparência ativa. Não foi possível verificar este item com os ` +
          `dados disponíveis na análise. A apuração requer acesso direto ao ` +
          `portal de transparência do município.`,
      });
    }

    out.push({
      detectorId: 'TP-01',
      detectorNome: 'Conformidade geral LAI',
      categoria: 'Transparência e LAI',
      titulo: `Checklist transparência: ${conformidade}% de conformidade`,
      descricao:
        `Dos ${ITENS.length} itens verificáveis nesta análise, ` +
        `${resultados.filter((r) => r.presente).length} foram evidenciados ` +
        `nos dados disponíveis. Conformidade estimada: ${conformidade}%.`,
      sujeitoTipo: 'orgao',
      sujeitoId: `checklist-transparencia-${ctx.exercicio}`,
      sujeitoRotulo: `Transparência ${ctx.exercicio}`,
      classificacao: conformidade < 60 ? 'suspeita' : conformidade < 80 ? 'atencao' : 'informativo',
      scores: {
        confiabilidade: 72,
        probabilidadeIrregularidade: Math.max(5, 100 - conformidade),
      },
      fundamentoLegal: ['Lei 12.527/2011 (LAI)', 'LC 101/2000 (LRF)'],
      evidencias: resultados.map((r) => ({
        resumo: `${r.presente ? '✓' : '✗'} ${r.rotulo} — ${r.fundamento}`,
      })),
      explicacao:
        'A transparência ativa dos municípios é exigida pela LAI (Lei 12.527/2011 ' +
        'art. 8º) e pela LRF (art. 48-A). A verificação aqui é INDIRETA — ' +
        'baseada na presença de dados no repositório SMARAPD durante a coleta. ' +
        'Não substitui verificação in loco do portal de transparência. ' +
        'Itens marcados como ausentes podem existir mas não terem sido ' +
        'coletados por falta de integração com a fonte específica.',
      valorEnvolvido: 0,
    });

    return out;
  },
};
