import { formatBRL, type DespesaNorm } from '../normalizar';
import type { Detector } from './tipos';

const ELEMENTOS_PREVIDENCIARIOS = [
  '11', '13', '31', '91',
];

function ehElementoPrevidenciario(elemento: string): boolean {
  const e = elemento.replace(/[^\d]/g, '');
  if (!e) return false;
  return ELEMENTOS_PREVIDENCIARIOS.some((cod) => e.startsWith(cod) || e.endsWith(cod));
}

const PALAVRAS_PREVIDENCIA = /^(?!.*(?:alimen|aux[íi]lio|transporte|viagem|di[áa]ria|f[eé]rias|13[°º])).*(?:previd|inss|rpps|patronal|contribui[çc][ãa]o|obriga[çc][ãa]o)/i;

function temIndicioPrevidenciario(d: DespesaNorm): boolean {
  if (ehElementoPrevidenciario(d.elemento)) return true;
  if (d.objeto) return PALAVRAS_PREVIDENCIA.test(d.objeto);
  return false;
}

interface MesAcumulo {
  mes: number;
  empenhado: number;
  pago: number;
  saldo: number;
}

export const detectorPedaladaFiscal: Detector = {
  id: 'OR-03',
  nome: 'Pedalada fiscal',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    const previdenciarias = ctx.despesas.filter(temIndicioPrevidenciario);
    if (previdenciarias.length < 6) return [];

    const porMes = new Map<number, { empenhado: number; pago: number }>();
    for (const d of previdenciarias) {
      if (!d.data) continue;
      const mes = parseInt(d.data.slice(5, 7), 10);
      if (mes < 1 || mes > 12) continue;
      const acc = porMes.get(mes) ?? { empenhado: 0, pago: 0 };
      acc.empenhado += d.valorEmpenhado;
      acc.pago += d.valorPago;
      porMes.set(mes, acc);
    }

    const acumulado: MesAcumulo[] = [];
    for (let m = 1; m <= 12; m++) {
      const acc = porMes.get(m);
      if (!acc) continue;
      const anterior = acumulado.length > 0 ? acumulado[acumulado.length - 1] : null;
      const saldoAnterior = anterior ? anterior.saldo : 0;
      acumulado.push({
        mes: m,
        empenhado: acc.empenhado,
        pago: acc.pago,
        saldo: saldoAnterior + (acc.empenhado - acc.pago),
      });
    }

    if (acumulado.length < 3) return [];

    const ultimo = acumulado[acumulado.length - 1];
    const primeiro = acumulado[0];
    const saldoFinal = ultimo.saldo;
    const saldoInicial = primeiro.saldo;
    const crescimento = saldoFinal - saldoInicial;

    const mesesCrescendo = acumulado.filter((m, i) =>
      i > 0 && m.saldo > acumulado[i - 1].saldo,
    ).length;

    if (saldoFinal <= 0) return [];
    if (crescimento <= 0 && mesesCrescendo < 2) return [];

    const totalEmpenhado = acumulado.reduce((s, m) => s + m.empenhado, 0);
    const classificacao = (saldoFinal > totalEmpenhado * 0.15 || mesesCrescendo >= 4)
      ? 'suspeita' : 'atencao';

    return [
      {
        detectorId: 'OR-03',
        detectorNome: 'Pedalada fiscal',
        categoria: 'Execução orçamentária',
        titulo: 'Possível pedalada fiscal — contribuições previdenciárias acumulando atraso',
        descricao:
          `Acumulado de ${formatBRL(saldoFinal)} em contribuições previdenciárias empenhadas ` +
          `mas não pagas no exercício (${acumulado.length} meses apurados). ` +
          `Saldo cresceu ${formatBRL(crescimento)} ao longo do período. ` +
          `${mesesCrescendo} de ${acumulado.length} meses registraram aumento do saldo devedor. ` +
          `Possível indício de atraso proposital para maquiar resultado fiscal (pedalada fiscal).`,
        sujeitoTipo: 'orgao',
        sujeitoId: 'pedalada-fiscal',
        sujeitoRotulo: 'Execução orçamentária — contribuições previdenciárias',
        classificacao,
        scores: {
          confiabilidade: 72,
          probabilidadeIrregularidade: Math.min(85, 50 + mesesCrescendo * 8 + (saldoFinal > 500_000 ? 15 : 0)),
        },
        fundamentoLegal: [
          'Lei 4.320/1964 art. 60 (empenho prévio)',
          'LC 101/2000 art. 42 (despesa sem disponibilidade)',
          'DL 201/1967, art. 1º, XIX — a apurar',
        ],
        evidencias: [
          {
            resumo: `Saldo acumulado em ${acumulado.length} meses: ${formatBRL(saldoFinal)}`,
            valor: saldoFinal,
            data: `${ctx.exercicio}-${String(ultimo.mes).padStart(2, '0')}`,
          },
          ...acumulado.slice(-3).map((m) => ({
            resumo: `Mês ${m.mes}: ${formatBRL(m.empenhado)} empenhado · ${formatBRL(m.pago)} pago · saldo ${formatBRL(m.saldo)}`,
            valor: m.saldo,
            data: `${ctx.exercicio}-${String(m.mes).padStart(2, '0')}`,
          })),
        ],
        explicacao:
          'A "pedalada fiscal" é o atraso proposital no pagamento de contribuições ' +
          'previdenciárias (INSS/RPPS) para maquiar o resultado fiscal de curto prazo. ' +
          'Contribuições empenhadas e não pagas que se acumulam por meses consecutivos ' +
          'são possível indício a apurar. ATENÇÃO: a apuração usa o elemento de despesa ' +
          'e palavras-chave no objeto como proxy — pode incluir contribuições de terceiros ' +
          'ou excluir obrigações não identificadas. A confirmação exige a folha de ' +
          'pagamento analítica e o cronograma de recolhimento.',
        valorEnvolvido: saldoFinal,
      },
    ];
  },
};
