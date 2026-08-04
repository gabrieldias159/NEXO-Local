/**
 * Detector cross-source computável.
 *
 *  XS-07 — Empenho relevante sem contrato/processo publicado.
 *
 * FP-11 (Despesa de pessoal em alta vs. receita) foi removido deste arquivo:
 * havia uma implementação idêntica (também `[]` por falta da série
 * multi-exercício de folha e receita) em `folha-receita-cat.ts`
 * (detectorPessoalEmAltaVsReceita), bloco sistemático da área de folha.
 * Mantém-se a de lá para não ter dois detectores com o mesmo `FP-11`.
 *
 * Trabalha sobre `empenhos`. Linguagem: indício a apurar.
 */
import { formatBRL, type EmpenhoNorm } from '../normalizar';
import { ehEntidadePublica, cnpjValido } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

/** Catálogo XS-07: empenho relevante > R$ 100k. */
const LIMIAR_XS07 = 100_000;

// ── XS-07 — Empenho sem contrato/processo publicado ──────────────────────────
/**
 * Lei 14.133/2021 art. 95 e LC 131/2009: a contratação relevante deve ter
 * contrato/processo localizável e publicado. Sinaliza empenhos de valor
 * relevante sem número de processo administrativo NEM processo licitatório
 * registrados.
 *
 * Conservador: empenhos de baixo valor e os tipicamente dispensáveis de
 * contrato formal não entram. A verificação do extrato no DOM exige fonte
 * adicional (DOM) não presente no contexto — registrado na explicação.
 */
export const detectorEmpenhoSemContrato: Detector = {
  id: 'XS-07',
  nome: 'Empenho sem contrato/processo publicado',
  categoria: 'Cruzamentos cross-source',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const semVinculo = ctx.empenhos.filter(
      (e) =>
        e.valorEmpenhado >= LIMIAR_XS07 &&
        !e.processoAdministrativo &&
        !e.processoLicitatorio &&
        // Ente público (transferência intra-governamental, duodécimo, repasse
        // ao RPPS) NÃO é "fornecedor" — não pode virar alerta de fornecedor.
        !ehEntidadePublica(e.cpfCnpj, e.fornecedorNome) &&
        // Só CNPJ válido — pagamento a CPF (subsídio, diária, folha) não é
        // "contratação" e legitimamente não tem processo administrativo/
        // licitatório; não é indício de contratação sem contrato.
        cnpjValido(e.cpfCnpj),
    );
    if (semVinculo.length === 0) return [];

    const porCnpj = new Map<string, EmpenhoNorm[]>();
    for (const e of semVinculo) {
      const chave = e.cpfCnpj || `sem-cnpj-${e.id}`;
      const arr = porCnpj.get(chave) ?? [];
      arr.push(e);
      porCnpj.set(chave, arr);
    }

    for (const [chave, lista] of porCnpj) {
      const soma = lista.reduce((s, e) => s + e.valorEmpenhado, 0);
      const nome = lista.find((e) => e.fornecedorNome)?.fornecedorNome || chave;
      out.push({
        detectorId: 'XS-07',
        detectorNome: 'Empenho sem contrato/processo publicado',
        categoria: 'Cruzamentos cross-source',
        titulo: `Empenho relevante sem processo localizável — ${nome}`,
        descricao:
          `${lista.length} empenho(s) acima de ${formatBRL(LIMIAR_XS07)} sem número de ` +
          `processo administrativo nem licitatório registrado, somando ${formatBRL(soma)}. ` +
          `Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj || chave,
        sujeitoRotulo: nome,
        classificacao: soma >= 500_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 60,
          probabilidadeIrregularidade: Math.min(70, 36 + lista.length * 6),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 95', 'LC 131/2009'],
        evidencias: lista.slice(0, 8).map((e) => ({
          resumo: `Empenho ${e.numeroEmpenho || e.id} — ${formatBRL(e.valorEmpenhado)}`,
          valor: e.valorEmpenhado,
          data: e.data,
        })),
        explicacao:
          'Contratações relevantes devem ter contrato/processo localizável e ' +
          'publicado (Lei 14.133/2021 art. 95; LC 131/2009). Empenhos de valor ' +
          'expressivo sem processo administrativo nem licitatório vinculado são ' +
          'possível indício a apurar — pode também ser lacuna de preenchimento no ' +
          'portal. DEPENDÊNCIA: a confirmação cruzada com o extrato no DOM exige a ' +
          'fonte do Diário Oficial, fora do contexto desta análise.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// FP-11 (Despesa de pessoal em alta vs. receita) — implementado em
// `folha-receita-cat.ts`. Removido daqui para não duplicar o ID.
