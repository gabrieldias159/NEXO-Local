/**
 * CHAVES CANÔNICAS do NEXO — lado APLICAÇÃO.
 *
 * ESPELHO VERBATIM de `functions/src/nexo/chaves.ts`. Os dois lados PRECISAM
 * produzir exatamente a mesma string para a mesma entrada, senão o JOIN entre o
 * que o coletor (functions) grava e o que o detector (app) procura
 * silenciosamente não casa nada. Por isso este arquivo é uma cópia idêntica em
 * algoritmo do lado das functions — só muda a import de `hashDoc` (regra do
 * projeto: cada lado importa o seu próprio `pii.ts`).
 *
 * Três chaves de junção:
 *
 *  - `chaveProcesso({num,ano})` — casa EMPENHO (`ProcessoLicitatorio`, primário)
 *    com CONTRATO (`numeroProcesso` + ano de vigência). `num` = primeiro grupo
 *    de dígitos SEM zeros à esquerda; `ano` = 4 dígitos. Forma `{num}/{ano}`.
 *    Sem isso, `"47"` (contrato) e `"0047 / 2022"` (empenho) jamais casariam.
 *
 *  - `chaveFraca(nome,cpf6)` — ÚNICA forma de ligar sócio↔doador. O CPF cheio é
 *    data-blocked dos dois lados (a Receita só dá 6 dígitos do miolo do CPF do
 *    sócio; o TSE traz o CPF mas só usamos `slice(3,9)` = mesmos 6 dígitos do
 *    miolo). Então a chave é `hashDoc(normNome(nome) + "|" + cpf6)`: nome
 *    normalizado + miolo do CPF, hasheados juntos. NÃO é identificação forte
 *    (daí "fraca") — é indício a apurar, nunca acusação.
 *
 *  - `chaveEmpenho(seq,ano)` — `EMP-{seq pad10}-{ano}`. Já em uso em
 *    `coleta-tce-despesas.ts`/`linkage.ts`; reproduzido aqui como forma canônica.
 *
 * Uso server-side (runtime nodejs) — `hashDoc` usa `node:crypto`.
 * Determinístico, sem efeito colateral.
 */
import { hashDoc } from "./pii";

/** Largura do zero-pad da sequência do empenho (casa SMARAPD×TCE). */
const EMPENHO_PAD = 10;

/** Só os dígitos de um valor (mesmo padrão do resto do módulo nexo). */
function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

/**
 * Normaliza um nome de pessoa/empresa para casar entre fontes: tira acento,
 * caixa-alta, colapsa espaços. ESPELHO do `normNome` dos coletores.
 */
export function normNome(v: unknown): string {
  return (v == null ? "" : String(v))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrai os 6 dígitos do MIOLO do CPF (posições 4–9, índice `slice(3,9)`) — os
 * únicos que ambas as fontes expõem. Aceita CPF cheio (11 díg → `slice(3,9)`),
 * já-mascarado (6 díg → usado direto) ou string formatada. Retorna "" se não
 * der pra extrair 6 dígitos de miolo (ex.: CNPJ de sócio PJ, doc vazio).
 */
export function cpf6De(cpf: unknown): string {
  const d = soDigitos(cpf);
  if (d.length === 6) return d;
  if (d.length === 11) return d.slice(3, 9);
  return "";
}

/**
 * Chave de processo licitatório/administrativo canônica: `{num}/{ano}`.
 * `num` = primeiro grupo de dígitos SEM zeros à esquerda; `ano` = 4 dígitos.
 * Tolera `num`/`ano` como número ou string suja (`"0047"`, `"47 / 2022"`).
 *
 * Retorna "" se não houver `num` (sem dígitos) — chave vazia NÃO entra no índice.
 */
export function chaveProcesso(p: {
  num: unknown;
  ano: unknown;
}): string {
  // Extrai grupos de dígitos do RAW de `num` ANTES de soDigitos — senão
  // "21 / 2022" colapsa p/ "212022" e o 1º grupo vira "212022" (bug que MATAVA o
  // linkage: 0 arestas empenho↔contrato/licitação). 1º grupo = número; um grupo
  // seguinte de 4 díg de ano (ex.: "21 / 2022") = ano embutido; senão usa `p.ano`.
  const grupos = String(p.num ?? "").match(/\d+/g) ?? [];
  if (grupos.length === 0) return "";
  const num = String(Number(grupos[0])); // remove zeros à esquerda ("0047" → "47")
  const anoEmbutido = grupos.slice(1).find((g) => /^(?:19|20)\d{2}$/.test(g));
  const ano = anoEmbutido ?? soDigitos(p.ano).match(/\d{4}/)?.[0] ?? "";
  return ano ? `${num}/${ano}` : num;
}

/**
 * Chave fraca sócio↔doador: `hashDoc(normNome(nome) + "|" + cpf6)`. Indício a
 * apurar (nome + miolo do CPF), nunca identificação forte. Retorna "" se faltar
 * nome OU cpf6 (sem um dos dois não há indício — não fabricar chave degenerada).
 */
export function chaveFraca(nome: unknown, cpf6: unknown): string {
  const n = normNome(nome);
  const c = soDigitos(cpf6);
  if (!n || !c) return "";
  return hashDoc(n + "|" + c);
}

/**
 * Chave canônica de empenho: `EMP-{seq pad10}-{ano}`. `seq` = primeiro grupo de
 * dígitos; `ano` = 4 dígitos do bruto, ou o `exercicio` informado como fallback.
 * Reproduz `normalizarNrEmpenho` de `coleta-tce-despesas.ts`.
 *
 * Retorna "" quando não há sequência de dígitos.
 */
export function chaveEmpenho(seq: unknown, ano: unknown): string {
  const limpo = seq == null ? "" : String(seq);
  const m = limpo.match(/(\d+)(?:\D+(\d{4}))?/);
  const s = m?.[1] ?? "";
  if (!s) return "";
  const anoStr = m?.[2] ?? soDigitos(ano).match(/\d{4}/)?.[0] ?? String(ano ?? "");
  const seqPad = s.padStart(EMPENHO_PAD, "0");
  return `EMP-${seqPad}-${anoStr}`;
}
