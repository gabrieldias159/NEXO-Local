/**
 * ENTITY-RESOLVER COMPARTILHADO do NEXO — lado FUNCTIONS.
 *
 * Fonte ÚNICA de verdade para responder, a partir de um par `(doc, nome)` cru de
 * qualquer fonte (empenho SMARAPD, despesa TCE, contrato/licitação, QSA, doação
 * TSE…), três perguntas:
 *
 *   1. Qual é a CHAVE CANÔNICA da entidade?   → `entidadeId(doc, nome)`
 *   2. Qual é a RAIZ do CNPJ (filial→grupo)?  → `cnpjRaizDe(doc)`
 *   3. Que TIPO de entidade é (empresa/pessoa/órgão)? → `tipoEntidade(doc, nome)`
 *
 * Antes desta frente, CADA coletor re-implementava `idCanonicoEntidade` /
 * `cnpjRaiz` / `ehEntidadePublica` localmente (perfil-entidades.ts, score-
 * entidades.ts, …) — colado, fácil de divergir. Aqui centralizamos a lógica para
 * que TODO coletor produza o MESMO `_entidadeId`/`_cnpjRaiz` na ingestão (campos
 * de sistema da seção 2.1 do plano-mestre), e o perfil/score só agreguem por
 * igualdade desses campos já carimbados.
 *
 * Espelha, em algoritmo, `src/lib/nexo/entidades.ts` (regra `functions/` NÃO
 * importa de `src/`): mesma denylist de entes públicos, mesma regex de nome,
 * mesma validação Módulo 11, mesmo `idCanonicoEntidade`. A diferença é só de
 * dependência: aqui a validação é re-implementada local (sem `cpf-cnpj-validator`),
 * como já é praxe no lado functions.
 *
 * Self-contained: NÃO importa de `src/`; só (opcionalmente) reusa `chaveFraca`/
 * `cpf6De` de `./chaves.ts` (Onda 1) para a perna sócio↔doador. Determinístico,
 * sem efeito colateral.
 */
import { chaveFraca, cpf6De, normNome } from "./chaves";

// ── Denylist de entes públicos (espelho de src/lib/nexo/entidades.ts) ─────────

/** CNPJs (só dígitos) de entes públicos de Marília que NUNCA são "empresa". */
export const ENTES_PUBLICOS_MARILIA = new Set<string>([
  "44477909000100", // Prefeitura Municipal de Marília
  "59989830000136", // IPREMM — RPPS de Marília
  // Câmara, SAAE/DAEM, fundos e fundações: a regex de nome (RE_ORGAO_PUBLICO)
  // já cobre; CNPJs específicos a confirmar contra a Receita e adicionar aqui.
]);

/** Raízes (8 díg) dos entes públicos — uma filial de raiz pública é pública. */
const RAIZES_PUBLICAS = new Set(
  [...ENTES_PUBLICOS_MARILIA].map((c) => c.slice(0, 8)),
);

/** Termos inequívocos de ente público (sobre o nome normalizado, sem acento). */
export const RE_ORGAO_PUBLICO =
  /\b(PREFEITURA|MUNICIPIO DE|CAMARA MUNICIPAL|FUNDO MUNICIPAL|INSTITUTO DE PREVIDENCIA|IPREMM|AUTARQUIA|FUNDACAO PUBLICA|SECRETARIA MUNICIPAL|SERVICO AUTONOMO|SAAE|DAEM|DAEMA|ESTADO DE SAO PAULO|UNIAO FEDERAL|TESOURO (NACIONAL|MUNICIPAL)|VARA (DO|DA|CIVEL|CRIMINAL|FEDERAL|UNICA|REGIONAL)|TRIBUNAL (DE|DO|REGIONAL)|JUSTICA (DO TRABALHO|FEDERAL|ELEITORAL|MILITAR|ESTADUAL)|MINISTERIO PUBLICO|JUIZADO|COMARCA|PROCURADORIA (GERAL|DO|DA)|DEFENSORIA PUBLICA)\b/;

const RE_SUFIXO_EMPRESARIAL =
  /\b(LTDA|EIRELI|EPP|MEI|ME|S\/?A|SA|SS|EI|SOCIEDADE\s+(SIMPLES|EMPRESARIA))\b\.?/g;

// ── Normalizadores ────────────────────────────────────────────────────────────

/** Só os dígitos de um valor. */
export function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

/**
 * Normaliza um nome para casar entre fontes: tira acento, caixa-alta, colapsa
 * espaços. Delega ao `normNome` canônico de `chaves.ts` (mesma normalização que
 * alimenta `chaveFraca`), garantindo um único algoritmo de normalização de nome
 * em todo o lado functions.
 */
export function normalizarNome(nome: unknown): string {
  return normNome(nome);
}

/** Rótulo canônico do nome — para dedup por grafia (sem sufixo/acento/caixa). */
export function rotuloCanonico(nome: unknown): string {
  return normalizarNome(nome)
    .replace(RE_SUFIXO_EMPRESARIAL, "")
    .replace(/\s+/g, " ")
    .replace(/[.,\-\s]+$/, "")
    .trim();
}

/** Raiz do CNPJ (8 primeiros dígitos). CPF (11 díg) não tem raiz — devolve ele. */
export function cnpjRaizDe(doc: unknown): string {
  const d = soDigitos(doc);
  return d.length === 14 ? d.slice(0, 8) : d;
}

// ── Validação Módulo 11 (CPF/CNPJ) — re-implementada local, sem dependência ───

function digitosTodosIguais(d: string): boolean {
  return /^(\d)\1+$/.test(d);
}

/** CPF (11 díg) válido por dígito verificador (Módulo 11). */
export function cpfValido(d: string): boolean {
  if (d.length !== 11 || digitosTodosIguais(d)) return false;
  const calc = (ate: number): number => {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (ate + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

/** CNPJ (14 díg) válido por dígito verificador (Módulo 11). */
export function cnpjValido(d: string): boolean {
  if (d.length !== 14 || digitosTodosIguais(d)) return false;
  const calc = (ate: number): number => {
    const pesos =
      ate === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * pesos[i];
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/** Documento REAL (CPF/CNPJ com dígito verificador válido — Módulo 11). */
export function docValido(doc: unknown): boolean {
  const d = soDigitos(doc);
  if (d.length === 11) return cpfValido(d);
  if (d.length === 14) return cnpjValido(d);
  return false;
}

// ── Tipo da entidade ──────────────────────────────────────────────────────────

export type TipoEntidade = "empresa" | "pessoa" | "orgao";

/**
 * true se a entidade é, na verdade, um ente público — vira `tipo: 'orgao'`,
 * NUNCA 'empresa'. Casa por doc na denylist (ou raiz pública) ou por nome
 * inequívoco (RE_ORGAO_PUBLICO).
 */
export function ehEntidadePublica(doc: unknown, nome: unknown): boolean {
  const d = soDigitos(doc);
  if (d && (ENTES_PUBLICOS_MARILIA.has(d) || RAIZES_PUBLICAS.has(cnpjRaizDe(d)))) {
    return true;
  }
  if (nome) return RE_ORGAO_PUBLICO.test(normalizarNome(nome));
  return false;
}

/** Tipo da entidade derivado do doc + nome. */
export function tipoEntidade(doc: unknown, nome: unknown): TipoEntidade {
  if (ehEntidadePublica(doc, nome)) return "orgao";
  const d = soDigitos(doc);
  if (d.length === 11 && cpfValido(d)) return "pessoa";
  // CNPJ válido → empresa; doc inválido → assume empresa (fornecedor por nome).
  return "empresa";
}

// ── Chave canônica de entidade ────────────────────────────────────────────────

/**
 * Chave canônica de agregação (`_entidadeId`) — colapsa filiais de um mesmo grupo
 * (raiz do CNPJ) numa entidade só. CPF (válido) fica isolado; doc inválido/lixo
 * (ex.: código interno do TCE) cai no rótulo do nome. Espelha
 * `idCanonicoEntidade` de `src/lib/nexo/entidades.ts`.
 *
 * Esta é a função que TODO coletor deve usar para carimbar `_entidadeId` na
 * ingestão, e que `perfil-entidades`/`score-entidades` usam para agregar.
 */
export function entidadeId(doc: unknown, nome: unknown): string {
  const d = soDigitos(doc);
  if (d && docValido(d)) return cnpjRaizDe(d);
  return rotuloCanonico(nome) || "(sem id)";
}

/**
 * Resolução completa de uma entidade a partir de um par `(doc, nome)` cru. Um
 * único ponto de entrada que devolve os campos de sistema canônicos da seção 2.1
 * para o coletor carimbar no doc: `_entidadeId`, `_cnpjRaiz`, `_cnpj`, `tipo`.
 *
 *   - `id`        = `_entidadeId` (chave de agregação; raiz do CNPJ ou rótulo).
 *   - `cnpjRaiz`  = `_cnpjRaiz`  (8 díg; "" se não houver CNPJ de 14 díg).
 *   - `cnpj`      = `_cnpj`      (14 díg só-dígitos; "" se não for CNPJ válido).
 *   - `cpf`       = 11 díg só-dígitos (se CPF válido; senão "").
 *   - `tipo`      = empresa | pessoa | orgao.
 *   - `docValido` = true se CPF/CNPJ passou no Módulo 11.
 *   - `chaveFraca`= chave fraca nome+cpf6 (só para PESSOA com CPF; senão "").
 */
export interface EntidadeResolvida {
  id: string;
  cnpjRaiz: string;
  cnpj: string;
  cpf: string;
  tipo: TipoEntidade;
  docValido: boolean;
  chaveFraca: string;
}

export function resolverEntidade(doc: unknown, nome: unknown): EntidadeResolvida {
  const d = soDigitos(doc);
  const valido = docValido(d);
  const ehCnpj = valido && d.length === 14;
  const ehCpf = valido && d.length === 11;
  const tipo = tipoEntidade(doc, nome);
  // Chave fraca só faz sentido p/ pessoa física (sócio↔doador). Para CNPJ não há
  // cpf6 — `chaveFraca` retorna "" sozinho, mas só a invocamos quando há CPF.
  const cpf6 = ehCpf ? cpf6De(d) : "";
  return {
    id: entidadeId(doc, nome),
    cnpjRaiz: ehCnpj ? cnpjRaizDe(d) : "",
    cnpj: ehCnpj ? d : "",
    cpf: ehCpf ? d : "",
    tipo,
    docValido: valido,
    chaveFraca: cpf6 ? chaveFraca(nome, cpf6) : "",
  };
}
