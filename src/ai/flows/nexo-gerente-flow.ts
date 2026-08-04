'use server';
/**
 * @fileOverview Vertical GERENTE do NEXO — o "gerente de fiscalização".
 *
 * A cada 30 min um cron (functions/src/nexo/gerente.ts) olha o estado do NEXO
 * — os alertas ativos top-priorizados + a saúde das fontes — e pede a este flow
 * um BRIEFING de gestão: o que priorizar agora, o que está degradado, e qual a
 * próxima ação. NÃO é o redator de requerimento nem um detector: é o gerente que
 * lê o painel e escreve um resumo executivo sóbrio para quem fiscaliza.
 *
 * Tom OBRIGATÓRIO: factual, curto, "indício a apurar" — nunca acusação, nunca
 * retórica. Trabalha SÓ com os dados recebidos (sem alucinar números/nomes).
 *
 * Exports:
 *  - `gerarBriefingGerente` — recebe o estado do NEXO, devolve o briefing.
 *  - `NexoGerenteInput` / `NexoGerenteOutput` — tipos de entrada/saída.
 */

import { z } from 'genkit';
import { NEXO_DISCLAIMER } from '@/lib/nexo/constants';
import { gerarJson } from '@/ai/multi-provider';

const AlertaResumoSchema = z.object({
  detectorId: z.string().describe('ID do detector, ex.: "LC-01".'),
  titulo: z.string().describe('Título do indício.'),
  classificacao: z
    .string()
    .describe("Severidade: 'informativo' | 'atencao' | 'suspeita' | 'critico'."),
  valorEnvolvido: z
    .number()
    .describe('Valor financeiro envolvido em R$ (0 quando não houver).'),
  scores: z
    .object({
      confiabilidade: z.number().optional(),
      probabilidadeIrregularidade: z.number().optional(),
      probabilidadeEnquadramento: z.number().optional(),
    })
    .describe('Score triplo do indício (0..100 por perna).'),
  ultimaDeteccaoEm: z
    .string()
    .nullable()
    .describe('Carimbo ISO da última detecção, ou null.'),
});

const FonteResumoSchema = z.object({
  fonte: z.string().describe('Nome curto da fonte, ex.: "smarapd", "pncp".'),
  statusSaude: z
    .string()
    .describe("Saúde da fonte: 'ok' | 'stale' | 'degradado' | 'falha'."),
  erro: z.string().nullable().describe('Última mensagem de erro, ou null.'),
});

const NexoGerenteInputSchema = z.object({
  alertas: z
    .array(AlertaResumoSchema)
    .describe('Alertas ATIVOS top-priorizados (já ordenados por potencial desc).'),
  fontes: z
    .array(FonteResumoSchema)
    .describe('Estado de saúde de cada fonte de coleta do NEXO.'),
});
export type NexoGerenteInput = z.infer<typeof NexoGerenteInputSchema>;

const NexoGerenteOutputSchema = z.object({
  resumo: z
    .string()
    .describe(
      'Resumo executivo de 3 a 5 linhas, sóbrio e factual, tratando tudo como ' +
        '"indício a apurar". Sem retórica, sem juízo de valor.',
    ),
  topPrioridades: z
    .array(
      z.object({
        titulo: z.string().describe('Título do indício a priorizar.'),
        porque: z
          .string()
          .describe(
            'Por que priorizar — 1 frase factual citando SÓ severidade e/ou ' +
              'valor em R$. NUNCA percentual de score/ilícito/improbidade.',
          ),
      }),
    )
    .describe('Até 3 prioridades, da mais grave/provável para a menos.'),
  fontesDegradadas: z
    .array(z.string())
    .describe('Nomes das fontes com saúde diferente de "ok" (vazio se todas ok).'),
  proximaAcao: z
    .string()
    .describe('Uma única próxima ação concreta de gestão da fiscalização.'),
  disclaimer: z
    .string()
    .default(NEXO_DISCLAIMER)
    .describe(
      'Disclaimer obrigatório do NEXO (copiado LITERALMENTE). Reforça que nada ' +
        'aqui é acusação, prova de improbidade ou de ilícito.',
    ),
});
export type NexoGerenteOutput = z.infer<typeof NexoGerenteOutputSchema>;

export async function gerarBriefingGerente(
  input: NexoGerenteInput,
): Promise<NexoGerenteOutput> {
  return nexoGerenteFlow(input);
}

// Sistema (papel + regras) — antes era o cabeçalho do template Handlebars.
// Agora é uma string montada e passada ao multi-provider (grátis primeiro,
// Gemini de fallback). O ESTADO ATUAL (alertas/fontes) é montado por
// `montarEstadoAtual` e anexado como prompt de usuário.
const SISTEMA_GERENTE = `Você é o GERENTE de fiscalização do NEXO — sala de situação que monitora exclusivamente a Prefeitura Municipal de Marília/SP. Sua função é ler o painel (alertas ativos + saúde das fontes) e escrever um BRIEFING de gestão para quem fiscaliza.

REGRAS ABSOLUTAS:
- Trabalhe SOMENTE com os dados fornecidos abaixo. NÃO invente números, nomes, valores, datas ou detectores.
- Tom factual e sóbrio. Toda menção a um achado é "indício a apurar", NUNCA acusação, ilícito, improbidade, fraude, crime ou condenação. NUNCA afirme que alguém "praticou", "desviou", "fraudou" ou "cometeu" qualquer coisa — o indício pode ter explicação legítima.
- NUNCA exponha os scores como percentual de culpa. Os números "prob. irregularidade" e "prob. enquadramento" são apenas critérios INTERNOS de ordenação; é PROIBIDO escrevê-los no texto como "X% de irregularidade", "X% de ilícito" ou "X% de chance de improbidade". No texto, cite só severidade e valor em R$.
- Sem retórica, sem moralização, sem juízo de valor, sem adjetivos de indignação ("absurdo", "descaso", "grave omissão"). Apenas fatos e o que apurar.
- Curto e direto. O resumo tem de 3 a 5 linhas.

COMO PRIORIZAR:
- Ordene do mais grave/provável para o menos: classificação "critico" > "suspeita" > "atencao" > "informativo"; em empate, use os scores internos (maior probabilidade combinada) e maior valorEnvolvido primeiro. Esses scores guiam a ORDEM, mas NÃO entram no texto como percentuais.
- Em "topPrioridades", liste no máximo 3 indícios. Para cada um, "porque" é UMA frase factual citando APENAS o motivo objetivo público: a severidade (ex.: "classificado como crítico") e/ou o valor em R$. Não cite percentuais de score.

FONTES:
- "fontesDegradadas": liste os nomes das fontes cujo statusSaude é diferente de "ok" (stale, degradado, falha). Se todas estiverem "ok", devolva lista vazia.
- Mencione no resumo, em uma frase, se há fonte degradada (a fiscalização pode estar cega numa fonte).

PRÓXIMA AÇÃO:
- "proximaAcao": UMA ação concreta de gestão — ex.: "Abrir apuração do indício LC-01 (fracionamento) de maior valor" ou "Verificar a coleta da fonte X, parada há 2 ciclos". Se não houver alerta nem fonte degradada, indique manter o monitoramento.

FORMATO DA SAÍDA (JSON): um objeto com 'resumo' (string, 3-5 linhas), 'topPrioridades' (array de até 3 objetos { titulo, porque }), 'fontesDegradadas' (array de strings), 'proximaAcao' (string) e 'disclaimer' (string).

DISCLAIMER OBRIGATÓRIO (copie LITERALMENTE no campo 'disclaimer', sem alterar uma vírgula):
"${NEXO_DISCLAIMER}"`;

/**
 * Monta o bloco "ESTADO ATUAL DO NEXO" (alertas + fontes) que antes era o
 * trecho Handlebars do template. Vira o prompt de usuário do multi-provider.
 */
function montarEstadoAtual(input: NexoGerenteInput): string {
  const linhasAlertas =
    input.alertas.length > 0
      ? input.alertas
          .map((a) => {
            const s = a.scores ?? {};
            return (
              `- [${a.detectorId}] ${a.titulo} — classificação: ${a.classificacao}; ` +
              `valor: R$ ${a.valorEnvolvido}; última detecção: ${a.ultimaDeteccaoEm ?? 'n/d'} ` +
              `(scores internos de ordenação — não citar como %: ` +
              `confiab.=${s.confiabilidade ?? 'n/d'}, ` +
              `irreg.=${s.probabilidadeIrregularidade ?? 'n/d'}, ` +
              `enq.=${s.probabilidadeEnquadramento ?? 'n/d'})`
            );
          })
          .join('\n')
      : '- Nenhum alerta ativo no momento.';

  const linhasFontes =
    input.fontes.length > 0
      ? input.fontes
          .map(
            (f) =>
              `- ${f.fonte}: ${f.statusSaude}${f.erro ? ` (erro: ${f.erro})` : ''}`,
          )
          .join('\n')
      : '- Sem dados de saúde de fontes.';

  return [
    'ESTADO ATUAL DO NEXO:',
    '',
    'ALERTAS ATIVOS (top priorizados):',
    linhasAlertas,
    '',
    'SAÚDE DAS FONTES:',
    linhasFontes,
  ].join('\n');
}

async function nexoGerenteFlow(
  input: NexoGerenteInput,
): Promise<NexoGerenteOutput> {
  // Grátis primeiro (NVIDIA → Groq → OpenRouter), Gemini de FALLBACK. A
  // validação Zod garante o mesmo contrato de saída do antigo definePrompt.
  const { dados } = await gerarJson({
    system: SISTEMA_GERENTE,
    prompt: montarEstadoAtual(input),
    schema: NexoGerenteOutputSchema,
    temperature: 0.3,
  });
  // Disclaimer é LEI no NEXO: força o texto canônico, ignorando qualquer
  // variação que o modelo tenha inventado (mesma disciplina do advogado).
  return { ...dados, disclaimer: NEXO_DISCLAIMER };
}
