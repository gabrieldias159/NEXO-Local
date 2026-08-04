/**
 * POST /api/nexo/detectar
 *
 * Computa os detectores anticorrupção do NEXO sobre os registros de um
 * exercício e devolve os alertas já carimbados com `chaveDeteccao`. NÃO grava
 * nada — é uma rota de CÔMPUTO puro.
 *
 * Quem chama: a Cloud Function de monitoramento (Fase 2). Ela tem
 * `firebase-admin`, mas NÃO manda mais os brutos no body — manda só
 * `{ exercicio }` + um access token de serviço. Esta rota LÊ ela mesma as
 * coleções `nexo_*` do Firestore (via REST, igual a `/api/nexo/analise`),
 * normaliza, roda os detectores e devolve os alertas. A escrita administrativa
 * em `nexo_alertas` continua na Function.
 *
 * PERFIL DE MEMÓRIA (fix do OOM): o contrato antigo mandava o EXERCÍCIO INTEIRO
 * no body (empenhos+despesas+cross-sources inteiras, dezenas de MB). Isto
 * mantinha VIVOS ao mesmo tempo o buffer cru do body + o grafo do JSON.parse +
 * as cópias normalizadas — pico triplo sobre registros gordos que estourava o
 * heap V8 mesmo a 4 GiB. Agora a rota lê do Firestore e normaliza IMEDIATAMENTE
 * (os docs brutos viram lixo coletável logo após cada `normalizar*`), exatamente
 * como `/api/nexo/analise` — que faz o MESMO trabalho + ranking + 6 fetches de
 * CNPJ e cabe em 4 GiB. O pico cai para o de `/analise`.
 *
 * Proteção: header `x-nexo-secret`, comparado a `NEXO_DETECTAR_SECRET` (ou, em
 * fallback, `DIARIO_BACKFILL_SECRET`). Sem segredo configurado no ambiente, a
 * rota responde 503 honesto — não fica aberta por omissão.
 *
 * CONTRATO DA REQUISIÇÃO (fixado — a Cloud Function manda exatamente isto):
 *   POST
 *     header `x-nexo-secret: <segredo>`
 *     header `x-nexo-firestore-token: <OAuth2 access token de serviço>`
 *     body JSON: { exercicio: number }
 *   O token autentica a leitura REST das coleções `nexo_*` (a rota não tem
 *   `firebase-admin`); `:runQuery` aceita tanto ID token Firebase quanto access
 *   token de serviço, então o mesmo `lerColecaoNexo` de `/analise` serve.
 *
 * CONTRATO DA RESPOSTA (fixado — INALTERADO):
 *   { exercicio: number, total: number, alertas: AlertaComChave[] }
 */
import { gzipSync } from 'node:zlib';
import { NextResponse } from 'next/server';
import {
  normalizarEmpenhosFornecedor,
  normalizarDiarias,
  normalizarModalidades,
  normalizarRestosAPagar,
  normalizarDespesas,
} from '@/lib/nexo/normalizar';
import { rodarDetectores, type MetricasDeteccao } from '@/lib/nexo/detectores';
import { chaveDeteccao, type AlertaComChave } from '@/lib/nexo/alertas';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import { consultasDeDocsSancoes } from '@/lib/nexo/sources/sancoes-federais';
import { consultasDeDocsSancoesEstaduais } from '@/lib/nexo/detectores/sancoes-estaduais-det';
import { acordosDeDocsLeniencia } from '@/lib/nexo/sources/leniencia';
import { tceDespesasDeDocsTce } from '@/lib/nexo/detectores/tce-divergencia-det';
import { sociosDeDocs } from '@/lib/nexo/detectores/socio-comum-det';
import { doacoesDeDocs } from '@/lib/nexo/detectores/doador-politico-det';
import { hashDoc } from '@/lib/nexo/pii';
import { enriquecerProcedencia } from '@/lib/nexo/procedencia';
import { enriquecerCrivoLegal } from '@/lib/nexo/base-legal';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Resposta da rota de cômputo — consumida pela Cloud Function de monitoramento. */
export interface DetectarResponse {
  exercicio: number;
  total: number;
  alertas: AlertaComChave[];
  /** Métricas de calibragem por execução (A9): emitidos × filtrados por detector. */
  metricas?: MetricasDeteccao;
}

export async function POST(req: Request) {
  // 1. Proteção por segredo compartilhado. Sem segredo no ambiente → 503
  // honesto (a rota não fica aberta por omissão de configuração).
  const segredo =
    process.env.NEXO_DETECTAR_SECRET ?? process.env.DIARIO_BACKFILL_SECRET;
  if (!segredo) {
    return NextResponse.json(
      { erro: 'rota de detecção não configurada (segredo ausente)' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const enviado = req.headers.get('x-nexo-secret') ?? '';
  if (enviado !== segredo) {
    return NextResponse.json(
      { erro: 'acesso negado' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // 2. Access token de serviço — a Function o obtém via admin SDK e o manda no
  // header. É o que autentica a leitura REST das coleções `nexo_*`. Sem ele a
  // rota não consegue ler (não tem `firebase-admin`).
  const idToken = req.headers.get('x-nexo-firestore-token') ?? '';
  if (!idToken) {
    return NextResponse.json(
      { erro: 'token de leitura ausente (x-nexo-firestore-token)' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // 3. Body MÍNIMO — só `{ exercicio }`. Sem brutos no payload (essa era a raiz
  // do OOM). O parse é trivial (poucos bytes).
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { erro: 'corpo inválido — JSON esperado' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const corpo = (body ?? {}) as { exercicio?: unknown };
  const exercicio = Number(corpo.exercicio);
  if (!Number.isInteger(exercicio) || exercicio < 2000 || exercicio > 2100) {
    return NextResponse.json(
      { erro: 'campo `exercicio` ausente ou inválido' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // 4. Lê as coleções `nexo_*` do Firestore e NORMALIZA IMEDIATAMENTE — mesmo
  // padrão de `/api/nexo/analise`. Cada `normalizar*` produz o tipo enxuto
  // (EmpenhoNorm/DespesaNorm/...) e os docs brutos lidos viram lixo coletável
  // assim que saem de escopo, sem reter `...bruto`. As 5 leituras por-exercício
  // em paralelo; o `await` libera o array de docs cru de cada uma logo após
  // normalizar (não guardamos os `docs*` além do necessário).
  let empenhos: ReturnType<typeof normalizarEmpenhosFornecedor>;
  let diarias: ReturnType<typeof normalizarDiarias>;
  let modalidades: ReturnType<typeof normalizarModalidades>;
  let restosAPagar: ReturnType<typeof normalizarRestosAPagar>;
  let despesas: ReturnType<typeof normalizarDespesas>;
  try {
    const [
      docsEmpenhos,
      docsDiarias,
      docsModalidades,
      docsRestos,
      docsDespesas,
    ] = await Promise.all([
      lerColecaoNexo('nexo_empenhos', { exercicio, fonte: 'empenhos' }, idToken),
      lerColecaoNexo('nexo_diarias', { exercicio, fonte: 'diarias' }, idToken),
      lerColecaoNexo('nexo_modalidades', { exercicio, fonte: 'modalidades' }, idToken),
      lerColecaoNexo('nexo_restos', { exercicio, fonte: 'restos' }, idToken),
      lerColecaoNexo('nexo_despesas', { exercicio, fonte: 'despesas' }, idToken),
    ]);
    empenhos = normalizarEmpenhosFornecedor(docsEmpenhos, exercicio);
    diarias = normalizarDiarias(docsDiarias, exercicio);
    modalidades = normalizarModalidades(docsModalidades);
    restosAPagar = normalizarRestosAPagar(docsRestos, exercicio);
    despesas = normalizarDespesas(docsDespesas, exercicio);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erro desconhecido';
    return NextResponse.json(
      { erro: `falha lendo coleções nexo_* do Firestore: ${msg}` },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Fontes CRUZADAS (não por-exercício): sanções federais por CNPJ. Cada uma
  // degrada para [] se a coleção estiver ausente/inacessível (cruzamento
  // inativo) — nunca derruba a detecção. Mesma mecânica de `/analise`.
  let sancoes: ReturnType<typeof consultasDeDocsSancoes> = [];
  try {
    sancoes = consultasDeDocsSancoes(await lerColecaoNexo('nexo_sancoes', {}, idToken));
  } catch {
    /* sanções indisponíveis — FR-04 inativo, a detecção segue */
  }
  // Sanções ESTADUAIS (Relação de Apenados do TCE-SP, de `nexo_sancoes_estaduais`):
  // habilita o FR-04E (sancionado-TCE×empenho). Ausência → cruzamento inativo.
  let sancoesEstaduais: ReturnType<typeof consultasDeDocsSancoesEstaduais> = [];
  try {
    sancoesEstaduais = consultasDeDocsSancoesEstaduais(
      await lerColecaoNexo('nexo_sancoes_estaduais', {}, idToken),
    );
  } catch {
    /* sanções estaduais indisponíveis — FR-04E inativo, a detecção segue */
  }
  // Acordos de leniência da CGU por CNPJ (de `nexo_leniencia`): habilita o FR-05.
  let leniencia: ReturnType<typeof acordosDeDocsLeniencia> = [];
  try {
    leniencia = acordosDeDocsLeniencia(
      await lerColecaoNexo('nexo_leniencia', {}, idToken),
    );
  } catch {
    /* leniência indisponível — FR-05 inativo, a detecção segue */
  }
  // 2ª fonte oficial por nº empenho (exercise-scoped): habilita o detector X2.
  let tceDespesas: ReturnType<typeof tceDespesasDeDocsTce> = [];
  try {
    tceDespesas = tceDespesasDeDocsTce(
      await lerColecaoNexo('nexo_tce_despesas', { exercicio }, idToken),
    );
  } catch {
    /* TCE-SP indisponível — X2 inativo, a detecção segue */
  }
  // Grafo societário (QSA) + doações TSE — cruzados (XS-SOCIO / XS-DOADOR).
  // hashDoc é a MESMA fn que gerou os hashes nos coletores → o CNPJ do
  // fornecedor casa com os doadores. Doação é lícita: vínculo a apurar.
  let socios: ReturnType<typeof sociosDeDocs> = [];
  try {
    socios = sociosDeDocs(await lerColecaoNexo('nexo_socios', {}, idToken));
  } catch {
    /* sócios indisponíveis — XS-SOCIO inativo, a detecção segue */
  }
  let doacoesTse: ReturnType<typeof doacoesDeDocs> = [];
  try {
    doacoesTse = doacoesDeDocs(await lerColecaoNexo('nexo_doacoes_tse', {}, idToken));
  } catch {
    /* TSE indisponível — XS-DOADOR inativo, a detecção segue */
  }
  const dataReferencia = new Date().toISOString().slice(0, 10);

  const totalEmpenhado = empenhos.reduce((s, e) => s + e.valorEmpenhado, 0);

  // 5+6. Roda o motor de detectores e ENRIQUECE os achados. Ambos eram
  // UNGUARDED: qualquer edge-case num detector ou no enriquecimento (ex.: dado
  // 2026 incompleto/atípico) virava um 500 SEM STACK — o cron `_coleta_diaria`
  // via só "HTTP 500" e não havia como diagnosticar (P1-C). Agora envelopamos o
  // bloco e LOGAMOS a stack real (com exercício/contagens) antes de devolver um
  // 502 honesto, para o erro ficar rastreável no log da função.
  let alertas: AlertaComChave[];
  const metricas: MetricasDeteccao = {
    porDetector: {},
    totalEmitidos: 0,
    totalFiltradosPublico: 0,
    totalDocCapado: 0,
  };
  try {
    // `amostra:false` — o exercício inteiro foi lido das coleções `nexo_*`, não
    // uma amostra. MESMA chamada de `/analise`.
    const detectados = rodarDetectores(
      {
        exercicio,
        empenhos,
        diarias,
        modalidades,
        restosAPagar,
        despesas,
        totalEmpenhado,
        amostra: false,
        sancoes,
        sancoesEstaduais,
        leniencia,
        tceDespesas,
        socios,
        doacoesTse,
        hashDocFn: hashDoc,
        dataReferencia,
      },
      metricas,
    );

    // Enriquece com PROCEDÊNCIA (link da prova documental em cada evidência) e
    // carimba a `chaveDeteccao` determinística — a Function usa essa chave como
    // `id` do doc em `nexo_alertas` (upsert idempotente). O documento vira o
    // acessório de consulta do achado (rastro probatório).
    alertas = detectados.map((a) => {
      // Provas (procedência documental) + crivo legal (norma aplicável sempre
      // presente) — os dois enriquecimentos aditivos antes de carimbar a chave.
      const enriquecido = enriquecerCrivoLegal(
        enriquecerProcedencia({ ...a, exercicio }),
      );
      return {
        ...enriquecido,
        chaveDeteccao: chaveDeteccao(enriquecido, exercicio),
      };
    });
  } catch (err) {
    // Stack REAL no log (antes era um 500 mudo). Inclui o exercício e as
    // contagens normalizadas para localizar o registro/edge-case culpado.
    const stack = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(
      `/api/nexo/detectar — falha na detecção/enriquecimento ` +
        `(exercicio=${exercicio}; empenhos=${empenhos.length} ` +
        `diarias=${diarias.length} modalidades=${modalidades.length} ` +
        `restos=${restosAPagar.length} despesas=${despesas.length} ` +
        `sancoes=${sancoes.length} sancoesEstaduais=${sancoesEstaduais.length} ` +
        `leniencia=${leniencia.length} ` +
        `tceDespesas=${tceDespesas.length} socios=${socios.length} ` +
        `doacoesTse=${doacoesTse.length})\n${stack}`,
    );
    const msg = err instanceof Error ? err.message : 'erro desconhecido';
    return NextResponse.json(
      { erro: `falha ao rodar detectores/enriquecimento: ${msg}`, exercicio },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // 7. Resposta GZIPADA. O teto de 32 MiB do Cloud Run para resposta
  // não-streamada vale para os BYTES NO FIO: o JSON de 2025 (~40 MB) chegava
  // TRUNCADO na Function (prod, 2026-06-09). Gzip explícito derruba o corpo
  // para ~3-6 MB — folga de sobra — e o fetch (undici) da Function
  // descomprime sozinho via Content-Encoding (res.json() transparente).
  // (Streaming NDJSON foi tentado e revertido: o App Hosting cortava o
  // stream a ~2 KB de forma "limpa" — prod, 2026-06-10.)
  const resposta: DetectarResponse = {
    exercicio,
    total: alertas.length,
    alertas,
    metricas,
  };
  const corpoGzip = gzipSync(Buffer.from(JSON.stringify(resposta)));

  return new Response(new Uint8Array(corpoGzip), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-store',
    },
  });
}
