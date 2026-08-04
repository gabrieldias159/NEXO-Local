/**
 * Detectores setoriais sobre o módulo DespesaAgrupada — classificam a despesa
 * pelo objeto/unidade gestora.
 *
 *  FC-01 — Concentração de gasto de combustível num posto.
 *  FC-02 — Gasto de combustível atípico num mês.
 *  SA-08 — Concentração de fornecedor de saúde.
 *  SA-11 — Locação recorrente na saúde com baixa comprovação.
 *  FR-11 — Vencedor único em várias secretarias.
 */
import { formatBRL, type DespesaNorm } from '../normalizar';
import { cnpjValido } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

const RE_COMBUSTIVEL = /combust|gasolina|diesel|etanol|abastec/i;
const RE_SAUDE = /sa[úu]de|medicament|farmac|hospital|insumo|ambul[âa]nc/i;
const RE_LOCACAO = /loca[çc][ãa]o|locar|aluguel/i;

function ehCombustivel(d: DespesaNorm): boolean {
  return RE_COMBUSTIVEL.test(d.objeto) || RE_COMBUSTIVEL.test(d.elemento);
}
function ehSaude(d: DespesaNorm): boolean {
  return RE_SAUDE.test(d.unidadeGestora) || RE_SAUDE.test(d.objeto);
}

export const detectorPostoConcentrado: Detector = {
  id: 'FC-01',
  nome: 'Concentração de gasto de combustível',
  categoria: 'Frota e combustível',
  detectar(ctx) {
    // Só CNPJ válido — posto de combustível é pessoa jurídica (exclui CPF/folha).
    const comb = ctx.despesas.filter((d) => cnpjValido(d.cpfCnpj) && d.valorEmpenhado > 0 && ehCombustivel(d));
    const total = comb.reduce((s, d) => s + d.valorEmpenhado, 0);
    if (total < 50_000) return [];
    const porCnpj = new Map<string, { soma: number; nome: string }>();
    for (const d of comb) {
      const cur = porCnpj.get(d.cpfCnpj) ?? { soma: 0, nome: d.fornecedorNome };
      cur.soma += d.valorEmpenhado;
      porCnpj.set(d.cpfCnpj, cur);
    }
    const out: AlertaDetectado[] = [];
    for (const [cnpj, d] of porCnpj) {
      const pct = (d.soma / total) * 100;
      if (pct < 60) continue;
      out.push({
        detectorId: 'FC-01',
        detectorNome: 'Concentração de gasto de combustível',
        categoria: 'Frota e combustível',
        titulo: `Posto concentra ${pct.toFixed(0)}% do combustível — ${d.nome || cnpj}`,
        descricao: `${formatBRL(d.soma)} de ${formatBRL(total)} em combustível foram para um único fornecedor.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: d.nome || cnpj,
        classificacao: pct >= 80 ? 'suspeita' : 'atencao',
        scores: { confiabilidade: 72, probabilidadeIrregularidade: Math.min(74, Math.round(20 + pct * 0.6)) },
        fundamentoLegal: ['Lei 14.133/2021 art. 11'],
        evidencias: [{ resumo: `${formatBRL(d.soma)} em combustível (${pct.toFixed(1)}% do total)`, valor: d.soma }],
        explicacao:
          'Um único posto concentrando o fornecimento de combustível merece ' +
          'verificar a competitividade da contratação e a renovação periódica.',
        valorEnvolvido: d.soma,
      });
    }
    return out;
  },
};

export const detectorCombustivelAtipico: Detector = {
  id: 'FC-02',
  nome: 'Gasto de combustível atípico no mês',
  categoria: 'Frota e combustível',
  detectar(ctx) {
    const comb = ctx.despesas.filter((d) => d.valorEmpenhado > 0 && d.data && ehCombustivel(d));
    const porMes = new Map<string, number>();
    for (const d of comb) {
      const mes = d.data!.slice(0, 7);
      porMes.set(mes, (porMes.get(mes) ?? 0) + d.valorEmpenhado);
    }
    if (porMes.size < 6) return [];
    const valores = [...porMes.values()];
    const media = valores.reduce((s, v) => s + v, 0) / valores.length;
    const desvio = Math.sqrt(valores.reduce((s, v) => s + (v - media) ** 2, 0) / valores.length);
    const limiar = media + 2 * desvio;
    const out: AlertaDetectado[] = [];
    for (const [mes, valor] of porMes) {
      if (valor <= limiar || desvio === 0) continue;
      out.push({
        detectorId: 'FC-02',
        detectorNome: 'Gasto de combustível atípico no mês',
        categoria: 'Frota e combustível',
        titulo: `Gasto de combustível atípico em ${mes}`,
        descricao: `${formatBRL(valor)} em combustível no mês — acima da média mensal (${formatBRL(media)}) + 2 desvios.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `combustivel-${mes}`,
        sujeitoRotulo: `Combustível ${mes}`,
        classificacao: 'atencao',
        scores: { confiabilidade: 66, probabilidadeIrregularidade: 50 },
        fundamentoLegal: ['LRF art. 1º §1º; controle interno'],
        evidencias: [{ resumo: `Gasto do mês: ${formatBRL(valor)} · média: ${formatBRL(media)}`, valor }],
        explicacao:
          'Pico de gasto de combustível fora da média histórica merece verificar ' +
          'a frota, as rotas e os abastecimentos do período.',
        valorEnvolvido: valor,
      });
    }
    return out;
  },
};

export const detectorFornecedorSaudeConcentrado: Detector = {
  id: 'SA-08',
  nome: 'Concentração de fornecedor de saúde',
  categoria: 'Saúde e almoxarifado',
  detectar(ctx) {
    // Só CNPJ válido — exclui CPF de servidor/folha lançado na área de saúde.
    const saude = ctx.despesas.filter((d) => cnpjValido(d.cpfCnpj) && d.valorEmpenhado > 0 && ehSaude(d));
    const total = saude.reduce((s, d) => s + d.valorEmpenhado, 0);
    if (total < 100_000) return [];
    const porCnpj = new Map<string, { soma: number; nome: string }>();
    for (const d of saude) {
      const cur = porCnpj.get(d.cpfCnpj) ?? { soma: 0, nome: d.fornecedorNome };
      cur.soma += d.valorEmpenhado;
      porCnpj.set(d.cpfCnpj, cur);
    }
    const out: AlertaDetectado[] = [];
    for (const [cnpj, d] of porCnpj) {
      const pct = (d.soma / total) * 100;
      if (pct < 30) continue;
      out.push({
        detectorId: 'SA-08',
        detectorNome: 'Concentração de fornecedor de saúde',
        categoria: 'Saúde e almoxarifado',
        titulo: `Fornecedor concentra ${pct.toFixed(0)}% da despesa de saúde — ${d.nome || cnpj}`,
        descricao: `${formatBRL(d.soma)} de ${formatBRL(total)} em despesas de saúde foram para um único fornecedor.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: d.nome || cnpj,
        classificacao: pct >= 50 ? 'suspeita' : 'atencao',
        scores: { confiabilidade: 70, probabilidadeIrregularidade: Math.min(72, Math.round(25 + pct)) },
        fundamentoLegal: ['Lei 14.133/2021 art. 11'],
        evidencias: [{ resumo: `${formatBRL(d.soma)} em saúde (${pct.toFixed(1)}% do total)`, valor: d.soma }],
        explicacao:
          'Concentração da despesa de saúde num fornecedor merece verificar a ' +
          'competitividade das compras de medicamentos e insumos.',
        valorEnvolvido: d.soma,
      });
    }
    return out;
  },
};

export const detectorLocacaoSaude: Detector = {
  id: 'SA-11',
  nome: 'Locação recorrente na saúde',
  categoria: 'Saúde e almoxarifado',
  detectar(ctx) {
    // Só CNPJ válido — locadora é pessoa jurídica (exclui CPF/folha).
    const loc = ctx.despesas.filter(
      (d) => cnpjValido(d.cpfCnpj) && d.valorEmpenhado > 0 && ehSaude(d) && RE_LOCACAO.test(d.objeto),
    );
    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of loc) {
      const arr = porCnpj.get(d.cpfCnpj) ?? [];
      arr.push(d);
      porCnpj.set(d.cpfCnpj, arr);
    }
    const out: AlertaDetectado[] = [];
    for (const [cnpj, lista] of porCnpj) {
      if (lista.length < 4) continue;
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || cnpj;
      out.push({
        detectorId: 'SA-11',
        detectorNome: 'Locação recorrente na saúde',
        categoria: 'Saúde e almoxarifado',
        titulo: `Locação recorrente na saúde — ${nome}`,
        descricao: `${lista.length} empenhos de locação na área de saúde, somando ${formatBRL(soma)}.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao: 'atencao',
        scores: { confiabilidade: 64, probabilidadeIrregularidade: 46 },
        fundamentoLegal: ['Lei 4.320/1964 art. 63'],
        evidencias: lista.slice(0, 6).map((d) => ({
          resumo: `${d.objeto} — ${formatBRL(d.valorEmpenhado)}`,
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'Pagamento recorrente de locação na saúde (veículo, ambulância, ' +
          'equipamento) merece verificar a comprovação de uso e a vantagem da ' +
          'locação frente à aquisição.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

export const detectorVencedorVariasUGs: Detector = {
  id: 'FR-11',
  nome: 'Vencedor único em várias secretarias',
  categoria: 'Fornecedores',
  detectar(ctx) {
    const porCnpj = new Map<string, { ugs: Set<string>; soma: number; nome: string }>();
    for (const d of ctx.despesas) {
      // Só CNPJ válido — exclui CPF de servidor/folha (ver cnpjValido em ../entidades).
      if (!cnpjValido(d.cpfCnpj) || d.valorEmpenhado <= 0 || !d.unidadeGestora) continue;
      const cur = porCnpj.get(d.cpfCnpj) ?? { ugs: new Set<string>(), soma: 0, nome: d.fornecedorNome };
      cur.ugs.add(d.unidadeGestora);
      cur.soma += d.valorEmpenhado;
      if (!cur.nome && d.fornecedorNome) cur.nome = d.fornecedorNome;
      porCnpj.set(d.cpfCnpj, cur);
    }
    const out: AlertaDetectado[] = [];
    for (const [cnpj, d] of porCnpj) {
      if (d.ugs.size < 4) continue;
      out.push({
        detectorId: 'FR-11',
        detectorNome: 'Vencedor único em várias secretarias',
        categoria: 'Fornecedores',
        titulo: `Fornecedor presente em ${d.ugs.size} secretarias — ${d.nome || cnpj}`,
        descricao: `O fornecedor recebeu empenhos de ${d.ugs.size} unidades gestoras, somando ${formatBRL(d.soma)}.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: d.nome || cnpj,
        classificacao: d.ugs.size >= 7 ? 'suspeita' : 'atencao',
        scores: { confiabilidade: 68, probabilidadeIrregularidade: Math.min(66, 30 + d.ugs.size * 4) },
        fundamentoLegal: ['Lei 14.133/2021 art. 11'],
        evidencias: [...d.ugs].slice(0, 8).map((ug) => ({ resumo: `Unidade gestora: ${ug}` })),
        explicacao:
          'Um mesmo fornecedor presente em muitas secretarias, com objetos ' +
          'heterogêneos, merece verificar se há competitividade real ou ' +
          'dependência de um único contratado.',
        valorEnvolvido: d.soma,
      });
    }
    return out;
  },
};
