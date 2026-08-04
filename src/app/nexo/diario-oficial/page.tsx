import { redirect } from 'next/navigation';

/**
 * O Diário Oficial tem módulo próprio e completo no app principal.
 * Dentro do NEXO, o item de menu encaminha para ele.
 */
export default function NexoDiarioOficialRedirect() {
  redirect('/diario-oficial');
}
