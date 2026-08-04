/**
 * Client do Portal de Transparência do TCE-SP — despesas municipais.
 *
 * GET {tce}/api/json/despesas/marilia/{exercicio}/{mes} → empenhos com o CNPJ/CPF
 * do fornecedor e o valor. É uma SEGUNDA FONTE independente do portal próprio
 * da Prefeitura (SMARAPD) — permite detectar DIVERGÊNCIA (mesmo empenho, valor
 * diferente entre o que a Prefeitura declara ao TCE e o que publica no portal).
 *
 * Slug do município = `marilia` (sem IBGE). Sem autenticação. Uso server-side.
 * `id_fornecedor` vem composto, ex.: "CNPJ - PESSOA JURIDICA - 52060118000109".
 */
import { FONTES } from '../constants';
import { soDigitos } from '../normalizar';
import { ehEntidadePublica } from '../entidades';

const BASE = FONTES.tce;
const TIMEOUT_MS = 25_000;
const HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

export interface DespesaTce {
  orgao: string;
  nroEmpenho: string;
  /** Documento do fornecedor (só dígitos) extraído do id_fornecedor composto. */
  cpfCnpj: string;
  fornecedorNome: string;
  valor: number;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const s = v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v;
    const n = Number(s.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Extrai os dígitos finais (CNPJ 14 / CPF 11 / código) do id_fornecedor composto. */
function extrairDoc(idFornecedor: unknown): string {
  const m = String(idFornecedor ?? '').match(/(\d{6,14})\s*$/);
  return m ? soDigitos(m[1]) : '';
}

/**
 * Despesas (empenhos) do mês no TCE-SP. Exclui entes públicos do rol de
 * fornecedores. Degrada com erro honesto. Aceita resposta em array ou
 * envelopada (`{ data | despesas | itens: [...] }`).
 */
export async function getDespesasTce(
  exercicio: number,
  mes: number,
): Promise<DespesaTce[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${BASE}/api/json/despesas/marilia/${exercicio}/${mes}`,
      { signal: ctrl.signal, headers: HEADERS, cache: 'no-store' },
    );
    if (!res.ok) throw new Error(`TCE-SP despesas HTTP ${res.status}`);
    const json: unknown = await res.json();
    const lista: unknown[] = Array.isArray(json)
      ? json
      : Array.isArray((json as { data?: unknown[] }).data)
        ? (json as { data: unknown[] }).data
        : Array.isArray((json as { despesas?: unknown[] }).despesas)
          ? (json as { despesas: unknown[] }).despesas
          : Array.isArray((json as { itens?: unknown[] }).itens)
            ? (json as { itens: unknown[] }).itens
            : [];

    const out: DespesaTce[] = [];
    for (const item of lista) {
      const d = (item ?? {}) as Record<string, unknown>;
      const cpfCnpj = extrairDoc(d.id_fornecedor);
      const fornecedorNome = String(d.nm_fornecedor ?? '');
      if (ehEntidadePublica(cpfCnpj, fornecedorNome)) continue;
      out.push({
        orgao: String(d.orgao ?? ''),
        nroEmpenho: String(d.nr_empenho ?? ''),
        cpfCnpj,
        fornecedorNome,
        valor: toNum(d.vl_despesa),
      });
    }
    return out;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`TCE-SP despesas — timeout após ${TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
