import { formatBRL, type DespesaNorm } from '../normalizar';
import { ehEntidadePublica } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

const MIN_ITENS_POR_GRUPO = 5;
const LIMIAR_DIFERENCA = 2.5;

function chaveElemento(d: DespesaNorm): string {
  const elem = d.elemento.replace(/[^\d]/g, '').slice(0, 4) || '0000';
  return elem;
}

export const detectorSuperfaturamento: Detector = {
  id: 'FN-07',
  nome: 'Superfaturamento — preço acima da mediana do elemento',
  categoria: 'Fornecedores',
  detectar(ctx) {
    const grupos = new Map<string, DespesaNorm[]>();
    for (const d of ctx.despesas) {
      const v = Math.abs(d.valorEmpenhado);
      if (v <= 0) continue;
      if (/REFOR|ANUL/i.test(d.tipoEmpenho)) continue;
      if (!d.cpfCnpj || ehEntidadePublica(d.cpfCnpj, d.fornecedorNome)) continue;
      const chave = chaveElemento(d);
      const arr = grupos.get(chave) ?? [];
      arr.push(d);
      grupos.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];

    for (const [elemento, lista] of grupos) {
      if (lista.length < MIN_ITENS_POR_GRUPO) continue;

      const valores = lista.map((d) => Math.abs(d.valorEmpenhado)).sort((a, b) => a - b);
      const mediana = valores.length % 2 === 0
        ? (valores[valores.length / 2 - 1] + valores[valores.length / 2]) / 2
        : valores[Math.floor(valores.length / 2)];

      if (mediana <= 0) continue;

      const porFornecedor = new Map<string, { despesas: DespesaNorm[]; soma: number }>();
      for (const d of lista) {
        const razao = Math.abs(d.valorEmpenhado) / mediana;
        if (razao < LIMIAR_DIFERENCA) continue;
        const cur = porFornecedor.get(d.cpfCnpj) ?? { despesas: [], soma: 0 };
        cur.despesas.push(d);
        cur.soma += Math.abs(d.valorEmpenhado);
        porFornecedor.set(d.cpfCnpj, cur);
      }

      for (const [cnpj, dados] of porFornecedor) {
        const nome = dados.despesas[0].fornecedorNome || cnpj;
        const razoes = dados.despesas.map((d) => Math.abs(d.valorEmpenhado) / mediana);
        const maiorRazao = Math.max(...razoes);
        const sobreprecoEstimado = dados.despesas.reduce(
          (s, d) => s + Math.max(0, Math.abs(d.valorEmpenhado) - mediana), 0,
        );

        out.push({
          detectorId: 'FN-07',
          detectorNome: 'Superfaturamento',
          categoria: 'Fornecedores',
          titulo: `Possível sobrepreço — ${nome} (elemento ${elemento})`,
          descricao:
            `Fornecedor ${nome} recebeu ${dados.despesas.length} empenho(s) no ` +
            `elemento ${elemento} com valores até ${maiorRazao.toFixed(1)}× a mediana ` +
            `do grupo (mediana: ${formatBRL(mediana)}). ` +
            `Sobrepreço estimado: ${formatBRL(sobreprecoEstimado)}. Possível indício a apurar.`,
          sujeitoTipo: 'fornecedor',
          sujeitoId: cnpj,
          sujeitoRotulo: nome,
          classificacao: maiorRazao >= 4 ? 'suspeita' : 'atencao',
          scores: {
            confiabilidade: Math.min(75, 45 + Math.round((maiorRazao - LIMIAR_DIFERENCA) * 10)),
            probabilidadeIrregularidade: Math.min(80, 40 + Math.round((maiorRazao - LIMIAR_DIFERENCA) * 12)),
          },
          fundamentoLegal: [
            'Lei 14.133/2021 art. 23 (pesquisa de preços)',
            'Lei 8.429/1992 art. 10 (dano ao erário) — a apurar',
          ],
          evidencias: dados.despesas.slice(0, 8).map((d) => ({
            resumo: `${d.objeto || 'sem descrição'} — ${formatBRL(Math.abs(d.valorEmpenhado))}` +
              ` (${(Math.abs(d.valorEmpenhado) / mediana).toFixed(1)}× mediana)`,
            valor: Math.abs(d.valorEmpenhado),
            data: d.data,
          })),
          explicacao:
            'Superfaturamento é a diferença entre o preço contratado e o preço de ' +
            'mercado de referência. Este detector compara os valores pagos com a ' +
            'mediana do mesmo elemento de despesa no próprio município — quando um ' +
            'fornecedor recebe consistentemente valores muito acima da mediana, há ' +
            'possível indício de sobrepreço a apurar. ATENÇÃO: a mediana pode refletir ' +
            'quantidades ou especificações diferentes (um empenho de alto valor pode ' +
            'ser legítimo se o volume for maior). A CONFIRMAÇÃO exige analisar preços ' +
            'unitários e comparar com bancos de preços externos (PNCP, SINAPI, TCE-SP). ' +
            'DEPENDÊNCIA: sem dados de CNAE do fornecedor nem preços de referência ' +
            'externos — a comparação é intra-município, o que pode subestimar o sobrepreço.',
          valorEnvolvido: sobreprecoEstimado,
        });
      }
    }

    return out;
  },
};
