/**
 * Ciclo de vida da informação — carimbo de PRIMEIRA observação (`_registradoEm`).
 *
 * Contexto: vários registros vindos de backends (ex.: empenho/pagamento do
 * TCE-SP) não têm data OFICIAL de registro. Nesse caso a semântica útil é: "se
 * apareceu hoje e ontem não existia, foi REGISTRADO hoje". `_coletadoEm` já
 * documenta a ÚLTIMA vez que vimos o registro (sobrescrita a cada merge) — este
 * módulo adiciona o complemento oposto: a PRIMEIRA observação, gravada UMA vez.
 *
 * Como é set-once (primeiro ciclo vence) e idempotente, a varredura é segura de
 * repetir: doc que já tem `_registradoEm` deixa de bater na query, então nunca
 * sobrescrevemos a data original. Não usa transações — cada doc é independente.
 *
 * Prática (Firestore): `where('_registradoEm', '==', null)` casa MISSING e
 * null. Por isso o campo deve ser escrito como `serverTimestamp()` (não como
 * Timestamp JS) para não ser confundido; docs ausentes caem na query e docs
 * já carimbados não.
 */
import { admin, db } from "../shared/admin";

/**
 * Carimba `_registradoEm` (set-once) em documentos de uma coleção `nexo_*`
 * que ainda não o possuam. Execução paginada e delimitada — uma única chamada
 * pode não zerar a fila de pendentes em bases gigantes; quem chama deve repetir
 * nas próximas coletas até retornar 0.
 *
 * @param colecao  Coleção `nexo_*` (ex.: 'nexo_tce_despesas').
 * @returns Quantos docs foram carimbados nesta passada.
 */
export async function carimbarPrimeiraObservacao(colecao: string): Promise<number> {
  const TAM_LOTE = 500;
  const MAX_VOLTAS = 200;
  let carimbados = 0;

  for (let volta = 0; volta < MAX_VOLTAS; volta++) {
    const snap = await db
      .collection(colecao)
      .where("_registradoEm", "==", null)
      .limit(TAM_LOTE)
      .get();

    if (snap.empty) break;

    let batch = db.batch();
    let n = 0;
    for (const doc of snap.docs) {
      batch.update(doc.ref, {
        _registradoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
      carimbados++;
      n++;
      if (n % 400 === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
    if (n % 400 !== 0) await batch.commit();

    if (snap.size < TAM_LOTE) break;
  }

  return carimbados;
}