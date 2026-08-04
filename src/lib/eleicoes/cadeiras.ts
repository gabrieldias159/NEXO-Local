/**
 * Distribuição de cadeiras da Câmara pelo sistema proporcional brasileiro.
 *
 * Reproduz o resultado oficial do TSE para Marília a partir dos votos por
 * candidato (+ votos de legenda, quando disponíveis). Serve de motor para o
 * simulador de recontagem: anule um partido inteiro ou candidatos avulsos e
 * recalcule quem fica com as cadeiras.
 *
 * Regras (verificadas contra o resultado real de 2016/2020/2024):
 *  - Quociente Eleitoral (QE) = votos válidos / nº de cadeiras (arredondado).
 *  - Quociente Partidário (QP) = ⌊votos da unidade / QE⌋ — cadeiras "cheias".
 *    Só ocupa cadeira de QP o candidato com ≥10% do QE (votação nominal mínima).
 *  - Sobras por maiores médias (média = votos / (cadeiras+1)):
 *      · 2024+ (Lei 14.211/2021): a unidade precisa de ≥80% do QE e o candidato
 *        de ≥20% do QE; esgotadas as unidades qualificadas, as cadeiras restantes
 *        vão pelas maiores médias sem as barreiras (art. 109, II).
 *      · 2016/2020 (Lei 13.165/2015): todas as unidades concorrem; candidato ≥10% do QE.
 *  - Unidade de apuração: 2016 = coligação; 2024 = federação (une PSDB+CIDADANIA
 *    etc.) ou partido isolado; 2020 = partido.
 */

export interface CandidatoVoto {
  sq: string;
  urna: string;
  nome?: string;
  partido: string;
  coligacao?: string;
  votos: number;
}

/** Nº de cadeiras da Câmara de Marília por ano de eleição. */
export const CADEIRAS_POR_ANO: Record<number, number> = {
  2016: 13,
  2020: 13,
  2024: 17,
};

/** Federações nacionais vigentes em 2024 (partido → id da federação). */
const FEDERACOES_2024: Record<string, string> = {
  PT: 'Federação Brasil da Esperança',
  PCDOB: 'Federação Brasil da Esperança',
  PV: 'Federação Brasil da Esperança',
  PSOL: 'Federação PSOL REDE',
  REDE: 'Federação PSOL REDE',
  PSDB: 'Federação PSDB Cidadania',
  CIDADANIA: 'Federação PSDB Cidadania',
};

const normSigla = (s: string | undefined) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Chave da unidade de apuração (partido, coligação ou federação) de um candidato. */
export function chaveUnidade(c: CandidatoVoto, ano: number): string {
  if (ano <= 2016) {
    // Coligação era a unidade em 2016; mas "PARTIDO ISOLADO" não é uma unidade —
    // cada partido isolado apura sozinho.
    const col = c.coligacao || '';
    return col && !/isolad/i.test(col) ? col : c.partido;
  }
  if (ano >= 2024 && /federa/i.test(c.coligacao || '')) {
    const fed = FEDERACOES_2024[normSigla(c.partido)];
    if (fed) return fed;
  }
  return c.partido;
}

export interface CadeiraEleito {
  sq: string;
  urna: string;
  partido: string;
  unidade: string;
  votos: number;
  via: 'QP' | 'média';
  ordem: number; // 1..cadeiras, ordem de conquista
}

export interface UnidadeResumo {
  unidade: string;
  partidos: string[];
  votos: number; // nominais + legenda (efetivos)
  qp: number;
  cadeiras: number;
}

export interface ResultadoCadeiras {
  ano: number;
  cadeiras: number;
  validos: number;
  qe: number;
  eleitos: CadeiraEleito[];
  unidades: UnidadeResumo[];
}

export interface OpcoesAlocacao {
  ano: number;
  candidatos: CandidatoVoto[];
  cadeiras?: number;
  /** Votos de legenda por partido (sigla). Somados por unidade internamente. */
  legendaPorPartido?: Record<string, number>;
  /** SQ de candidatos com votos anulados (simulação). */
  candidatosAnulados?: Set<string> | string[];
  /** Siglas de partidos anulados por inteiro (nominais + legenda). */
  partidosAnulados?: Set<string> | string[];
}

const round = (x: number) => Math.floor(x + 0.5);
const asSet = (v?: Set<string> | string[]) =>
  v instanceof Set ? v : new Set(v || []);

export function distribuirCadeiras(opts: OpcoesAlocacao): ResultadoCadeiras {
  const { ano, candidatos } = opts;
  const cadeiras = opts.cadeiras ?? CADEIRAS_POR_ANO[ano] ?? 17;
  const anulados = asSet(opts.candidatosAnulados);
  const partAnul = asSet(opts.partidosAnulados);
  const legendaPorPartido = opts.legendaPorPartido || {};

  const votoEfetivo = (c: CandidatoVoto) =>
    anulados.has(c.sq) || partAnul.has(c.partido) ? 0 : c.votos || 0;

  // Agrupa candidatos por unidade
  interface U {
    key: string;
    partidos: Set<string>;
    votos: number;
    cands: CandidatoVoto[];
  }
  const units = new Map<string, U>();
  for (const c of candidatos) {
    const key = chaveUnidade(c, ano);
    let u = units.get(key);
    if (!u) units.set(key, (u = { key, partidos: new Set(), votos: 0, cands: [] }));
    u.partidos.add(c.partido);
    u.votos += votoEfetivo(c);
    u.cands.push(c);
  }
  // Soma votos de legenda (por partido) na respectiva unidade, exceto anulados
  for (const u of units.values()) {
    for (const p of u.partidos) {
      if (partAnul.has(p)) continue;
      u.votos += legendaPorPartido[p] || 0;
    }
    u.cands.sort((a, b) => votoEfetivo(b) - votoEfetivo(a));
  }

  const validos = [...units.values()].reduce((s, u) => s + u.votos, 0);
  const qe = validos > 0 ? round(validos / cadeiras) : 0;

  // Parâmetros da regra vigente no ano
  const regra2021 = ano >= 2022;
  const thrQP = 0.1 * qe;
  const thrSobraCand = (regra2021 ? 0.2 : 0.1) * qe;
  const thrUnidade = (regra2021 ? 0.8 : 0) * qe;

  const eleitos: CadeiraEleito[] = [];
  const eleitoSet = new Set<string>();
  const cadeirasUnit = new Map<string, number>();
  for (const u of units.values()) cadeirasUnit.set(u.key, 0);
  let ordem = 0;

  const eleger = (u: U, c: CandidatoVoto, via: 'QP' | 'média') => {
    eleitos.push({
      sq: c.sq,
      urna: c.urna,
      partido: c.partido,
      unidade: u.key,
      votos: votoEfetivo(c),
      via,
      ordem: ++ordem,
    });
    eleitoSet.add(c.sq);
    cadeirasUnit.set(u.key, (cadeirasUnit.get(u.key) || 0) + 1);
  };

  // 1) Cadeiras por Quociente Partidário
  for (const u of units.values()) {
    if (qe <= 0) break;
    const qp = Math.floor(u.votos / qe);
    let dados = 0;
    for (const c of u.cands) {
      if (dados >= qp) break;
      if (votoEfetivo(c) >= thrQP) {
        eleger(u, c, 'QP');
        dados++;
      }
    }
  }

  // 2) Sobras por maiores médias
  const proximo = (u: U, minCand: number) =>
    u.cands.find((c) => !eleitoSet.has(c.sq) && votoEfetivo(c) >= minCand);

  let guard = 0;
  while (eleitos.length < cadeiras && guard++ < 1000) {
    // Fase A: unidades qualificadas (barreiras da regra vigente)
    let best: { u: U; c: CandidatoVoto } | null = null;
    let bestMedia = -1;
    for (const u of units.values()) {
      if (u.votos < thrUnidade) continue;
      const c = proximo(u, thrSobraCand);
      if (!c) continue;
      const media = u.votos / ((cadeirasUnit.get(u.key) || 0) + 1);
      if (media > bestMedia) {
        bestMedia = media;
        best = { u, c };
      }
    }
    if (best) {
      eleger(best.u, best.c, 'média');
      continue;
    }
    // Fase B: esgotadas as qualificadas, distribui o restante sem barreiras
    best = null;
    bestMedia = -1;
    for (const u of units.values()) {
      const c = proximo(u, 0);
      if (!c) continue;
      const media = u.votos / ((cadeirasUnit.get(u.key) || 0) + 1);
      if (media > bestMedia) {
        bestMedia = media;
        best = { u, c };
      }
    }
    if (!best) break;
    eleger(best.u, best.c, 'média');
  }

  const unidades: UnidadeResumo[] = [...units.values()]
    .map((u) => ({
      unidade: u.key,
      partidos: [...u.partidos].sort(),
      votos: u.votos,
      qp: qe > 0 ? Math.floor(u.votos / qe) : 0,
      cadeiras: cadeirasUnit.get(u.key) || 0,
    }))
    .sort((a, b) => b.votos - a.votos);

  return { ano, cadeiras, validos, qe, eleitos, unidades };
}
