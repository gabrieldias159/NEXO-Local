/**
 * Camada de IA MULTI-PROVIDER (server-side, runtime nodejs) — AGNÓSTICA de
 * provedor, DIRIGIDA POR CONFIG e OBSERVÁVEL.
 *
 * OBJETIVO DO DONO: usar provedores GRÁTIS como PRIORIDADE e o Gemini (pago)
 * só como FALLBACK; mas trocar/forçar/reordenar qualquer provedor deve ser
 * CONFIGURAÇÃO, não reescrita.
 *
 * COMO A CADEIA É MONTADA (não é mais hardcoded):
 *   - O REGISTRY de provedores vive em `@/ai/ia-config` (PROVIDERS_REGISTRY) —
 *     cada provedor OpenAI-compat é só uma entrada (driver genérico abaixo); o
 *     Gemini é o único driver especial (via Genkit).
 *   - O doc `config/ia` (lido via endpoint das Functions, com cache de 45s)
 *     define: por provedor → habilitado/ordem/modelo; e um modo global:
 *       • 'auto'                → failover na ORDEM (grátis → ... → Gemini);
 *       • 'forcar:<provedor>'   → usa SÓ aquele (com fallback opcional na ordem).
 *   - Se a config não vier (endpoint off/erro), usa o DEFAULT do registry — que
 *     reproduz o comportamento histórico (NVIDIA → Groq → OpenRouter → Gemini).
 *
 * LÓGICA por chamada (preservada):
 *   - para cada provider na cadeia → tenta cada KEY do provider;
 *   - em 429/limite/5xx/timeout/401/403 → ROTACIONA a key; esgotadas → próximo;
 *   - provider SEM chave no env é PULADO; timeout por chamada: 30s.
 *   - loga (SEM expor a key) qual provider/modelo respondeu.
 *
 * OBSERVABILIDADE: cada chamada (sucesso OU falha) emite um evento de uso
 * (provedor, modelo, tokens in/out, latência, 429, erro) via
 * `registrarUsoIa` — POST fire-and-forget ao endpoint das Functions, que
 * agrega em `ia_uso/{AAAA-MM-DD}`. Falha de registro é silenciosa.
 *
 * API pública (100% COMPATÍVEL — assinaturas e failover inalterados):
 *   - gerarTexto({ system?, prompt, temperature? }) → { texto, provedor, modelo }
 *   - gerarJson<T>({ system?, prompt, schema, temperature? })
 *       → { dados: T, provedor, modelo }
 *   - haAlgumProvedorDeIa() → boolean
 *
 * NÃO hardcoda nenhuma chave: tudo vem de process.env via sanitizeApiKey.
 */
import type { ZodType } from 'zod';
import { sanitizeApiKey, resolveGeminiApiKey } from '@/ai/api-key';
import { listaParaGenkit, type ToolSpec } from '@/ai/tools/tool-spec';
import {
  PROVIDERS_REGISTRY,
  CAPACIDADES_PADRAO,
  labelDoProvedor,
  lerConfigIa,
  registrarUsoIa,
  type IaConfigDoc,
  type IaMeta,
  type ProvedorRegistro,
  type ProtocoloIa,
  type CapacidadeIa,
  type ClasseErroIa,
} from '@/ai/ia-config';

// ── Configuração ──────────────────────────────────────────────────────────────

/**
 * Timeout por chamada HTTP a um provider (ms).
 *
 * TRADEOFF (reduzido de 30s → 14s em jun/2026): a cadeia tenta vários provedores
 * grátis em sequência (NVIDIA → Groq → OpenRouter → ... → Gemini). Com 30s por
 * tentativa, um único provedor grátis lento/pendurado podia segurar a UI por 30s
 * ANTES de cair pro próximo — e, no pior caso (vários lentos), a espera somava
 * minutos, lendo como "travado". Com 14s, um provedor lento é abandonado mais
 * cedo e a cascata escoa pro próximo rapidamente. A CONFIABILIDADE é preservada:
 * o fallback continua intacto (só desistimos MAIS CEDO de uma tentativa
 * individual), e 14s ainda é folgado para uma geração de texto típica desses
 * modelos (que respondem em poucos segundos quando estão saudáveis). Se algum
 * provedor específico precisar de mais tempo no futuro, dá pra promover isto a
 * config por provedor sem mexer no orquestrador.
 */
const TIMEOUT_MS = 14_000;

/** Espera bounded (ms) antes de rotacionar key em 429 — evita queimar todas as
 *  chaves num burst quando a cota reseta por janela. Cap em 8s + jitter. */
const BACKOFF_429_MS = 2_000;
const BACKOFF_429_MAX_MS = 8_000;
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Tipos públicos (inalterados) ───────────────────────────────────────────────

export interface GerarTextoInput {
  /** Mensagem de sistema (papel/regras). Opcional. */
  system?: string;
  /** Prompt do usuário (conteúdo). */
  prompt: string;
  /** Temperatura (0..2). Default 0.3. */
  temperature?: number;
}

export interface GerarTextoResultado {
  texto: string;
  /** Nome do provider que respondeu (ex.: 'nvidia', 'groq', 'gemini'). */
  provedor: string;
  /** Modelo concreto que respondeu. */
  modelo: string;
}

export interface GerarJsonInput<T> {
  system?: string;
  prompt: string;
  /** Schema Zod que valida (e tipa) a saída. */
  schema: ZodType<T>;
  temperature?: number;
  /** Fila preferencial p/ esta chamada (ordem/modelo/timeout). Ex.: PERFIS_IA.redacao. */
  preferir?: string[];
  modeloPorProvedor?: Record<string, string>;
  timeoutMs?: number;
}

export interface GerarJsonResultado<T> {
  dados: T;
  provedor: string;
  modelo: string;
}

/**
 * Roteamento por chamada (FILAS PREFERENCIAIS por tipo de trabalho). Permite que
 * cargas distintas usem ordens/modelos/timeouts distintos SEM brigar pela mesma
 * cota — ex.: o lote pesado de DIÁRIO fica no NVIDIA (5 chaves, folga), e a
 * REDAÇÃO interativa fica no Groq (rápido), com NVIDIA leve só de fallback.
 */
export interface RoteamentoIa {
  /** Nomes de provedores em PRIORIDADE p/ esta chamada (os demais viram fallback). */
  preferir?: string[];
  /** Override de modelo por provedor NESTA chamada (ex.: NVIDIA leve p/ redação). */
  modeloPorProvedor?: Record<string, string>;
  /** Timeout por chamada (ms). */
  timeoutMs?: number;
}

/** Perfis nomeados de roteamento — um lugar só pra ajustar a política das filas. */
export const PERFIS_IA: Record<'diario' | 'redacao', RoteamentoIa> = {
  // DIÁRIO/DOMM: prompt gigante, lote → NVIDIA 70B primeiro (5 chaves). Timeout
  // 45s por chave: 5×45=225s de orçamento NVIDIA cabe nos 480s da rota com folga
  // p/ fallback (Groq/Gemini) — 60s × 5 estourava o teto antes do failover.
  diario: { preferir: ['nvidia'], timeoutMs: 45_000 },
  // REDAÇÃO: interativo → Groq primeiro (rápido); NVIDIA com modelo LEVE e
  // timeout curto como fallback (não rouba a cota do diário). Modelo configurável.
  redacao: {
    preferir: ['groq', 'nvidia'],
    modeloPorProvedor: { nvidia: 'meta/llama-3.1-8b-instruct' },
    timeoutMs: 20_000,
  },
};

// ── Provedor RESOLVIDO (registry + env + config) ───────────────────────────────

/** Um provedor pronto para uso na cadeia (modelo concreto já resolvido). */
interface ProvedorResolvido {
  nome: string;
  base: string;
  model: string;
  keyEnvVars: string[];
  /** Já RESOLVIDO (thunk avaliado): headers extras planos prontos p/ uso. */
  headersExtra?: Record<string, string>;
  ehGemini: boolean;
  /** Protocolo de transporte resolvido (chave da tabela DRIVERS). */
  protocolo: ProtocoloIa;
  /** Capacidades que o provedor declara sustentar. */
  capacidades: CapacidadeIa[];
  ordem: number;
}

/**
 * Mensagem de chat MULTI-TURN. Mantém a forma simples `content: string` (todos
 * os call-sites texto/json usam só isso) e RESERVA `partes` para conteúdo
 * multimodal (texto+media) das frentes futuras — drivers de visão/áudio leem
 * `partes` quando presente; os drivers de texto leem `content`. Aditivo: quem só
 * passa `content` continua igual.
 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** Conteúdo textual (caminho ativo: texto/json). */
  content: string;
  /**
   * Partes multimodais (reservado p/ visão/áudio — F5d/F3). Quando presente,
   * drivers multimodais a consomem; drivers de texto usam `content`.
   */
  partes?: Array<
    | { tipo: 'texto'; texto: string }
    | { tipo: 'media'; dataUri: string; mime?: string }
  >;
}

/**
 * PAYLOAD por capacidade — união discriminada que os drivers recebem. Hoje só os
 * ramos 'texto'/'json' são exercidos (carregam `messages[]` multi-turn). Os
 * demais ficam DECLARADOS p/ as frentes que introduzem áudio/imagem/visão/tools/
 * streaming plugarem sem mudar a assinatura do dispatch.
 */
export type PayloadCapacidade =
  | {
      cap: 'texto' | 'json';
      messages: ChatMessage[];
      temperature: number;
      jsonMode: boolean;
      /** Timeout por chamada (ms). Caminho pesado (diário) usa mais que os 14s padrão. */
      timeoutMs?: number;
      /** Fila preferencial: ordem de provedores p/ esta chamada. */
      preferir?: string[];
      /** Override de modelo por provedor p/ esta chamada. */
      modeloPorProvedor?: Record<string, string>;
    }
  | {
      cap: 'audio';
      audioDataUri: string;
      mime?: string;
      /** Idioma do áudio (ISO-639-1, ex.: 'pt') — repassado ao Whisper. Opcional. */
      idioma?: string;
      /** Prompt/contexto da transcrição (Whisper `prompt` / instrução Gemini). Opcional. */
      prompt?: string;
      /** Pede SEGMENTOS com timestamps (Whisper verbose_json / Gemini JSON). Opcional. */
      segmentado?: boolean;
    }
  | { cap: 'imagem'; prompt: string; aspecto?: string }
  | { cap: 'visao'; messages: ChatMessage[]; temperature: number; timeoutMs?: number }
  | {
      cap: 'tools';
      messages: ChatMessage[];
      system?: string;
      temperature: number;
      /** Ferramentas AGNOSTICAS (function-calling) — o driver as adapta ao provedor. */
      tools: ToolSpec[];
    }
  | { cap: 'streaming'; messages: ChatMessage[]; temperature: number };

/**
 * Monta a lista de mensagens a partir de system?/prompt (caminho clássico) OU de
 * uma lista de mensagens multi-turn já pronta. Quando `messages` é dado, ele é
 * usado tal-qual (permitindo histórico assistant/user) e `system`/`prompt` são
 * prefixados se presentes. Sem `messages`, reproduz o comportamento histórico
 * (system + 1 user) byte-a-byte.
 */
function montarMensagens(
  system: string | undefined,
  prompt: string,
  historico?: ChatMessage[],
): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  if (system && system.trim()) msgs.push({ role: 'system', content: system });
  if (historico && historico.length) msgs.push(...historico);
  if (prompt && prompt.length) msgs.push({ role: 'user', content: prompt });
  return msgs;
}

/** Avalia `headersExtra` (objeto OU thunk lazy) → objeto plano. */
function resolverHeadersExtra(
  h: ProvedorRegistro['headersExtra'],
): Record<string, string> | undefined {
  if (!h) return undefined;
  return typeof h === 'function' ? h() : h;
}

/**
 * Modelo concreto do provedor para uma capacidade:
 *   config.modelo > env > registry.modeloPorCapacidade[cap] > registry.modeloDefault.
 * Para 'texto'/'json' não há `modeloPorCapacidade` nos provedores atuais, então o
 * resultado é IDÊNTICO ao histórico (config.modelo > env > modeloDefault).
 */
function modeloDoProvedor(
  reg: ProvedorRegistro,
  cfg: IaConfigDoc,
  cap: CapacidadeIa = 'texto',
): string {
  const override = cfg.provedores?.[reg.nome]?.modelo?.trim();
  if (override) return override;
  if (reg.modelEnvVar) {
    const envModel = process.env[reg.modelEnvVar]?.trim();
    if (envModel) return envModel;
  }
  const porCap = reg.modeloPorCapacidade?.[cap];
  if (porCap) return porCap;
  return reg.modeloDefault;
}

/**
 * Protocolo resolvido para uma capacidade:
 *   protocoloPorCapacidade[cap] > protocolo > 'gemini' se ehGemini > 'openai-compat'.
 * Capability-aware p/ provedores que falam transportes diferentes por capacidade
 * (ex.: Groq = 'openai-compat' em texto, 'whisper-multipart' em áudio).
 */
function protocoloDoProvedor(
  reg: ProvedorRegistro,
  cap: CapacidadeIa = 'texto',
): ProtocoloIa {
  const porCap = reg.protocoloPorCapacidade?.[cap];
  if (porCap) return porCap;
  if (reg.protocolo) return reg.protocolo;
  return reg.ehGemini ? 'gemini' : 'openai-compat';
}

/** Capacidades declaradas (ausente → padrão ['texto','json']). */
function capacidadesDoProvedor(reg: ProvedorRegistro): CapacidadeIa[] {
  return reg.capacidades ?? CAPACIDADES_PADRAO;
}

/** Resolve as chaves SANITIZADAS de um provider (ignora env vars vazias). */
function chavesDoProvider(p: { keyEnvVars: string[] }): string[] {
  const chaves: string[] = [];
  for (const envVar of p.keyEnvVars) {
    const k = sanitizeApiKey(process.env[envVar]);
    if (k) chaves.push(k);
  }
  return chaves;
}

/**
 * CONSTRÓI a cadeia de provedores para uma CAPACIDADE, a partir do registry +
 * env + config. Aplica, na ordem:
 *   - resolve protocolo/capacidades/headers (thunk avaliado);
 *   - FILTRA quem não declara a capacidade pedida (eixo de capacidade F1/F2);
 *   - habilitado (default true);
 *   - ordem: `config.capacidades[cap].ordem` se existir, senão config.ordem >
 *     registry.ordemDefault (legado);
 *   - modo 'forcar:<provedor>': `config.capacidades[cap].modo` se existir, senão
 *     `config.modo` (legado). O forçado é IGNORADO se não declarar a capacidade
 *     (log honesto — não trava uma capacidade que o forçado não sustenta).
 *
 * Para 'texto'/'json' SEM `config.capacidades`, o resultado é IDÊNTICO ao
 * comportamento histórico (todos os 4 provedores declaram texto/json, e a
 * resolução cai no legado `modo`/`provedores`). Porta de não-regressão.
 *
 * Provedores sem chave no env são MANTIDOS aqui (o orquestrador os pula em
 * runtime e loga), exceto que isso não afeta a ordem.
 */
async function montarCadeia(
  capacidade: CapacidadeIa = 'texto',
  opts?: { preferir?: string[]; modeloPorProvedor?: Record<string, string> },
): Promise<ProvedorResolvido[]> {
  let cfg: IaConfigDoc = {};
  try {
    cfg = await lerConfigIa();
  } catch {
    cfg = {};
  }

  const capCfg = cfg.capacidades?.[capacidade];

  const resolvidos: ProvedorResolvido[] = PROVIDERS_REGISTRY.map((reg) => {
    const pc = cfg.provedores?.[reg.nome];
    return {
      nome: reg.nome,
      base: reg.base,
      model: modeloDoProvedor(reg, cfg, capacidade),
      keyEnvVars: reg.keyEnvVars,
      headersExtra: resolverHeadersExtra(reg.headersExtra),
      ehGemini: reg.ehGemini ?? false,
      protocolo: protocoloDoProvedor(reg, capacidade),
      capacidades: capacidadesDoProvedor(reg),
      ordem: pc?.ordem ?? reg.ordemDefault,
    };
  });

  // EIXO DE CAPACIDADE: só provedores que declaram a capacidade pedida.
  let habilitados = resolvidos.filter((r) =>
    r.capacidades.includes(capacidade),
  );

  // Filtra desabilitados.
  habilitados = habilitados.filter(
    (r) => cfg.provedores?.[r.nome]?.habilitado !== false,
  );

  // Ordem específica da capacidade (se houver) sobrepõe a ordem numérica.
  const ordemCap = capCfg?.ordem;
  if (ordemCap && ordemCap.length) {
    const idx = new Map(ordemCap.map((nome, i) => [nome, i]));
    const FIM = ordemCap.length + 1000;
    habilitados.sort(
      (a, b) =>
        (idx.get(a.nome) ?? a.ordem + FIM) - (idx.get(b.nome) ?? b.ordem + FIM),
    );
  } else {
    habilitados.sort((a, b) => a.ordem - b.ordem);
  }

  // Modo forçar: capacidade-específico se houver, senão o legado global.
  const modo = capCfg?.modo ?? cfg.modo;
  if (modo?.tipo === 'forcar') {
    const forcado = habilitados.find((r) => r.nome === modo.provedor);
    if (forcado) {
      if (modo.comFallback) {
        // Forçado primeiro; os demais (na ordem) como fallback.
        habilitados = [
          forcado,
          ...habilitados.filter((r) => r.nome !== modo.provedor),
        ];
      } else {
        habilitados = [forcado];
      }
    } else if (
      modo.provedor &&
      !resolvidos.some(
        (r) => r.nome === modo.provedor && r.capacidades.includes(capacidade),
      )
    ) {
      // Forçado NÃO sustenta esta capacidade → ignora o forçar (log honesto),
      // mantém a cadeia 'auto' filtrada — não trava a capacidade.
      logProvider(
        `forçar '${modo.provedor}' ignorado p/ capacidade '${capacidade}'` +
          ` (provedor não a declara) — usando cadeia auto`,
      );
    }
    // Se o forçado existe mas está desabilitado, mantém 'auto' (não trava o dono).
  }

  // FILA PREFERENCIAL por chamada (sobre a ordem da config): os provedores em
  // `preferir` vêm primeiro, na ordem dada; os demais mantêm a ordem relativa
  // (sort estável no V8). Não REMOVE ninguém — só reordena (failover preservado).
  if (opts?.preferir && opts.preferir.length) {
    const pref = new Map(opts.preferir.map((n, i) => [n, i]));
    const MAX = Number.MAX_SAFE_INTEGER;
    habilitados = [...habilitados].sort(
      (a, b) => (pref.get(a.nome) ?? MAX) - (pref.get(b.nome) ?? MAX),
    );
  }

  // Override de MODELO por provedor p/ esta chamada (ex.: NVIDIA leve na redação).
  if (opts?.modeloPorProvedor) {
    habilitados = habilitados.map((r) =>
      opts.modeloPorProvedor![r.nome]
        ? { ...r, model: opts.modeloPorProvedor![r.nome] }
        : r,
    );
  }

  return habilitados;
}

// ── Erros retryable ────────────────────────────────────────────────────────────

class ProviderRetryableError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderRetryableError';
  }
}

/** 429/5xx/timeout/401/403 → rotaciona/cai na cadeia (máxima disponibilidade). */
function statusEhRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500 || status === 401 || status === 403;
}

/**
 * Falha POR-CHAVE — vale rotacionar p/ a próxima env var do MESMO provedor:
 * cota (429) ou credencial (401/403). Timeout/rede/5xx (status undefined ou
 * >=500) e erro duro são do PROVEDOR: trocar de chave não cura, então pula
 * direto pro próximo provedor (evita gastar 5×timeout num provedor morto —
 * NVIDIA fora custava 5×14s no default e 5×45s no diário antes do failover).
 */
function ehFalhaDeChave(err: unknown): boolean {
  if (!(err instanceof ProviderRetryableError)) return false;
  return err.status === 429 || err.status === 401 || err.status === 403;
}

/**
 * Classifica a CAUSA de uma tentativa que falhou, para observabilidade (aditivo
 * — não muda o failover). Usa o `httpStatus` quando há, senão infere pela
 * mensagem (timeout/rede/vazio/json). Default 'outro'.
 */
function classificarErro(
  err: unknown,
  httpStatus?: number,
): ClasseErroIa {
  if (typeof httpStatus === 'number') {
    if (httpStatus === 429) return '429';
    if (httpStatus === 401 || httpStatus === 403) return 'auth';
    if (httpStatus >= 500) return '5xx';
    if (httpStatus >= 400) return '4xx';
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes('timeout') || msg.includes('aborterror')) return 'timeout';
  if (msg.includes('sem conteúdo') || msg.includes('vazia') || msg.includes('vazio'))
    return 'vazio';
  if (msg.includes('json')) return 'json_invalido';
  if (msg.includes('rede') || msg.includes('não-json')) return 'rede';
  return 'outro';
}

/** Loga sem NUNCA imprimir a chave. */
function logProvider(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[multi-provider] ${msg}`);
}

// ── Driver OpenAI-compat (genérico p/ TODOS os provedores não-Gemini) ──────────

/** Tokens extraídos do `usage` (OpenAI-compat) ou usageMetadata (Gemini). */
interface Uso {
  tokensEntrada: number;
  tokensSaida: number;
}

interface RespostaProvider {
  content: string;
  uso: Uso;
  /** Mídia gerada (data URI) — capacidade 'imagem'. Texto-only deixa indefinido. */
  midia?: string;
  /** Segmentos com timestamps — capacidade 'audio' segmentada. Indefinido se não pedido. */
  segmentos?: SegmentoTranscricao[];
}

/** Segmento de transcrição com tempos em SEGUNDOS (relativos ao áudio enviado). */
export interface SegmentoTranscricao {
  start: number;
  end: number;
  text: string;
}

/** Segmento aceitável: tempos finitos, start≥0, end>start, texto presente. */
function segmentoValido(s: SegmentoTranscricao): boolean {
  return (
    Number.isFinite(s.start) &&
    s.start >= 0 &&
    Number.isFinite(s.end) &&
    s.end > s.start &&
    !!s.text
  );
}

/**
 * Faz UMA chamada chat/completions a um provider OpenAI-compatível. Devolve o
 * `content` + os tokens do campo `usage`. Lança `ProviderRetryableError` em
 * 429/5xx/timeout (para o orquestrador rotacionar).
 */
async function chamarOpenAiCompat(args: {
  provider: ProvedorResolvido;
  key: string;
  messages: ChatMessage[];
  temperature: number;
  jsonMode: boolean;
  /** Timeout específico (ms) — caminhos pesados (ex.: diário) pedem mais. Default TIMEOUT_MS. */
  timeoutMs?: number;
}): Promise<RespostaProvider> {
  const { provider, key, messages, temperature, jsonMode } = args;
  const url = `${provider.base}/chat/completions`;

  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    temperature,
  };
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(provider.headersExtra ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const motivo =
      err instanceof Error && err.name === 'AbortError'
        ? `timeout após ${TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'erro de rede';
    throw new ProviderRetryableError(`${provider.nome}: ${motivo}`, provider.nome);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    let detalhe = '';
    try {
      detalhe = (await resp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    if (statusEhRetryable(resp.status)) {
      throw new ProviderRetryableError(
        `${provider.nome}: HTTP ${resp.status} ${detalhe}`,
        provider.nome,
        resp.status,
      );
    }
    throw new Error(`${provider.nome}: HTTP ${resp.status} ${detalhe}`);
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    throw new ProviderRetryableError(
      `${provider.nome}: resposta não-JSON`,
      provider.nome,
    );
  }

  const content = extrairContent(json);
  if (content == null || content.trim() === '') {
    throw new ProviderRetryableError(
      `${provider.nome}: resposta sem conteúdo`,
      provider.nome,
    );
  }
  return { content, uso: extrairUsoOpenAi(json) };
}

/** Extrai choices[0].message.content da resposta OpenAI-compatível. */
function extrairContent(json: unknown): string | null {
  const j = json as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const c = j?.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : null;
}

/** Extrai usage.prompt_tokens / usage.completion_tokens (OpenAI-compat). */
function extrairUsoOpenAi(json: unknown): Uso {
  const u = (json as { usage?: Record<string, unknown> })?.usage ?? {};
  const ent = Number(u.prompt_tokens);
  const sai = Number(u.completion_tokens);
  return {
    tokensEntrada: Number.isFinite(ent) ? ent : 0,
    tokensSaida: Number.isFinite(sai) ? sai : 0,
  };
}

// ── Driver Gemini (via Genkit) ─────────────────────────────────────────────────

/**
 * Chama o Gemini via o Genkit existente. Import dinâmico para não puxar o
 * Genkit/Google SDK quando os grátis já resolveram. Devolve texto + tokens do
 * `usage` do Genkit (input/outputTokens), quando disponíveis.
 */
async function chamarGemini(args: {
  modelo: string;
  messages: ChatMessage[];
  temperature: number;
}): Promise<RespostaProvider> {
  if (!resolveGeminiApiKey()) {
    throw new Error('Gemini indisponível: GEMINI_API_KEY ausente');
  }
  const { ai } = await import('@/ai/genkit');
  const sys = args.messages.find((m) => m.role === 'system')?.content ?? '';
  const usr = args.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n\n');

  const resposta = await ai.generate({
    model: args.modelo,
    ...(sys ? { system: sys } : {}),
    prompt: usr,
    config: { temperature: args.temperature },
  });
  const text = resposta.text;
  if (!text || !text.trim()) {
    throw new Error('Gemini devolveu resposta vazia');
  }
  // Genkit expõe usage em resposta.usage (input/outputTokens).
  const usage = (resposta as { usage?: Record<string, unknown> }).usage ?? {};
  const ent = Number(usage.inputTokens);
  const sai = Number(usage.outputTokens);
  return {
    content: text,
    uso: {
      tokensEntrada: Number.isFinite(ent) ? ent : 0,
      tokensSaida: Number.isFinite(sai) ? sai : 0,
    },
  };
}

// ── Tabela de drivers: DRIVERS[capacidade][protocolo] ──────────────────────────

/**
 * Uma função-driver: recebe o provedor resolvido, a chave (já sanitizada; para o
 * Gemini é o sentinela lógico) e o payload da capacidade; devolve texto + tokens
 * ou lança `ProviderRetryableError` (rotaciona) / `Error` (erro duro).
 *
 * O `if (ehGemini)` histórico VIRA esta tabela: o orquestrador olha
 * `DRIVERS[capacidade][protocolo]` e chama o driver. Hoje só os ramos
 * 'texto'/'json' × {openai-compat, gemini} estão preenchidos; as demais células
 * ficam vazias (→ `NoDriverForCapability`) até as frentes F3/F5/F6 plugarem
 * `audio`/`imagem`/`visao`/`tools`/`streaming`. Adicionar um driver é só
 * preencher uma célula — não tocar no laço.
 */
type DriverFn = (args: {
  provider: ProvedorResolvido;
  key: string;
  payload: PayloadCapacidade;
}) => Promise<RespostaProvider>;

/** Driver de chat OpenAI-compat (texto/json) — envelopa `chamarOpenAiCompat`. */
const driverChatOpenAi: DriverFn = async ({ provider, key, payload }) => {
  if (payload.cap !== 'texto' && payload.cap !== 'json') {
    throw new Error(
      `driverChatOpenAi: payload incompatível (cap=${payload.cap})`,
    );
  }
  return chamarOpenAiCompat({
    provider,
    key,
    messages: payload.messages,
    temperature: payload.temperature,
    jsonMode: payload.jsonMode,
    timeoutMs: payload.timeoutMs,
  });
};

/** Driver de chat Gemini (texto/json) — envelopa `chamarGemini`. */
const driverChatGemini: DriverFn = async ({ provider, payload }) => {
  if (payload.cap !== 'texto' && payload.cap !== 'json') {
    throw new Error(
      `driverChatGemini: payload incompatível (cap=${payload.cap})`,
    );
  }
  return chamarGemini({
    modelo: provider.model,
    messages: payload.messages,
    temperature: payload.temperature,
  });
};

// ── Driver de ÁUDIO: Groq Whisper (multipart) ──────────────────────────────────

/**
 * Decodifica um data URI (`data:<mime>;base64,<dados>`) em bytes + mime. Aceita
 * também base64 cru (sem prefixo `data:`) com um mime opcional informado pelo
 * payload. Lança se o conteúdo não puder ser decodificado.
 */
function decodificarAudio(
  audioDataUri: string,
  mimePayload?: string,
): { buffer: ArrayBuffer; mime: string } {
  const cru = audioDataUri.trim();
  let mime = mimePayload || 'audio/mpeg';
  let base64: string;
  const virgula = cru.indexOf(',');
  if (cru.startsWith('data:') && virgula !== -1) {
    const cabecalho = cru.slice(5, virgula); // ex.: 'audio/webm;base64'
    if (!/;base64/i.test(cabecalho)) {
      // data URI sem base64 (texto puro) — não é áudio válido p/ transcrição.
      throw new Error('audio: data URI sem base64 não suportado');
    }
    const mimeNoCabecalho = cabecalho.replace(/;base64.*/i, '').trim();
    if (mimeNoCabecalho) mime = mimePayload || mimeNoCabecalho;
    base64 = cru.slice(virgula + 1);
  } else {
    base64 = cru;
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    throw new Error('audio: base64 inválido');
  }
  // Copia para um ArrayBuffer próprio (evita o SharedArrayBuffer do pool do Node
  // e satisfaz o tipo BlobPart).
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return { buffer: ab, mime };
}

/** Extensão de arquivo plausível a partir do mime (Whisper exige um nome). */
function extDoMime(mime: string): string {
  const map: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'mp4',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
  };
  return map[mime.toLowerCase()] ?? 'mp3';
}

/** Limite de tamanho de áudio do tier grátis da Groq Whisper (25 MB). */
const GROQ_WHISPER_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Driver Groq Whisper: POST multipart/form-data para `{base}/audio/transcriptions`
 * (OpenAI-compat). Campos `file` (Blob do áudio) + `model` (whisper-large-v3).
 * Repassa `language`/`prompt` quando o payload os traz. Lê `{text}` da resposta.
 * Lança `ProviderRetryableError` em 429/5xx/timeout (rotaciona/cai pro Gemini).
 *
 * Limite honesto: arquivos > 25 MB são rejeitados ANTES da chamada como erro
 * retryable → o orquestrador cai no Gemini (que aceita áudios maiores via inline
 * data). Áudio que estoure também o Gemini lança erro duro lá.
 */
const driverWhisperGroq: DriverFn = async ({ provider, key, payload }) => {
  if (payload.cap !== 'audio') {
    throw new Error(`driverWhisperGroq: payload incompatível (cap=${payload.cap})`);
  }
  const { buffer, mime } = decodificarAudio(payload.audioDataUri, payload.mime);

  if (buffer.byteLength > GROQ_WHISPER_MAX_BYTES) {
    // Maior que o tier grátis da Groq → deixa o Gemini assumir (retryable).
    throw new ProviderRetryableError(
      `${provider.nome}: áudio ${(buffer.byteLength / 1048576).toFixed(1)}MB > limite 25MB do Whisper`,
      provider.nome,
    );
  }

  const url = `${provider.base}/audio/transcriptions`;
  const form = new FormData();
  const blob = new Blob([buffer], { type: mime });
  form.append('file', blob, `audio.${extDoMime(mime)}`);
  form.append('model', provider.model);
  // Segmentado → verbose_json (traz `segments` com start/end); senão, json simples.
  if (payload.segmentado) {
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
  } else {
    form.append('response_format', 'json');
  }
  if (payload.idioma && payload.idioma.trim()) {
    form.append('language', payload.idioma.trim());
  }
  if (payload.prompt && payload.prompt.trim()) {
    form.append('prompt', payload.prompt.trim());
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        // NÃO setar Content-Type: o fetch monta o boundary do multipart.
        ...(provider.headersExtra ?? {}),
      },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    const motivo =
      err instanceof Error && err.name === 'AbortError'
        ? `timeout após ${TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'erro de rede';
    throw new ProviderRetryableError(`${provider.nome}: ${motivo}`, provider.nome);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    let detalhe = '';
    try {
      detalhe = (await resp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    if (statusEhRetryable(resp.status)) {
      throw new ProviderRetryableError(
        `${provider.nome}: HTTP ${resp.status} ${detalhe}`,
        provider.nome,
        resp.status,
      );
    }
    throw new Error(`${provider.nome}: HTTP ${resp.status} ${detalhe}`);
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    throw new ProviderRetryableError(
      `${provider.nome}: resposta não-JSON`,
      provider.nome,
    );
  }
  const texto = (json as { text?: unknown })?.text;
  if (typeof texto !== 'string' || texto.trim() === '') {
    throw new ProviderRetryableError(
      `${provider.nome}: transcrição vazia`,
      provider.nome,
    );
  }

  // Segmentado: extrai `segments` do verbose_json (start/end em segundos).
  let segmentos: SegmentoTranscricao[] | undefined;
  if (payload.segmentado) {
    const segs = (json as { segments?: unknown }).segments;
    if (Array.isArray(segs)) {
      segmentos = segs
        .map((s) => {
          const o = s as { start?: unknown; end?: unknown; text?: unknown };
          return {
            start: Number(o.start),
            end: Number(o.end),
            text: typeof o.text === 'string' ? o.text.trim() : '',
          };
        })
        .filter((s) => segmentoValido(s));
    }
    if (!segmentos || segmentos.length === 0) {
      // Pediu segmentos e o Whisper não entregou → deixa o Gemini tentar.
      throw new ProviderRetryableError(
        `${provider.nome}: verbose_json sem segments utilizáveis`,
        provider.nome,
      );
    }
  }

  // Whisper não devolve usage de tokens; reporta 0 (observabilidade honesta).
  return { content: texto, uso: { tokensEntrada: 0, tokensSaida: 0 }, segmentos };
};

// ── Driver de ÁUDIO: Gemini (via Genkit, multimodal) — FALLBACK ─────────────────

/**
 * Driver de transcrição via Gemini (Genkit), reproduzindo o caminho que o
 * `ai-audio-transcriber` usava direto: `{{media url=audioDataUri}}` + instrução
 * de transcrever. É o FALLBACK do failover de áudio (Groq Whisper → Gemini) e o
 * caminho GARANTIDO quando a Groq não tem chave/quota — comportamento idêntico
 * ao de hoje (Gemini-only) nesse caso.
 */
const driverAudioGemini: DriverFn = async ({ provider, payload }) => {
  if (payload.cap !== 'audio') {
    throw new Error(`driverAudioGemini: payload incompatível (cap=${payload.cap})`);
  }
  if (!resolveGeminiApiKey()) {
    throw new Error('Gemini indisponível: GEMINI_API_KEY ausente');
  }
  const { ai } = await import('@/ai/genkit');

  const idiomaHint = payload.idioma ? ` Idioma: ${payload.idioma}.` : '';
  // No modo segmentado, o `prompt` do caller (contexto/glossário/nomes) é
  // INCORPORADO à instrução de JSON — não pode ser descartado no fallback.
  const contextoHint =
    payload.segmentado && payload.prompt && payload.prompt.trim()
      ? ` Contexto para guiar a transcrição: ${payload.prompt.trim()}`
      : '';
  const instrucao = payload.segmentado
    ? 'Transcreva o áudio a seguir em SEGMENTOS curtos (1 a 6 segundos cada) com ' +
      'marcação de tempo. Responda EXCLUSIVAMENTE com um JSON no formato ' +
      '{"segments":[{"start":<segundos>,"end":<segundos>,"text":"..."}]} — tempos em ' +
      'SEGUNDOS relativos ao início do áudio, sem texto fora do JSON.' +
      idiomaHint +
      contextoHint
    : (payload.prompt && payload.prompt.trim()) ||
      'Transcreva o áudio a seguir com precisão.' + idiomaHint;

  // A data URI já carrega o MIME (`data:<mime>;base64,...`), então `media.url`
  // basta — mesmo formato de parte usado nos flows multimodais existentes.
  const resposta = await ai.generate({
    model: provider.model,
    prompt: [
      { text: instrucao },
      { media: { url: payload.audioDataUri } },
    ],
  });
  const texto = resposta.text;
  if (!texto || !texto.trim()) {
    throw new Error('Gemini devolveu transcrição vazia');
  }
  const usage = (resposta as { usage?: Record<string, unknown> }).usage ?? {};
  const ent = Number(usage.inputTokens);
  const sai = Number(usage.outputTokens);

  // Segmentado: parseia {segments:[...]} do texto e devolve `content` como o
  // texto concatenado dos segmentos (compatível com o caminho não-segmentado).
  let segmentos: SegmentoTranscricao[] | undefined;
  let conteudo = texto;
  if (payload.segmentado) {
    let bruto: unknown;
    try {
      bruto = JSON.parse(extrairJsonBruto(texto));
    } catch {
      throw new Error('Gemini não devolveu JSON de segmentos válido');
    }
    const segs = (bruto as { segments?: unknown }).segments;
    if (!Array.isArray(segs) || segs.length === 0) {
      throw new Error('Gemini não devolveu o array segments');
    }
    segmentos = segs
      .map((s) => {
        const o = s as { start?: unknown; end?: unknown; text?: unknown };
        return {
          start: Number(o.start),
          end: Number(o.end),
          text: typeof o.text === 'string' ? o.text.trim() : '',
        };
      })
      .filter((s) => segmentoValido(s));
    if (segmentos.length === 0) {
      throw new Error('Gemini: nenhum segmento utilizável após parse');
    }
    conteudo = segmentos.map((s) => s.text).join(' ');
  }

  return {
    content: conteudo,
    uso: {
      tokensEntrada: Number.isFinite(ent) ? ent : 0,
      tokensSaida: Number.isFinite(sai) ? sai : 0,
    },
    segmentos,
  };
};

// ── Drivers MULTIMODAIS Gemini: VISÃO (anexos) e TOOLS (function-calling) ───────

/** Tipo de uma parte Genkit (texto OU media via data URI). */
type GenkitPart = { text: string } | { media: { url: string } };

/**
 * Converte uma `ChatMessage` (forma do gateway, com `partes` multimodais) para
 * a lista de partes Genkit. Quando há `partes`, mapeia texto→{text} e
 * media→{media:{url}}; sem `partes`, usa o `content` textual.
 */
function partesGenkit(m: ChatMessage): GenkitPart[] {
  if (m.partes && m.partes.length) {
    return m.partes.map((p) =>
      p.tipo === 'media'
        ? ({ media: { url: p.dataUri } } as GenkitPart)
        : ({ text: p.texto } as GenkitPart),
    );
  }
  return [{ text: m.content }];
}

/**
 * Reparte `ChatMessage[]` (incluindo system + histórico + última mensagem do
 * usuário) na forma que o `ai.generate` do Genkit espera:
 *   - `system`: concatena as mensagens 'system';
 *   - `messages`: histórico (tudo que NÃO é system nem a última do usuário),
 *      com role 'user'/'model' (Genkit usa 'model', não 'assistant');
 *   - `prompt`: as partes da ÚLTIMA mensagem do usuário (carrega anexos/mídia).
 * Reproduz o formato que o chat-assistant montava à mão (system + messages +
 * prompt com `userMessageParts`).
 */
function repartirParaGenkit(messages: ChatMessage[]): {
  system: string;
  history: Array<{ role: 'user' | 'model'; content: GenkitPart[] }>;
  prompt: GenkitPart[];
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .filter((s) => s && s.trim())
    .join('\n\n');

  const naoSystem = messages.filter((m) => m.role !== 'system');

  // A última mensagem do usuário vira o `prompt` (carrega os anexos). Se a
  // última não for do usuário, mantemos tudo como histórico e prompt vazio.
  let prompt: GenkitPart[] = [];
  let history = naoSystem;
  const ultima = naoSystem[naoSystem.length - 1];
  if (ultima && ultima.role === 'user') {
    prompt = partesGenkit(ultima);
    history = naoSystem.slice(0, -1);
  }

  return {
    system,
    history: history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      content: partesGenkit(m),
    })),
    prompt,
  };
}

/** Lê usage (input/outputTokens) de uma resposta Genkit. */
function usoDoGenkit(resposta: unknown): Uso {
  const usage = (resposta as { usage?: Record<string, unknown> }).usage ?? {};
  const ent = Number(usage.inputTokens);
  const sai = Number(usage.outputTokens);
  return {
    tokensEntrada: Number.isFinite(ent) ? ent : 0,
    tokensSaida: Number.isFinite(sai) ? sai : 0,
  };
}

/**
 * Driver de VISÃO (anexos imagem/PDF) via Gemini/Genkit. SINGLE-PROVIDER: só o
 * Gemini lê mídia inline hoje — `montarCadeia('visao')` resolve só ele e, sem
 * Gemini, o orquestrador lança `NoDriverForCapability` (erro honesto, sem
 * cascata simulada). Reproduz o caminho multimodal que o chat fazia direto
 * (system + messages + prompt com `{media:{url}}`).
 */
const driverVisaoGemini: DriverFn = async ({ provider, payload }) => {
  if (payload.cap !== 'visao') {
    throw new Error(`driverVisaoGemini: payload incompatível (cap=${payload.cap})`);
  }
  if (!resolveGeminiApiKey()) {
    throw new Error('Gemini indisponível: GEMINI_API_KEY ausente');
  }
  const { ai } = await import('@/ai/genkit');
  const { system, history, prompt } = repartirParaGenkit(payload.messages);

  // Genkit `ai.generate` não expõe timeout nativo; um Gemini travado prenderia a
  // instância. Corrida com um timeout bounded (default 14s; o diário passa 180s
  // via payload.timeoutMs). O erro é retryable p/ o orquestrador (aqui é single-
  // provider Gemini, então cai numa falha honesta em vez de pendurar).
  const limiteMs = payload.timeoutMs ?? TIMEOUT_MS;
  const resposta = await Promise.race([
    ai.generate({
      model: provider.model,
      ...(system ? { system } : {}),
      ...(history.length ? { messages: history } : {}),
      prompt,
      config: { temperature: payload.temperature },
    }),
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new ProviderRetryableError(`timeout após ${limiteMs}ms (visão)`, provider.nome)),
        limiteMs,
      ),
    ),
  ]);
  const texto = resposta.text;
  if (!texto || !texto.trim()) {
    throw new Error('Gemini devolveu resposta vazia (visão)');
  }
  return { content: texto, uso: usoDoGenkit(resposta) };
};

/**
 * Driver de TOOLS (function-calling) via Gemini/Genkit. SINGLE-PROVIDER: só o
 * Gemini sustenta o loop de tool-calls hoje — rotulado sem failover. As tools
 * chegam como `ToolSpec` AGNOSTICAS e são convertidas para `ai.defineTool` em
 * runtime (`listaParaGenkit`); o Genkit conduz o loop de `tool_calls`
 * internamente. Reproduz o caminho Gemini+tools+messages do chat-assistant.
 */
const driverToolsGemini: DriverFn = async ({ provider, payload }) => {
  if (payload.cap !== 'tools') {
    throw new Error(`driverToolsGemini: payload incompatível (cap=${payload.cap})`);
  }
  if (!resolveGeminiApiKey()) {
    throw new Error('Gemini indisponível: GEMINI_API_KEY ausente');
  }
  const { ai } = await import('@/ai/genkit');
  const tools = listaParaGenkit(ai, payload.tools);

  const { system, history, prompt } = repartirParaGenkit(payload.messages);
  const systemFinal = payload.system?.trim() || system;

  const resposta = await ai.generate({
    model: provider.model,
    ...(systemFinal ? { system: systemFinal } : {}),
    ...(history.length ? { messages: history } : {}),
    prompt,
    tools: tools as never,
    config: { temperature: payload.temperature },
  });
  const texto = resposta.text;
  if (!texto || !texto.trim()) {
    throw new Error('Gemini devolveu resposta vazia (tools)');
  }
  return { content: texto, uso: usoDoGenkit(resposta) };
};

/**
 * Driver de IMAGEM (geração) via Gemini/Genkit. SINGLE-PROVIDER: só o Gemini
 * emite mídia hoje (os grátis são text-only) — rotulado, sem failover. Usa
 * `ai.generate` com `responseModalities: ['IMAGE','TEXT']` e devolve a imagem em
 * `midia` (data URI) + a legenda textual em `content`.
 */
const driverImagemGemini: DriverFn = async ({ provider, payload }) => {
  if (payload.cap !== 'imagem') {
    throw new Error(`driverImagemGemini: payload incompatível (cap=${payload.cap})`);
  }
  if (!resolveGeminiApiKey()) {
    throw new Error('Gemini indisponível: GEMINI_API_KEY ausente');
  }
  const { ai } = await import('@/ai/genkit');
  const resposta = await ai.generate({
    model: provider.model,
    prompt: payload.prompt,
    config: { responseModalities: ['IMAGE', 'TEXT'] },
  });
  const url = resposta.media?.url;
  if (!url) {
    throw new Error('Gemini não retornou imagem.');
  }
  return { content: resposta.text ?? '', midia: url, uso: usoDoGenkit(resposta) };
};

/**
 * Despacho por capacidade × protocolo. Estrutura EXTENSÍVEL: as frentes futuras
 * só preenchem células (ex.: `audio['whisper-multipart'] = driverWhisperGroq`,
 * `imagem['gemini-image'] = driverImagemGemini`). Célula ausente → o orquestrador
 * lança `NoDriverForCapability` (erro claro, NÃO cai silencioso no Gemini).
 */
const DRIVERS: Partial<
  Record<CapacidadeIa, Partial<Record<ProtocoloIa, DriverFn>>>
> = {
  texto: { 'openai-compat': driverChatOpenAi, gemini: driverChatGemini },
  json: { 'openai-compat': driverChatOpenAi, gemini: driverChatGemini },
  // ÁUDIO (F3): Groq Whisper (multipart) como prioridade + Gemini como fallback.
  // montarCadeia('audio') já filtra a cadeia p/ [groq, gemini] (quem declara
  // 'audio' no registry) e executarCadeia faz o failover REAL Whisper → Gemini.
  audio: { 'whisper-multipart': driverWhisperGroq, gemini: driverAudioGemini },
  // VISÃO + TOOLS (F5d): SINGLE-PROVIDER Gemini (sem candidato grátis de
  // failover hoje). montarCadeia('visao')/('tools') resolve só o Gemini; se
  // faltar Gemini, executarCadeia lança NoDriverForCapability (erro honesto —
  // NÃO simula cascata). failoverDisponivel é naturalmente false (1 provedor).
  visao: { gemini: driverVisaoGemini },
  tools: { gemini: driverToolsGemini },
  // IMAGEM (F5e): SINGLE-PROVIDER Gemini (gera mídia) — sem failover grátis.
  imagem: { gemini: driverImagemGemini },
  // STREAMING (F6): vive numa tabela SEPARADA (STREAM_DRIVERS) porque o driver
  // devolve um AsyncGenerator (não um Promise único) — ver `gerarTextoStream`.
  // imagem: reservado (F5e preenche aqui).
};

/** Resolve o driver de um provedor p/ uma capacidade. Null se não houver. */
function resolverDriver(
  capacidade: CapacidadeIa,
  protocolo: ProtocoloIa,
): DriverFn | null {
  return DRIVERS[capacidade]?.[protocolo] ?? null;
}

/** Erro claro quando NENHUM provedor da cadeia tem driver p/ a capacidade. */
export class NoDriverForCapability extends Error {
  constructor(readonly capacidade: CapacidadeIa) {
    super(`Nenhum driver disponível para a capacidade '${capacidade}'`);
    this.name = 'NoDriverForCapability';
  }
}

// ── Orquestrador central ──────────────────────────────────────────────────────

/**
 * Percorre a cadeia (montada da config FILTRADA pela capacidade) e devolve o
 * primeiro resultado que sair, despachando cada provedor pelo seu driver
 * (`DRIVERS[capacidade][protocolo]`). Registra uso (sucesso/falha) por tentativa.
 * Lança se tudo falhar; lança `NoDriverForCapability` se nenhum provedor da
 * cadeia tem driver para a capacidade.
 *
 * GENERALIZAÇÃO (F2): antes a assinatura era `{messages,temperature,jsonMode}` e
 * o ramo era `if (ehGemini)`. Agora é `(capacidade, payload)` e o ramo é a tabela
 * DRIVERS — mas o LAÇO (provider → key → retryable → fallback), os timeouts, a
 * rotação multi-key, a classificação de erro e a telemetria são IDÊNTICOS.
 */
async function executarCadeia(
  capacidade: CapacidadeIa,
  payload: PayloadCapacidade,
): Promise<{ texto: string; provedor: string; modelo: string; midia?: string; segmentos?: SegmentoTranscricao[] }> {
  const erros: string[] = [];
  // Roteamento por chamada (filas preferenciais) só existe nos payloads texto/json.
  const roteamento =
    payload.cap === 'texto' || payload.cap === 'json'
      ? { preferir: payload.preferir, modeloPorProvedor: payload.modeloPorProvedor }
      : undefined;
  const cadeia = await montarCadeia(capacidade, roteamento);

  // Honestidade: se NINGUÉM na cadeia tem driver p/ a capacidade, erro claro.
  const algumComDriver = cadeia.some(
    (p) => resolverDriver(capacidade, p.protocolo) != null,
  );
  if (!algumComDriver) {
    throw new NoDriverForCapability(capacidade);
  }

  for (const provider of cadeia) {
    const driver = resolverDriver(capacidade, provider.protocolo);
    if (!driver) {
      logProvider(
        `${provider.nome}: sem driver p/ ${capacidade}/${provider.protocolo} — PULADO`,
      );
      continue;
    }

    // Gemini: chave única lógica; os OpenAI-compat rotacionam env vars.
    const chaves = provider.ehGemini
      ? resolveGeminiApiKey()
        ? ['__gemini__']
        : []
      : chavesDoProvider(provider);

    if (chaves.length === 0) {
      logProvider(`${provider.nome}: sem chave no env — PULADO`);
      continue;
    }

    for (let i = 0; i < chaves.length; i++) {
      const inicio = Date.now();
      try {
        const r = await driver({ provider, key: chaves[i], payload });

        registrarUsoIa({
          provedor: provider.nome,
          modelo: provider.model,
          tokensEntrada: r.uso.tokensEntrada,
          tokensSaida: r.uso.tokensSaida,
          latenciaMs: Date.now() - inicio,
          sucesso: true,
          foi429: false,
          capacidade,
        });
        logProvider(
          `OK via ${provider.nome} (modelo ${provider.model}, key #${i + 1}/${chaves.length})`,
        );
        return { texto: r.content, provedor: provider.nome, modelo: provider.model, midia: r.midia, segmentos: r.segmentos };
      } catch (err) {
        const retryable = err instanceof ProviderRetryableError;
        const status =
          err instanceof ProviderRetryableError ? err.status : undefined;
        const msg = err instanceof Error ? err.message : String(err);
        const classeErro = classificarErro(err, status);
        erros.push(msg);

        registrarUsoIa({
          provedor: provider.nome,
          modelo: provider.model,
          tokensEntrada: 0,
          tokensSaida: 0,
          latenciaMs: Date.now() - inicio,
          sucesso: false,
          foi429: status === 429,
          erro: msg.slice(0, 300),
          capacidade,
          classeErro,
          ...(typeof status === 'number' ? { httpStatus: status } : {}),
        });
        const vaiRotacionar = ehFalhaDeChave(err) && i + 1 < chaves.length;
        logProvider(
          `falhou ${provider.nome} key #${i + 1}/${chaves.length}` +
            ` (${retryable ? 'retryable' : 'duro'}): ${msg} → ` +
            (vaiRotacionar ? 'rotaciona key' : 'próximo provider'),
        );
        // Falha provider-wide (timeout/5xx/erro duro) ou última key → não
        // queima as demais chaves; cai pro próximo PROVEDOR.
        if (!vaiRotacionar) break;
        // 429: cota por janela. Espera bounded antes da próxima key para não
        // estourar todas de uma vez (visto em prod: burst 429 esgotava o provedor
        // inteiro em ms e derrubava a cadeia — auditoria 2026-07-02).
        if (status === 429) {
          await dormir(Math.min(BACKOFF_429_MS + Math.floor(Math.random() * 1_500), BACKOFF_429_MAX_MS));
        }
      }
    }
  }

  throw new Error(
    `Todos os provedores de IA falharam. Detalhes: ${erros.join(' | ')}`,
  );
}

// ── STREAMING SSE (F6): texto token-a-token, failover honesto pré-1o-token ─────

/**
 * Resultado FINAL de um stream — a meta de procedência REAL (provedor/modelo que
 * de fato emitiu os tokens) que a UI usa no `IaSelo` ao terminar o stream.
 */
export interface StreamMeta {
  provedor: string;
  modelo: string;
}

/**
 * Um driver de STREAMING: recebe o provedor resolvido, a chave e o payload, e
 * devolve um AsyncGenerator que emite PEDAÇOS de texto (deltas) à medida que o
 * provedor os produz. Lança `ProviderRetryableError` (rotaciona/cai) ou `Error`
 * (erro duro) ANTES do primeiro yield para o orquestrador trocar de provedor;
 * uma vez que o primeiro pedaço foi emitido, não há mais failover (a resposta
 * já começou — degrade honesto, sem reescrever silenciosamente).
 *
 * O segundo elemento do tuple devolvido pelo `return` do generator é o `Uso`
 * (tokens), reportado à telemetria ao final. Provedores que não enviam usage no
 * stream reportam 0 (observabilidade honesta).
 */
type StreamDriverFn = (args: {
  provider: ProvedorResolvido;
  key: string;
  payload: PayloadCapacidade;
}) => AsyncGenerator<string, Uso, void>;

/**
 * Lê uma resposta SSE de `chat/completions` com `stream:true` (OpenAI-compat:
 * groq/nvidia/openrouter) e emite os deltas de `choices[0].delta.content`. O
 * corpo vem como linhas `data: {json}\n\n`, terminando em `data: [DONE]`. Acumula
 * o `usage` final quando o provedor o envia (alguns mandam `stream_options`).
 *
 * Conexão/handshake (status != 2xx, timeout, rede) → ProviderRetryableError
 * ANTES do 1o token. Depois do 1o token emitido, qualquer corte é propagado como
 * erro (sem failover — a resposta já começou).
 */
async function* streamOpenAiCompat(args: {
  provider: ProvedorResolvido;
  key: string;
  messages: ChatMessage[];
  temperature: number;
}): AsyncGenerator<string, Uso, void> {
  const { provider, key, messages, temperature } = args;
  const url = `${provider.base}/chat/completions`;

  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    temperature,
    stream: true,
    // Pede o usage no chunk final (suportado por groq/openrouter; ignorado pelos
    // que não o conhecem). Observabilidade best-effort.
    stream_options: { include_usage: true },
  };

  // Timeout de HANDSHAKE: só cobre a abertura da conexão (até o 1o byte). Depois
  // que o stream começa, o provedor pode levar mais tempo para concluir — não
  // abortamos no meio de uma resposta já em curso.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(provider.headersExtra ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const motivo =
      err instanceof Error && err.name === 'AbortError'
        ? `timeout após ${TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'erro de rede';
    throw new ProviderRetryableError(`${provider.nome}: ${motivo}`, provider.nome);
  }

  if (!resp.ok || !resp.body) {
    clearTimeout(timer);
    let detalhe = '';
    try {
      detalhe = (await resp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    if (!resp.body || statusEhRetryable(resp.status)) {
      throw new ProviderRetryableError(
        `${provider.nome}: HTTP ${resp.status} ${detalhe}`,
        provider.nome,
        resp.status,
      );
    }
    throw new Error(`${provider.nome}: HTTP ${resp.status} ${detalhe}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let emitiuAlgo = false;
  let uso: Uso = { tokensEntrada: 0, tokensSaida: 0 };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Chegou byte → o handshake passou; libera o timeout (não abortar o meio).
      clearTimeout(timer);
      buffer += decoder.decode(value, { stream: true });

      // SSE: eventos separados por linha em branco; cada linha de dado é `data:`.
      let idxNl: number;
      while ((idxNl = buffer.indexOf('\n')) !== -1) {
        const linha = buffer.slice(0, idxNl).trim();
        buffer = buffer.slice(idxNl + 1);
        if (!linha || !linha.startsWith('data:')) continue;
        const dados = linha.slice(5).trim();
        if (dados === '[DONE]') continue;
        let json: unknown;
        try {
          json = JSON.parse(dados);
        } catch {
          continue; // chunk parcial/ruído — ignora
        }
        const j = json as {
          choices?: Array<{ delta?: { content?: unknown } }>;
          usage?: Record<string, unknown>;
        };
        const delta = j?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length) {
          emitiuAlgo = true;
          yield delta;
        }
        if (j?.usage) {
          const ent = Number(j.usage.prompt_tokens);
          const sai = Number(j.usage.completion_tokens);
          uso = {
            tokensEntrada: Number.isFinite(ent) ? ent : 0,
            tokensSaida: Number.isFinite(sai) ? sai : 0,
          };
        }
      }
    }
  } catch (err) {
    // Corte no MEIO do stream. Se nada foi emitido ainda, é retryable (failover
    // pré-1o-token); se já emitimos, propaga como erro duro (degrade honesto).
    if (!emitiuAlgo) {
      throw new ProviderRetryableError(
        `${provider.nome}: stream interrompido antes do 1o token (${
          err instanceof Error ? err.message : String(err)
        })`,
        provider.nome,
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }

  if (!emitiuAlgo) {
    // Stream concluiu sem nenhum delta → trata como vazio (retryable, cai pro
    // próximo provedor).
    throw new ProviderRetryableError(
      `${provider.nome}: stream sem conteúdo`,
      provider.nome,
    );
  }
  return uso;
}

/** Driver de streaming OpenAI-compat — envelopa `streamOpenAiCompat`. */
const streamDriverOpenAi: StreamDriverFn = function (args) {
  const { provider, key, payload } = args;
  if (payload.cap !== 'streaming') {
    throw new Error(
      `streamDriverOpenAi: payload incompatível (cap=${payload.cap})`,
    );
  }
  return streamOpenAiCompat({
    provider,
    key,
    messages: payload.messages,
    temperature: payload.temperature,
  });
};

/**
 * Driver de streaming Gemini (via Genkit `ai.generateStream`). Emite os pedaços
 * de texto de cada chunk. O failover pré-1o-token é coberto pelo orquestrador:
 * se `resolveGeminiApiKey` faltar OU o generateStream estourar antes do 1o
 * chunk, lança e o orquestrador cai (mas o Gemini é o último da cadeia, então em
 * geral é o destino final). Lê `usage` da resposta final agregada.
 */
const streamDriverGemini: StreamDriverFn = async function* (args) {
  const { provider, payload } = args;
  if (payload.cap !== 'streaming') {
    throw new Error(
      `streamDriverGemini: payload incompatível (cap=${payload.cap})`,
    );
  }
  if (!resolveGeminiApiKey()) {
    throw new Error('Gemini indisponível: GEMINI_API_KEY ausente');
  }
  const { ai } = await import('@/ai/genkit');
  const sys = payload.messages.find((m) => m.role === 'system')?.content ?? '';
  const { history, prompt } = repartirParaGenkit(
    payload.messages.filter((m) => m.role !== 'system'),
  );

  let emitiuAlgo = false;
  let respostaFinal: unknown;
  try {
    const { stream, response } = ai.generateStream({
      model: provider.model,
      ...(sys ? { system: sys } : {}),
      ...(history.length ? { messages: history } : {}),
      prompt,
      config: { temperature: payload.temperature },
    });

    for await (const chunk of stream) {
      const texto = (chunk as { text?: unknown })?.text;
      if (typeof texto === 'string' && texto.length) {
        emitiuAlgo = true;
        yield texto;
      }
    }
    respostaFinal = await response;
  } catch (err) {
    if (!emitiuAlgo) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (!emitiuAlgo) {
    throw new Error('Gemini devolveu stream vazio');
  }
  return usoDoGenkit(respostaFinal);
};

/** Tabela de drivers de STREAMING por protocolo (capacidade 'streaming'). */
const STREAM_DRIVERS: Partial<Record<ProtocoloIa, StreamDriverFn>> = {
  'openai-compat': streamDriverOpenAi,
  gemini: streamDriverGemini,
};

/** Resolve o driver de streaming de um protocolo. Null se não houver. */
function resolverStreamDriver(protocolo: ProtocoloIa): StreamDriverFn | null {
  return STREAM_DRIVERS[protocolo] ?? null;
}

/**
 * Entrada do streaming de texto: mesma forma de `gerarTexto`, mas opcionalmente
 * com histórico multi-turn (chat) já montado.
 */
export interface GerarTextoStreamInput {
  system?: string;
  prompt: string;
  temperature?: number;
  /** Histórico multi-turn (chat). Opcional — sem ele é single-turn. */
  historico?: MensagemChat[];
}

/**
 * STREAMING de texto token-a-token pelo MESMO núcleo (montarCadeia/rotação/
 * telemetria) que `gerarTexto`, na capacidade 'streaming'. Failover HONESTO: se
 * o provedor falhar ANTES do 1o token (handshake/429/5xx/timeout/stream vazio),
 * cai pro próximo da cadeia; DEPOIS do 1o token emitido, um corte vira erro (não
 * troca silenciosa). Ao final, emite o `StreamMeta` (provedor/modelo REAIS) e
 * registra o uso na telemetria.
 *
 * O generator yielda STRINGS (deltas de texto) e RETORNA o `StreamMeta` final —
 * a rota SSE serializa os deltas como `data:` e a meta como o evento final.
 *
 * ADITIVO: não toca `gerarTexto`/`gerarJson`/`chat` — caminho novo.
 */
export async function* gerarTextoStream(
  input: GerarTextoStreamInput,
  capacidade: CapacidadeIa = 'streaming',
): AsyncGenerator<string, StreamMeta, void> {
  const temperature = input.temperature ?? 0.3;
  const messages = montarMensagens(input.system, input.prompt, input.historico);

  const cadeia = await montarCadeia(capacidade);
  const algumComDriver = cadeia.some(
    (p) => resolverStreamDriver(p.protocolo) != null,
  );
  if (!algumComDriver) {
    throw new NoDriverForCapability(capacidade);
  }

  const payload: PayloadCapacidade = { cap: 'streaming', messages, temperature };
  const erros: string[] = [];

  for (const provider of cadeia) {
    const driver = resolverStreamDriver(provider.protocolo);
    if (!driver) {
      logProvider(
        `${provider.nome}: sem driver de stream p/ ${provider.protocolo} — PULADO`,
      );
      continue;
    }

    const chaves = provider.ehGemini
      ? resolveGeminiApiKey()
        ? ['__gemini__']
        : []
      : chavesDoProvider(provider);
    if (chaves.length === 0) {
      logProvider(`${provider.nome}: sem chave no env — PULADO (stream)`);
      continue;
    }

    for (let i = 0; i < chaves.length; i++) {
      const inicio = Date.now();
      let emitiuAlgo = false;
      try {
        const gen = driver({ provider, key: chaves[i], payload });
        // O failover pré-1o-token vive AQUI: a 1a chamada a next() dispara o
        // handshake. Se ela lançar retryable antes de qualquer yield, caímos.
        let it = await gen.next();
        while (!it.done) {
          emitiuAlgo = true;
          yield it.value;
          it = await gen.next();
        }
        const uso: Uso = it.value ?? { tokensEntrada: 0, tokensSaida: 0 };

        registrarUsoIa({
          provedor: provider.nome,
          modelo: provider.model,
          tokensEntrada: uso.tokensEntrada,
          tokensSaida: uso.tokensSaida,
          latenciaMs: Date.now() - inicio,
          sucesso: true,
          foi429: false,
          capacidade,
        });
        logProvider(
          `OK (stream) via ${provider.nome} (modelo ${provider.model}, key #${i + 1}/${chaves.length})`,
        );
        return { provedor: provider.nome, modelo: provider.model };
      } catch (err) {
        const retryable = err instanceof ProviderRetryableError;
        const status =
          err instanceof ProviderRetryableError ? err.status : undefined;
        const msg = err instanceof Error ? err.message : String(err);
        erros.push(msg);

        registrarUsoIa({
          provedor: provider.nome,
          modelo: provider.model,
          tokensEntrada: 0,
          tokensSaida: 0,
          latenciaMs: Date.now() - inicio,
          sucesso: false,
          foi429: status === 429,
          erro: msg.slice(0, 300),
          capacidade,
          classeErro: classificarErro(err, status),
          ...(typeof status === 'number' ? { httpStatus: status } : {}),
        });

        // DEPOIS do 1o token NÃO há failover: a resposta já começou. Propaga.
        if (emitiuAlgo) {
          logProvider(
            `stream cortado APÓS 1o token via ${provider.nome}: ${msg} (sem failover)`,
          );
          throw new Error(
            `Stream interrompido após início da resposta (${provider.nome}): ${msg}`,
          );
        }

        const vaiRotacionar = ehFalhaDeChave(err) && i + 1 < chaves.length;
        logProvider(
          `falhou stream ${provider.nome} key #${i + 1}/${chaves.length}` +
            ` (${retryable ? 'retryable' : 'duro'}, pré-1o-token): ${msg} → ` +
            (vaiRotacionar ? 'rotaciona key' : 'próximo provider'),
        );
        if (!vaiRotacionar) break; // provider-wide ou última key → próximo provedor
      }
    }
  }

  throw new Error(
    `Todos os provedores de IA falharam (stream). Detalhes: ${erros.join(' | ')}`,
  );
}

// ── API pública: disponibilidade ──────────────────────────────────────────────

/**
 * True se AO MENOS UM provedor de IA está configurado (qualquer chave grátis OU
 * o Gemini). Baseado no REGISTRY (independe da config dinâmica — é "tem chave no
 * env?"), preservando o comportamento histórico do 503 honesto das rotas.
 */
export function haAlgumProvedorDeIa(): boolean {
  return PROVIDERS_REGISTRY.some((reg) =>
    reg.ehGemini ? Boolean(resolveGeminiApiKey()) : chavesDoProvider(reg).length > 0,
  );
}

// ── API pública: provedor ESPERADO (para o loading informativo) ────────────────

/**
 * Procedência ESPERADA da próxima geração: o PRIMEIRO provedor da cadeia (config
 * + ordem + modo forçar) que TEM chave no env — ou seja, o que MAIS provavelmente
 * responderá primeiro. É só uma EXPECTATIVA (o multi-provider pode cair pro
 * próximo em runtime); a UI deve rotular como "esperado", não garantido. O selo
 * de RESULTADO usa a procedência REAL (`provedor`/`modelo` do retorno). Nunca
 * lança: se nada resolver, devolve null e a UI mostra um genérico "IA".
 */
export async function provedorEsperado(
  capacidade: CapacidadeIa = 'texto',
): Promise<(IaMeta & { label: string }) | null> {
  let cadeia: ProvedorResolvido[];
  try {
    cadeia = await montarCadeia(capacidade);
  } catch {
    return null;
  }
  for (const p of cadeia) {
    // Só conta como "esperado" quem TEM driver p/ a capacidade (honestidade).
    if (!resolverDriver(capacidade, p.protocolo)) continue;
    const temChave = p.ehGemini
      ? Boolean(resolveGeminiApiKey())
      : chavesDoProvider(p).length > 0;
    if (temChave) {
      return { provedor: p.nome, modelo: p.model, label: labelDoProvedor(p.nome) };
    }
  }
  return null;
}

// ── API pública: gerarTexto ───────────────────────────────────────────────────

export async function gerarTexto(
  input: GerarTextoInput,
): Promise<GerarTextoResultado> {
  const messages = montarMensagens(input.system, input.prompt);
  const temperature = input.temperature ?? 0.3;
  const { texto, provedor, modelo } = await executarCadeia('texto', {
    cap: 'texto',
    messages,
    temperature,
    jsonMode: false,
  });
  return { texto, provedor, modelo };
}

/**
 * Gera JSON pela capacidade 'json' SEM schema Zod (devolve o texto cru) —
 * para chamadores que validam o shape por conta própria (ex.: o endpoint
 * interno /api/ia/gerar-json, que repassa às functions). Liga `jsonMode`
 * (`response_format:json_object` nos grátis) e usa a CADEIA de 'json' (não a de
 * 'texto'), herdando rotação/telemetria/fallback do núcleo. Diferente de
 * `gerarJson<T>` (que valida em Zod + retry de reparo), aqui o parse/validação
 * fica com o chamador.
 */
export async function gerarJsonBruto(input: {
  system?: string;
  prompt: string;
  temperature?: number;
  /** Timeout por chamada (ms) — diário/LOA são prompts grandes; default TIMEOUT_MS (14s). */
  timeoutMs?: number;
  /** Fila preferencial p/ esta chamada (ordem de provedores). */
  preferir?: string[];
  /** Override de modelo por provedor p/ esta chamada. */
  modeloPorProvedor?: Record<string, string>;
}): Promise<{ texto: string; provedor: string; modelo: string }> {
  const messages = montarMensagens(input.system, input.prompt);
  const { texto, provedor, modelo } = await executarCadeia('json', {
    cap: 'json',
    messages,
    temperature: input.temperature ?? 0.2,
    jsonMode: true,
    timeoutMs: input.timeoutMs,
    preferir: input.preferir,
    modeloPorProvedor: input.modeloPorProvedor,
  });
  return { texto, provedor, modelo };
}

// ── API pública: transcreverAudio (áudio → texto, failover REAL) ───────────────

export interface TranscreverAudioInput {
  /** Áudio como data URI `data:<mime>;base64,<dados>`. */
  audioDataUri: string;
  /** MIME do áudio (ex.: 'audio/webm'). Opcional — inferido do data URI. */
  mime?: string;
  /** Idioma do áudio (ISO-639-1, ex.: 'pt'). Opcional. */
  idioma?: string;
  /** Prompt/contexto para guiar a transcrição. Opcional. */
  prompt?: string;
}

export interface TranscreverAudioResultado {
  texto: string;
  /** Provedor que de fato transcreveu (ex.: 'groq', 'gemini'). */
  provedor: string;
  /** Modelo concreto (ex.: 'whisper-large-v3', 'googleai/gemini-2.5-flash'). */
  modelo: string;
}

/**
 * Transcreve áudio pelo gateway, com FAILOVER REAL: tenta a Groq (Whisper
 * `whisper-large-v3`, mais rápido/barato) primeiro e cai no Gemini se a Groq
 * falhar (timeout/429/erro/áudio > 25MB/sem chave). Se a Groq não estiver
 * configurada (sem `GROQ_API_KEY`) ou não declarar 'audio', `montarCadeia('audio')`
 * a pula e o comportamento é IDÊNTICO ao de hoje (Gemini-only). Wrapper fino
 * sobre `executarCadeia('audio', ...)` — herda laço/rotação/telemetria do núcleo.
 */
export async function transcreverAudio(
  input: TranscreverAudioInput,
): Promise<TranscreverAudioResultado> {
  const { texto, provedor, modelo } = await executarCadeia('audio', {
    cap: 'audio',
    audioDataUri: input.audioDataUri,
    mime: input.mime,
    idioma: input.idioma,
    prompt: input.prompt,
  });
  return { texto, provedor, modelo };
}

export interface TranscreverAudioTemporizadoResultado extends TranscreverAudioResultado {
  /** Segmentos com tempos (segundos, relativos ao áudio enviado). */
  segmentos: SegmentoTranscricao[];
}

/**
 * Transcreve áudio COM SEGMENTOS temporizados (legendas/captions). Mesmo failover
 * REAL do `transcreverAudio` (Groq Whisper `verbose_json` → Gemini JSON). LANÇA se
 * nenhum provedor produzir segmentos utilizáveis — o chamador (ex.: a function de
 * legendas) NÃO deve degradar para texto sem tempos silenciosamente.
 */
export async function transcreverAudioTemporizado(
  input: TranscreverAudioInput,
): Promise<TranscreverAudioTemporizadoResultado> {
  const { texto, provedor, modelo, segmentos } = await executarCadeia('audio', {
    cap: 'audio',
    audioDataUri: input.audioDataUri,
    mime: input.mime,
    idioma: input.idioma,
    prompt: input.prompt,
    segmentado: true,
  });
  if (!segmentos || segmentos.length === 0) {
    throw new Error('Nenhum provedor retornou segmentos temporizados do áudio.');
  }
  return { texto, provedor, modelo, segmentos };
}

// ── API pública: CHAT com tools / visão (multi-turn, multimodal) ───────────────

/**
 * Mensagem de chat PÚBLICA (forma do gateway). `partes` carrega conteúdo
 * multimodal (texto + media via data URI) para visão; sem `partes`, `content` é
 * o texto. Espelha o `ChatMessage` interno, exportado p/ os flows montarem o
 * histórico/última mensagem.
 */
export interface MensagemChat {
  role: 'system' | 'user' | 'assistant';
  content: string;
  partes?: Array<
    | { tipo: 'texto'; texto: string }
    | { tipo: 'media'; dataUri: string; mime?: string }
  >;
}

export interface ChatResultado {
  texto: string;
  provedor: string;
  modelo: string;
}

/**
 * CHAT com FUNCTION-CALLING (capacidade 'tools'). SINGLE-PROVIDER: resolve só o
 * Gemini (único driver de 'tools' hoje) — sem failover (rotulado). Se faltar
 * Gemini, lança `NoDriverForCapability`. As `tools` são `ToolSpec` AGNOSTICAS;
 * o driver as adapta ao provedor. Multi-turn via `messages` (system + histórico
 * + última do usuário).
 */
export async function conversarComTools(input: {
  system?: string;
  messages: MensagemChat[];
  tools: ToolSpec[];
  temperature?: number;
}): Promise<ChatResultado> {
  const { texto, provedor, modelo } = await executarCadeia('tools', {
    cap: 'tools',
    messages: input.messages,
    system: input.system,
    tools: input.tools,
    temperature: input.temperature ?? 0.3,
  });
  return { texto, provedor, modelo };
}

/**
 * CHAT com VISÃO (anexos imagem/PDF — capacidade 'visao'). SINGLE-PROVIDER:
 * resolve só o Gemini; sem failover (rotulado). Sem Gemini →
 * `NoDriverForCapability`. As mensagens carregam `partes` com `media`.
 */
export async function conversarComVisao(input: {
  messages: MensagemChat[];
  temperature?: number;
  /** Timeout por chamada (ms). PDF grande no Gemini pede muito mais que os 14s
   *  padrão — o caminho do diário passa 180s. Sem isto, uma geração travada
   *  prendia a instância até o maxDuration da rota (480s). */
  timeoutMs?: number;
}): Promise<ChatResultado> {
  const { texto, provedor, modelo } = await executarCadeia('visao', {
    cap: 'visao',
    messages: input.messages,
    temperature: input.temperature ?? 0.3,
    timeoutMs: input.timeoutMs,
  });
  return { texto, provedor, modelo };
}

/**
 * GERA IMAGEM (capacidade 'imagem'). SINGLE-PROVIDER: resolve só o Gemini (único
 * que emite mídia hoje) — sem failover (rotulado). Sem Gemini →
 * `NoDriverForCapability`. Devolve o data URI da imagem + a legenda + procedência.
 * Roteia pelo GATEWAY (config/meta/telemetria unificados) em vez de `ai.generate`
 * direto nos flows.
 */
export async function gerarImagem(input: {
  prompt: string;
  aspecto?: string;
}): Promise<{ imageDataUri: string; caption: string; provedor: string; modelo: string }> {
  const { texto, midia, provedor, modelo } = await executarCadeia('imagem', {
    cap: 'imagem',
    prompt: input.prompt,
    aspecto: input.aspecto,
  });
  if (!midia) {
    throw new Error('O provedor não retornou imagem.');
  }
  return { imageDataUri: midia, caption: texto, provedor, modelo };
}

/**
 * VISÃO com saída JSON ESTRUTURADA validada por Zod. Para fluxos multimodais
 * (imagem/PDF/áudio) que precisam de objeto tipado: roda `conversarComVisao`
 * (Gemini DENTRO do gateway — único driver de 'visao' hoje) e faz parse +
 * validação do JSON retornado. Centraliza o que antes cada flow fazia à mão
 * com `ai.definePrompt` direto no Gemini, mantendo TUDO pelo gateway.
 *
 * Robustez (igual ao `gerarJson`): injeta uma mensagem de SISTEMA com o contrato
 * "responda só JSON" e, se o parse/validação falhar, faz 1 RETRY de reparo
 * devolvendo o texto cru e pedindo o JSON corrigido — modelos multimodais às
 * vezes envolvem o JSON em prosa/cercas.
 */
export async function gerarJsonComVisao<T>(input: {
  messages: MensagemChat[];
  schema: ZodType<T>;
  system?: string;
  temperature?: number;
}): Promise<{ dados: T; provedor: string; modelo: string }> {
  const instrucaoJson =
    (input.system ? input.system + '\n\n' : '') +
    'IMPORTANTE: responda EXCLUSIVAMENTE com um único objeto JSON válido que ' +
    'satisfaça o formato pedido. Não inclua texto fora do JSON, nem cercas de ' +
    'código, nem comentários.';

  // Garante a mensagem de sistema com o contrato de JSON (substitui qualquer
  // system que o caller tenha mandado, evitando duplicidade).
  const messages: MensagemChat[] = [
    { role: 'system', content: instrucaoJson },
    ...input.messages.filter((m) => m.role !== 'system'),
  ];

  const temperatura = input.temperature ?? 0.3;
  const { texto, provedor, modelo } = await conversarComVisao({ messages, temperature: temperatura });
  try {
    return { dados: parseEValidar(texto, input.schema), provedor, modelo };
  } catch (primeiroErro) {
    // RETRY de reparo: devolve o texto cru e pede SOMENTE o JSON corrigido.
    const motivo = primeiroErro instanceof Error ? primeiroErro.message : String(primeiroErro);
    const reparo = await conversarComVisao({
      messages: [
        { role: 'system', content: instrucaoJson },
        {
          role: 'user',
          content:
            'O texto a seguir DEVERIA ser apenas um objeto JSON válido, mas falhou na ' +
            `validação (${motivo}). Corrija e devolva SOMENTE o JSON, sem comentários ` +
            `nem cercas de código:\n\n${texto}`,
        },
      ],
      temperature: 0,
    });
    return { dados: parseEValidar(reparo.texto, input.schema), provedor: reparo.provedor, modelo: reparo.modelo };
  }
}

// ── API pública: gerarJson ────────────────────────────────────────────────────

/** Extrai o primeiro objeto/array JSON de um texto (modelos às vezes cercam de prosa/```). */
function extrairJsonBruto(texto: string): string {
  const t = texto.trim();
  const semCerca = t
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (semCerca.startsWith('{') || semCerca.startsWith('[')) return semCerca;
  const primeiroObj = semCerca.indexOf('{');
  const primeiroArr = semCerca.indexOf('[');
  const ini =
    primeiroObj === -1
      ? primeiroArr
      : primeiroArr === -1
        ? primeiroObj
        : Math.min(primeiroObj, primeiroArr);
  if (ini === -1) return semCerca;
  const abre = semCerca[ini];
  const fecha = abre === '{' ? '}' : ']';
  const fim = semCerca.lastIndexOf(fecha);
  if (fim > ini) return semCerca.slice(ini, fim + 1);
  return semCerca;
}

/** Parse + validação Zod de um texto que DEVERIA ser JSON. Lança se inválido. */
function parseEValidar<T>(texto: string, schema: ZodType<T>): T {
  const bruto = extrairJsonBruto(texto);
  let obj: unknown;
  try {
    obj = JSON.parse(bruto);
  } catch (e) {
    throw new Error(
      `JSON inválido (parse falhou): ${e instanceof Error ? e.message : e}`,
    );
  }
  const parsed = schema.safeParse(obj);
  if (!parsed.success) {
    throw new Error(`JSON não passou no schema Zod: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Gera JSON ESTRUTURADO validado por Zod. Liga `response_format:json_object`
 * nos providers grátis; 1 RETRY de correção se o JSON vier inválido. Mantém o
 * "último recurso Gemini" SE o Gemini estiver na cadeia (config-aware): se um
 * provider produziu prosa estável mas JSON inválido 2x e o Gemini está
 * disponível e habilitado, dá ao Gemini uma chance de produzir o JSON.
 */
export async function gerarJson<T>(
  input: GerarJsonInput<T>,
): Promise<GerarJsonResultado<T>> {
  const temperature = input.temperature ?? 0.2;

  const sistemaBase =
    (input.system ? input.system + '\n\n' : '') +
    'IMPORTANTE: responda EXCLUSIVAMENTE com um único objeto JSON válido que ' +
    'satisfaça o formato pedido. Não inclua texto fora do JSON, nem cercas de ' +
    'código, nem comentários.';

  const messages = montarMensagens(sistemaBase, input.prompt);
  const { preferir, modeloPorProvedor, timeoutMs } = input;

  const r1 = await executarCadeia('json', {
    cap: 'json',
    messages,
    temperature,
    jsonMode: true,
    preferir,
    modeloPorProvedor,
    timeoutMs,
  });
  try {
    const dados = parseEValidar(r1.texto, input.schema);
    return { dados, provedor: r1.provedor, modelo: r1.modelo };
  } catch (e1) {
    logProvider(
      `JSON inválido de ${r1.provedor} — fazendo 1 retry de correção: ${
        e1 instanceof Error ? e1.message : e1
      }`,
    );
  }

  const messagesRetry = montarMensagens(
    sistemaBase,
    input.prompt +
      '\n\n---\nSua resposta anterior NÃO era um JSON válido para o formato ' +
      'pedido. Corrija e responda APENAS com o objeto JSON válido, sem nenhum ' +
      'outro texto.',
  );
  const r2 = await executarCadeia('json', {
    cap: 'json',
    messages: messagesRetry,
    temperature,
    jsonMode: true,
    preferir,
    modeloPorProvedor,
    timeoutMs,
  });
  try {
    const dados = parseEValidar(r2.texto, input.schema);
    return { dados, provedor: r2.provedor, modelo: r2.modelo };
  } catch (e2) {
    // ÚLTIMO RECURSO: se quem respondeu (e errou o JSON 2x) NÃO foi o Gemini,
    // mas o Gemini está na cadeia (habilitado + chave no env), dá uma chance
    // direta ao Gemini de produzir o JSON.
    if (r2.provedor !== 'gemini' && resolveGeminiApiKey()) {
      const cadeia = await montarCadeia('json');
      const gemini = cadeia.find((p) => p.ehGemini);
      if (gemini) {
        logProvider(
          `JSON ainda inválido de ${r2.provedor} — último recurso: Gemini direto`,
        );
        const inicio = Date.now();
        try {
          const r = await chamarGemini({
            modelo: gemini.model,
            messages: messagesRetry,
            temperature,
          });
          const dados = parseEValidar(r.content, input.schema);
          registrarUsoIa({
            provedor: 'gemini',
            modelo: gemini.model,
            tokensEntrada: r.uso.tokensEntrada,
            tokensSaida: r.uso.tokensSaida,
            latenciaMs: Date.now() - inicio,
            sucesso: true,
            foi429: false,
            capacidade: 'json',
          });
          return { dados, provedor: 'gemini', modelo: gemini.model };
        } catch (e3) {
          registrarUsoIa({
            provedor: 'gemini',
            modelo: gemini.model,
            tokensEntrada: 0,
            tokensSaida: 0,
            latenciaMs: Date.now() - inicio,
            sucesso: false,
            foi429: false,
            erro: e3 instanceof Error ? e3.message.slice(0, 300) : String(e3),
            capacidade: 'json',
            classeErro: classificarErro(e3),
          });
          throw e2;
        }
      }
    }
    throw e2;
  }
}
