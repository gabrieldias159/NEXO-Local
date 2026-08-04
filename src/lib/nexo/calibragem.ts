/**
 * CALIBRAGEM central do motor de indícios (frente A do plano de reforma).
 *
 * Um lugar só para os "botões" de qualidade que antes ficavam enterrados em
 * constantes locais de cada detector. Girar aqui (com base nas métricas de
 * `nexo_sync_state`) recalibra o motor sem caçar número mágico em 30 arquivos.
 *
 * Ver docs/nexo-qualidade-indicios-auditoria.md.
 */

/**
 * Objetos genéricos/catch-all — grupo heterogêneo onde comparar preço ou inferir
 * fracionamento é inválido (agrupa naturezas distintas). Fonte única reusada por
 * AN-01 (anomalia de preço) e LC-02/LC-03 (fracionamento). O corte deste ruído
 * no AN-01 sozinho tirou ~42% do backlog (commit 1b3afa7).
 */
export const OBJETOS_GENERICOS = new Set([
  '', 'geral', 'diversos', 'diversas', 'outros', 'outras', 'varios', 'varias',
  'nao informado', 'sem objeto', 'material de consumo', 'servicos diversos',
]);

/** Normaliza objeto p/ casar com OBJETOS_GENERICOS (sem acento/caixa/espaço). */
export function objetoEhGenerico(objeto: string | null | undefined): boolean {
  const s = (objeto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return OBJETOS_GENERICOS.has(s);
}

/** Tipos de empenho que NÃO devem contar como "nova compra" no fracionamento
 *  (reforço e anulação referenciam um empenho já contado → dupla contagem). */
export function tipoEmpenhoContaComoCompra(tipo: string | null | undefined): boolean {
  const t = (tipo ?? '').toLowerCase();
  return !t.includes('reforc') && !t.includes('reforç') && !t.includes('anula');
}

/** Teto de confiabilidade quando o fornecedor não tem documento válido (join
 *  por nome é fraco — não pode pontuar como join forte por CNPJ). Aplicado no
 *  pós-filtro central de `rodarDetectores`. */
export const PISO_CONFIABILIDADE_DOC_INVALIDO = 55;

/**
 * Piso de EXIBIÇÃO: abaixo desta confiança consolidada o indício é rebaixado
 * para a aba "baixa confiança" (não some — auditável). Aplicado na rota
 * `/api/nexo/alertas`. 45 = corta a cauda de proxies textuais fracas sem
 * esconder indício de origem oficial.
 */
export const PISO_EXIBICAO_CONFIANCA = 45;

/**
 * Régua de CONFIABILIDADE por origem do dado (0–100) — documentada para os
 * detectores se alinharem (hoje há dezenas de "70" mágicos). Não força nada em
 * runtime; é referência + usada por `confiancaIndicio`.
 *  - oficialCruzado: cruzamento de 2 fontes oficiais (TCE×SMARAPD, CGU×empenho);
 *  - oficialPrimario: uma fonte oficial (SMARAPD/PNCP/portal);
 *  - estatistico: anomalia estatística (Benford, outlier) — sinal, não prova;
 *  - proxyTextual: heurística de texto (objeto genérico, nome) — o mais fraco.
 */
export const REGUA_CONFIABILIDADE = {
  oficialCruzado: 85,
  oficialPrimario: 68,
  estatistico: 55,
  proxyTextual: 48,
} as const;

/**
 * Calibragem por detector. `pisoValor` = materialidade mínima (R$) para o
 * indício sair de 'informativo'; `minOcorrencias` = repetições mínimas;
 * `topK` = teto de itens persistidos por execução (foco na worklist);
 * `ativo:false` desliga o detector sem removê-lo do registry.
 * Ausência de entrada = sem piso extra (comportamento atual).
 */
export interface CalibragemDetector {
  pisoValor?: number;
  minOcorrencias?: number;
  topK?: number;
  ativo?: boolean;
}

export const CALIBRAGEM: Record<string, CalibragemDetector> = {
  // Fracionamento e sequências abaixo do teto — materialidade mínima evita
  // acusar 3 notas de material de escritório de R$ 200.
  'LC-01': { pisoValor: 8_000, minOcorrencias: 3, topK: 200 },
  'LC-02': { pisoValor: 8_000, minOcorrencias: 3, topK: 200 },
  'LC-03': { pisoValor: 8_000, topK: 200 },
  'LC-05': { pisoValor: 8_000, minOcorrencias: 3, topK: 200 },
  // Anomalia estatística — já filtra objeto genérico; cap de saída.
  'AN-01': { topK: 150 },
  'AN-04': { pisoValor: 8_000, topK: 150 },
};

/** Consulta a calibragem de um detector (nunca lança; default vazio). */
export function calibragemDe(detectorId: string): CalibragemDetector {
  return CALIBRAGEM[detectorId] ?? {};
}

/**
 * Confiança consolidada do indício (0–100) — combina a confiabilidade que o
 * detector reportou (origem/força do join) com corroboração cruzada (o mesmo
 * sujeito acusado por N detectores é mais crível) e materialidade. Usada para o
 * piso de exibição. Conservadora: nunca REBAIXA um indício de origem forte só
 * por ser único; só PROMOVE quando há corroboração.
 */
export function confiancaIndicio(input: {
  confiabilidade: number;
  corroboracoes: number; // nº de detectores distintos sobre o mesmo sujeito
  valorEnvolvido: number;
}): number {
  let c = input.confiabilidade;
  if (input.corroboracoes >= 3) c += 12;
  else if (input.corroboracoes === 2) c += 6;
  if (input.valorEnvolvido >= 100_000) c += 6;
  else if (input.valorEnvolvido >= 25_000) c += 3;
  return Math.max(0, Math.min(100, Math.round(c)));
}
