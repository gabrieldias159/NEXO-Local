/**
 * PII de documentos — base LGPD do NEXO (`hashDoc` + `mascararDoc`).
 *
 * Regra-mãe: **ninguém persiste CPF cru**. Pessoa física é dado pessoal; um CPF
 * em claro num documento do Firestore é vazamento esperando acontecer (LGPD
 * arts. 6º/46). Mas a fiscalização ainda precisa de duas coisas:
 *
 *  1. **Cruzar** o mesmo documento entre fontes (empenho ↔ contrato ↔ sanção)
 *     sem nunca guardar o número original  →  `hashDoc` (pseudonimização
 *     determinística: mesmo doc, mesmo hash, sempre, então dá pra fazer JOIN no
 *     hash; mas o hash não volta pro CPF). CNPJ também passa por aqui pra ter
 *     UMA chave de junção uniforme — CNPJ não é PII, mas hashear junto mantém o
 *     motor de linkage simples (uma coluna `docHash` só) e não custa nada.
 *  2. **Exibir** pro humano sem expor o número inteiro  →  `mascararDoc`
 *     (máscara visual; CPF some quase todo, CNPJ mostra só raiz+ordem que já
 *     são públicas e identificam a empresa).
 *
 * Fluxo: coletor recebe o doc → grava `docHash = hashDoc(x)` (pra cruzar) e
 * `docMasc = mascararDoc(x)` (pra mostrar) → DESCARTA o número cru. O painel
 * exibe a máscara; o linkage casa pelo hash.
 *
 * SALT: `hashDoc` usa `process.env.NEXO_PII_SALT`. O salt impede ataque de
 * dicionário (o espaço de CPF é só ~10^11 — um atacante com a tabela de hashes
 * e SEM salt reverte tudo em minutos). Há fallback pra constante fixa abaixo pra
 * que o hash seja reproduzível em dev/CI e entre coletores mesmo sem env var
 * configurada; em produção, DEFINA `NEXO_PII_SALT` (segredo) pra que o fallback
 * público não seja o salt efetivo. Trocar o salt RE-CHAVEIA tudo (hashes antigos
 * deixam de casar), então o salt de produção é fixo e versionado como segredo.
 *
 * Self-contained: igual ao resto de `functions/nexo`, não importa de `src/`;
 * usa só `node:crypto`. Determinístico e sem efeitos colaterais — fácil de
 * testar e seguro de chamar em qualquer coletor.
 */
import { createHash } from "node:crypto";

/**
 * Salt de FALLBACK — usado só quando `NEXO_PII_SALT` não está no ambiente.
 * É público (está no código), então NÃO protege contra ataque de dicionário;
 * serve apenas pra dar reprodutibilidade determinística em dev/CI. Em produção
 * o valor real vem de `process.env.NEXO_PII_SALT` (segredo). Documentado e fixo
 * de propósito: mudá-lo invalidaria todos os hashes já gravados com o fallback.
 */
const SALT_FALLBACK = "nexo-pii-v1-fallback-salt-defina-NEXO_PII_SALT-em-prod";

/** Salt efetivo: env var (segredo, prod) com fallback fixo documentado. */
function salt(): string {
  const s = process.env.NEXO_PII_SALT;
  return s && s.trim() ? s.trim() : SALT_FALLBACK;
}

/** Só os dígitos do documento (mesmo padrão do resto do módulo nexo). */
function soDigitos(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D/g, "");
}

/**
 * Hash determinístico e irreversível de um CPF/CNPJ — chave de junção que NÃO
 * é PII. `sha256(SALT + soDigitos(doc))`. O mesmo documento sempre gera o mesmo
 * hash (então dá pra cruzar empenho ↔ contrato ↔ sanção pelo hash), mas não dá
 * pra voltar do hash pro número. Retorna o hex do sha256; string vazia (sem
 * dígito nenhum) também é hasheada de forma estável.
 *
 * Use este valor pra PERSISTIR/CRUZAR. Nunca grave o número cru ao lado dele.
 */
export function hashDoc(cpfOuCnpj: unknown): string {
  const dig = soDigitos(cpfOuCnpj);
  return createHash("sha256").update(salt() + dig).digest("hex");
}

/**
 * Máscara visual de um CPF/CNPJ pra EXIBIR pro humano sem expor o número
 * inteiro:
 *
 *  - **CPF** (11 dígitos): `***.XXX.XXX-**` — esconde os 3 primeiros e os 2
 *    dígitos verificadores, mostra só o miolo (o suficiente pra um operador
 *    conferir/desambiguar sem reconstruir o CPF).
 *  - **CNPJ** (14 dígitos): formato `XX.XXX.***`+`/`+`****-XX` — mostra a raiz
 *    e o DV (que são públicos e identificam a empresa) e mascara a ordem/filial
 *    do meio. (O exemplo é quebrado neste comentário só pra não fechar o bloco.)
 *  - Tamanho inesperado: formata o que dá e mascara o miolo de forma genérica,
 *    pra nunca devolver o número cru por engano.
 *
 * Pra LGPD: este é o valor que vai pra tela; o cruzamento usa `hashDoc`.
 */
export function mascararDoc(cpfOuCnpj: unknown): string {
  const d = soDigitos(cpfOuCnpj);

  // CPF: ***.XXX.XXX-**  (esconde início e DV, mostra o miolo)
  if (d.length === 11) {
    return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  }

  // CNPJ: XX.XXX.***/****-XX  (raiz + DV públicos; ordem/filial mascaradas)
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.***/****-${d.slice(12, 14)}`;
  }

  // Vazio: nada a mascarar.
  if (d.length === 0) return "";

  // Tamanho fora do esperado: mostra início e fim, mascara o miolo, nunca
  // devolve o número inteiro em claro.
  if (d.length <= 4) return "*".repeat(d.length);
  return `${d.slice(0, 2)}${"*".repeat(d.length - 4)}${d.slice(-2)}`;
}
