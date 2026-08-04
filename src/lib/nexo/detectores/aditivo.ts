/**
 * Detector LC-19 — Aditivo acima do limite.
 *
 * Sinaliza contratos cujo valor global supera o valor inicial em mais de 25%
 * — o teto de acréscimo do art. 125 da Lei 14.133/2021 (50% para reforma de
 * edifício ou equipamento). Opera sobre contratos do PNCP.
 *
 * Catálogo: LC-19 "Aditivo acima do limite" (Σ aditivos / valor original >
 * 0,25 — ou 0,50 reforma). NÃO é o LC-05 ("Sequência logo abaixo do limite"),
 * que trata de compras diretas calibradas e está em `licitacoes-extra.ts`.
 *
 * Indício a apurar: o detector mede a variação de valor; a confirmação de
 * aditivo irregular depende do tipo de objeto e da justificativa técnica.
 */
import { formatBRL, type ContratoNorm } from '../normalizar';
import type { AlertaDetectado } from './tipos';

const LIMITE_ADITIVO = 0.25;

/** Roda o detector de aditivos sobre uma lista de contratos do PNCP. */
export function detectarAditivos(contratos: ContratoNorm[]): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];

  for (const c of contratos) {
    if (c.valorInicial <= 0 || c.valorGlobal <= 0) continue;
    const variacao = c.valorGlobal / c.valorInicial - 1;
    if (variacao <= LIMITE_ADITIVO) continue;

    const pct = variacao * 100;
    const nome = c.fornecedorNome || c.fornecedorDoc || 'fornecedor não identificado';
    const classificacao = pct > 50 ? 'suspeita' : 'atencao';
    const acrescimo = c.valorGlobal - c.valorInicial;

    out.push({
      detectorId: 'LC-19',
      detectorNome: 'Aditivo acima do limite',
      categoria: 'Contratos e licitações',
      titulo: `Contrato com acréscimo de ${pct.toFixed(0)}% — ${nome}`,
      descricao:
        `Contrato ${c.numeroContrato || c.id}: valor inicial ${formatBRL(c.valorInicial)}, ` +
        `valor global ${formatBRL(c.valorGlobal)} — acréscimo de ${formatBRL(acrescimo)} ` +
        `(${pct.toFixed(1)}%), acima do limite de 25%.`,
      sujeitoTipo: 'contrato',
      sujeitoId: c.id,
      sujeitoRotulo: c.numeroContrato || c.id,
      classificacao,
      scores: {
        confiabilidade: 80,
        probabilidadeIrregularidade: Math.min(88, Math.round(45 + pct)),
      },
      fundamentoLegal: ['Lei 14.133/2021, art. 125'],
      evidencias: [
        { resumo: `Valor inicial: ${formatBRL(c.valorInicial)}`, valor: c.valorInicial },
        { resumo: `Valor global: ${formatBRL(c.valorGlobal)}`, valor: c.valorGlobal },
        ...(c.objeto ? [{ resumo: `Objeto: ${c.objeto.slice(0, 140)}` }] : []),
      ],
      explicacao:
        `O valor global do contrato supera o inicial em ${pct.toFixed(1)}%. A Lei ` +
        `14.133/2021 (art. 125) limita acréscimos a 25% — 50% no caso de reforma. ` +
        `Requer verificar o tipo de objeto, os termos aditivos e a justificativa ` +
        `técnica de cada acréscimo.`,
      valorEnvolvido: acrescimo,
    });
  }

  return out;
}
