import { formatBRL } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

const LIMIAR_VALOR_MES = 5_000;
const LIMIAR_QTD_MES = 15;
const LIMIAR_MESES_HABITUALIDADE = 7;

export const detectorDiarias: Detector = {
  id: 'DE-02',
  nome: 'Diárias — acúmulo e habitualidade',
  categoria: 'Diárias e eventos',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const porBenefMes = new Map<string, { total: number; n: number; nome: string; mes: string }>();
    for (const d of ctx.diarias) {
      if (!d.beneficiario || d.valor <= 0) continue;
      const mes = (d.data ?? '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(mes)) continue;
      const benef = d.beneficiario.toUpperCase().trim();
      const chave = `${benef}|${mes}`;
      const cur = porBenefMes.get(chave) ?? { total: 0, n: 0, nome: d.beneficiario, mes };
      cur.total += d.valor;
      cur.n += 1;
      porBenefMes.set(chave, cur);
    }

    const mesesPorBenef = new Map<string, Set<string>>();
    for (const [chave] of porBenefMes) {
      const [benef, mes] = chave.split('|');
      if (!benef || !mes) continue;
      let s = mesesPorBenef.get(benef);
      if (!s) { s = new Set(); mesesPorBenef.set(benef, s); }
      s.add(mes);
    }

    for (const dados of porBenefMes.values()) {
      if (dados.total <= LIMIAR_VALOR_MES && dados.n <= LIMIAR_QTD_MES) continue;
      const classificacao =
        dados.total >= LIMIAR_VALOR_MES * 2 || dados.n >= LIMIAR_QTD_MES * 2
          ? 'suspeita' : 'atencao';
      const probabilidade = Math.min(80, Math.round(34 + dados.n * 2 + dados.total / 1_000));
      out.push({
        detectorId: 'DE-02',
        detectorNome: 'Diárias — acúmulo mensal',
        categoria: 'Diárias e eventos',
        titulo: `Acúmulo de diárias em ${dados.mes} — ${dados.nome}`,
        descricao:
          `${dados.n} diárias somando ${formatBRL(dados.total)} para o mesmo ` +
          `beneficiário no mês ${dados.mes} — acima do parâmetro de ` +
          `${LIMIAR_QTD_MES} diárias ou ${formatBRL(LIMIAR_VALOR_MES)} por mês. ` +
          `Possível indício a apurar.`,
        sujeitoTipo: 'servidor',
        sujeitoId: dados.nome,
        sujeitoRotulo: dados.nome,
        classificacao,
        scores: { confiabilidade: 74, probabilidadeIrregularidade: probabilidade },
        fundamentoLegal: ['Constituição Federal, art. 37', 'Legislação municipal de diárias'],
        evidencias: [{ resumo: `${dados.n} diárias em ${dados.mes} · total ${formatBRL(dados.total)}`, valor: dados.total }],
        explicacao:
          `O beneficiário acumulou ${dados.n} diárias (${formatBRL(dados.total)}) ` +
          `no mês ${dados.mes}. Cada diária exige justificativa formal, ` +
          `comprovação de deslocamento e relatório de resultado — convém ` +
          `verificar a prestação de contas e a relação das viagens com a ` +
          `função do cargo.`,
        valorEnvolvido: dados.total,
      });
    }

    for (const [benef, meses] of mesesPorBenef) {
      if (meses.size < LIMIAR_MESES_HABITUALIDADE) continue;
      const totalAnual = [...porBenefMes.entries()]
        .filter(([chave]) => chave.startsWith(benef + '|'))
        .reduce((s, [, v]) => s + v.total, 0);
      const totalDiarias = [...porBenefMes.entries()]
        .filter(([chave]) => chave.startsWith(benef + '|'))
        .reduce((s, [, v]) => s + v.n, 0);
      out.push({
        detectorId: 'DE-02',
        detectorNome: 'Diárias — habitualidade',
        categoria: 'Diárias e eventos',
        discriminador: `habitualidade-${benef}`,
        titulo: `Habitualidade de diárias — ${benef}`,
        descricao:
          `O beneficiário recebeu diárias em ${meses.size} meses diferentes ` +
          `no exercício, totalizando ${formatBRL(totalAnual)} em ${totalDiarias} diárias. ` +
          `A repetição mensal sugere deslocamento permanente ou pagamento ` +
          `habitual — a diária é indenização eventual, não complemento salarial. ` +
          `Possível indício a apurar.`,
        sujeitoTipo: 'servidor',
        sujeitoId: benef,
        sujeitoRotulo: benef,
        classificacao: meses.size >= 10 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 72,
          probabilidadeIrregularidade: Math.min(85, 45 + meses.size * 4),
        },
        fundamentoLegal: [
          'Constituição Federal, art. 37',
          'Súmula 680 STF (diária como indenização eventual)',
        ],
        evidencias: [
          { resumo: `${meses.size} meses com diárias · ${totalDiarias} diárias`, valor: totalDiarias },
          { resumo: `Total anual: ${formatBRL(totalAnual)}`, valor: totalAnual },
        ],
        explicacao:
          `Diária é verba indenizatória por serviço eventual fora da sede, ` +
          `NÃO complemento salarial. Receber diárias em ${meses.size} de 12 meses ` +
          `possíveis no exercício sugere habitualidade incompatível com a ` +
          `natureza indenizatória — possível indício de desvirtuamento a apurar.`,
        valorEnvolvido: totalAnual,
      });
    }

    return out;
  },
};
