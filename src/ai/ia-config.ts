/**
 * Configuração DIRIGIDA POR DADOS da camada de IA (agnóstica de provedor) e o
 * REGISTRO DE USO — leitura/escrita feitas SEM `firebase-admin` (o app no App
 * Hosting não o tem).
 *
 * ── Como a config é lida server-side (sem token de usuário) ───────────────────
 * Os flows/rotas que chamam a IA muitas vezes NÃO têm um ID token de usuário
 * (ex.: crons que postam com `x-nexo-secret`). Por isso a config NÃO é lida
 * diretamente do Firestore aqui: é servida pelo ENDPOINT HTTP das Functions
 * (`onIaConfigUso`, que TEM admin) via `GET ?action=config`. O endpoint lê o doc
 * `config/ia` com o Admin SDK e devolve o JSON. Este módulo faz fetch com CACHE
 * curto (45s) — não bate no endpoint a cada chamada. Se o endpoint estiver
 * indisponível, cai no DEFAULT abaixo (o comportamento histórico hardcoded),
 * então nenhum flow quebra.
 *
 * ── Como o uso é gravado (sem admin no app) ───────────────────────────────────
 * Após cada chamada, o multi-provider faz um POST fire-and-forget para o mesmo
 * endpoint (`action=uso`), que INCREMENTA contadores agregados em
 * `ia_uso/{AAAA-MM-DD}` com `FieldValue.increment` (admin). Falha do POST é
 * silenciosa — observabilidade nunca derruba a geração.
 *
 * ── Como adicionar um provedor novo ───────────────────────────────────────────
 * Todos os provedores grátis são OpenAI-compatíveis e usam o MESMO driver
 * genérico (`chamarOpenAiCompat` no multi-provider). Para somar um provedor:
 *   1. registre uma entrada em `PROVIDERS_REGISTRY` abaixo (rótulo, base, env
 *      vars das chaves, modelo default, headers extras opcionais);
 *   2. (opcional) adicione preços em `PRECOS_DEFAULT` para o custo estimado;
 *   3. provisione as chaves no env (apphosting.yaml) — provider sem chave é
 *      pulado em runtime;
 *   4. ligue/ordene/force pelo painel `/admin/ia` (grava em `config/ia`).
 * Nenhuma reescrita do orquestrador é necessária — é só registro + config.
 */

// ── Tipos da config ───────────────────────────────────────────────────────────

/**
 * Metadados de PROCEDÊNCIA de uma geração de IA — qual provedor/modelo REAL
 * respondeu. Propagado dos flows até a UI para exibir o selo "gerado por X".
 * Aditivo: campos opcionais não quebram callers existentes (NEXO etc.).
 */
export interface IaMeta {
  /** Provider que de fato respondeu (ex.: 'nvidia', 'groq', 'gemini'). */
  provedor: string;
  /** Modelo concreto que respondeu. */
  modelo: string;
}

/** Modo global do orquestrador. */
export type ModoIa =
  | { tipo: 'auto' }
  | { tipo: 'forcar'; provedor: string; comFallback: boolean };

/** Override de config por provedor (mescla sobre o registry). */
export interface ProvedorConfig {
  /** Provider ligado? (default true) */
  habilitado?: boolean;
  /** Prioridade (menor = mais cedo na cadeia). Default = ordem do registry. */
  ordem?: number;
  /** Modelo concreto a usar (sobrescreve o default do registry). */
  modelo?: string;
}

/**
 * Roteamento POR CAPACIDADE (aditivo — F1). Permite definir, para uma capacidade
 * específica (ex.: 'audio'), um modo/ordem próprios que sobrepõem o legado
 * global. AUSENTE → o orquestrador cai no `modo`/`provedores` legados (byte-a-byte
 * o comportamento de hoje). O eixo está PRONTO mas só 'texto'/'json' são exercidos
 * pelos drivers ativos por enquanto.
 */
export interface CapacidadeConfig {
  /** Modo específico desta capacidade. Ausente → usa o `modo` global legado. */
  modo?: ModoIa;
  /** Ordem dos provedores p/ esta capacidade (lista de `nome`). Ausente → ordem legada. */
  ordem?: string[];
}

/** Documento `config/ia` (todos os campos opcionais → default seguro). */
export interface IaConfigDoc {
  /** Modo global. Ausente → 'auto'. */
  modo?: ModoIa;
  /** Overrides por provedor (chave = rótulo do provedor, ex.: 'nvidia'). */
  provedores?: Record<string, ProvedorConfig>;
  /**
   * Roteamento por capacidade (aditivo — F1). Chave = `CapacidadeIa`. Ausente →
   * cai no `modo`/`provedores` legados. Reservado para as frentes que ativam
   * capacidades multimodais; declarar aqui não muda nada enquanto não houver
   * driver para a capacidade.
   */
  capacidades?: Partial<Record<CapacidadeIa, CapacidadeConfig>>;
}

/**
 * PROTOCOLO de transporte de um provedor — qual driver atende a chamada. Hoje
 * só 'openai-compat' (default) e 'gemini' (Genkit) têm driver ativo; os demais
 * ficam RESERVADOS para as frentes que introduzem os transportes multimodais
 * (Whisper multipart em F3, etc.). A tabela DRIVERS no orquestrador despacha por
 * `[capacidade][protocolo]`, então adicionar um protocolo é aditivo.
 */
export type ProtocoloIa =
  | 'openai-compat'
  | 'gemini'
  | 'whisper-multipart'
  | 'gemini-image';

/** Capacidades que um provedor sustenta hoje, se nada for declarado. */
export const CAPACIDADES_PADRAO: CapacidadeIa[] = ['texto', 'json'];

/**
 * Entrada do REGISTRY de provedores. É o "driver": um provedor OpenAI-compatível
 * é só uma entrada aqui. O `gemini` é especial (via Genkit) e marcado.
 *
 * EIXO DE CAPACIDADE (F1, aditivo): cada provedor DECLARA quais capacidades
 * sustenta (`capacidades`) e, opcionalmente, o protocolo de transporte
 * (`protocolo`) e um modelo por capacidade (`modeloPorCapacidade`). Ausência de
 * `capacidades` ⇒ `CAPACIDADES_PADRAO` (['texto','json']) — preserva os 4
 * provedores atuais byte-a-byte. Apenas 'texto'/'json' são EXERCIDOS pelos
 * drivers ativos por enquanto; as demais ficam declaradas e prontas p/ plugar.
 */
export interface ProvedorRegistro {
  /** Rótulo curto/estável (ex.: 'nvidia'). */
  nome: string;
  /** Rótulo amigável para a UI. */
  label: string;
  /** Base OpenAI-compat ({base}/chat/completions). Vazio p/ o gemini. */
  base: string;
  /** Modelo default (pode ser sobrescrito por env ou config). */
  modeloDefault: string;
  /** Env vars das chaves, em ordem de rotação. */
  keyEnvVars: string[];
  /** Env var opcional que sobrescreve o modelo default. */
  modelEnvVar?: string;
  /**
   * Headers extras (ex.: OpenRouter Referer/Title). Aceita um THUNK lazy para
   * evitar ler `process.env` na avaliação do módulo (o thunk é chamado só quando
   * a requisição é montada). Forma objeto continua suportada (legado).
   */
  headersExtra?:
    | Record<string, string>
    | (() => Record<string, string>);
  /** True só para o Gemini (driver via Genkit, não OpenAI-compat). */
  ehGemini?: boolean;
  /**
   * Protocolo de transporte. Ausente → 'gemini' se `ehGemini`, senão
   * 'openai-compat'. Aditivo: a tabela DRIVERS despacha por protocolo.
   */
  protocolo?: ProtocoloIa;
  /**
   * Protocolo por CAPACIDADE (aditivo, F3). Um mesmo provedor pode falar
   * protocolos diferentes por capacidade — ex.: a Groq usa 'openai-compat' em
   * texto/json mas 'whisper-multipart' (endpoint `/audio/transcriptions`) em
   * áudio. Ausente p/ uma capacidade → cai no `protocolo` (ou no default). Só o
   * protocolo é capability-aware; a base/chaves são as mesmas do provedor.
   */
  protocoloPorCapacidade?: Partial<Record<CapacidadeIa, ProtocoloIa>>;
  /**
   * Capacidades sustentadas. Ausente → `CAPACIDADES_PADRAO` (['texto','json']).
   * Só 'texto'/'json' têm driver ativo hoje.
   */
  capacidades?: CapacidadeIa[];
  /**
   * Modelo concreto por capacidade (ex.: groq.audio = 'whisper-large-v3').
   * Ausente p/ uma capacidade → usa o `modeloDefault`/override normal.
   */
  modeloPorCapacidade?: Partial<Record<CapacidadeIa, string>>;
  /** Ordem default na cadeia (menor = mais cedo). */
  ordemDefault: number;
}

// ── REGISTRY de provedores (extensível: somar provedor = somar entrada) ────────

export const PROVIDERS_REGISTRY: ProvedorRegistro[] = [
  {
    nome: 'nvidia',
    label: 'NVIDIA NIM',
    base: 'https://integrate.api.nvidia.com/v1',
    modeloDefault: 'meta/llama-3.3-70b-instruct',
    modelEnvVar: 'NVIDIA_MODEL',
    keyEnvVars: [
      'NVIDIA_API_KEY',
      'NVIDIA_API_KEY_2',
      'NVIDIA_API_KEY_3',
      'NVIDIA_API_KEY_4',
      'NVIDIA_API_KEY_5',
    ],
    protocolo: 'openai-compat',
    // 'streaming' é honesto (SSE OpenAI-compat) mas SEM driver ativo ainda (F6).
    capacidades: ['texto', 'json', 'streaming'],
    // REBAIXADO: o endpoint da NVIDIA nao responde desta rede — timeout
    // consistente de 20s+ em todas as tentativas (19/08/2026). Mantido no
    // registry porque as 5 chaves seguem validas e ele volta a servir de
    // onde houver rota; mas em PRIMEIRO lugar ele fazia toda chamada de IA
    // esperar o timeout antes do fallback.
    ordemDefault: 4,
  },
  {
    nome: 'groq',
    label: 'Groq',
    base: 'https://api.groq.com/openai/v1',
    // `llama-3.3-70b-versatile` foi DESCOMISSIONADO pela Groq (a API responde
    // 404 "model does not exist"). Verificado em 19/08/2026 contra
    // /v1/models: os vivos sao openai/gpt-oss-120b, openai/gpt-oss-20b e
    // qwen/qwen3.6-27b. O 120b responde em ~480ms.
    modeloDefault: 'openai/gpt-oss-120b',
    modelEnvVar: 'GROQ_MODEL',
    keyEnvVars: ['GROQ_API_KEY', 'GROQ_API_KEY_2'],
    protocolo: 'openai-compat',
    // 'audio' (Whisper) ATIVADO em F3: a Groq fala 'whisper-multipart' no
    // endpoint `/audio/transcriptions`, distinto do 'openai-compat' de texto.
    capacidades: ['texto', 'json', 'streaming', 'audio'],
    protocoloPorCapacidade: { audio: 'whisper-multipart' },
    modeloPorCapacidade: { audio: 'whisper-large-v3' },
    // PRIMEIRO: unico provedor que responde rapido daqui (~300ms) e o que
    // atende `audio` (whisper-large-v3) — o caminho das LEGENDAS.
    ordemDefault: 1,
  },
  {
    nome: 'openrouter',
    label: 'OpenRouter',
    base: 'https://openrouter.ai/api/v1',
    modeloDefault: 'meta-llama/llama-3.3-70b-instruct:free',
    modelEnvVar: 'OPENROUTER_MODEL',
    keyEnvVars: ['OPENROUTER_API_KEY'],
    // Thunk lazy: NÃO lê process.env na avaliação do módulo (corrige o
    // vazamento apontado no plano §1.5/:131-134). Chamado só ao montar a request.
    headersExtra: () => ({
      'HTTP-Referer':
        process.env.OPENROUTER_REFERER?.trim() ||
        'https://oficioexpress.web.app',
      'X-Title': process.env.OPENROUTER_TITLE?.trim() || 'OficioExpress NEXO',
    }),
    protocolo: 'openai-compat',
    capacidades: ['texto', 'json', 'streaming'],
    ordemDefault: 3,
  },
  {
    nome: 'gemini',
    label: 'Google Gemini',
    base: '',
    modeloDefault: 'googleai/gemini-2.5-flash',
    modelEnvVar: 'GEMINI_MODEL',
    keyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY'],
    ehGemini: true,
    protocolo: 'gemini',
    // Gemini é o multimodal: declara tudo (mas só texto/json têm driver ATIVO
    // hoje; audio/imagem/visao/tools/streaming plugam nas frentes futuras).
    capacidades: [
      'texto',
      'json',
      'streaming',
      'audio',
      'imagem',
      'visao',
      'tools',
    ],
    // O modelo de geração de IMAGEM é distinto do de texto (flash não emite mídia).
    modeloPorCapacidade: { imagem: 'googleai/gemini-2.5-flash-image' },
    ordemDefault: 99, // fallback final por default
  },
];

/**
 * Rótulo amigável de um provedor a partir do seu nome curto (ex.: 'nvidia' →
 * 'NVIDIA NIM'). Se desconhecido, devolve o próprio nome capitalizado. Usado
 * pela UI no selo "gerado por …". Aditivo, sem dependências de runtime.
 */
export function labelDoProvedor(nome: string): string {
  const reg = PROVIDERS_REGISTRY.find((r) => r.nome === nome);
  if (reg) return reg.label;
  if (!nome) return 'IA';
  return nome.charAt(0).toUpperCase() + nome.slice(1);
}

/**
 * Tabela de PREÇO por modelo (USD por 1.000.000 de tokens) para o custo
 * ESTIMADO. Os grátis ficam 0 (rótulo "estimado"); o Gemini 2.5 Flash usa a
 * tabela pública. Configurável por modelo no doc `config/ia.precos` no futuro;
 * por ora vive aqui (default), e o painel rotula tudo como "estimado".
 */
export const PRECOS_DEFAULT: Record<
  string,
  { entradaPorM: number; saidaPorM: number }
> = {
  'googleai/gemini-2.5-flash': { entradaPorM: 0.3, saidaPorM: 2.5 },
};

/**
 * Normaliza um id de modelo para a CHAVE estável usada como nome de campo no
 * Firestore (`ia_uso`). DEVE ser idêntica à sanitização feita na Function
 * (`config-uso.ts: rotulo`): minúsculas + troca de caracteres proibidos em
 * nome de campo de map ('.', '/', '~', '*', '[', ']') por '_'.
 *
 * BUG-FIX (custo Gemini sempre $0): o uso era gravado com o modelo SANITIZADO
 * ('.'→'_'), mas o painel chaveava `PRECOS_DEFAULT` pelo id ORIGINAL com pontos
 * ('googleai/gemini-2.5-flash') → o lookup nunca casava e o único provedor pago
 * aparecia grátis. Normalizando os DOIS lados por esta função, a tabela de
 * preço é reindexada pela mesma chave que o agregado guarda e o lookup casa.
 */
export function chaveModeloUso(modelo: string): string {
  return (modelo ?? '')
    .toLowerCase()
    .replace(/[.\/~*[\]]/g, '_')
    .slice(0, 80);
}

/**
 * `PRECOS_DEFAULT` reindexado pela CHAVE normalizada (`chaveModeloUso`) — é o
 * que o painel deve usar para casar com o modelo que vem do agregado `ia_uso`
 * (que está sanitizado). Calculado uma vez na carga do módulo.
 */
export const PRECOS_POR_CHAVE: Record<
  string,
  { entradaPorM: number; saidaPorM: number }
> = Object.fromEntries(
  Object.entries(PRECOS_DEFAULT).map(([id, p]) => [chaveModeloUso(id), p]),
);

// ── Evento de uso (POST fire-and-forget) ──────────────────────────────────────

/**
 * CAPACIDADE da chamada de IA (eixo de observabilidade — aditivo). Hoje só
 * 'texto'/'json' são exercidos pelo orquestrador; os demais ficam reservados
 * para quando os drivers multimodais entrarem (frentes futuras). Ausente no
 * evento → o agregador assume 'texto' (comportamento histórico).
 */
export type CapacidadeIa =
  | 'texto'
  | 'json'
  | 'audio'
  | 'imagem'
  | 'visao'
  | 'tools'
  | 'streaming';

/**
 * CLASSE do erro de uma tentativa que falhou (aditivo). Permite ao painel
 * separar timeout/429/5xx/4xx em vez de um balde único de "erros".
 */
export type ClasseErroIa =
  | 'timeout'
  | '429'
  | '5xx'
  | '4xx'
  | 'auth'
  | 'json_invalido'
  | 'vazio'
  | 'rede'
  | 'outro';

export interface EventoUsoIa {
  provedor: string;
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
  /** Latência da tentativa (ms) — de SUCESSO ou de FALHA (o agregador separa). */
  latenciaMs: number;
  sucesso: boolean;
  /** True se a falha foi 429 (cota/limite). */
  foi429: boolean;
  /** Mensagem de erro curta (quando !sucesso). */
  erro?: string;
  /**
   * Capacidade exercida (aditivo). Default no agregador = 'texto'. Não quebra
   * o shape histórico (campo opcional).
   */
  capacidade?: CapacidadeIa;
  /** Classe do erro (aditivo, quando !sucesso). */
  classeErro?: ClasseErroIa;
  /** Status HTTP da falha, quando houver (aditivo). */
  httpStatus?: number;
}

// ── Resolução do endpoint das Functions ───────────────────────────────────────

/**
 * URL do endpoint HTTP `onIaConfigUso`. Em prod resolve para a URL canônica do
 * Cloud Functions a partir do projectId; pode ser sobrescrita por
 * `IA_CONFIG_USO_URL` (ex.: domínio .run.app). Vazio → modo offline (sem
 * registro de uso, config = default).
 */
function endpointUrl(): string | null {
  const override = process.env.IA_CONFIG_USO_URL?.trim();
  if (override) return override;
  // projectId server-side (mesmo do firestore-read).
  const projectId = process.env.GCLOUD_PROJECT || 'studio-8612233125-caa0a';
  if (!projectId) return null;
  return `https://us-central1-${projectId}.cloudfunctions.net/onIaConfigUso`;
}

// ── Leitura da config (cache curto) ───────────────────────────────────────────

let cacheConfig: { valor: IaConfigDoc; expiraEm: number } | null = null;
/** Último config BOM lido com sucesso — servido em falha (stale-while-error). */
let ultimoConfigBom: IaConfigDoc | null = null;
const CACHE_MS = 45_000;
/** Após falha, re-tenta mais cedo (não segura o stale por 45s inteiros). */
const CACHE_ERRO_MS = 10_000;

/**
 * Lê o doc `config/ia` via endpoint das Functions, com cache de 45s. Em falha
 * serve o ÚLTIMO config bom (stale-while-error) em vez de `{}` — assim um
 * cold-start/saturação do endpoint não descarta silenciosamente a ordenação
 * configurada (ex.: Groq 1º) caindo no default nvidia-first. Sem nenhum bom
 * ainda (1ª falha), cai no `{}` → default do registry. NUNCA lança.
 */
export async function lerConfigIa(): Promise<IaConfigDoc> {
  const agora = Date.now();
  if (cacheConfig && cacheConfig.expiraEm > agora) return cacheConfig.valor;

  const url = endpointUrl();
  if (!url) {
    const valor = ultimoConfigBom ?? {};
    cacheConfig = { valor, expiraEm: agora + CACHE_MS };
    return valor;
  }
  try {
    const resp = await fetch(`${url}?action=config`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = (await resp.json()) as { config?: IaConfigDoc };
    const valor = json?.config ?? {};
    ultimoConfigBom = valor;
    cacheConfig = { valor, expiraEm: agora + CACHE_MS };
    return valor;
  } catch {
    // Stale-while-error: serve o último bom (preserva a ordenação) com cache
    // curto pra re-tentar logo. Sem último bom, cai no default do registry.
    const valor = ultimoConfigBom ?? {};
    cacheConfig = { valor, expiraEm: agora + CACHE_ERRO_MS };
    return valor;
  }
}

/** Invalida o cache (útil em teste; não usado em runtime normal). */
export function invalidarCacheConfigIa(): void {
  cacheConfig = null;
  ultimoConfigBom = null; // zera o stale p/ testes deterministicos
}

// ── Registro de uso (POST fire-and-forget) ────────────────────────────────────

/**
 * Envia 1 evento de uso ao endpoint, sem bloquear nem lançar. Em qualquer falha
 * (endpoint ausente/erro), apenas ignora — a observabilidade é best-effort.
 */
export function registrarUsoIa(evento: EventoUsoIa): void {
  const url = endpointUrl();
  if (!url) return;
  // Não await: fire-and-forget. O .catch evita unhandled rejection.
  void fetch(`${url}?action=uso`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(evento),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {
    /* silencioso por design */
  });
}
