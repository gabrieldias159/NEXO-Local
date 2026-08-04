/**
 * NEXO — Resolução e sanitização de entidades (fornecedores/órgãos).
 *
 * Fonte única de verdade para responder "isto é um fornecedor privado de
 * verdade?" e "qual é a chave canônica desta entidade?". Resolve o problema de
 * qualidade nº 1 do dono: a própria Prefeitura / órgãos públicos apareciam como
 * "fornecedor" (transferências intra-governamentais, repasse ao RPPS, duodécimo
 * da Câmara, folha lançada como fornecedor) — nada disso é contratação privada.
 *
 * ⚠ A denylist abaixo é um SEED conservador. Confirmar/expandir contra Receita
 * (natureza jurídica 1xxx = Administração Pública) e PNCP. A heurística de nome
 * usa só termos inequívocos de ente público para não excluir empresa privada.
 */
import { MARILIA } from './constants';
import { cpf, cnpj } from 'cpf-cnpj-validator';

/** CNPJs (só dígitos) de entes públicos de Marília que NUNCA são "fornecedor". */
export const ENTES_PUBLICOS_MARILIA = new Set<string>([
  MARILIA.cnpjPrefeitura, // 44477909000100 — Prefeitura
  '59989830000136', // IPREMM — RPPS de Marília (confirmado no catálogo de fontes)
  // Câmara, SAAE/DAEM, fundos e fundações: a regex de nome (RE_ORGAO_PUBLICO)
  // já cobre; CNPJs específicos a confirmar contra a Receita e adicionar aqui.
]);

const RAIZES_PUBLICAS = new Set(
  [...ENTES_PUBLICOS_MARILIA].map((c) => c.slice(0, 8)),
);

/** Termos inequívocos de ente público (sobre o nome normalizado, sem acento). */
export const RE_ORGAO_PUBLICO =
  /\b(PREFEITURA|MUNICIPIO DE|CAMARA MUNICIPAL|FUNDO MUNICIPAL|INSTITUTO DE PREVIDENCIA|IPREMM|AUTARQUIA|FUNDACAO PUBLICA|SECRETARIA MUNICIPAL|SERVICO AUTONOMO|SAAE|DAEM|DAEMA|ESTADO DE SAO PAULO|UNIAO FEDERAL|TESOURO (NACIONAL|MUNICIPAL)|VARA (DO|DA|CIVEL|CRIMINAL|FEDERAL|UNICA|REGIONAL)|TRIBUNAL (DE|DO|REGIONAL)|JUSTICA (DO TRABALHO|FEDERAL|ELEITORAL|MILITAR|ESTADUAL)|MINISTERIO PUBLICO|JUIZADO|COMARCA|PROCURADORIA (GERAL|DO|DA)|DEFENSORIA PUBLICA)\b/;

export function soDigitos(doc: string | null | undefined): string {
  return (doc ?? '').replace(/\D/g, '');
}

export function normalizarNome(nome: string | null | undefined): string {
  return (nome ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const RE_SUFIXO_EMPRESARIAL =
  /\b(LTDA|EIRELI|EPP|MEI|ME|S\/?A|SA|SS|EI|SOCIEDADE\s+(SIMPLES|EMPRESARIA))\b\.?/g;

/** Rótulo canônico do nome — para dedup por grafia (sem sufixo/acento/caixa). */
export function rotuloCanonico(nome: string | null | undefined): string {
  return normalizarNome(nome)
    .replace(RE_SUFIXO_EMPRESARIAL, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,\-\s]+$/, '')
    .trim();
}

/** Raiz do CNPJ (8 primeiros dígitos). CPF (11 dígitos) não tem raiz. */
export function cnpjRaiz(doc: string | null | undefined): string {
  const d = soDigitos(doc);
  return d.length === 14 ? d.slice(0, 8) : d;
}

/**
 * Documento REAL (CPF/CNPJ com dígito verificador válido — Módulo 11).
 * Evita tratar lixo como entidade: ex.: "PESSOA FISICA - 605238" (6 dígitos,
 * código interno do TCE) NÃO é CPF — vira documento vazio, não pseudo-CPF.
 */
export function docValido(doc: string | null | undefined): boolean {
  const d = soDigitos(doc);
  if (d.length === 11) return cpf.isValid(d);
  if (d.length === 14) return cnpj.isValid(d);
  return false;
}

/**
 * true se `doc` é especificamente um CNPJ (14 dígitos) com dígito verificador
 * válido — Módulo 11. Diferente de `docValido` (aceita CPF OU CNPJ): usado
 * pelos detectores de FRACIONAMENTO/COMPRA (LC-01..05, FC-01, SA-08, SA-11,
 * FR-11) para excluir CPF de servidor/folha (pagamento de subsídio/diária
 * lançado com o CPF do beneficiário) e lixo numérico do agrupamento por
 * "fornecedor" — só pessoa JURÍDICA pode fracionar uma compra/dispensa.
 *
 * Confirmado empiricamente (auditoria 2026-07-27): ~25% dos registros de
 * `nexo_empenhos` têm CPF (11 díg.) como documento, com indivíduos chegando a
 * 200+ "empenhos" cada — sem este guard, esses lançamentos de pessoa física
 * disparavam fracionamento/concentração como se fossem compra fatiada.
 */
export function cnpjValido(doc: string | null | undefined): boolean {
  const d = soDigitos(doc);
  return d.length === 14 && cnpj.isValid(d);
}

/**
 * true se o "fornecedor" é, na verdade, um ente público — deve ser EXCLUÍDO das
 * listas/rankings/detectores de fornecedor.
 */
export function ehEntidadePublica(
  doc: string | null | undefined,
  nome?: string | null,
): boolean {
  const d = soDigitos(doc);
  if (d && (ENTES_PUBLICOS_MARILIA.has(d) || RAIZES_PUBLICAS.has(cnpjRaiz(d)))) {
    return true;
  }
  if (nome) return RE_ORGAO_PUBLICO.test(normalizarNome(nome));
  return false;
}

/**
 * Chave canônica de agregação — colapsa filiais de um mesmo grupo (raiz do
 * CNPJ) numa entidade só. CPF fica isolado; sem doc, cai no rótulo do nome.
 */
export function idCanonicoEntidade(
  doc: string | null | undefined,
  nome?: string | null,
): string {
  const d = soDigitos(doc);
  // Só usa o documento como chave se for um CPF/CNPJ REAL (Módulo 11); senão
  // cai no rótulo do nome — não agrega por código interno/lixo numérico.
  if (d && docValido(d)) return cnpjRaiz(d);
  return rotuloCanonico(nome) || '(sem id)';
}
