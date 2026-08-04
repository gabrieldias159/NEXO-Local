/**
 * Detector LC-01 — Fracionamento de despesa.
 *
 * Sinaliza fornecedores que receberam várias contratações abaixo do limite
 * de dispensa, num intervalo curto, somando acima desse limite — o padrão
 * clássico de fuga ao procedimento licitatório.
 *
 * Um fornecedor pode ter mais de um episódio no exercício: a varredura emite
 * todas as janelas de 90 dias NÃO sobrepostas que se qualificam.
 *
 * Indício a apurar, não acusação: o detector aponta o padrão; a confirmação
 * depende de análise documental (objeto, processo, justificativa).
 */
import { getLimiteDispensa } from '../limites';
import { formatBRL, type EmpenhoNorm } from '../normalizar';
import { cnpjValido } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

const JANELA_DIAS = 90;
const MIN_OCORRENCIAS = 3;

/**
 * true se o empenho está vinculado a um PROCESSO LICITATÓRIO (passou por
 * licitação → tem contrato formal). Fracionamento é fuga À licitação, por
 * DISPENSA; um empenho que executa um contrato licitado NÃO é fracionamento.
 * Excluí-los do cálculo abate do alerta os empenhos de contrato (corrige o
 * falso positivo de somar execução de contrato como se fosse dispensa).
 */
function temVinculoLicitatorio(e: EmpenhoNorm): boolean {
  return !!(e.processoLicitatorio && String(e.processoLicitatorio).trim());
}

function addDiasISO(iso: string, dias: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function montarAlerta(
  cnpj: string,
  janela: EmpenhoNorm[],
  soma: number,
  teto: number,
  limiteExato: boolean,
): AlertaDetectado {
  const nome = janela.find((e) => e.fornecedorNome)?.fornecedorNome || cnpj;
  const excesso = soma / teto;
  const classificacao =
    soma > teto * 2 ? 'critico' : soma > teto * 1.4 ? 'suspeita' : 'atencao';
  const probabilidade = Math.min(
    92,
    Math.round(54 + (janela.length - MIN_OCORRENCIAS) * 7 + Math.min(24, (excesso - 1) * 22)),
  );
  const primeira = janela[0].data ?? '';
  const ultima = janela[janela.length - 1].data ?? '';

  return {
    detectorId: 'LC-01',
    detectorNome: 'Fracionamento de despesa',
    categoria: 'Licitações e compras',
    // Discriminador da JANELA (datas inicial..final) — um fornecedor pode ter
    // mais de um episódio de fracionamento no exercício, em janelas de 90 dias
    // distintas. Sem isto, todos colapsam na mesma chaveDeteccao e o upsert
    // (Map last-wins em persistirAlertas) mantém só o último episódio.
    discriminador: `${primeira}..${ultima}`,
    titulo: `Possível fracionamento de despesa — ${nome}`,
    descricao:
      `${janela.length} empenhos ao mesmo fornecedor entre ${primeira} e ${ultima}, ` +
      `somando ${formatBRL(soma)} — ${Math.round((excesso - 1) * 100)}% acima do ` +
      `limite de dispensa (${formatBRL(teto)}).`,
    sujeitoTipo: 'fornecedor',
    sujeitoId: cnpj,
    sujeitoRotulo: nome,
    classificacao,
    scores: {
      confiabilidade: limiteExato ? 78 : 66,
      probabilidadeIrregularidade: probabilidade,
    },
    fundamentoLegal: [
      'Lei 14.133/2021, art. 75, II e §1º',
      'Constituição Federal, art. 37',
    ],
    evidencias: janela.slice(0, 10).map((e) => ({
      resumo: `Empenho ${e.numeroEmpenho || e.id} — ${formatBRL(e.valorEmpenhado)}`,
      valor: e.valorEmpenhado,
      data: e.data,
      ref: e.id,
    })),
    explicacao:
      `O fornecedor recebeu ${janela.length} contratações POR DISPENSA, cada uma ` +
      `abaixo do limite legal, que somadas (${formatBRL(soma)}) ultrapassam esse ` +
      `limite em até ${JANELA_DIAS} dias. Empenhos vinculados a processo ` +
      `licitatório (contrato) foram EXCLUÍDOS deste total — não são fracionamento. ` +
      `Padrão compatível com fracionamento indevido — requer verificação do ` +
      `objeto, dos processos e da justificativa de cada contratação.`,
    valorEnvolvido: soma,
  };
}

export const detectorFracionamento: Detector = {
  id: 'LC-01',
  nome: 'Fracionamento de despesa',
  categoria: 'Licitações e compras',

  detectar(ctx) {
    const limite = getLimiteDispensa(ctx.exercicio);
    const teto = limite.comprasServicos;
    const out: AlertaDetectado[] = [];

    // Agrupa empenhos por CNPJ — só pessoa JURÍDICA fraciona uma compra/
    // dispensa; CPF de servidor/folha (subsídio, diária) NÃO entra (ver
    // cnpjValido em ../entidades).
    const porFornecedor = new Map<string, EmpenhoNorm[]>();
    for (const e of ctx.empenhos) {
      if (!cnpjValido(e.cpfCnpj) || !e.data || e.valorEmpenhado <= 0) continue;
      const arr = porFornecedor.get(e.cpfCnpj) ?? [];
      arr.push(e);
      porFornecedor.set(e.cpfCnpj, arr);
    }

    for (const [cnpj, lista] of porFornecedor) {
      // Só interessam empenhos individualmente abaixo do limite de dispensa E
      // por DISPENSA — empenhos vinculados a processo licitatório (contrato)
      // passaram por licitação e NÃO são fracionamento. Excluí-los abate o valor
      // (corrige o falso positivo: execução de contrato somada como dispensa).
      const candidatos = lista
        .filter((e) => e.valorEmpenhado <= teto && !temVinculoLicitatorio(e))
        .sort((a, b) => (a.data! < b.data! ? -1 : 1));
      if (candidatos.length < MIN_OCORRENCIAS) continue;

      // Varredura de janelas de 90 dias NÃO sobrepostas.
      let i = 0;
      while (i <= candidatos.length - MIN_OCORRENCIAS) {
        const fim = addDiasISO(candidatos[i].data!, JANELA_DIAS);
        const janela = candidatos.filter(
          (e) => e.data! >= candidatos[i].data! && e.data! <= fim,
        );
        const soma = janela.reduce((s, e) => s + e.valorEmpenhado, 0);

        if (janela.length >= MIN_OCORRENCIAS && soma > teto) {
          out.push(montarAlerta(cnpj, janela, soma, teto, limite.exato));
          // Salta para depois da última data da janela emitida.
          const ultimaData = janela[janela.length - 1].data!;
          let j = i;
          while (j < candidatos.length && candidatos[j].data! <= ultimaData) j++;
          i = j;
        } else {
          i++;
        }
      }
    }

    return out;
  },
};
