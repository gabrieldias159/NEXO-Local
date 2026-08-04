/**
 * TOOL-SPEC AGNOSTICA de provedor (F5d).
 *
 * Forma NEUTRA de declarar uma ferramenta (function-calling) que o gateway
 * converte para o formato concreto de cada provedor. Hoje o unico provedor com
 * driver de `tools` e o Gemini (via Genkit) — single-provider, rotulado sem
 * failover — entao a unica conversao implementada e `paraGenkit`. Outros
 * provedores (ex.: OpenAI-compat com `tools`/`tool_calls`) plugariam aqui no
 * futuro SEM reescrever quem declara a tool: a tool e descrita uma vez, de
 * forma agnostica, e cada driver a adapta.
 *
 * POR QUE AGNOSTICA: hoje as tools eram `ai.defineTool(...)` (acopladas ao
 * Genkit) declaradas DENTRO do flow de chat. Isso prendia a tool ao Gemini e
 * misturava a logica de negocio (buscar legislacao/oficios) com o transporte. A
 * `ToolSpec` separa as duas coisas: o handler e TypeScript+Zod puro; o driver e
 * quem sabe transformar isso no formato do provedor.
 *
 * COMO CONVERTE PRO GEMINI (`paraGenkit`): recebe a instancia `ai` do Genkit e
 * devolve o objeto de `ai.defineTool({ name, description, inputSchema,
 * outputSchema? }, handler)` — exatamente o que o `ai.generate({ tools: [...] })`
 * espera. O schema Zod e repassado tal-qual (o Genkit ja o entende), e o
 * `executar` da ToolSpec vira o handler. Idempotente o suficiente para ser
 * chamado por requisicao.
 */
import type { ZodTypeAny } from 'zod';

/**
 * Declaracao NEUTRA de uma ferramenta. `parametros` e `saida` sao schemas Zod
 * (a forma comum entre Genkit e a maioria dos SDKs). `executar` e o handler
 * puro (sem dependencia de provedor).
 */
export interface ToolSpec<TIn = unknown, TOut = unknown> {
  /** Nome estavel da ferramenta (usado pelo modelo p/ invoca-la). */
  nome: string;
  /** Descricao para o modelo decidir QUANDO usar a tool. */
  descricao: string;
  /** Schema Zod dos parametros de entrada. */
  parametros: ZodTypeAny;
  /** Schema Zod da saida (opcional, mas recomendado). */
  saida?: ZodTypeAny;
  /** Handler puro: recebe os parametros validados e devolve a saida. */
  executar: (entrada: TIn) => Promise<TOut> | TOut;
}

/**
 * Helper para declarar uma `ToolSpec` com inferencia de tipos preservada. Puro
 * acucar — apenas devolve o objeto tipado.
 */
export function definirTool<TIn = unknown, TOut = unknown>(
  spec: ToolSpec<TIn, TOut>,
): ToolSpec<TIn, TOut> {
  return spec;
}

/**
 * Forma minima da instancia Genkit que precisamos para converter uma tool — so
 * o `defineTool`. Tipada de forma estrutural para nao acoplar este modulo ao
 * import concreto do Genkit (o driver de tools passa o `ai` real).
 */
export interface GenkitToolHost {
  // Assinatura LARGA o suficiente para aceitar a instância concreta do Genkit
  // (cuja `defineTool` tem overloads/genéricos mais estritos). O `config`/handler
  // que passamos satisfaz a forma do Genkit em runtime; o tipo aqui é o contrato
  // mínimo que precisamos chamar.
  defineTool: (config: any, handler: any) => unknown;
}

/**
 * Converte uma `ToolSpec` agnostica para o formato do Genkit (`ai.defineTool`).
 * E a unica conversao implementada hoje (Gemini = unico provedor de `tools`).
 * O schema Zod e repassado intacto; o `executar` vira o handler.
 */
export function paraGenkit(host: GenkitToolHost, spec: ToolSpec): unknown {
  return host.defineTool(
    {
      name: spec.nome,
      description: spec.descricao,
      inputSchema: spec.parametros,
      ...(spec.saida ? { outputSchema: spec.saida } : {}),
    },
    (entrada: unknown) => spec.executar(entrada),
  );
}

/** Converte uma lista de `ToolSpec` para tools do Genkit (conveniencia). */
export function listaParaGenkit(
  host: GenkitToolHost,
  specs: ToolSpec[],
): unknown[] {
  return specs.map((s) => paraGenkit(host, s));
}
