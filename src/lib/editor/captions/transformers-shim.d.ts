/**
 * Shim de tipos para `@huggingface/transformers` (transformers.js v3).
 *
 * Existe SÓ para que `tsc --noEmit` não quebre enquanto a dependência ainda
 * não foi instalada/vendorada pelo orquestrador. O worker importa a lib
 * dinamicamente e a usa como `any`, então só precisamos que o módulo
 * "exista" para o type-checker.
 *
 * Quando o pacote real for instalado, ele traz os próprios tipos; este
 * arquivo pode ser removido (ou mantido — `skipLibCheck` evita conflito de
 * checagem interna). Mantemos as assinaturas frouxas (`any`) de propósito.
 */
declare module '@huggingface/transformers' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const pipeline: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const env: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any;
  export default _default;
}
