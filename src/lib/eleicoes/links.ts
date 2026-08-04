/**
 * Links externos oficiais do TSE por candidato / partido / resultado.
 *
 * Formato REAL do deep-link do DivulgaCandContas (confirmado):
 *   #/candidato/{REGIAO}/{UF}/{codEleicao}/{sqCandidato}/{ano}/{codMunicipio}
 * Ex.: .../#/candidato/SUDESTE/SP/2045202024/250002063436/2024/66818
 * Marília é sempre SUDESTE / SP / 66818, e a rota usa o próprio SQ_CANDIDATO.
 *
 * Códigos de eleição municipal: 2024 = 2045202024 · 2020 = 2030402020 · 2016 = 2.
 */

export const COD_ELEICAO: Record<number, string> = {
  2024: '2045202024',
  2020: '2030402020',
  2016: '2',
  2012: '1699',
};

const BASE_DIVULGA = 'https://divulgacandcontas.tse.jus.br/divulga/#/candidato/SUDESTE/SP';
const UE_MARILIA = '66818';

/** Ficha do candidato no DivulgaCandContas (deep-link real, por sqCandidato). */
export function urlDivulgaCandidato(ano: number, sqCandidato: string): string {
  const cod = COD_ELEICAO[ano];
  if (!cod || !sqCandidato) return 'https://divulgacandcontas.tse.jus.br/divulga/#/home';
  return `${BASE_DIVULGA}/${cod}/${sqCandidato}/${ano}/${UE_MARILIA}`;
}

/** Foto oficial do candidato (mesmo arquivo servido na ficha do DivulgaCand). */
export function urlFotoCandidato(ano: number, sqCandidato: string): string | null {
  const cod = COD_ELEICAO[ano];
  if (!cod || !sqCandidato) return null;
  return `https://divulgacandcontas.tse.jus.br/divulga/rest/arquivo/img/${cod}/${sqCandidato}/${UE_MARILIA}`;
}

/** Prestação de contas do candidato — mesma ficha do DivulgaCandContas (abas internas). */
export function urlContasCandidato(ano: number, sqCandidato: string): string {
  return urlDivulgaCandidato(ano, sqCandidato);
}

/**
 * Contas anuais dos partidos (DivulgaSPCA). O caminho /divulgaspca/ retorna 403;
 * a página-portal do TSE é estável e leva ao sistema de consulta.
 */
export function urlContasPartido(): string {
  return 'https://www.tse.jus.br/partidos/contas-partidarias/prestacao-de-contas/divulga-spca';
}

/** Resultado oficial da eleição (portal de resultados do TSE) — verificado, abre. */
export function urlResultados(): string {
  return 'https://resultados.tse.jus.br/oficial/app/index.html#/eleicao/resultados';
}
