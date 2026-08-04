/**
 * Conector dos ACORDOS DE LENIÊNCIA (CGU) — NEXO.
 *
 * Lado Next.js da coleção `nexo_leniencia`, ingerida mensalmente pelo cron
 * `onNexoSyncLeniencia` (functions/src/nexo/coleta-leniencia.ts) a partir da
 * API do Portal da Transparência Federal:
 *   GET /api-de-dados/acordos-leniencia?cnpjSancionado={cnpj}&pagina=N
 *
 * Acordo de leniência (Lei 12.846/2013, arts. 16–17) é o ajuste pelo qual a
 * empresa que praticou ato lesivo COLABORA com a investigação em troca de
 * atenuação de sanções. Celebrar o acordo é LÍCITO — mas é fato relevante de
 * devida diligência quando a empresa segue recebendo recurso municipal; e o
 * DESCUMPRIMENTO do acordo (art. 16, §8º) é indício grave, pois restaura a
 * exposição às sanções atenuadas.
 *
 * Este módulo NÃO faz fetch: só reidrata os docs crus de `nexo_leniencia`
 * para o formato que o detector FR-05 consome — mesmo papel que
 * `consultasDeDocsSancoes` cumpre em `sancoes-federais.ts` para o FR-04.
 *
 * Apenas dados públicos — todo acordo é fato cadastral oficial; o uso
 * analítico é sempre indício a apurar, nunca acusação.
 */
import { soDigitos } from '../normalizar';

// ── Tipos ────────────────────────────────────────────────────────────────────

/** Um acordo de leniência normalizado (formato gravado em `nexo_leniencia`). */
export interface AcordoLeniencia {
  /** ID do registro na CGU — habilita o deep-link de detalhe no portal. */
  idAcordo: string;
  /** CNPJ da empresa abrangida — apenas dígitos. */
  cnpjSancionado: string;
  /** Razão social da empresa abrangida. */
  razaoSocial: string;
  /** Situação do acordo (ex.: "Acordo em vigência", "Acordo descumprido"). */
  situacaoAcordo: string;
  /** Órgão responsável pelo acordo (ex.: CGU/AGU). */
  orgaoResponsavel: string;
  /** Início da vigência em ISO `yyyy-MM-dd`, ou null. */
  dataInicio: string | null;
  /** Fim da vigência em ISO `yyyy-MM-dd`, ou null. */
  dataFim: string | null;
  /** Quantas empresas o acordo abrange. */
  qtdEmpresasAbrangidas: number;
}

/** Resultado da verificação de UM CNPJ contra o cadastro de leniência. */
export interface ConsultaLenienciaCnpj {
  /** CNPJ verificado — apenas dígitos. */
  cnpj: string;
  /** Acordos de leniência que abrangem o CNPJ (vazio = verificado e limpo). */
  acordos: AcordoLeniencia[];
}

// ── Reidratação dos docs de `nexo_leniencia` para o detector ─────────────────

/** Coage um acordo JÁ normalizado (gravado em `nexo_leniencia`). */
function coagirAcordo(v: unknown): AcordoLeniencia | null {
  if (v == null || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  return {
    idAcordo: String(r.idAcordo ?? '').trim(),
    cnpjSancionado: soDigitos(r.cnpjSancionado as string),
    razaoSocial: String(r.razaoSocial ?? ''),
    situacaoAcordo: String(r.situacaoAcordo ?? ''),
    orgaoResponsavel: String(r.orgaoResponsavel ?? ''),
    dataInicio: typeof r.dataInicio === 'string' ? r.dataInicio : null,
    dataFim: typeof r.dataFim === 'string' ? r.dataFim : null,
    qtdEmpresasAbrangidas:
      typeof r.qtdEmpresasAbrangidas === 'number' ? r.qtdEmpresasAbrangidas : 0,
  };
}

/**
 * Converte os docs CRUS de `nexo_leniencia` (um por CNPJ verificado, com o
 * sub-array `acordos` já normalizado) em `ConsultaLenienciaCnpj[]` para
 * alimentar o detector FR-05 — tanto no pipeline persistido
 * (`/api/nexo/detectar`) quanto na análise ao vivo (`/api/nexo/analise`).
 * Descarta CNPJ inválido (≠14 dígitos). Espelha `consultasDeDocsSancoes`.
 */
export function acordosDeDocsLeniencia(
  docs: Record<string, unknown>[],
): ConsultaLenienciaCnpj[] {
  const out: ConsultaLenienciaCnpj[] = [];
  for (const d of docs) {
    const cnpj = soDigitos((d.cnpj ?? d._cnpj) as string);
    if (cnpj.length !== 14) continue;
    const acordos = (Array.isArray(d.acordos) ? d.acordos : [])
      .map(coagirAcordo)
      .filter((a): a is AcordoLeniencia => a !== null);
    out.push({ cnpj, acordos });
  }
  return out;
}
