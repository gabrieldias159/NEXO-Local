/**
 * Conversão dos segmentos de transcrição (Whisper via transformers.js) para
 * `CaptionCue` (sem id) prontos para `addCaption(...)`.
 *
 * Mantém-se PURO (sem React, sem dependência da lib STT) para poder rodar em
 * worker / SSR / testes. Reaproveita `ParsedCue` e `DEFAULT_PARSER_STYLE` do
 * parser de .srt e os utilitários de higiene de `utils.ts`.
 *
 * Sem IA paga, sem APIs externas — só transformação de dados.
 */

import type { ParsedCue } from './parser';
import { DEFAULT_PARSER_STYLE } from './parser';

/**
 * Formato de um "chunk" devolvido pelo pipeline `automatic-speech-recognition`
 * do transformers.js com `return_timestamps: true`.
 *
 * `timestamp` é `[start, end]` em **segundos**. O `end` pode vir `null` no
 * último chunk de um stream — tratamos isso no mapeamento.
 */
export interface TranscriptionChunk {
  text: string;
  timestamp: [number, number | null];
}

const MIN_CUE_DURATION = 0.3;

/**
 * Converte os chunks de transcrição em `ParsedCue[]`.
 *
 * - Descarta chunks sem texto.
 * - Garante `endTime > startTime` (usa o início do próximo chunk como fim
 *   quando o `end` vier nulo; senão soma uma duração mínima).
 * - Ordena por `startTime` e clampa tempos negativos.
 * - Aplica `DEFAULT_PARSER_STYLE` (o usuário re-estiliza depois).
 *
 * @param chunks segmentos crus do pipeline.
 * @param totalDuration duração total do áudio (s), usada como fallback do
 *   `end` do último chunk. Opcional.
 */
export function chunksToCues(
  chunks: TranscriptionChunk[],
  totalDuration?: number,
): ParsedCue[] {
  const cleaned = chunks
    .map((c) => ({
      text: (c.text ?? '').replace(/\s+/g, ' ').trim(),
      start: Number.isFinite(c.timestamp?.[0]) ? Math.max(0, c.timestamp[0]) : 0,
      end:
        c.timestamp?.[1] != null && Number.isFinite(c.timestamp[1])
          ? Math.max(0, c.timestamp[1] as number)
          : null,
    }))
    .filter((c) => c.text.length > 0)
    .sort((a, b) => a.start - b.start);

  const out: ParsedCue[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const cur = cleaned[i];
    const next = cleaned[i + 1];

    let end = cur.end;
    if (end == null || end <= cur.start) {
      // Fim ausente/inválido: usa início do próximo, ou fallback.
      if (next) {
        end = Math.max(cur.start + MIN_CUE_DURATION, next.start);
      } else if (totalDuration && totalDuration > cur.start) {
        end = totalDuration;
      } else {
        end = cur.start + MIN_CUE_DURATION;
      }
    }
    // Não deixa um cue invadir o início do próximo.
    if (next && end > next.start) {
      end = Math.max(cur.start + 0.05, next.start);
    }

    out.push({
      startTime: cur.start,
      endTime: Math.max(cur.start + 0.05, end),
      text: cur.text,
      slot: 'full',
      style: { ...DEFAULT_PARSER_STYLE },
    });
  }

  return out;
}
