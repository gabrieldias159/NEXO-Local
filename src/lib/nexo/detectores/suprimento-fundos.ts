import { formatBRL, type DespesaNorm } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

function ehSuprimentoFundos(elemento: string): boolean {
  const e = elemento.replace(/[^\d]/g, '');
  if (!e) return false;
  if (e.endsWith('91') || e.endsWith('193')) return true;
  return /339091|449091|339193/i.test(e);
}

const PALAVRAS_SUPRIMENTO = /suprimento.*fundo|suprimento.*fundos|adiantamento|pequena despesa|pronto pagamento|regime.*adiantamento/i;

function temIndicioSuprimento(d: DespesaNorm): boolean {
  if (ehSuprimentoFundos(d.elemento)) return true;
  if (d.objeto) return PALAVRAS_SUPRIMENTO.test(d.objeto);
  return false;
}

export const detectorSuprimentoFundos: Detector = {
  id: 'OR-14',
  nome: 'Suprimento de fundos atípico',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const servidores = new Map<string, { nome: string; despesas: DespesaNorm[]; total: number }>();

    for (const d of ctx.despesas) {
      if (d.valorEmpenhado <= 0) continue;
      if (!temIndicioSuprimento(d)) continue;
      const cpf = d.cpfCnpj || 'sem-doc';
      const cur = servidores.get(cpf) ?? { nome: d.fornecedorNome || cpf, despesas: [], total: 0 };
      cur.despesas.push(d);
      cur.total += Math.abs(d.valorEmpenhado);
      servidores.set(cpf, cur);
    }

    for (const [doc, dados] of servidores) {
      if (dados.despesas.length < 3 && dados.total < 50_000) continue;
      const classificacao = dados.total > 200_000 || dados.despesas.length > 10 ? 'suspeita' : 'atencao';
      out.push({
        detectorId: 'OR-14',
        detectorNome: 'Suprimento de fundos atípico',
        categoria: 'Execução orçamentária',
        titulo: `Suprimento de fundos acima do padrão — ${dados.nome}`,
        descricao:
          `${dados.despesas.length} operações de suprimento de fundos ao mesmo ` +
          `beneficiário no exercício, somando ${formatBRL(dados.total)}. ` +
          `Suprimento de fundos é modalidade de adiantamento para despesas de ` +
          `pequeno vulto — volume elevado sugere possível desvirtuamento a apurar.`,
        sujeitoTipo: 'servidor',
        sujeitoId: doc,
        sujeitoRotulo: dados.nome,
        classificacao,
        scores: {
          confiabilidade: 70,
          probabilidadeIrregularidade: Math.min(85, 40 + dados.despesas.length * 4),
        },
        fundamentoLegal: [
          'DL 200/1967 art. 74-76 (suprimento de fundos)',
          'Lei 4.320/1964 art. 12-13 (classificação da despesa)',
        ],
        evidencias: dados.despesas.slice(0, 8).map((d) => ({
          resumo: `${d.objeto || 'sem descrição'} — ${formatBRL(Math.abs(d.valorEmpenhado))}`,
          valor: Math.abs(d.valorEmpenhado),
          data: d.data,
        })),
        explicacao:
          'Suprimento de fundos é adiantamento a servidor para despesas de ' +
          'pequeno vulto que exijam pronto pagamento. O volume excessivo de ' +
          'operações ao mesmo beneficiário ou o valor total elevado indicam ' +
          'possível desvirtuamento da finalidade — a apurar. ATENÇÃO: a ' +
          'classificação como suprimento baseia-se no código de elemento ' +
          '(sufixo 91/193) e em palavras-chave no objeto. A apuração exige ' +
          'a prestação de contas de cada suprimento.',
        valorEnvolvido: dados.total,
      });
    }

    return out;
  },
};
