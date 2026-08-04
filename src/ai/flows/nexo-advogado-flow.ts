'use server';
/**
 * @fileOverview NEXO — vertical ADVOGADO.
 *
 * O "advogado" do complexo de inteligência: aplica o CRIVO JURÍDICO sobre os
 * alertas que o motor de detecção já abriu e prepara, para cada um, o
 * ENQUADRAMENTO normativo + a MINUTA de representação. Não detecta nada novo —
 * recebe indícios prontos e os traduz em peça jurídica sóbria, pronta para o
 * gabinete adaptar e protocolar perante o TCE-SP ou o Ministério Público.
 *
 * ── INVARIANTES INEGOCIÁVEIS (pedido do dono — ver base-legal.ts §9-13) ──────
 *  1. NUNCA enquadrar em Lei 8.429/1992 (improbidade) como AFIRMAÇÃO. Pós-Lei
 *     14.230/2021 a improbidade exige DOLO específico e tem rol TAXATIVO — só
 *     entra como hipótese "a apurar pela instituição competente", jamais como
 *     conclusão. O enquadramento se faz em NORMA ADMINISTRATIVA COGENTE
 *     (14.133/2021, 4.320/1964, LC 101/2000 — LRF, 12.527/2011 — LAI).
 *  2. A `aderenciaNorma` é um CHECKLIST de elementos objetivos verificáveis
 *     (o que a norma exige × o que os dados mostram), NUNCA um "% de ilícito"
 *     ou juízo probabilístico de culpa.
 *  3. Linguagem de INDÍCIO, nunca de acusação. Toda peça carrega disclaimer.
 *
 * Alinhado ao padrão do gabinete (Câmara de Marília): ver
 * src/ai/flows/ai-requerimento-assistant.ts e src/lib/nexo/requerimentos.ts —
 * texto sóbrio, institucional, objetivo, sem retórica nem "considerandos".
 *
 * CONTRATO:
 *   Input  → { alertas: [{ chaveDeteccao, detectorId, titulo, descricao,
 *              classificacao, fundamentoLegal[], evidencias[] }] }
 *   Output → { pareceres: [{ chaveDeteccao, enquadramento, normaPrincipal,
 *              aderenciaNorma, minutaRepresentacao }] }
 */

import { z } from 'genkit';
import { NEXO_DISCLAIMER } from '@/lib/nexo/constants';
import { gerarJson } from '@/ai/multi-provider';

// ── Schemas ───────────────────────────────────────────────────────────────────

/**
 * Coage para STRING um campo de texto livre que o modelo às vezes devolve como
 * array (checklist estruturado) ou objeto — causa nº 1 de reprovação Zod em
 * produção ("aderenciaNorma Expected string, received object/array", ~6×/ciclo,
 * auditoria 2026-07-02). Em vez de derrubar o parecer inteiro (o `gerarJson`
 * repetia o mesmo erro no retry), normaliza a forma:
 *  - array de checklist `[{elemento, presente}]` (e variações item/atende/ok) →
 *    linhas "- <elemento> — atendido/não atendido";
 *  - array simples de strings → linhas com "- ";
 *  - objeto → pares "chave: valor" por linha;
 *  - string/number/etc. → String() direto.
 * Roda como `z.preprocess` (ANTES do `z.string()`), então string legítima passa
 * intacta. Idempotente e defensivo — nunca lança.
 */
function paraTextoLivre(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  const rotuloItem = (o: Record<string, unknown>): string =>
    String(o.elemento ?? o.item ?? o.requisito ?? o.exigencia ?? o.texto ?? o.descricao ?? '')
      .trim();
  const marcaAtende = (o: Record<string, unknown>): boolean | null => {
    const raw = o.presente ?? o.atende ?? o.ok ?? o.atendido ?? o.cumprido;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') return /^(sim|true|1|atendid|presente|cumprid)/i.test(raw.trim());
    return null;
  };
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          const rot = rotuloItem(o);
          const at = marcaAtende(o);
          if (rot) return `- ${rot}${at == null ? '' : at ? ' — atendido' : ' — não atendido'}`;
          return `- ${paraTextoLivre(o)}`;
        }
        return `- ${String(item).trim()}`;
      })
      .filter((l) => l !== '- ')
      .join('\n');
  }
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${typeof val === 'object' ? JSON.stringify(val) : String(val)}`)
      .join('\n');
  }
  return String(v);
}

/** Campo de texto livre TOLERANTE para o schema de VALIDAÇÃO (aceita string,
 *  array-checklist ou objeto sem reprovar). A coerção para string acontece no
 *  emparelhamento (paraTextoLivre), onde montamos o parecer FINAL já tipado como
 *  string — assim o schema estrito público continua `z.string()` e o tipo
 *  público `ParecerAdvogado` permanece com campos string. */
const campoTolerante = () => z.union([z.string(), z.array(z.any()), z.record(z.any())]);

const EvidenciaInputSchema = z
  .object({
    resumo: z.string().describe('Resumo factual da evidência.'),
    valor: z.number().optional().describe('Valor financeiro envolvido (R$).'),
    data: z.string().nullable().optional().describe('Data ISO da evidência.'),
  })
  .describe('Uma evidência objetiva do alerta.');

const AlertaInputSchema = z.object({
  chaveDeteccao: z
    .string()
    .describe('Identidade estável do indício — repassada inalterada na saída.'),
  detectorId: z
    .string()
    .describe('ID do detector (ex.: LC-01) — família do achado.'),
  titulo: z.string().describe('Título do indício.'),
  descricao: z.string().describe('Descrição factual do indício detectado.'),
  classificacao: z
    .string()
    .describe('Classificação do motor: informativo|atencao|suspeita|critico.'),
  fundamentoLegal: z
    .array(z.string())
    .default([])
    .describe('Citações legais já trazidas pelo crivo (norma administrativa).'),
  evidencias: z
    .array(EvidenciaInputSchema)
    .default([])
    .describe('Evidências objetivas que sustentam o indício.'),
});

// NÃO exportar o schema: arquivo 'use server' só pode exportar funções async
// (Next). O schema é interno (usado em definePrompt/defineFlow); o que sai é o
// TIPO (apagado em compile-time) e a função async rodarAdvogado.
const NexoAdvogadoInputSchema = z.object({
  alertas: z
    .array(AlertaInputSchema)
    .describe('Alertas abertos sobre os quais aplicar o crivo jurídico.'),
});
export type NexoAdvogadoInput = z.infer<typeof NexoAdvogadoInputSchema>;

// Schema ESTRITO (público): os campos são string — define o tipo ParecerAdvogado.
const ParecerSchema = z.object({
  chaveDeteccao: z.string(),
  enquadramento: z.string(),
  normaPrincipal: z.string(),
  aderenciaNorma: z.string(),
  minutaRepresentacao: z.string(),
});
export type ParecerAdvogado = z.infer<typeof ParecerSchema>;
export type NexoAdvogadoOutput = { pareceres: ParecerAdvogado[] };

// Schema TOLERANTE (validação da saída do modelo): aceita array/objeto nos
// campos de texto sem reprovar — a coerção p/ string ocorre no emparelhamento.
const ParecerBrutoSchema = z.object({
  chaveDeteccao: z.string().describe('A MESMA chaveDeteccao do alerta de entrada — não inventar.'),
  enquadramento: campoTolerante().describe(
    'Enquadramento em norma administrativa COGENTE (14.133/4.320/LRF/LAI). ' +
      'STRING única multilinha. NUNCA afirma improbidade (8.429): se cabível, só como hipótese "a apurar".',
  ),
  normaPrincipal: campoTolerante().describe(
    'A norma/artigo nuclear do enquadramento (ex.: "Lei 14.133/2021, art. 75"). STRING única.',
  ),
  aderenciaNorma: campoTolerante().describe(
    'Checklist de elementos OBJETIVOS (o que a norma exige × o que os dados ' +
      'mostram), como UMA ÚNICA STRING multilinha (uma linha por elemento, ' +
      'ex.: "- dispensa fundamentada — não atendido"). Se vier como array/objeto ' +
      'será convertido, mas o esperado é STRING. NUNCA um "% de ilícito" nem juízo de culpa.',
  ),
  minutaRepresentacao: campoTolerante().describe(
    'Minuta sóbria de representação ao TCE-SP (art. 113, §1º, da LC 709/93) ou ' +
      'de Notícia de Fato ao MP-SP, com disclaimer. STRING única multilinha.',
  ),
});

const NexoAdvogadoOutputSchema = z.object({
  pareceres: z.array(ParecerBrutoSchema).describe('Um parecer jurídico por alerta de entrada.'),
});

// ── Entrada pública ─────────────────────────────────────────────────────────

/**
 * Aplica o crivo jurídico sobre um conjunto de alertas abertos. Pode lançar se a
 * IA falhar (chave ausente, indisponibilidade) — o chamador (API route) é quem
 * decide como degradar honestamente. NUNCA mascara erro como sucesso.
 */
export async function rodarAdvogado(
  input: NexoAdvogadoInput,
): Promise<NexoAdvogadoOutput> {
  return nexoAdvogadoFlow(input);
}

// ── Prompt ────────────────────────────────────────────────────────────────────

// Sistema (papel + regras inegociáveis). Antes era o cabeçalho do template
// Handlebars; agora é uma string passada ao multi-provider (grátis primeiro,
// Gemini de fallback). A LISTA DE ALERTAS é montada por `montarAlertas` e vai
// no prompt de usuário.
const SISTEMA_ADVOGADO = `Você é o ADVOGADO do NEXO — núcleo de fiscalização parlamentar do Gabinete do Vereador, Câmara Municipal de Marília/SP. Sua função NÃO é detectar nada novo: os indícios já foram apurados por um motor de dados. Você aplica sobre cada indício o CRIVO JURÍDICO e prepara o ENQUADRAMENTO normativo + a MINUTA de representação para o gabinete adaptar.

**MISSÃO POR ALERTA:** para CADA alerta da lista, produza um parecer com quatro campos — \`enquadramento\`, \`normaPrincipal\`, \`aderenciaNorma\`, \`minutaRepresentacao\` — e devolva a MESMA \`chaveDeteccao\` recebida (cópia exata, nunca inventada).

**REGRAS INEGOCIÁVEIS (violar qualquer uma invalida o parecer):**

1.  **ENQUADRAMENTO SÓ EM NORMA ADMINISTRATIVA COGENTE.** Use exclusivamente:
    - Lei 14.133/2021 (licitações e contratos: dispensa art. 75, inexigibilidade art. 74, aditivos arts. 124-125, sanções art. 14);
    - Lei 4.320/1964 (execução da despesa: empenho arts. 58-60, liquidação arts. 62-63, pagamento arts. 64-65);
    - LC 101/2000 — LRF (limites, restos a pagar art. 42, transparência art. 48, mínimos);
    - Lei 12.527/2011 — LAI (transparência ativa e passiva);
    - CF/1988 art. 37 (princípios), arts. 198 e 212 (mínimos de saúde e educação);
    - DL 201/1967 (crimes de responsabilidade de prefeitos: art. 1º, I — apropriar-se de rendas; III — aplicar indevidamente verbas; V — despesa sem empenho; XII — quebrar ordem cronológica; XIX — deixar de promover liquidação de operação de crédito);
    - Resolução do Senado Federal nº 40/2001 (limites da dívida consolidada e concessão de garantias);
    - Resolução do Senado Federal nº 43/2001 (limites para operações de crédito: restos a pagar art. 7º);
    - LC estadual nº 709/1993 (Lei Orgânica do TCE-SP: art. 113, §1º — representação de cidadão ao Tribunal).
    Prefira as normas que JÁ vieram em \`fundamentoLegal\` — elas passaram pelo crivo do sistema. Acrescente artigos pertinentes, mas no MESMO universo normativo administrativo.

2.  **PROIBIDO AFIRMAR IMPROBIDADE.** É TERMINANTEMENTE VEDADO enquadrar o indício na Lei 8.429/1992 (improbidade administrativa) como afirmação ou conclusão. Pós-Lei 14.230/2021, a improbidade exige DOLO específico e tem rol TAXATIVO de condutas. Se — e somente se — for tecnicamente cabível, mencione a 8.429 APENAS como hipótese a ser apurada pela instituição competente, sempre com a ressalva literal "a apurar" ou "eventual, a depender de investigação". NUNCA escreva que o agente "praticou improbidade", "cometeu ato ímprobo" ou equivalente. O mesmo vale para crime: não tipifique condutas penais como certas.

3.  **\`aderenciaNorma\` É CHECKLIST OBJETIVO, NÃO PERCENTUAL.** Liste os ELEMENTOS OBJETIVOS que a norma principal exige e confronte cada um com o que os dados do alerta mostram (atendido / não evidenciado / a verificar com documentos). **FORMATO: uma ÚNICA STRING de texto, com uma linha por elemento (prefixe cada linha com "- "). NUNCA devolva este campo como array JSON ou objeto — todos os quatro campos do parecer são STRINGS.** É PROIBIDO escrever "X% de ilícito", "probabilidade de crime", "Y% de chance de irregularidade" ou qualquer métrica de culpa. Trabalhe só com elementos verificáveis: "- a norma exige pesquisa de preços (art. X) — os dados não evidenciam; verificar no processo administrativo". O resultado é um roteiro de verificação, não um veredito.

4.  **LINGUAGEM DE INDÍCIO, NUNCA ACUSAÇÃO.** O texto é sóbrio, institucional, técnico e impessoal. Nada de "absurdo", "descaso", "desvio comprovado", "fraude". Use "indício", "padrão atípico", "aparente desconformidade a apurar". O indício pode ter explicação legítima — o objetivo é levar à apuração pelo órgão competente, não condenar.

**MINUTA DE REPRESENTAÇÃO (\`minutaRepresentacao\`):**
Escolha o destinatário pelo perfil do indício:
- Matéria de gestão fiscal/contratos/contas → **REPRESENTAÇÃO ao Tribunal de Contas do Estado de São Paulo (TCE-SP)**, com fundamento no art. 113, §1º, da Lei Orgânica do TCE-SP (LC estadual nº 709/1993), que assegura a qualquer cidadão, partido, associação ou sindicato a legitimidade para denunciar irregularidades.
- Indício com possível repercussão que extrapole o controle de contas → **NOTÍCIA DE FATO ao Ministério Público do Estado de São Paulo (MP-SP)** (Resolução CNMP nº 174/2017), para conhecimento e eventual apuração.
Estrutura da minuta (texto corrido, sóbrio, pronto para adaptar):
  (a) cabeçalho curto identificando a peça e o destinatário;
  (b) exposição FACTUAL do indício, calcada apenas na \`descricao\` e nas \`evidencias\` (não invente valores, datas ou nomes que não estejam nos dados);
  (c) fundamentação: a \`normaPrincipal\` e os dispositivos administrativos pertinentes, indicando o que precisa ser apurado — SEM afirmar improbidade ou crime;
  (d) pedido: que o órgão receba a representação/notícia e apure os fatos, requisitando à origem os documentos que comprovem (ou afastem) a desconformidade;
  (e) ao final, em parágrafo próprio, o DISCLAIMER literal abaixo.

**DISCLAIMER OBRIGATÓRIO** (copie LITERALMENTE ao fim de cada \`minutaRepresentacao\`):
"${NEXO_DISCLAIMER}"

**FIDELIDADE AOS DADOS:** use somente os números, datas, nomes e valores presentes em cada alerta. NÃO invente dados ausentes. Se uma informação não foi fornecida, refira-se a ela como "a ser verificada junto à origem".

**ALERTAS A ANALISAR:**
A LISTA DE ALERTAS A ANALISAR é fornecida na mensagem do usuário, no mesmo formato.

Produza o objeto JSON com \`pareceres\` — UM parecer por alerta, na MESMA ordem, repetindo a \`chaveDeteccao\` exata de cada um. Não acrescente nem omita alertas.`;

/**
 * Monta o bloco "ALERTAS A ANALISAR" (antes o trecho Handlebars do template).
 * Vira o prompt de usuário do multi-provider.
 */
function montarAlertas(input: NexoAdvogadoInput): string {
  const blocos = input.alertas.map((a) => {
    const fundamentos =
      a.fundamentoLegal.length > 0
        ? a.fundamentoLegal.map((f) => `  - ${f}`).join('\n')
        : '  - (nenhum fundamento prévio)';
    const evidencias =
      a.evidencias.length > 0
        ? a.evidencias
            .map(
              (e) =>
                `  - ${e.resumo}` +
                (e.valor != null ? ` (R$ ${e.valor})` : '') +
                (e.data ? ` [${e.data}]` : ''),
            )
            .join('\n')
        : '  - (sem evidências detalhadas)';
    return [
      '---',
      `ALERTA chaveDeteccao=${a.chaveDeteccao} | detector=${a.detectorId} | classificacao=${a.classificacao}`,
      `Título: ${a.titulo}`,
      `Descrição: ${a.descricao}`,
      'Fundamento legal já apurado pelo crivo:',
      fundamentos,
      'Evidências:',
      evidencias,
    ].join('\n');
  });
  return [
    'ALERTAS A ANALISAR:',
    ...blocos,
    '---',
    '',
    'Produza o objeto JSON com `pareceres` — UM parecer por alerta acima, na ' +
      'MESMA ordem, repetindo a `chaveDeteccao` exata de cada um. Não acrescente ' +
      'nem omita alertas.',
  ].join('\n');
}

// ── Flow ──────────────────────────────────────────────────────────────────────

async function nexoAdvogadoFlow(
  input: NexoAdvogadoInput,
): Promise<NexoAdvogadoOutput> {
  // Sem alertas → nada a fazer (evita uma chamada à IA à toa).
  if (!input.alertas || input.alertas.length === 0) {
    return { pareceres: [] };
  }

  // Grátis primeiro (NVIDIA → Groq → OpenRouter), Gemini de FALLBACK. A
  // validação Zod (com 1 retry) garante o mesmo contrato do antigo definePrompt.
  const { dados: output } = await gerarJson({
    system: SISTEMA_ADVOGADO,
    prompt: montarAlertas(input),
    schema: NexoAdvogadoOutputSchema,
    temperature: 0.2,
  });

  // Defesa do invariante #1 mesmo se o modelo escorregar: re-emparelha os
  // pareceres às chaves de entrada (mantendo a ordem da entrada) e sanitiza
  // qualquer AFIRMAÇÃO de improbidade que tenha vazado para o texto.
  {
    const porChave = new Map(
      output.pareceres.map((p) => [p.chaveDeteccao, p]),
    );
    const pareceres: ParecerAdvogado[] = input.alertas.map((a, i) => {
      const bruto =
        porChave.get(a.chaveDeteccao) ?? output.pareceres[i] ?? null;
      if (!bruto) {
        // Degrada honesto para este alerta: parecer mínimo, sem inventar.
        return {
          chaveDeteccao: a.chaveDeteccao,
          enquadramento:
            'Enquadramento não gerado automaticamente — revisar manualmente.',
          normaPrincipal: a.fundamentoLegal[0] ?? '',
          aderenciaNorma:
            'Checklist não gerado — verificar os elementos da norma junto à origem.',
          minutaRepresentacao: NEXO_DISCLAIMER,
        };
      }
      // paraTextoLivre coage array-checklist/objeto → string ANTES de sanitizar
      // (o schema tolerante deixou passar; aqui viram os campos string do parecer).
      return {
        chaveDeteccao: a.chaveDeteccao, // força a chave correta
        enquadramento: removerPercentualDeCulpa(
          sanitizarImprobidade(paraTextoLivre(bruto.enquadramento)),
        ),
        normaPrincipal: paraTextoLivre(bruto.normaPrincipal),
        // A 3ª perna é CHECKLIST objetivo: além de sanitizar improbidade,
        // remove qualquer "% de ilícito/culpa" que tenha vazado (invariante #2).
        aderenciaNorma: removerPercentualDeCulpa(
          sanitizarImprobidade(paraTextoLivre(bruto.aderenciaNorma)),
        ),
        minutaRepresentacao: garantirDisclaimer(
          removerPercentualDeCulpa(
            sanitizarImprobidade(paraTextoLivre(bruto.minutaRepresentacao)),
          ),
        ),
      };
    });

    return { pareceres };
  }
}

// ── Guardas do invariante (defense-in-depth) ──────────────────────────────────

/**
 * Se o texto AFIRMAR improbidade (8.429 sem ressalva), insere a ressalva
 * "(a apurar pela instituição competente)" — nunca propaga a afirmação. Barato,
 * idempotente: se já houver ressalva próxima, não duplica.
 */
function sanitizarImprobidade(texto: string): string {
  if (!texto) return texto;
  const RE_IMPROB = /\b(8\.?429|improbidade|ato[s]? ímprobo[s]?)\b/gi;
  if (!RE_IMPROB.test(texto)) return texto;
  // Já tem ressalva no texto inteiro? Então confiamos que está como hipótese.
  if (/a apurar|em tese|eventual|hip[óo]tese|se comprovad|a depender de/i.test(texto)) {
    return texto;
  }
  // Reinsere o marcador (regex global precisa do lastIndex resetado).
  RE_IMPROB.lastIndex = 0;
  return texto.replace(
    RE_IMPROB,
    (m) => `${m} (hipótese a apurar pela instituição competente)`,
  );
}

/**
 * Invariante #2 (3ª perna): a aderência à norma é CHECKLIST, NUNCA um "% de
 * ilícito/culpa". Se o modelo escorregar e emitir um percentual atado a um
 * juízo de culpa ("70% de irregularidade", "probabilidade de improbidade: 80%"),
 * troca o número pela expressão qualitativa "(grau a apurar)" — preserva a frase
 * sem o veredito numérico. NÃO toca em percentuais legítimos e neutros (ex.:
 * "reajuste de 25%", "execução de 60% do contrato"): só dispara quando o
 * percentual está colado a uma palavra de CULPA. Idempotente.
 */
function removerPercentualDeCulpa(texto: string): string {
  if (!texto) return texto;
  const CULPA =
    'il[íi]cito|irregularidade|improbidade|culpa|crime|fraude|dolo|enquadramento';
  // "<n>% de <culpa>"  →  "(grau a apurar) de <culpa>"
  const RE_ANTES = new RegExp(
    `\\d{1,3}(?:[.,]\\d+)?\\s*%\\s*(de|da|de\\s+chance\\s+de)\\s+(${CULPA})`,
    'gi',
  );
  // "<culpa> ...: <n>%"  ou  "<culpa> de <n>%"  →  "<culpa> ...: (grau a apurar)"
  const RE_DEPOIS = new RegExp(
    `(${CULPA})([^.\\n]{0,24}?)(?:de\\s+)?\\d{1,3}(?:[.,]\\d+)?\\s*%`,
    'gi',
  );
  return texto
    .replace(RE_ANTES, (_m, _liga, palavra) => `(grau a apurar) de ${palavra}`)
    .replace(RE_DEPOIS, (_m, palavra, meio) => `${palavra}${meio}(grau a apurar)`);
}

/** Garante que a minuta termine com o disclaimer literal do NEXO. */
function garantirDisclaimer(texto: string): string {
  const t = (texto ?? '').trim();
  if (t.includes(NEXO_DISCLAIMER)) return t;
  return `${t}\n\n${NEXO_DISCLAIMER}`;
}
