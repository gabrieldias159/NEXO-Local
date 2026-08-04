/**
 * Identidade estável dos alertas pré-computados do NEXO (Fase 2 do monitoramento).
 *
 * A detecção saiu do caminho por-request para o pré-computado: o cron roda os
 * detectores e grava em `nexo_alertas`; as páginas só LEEM alertas prontos. Para
 * o mesmo indício não duplicar a cada execução do monitor, cada `AlertaDetectado`
 * recebe uma `chaveDeteccao` determinística — o upsert na coleção usa essa chave
 * como `id` do documento, então re-rodar o detector ATUALIZA o alerta existente
 * (incrementando `ocorrencias`/`ultimaDeteccaoEm`) em vez de criar outro.
 */
import { createHash } from 'node:crypto';
import type { AlertaDetectado } from '@/lib/nexo/detectores';

/** Um `AlertaDetectado` já carimbado com sua identidade estável. */
export type AlertaComChave = AlertaDetectado & { chaveDeteccao: string };

/**
 * Chave de deduplicação determinística de um indício.
 *
 * `sha1(detectorId | exercicio | sujeitoTipo | sujeitoId | discriminador)`.
 * O `discriminador` é o campo opcional já existente em `AlertaDetectado` que
 * distingue múltiplos episódios do mesmo detector+sujeito (ex.: a janela
 * trimestral de um fracionamento). Na ausência dele, há 1 alerta por
 * detector+sujeito no exercício.
 */
export function chaveDeteccao(alerta: AlertaDetectado, exercicio: number): string {
  const partes = [
    alerta.detectorId,
    String(exercicio),
    alerta.sujeitoTipo,
    alerta.sujeitoId,
    alerta.discriminador ?? '',
  ];
  return createHash('sha1').update(partes.join('|')).digest('hex');
}
