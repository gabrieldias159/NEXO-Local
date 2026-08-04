import { formatBRL } from '../normalizar';
import { ehEntidadePublica, docValido } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

interface CpfEmFoco {
  cpf: string;
  nome: string;
  totalRecebido: number;
  ocorrencias: number;
}

export const detectorFuncionarioFantasma: Detector = {
  id: 'FP-10',
  nome: 'Funcionário fantasma — CPF fornecedor vinculado como sócio',
  categoria: 'Folha, cargos e terceirizados',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];

    if (!ctx.socios || ctx.socios.length === 0) {
      return [];
    }

    const cpfsQueRecebem = new Map<string, CpfEmFoco>();
    for (const d of ctx.despesas) {
      if (!d.cpfCnpj || d.cpfCnpj.length !== 11) continue;
      if (!docValido(d.cpfCnpj)) continue;
      if (ehEntidadePublica(d.cpfCnpj, d.fornecedorNome)) continue;
      const v = Math.abs(d.valorEmpenhado);
      if (v <= 0) continue;
      const cur = cpfsQueRecebem.get(d.cpfCnpj) ?? {
        cpf: d.cpfCnpj,
        nome: d.fornecedorNome,
        totalRecebido: 0,
        ocorrencias: 0,
      };
      cur.totalRecebido += v;
      cur.ocorrencias += 1;
      if (d.fornecedorNome && !cur.nome) cur.nome = d.fornecedorNome;
      cpfsQueRecebem.set(d.cpfCnpj, cur);
    }

    const cpfVinculado: Array<{ cpf: string; nome: string; total: number; empresas: string[] }> = [];

    for (const [, dados] of cpfsQueRecebem) {
      if (dados.totalRecebido < 10_000) continue;

      const empresasComoSocial = ctx.socios.filter((s: { socios: { cpfHash: string }[] }) =>
        s.socios.some((p: { cpfHash: string }) => p.cpfHash && dados.cpf.endsWith(p.cpfHash.slice(-6))),
      );

      if (empresasComoSocial.length === 0) continue;

      const nomesEmpresas = empresasComoSocial.map((s) => s.razaoSocial).filter(Boolean);
      cpfVinculado.push({
        cpf: dados.cpf,
        nome: dados.nome,
        total: dados.totalRecebido,
        empresas: nomesEmpresas.slice(0, 5),
      });
    }

    for (const item of cpfVinculado) {
      const nome = item.nome || item.cpf;
      out.push({
        detectorId: 'FP-10',
        detectorNome: 'Funcionário fantasma — CPF fornecedor vinculado como sócio',
        categoria: 'Folha, cargos e terceirizados',
        titulo: `CPF recebe como fornecedor e é sócio de empresa contratada — ${nome}`,
        descricao:
          `O CPF ${item.cpf.slice(0, 3)}.***.***-${item.cpf.slice(9)} recebeu ` +
          `${formatBRL(item.total)} como fornecedor pessoa física no exercício, ` +
          `e consta como sócio de ${item.empresas.length} empresa(s) que também ` +
          `contratam com a Prefeitura. Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: item.cpf,
        sujeitoRotulo: nome,
        classificacao: item.total > 100_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 68,
          probabilidadeIrregularidade: Math.min(82, 50 + item.empresas.length * 8),
        },
        fundamentoLegal: [
          'DL 201/1967, art. 1º, I (apropriar-se de rendas públicas) — a apurar',
          'Lei 8.429/1992 art. 9º (enriquecimento ilícito) — a apurar',
        ],
        evidencias: [
          {
            resumo: `Recebido como PF: ${formatBRL(item.total)}`,
            valor: item.total,
          },
          ...item.empresas.slice(0, 4).map((emp) => ({
            resumo: `Sócio de: ${emp}`,
          })),
        ],
        explicacao:
          'Este detector identifica pessoas físicas (CPF) que recebem pagamentos ' +
          'diretos da Prefeitura como "fornecedor" e simultaneamente figuram como ' +
          'sócias de empresas que também contratam com o poder público. O vínculo ' +
          'pode ser legítimo (profissional autônomo que também é sócio de uma ' +
          'empresa), MAS merece APURAÇÃO quando há indícios de direcionamento de ' +
          'contratos ou quando a pessoa acumula vínculo público. ' +
          'DEPENDÊNCIA: a detecção plena de "funcionário fantasma" (servidor ' +
          'recebendo sem trabalhar) exige a folha de pagamento individualizada ' +
          '(ServidorNorm), que não integra este contexto. Este detector cobre ' +
          'apenas o cruzamento CPF-fornecedor × QSA. A verificação completa requer ' +
          'cruzar a folha de servidores com a base de óbitos (INSS) e com o QSA.',
        valorEnvolvido: item.total,
      });
    }

    return out;
  },
};
