/**
 * Detectores adicionais de Licitações e Compras, sobre o módulo
 * DespesaAgrupada (que carrega objeto, elemento e unidade gestora).
 *
 *  LC-02 — Fracionamento por objeto (mesmo CNPJ + mesmo objeto).
 *  LC-03 — Fracionamento entre secretarias (mesmo objeto em ≥2 UGs).
 *  LC-04 — Valor colado no limite de dispensa.
 *  LC-05 — Sequência de compras logo abaixo do limite.
 */
import { getLimiteDispensa } from '../limites';
import { formatBRL, type DespesaNorm } from '../normalizar';
import { objetoEhGenerico, tipoEmpenhoContaComoCompra } from '../calibragem';
import { cnpjValido } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

function normObjeto(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Filtro de entrada comum ao fracionamento: despesa com CNPJ VÁLIDO (só
 *  pessoa jurídica fraciona compra/dispensa — exclui CPF de servidor/folha),
 *  objeto ESPECÍFICO (não catch-all), valor positivo e empenho que conta como
 *  compra (exclui reforço/anulação — dupla contagem). Objeto genérico agrupa
 *  naturezas distintas e produzia falso "fracionamento" (auditoria de qualidade). */
function contaNoFracionamento(d: DespesaNorm): boolean {
  return (
    cnpjValido(d.cpfCnpj) &&
    !!d.objeto &&
    !objetoEhGenerico(d.objeto) &&
    d.valorEmpenhado > 0 &&
    tipoEmpenhoContaComoCompra(d.tipoEmpenho)
  );
}

export const detectorFracionamentoObjeto: Detector = {
  id: 'LC-02',
  nome: 'Fracionamento por objeto',
  categoria: 'Licitações e compras',
  detectar(ctx) {
    const teto = getLimiteDispensa(ctx.exercicio).comprasServicos;
    const out: AlertaDetectado[] = [];
    const grupos = new Map<string, DespesaNorm[]>();
    for (const d of ctx.despesas) {
      // valor individual ≤ teto (fracionamento é sobre compras diretas)
      if (!contaNoFracionamento(d) || d.valorEmpenhado > teto) continue;
      const chave = `${d.cpfCnpj}|${normObjeto(d.objeto)}`;
      const arr = grupos.get(chave) ?? [];
      arr.push(d);
      grupos.set(chave, arr);
    }
    for (const lista of grupos.values()) {
      if (lista.length < 3) continue;
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      if (soma <= teto) continue;
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || lista[0].cpfCnpj;
      out.push({
        detectorId: 'LC-02',
        detectorNome: 'Fracionamento por objeto',
        categoria: 'Licitações e compras',
        titulo: `Compras repetidas do mesmo objeto — ${nome}`,
        descricao:
          `${lista.length} empenhos do objeto "${lista[0].objeto}" ao mesmo fornecedor, ` +
          `cada um abaixo do limite de dispensa, somando ${formatBRL(soma)}.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj,
        sujeitoRotulo: nome,
        classificacao: soma > teto * 2 ? 'suspeita' : 'atencao',
        scores: { confiabilidade: 72, probabilidadeIrregularidade: Math.min(85, 50 + lista.length * 5) },
        fundamentoLegal: ['Lei 14.133/2021 art. 75 §1º, art. 18'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Empenho ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)}`,
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'O mesmo objeto foi adquirido em várias compras menores ao mesmo ' +
          'fornecedor, somando acima do limite de dispensa. Padrão compatível ' +
          'com fracionamento — requer verificar se deveria ter sido licitado em conjunto.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

export const detectorFracionamentoSecretarias: Detector = {
  id: 'LC-03',
  nome: 'Fracionamento entre secretarias',
  categoria: 'Licitações e compras',
  detectar(ctx) {
    const teto = getLimiteDispensa(ctx.exercicio).comprasServicos;
    const out: AlertaDetectado[] = [];
    const grupos = new Map<string, DespesaNorm[]>();
    for (const d of ctx.despesas) {
      // LC-03: cada compra individual ≤ teto (senão já seria licitável isolada —
      // não é fracionamento). Exclui objeto genérico e reforço/anulação.
      if (!contaNoFracionamento(d) || d.valorEmpenhado > teto) continue;
      const chave = `${d.cpfCnpj}|${normObjeto(d.objeto)}`;
      const arr = grupos.get(chave) ?? [];
      arr.push(d);
      grupos.set(chave, arr);
    }
    for (const lista of grupos.values()) {
      const ugs = new Set(lista.map((d) => d.unidadeGestora).filter(Boolean));
      if (ugs.size < 2) continue;
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      if (soma <= teto) continue;
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || lista[0].cpfCnpj;
      out.push({
        detectorId: 'LC-03',
        detectorNome: 'Fracionamento entre secretarias',
        categoria: 'Licitações e compras',
        titulo: `Mesmo objeto comprado por ${ugs.size} secretarias — ${nome}`,
        descricao:
          `O objeto "${lista[0].objeto}" foi adquirido do mesmo fornecedor por ` +
          `${ugs.size} unidades gestoras distintas, somando ${formatBRL(soma)}.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj,
        sujeitoRotulo: nome,
        classificacao: 'suspeita',
        scores: { confiabilidade: 70, probabilidadeIrregularidade: Math.min(82, 52 + ugs.size * 8) },
        fundamentoLegal: ['Lei 14.133/2021 art. 75 §1º'],
        evidencias: [...ugs].slice(0, 8).map((ug) => ({ resumo: `Unidade gestora: ${ug}` })),
        explicacao:
          'Comprar o mesmo objeto do mesmo fornecedor por secretarias diferentes ' +
          'pode ser uma forma de manter cada compra abaixo do limite e escapar da ' +
          'soma — requer verificar o planejamento conjunto da contratação.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

function bandaDetector(
  ctx: { exercicio: number; despesas: DespesaNorm[] },
  cfg: {
    id: string;
    nome: string;
    pisoFrac: number;
    tetoFrac: number;
    minOcorrencias: number;
    fundamento: string;
  },
): AlertaDetectado[] {
  const teto = getLimiteDispensa(ctx.exercicio).comprasServicos;
  const piso = teto * cfg.pisoFrac;
  const tetoBanda = teto * cfg.tetoFrac;
  const out: AlertaDetectado[] = [];
  const porCnpj = new Map<string, DespesaNorm[]>();
  for (const d of ctx.despesas) {
    // Só CNPJ válido — exclui CPF de servidor/folha (ver cnpjValido em ../entidades).
    if (!cnpjValido(d.cpfCnpj) || d.valorEmpenhado < piso || d.valorEmpenhado > tetoBanda) continue;
    const arr = porCnpj.get(d.cpfCnpj) ?? [];
    arr.push(d);
    porCnpj.set(d.cpfCnpj, arr);
  }
  for (const lista of porCnpj.values()) {
    if (lista.length < cfg.minOcorrencias) continue;
    const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
    const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || lista[0].cpfCnpj;
    out.push({
      detectorId: cfg.id,
      detectorNome: cfg.nome,
      categoria: 'Licitações e compras',
      titulo: `${cfg.nome} — ${nome}`,
      descricao:
        `${lista.length} empenhos diretos ao mesmo fornecedor com valores entre ` +
        `${Math.round(cfg.pisoFrac * 100)}% e ${Math.round(cfg.tetoFrac * 100)}% do ` +
        `limite de dispensa (${formatBRL(teto)}).`,
      sujeitoTipo: 'fornecedor',
      sujeitoId: lista[0].cpfCnpj,
      sujeitoRotulo: nome,
      classificacao: lista.length >= cfg.minOcorrencias + 2 ? 'suspeita' : 'atencao',
      scores: { confiabilidade: 70, probabilidadeIrregularidade: Math.min(80, 44 + lista.length * 6) },
      fundamentoLegal: [cfg.fundamento],
      evidencias: lista.slice(0, 8).map((d) => ({
        resumo: `Empenho ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)}`,
        valor: d.valorEmpenhado,
        data: d.data,
      })),
      explicacao:
        'Valores recorrentes logo abaixo do teto de dispensa são um padrão ' +
        'clássico de contratação calibrada para evitar a licitação — requer ' +
        'verificar os objetos e a justificativa de cada compra.',
      valorEnvolvido: soma,
    });
  }
  return out;
}

export const detectorValorColado: Detector = {
  id: 'LC-04',
  nome: 'Valor colado no limite de dispensa',
  categoria: 'Licitações e compras',
  detectar(ctx) {
    return bandaDetector(ctx, {
      id: 'LC-04',
      nome: 'Valor colado no limite de dispensa',
      pisoFrac: 0.9,
      tetoFrac: 1.0,
      minOcorrencias: 2,
      fundamento: 'Lei 14.133/2021 art. 75 I/II',
    });
  },
};

export const detectorSequenciaAbaixoLimite: Detector = {
  id: 'LC-05',
  nome: 'Sequência logo abaixo do limite',
  categoria: 'Licitações e compras',
  detectar(ctx) {
    return bandaDetector(ctx, {
      id: 'LC-05',
      nome: 'Sequência logo abaixo do limite',
      pisoFrac: 0.8,
      tetoFrac: 0.99,
      minOcorrencias: 4,
      fundamento: 'Lei 14.133/2021 art. 75 §1º',
    });
  },
};
