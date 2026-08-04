/**
 * Registry e runner do motor de detecção do NEXO.
 *
 * Detectores ativos do pipeline de análise. O catálogo completo tem 172
 * monitoramentos (ver src/lib/nexo/catalogo-completo.ts e
 * docs/nexo/02-catalogo-de-monitoramentos.md) — os demais entram
 * incrementalmente ou dependem de fonte sem API pública.
 */
import { detectorFracionamento } from './fracionamento';
import { detectorConcentracao } from './concentracao';
import { detectorGrupoCnpj } from './grupo-cnpj';
import { detectorDiarias } from './diarias';
import { detectorModalidade } from './modalidade';
import { detectorEmpenhoSemLiquidacao } from './liquidacao';
import { detectorRestosAPagar } from './restos';
import {
  detectorFracionamentoObjeto,
  detectorFracionamentoSecretarias,
  detectorValorColado,
  detectorSequenciaAbaixoLimite,
} from './licitacoes-extra';
import {
  detectorEmpenhoAnulado,
  detectorEmpenhosFimExercicio,
  detectorReforcoAtipico,
} from './orcamento';
import { detectorDiariasMesmaData, detectorGrupoViajantes } from './diarias-extra';
import {
  detectorPostoConcentrado,
  detectorCombustivelAtipico,
  detectorFornecedorSaudeConcentrado,
  detectorLocacaoSaude,
  detectorVencedorVariasUGs,
} from './setoriais';
import {
  detectorPagamentoSemEmpenho,
  detectorLiquidacaoSemEmpenho,
  detectorOrdemCronologica,
  detectorDotacaoAcima100,
  detectorElementoIncompativel,
} from './orcamento-extra';
import {
  detectorInexigibilidadeFragil,
  detectorModalidadeIncompativel,
  detectorEmpenhoSemItens,
} from './licitacoes-comp';
import {
  detectorViagensRepetidasDestino,
  detectorLocomocaoDesproporcional,
  detectorPicoPublicidadeEleitoral,
} from './diarias-comp';
import { detectorCnaeIncompativel } from './fornecedores-comp';
import { detectorEmpenhoSemContrato } from './cross-comp';
import { detectorSancoesFornecedor } from './sancoes-det';
import { detectorSancoesEstaduaisFornecedor } from './sancoes-estaduais-det';
import { detectorLenienciaFornecedor } from './leniencia-det';
import { detectorDivergenciaTce } from './tce-divergencia-det';
import { detectorSocioComum } from './socio-comum-det';
import { detectorDoadorPolitico } from './doador-politico-det';
import { detectorContasIrregulares } from './contas-irregulares-det';
import { detectorPedaladaFiscal } from './pedalada-fiscal';
import { detectorEmpresaFantasma } from './empresa-fantasma';
import { detectorSuperfaturamento } from './superfaturamento';
import { detectorFuncionarioFantasma } from './funcionario-fantasma';
import { detectorDesvioVerbaVinculada } from './desvio-verba-vinculada';
import { detectorRAPArt42 } from './rap-art42';
import { detectorSuprimentoFundos } from './suprimento-fundos';
import { detectorPrecatorios } from './precatorios';
import { detectorIndiceLiquidez } from './indice-liquidez';
import { detectorDuodecimo } from './duodecimo';
import { detectorResultadoFiscal } from './resultado-fiscal';
import { detectorChecklistTransparencia } from './checklist-transparencia';
import { detectorBenford } from './benford-det';
import { detectorOutlierPreco } from './anomalia-preco';
import { detectorValorProximoTetoDispensa } from './anomalia-teto';
import { detectorConcentracaoOrgaoFornecedor } from './anomalia-concentracao';
import { DETECTORES_LC_CAT } from './licitacoes-cat';
import { DETECTORES_OB_CAT } from './obras-cat';
import { DETECTORES_FS_CAT } from './frota-saude-cat';
import { DETECTORES_ED_CAT } from './emergenciais-diarias-cat';
import { DETECTORES_FR_CAT } from './folha-receita-cat';
import { DETECTORES_DIV_CAT } from './diversos-cat';
import { DETECTORES_XS_CAT } from './cross-cat';
import { DETECTORES_PLANEJADOS_EXTRA } from './planejados-extra';
import type { AlertaDetectado, ContextoAnalise, Detector } from './tipos';
import { compararPotencial } from '../prioridade';
import { ehEntidadePublica, docValido } from '../entidades';
import { PISO_CONFIABILIDADE_DOC_INVALIDO } from '../calibragem';

export * from './tipos';

/**
 * Métricas por execução do motor (A9 do plano de calibragem) — quantos alertas
 * cada detector emitiu e quantos o pós-filtro central descartou/rebaixou. A
 * rota `/api/nexo/detectar` devolve isto e grava em `nexo_sync_state` para o
 * painel medir os detectores mais ruidosos e ajustar `calibragem.ts`.
 */
export interface MetricasDeteccao {
  porDetector: Record<string, { emitidos: number; filtradosPublico: number; docCapado: number }>;
  totalEmitidos: number;
  totalFiltradosPublico: number;
  totalDocCapado: number;
}

export const DETECTORES: readonly Detector[] = [
  detectorFracionamento,
  detectorConcentracao,
  detectorGrupoCnpj,
  detectorDiarias,
  detectorModalidade,
  detectorEmpenhoSemLiquidacao,
  detectorRestosAPagar,
  detectorPedaladaFiscal,
  detectorFracionamentoObjeto,
  detectorFracionamentoSecretarias,
  detectorValorColado,
  detectorSequenciaAbaixoLimite,
  detectorEmpenhoAnulado,
  detectorEmpenhosFimExercicio,
  detectorReforcoAtipico,
  detectorDiariasMesmaData,
  detectorGrupoViajantes,
  detectorPostoConcentrado,
  detectorCombustivelAtipico,
  detectorFornecedorSaudeConcentrado,
  detectorLocacaoSaude,
  detectorVencedorVariasUGs,
  // ── Detectores computáveis adicionados (área OR/LC/DE/FR/XS/FP) ──
  detectorPagamentoSemEmpenho,
  detectorLiquidacaoSemEmpenho,
  detectorOrdemCronologica,
  detectorDotacaoAcima100,
  detectorElementoIncompativel,
  detectorInexigibilidadeFragil,
  detectorModalidadeIncompativel,
  detectorEmpenhoSemItens,
  detectorViagensRepetidasDestino,
  detectorLocomocaoDesproporcional,
  detectorPicoPublicidadeEleitoral,
  detectorCnaeIncompativel,
  detectorFuncionarioFantasma,
  detectorEmpenhoSemContrato,
  // ── Cross-source LIGADO: sancionado × empenho (FR-04). Lê ctx.sancoes
  //    (de nexo_sancoes); degrada para [] se a fonte não foi anexada. ──
  detectorEmpresaFantasma,
  detectorSuperfaturamento,
  detectorDesvioVerbaVinculada,
  detectorRAPArt42,
  detectorSuprimentoFundos,
  detectorPrecatorios,
  detectorIndiceLiquidez,
  detectorDuodecimo,
  detectorResultadoFiscal,
  detectorChecklistTransparencia,
  detectorSancoesFornecedor,
  // ── Cross-source LIGADO: sanção ESTADUAL (Relação de Apenados do TCE-SP) ×
  //    empenho (FR-04E). Lê ctx.sancoesEstaduais (de nexo_sancoes_estaduais);
  //    degrada para [] se a fonte não foi anexada. Vigente → 'suspeita'
  //    (impedimento estadual pode ser restrito ao ente sancionador). ──
  detectorSancoesEstaduaisFornecedor,
  // ── Cross-source LIGADO: acordo de leniência × empenho (FR-05). Lê
  //    ctx.leniencia (de nexo_leniencia); degrada para [] sem a fonte.
  //    Descumprido → crítico; em vigência → atenção (acordo é LÍCITO). ──
  detectorLenienciaFornecedor,
  // ── Cross-source LIGADO: divergência SMARAPD × TCE-SP por nº empenho (X2).
  //    Lê ctx.tceDespesas (de nexo_tce_despesas); degrada para [] sem a fonte. ──
  detectorDivergenciaTce,
  // ── Cross-source: sócio em comum entre fornecedores com empenho (XS-SOCIO).
  //    Lê ctx.socios (grafo de sócios/QSA, anonimizado); degrada para [] sem a
  //    fonte. Indício de grupo econômico/possível cartel a apurar ('atencao'). ──
  detectorSocioComum,
  // ── Cross-source: fornecedor/sócio doador de campanha (XS-DOADOR). Lê
  //    ctx.doacoesTse (+ ctx.socios, ctx.hashDocFn opcional); degrada para []
  //    sem o TSE. Doação é LÍCITA: potencial conflito a verificar ('atencao'). ──
  detectorDoadorPolitico,
  // ── Cross-source: fornecedor/sócio com contas julgadas irregulares no TCE-SP
  //    (XS-14). Lê ctx.contasIrregulares (+ ctx.socios); degrada para [] sem a
  //    relação do TCE. CPF anonimizado na fonte: casa por NOME (homonímia →
  //    'informativo') ou nome+CPF parcial ('atencao'). NUNCA afirma
  //    inelegibilidade (é decisão da Justiça Eleitoral); SEM Lei 8.429. ──
  detectorContasIrregulares,
  // ── Estatística forense: Lei de Benford sobre os valores de empenho (BN-01).
  //    Sinal agregado de direcionamento/fracionamento sistêmico (nunca crítico). ──
  detectorBenford,
  // ── Anomalia estatística (AN-01/04/03): outlier de preço por elemento/objeto
  //    (Iglewicz-Hoaglin), valor colado no teto de dispensa (limites.ts) e
  //    concentração órgão→fornecedor (HHI). Indício a apurar; degradam sem fonte. ──
  detectorOutlierPreco,
  detectorValorProximoTetoDispensa,
  detectorConcentracaoOrgaoFornecedor,
  // ── Catálogo completo — detectores das 14 áreas (172 monitoramentos). ──
  // Cada detector roda sobre o ContextoAnalise; os que dependem de fonte ainda
  // não coletada degradam para [] honestamente (ver comentário de cada um).
  ...DETECTORES_LC_CAT,
  ...DETECTORES_OB_CAT,
  ...DETECTORES_FS_CAT,
  ...DETECTORES_ED_CAT,
  ...DETECTORES_FR_CAT,
  ...DETECTORES_DIV_CAT,
  ...DETECTORES_XS_CAT,
  // ── Planejados→computáveis: proxies de reforço/aditivo sobre `despesas`
  //    (OB-11, EM-06). Stubs homônimos nos blocos -cat.ts seguem em [] (seguro). ──
  ...DETECTORES_PLANEJADOS_EXTRA,
];

/**
 * Executa todos os detectores. Um detector que falhe não derruba os demais.
 *
 * PÓS-FILTRO CENTRAL INVARIANTE (A1 do plano de calibragem): descarta todo
 * alerta de FORNECEDOR cujo sujeito é ENTE PÚBLICO (`ehEntidadePublica`). É a
 * rede de segurança contra o falso positivo clássico — "PREFEITURA MUNICIPAL
 * fornecendo a ela mesma" no fracionamento — que nenhum detector novo escapa
 * (o filtro era aplicado detector-a-detector e ~20 arquivos esqueciam, incl. o
 * `fracionamento.ts`). NÃO toca `sujeitoTipo:'orgao'` (ente público é sujeito
 * legítimo ali). GATE DE DOCUMENTO (A3): fornecedor com documento ausente/
 * inválido tem a confiabilidade capada — join fraco (por nome) não pode
 * pontuar como join forte (por CNPJ).
 *
 * `metricas` (opcional) é preenchido para a rota expor no painel (A9).
 */
export function rodarDetectores(
  ctx: ContextoAnalise,
  metricas?: MetricasDeteccao,
): AlertaDetectado[] {
  const alertas: AlertaDetectado[] = [];
  const tally = (id: string, campo: 'emitidos' | 'filtradosPublico' | 'docCapado') => {
    if (!metricas) return;
    (metricas.porDetector[id] ??= { emitidos: 0, filtradosPublico: 0, docCapado: 0 })[campo]++;
  };
  const descartesPublico: Record<string, number> = {};

  for (const detector of DETECTORES) {
    try {
      const doDetector = detector.detectar(ctx);
      for (const a of doDetector) {
        tally(a.detectorId, 'emitidos');
        if (metricas) {
          metricas.totalEmitidos++;
        }
        // A1 — ente público como FORNECEDOR nunca vira indício.
        if (a.sujeitoTipo === 'fornecedor' && ehEntidadePublica(a.sujeitoId, a.sujeitoRotulo)) {
          descartesPublico[a.detectorId] = (descartesPublico[a.detectorId] ?? 0) + 1;
          tally(a.detectorId, 'filtradosPublico');
          if (metricas) metricas.totalFiltradosPublico++;
          continue;
        }
        // A3 — fornecedor sem documento válido: join por nome é fraco; capa a
        // confiabilidade e anota (não descarta — pode ser CNPJ ausente na fonte).
        if (a.sujeitoTipo === 'fornecedor' && !docValido(a.sujeitoId)) {
          if (a.scores.confiabilidade > PISO_CONFIABILIDADE_DOC_INVALIDO) {
            a.scores.confiabilidade = PISO_CONFIABILIDADE_DOC_INVALIDO;
            a.explicacao =
              (a.explicacao ? a.explicacao + ' ' : '') +
              '(Confiabilidade rebaixada: documento do fornecedor ausente/inválido na fonte — vínculo por nome, a confirmar.)';
            tally(a.detectorId, 'docCapado');
            if (metricas) metricas.totalDocCapado++;
          }
        }
        alertas.push(a);
      }
    } catch (err) {
      // Detector isolado — falha individual não interrompe a análise. Erro de
      // PROGRAMAÇÃO (ReferenceError/TypeError — ex.: import faltando) é bug, não
      // falha de dado: logamos como ERROR e marcamos no nome p/ não virar
      // silêncio operacional (um detector que some é pior que um que acusa).
      const ehBug =
        err instanceof ReferenceError || err instanceof TypeError;
      console[ehBug ? 'error' : 'warn'](
        `[nexo] detector ${detector.id} ${ehBug ? 'QUEBRADO (bug)' : 'falhou'}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const totalDescartes = Object.values(descartesPublico).reduce((s, n) => s + n, 0);
  if (totalDescartes > 0) {
    const detalhe = Object.entries(descartesPublico)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${id}:${n}`)
      .join(' ');
    console.info(`[nexo] calibragem: ${totalDescartes} alertas de ente público filtrados (${detalhe})`);
  }

  // Ordena por POTENCIAL (score triplo) desc, com desempate por recência/valor.
  return alertas.sort(compararPotencial);
}
