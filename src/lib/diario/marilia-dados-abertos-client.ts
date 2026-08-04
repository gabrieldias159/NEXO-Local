/**
 * Cliente para a API de Dados Abertos da Prefeitura de Marília.
 *
 * Endpoint: https://www.marilia.sp.gov.br/portal/dados-abertos/diario-oficial/{ano}
 *
 * Retorna TODAS as edições do ano em um único JSON, com:
 *  - `edicao`: número da edição (string)
 *  - `data`: timestamp de publicação (YYYY-MM-DD HH:mm:ss)
 *  - `dataAtualizacao`: última atualização (YYYY-MM-DD HH:mm:ss)
 *  - `edicaoExtra`: "S" para edições extras, null para regulares
 *  - `descricao`: TEXTO INTEGRAL da edição (substitui necessidade de baixar PDF)
 *
 * É a FONTE PRIMÁRIA do módulo Diário Oficial — atualização em tempo real,
 * sem lag de 24-48h da API do Querido Diário, e sem necessidade de OCR.
 *
 * Verificado em 2026-05-07:
 *  - 2026 → 86 edições (4103→4188)
 *  - 2025 → 250 edições (3853→4102)
 *  - 2024 → ~250 edições estimadas
 */

const API_BASE = 'https://www.marilia.sp.gov.br/portal/dados-abertos/diario-oficial';

export interface DadosAbertosGazette {
  /** Número da edição (string numérica). */
  edicao: string;
  /** Data de publicação no formato `YYYY-MM-DD HH:mm:ss`. */
  data: string;
  /** Data da última atualização no formato `YYYY-MM-DD HH:mm:ss`. */
  dataAtualizacao: string;
  /** "S" se edição extra, null caso regular. */
  edicaoExtra: 'S' | null;
  /** Texto integral da edição — substitui necessidade de PDF. */
  descricao: string;
}

interface DadosAbertosResponse {
  dados: DadosAbertosGazette[];
}

export class DadosAbertosError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'DadosAbertosError';
  }
}

/**
 * Lista TODAS as edições do diário oficial de Marília para um ano específico.
 *
 * @example
 * const editions = await listGazettesByYear(2026);
 * // 86+ edições com texto integral
 */
export async function listGazettesByYear(ano: number): Promise<DadosAbertosGazette[]> {
  const url = `${API_BASE}/${ano}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'OficioExpresso/1.0 (legislative-tool; contact: vereador@marilia.sp.gov.br)',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new DadosAbertosError(
      `Falha ao buscar dados abertos para ${ano}: HTTP ${res.status}`,
      res.status,
      body.slice(0, 500),
    );
  }

  const json = (await res.json()) as DadosAbertosResponse;
  if (!json || !Array.isArray(json.dados)) {
    throw new DadosAbertosError(`Resposta inválida do endpoint: campo "dados" ausente`);
  }
  return json.dados;
}

/**
 * Lista edições de múltiplos anos sequencialmente (com throttle).
 * Útil para backfill histórico.
 */
export async function listGazettesByYears(
  anos: number[],
  opts: { throttleMs?: number } = {},
): Promise<{ ano: number; gazettes: DadosAbertosGazette[] }[]> {
  const throttleMs = opts.throttleMs ?? 1000;
  const out: { ano: number; gazettes: DadosAbertosGazette[] }[] = [];
  for (const ano of anos) {
    try {
      const gazettes = await listGazettesByYear(ano);
      out.push({ ano, gazettes });
    } catch (err) {
      console.error(`Erro buscando ${ano}:`, err);
      out.push({ ano, gazettes: [] });
    }
    if (ano !== anos[anos.length - 1]) {
      await new Promise((r) => setTimeout(r, throttleMs));
    }
  }
  return out;
}

/**
 * Parse "YYYY-MM-DD HH:mm:ss" → Date.
 * Os dados abertos da Prefeitura usam horário de São Paulo (UTC-3) sem indicar
 * timezone. O servidor Next.js roda em UTC, então `new Date(y, mo, da, h)` seria
 * interpretado como UTC e causaria um shift de 3h. Usamos Date.UTC + offset +3h
 * para obter o instante UTC correto — sem isso, meia-noite SP viraria 21h do dia
 * anterior e edições publicadas à meia-noite apareceriam como "ontem".
 */
export function parseDadosAbertosDate(s: string): Date {
  const [d, t] = s.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, se] = (t ?? '00:00:00').split(':').map(Number);
  return new Date(Date.UTC(y, (mo ?? 1) - 1, da ?? 1, (h ?? 0) + 3, mi ?? 0, se ?? 0));
}

/** Constrói o ID Firestore canônico da edição. */
export function gazetteDocId(gazette: DadosAbertosGazette): string {
  const date = parseDadosAbertosDate(gazette.data);
  return `${date.getFullYear()}_${gazette.edicao}`;
}

/**
 * URL do PDF original na prefeitura (página de visualização HTML que contém o link).
 * NÃO é o PDF direto — é a página /portal/diario-oficial/ver/{id} mas como o id
 * interno não vem nesse JSON, retornamos a URL de listagem por edição.
 */
export function buildOriginalGazetteUrl(gazette: DadosAbertosGazette): string {
  return `https://www.marilia.sp.gov.br/portal/diario-oficial?edicao=${gazette.edicao}`;
}
