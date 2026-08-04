import { formatBRL } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

function ultimosQuadrimestresMandato(exercicio: number, mes: number): boolean {
  const ANOS_MANDATO = [2021, 2025, 2029];
  if (!ANOS_MANDATO.includes(exercicio)) return false;
  return mes >= 5;
}

export const detectorRAPArt42: Detector = {
  id: 'OR-13',
  nome: 'Restos a pagar — Art. 42 LRF (fim de mandato)',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    const hoje = new Date();
    const mesAtual = hoje.getMonth() + 1;

    if (!ultimosQuadrimestresMandato(ctx.exercicio, mesAtual)) return [];

    const totalRAP = ctx.restosAPagar.reduce((s, r) => s + r.valor, 0);
    if (totalRAP <= 0) return [];

    const totalEmpenhado = ctx.totalEmpenhado;
    const razaoRAP = totalEmpenhado > 0 ? (totalRAP / totalEmpenhado) * 100 : 0;

    const alertas: AlertaDetectado[] = [];

    alertas.push({
      detectorId: 'OR-13',
      detectorNome: 'Restos a pagar — Art. 42 LRF',
      categoria: 'Execução orçamentária',
      titulo: `Restos a pagar em ano de fim de mandato: ${formatBRL(totalRAP)}`,
      descricao:
        `Exercício ${ctx.exercicio} (fim de mandato) com ${formatBRL(totalRAP)} em restos ` +
        `a pagar — ${razaoRAP.toFixed(1)}% do total empenhado ` +
        `(${formatBRL(totalEmpenhado)}). O Art. 42 da LRF veda contrair despesa ` +
        `nos últimos 2 quadrimestres sem disponibilidade de caixa. Possível indício a apurar.`,
      sujeitoTipo: 'orgao',
      sujeitoId: `rap-art42-${ctx.exercicio}`,
      sujeitoRotulo: `Restos a pagar ${ctx.exercicio}`,
      classificacao: razaoRAP > 20 ? 'critico' : razaoRAP > 10 ? 'suspeita' : 'atencao',
      scores: {
        confiabilidade: 70,
        probabilidadeIrregularidade: Math.min(90, 50 + Math.round(razaoRAP * 2)),
      },
      fundamentoLegal: [
        'LC 101/2000 art. 42 (despesa sem disponibilidade de caixa em fim de mandato)',
      ],
      evidencias: [
        {
          resumo: `Total de restos a pagar: ${formatBRL(totalRAP)}`,
          valor: totalRAP,
        },
        {
          resumo: `Total empenhado no exercício: ${formatBRL(totalEmpenhado)}`,
          valor: totalEmpenhado,
        },
        ...ctx.restosAPagar.slice(0, 5).map((r) => ({
          resumo: `${r.fornecedorNome || r.cpfCnpj} — ${formatBRL(r.valor)}`,
          valor: r.valor,
        })),
      ],
      explicacao:
        'O Art. 42 da LRF proíbe o gestor, nos últimos dois quadrimestres do ' +
        'mandato, de contrair despesa que não possa ser paga no mesmo exercício ' +
        'ou que não tenha contrapartida em caixa. Este detector sinaliza o volume ' +
        'de restos a pagar em ano de fim de mandato como possível indício de ' +
        'descumprimento. ATENÇÃO: a apuração exata depende da disponibilidade de ' +
        'caixa por fonte de recurso (RGF Anexo 5), que não está neste contexto. ' +
        'O alerta usa o total de RAP como proxy — a confirmação exige o balanço ' +
        'de caixa do SICONFI.',
      valorEnvolvido: totalRAP,
    });

    return alertas;
  },
};
