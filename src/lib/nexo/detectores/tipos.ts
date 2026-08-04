/**
 * Contratos do motor de detecção do NEXO.
 *
 * Um detector recebe um contexto de análise e devolve alertas — sempre como
 * indício a apurar, nunca acusação. Ver docs/nexo-plano-mestre.md §6–§7.
 */
import type {
  EmpenhoNorm,
  DiariaNorm,
  ModalidadeTotal,
  RestoPagarNorm,
  DespesaNorm,
} from '../normalizar';
// `import type` é apagado em compile-time — não puxa o conector server-only
// (process.env/fetch) para o bundle; só o formato do dado cross-source.
import type { ConsultaSancaoCnpj } from '../sources/sancoes-federais';
// Tipo da 2ª fonte oficial (TCE-SP). `import type` é erased — sem ciclo runtime.
import type { TceDespesaNorm } from './tce-divergencia-det';
// Grafo societário (QSA) e doações TSE — anonimizados (hash/máscara).
import type { SocioCtx } from './socio-comum-det';
import type { DoacaoCtx } from './doador-politico-det';
// Acordos de leniência (CGU) — `import type` erased, sem ciclo runtime.
import type { ConsultaLenienciaCnpj } from '../sources/leniencia';

export type Classificacao = 'informativo' | 'atencao' | 'suspeita' | 'critico';

/** Procedência documental de uma evidência — de onde o dado saiu (prova). */
export interface Procedencia {
  /** Sistema-fonte. ('CGU' = Portal da Transparência Federal — sanções/leniência.) */
  fonte: 'SMARAPD' | 'PNCP' | 'SICONFI' | 'TCE-SP' | 'DOM' | 'PORTAL-MARILIA' | 'CGU';
  /** Rótulo do botão, ex.: 'Ver empenho no Portal da Transparência'. */
  label: string;
  /** URL da prova: deep-link, URL de API determinística, ou PDF. */
  url: string;
  /** Controla ícone e se renderiza preview. */
  tipoDoc: 'pdf' | 'pagina' | 'api-json' | 'modulo';
  /** true quando a url é um PDF inline-embedável (preview no iframe). */
  podePreview: boolean;
  /** Ponteiro ao registro BRUTO coletado (prova de 2º nível). */
  refColecao?: string;
  refId?: string;
}

export interface Evidencia {
  resumo: string;
  valor?: number;
  data?: string | null;
  ref?: string;
  /** Procedência documental (opcional, retrocompatível). */
  procedencia?: Procedencia;
}

export interface AlertaDetectado {
  /** ID do detector no esquema unificado (ex.: 'LC-01'). */
  detectorId: string;
  detectorNome: string;
  categoria: string;
  titulo: string;
  descricao: string;
  sujeitoTipo: 'fornecedor' | 'contrato' | 'empenho' | 'servidor' | 'orgao';
  sujeitoId: string;
  sujeitoRotulo: string;
  classificacao: Classificacao;
  /** Score triplo — ver plano-mestre §7. */
  scores: {
    confiabilidade: number;
    probabilidadeIrregularidade: number;
    /**
     * 3ª perna do score triplo (probabilidade de enquadramento legal, 0–100).
     * Opcional: detectores antigos não preenchem; o cálculo de prioridade usa
     * default 50 (ou derivado do fundamento legal) quando ausente.
     */
    probabilidadeEnquadramento?: number;
  };
  fundamentoLegal: string[];
  evidencias: Evidencia[];
  explicacao: string;
  /** Valor financeiro envolvido (R$) — usado para ordenar e priorizar. */
  valorEnvolvido: number;
  /**
   * Discriminador estável do episódio — distingue múltiplos indícios do mesmo
   * detector+sujeito (ex.: a janela trimestral de um fracionamento). Compõe a
   * `chaveDeteccao` para o alerta não duplicar a cada execução do monitor.
   * Opcional: na ausência, há 1 alerta por detector+sujeito.
   */
  discriminador?: string;
}

export interface ContextoAnalise {
  exercicio: number;
  empenhos: EmpenhoNorm[];
  diarias: DiariaNorm[];
  /** Totais de empenho por modalidade licitatória (visão agregada). */
  modalidades: ModalidadeTotal[];
  restosAPagar: RestoPagarNorm[];
  /** Despesas do módulo DespesaAgrupada — com objeto, elemento e tipo. */
  despesas: DespesaNorm[];
  /** Soma de tudo que foi coletado nesta análise. */
  totalEmpenhado: number;
  /** true quando a coleta trouxe só uma amostra (não o exercício inteiro). */
  amostra: boolean;

  // ── Fontes CRUZADAS (cross-source) — opcionais e retrocompatíveis ──────────
  // Não são por-exercício: refletem o estado atual da 2ª fonte. Um detector que
  // não recebe a fonte degrada para [] honestamente (cruzamento inativo).
  /**
   * Sanções federais (CEIS/CNEP/CEPIM) por CNPJ — uma consulta por fornecedor
   * verificado, vindas de `nexo_sancoes`. Alimenta o FR-04 (sancionado×empenho).
   */
  sancoes?: ConsultaSancaoCnpj[];
  /**
   * Sanções ESTADUAIS (Relação de Apenados do TCE-SP, cadastro TCE-SP-APENADOS)
   * por CNPJ — uma verificação por fornecedor, vindas de `nexo_sancoes_estaduais`.
   * Alimenta o FR-04E (sancionado-TCE×empenho). Reusa `ConsultaSancaoCnpj` (o
   * mesmo formato do federal). Ausente → cruzamento inativo (detector degrada
   * para []).
   */
  sancoesEstaduais?: ConsultaSancaoCnpj[];
  /**
   * Data ISO `yyyy-MM-dd` de referência para aferir vigência de sanção/prazo
   * nos cruzamentos. Default (quando ausente): hoje, no detector.
   */
  dataReferencia?: string;
  /**
   * Acordos de leniência (CGU, Lei 12.846/2013 arts. 16–17) por CNPJ — uma
   * verificação por fornecedor, vindas de `nexo_leniencia`. Alimenta o FR-05
   * (leniência×empenho). Ausente → cruzamento inativo (detector degrada p/ []).
   */
  leniencia?: ConsultaLenienciaCnpj[];
  /**
   * Despesas do TCE-SP por nº empenho (2ª fonte oficial, de `nexo_tce_despesas`).
   * Alimenta o detector X2 (divergência SMARAPD×TCE). Exercise-scoped. Ausente →
   * cruzamento inativo (detector degrada para []).
   */
  tceDespesas?: TceDespesaNorm[];
  /**
   * Grafo societário (QSA) por fornecedor — de `nexo_socios`, anonimizado
   * (cpfHash/cpfMasc). Alimenta o XS-SOCIO (sócio em comum entre fornecedores).
   */
  socios?: SocioCtx[];
  /**
   * Doações de campanha (TSE) por doador (`docHash`) — de `nexo_doacoes_tse`.
   * Alimenta o XS-DOADOR. DOAÇÃO É ATO LÍCITO: o detector trata como vínculo a
   * apurar, nunca acusação. Ausente → cruzamento inativo.
   */
  doacoesTse?: DoacaoCtx[];
  /**
   * A MESMA função `hashDoc` que gerou cpfHash/docHash — deixa o XS-DOADOR
   * hashear o CNPJ do fornecedor p/ casar com `doacoesTse`. Opcional (sem ela,
   * o XS-DOADOR casa só por sócio — cobertura parcial honesta).
   */
  hashDocFn?: (doc: string) => string;
}

export interface Detector {
  id: string;
  nome: string;
  categoria: string;
  detectar(ctx: ContextoAnalise): AlertaDetectado[];
}
