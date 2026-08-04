/**
 * GET /api/nexo/saude-ingestao
 *
 * Painel de SAÚDE da ingestão do NEXO (Fase 4). Lê a coleção inteira de
 * `nexo_sync_state` — o cron de coleta grava ali um documento por par
 * `${fonte}-${exercicio}` registrando o resultado de cada coleta.
 *
 * Diferente de `/api/nexo/status` (que sonda conectividade ao vivo), esta rota
 * NÃO bate em nenhuma fonte externa: só lê o estado já persistido e o agrega
 * por FONTE, devolvendo a saúde real da última ingestão de cada uma.
 *
 * Derivação do `statusSaude`
 * --------------------------
 * O cron já grava `statusSaude` em cada doc. Mas documentos antigos podem não
 * ter esse campo (nem `errosConsecutivos`/`ultimoSucessoEm`/`cadencia`). Nesses
 * casos a rota DERIVA o estado de forma honesta a partir de `coletadoEm`,
 * `erro`, `parcial` e da `cadencia` esperada:
 *   - `falha`     → última coleta terminou com `erro`;
 *   - `degradado` → coleta `parcial` (alguma página/trecho falhou);
 *   - `stale`     → sem coleta há mais que a janela tolerada da `cadencia`;
 *   - `ok`        → coleta recente, sem erro e completa.
 *
 * A saúde da FONTE é o pior estado entre seus exercícios (uma falha em qualquer
 * exercício rebaixa a fonte inteira).
 *
 * Apenas dados públicos. Responde honesto se `nexo_sync_state` estiver vazia.
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';

export const runtime = 'nodejs';
// Cache curto: a ingestão muda no máximo algumas vezes ao dia (crons) — o cache
// evita amplificar leituras do Firestore a cada acesso da página de Coleta.
export const revalidate = 120;

/** Estado de saúde de uma ingestão — contrato gravado pelo cron. */
export type StatusSaude = 'ok' | 'stale' | 'degradado' | 'falha';

/** Cadência esperada de coleta de uma fonte — contrato gravado pelo cron. */
export type Cadencia = 'diario' | 'quinzenal' | '6h' | '30min' | '1h' | 'evento';

/** Saúde de uma fonte de ingestão, agregada de todos os seus exercícios. */
export interface FonteSaude {
  /** Nome curto da fonte (ex.: 'empenhos'). */
  fonte: string;
  /** Coleção `nexo_*` onde a fonte persiste seus registros, se conhecida. */
  colecao: string | null;
  /** Pior estado entre os exercícios cobertos — o que define o semáforo. */
  statusSaude: StatusSaude;
  /** Cadência esperada da fonte; null quando nenhum doc a registrou. */
  cadencia: Cadencia | null;
  /** Exercícios cobertos pela fonte, em ordem decrescente. */
  exercicios: number[];
  /** Soma dos registros de todos os exercícios da fonte. */
  registros: number;
  /** Coleta mais recente da fonte (ISO), ou null se nunca coletou. */
  ultimaColeta: string | null;
  /** Último sucesso da fonte (ISO), ou null. */
  ultimoSucesso: string | null;
  /** Mensagem de erro mais recente, ou null se íntegra. */
  erro: string | null;
  /** Maior contador de erros consecutivos entre os exercícios. */
  errosConsecutivos: number;
  /** true se ALGUM exercício da fonte teve coleta parcial. */
  parcial: boolean;
  /**
   * true se ALGUM exercício da fonte foi TRUNCADO no cap de páginas (dados
   * cortados — a fonte tem mais registros do que coletamos). Sinal de cobertura
   * incompleta distinto de `parcial` (falha de página no meio).
   */
  truncado: boolean;
  /** Exercícios truncados desta fonte, em ordem decrescente (vazio se nenhum). */
  exerciciosTruncados: number[];
  /** Duração da última coleta da fonte em ms, ou null. */
  duracaoMs: number | null;
  /** true quando o `statusSaude` foi derivado (doc antigo sem o campo). */
  derivado: boolean;
}

/**
 * Uma célula da matriz de cobertura (ano × fonte): o estado da coleta de UMA
 * fonte num exercício específico. `presente=false` quando aquele par não tem
 * doc em `nexo_sync_state` (lacuna de cobertura — ano não coletado).
 */
export interface CoberturaCelula {
  fonte: string;
  exercicio: number;
  /** false = nenhuma coleta registrada para este par (lacuna). */
  presente: boolean;
  statusSaude: StatusSaude | null;
  registros: number;
  truncado: boolean;
  parcial: boolean;
  /** Última coleta do par (ISO), ou null. */
  coletadoEm: string | null;
}

/** Matriz de cobertura temporal: fontes × exercícios, com lacunas explícitas. */
export interface MatrizCobertura {
  /** Exercícios cobertos por ALGUMA fonte, em ordem decrescente. */
  exercicios: number[];
  /** Nomes de fonte, em ordem alfabética. */
  fontes: string[];
  /** Células (fonte×exercício) — inclui as ausentes com `presente:false`. */
  celulas: CoberturaCelula[];
  /** Pares fonte×exercício esperados mas SEM coleta (lacunas). */
  lacunas: number;
}

/** Resposta da rota — exportada para a página importar com `import type`. */
export interface SaudeIngestaoResponse {
  /** false quando `nexo_sync_state` está vazia (cron nunca rodou). */
  ingestaoExecutou: boolean;
  resumo: {
    /** Total de fontes distintas em `nexo_sync_state`. */
    fontes: number;
    ok: number;
    stale: number;
    degradado: number;
    falha: number;
    /** Fontes com ALGUM exercício truncado (dados cortados no cap). */
    truncadas: number;
    /** Total de registros somados de todas as fontes. */
    registros: number;
    /** Coleta mais recente entre todas as fontes (ISO), ou null. */
    ultimaColeta: string | null;
  };
  /** Saúde por fonte, ordenada pelo estado mais grave primeiro. */
  fontes: FonteSaude[];
  /** Matriz de cobertura temporal (fonte × exercício) com lacunas explícitas. */
  matrizCobertura: MatrizCobertura;
  /**
   * Crons/fontes em estado NÃO-saudável (falha, stale ou degradado), ordenados
   * pelo estado mais grave — a worklist de quem precisa de atenção. Vazio = tudo
   * ok.
   */
  cronsDegradados: FonteSaude[];
  /** Aviso humano quando a ingestão ainda não rodou. */
  aviso: string | null;
  atualizadoEm: string;
}

// ── Coerções dos campos brutos de `nexo_sync_state` ──────────────────────────

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asStatusSaude(v: unknown): StatusSaude | null {
  return v === 'ok' || v === 'stale' || v === 'degradado' || v === 'falha'
    ? v
    : null;
}

function asCadencia(v: unknown): Cadencia | null {
  return v === 'diario' ||
    v === 'quinzenal' ||
    v === '6h' ||
    v === '30min' ||
    v === '1h' ||
    v === 'evento'
    ? v
    : null;
}

/**
 * Janela máxima, em ms, em que uma coleta ainda é considerada "fresca" para
 * cada cadência. Inclui folga para tolerar uma execução perdida do cron sem
 * marcar a fonte como `stale` no primeiro atraso.
 */
const JANELA_FRESCOR_MS: Record<Cadencia, number> = {
  '30min': 90 * 60 * 1000, // 30min + folga (3× o intervalo)
  '1h': 3 * 60 * 60 * 1000, // 1h + folga (3× o intervalo)
  '6h': 9 * 60 * 60 * 1000, // 6h + folga de 3h
  diario: 36 * 60 * 60 * 1000, // 24h + folga de 12h
  quinzenal: 18 * 24 * 60 * 60 * 1000, // 15d + folga de 3d
  // 'evento' é disparado por gatilho (não por cron): nunca fica "stale" por
  // tempo — a saúde vem do último sucesso/erro, não da idade.
  evento: Number.POSITIVE_INFINITY,
};

/** Cadência assumida quando o doc não a registra — diário é o caso comum. */
const CADENCIA_PADRAO: Cadencia = 'diario';

/** Estado de saúde de UM doc de `nexo_sync_state` (uma fonte/exercício). */
interface SaudeDoc {
  status: StatusSaude;
  derivado: boolean;
}

/**
 * Resolve o `statusSaude` de um doc. Prefere o campo gravado pelo cron; se
 * ausente (doc antigo), DERIVA de `erro`/`parcial`/`coletadoEm` + `cadencia`.
 */
function resolverSaude(
  statusGravado: StatusSaude | null,
  erro: string | null,
  parcial: boolean,
  coletadoEm: string | null,
  cadencia: Cadencia,
  agora: number,
): SaudeDoc {
  if (statusGravado !== null) {
    return { status: statusGravado, derivado: false };
  }
  // Derivação honesta — ordem de gravidade: falha > stale > degradado > ok.
  if (erro !== null) return { status: 'falha', derivado: true };
  if (coletadoEm === null) return { status: 'falha', derivado: true };
  const idade = agora - new Date(coletadoEm).getTime();
  if (!Number.isFinite(idade) || idade > JANELA_FRESCOR_MS[cadencia]) {
    return { status: 'stale', derivado: true };
  }
  if (parcial) return { status: 'degradado', derivado: true };
  return { status: 'ok', derivado: true };
}

/** Ordem de gravidade para escolher o pior estado de uma fonte. */
const GRAVIDADE: Record<StatusSaude, number> = {
  ok: 0,
  stale: 1,
  degradado: 2,
  falha: 3,
};

function maisGrave(a: StatusSaude, b: StatusSaude): StatusSaude {
  return GRAVIDADE[b] > GRAVIDADE[a] ? b : a;
}

/** Estado intermediário acumulado por fonte enquanto agregamos exercícios. */
interface AcumuladorFonte {
  fonte: string;
  colecao: string | null;
  cadencia: Cadencia | null;
  status: StatusSaude;
  exercicios: Set<number>;
  registros: number;
  ultimaColeta: string | null;
  ultimoSucesso: string | null;
  /** erro do doc mais recente (por `coletadoEm`). */
  erro: string | null;
  /** `coletadoEm` que ancora o `erro` corrente — para escolher o mais recente. */
  erroEm: string | null;
  errosConsecutivos: number;
  parcial: boolean;
  truncado: boolean;
  exerciciosTruncados: Set<number>;
  /** `duracaoMs` do doc mais recente. */
  duracaoMs: number | null;
  duracaoEm: string | null;
  derivado: boolean;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Filtro vazio → lê `nexo_sync_state` inteira. A coleção é pequena (dezenas
  // de docs: uma fonte por exercício), então agregamos em memória.
  let docs: Record<string, unknown>[];
  try {
    docs = await lerColecaoNexo('nexo_sync_state', {}, sessao.idToken);
  } catch (err) {
    return NextResponse.json(
      {
        erro:
          'falha ao ler o estado da ingestão (nexo_sync_state): ' +
          (err instanceof Error ? err.message : 'erro desconhecido'),
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const agora = Date.now();

  // ── Ingestão nunca rodou — resposta honesta, não é erro ────────────────────
  if (docs.length === 0) {
    const vazio: SaudeIngestaoResponse = {
      ingestaoExecutou: false,
      resumo: {
        fontes: 0,
        ok: 0,
        stale: 0,
        degradado: 0,
        falha: 0,
        truncadas: 0,
        registros: 0,
        ultimaColeta: null,
      },
      fontes: [],
      matrizCobertura: {
        exercicios: [],
        fontes: [],
        celulas: [],
        lacunas: 0,
      },
      cronsDegradados: [],
      aviso:
        'A ingestão automática ainda não rodou: a coleção nexo_sync_state está ' +
        'vazia. Assim que o cron de coleta executar pela primeira vez, a saúde ' +
        'de cada fonte aparecerá aqui.',
      atualizadoEm: new Date().toISOString(),
    };
    return NextResponse.json(vazio, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // ── Agrega os docs por fonte + monta as células da matriz de cobertura ─────
  const porFonte = new Map<string, AcumuladorFonte>();
  // Células presentes por par fonte×exercício (dedup pelo doc mais recente).
  const celulasPresentes = new Map<string, CoberturaCelula>();
  // Conjuntos para o esqueleto da matriz (eixos).
  const todosExercicios = new Set<number>();
  const todasFontes = new Set<string>();

  for (const d of docs) {
    const fonte = asString(d.fonte) ?? '(desconhecida)';
    const colecao = asString(d.colecao);
    const exercicio = asNumber(d.exercicio);
    const registros = asNumber(d.registros);
    const parcial = d.parcial === true;
    const truncado = d.truncado === true;
    const erro = asString(d.erro);
    const coletadoEm = asString(d.coletadoEm);
    const cadencia = asCadencia(d.cadencia);
    const ultimoSucesso = asString(d.ultimoSucessoEm);
    const duracaoMs =
      typeof d.duracaoMs === 'number' && Number.isFinite(d.duracaoMs)
        ? d.duracaoMs
        : null;
    const errosConsecutivos = asNumber(d.errosConsecutivos);

    const { status, derivado } = resolverSaude(
      asStatusSaude(d.statusSaude),
      erro,
      parcial,
      coletadoEm,
      cadencia ?? CADENCIA_PADRAO,
      agora,
    );

    // Eixos/célula da matriz. Docs agregados (ex.: `_coleta_diaria`) têm
    // `exercicio<=0` e NÃO entram na matriz por ano — só na visão por fonte.
    if (exercicio > 0) {
      todosExercicios.add(exercicio);
      todasFontes.add(fonte);
      const chaveCelula = `${fonte}|${exercicio}`;
      const existente = celulasPresentes.get(chaveCelula);
      // Mantém a coleta mais recente do par (ISO lexicográfico).
      if (
        !existente ||
        (coletadoEm ?? '') >= (existente.coletadoEm ?? '')
      ) {
        celulasPresentes.set(chaveCelula, {
          fonte,
          exercicio,
          presente: true,
          statusSaude: status,
          registros,
          truncado,
          parcial,
          coletadoEm,
        });
      }
    }

    let acc = porFonte.get(fonte);
    if (!acc) {
      acc = {
        fonte,
        colecao,
        cadencia,
        status,
        exercicios: new Set<number>(),
        registros: 0,
        ultimaColeta: null,
        ultimoSucesso: null,
        erro: null,
        erroEm: null,
        errosConsecutivos: 0,
        parcial: false,
        truncado: false,
        exerciciosTruncados: new Set<number>(),
        duracaoMs: null,
        duracaoEm: null,
        derivado: false,
      };
      porFonte.set(fonte, acc);
    }

    if (acc.colecao === null && colecao !== null) acc.colecao = colecao;
    if (acc.cadencia === null && cadencia !== null) acc.cadencia = cadencia;
    if (exercicio > 0) acc.exercicios.add(exercicio);
    acc.registros += registros;
    acc.status = maisGrave(acc.status, status);
    acc.errosConsecutivos = Math.max(acc.errosConsecutivos, errosConsecutivos);
    acc.parcial = acc.parcial || parcial;
    acc.truncado = acc.truncado || truncado;
    if (truncado && exercicio > 0) acc.exerciciosTruncados.add(exercicio);
    acc.derivado = acc.derivado || derivado;

    // Coleta mais recente da fonte (comparação ISO lexicográfica funciona).
    if (coletadoEm && (acc.ultimaColeta === null || coletadoEm > acc.ultimaColeta)) {
      acc.ultimaColeta = coletadoEm;
    }
    if (
      ultimoSucesso &&
      (acc.ultimoSucesso === null || ultimoSucesso > acc.ultimoSucesso)
    ) {
      acc.ultimoSucesso = ultimoSucesso;
    }
    // erro e duracao do doc mais recente — ancorados em `coletadoEm`.
    if (erro && (acc.erroEm === null || (coletadoEm ?? '') >= acc.erroEm)) {
      acc.erro = erro;
      acc.erroEm = coletadoEm ?? '';
    }
    if (
      duracaoMs !== null &&
      (acc.duracaoEm === null || (coletadoEm ?? '') >= acc.duracaoEm)
    ) {
      acc.duracaoMs = duracaoMs;
      acc.duracaoEm = coletadoEm ?? '';
    }
  }

  const fontes: FonteSaude[] = Array.from(porFonte.values())
    .map((acc) => ({
      fonte: acc.fonte,
      colecao: acc.colecao,
      statusSaude: acc.status,
      cadencia: acc.cadencia,
      exercicios: Array.from(acc.exercicios).sort((a, b) => b - a),
      registros: acc.registros,
      ultimaColeta: acc.ultimaColeta,
      ultimoSucesso: acc.ultimoSucesso,
      erro: acc.erro,
      errosConsecutivos: acc.errosConsecutivos,
      parcial: acc.parcial,
      truncado: acc.truncado,
      exerciciosTruncados: Array.from(acc.exerciciosTruncados).sort(
        (a, b) => b - a,
      ),
      duracaoMs: acc.duracaoMs,
      derivado: acc.derivado,
    }))
    // Mais grave primeiro; em empate, nome da fonte.
    .sort(
      (a, b) =>
        GRAVIDADE[b.statusSaude] - GRAVIDADE[a.statusSaude] ||
        a.fonte.localeCompare(b.fonte),
    );

  const ultimaColeta = fontes.reduce<string | null>((acc, f) => {
    if (f.ultimaColeta && (acc === null || f.ultimaColeta > acc)) {
      return f.ultimaColeta;
    }
    return acc;
  }, null);

  // ── Matriz de cobertura: produto fonte × exercício, lacunas explícitas ─────
  // Só fontes com exercício real entram nos eixos (docs agregados ficam de fora,
  // pois não cobrem um ano específico). Cada par sem doc vira célula ausente —
  // é a forma honesta de mostrar "este ano não foi coletado por esta fonte".
  const exerciciosMatriz = Array.from(todosExercicios).sort((a, b) => b - a);
  const fontesMatriz = Array.from(todasFontes).sort((a, b) =>
    a.localeCompare(b),
  );
  const celulas: CoberturaCelula[] = [];
  let lacunas = 0;
  for (const f of fontesMatriz) {
    for (const ex of exerciciosMatriz) {
      const presente = celulasPresentes.get(`${f}|${ex}`);
      if (presente) {
        celulas.push(presente);
      } else {
        lacunas++;
        celulas.push({
          fonte: f,
          exercicio: ex,
          presente: false,
          statusSaude: null,
          registros: 0,
          truncado: false,
          parcial: false,
          coletadoEm: null,
        });
      }
    }
  }
  const matrizCobertura: MatrizCobertura = {
    exercicios: exerciciosMatriz,
    fontes: fontesMatriz,
    celulas,
    lacunas,
  };

  // Worklist: fontes que NÃO estão saudáveis (falha/stale/degradado), já na
  // ordem de gravidade herdada de `fontes`.
  const cronsDegradados = fontes.filter((f) => f.statusSaude !== 'ok');

  const response: SaudeIngestaoResponse = {
    ingestaoExecutou: true,
    resumo: {
      fontes: fontes.length,
      ok: fontes.filter((f) => f.statusSaude === 'ok').length,
      stale: fontes.filter((f) => f.statusSaude === 'stale').length,
      degradado: fontes.filter((f) => f.statusSaude === 'degradado').length,
      falha: fontes.filter((f) => f.statusSaude === 'falha').length,
      truncadas: fontes.filter((f) => f.truncado).length,
      registros: fontes.reduce((s, f) => s + f.registros, 0),
      ultimaColeta,
    },
    fontes,
    matrizCobertura,
    cronsDegradados,
    aviso: null,
    atualizadoEm: new Date().toISOString(),
  };

  return NextResponse.json(response, {
    headers: { 'Cache-Control': 'private, max-age=120' },
  });
}
