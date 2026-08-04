/**
 * PII de documentos no LADO DA APLICAÇÃO — espelho EXATO de
 * `functions/src/nexo/pii.ts`. Precisa ser idêntico em algoritmo e salt: o
 * detector de doador casa o CNPJ do fornecedor (hasheado aqui, via `hashDocFn`)
 * contra `docHash`/`cpfHash` que os COLETORES gravaram com o pii.ts das
 * functions. Mesmo `sha256(NEXO_PII_SALT + dígitos)` dos dois lados → os hashes
 * casam. Se este divergir do das functions, o cruzamento doador↔fornecedor
 * silenciosamente NÃO casa nada — por isso é uma cópia verbatim, não uma
 * variação.
 *
 * Regra-mãe LGPD: ninguém persiste CPF cru; hash p/ cruzar, máscara p/ exibir.
 * Uso server-side (runtime nodejs) — `node:crypto`.
 */
import { createHash } from 'node:crypto';

/**
 * Salt de FALLBACK — usado só quando `NEXO_PII_SALT` não está no ambiente.
 * DEVE ser idêntico ao fallback de `functions/src/nexo/pii.ts`. Em produção,
 * defina `NEXO_PII_SALT` (segredo) nos DOIS ambientes (App Hosting + functions)
 * com o MESMO valor, senão os hashes não casam entre coletor e detector.
 */
const SALT_FALLBACK = 'nexo-pii-v1-fallback-salt-defina-NEXO_PII_SALT-em-prod';

/** Salt efetivo: env var (segredo, prod) com fallback fixo documentado. */
function salt(): string {
  const s = process.env.NEXO_PII_SALT;
  return s && s.trim() ? s.trim() : SALT_FALLBACK;
}

/** Só os dígitos do documento. */
function soDigitos(v: unknown): string {
  return v == null ? '' : String(v).replace(/\D/g, '');
}

/**
 * Hash determinístico e irreversível de um CPF/CNPJ — chave de junção que NÃO é
 * PII. `sha256(SALT + soDigitos(doc))`. Mesmo doc → mesmo hash (dá pra cruzar),
 * mas não volta pro número. IDÊNTICO ao das functions.
 */
export function hashDoc(cpfOuCnpj: unknown): string {
  const dig = soDigitos(cpfOuCnpj);
  return createHash('sha256').update(salt() + dig).digest('hex');
}

/** Máscara visual de CPF/CNPJ pra exibir sem expor o número inteiro. */
export function mascararDoc(cpfOuCnpj: unknown): string {
  const d = soDigitos(cpfOuCnpj);
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.***/****-${d.slice(12, 14)}`;
  if (d.length === 0) return '';
  if (d.length <= 4) return '*'.repeat(d.length);
  return `${d.slice(0, 2)}${'*'.repeat(d.length - 4)}${d.slice(-2)}`;
}
