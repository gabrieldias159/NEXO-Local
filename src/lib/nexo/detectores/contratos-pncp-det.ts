/**
 * Detectores sobre contratos do PNCP — NEXO.
 *
 * Operam sobre `ContratoPNCP[]` (já normalizado pelo conector PNCP) e medem
 * desvios computáveis a partir de dados de contrato:
 *
 *  - LC-19 — Aditivo acima do limite legal: a soma dos aditivos de valor (ou,
 *    na falta da lista de aditivos, a diferença valorGlobal − valorInicial)
 *    ultrapassa 25% do valor original — ou 50% quando o objeto é reforma de
 *    edifício/equipamento (Lei 14.133/2021, art. 125).
 *  - LC-20 — Prorrogações sucessivas de prazo: contrato com ≥2 aditivos de
 *    prazo. O PNCP não publica o prazo de vigência original separadamente, por
 *    isso o detector sinaliza a recorrência das prorrogações — não um
 *    percentual estimado (Lei 14.133/2021, art. 124–125).
 *
 * Linguagem "indício, nunca acusação": todo alerta é possível indício a
 * apurar pelas instituições competentes. Apenas dados públicos.
 *
 * Ver docs/nexo/02-catalogo-de-monitoramentos.md (LC-19, LC-20).
 */
import { formatBRL } from '../normalizar';
import type { ContratoPNCP } from '../sources/pncp';
import type { AlertaDetectado } from './tipos';

const CATEGORIA = 'Contratos e licitações';

/** Teto de acréscimo de valor — art. 125 da Lei 14.133/2021. */
const LIMITE_ADITIVO = 0.25;
/** Teto majorado para reforma de edifício ou equipamento. */
const LIMITE_ADITIVO_REFORMA = 0.5;
/** Acima de 100% o aditivo de prazo iguala/supera o prazo original. */
const LIMITE_PRAZO = 1.0;

/** Heurística textual: o objeto do contrato é uma reforma? */
function ehReforma(objeto: string): boolean {
  return /\b(reforma|reform\w*|reabilita\w*|recupera\w*|restaur\w*)\b/i.test(
    objeto,
  );
}

/** Diferença em dias entre duas datas ISO (`yyyy-MM-dd`), ou null. */
function difDias(inicio: string | null, fim: string | null): number | null {
  if (!inicio || !fim) return null;
  const a = Date.parse(inicio);
  const b = Date.parse(fim);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = Math.round((b - a) / 86_400_000);
  return d > 0 ? d : null;
}

// ── LC-19 — Aditivo acima do limite legal ────────────────────────────────────

function detectarLC19(contratos: ContratoPNCP[]): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];

  for (const c of contratos) {
    if (c.valorInicial <= 0) continue;

    // Soma dos aditivos de valor; se a lista não veio, usa a diferença
    // valorGlobal − valorInicial como proxy do acréscimo acumulado.
    const somaAditivos = c.aditivos.reduce((s, a) => s + Math.max(0, a.valor), 0);
    const acrescimo =
      somaAditivos > 0
        ? somaAditivos
        : Math.max(0, c.valorGlobal - c.valorInicial);
    if (acrescimo <= 0) continue;

    const pct = acrescimo / c.valorInicial;
    const reforma = ehReforma(c.objeto);
    const limite = reforma ? LIMITE_ADITIVO_REFORMA : LIMITE_ADITIVO;
    if (pct <= limite) continue;

    const pctStr = (pct * 100).toFixed(1);
    const limiteStr = reforma ? '50%' : '25%';
    const nome =
      c.fornecedorNome || c.fornecedorDoc || 'fornecedor não identificado';
    const classificacao: AlertaDetectado['classificacao'] =
      pct > limite * 2 ? 'suspeita' : 'atencao';

    const evidencias: AlertaDetectado['evidencias'] = [
      {
        resumo: `Valor inicial: ${formatBRL(c.valorInicial)}`,
        valor: c.valorInicial,
      },
      {
        resumo: `Valor global atualizado: ${formatBRL(c.valorGlobal)}`,
        valor: c.valorGlobal,
      },
      {
        resumo: `Acréscimo acumulado: ${formatBRL(acrescimo)} (${pctStr}%)`,
        valor: acrescimo,
      },
    ];
    if (c.aditivos.length > 0) {
      evidencias.push({
        resumo: `${c.aditivos.length} termo(s) aditivo(s) registrado(s) no PNCP`,
      });
    } else {
      evidencias.push({
        resumo:
          'Lista de termos aditivos não detalhada pelo PNCP — acréscimo ' +
          'inferido da diferença entre valor global e valor inicial.',
      });
    }
    if (c.objeto) {
      evidencias.push({ resumo: `Objeto: ${c.objeto.slice(0, 160)}` });
    }

    out.push({
      detectorId: 'LC-19',
      detectorNome: 'Aditivo acima do limite',
      categoria: CATEGORIA,
      titulo: `Possível aditivo acima do limite (${pctStr}%) — ${nome}`,
      descricao:
        `Contrato ${c.numeroContrato || c.id}: acréscimo acumulado de ` +
        `${formatBRL(acrescimo)} sobre o valor inicial de ` +
        `${formatBRL(c.valorInicial)} — ${pctStr}%, acima do teto de ` +
        `${limiteStr}${reforma ? ' (objeto classificado como reforma)' : ''}.`,
      sujeitoTipo: 'contrato',
      sujeitoId: c.id,
      sujeitoRotulo: c.numeroContrato || c.id,
      classificacao,
      scores: {
        confiabilidade: c.aditivos.length > 0 ? 80 : 62,
        probabilidadeIrregularidade: Math.min(
          88,
          Math.round(40 + (pct - limite) * 100),
        ),
      },
      fundamentoLegal: ['Lei 14.133/2021, art. 125'],
      evidencias,
      explicacao:
        `O acréscimo acumulado dos aditivos representa ${pctStr}% do valor ` +
        `inicial, acima do limite de ${limiteStr} fixado no art. 125 da Lei ` +
        `14.133/2021. Trata-se de possível indício a apurar: a regularidade ` +
        `depende do tipo de objeto, da justificativa técnica e de eventuais ` +
        `supressões compensatórias. Não constitui acusação.`,
      valorEnvolvido: acrescimo,
    });
  }

  return out;
}

// ── LC-20 — Aditivo de prazo desproporcional ─────────────────────────────────

function detectarLC20(contratos: ContratoPNCP[]): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];

  for (const c of contratos) {
    // Aditivos que alteram a data-fim de vigência (prorrogações de prazo).
    const aditivosPrazo = c.aditivos.filter((a) => a.novaVigenciaFim);
    // O indício factual e verificável é a RECORRÊNCIA das prorrogações. O PNCP
    // não publica o prazo de vigência original separadamente — reconstruí-lo a
    // partir das datas dos termos aditivos produz razões infladas e falsos
    // positivos. O detector sinaliza ≥2 prorrogações sucessivas, sem fabricar
    // um percentual de prazo.
    if (aditivosPrazo.length < 2) continue;

    const datas = aditivosPrazo
      .map((a) => a.novaVigenciaFim)
      .filter((d): d is string => !!d)
      .sort();
    const inicio = c.dataVigenciaInicio ?? c.dataAssinatura;
    const fimAtual = c.dataVigenciaFim ?? datas[datas.length - 1] ?? null;

    const nome = c.fornecedorNome || 'fornecedor não identificado';
    const classificacao: AlertaDetectado['classificacao'] =
      aditivosPrazo.length >= 4 ? 'suspeita' : 'atencao';

    out.push({
      detectorId: 'LC-20',
      detectorNome: 'Prorrogações sucessivas de prazo',
      categoria: CATEGORIA,
      titulo: `Contrato prorrogado ${aditivosPrazo.length}× no prazo — ${nome}`,
      descricao:
        `O contrato ${c.numeroContrato || c.id} recebeu ${aditivosPrazo.length} ` +
        `aditivos de prazo` +
        (fimAtual ? `, com vigência atual até ${fimAtual}` : '') +
        `. Prorrogações sucessivas podem indicar planejamento deficiente ou ` +
        `descaracterização do objeto licitado.`,
      sujeitoTipo: 'contrato',
      sujeitoId: c.id,
      sujeitoRotulo: c.numeroContrato || c.id,
      classificacao,
      scores: {
        confiabilidade: 66,
        probabilidadeIrregularidade: Math.min(70, 34 + aditivosPrazo.length * 9),
      },
      fundamentoLegal: ['Lei 14.133/2021, art. 124–125'],
      evidencias: [
        { resumo: `${aditivosPrazo.length} aditivos de prazo registrados no PNCP` },
        ...(inicio
          ? [{ resumo: `Início de vigência: ${inicio}`, data: inicio }]
          : []),
        ...(fimAtual
          ? [{ resumo: `Vigência atual até ${fimAtual}`, data: fimAtual }]
          : []),
        ...(c.objeto ? [{ resumo: `Objeto: ${c.objeto.slice(0, 160)}` }] : []),
      ],
      explicacao:
        `O contrato teve a vigência prorrogada ${aditivosPrazo.length} vezes ` +
        `por aditivo de prazo. Aditivos de prazo são lícitos (art. 124–125 da ` +
        `Lei 14.133/2021), mas a recorrência merece verificar o cronograma de ` +
        `execução e se o objeto não foi descaracterizado. O PNCP não publica o ` +
        `prazo original separadamente, por isso o detector sinaliza a ` +
        `recorrência das prorrogações — não um percentual estimado. Possível ` +
        `indício a apurar, não constitui acusação.`,
      valorEnvolvido: c.valorGlobal,
    });
  }

  return out;
}

/**
 * Roda os detectores de contratos do PNCP (LC-19, LC-20) e devolve os
 * indícios ordenados por valor envolvido (decrescente).
 */
export function analisarContratosPNCP(
  contratos: ContratoPNCP[],
): AlertaDetectado[] {
  const alertas = [...detectarLC19(contratos), ...detectarLC20(contratos)];
  alertas.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  return alertas;
}
