/**
 * GET /api/nexo/metas-fiscais?exercicio=2026
 *
 * Monitor de Metas Fiscais & Orçamentárias. Retorna o catálogo de indicadores
 * (limites e fundamentos legais) e tenta apurar os valores reais via SICONFI.
 *
 * A extração de valor é best-effort: o SICONFI publica os dados em estruturas
 * que variam por anexo/exercício. Quando o valor não é localizado, o indicador
 * volta com `valor: null` e a UI degrada graciosamente.
 *
 * Além dos indicadores-medidor (saúde/educação/pessoal/dívida), a rota apura os
 * detectores de RISCO FISCAL do catálogo §10 que produzem ALERTA, não medidor:
 *   - MF-09 — Restos a pagar sem cobertura de caixa (LRF art. 42)
 *   - MF-10 — Restos a pagar antigos sem baixa (LRF art. 42; Lei 4.320/1964)
 *   - MF-12 — Indicador fiscal em tendência de piora (LRF art. 59)
 *   - MF-13 — Queda de investimento social em ano eleitoral (LC 141/2012; CF 212)
 *   - MF-14 — Arrecadação abaixo do previsto (LRF art. 9º, 59 §1º I)
 * Cada detector é best-effort: quando o SICONFI não publica o dado de forma
 * extraível, o detector NÃO gera alerta e o motivo fica registrado em
 * `cobertura.semDado` — nunca se mascara fonte ausente como "tudo ok".
 */
import { NextResponse } from 'next/server';
import { getRGF, getRREO } from '@/lib/nexo/sources/siconfi';
import {
  INDICADORES_FISCAIS,
  situacaoIndicador,
  type SituacaoIndicador,
} from '@/lib/nexo/metas';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { calcularPrazosFiscais, type PrazoFiscal } from '@/lib/nexo/prazos';
import type { AlertaDetectado } from '@/lib/nexo/detectores/tipos';
import {
  apurarRestosAPagar,
  apurarArrecadacao,
  apurarDespesaFuncao,
  apurarEmpenhoVsRCL,
  apurarLiquidacaoVsReceita,
} from '@/lib/nexo/siconfi-fiscal';

export const runtime = 'nodejs';
export const revalidate = 3600;
export const maxDuration = 60;

export interface IndicadorApurado {
  chave: string;
  rotulo: string;
  limite: number;
  sentido: 'minimo' | 'maximo';
  fundamento: string;
  descricao: string;
  valor: number | null;
  situacao: SituacaoIndicador;
  periodoApurado: string | null;
}

export interface MetasFiscaisResponse {
  exercicio: number;
  indicadores: IndicadorApurado[];
  /** Detectores de risco fiscal §10 que produzem alerta (MF-09/10/12/13/14). */
  alertasFiscais: AlertaDetectado[];
  /** Cobertura honesta: detectores que não puderam apurar e o motivo. */
  cobertura: {
    detectoresApurados: string[];
    semDado: { id: string; motivo: string }[];
  };
  /** Valor absoluto da RCL (Receita Corrente Líquida), extraído do RGF Anexo 01. */
  rcl: { valor: number; periodo: string | null } | null;
  /**
   * Execução consolidada do exercício (RREO Anexo 01/02 + RGF) em números
   * ESTRUTURADOS — a UI monta cards a partir daqui, nunca de valores fixos.
   * Campo `null` = a fonte não publicou de forma extraível (UI degrada p/ "—").
   */
  execucao: {
    /** Total empenhado acumulado no exercício (RREO Anexo 02). */
    empenhado: number | null;
    /** Total liquidado acumulado no exercício (RREO Anexo 02). */
    liquidado: number | null;
    /** Receita Corrente arrecadada no exercício (RREO Anexo 01). */
    receitaCorrente: number | null;
    /** Receita Corrente arrecadada no exercício ANTERIOR (base do MF-15). */
    receitaCorrenteAnterior: number | null;
    /** empenhado ÷ RC bruta do exercício anterior × 100. */
    pctEmpenhoRcAnterior: number | null;
    /** empenhado ÷ RCL atual do RGF × 100. */
    pctEmpenhoRclAtual: number | null;
    /** liquidado ÷ RC arrecadada no exercício × 100. */
    pctLiquidacaoRc: number | null;
    /** Período de referência (ex.: "6º bim. 2025"). */
    periodo: string | null;
  };
  prazos: PrazoFiscal[];
  siconfi: { conectado: boolean; registros: number; erro: string | null };
  fonte: string;
  atualizadoEm: string;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/\./g, '').replace(',', '.'));
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Busca o RGF mais recente disponível no exercício, tentando do 3º período ao 1º. */
async function buscarRGFRecente(
  exercicio: number,
  poder: 'E' | 'L',
): Promise<{ items: Record<string, unknown>[]; periodo: number } | null> {
  let ultimoErro: unknown = null;
  let algumSucesso = false;
  for (const periodo of [3, 2, 1]) {
    try {
      const items = await getRGF({ exercicio, periodo, poder });
      algumSucesso = true;
      if (items.length > 0) return { items, periodo };
    } catch (err) {
      ultimoErro = err;
    }
  }
  // Só propaga erro se TODAS as tentativas falharam de fato. Se ao menos uma
  // respondeu (ainda que vazia), é "sem dados publicados", não indisponível.
  if (!algumSucesso && ultimoErro) throw ultimoErro;
  return null;
}

/** Busca um período específico do RGF; retorna null quando ainda não foi publicado. */
async function buscarRGFPeriodo(
  exercicio: number,
  poder: 'E' | 'L',
  periodo: number,
): Promise<{ items: Record<string, unknown>[]; periodo: number } | null> {
  try {
    const items = await getRGF({ exercicio, periodo, poder });
    return items.length > 0 ? { items, periodo } : null;
  } catch {
    return null;
  }
}

function quadrimestrePorBimestre(periodoRreo: number): number | null {
  if (periodoRreo >= 1 && periodoRreo <= 2) return 1;
  if (periodoRreo >= 3 && periodoRreo <= 4) return 2;
  if (periodoRreo >= 5 && periodoRreo <= 6) return 3;
  return null;
}

/**
 * Extrai um indicador-PERCENTUAL casando `conta` + um marcador que pode estar no
 * `conta` OU na `coluna`. É o ponto-chave: o SICONFI publica esses indicadores
 * (DTP/RCL, DCL/RCL, ASPS) com o `%` na COLUNA (ex.: coluna "% sobre a RCL
 * Ajustada"), não no `conta` — a versão antiga só olhava o `conta` e devolvia
 * null. Só aceita valor 0–100, o que descarta naturalmente as linhas de LIMITE
 * (54%/120% caem fora quando o valor já é > 100; as de 0–100 são desambiguadas
 * pela especificidade do `contaRe`).
 */
function extrairPctContaColuna(
  items: Record<string, unknown>[],
  contaRe: RegExp,
  marcadorRe: RegExp,
): number | null {
  for (const item of items) {
    const conta = String(item.conta ?? item.cod_conta ?? '').toUpperCase();
    if (!contaRe.test(conta)) continue;
    const col = String(item.coluna ?? '').toUpperCase();
    if (!marcadorRe.test(conta) && !marcadorRe.test(col)) continue;
    const valor = toNumber(item.valor);
    if (valor != null && valor >= 0 && valor <= 100) return valor;
  }
  return null;
}

/**
 * % de despesa total com pessoal (DTP) sobre a RCL — RGF Anexo 01. A linha é
 * `conta:"DESPESA TOTAL COM PESSOAL - DTP..."` com o `%` na `coluna:"% sobre a
 * RCL Ajustada"`. `contaRe` evita as linhas de LIMITE (que não trazem "DESPESA
 * TOTAL COM PESSOAL").
 */
function extrairPercentualPessoal(items: Record<string, unknown>[]): number | null {
  return extrairPctContaColuna(
    items,
    /DESPESA TOTAL COM PESSOAL/,
    /%\s*SOBRE A RCL|RCL AJUSTADA/,
  );
}

/**
 * Extrai o valor ABSOLUTO (R$) da RCL — a linha de "RECEITA CORRENTE LÍQUIDA"
 * na coluna de valor acumulado (não %). Útil para expor o denominador fiscal
 * principal que a UI precisa (ex.: "RCL 2025: R$ 2,3 bi").
 */
function extrairRcl(items: Record<string, unknown>[]): number | null {
  for (const item of items) {
    const c = String(item.conta ?? item.cod_conta ?? '').toUpperCase();
    if (!/RECEITA CORRENTE L[IÍ]QUIDA/.test(c)) continue;
    const col = String(item.coluna ?? '').toUpperCase();
    if (col.includes('%')) continue;
    // Prefere a coluna "Valor" (RCL absoluta), mas aceita qualquer coluna
    // de valor acumulado que não seja percentual.
    const v = toNumber(item.valor);
    if (v != null && v > 0) return v;
  }
  return null;
}

/** Procura a 1ª linha cujo `conta` casa todas as regexes e tem valor 0–100. */
function extrairLinhaPercentual(
  items: Record<string, unknown>[],
  ...regexes: RegExp[]
): number | null {
  for (const item of items) {
    const conta = String(item.conta ?? item.cod_conta ?? '').toUpperCase();
    if (!regexes.every((r) => r.test(conta))) continue;
    const valor = toNumber(item.valor);
    if (valor != null && valor >= 0 && valor <= 100) return valor;
  }
  return null;
}

/** Busca o RREO mais recente disponível no exercício (do 6º bimestre ao 1º). */
async function buscarRREORecente(
  exercicio: number,
): Promise<{ items: Record<string, unknown>[]; periodo: number }> {
  let ultimoErro: unknown = null;
  let algumSucesso = false;
  for (const periodo of [6, 5, 4, 3, 2, 1]) {
    try {
      const items = await getRREO({ exercicio, periodo });
      algumSucesso = true;
      if (items.length > 0) return { items, periodo };
    } catch (err) {
      ultimoErro = err;
    }
  }
  // Só propaga se TODAS as tentativas falharam — assim a rota distingue
  // "sem dados publicados" de "fonte indisponível".
  if (!algumSucesso && ultimoErro) throw ultimoErro;
  return { items: [], periodo: 0 };
}

/**
 * Busca o RREO Anexo específico mais recente (do 6º bimestre ao 1º).
 * Útil para MF-15/16 que precisam de Anexo 01 e 02 separados.
 */
async function buscarRREOAnexoRecente(
  exercicio: number,
  anexo: string,
): Promise<{ items: Record<string, unknown>[]; periodo: number }> {
  let ultimoErro: unknown = null;
  let algumSucesso = false;
  for (const periodo of [6, 5, 4, 3, 2, 1]) {
    try {
      const items = await getRREO({ exercicio, periodo, anexo });
      algumSucesso = true;
      if (items.length > 0) return { items, periodo };
    } catch (err) {
      ultimoErro = err;
    }
  }
  if (!algumSucesso && ultimoErro) throw ultimoErro;
  return { items: [], periodo: 0 };
}

/** Estima se `exercicio` é ano de eleição municipal (a cada 4 anos a partir de 2024). */
function ehAnoEleitoralMunicipal(exercicio: number): boolean {
  return (exercicio - 2024) % 4 === 0;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const { searchParams } = new URL(req.url);
  const exercicio = Number(searchParams.get('exercicio')) || new Date().getFullYear();

  let registros = 0;
  let erro: string | null = null;
  const valores = new Map<string, { valor: number; periodo: string }>();
  const alertasFiscais: AlertaDetectado[] = [];
  const detectoresApurados: string[] = [];
  const semDado: { id: string; motivo: string }[] = [];

  // RGF — pessoal, dívida e (Anexo 05) restos a pagar / disponibilidade de caixa.
  let rgfExecItems: Record<string, unknown>[] = [];
  let rgfExecPeriodo: string | null = null;
  let rclValor: number | null = null;
  let rclPeriodo: string | null = null;
  try {
    const [rgfExec, rgfLeg] = await Promise.all([
      buscarRGFRecente(exercicio, 'E'),
      buscarRGFRecente(exercicio, 'L'),
    ]);

    if (rgfExec) {
      registros += rgfExec.items.length;
      rgfExecItems = rgfExec.items;
      rgfExecPeriodo = `${rgfExec.periodo}º quad.`;
      const pct = extrairPercentualPessoal(rgfExec.items);
      if (pct != null) {
        valores.set('pessoal_executivo', { valor: pct, periodo: `${rgfExec.periodo}º quad.` });
      }
      // Dívida — a linha é `conta:"% da DCL sobre a RCL AJUSTADA"` (SICONFI usa a
      // SIGLA "DCL", não "DÍVIDA CONSOLIDADA"). Prefere a RCL AJUSTADA (base do
      // limite do Senado); cai na genérica se faltar. O limite 120% cai fora (>100).
      const divida =
        extrairPctContaColuna(rgfExec.items, /DCL SOBRE A RCL AJUSTADA/, /RCL/) ??
        extrairPctContaColuna(rgfExec.items, /%\s*DA DCL SOBRE A RCL|DCL SOBRE A RCL/, /RCL/);
      if (divida != null) {
        valores.set('divida', { valor: divida, periodo: `${rgfExec.periodo}º quad.` });
      }
      // RCL (valor absoluto) — linha "RECEITA CORRENTE LÍQUIDA" do RGF.
      const rcl = extrairRcl(rgfExec.items);
      if (rcl != null) {
        rclValor = rcl;
        rclPeriodo = `${rgfExec.periodo}º quad.`;
      }
    }
    if (rgfLeg) {
      registros += rgfLeg.items.length;
      const pct = extrairPercentualPessoal(rgfLeg.items);
      if (pct != null) {
        valores.set('pessoal_legislativo', { valor: pct, periodo: `${rgfLeg.periodo}º quad.` });
      }
    }
  } catch (err) {
    erro = err instanceof Error ? err.message : 'erro desconhecido';
  }

  // RREO — saúde, educação e FUNDEB (extração best-effort) + base dos
  // detectores MF-09/13/14.
  let rreoItems: Record<string, unknown>[] = [];
  let rreoPeriodo: string | null = null;
  try {
    const rreo = await buscarRREORecente(exercicio);
    rreoItems = rreo.items;
    rreoPeriodo = rreo.periodo > 0 ? `${rreo.periodo}º bim.` : null;
    if (rreo.items.length > 0) {
      registros += rreo.items.length;
      // Saúde (ASPS) — o % aplicado costuma vir na COLUNA. Prefere a linha do %
      // APLICADO (evita pegar a linha de "% mínimo 15%"); só cai no marcador
      // genérico se não achar a aplicada.
      const saude =
        extrairPctContaColuna(rreo.items, /SA[ÚU]DE|ASPS/, /APLICAD/) ??
        extrairPctContaColuna(rreo.items, /SA[ÚU]DE|ASPS/, /M[ÍI]NIMO|%/);
      if (saude != null) valores.set('saude', { valor: saude, periodo: 'RREO' });
      const educ = extrairLinhaPercentual(rreo.items, /ENSINO|EDUCA/, /APLICAD|M[ÍI]NIMO|%/);
      if (educ != null) valores.set('educacao', { valor: educ, periodo: 'RREO' });
      const fundeb = extrairLinhaPercentual(rreo.items, /FUNDEB/, /MAGIST|PROFISS/);
      if (fundeb != null) valores.set('fundeb', { valor: fundeb, periodo: 'RREO' });
    }
  } catch (err) {
    if (!erro) erro = err instanceof Error ? err.message : 'erro RREO';
  }

  // ── MF-09 — Restos a pagar sem cobertura de caixa (LRF art. 42) ────────────
  {
    const rap = apurarRestosAPagar(rgfExecItems, rreoItems, rgfExecPeriodo ?? rreoPeriodo);
    if (rap.rapInscritos != null && rap.disponibilidadeCaixa != null) {
      detectoresApurados.push('MF-09');
      const deficit = rap.rapInscritos - rap.disponibilidadeCaixa;
      if (deficit > 0) {
        const cobertura =
          rap.rapInscritos > 0
            ? (rap.disponibilidadeCaixa / rap.rapInscritos) * 100
            : 100;
        alertasFiscais.push({
          detectorId: 'MF-09',
          detectorNome: 'Restos a pagar sem cobertura de caixa',
          categoria: 'Metas fiscais e LRF',
          titulo: 'Restos a pagar acima da disponibilidade de caixa',
          descricao:
            `Os restos a pagar (${brl(rap.rapInscritos)}) superam a ` +
            `disponibilidade de caixa líquida (${brl(rap.disponibilidadeCaixa)}) ` +
            `no ${rap.periodo ?? 'período apurado'} — déficit de ${brl(deficit)}. ` +
            'Indício de assunção de obrigação sem lastro financeiro.',
          sujeitoTipo: 'orgao',
          sujeitoId: `${exercicio}_MF-09`,
          sujeitoRotulo: `Marília — execução fiscal ${exercicio}`,
          classificacao: cobertura < 50 ? 'critico' : 'suspeita',
          scores: {
            confiabilidade: 60,
            probabilidadeIrregularidade: Math.min(
              85,
              Math.round(45 + (100 - cobertura) * 0.4),
            ),
          },
          fundamentoLegal: ['LRF (LC 101/2000), art. 42'],
          evidencias: [
            { resumo: 'Restos a pagar inscritos/saldo', valor: rap.rapInscritos },
            { resumo: 'Disponibilidade de caixa líquida', valor: rap.disponibilidadeCaixa },
            { resumo: `Déficit de cobertura`, valor: deficit },
            { resumo: `Cobertura: ${cobertura.toFixed(1)}% dos RAP`, ref: rap.periodo ?? undefined },
          ],
          explicacao:
            'O art. 42 da LRF veda contrair obrigação que não possa ser cumprida ' +
            'dentro do exercício, ou que tenha parcelas a pagar no seguinte sem ' +
            'disponibilidade de caixa. Quando os restos a pagar superam o caixa ' +
            'líquido, há indício de descumprimento. A apuração aqui é do agregado ' +
            'publicado pelo SICONFI — a verificação fonte-a-fonte exige o anexo ' +
            'detalhado. Indício a apurar, não acusação.',
          valorEnvolvido: deficit,
        });
      }
    } else {
      semDado.push({
        id: 'MF-09',
        motivo:
          'SICONFI não retornou, de forma extraível, os restos a pagar e/ou a ' +
          'disponibilidade de caixa líquida (RGF Anexo 05 / RREO Anexo 07).',
      });
    }

    // ── MF-10 — Restos a pagar antigos sem baixa ────────────────────────────
    if (rap.rapAnteriores != null) {
      detectoresApurados.push('MF-10');
      if (rap.rapAnteriores > 0) {
        alertasFiscais.push({
          detectorId: 'MF-10',
          detectorNome: 'Restos a pagar antigos sem baixa',
          categoria: 'Metas fiscais e LRF',
          titulo: 'Restos a pagar de exercícios anteriores em aberto',
          descricao:
            `Há ${brl(rap.rapAnteriores)} em restos a pagar de exercícios ` +
            'anteriores ainda registrados sem baixa/pagamento. RAP arrastados ' +
            'por anos comprometem o caixa e podem mascarar despesa sem lastro.',
          sujeitoTipo: 'orgao',
          sujeitoId: `${exercicio}_MF-10`,
          sujeitoRotulo: `Marília — restos a pagar ${exercicio}`,
          classificacao: 'atencao',
          scores: { confiabilidade: 55, probabilidadeIrregularidade: 38 },
          fundamentoLegal: ['LRF (LC 101/2000), art. 42', 'Lei 4.320/1964, art. 36'],
          evidencias: [
            {
              resumo: 'Restos a pagar de exercícios anteriores em aberto',
              valor: rap.rapAnteriores,
              ref: rap.periodo ?? undefined,
            },
          ],
          explicacao:
            'Restos a pagar de exercícios anteriores que permanecem sem baixa ' +
            'indicam obrigações antigas não liquidadas — pode ser pendência ' +
            'legítima ou despesa irregular nunca cancelada. O SICONFI publica o ' +
            'saldo agregado de RAP de exercícios anteriores, mas não a data de ' +
            'inscrição linha-a-linha; o corte exato ">2 anos" exige o anexo ' +
            'detalhado do ente. Indício a apurar.',
          valorEnvolvido: rap.rapAnteriores,
        });
      }
    } else {
      semDado.push({
        id: 'MF-10',
        motivo:
          'O SICONFI não publica a coluna de restos a pagar de exercícios ' +
          'anteriores de forma extraível neste anexo; a antiguidade linha-a-linha ' +
          '(>2 anos) depende do anexo detalhado de RAP do ente.',
      });
    }
  }

  // ── MF-12 — Indicador fiscal em tendência de piora ────────────────────────
  // Série histórica do % de despesa com pessoal do Executivo nos 3 exercícios
  // anteriores + o atual. Detecta piora monotônica rumo ao teto da LRF.
  try {
    const anosSerie = [exercicio - 3, exercicio - 2, exercicio - 1, exercicio];
    const serie: { ano: number; valor: number }[] = [];
    for (const ano of anosSerie) {
      // Reaproveita o RGF já carregado para o exercício corrente.
      if (ano === exercicio) {
        const atual = valores.get('pessoal_executivo');
        if (atual) serie.push({ ano, valor: atual.valor });
        continue;
      }
      try {
        const r = await buscarRGFRecente(ano, 'E');
        if (r) {
          const pct = extrairPercentualPessoal(r.items);
          if (pct != null) serie.push({ ano, valor: pct });
        }
      } catch {
        // Ano sem dado — ignora; a série segue com o que houver.
      }
    }

    if (serie.length >= 3) {
      detectoresApurados.push('MF-12');
      // Piora monotônica = cada ponto >= anterior, com ao menos uma alta real.
      let pioraMonotonica = true;
      let subiuAlgumaVez = false;
      for (let i = 1; i < serie.length; i++) {
        if (serie[i].valor < serie[i - 1].valor - 0.01) pioraMonotonica = false;
        if (serie[i].valor > serie[i - 1].valor + 0.01) subiuAlgumaVez = true;
      }
      const primeiro = serie[0];
      const ultimo = serie[serie.length - 1];
      const variacao = ultimo.valor - primeiro.valor;
      if (pioraMonotonica && subiuAlgumaVez && variacao > 0) {
        alertasFiscais.push({
          detectorId: 'MF-12',
          detectorNome: 'Indicador fiscal em tendência de piora',
          categoria: 'Metas fiscais e LRF',
          titulo: 'Despesa com pessoal do Executivo em piora contínua',
          descricao:
            `O percentual de despesa com pessoal do Executivo sobre a RCL subiu ` +
            `de ${primeiro.valor.toFixed(1)}% (${primeiro.ano}) para ` +
            `${ultimo.valor.toFixed(1)}% (${ultimo.ano}) — alta monotônica em ` +
            `${serie.length} períodos consecutivos, +${variacao.toFixed(1)} p.p.`,
          sujeitoTipo: 'orgao',
          sujeitoId: `${exercicio}_MF-12`,
          sujeitoRotulo: `Marília — tendência fiscal ${exercicio}`,
          classificacao: ultimo.valor >= 48.6 ? 'suspeita' : 'atencao',
          scores: {
            confiabilidade: 70,
            probabilidadeIrregularidade: Math.min(
              75,
              Math.round(35 + variacao * 6),
            ),
          },
          fundamentoLegal: ['LRF (LC 101/2000), art. 59', 'LRF, art. 19–20'],
          evidencias: serie.map((p) => ({
            resumo: `Pessoal/RCL em ${p.ano}: ${p.valor.toFixed(1)}%`,
            valor: p.valor,
          })),
          explicacao:
            'O art. 59 da LRF incumbe o controle de fiscalizar a tendência dos ' +
            'indicadores fiscais. Uma série que só piora, ano após ano, sinaliza ' +
            'rota de colisão com o teto legal mesmo que o limite ainda não tenha ' +
            'sido ultrapassado. O indício é a TENDÊNCIA — não há, por si, ' +
            'irregularidade. A série usa o RGF de cada exercício; anos sem ' +
            'publicação no SICONFI ficam de fora.',
          valorEnvolvido: 0,
        });
      }
    } else {
      semDado.push({
        id: 'MF-12',
        motivo:
          'Série histórica insuficiente: o SICONFI retornou o % de pessoal/RCL ' +
          'do RGF em menos de 3 exercícios — sem base para tendência.',
      });
    }
  } catch (err) {
    semDado.push({
      id: 'MF-12',
      motivo: `Falha ao montar a série histórica do RGF: ${
        err instanceof Error ? err.message : 'erro desconhecido'
      }.`,
    });
  }

  // ── MF-13 — Queda de investimento social em ano eleitoral ─────────────────
  // Compara a despesa nas funções Saúde+Educação do exercício com a do
  // exercício anterior. Só gera alerta quando `exercicio` é ano de eleição
  // municipal — fora disso o detector é informado como "não aplicável".
  if (!ehAnoEleitoralMunicipal(exercicio)) {
    semDado.push({
      id: 'MF-13',
      motivo: `${exercicio} não é ano de eleição municipal — detector não aplicável neste exercício.`,
    });
  } else {
    try {
      const rreoAnterior = await buscarRREORecente(exercicio - 1);
      const saudeAtual = apurarDespesaFuncao(rreoItems, /SA[ÚU]DE/);
      const educAtual = apurarDespesaFuncao(rreoItems, /EDUCA/);
      const saudeAnt = apurarDespesaFuncao(rreoAnterior.items, /SA[ÚU]DE/);
      const educAnt = apurarDespesaFuncao(rreoAnterior.items, /EDUCA/);

      const investAtual =
        saudeAtual != null || educAtual != null
          ? (saudeAtual ?? 0) + (educAtual ?? 0)
          : null;
      const investAnt =
        saudeAnt != null || educAnt != null
          ? (saudeAnt ?? 0) + (educAnt ?? 0)
          : null;

      if (investAtual != null && investAnt != null && investAnt > 0) {
        detectoresApurados.push('MF-13');
        const queda = ((investAnt - investAtual) / investAnt) * 100;
        if (queda > 10) {
          alertasFiscais.push({
            detectorId: 'MF-13',
            detectorNome: 'Queda de investimento social em ano eleitoral',
            categoria: 'Metas fiscais e LRF',
            titulo: 'Investimento em saúde e educação cai em ano eleitoral',
            descricao:
              `A despesa nas funções Saúde e Educação caiu ${queda.toFixed(1)}% ` +
              `de ${exercicio - 1} (${brl(investAnt)}) para ${exercicio} ` +
              `(${brl(investAtual)}), em ano de eleição municipal.`,
            sujeitoTipo: 'orgao',
            sujeitoId: `${exercicio}_MF-13`,
            sujeitoRotulo: `Marília — investimento social ${exercicio}`,
            classificacao: queda > 20 ? 'suspeita' : 'atencao',
            scores: {
              confiabilidade: 58,
              probabilidadeIrregularidade: Math.min(70, Math.round(30 + queda)),
            },
            fundamentoLegal: ['LC 141/2012', 'CF, art. 212', 'Lei 9.504/1997, art. 73'],
            evidencias: [
              { resumo: `Saúde+Educação em ${exercicio - 1}`, valor: investAnt },
              { resumo: `Saúde+Educação em ${exercicio}`, valor: investAtual },
              { resumo: `Queda de ${queda.toFixed(1)}%` },
            ],
            explicacao:
              'Queda expressiva do gasto em saúde/educação no ano da eleição ' +
              'pode indicar realocação de recursos para despesas de maior ' +
              'visibilidade eleitoral, em prejuízo de serviços essenciais. O ' +
              'proxy é a despesa por função do RREO Anexo 02 (funções 10 e 12) — ' +
              'não o conceito contábil estrito de "investimento". Indício a ' +
              'apurar, sobretudo se a queda não tiver causa orçamentária clara.',
            valorEnvolvido: investAnt - investAtual,
          });
        }
      } else {
        semDado.push({
          id: 'MF-13',
          motivo:
            'SICONFI não retornou a despesa por função (Saúde/Educação) de forma ' +
            'extraível em um dos dois exercícios comparados (RREO Anexo 02).',
        });
      }
    } catch (err) {
      semDado.push({
        id: 'MF-13',
        motivo: `Falha ao comparar investimento social entre exercícios: ${
          err instanceof Error ? err.message : 'erro desconhecido'
        }.`,
      });
    }
  }

  // ── MF-14 — Arrecadação abaixo do previsto ────────────────────────────────
  {
    const arr = apurarArrecadacao(rreoItems, rreoPeriodo);
    if (arr.percentual != null) {
      detectoresApurados.push('MF-14');
      if (arr.percentual < 90) {
        const deficit = (arr.receitaPrevista ?? 0) - (arr.receitaRealizada ?? 0);
        alertasFiscais.push({
          detectorId: 'MF-14',
          detectorNome: 'Arrecadação abaixo do previsto',
          categoria: 'Metas fiscais e LRF',
          titulo: 'Receita realizada abaixo da previsão da LOA',
          descricao:
            `A receita realizada (${brl(arr.receitaRealizada ?? 0)}) atingiu ` +
            `${arr.percentual.toFixed(1)}% da previsão atualizada ` +
            `(${brl(arr.receitaPrevista ?? 0)}) no ${arr.periodo ?? 'período apurado'}. ` +
            'Arrecadação muito abaixo do previsto força contingenciamento.',
          sujeitoTipo: 'orgao',
          sujeitoId: `${exercicio}_MF-14`,
          sujeitoRotulo: `Marília — execução da receita ${exercicio}`,
          classificacao: arr.percentual < 75 ? 'suspeita' : 'atencao',
          scores: {
            confiabilidade: 56,
            probabilidadeIrregularidade: Math.min(
              72,
              Math.round(30 + (90 - arr.percentual) * 1.5),
            ),
          },
          fundamentoLegal: ['LRF (LC 101/2000), art. 9º', 'LRF, art. 59 §1º I'],
          evidencias: [
            { resumo: 'Receita prevista (atualizada)', valor: arr.receitaPrevista ?? 0 },
            { resumo: 'Receita realizada', valor: arr.receitaRealizada ?? 0 },
            { resumo: `Realizado: ${arr.percentual.toFixed(1)}% do previsto` },
            { resumo: 'Frustração de receita', valor: deficit },
          ],
          explicacao:
            'Quando a receita não se realiza conforme a previsão da LOA, o art. ' +
            '9º da LRF obriga a limitação de empenho e movimentação financeira. ' +
            'Receita muito abaixo do previsto sinaliza previsão superestimada ' +
            '(orçamento "inflado") ou queda real de arrecadação a investigar. ' +
            'O RREO é acumulado e bimestral — comparar com a previsão ANUAL nos ' +
            'primeiros bimestres subestima o percentual; o período apurado é ' +
            'sempre citado. Indício a apurar.',
          valorEnvolvido: deficit,
        });
      }
    } else {
      semDado.push({
        id: 'MF-14',
        motivo:
          'SICONFI não retornou a receita prevista e/ou realizada de forma ' +
          'extraível (RREO Anexo 01 — Balanço Orçamentário).',
      });
    }
  }

  // Execução consolidada estruturada — preenchida pelos blocos MF-15/MF-16
  // abaixo, SEMPRE que apurada (não só quando estoura 100%).
  const execucao: MetasFiscaisResponse['execucao'] = {
    empenhado: null,
    liquidado: null,
    receitaCorrente: null,
    receitaCorrenteAnterior: null,
    pctEmpenhoRcAnterior: null,
    pctEmpenhoRclAtual: null,
    pctLiquidacaoRc: null,
    periodo: null,
  };

  // ── MF-15 — Empenho total acima da RC do exercício anterior ───────────────
  // Compara o total empenhado do exercício atual contra a Receita Corrente
  // arrecadada no exercício anterior e expõe, quando houver RGF publicado,
  // a RCL oficial atual e a RCL oficial do mesmo período do ano anterior.
  // Alerta: empenhado ≥ 95 % da RC anterior; crítico: ≥ 100 %.
  try {
    const anoAnterior = exercicio - 1;
    const [rreoAnexo02Atual, rreoAnexo01Anterior] = await Promise.all([
      buscarRREOAnexoRecente(exercicio, 'RREO-Anexo 02'),
      buscarRREOAnexoRecente(anoAnterior, 'RREO-Anexo 01'),
    ]);
    const quadrimestreReferencia = quadrimestrePorBimestre(rreoAnexo02Atual.periodo);
    const [rgfAtual, rgfAnteriorMesmoPeriodo] = quadrimestreReferencia
      ? await Promise.all([
          buscarRGFPeriodo(exercicio, 'E', quadrimestreReferencia),
          buscarRGFPeriodo(anoAnterior, 'E', quadrimestreReferencia),
        ])
      : [null, null];

    const mf15 = apurarEmpenhoVsRCL(
      rreoAnexo02Atual.items,
      rreoAnexo01Anterior.items,
      anoAnterior,
      rreoAnexo02Atual.periodo > 0 ? `${rreoAnexo02Atual.periodo}º bim. ${exercicio}` : null,
    );

    const rclAtual = rgfAtual ? extrairRcl(rgfAtual.items) : null;
    const rclAnteriorMesmoPeriodo = rgfAnteriorMesmoPeriodo
      ? extrairRcl(rgfAnteriorMesmoPeriodo.items)
      : null;
    const pctRclAtual =
      rclAtual != null && rclAtual > 0 && mf15.empenhado != null
        ? (mf15.empenhado / rclAtual) * 100
        : null;
    const pctRclAnteriorMesmoPeriodo =
      rclAnteriorMesmoPeriodo != null && rclAnteriorMesmoPeriodo > 0 && mf15.empenhado != null
        ? (mf15.empenhado / rclAnteriorMesmoPeriodo) * 100
        : null;

    execucao.empenhado = mf15.empenhado;
    execucao.receitaCorrenteAnterior = mf15.receitaCorrenteAnterior;
    execucao.pctEmpenhoRcAnterior = mf15.percentual;
    execucao.pctEmpenhoRclAtual = pctRclAtual;
    execucao.periodo = mf15.periodo ?? execucao.periodo;

    if (mf15.percentual != null) {
      detectoresApurados.push('MF-15');
      if (mf15.percentual > 100) {
        const excesso = (mf15.empenhado ?? 0) - (mf15.receitaCorrenteAnterior ?? 0);
        const tituloRcl =
          pctRclAtual != null
            ? ` | ${pctRclAtual.toFixed(1)}% da RCL atual`
            : pctRclAnteriorMesmoPeriodo != null
              ? ` | ${pctRclAnteriorMesmoPeriodo.toFixed(1)}% da RCL do mesmo período de ${anoAnterior}`
              : '';
        alertasFiscais.push({
          detectorId: 'MF-15',
          detectorNome: 'Empenho total acima da RCL do exercício anterior',
          categoria: 'Metas fiscais e LRF',
          titulo: `Empenhos: ${mf15.percentual.toFixed(1)}% da RC Bruta de ${mf15.anoRCL}${tituloRcl}`,
          descricao:
            `O total empenhado em ${exercicio} (${brl(mf15.empenhado ?? 0)}) ` +
            `corresponde a ${mf15.percentual.toFixed(1)}% da Receita Corrente Bruta ` +
            `arrecadada em ${mf15.anoRCL} (${brl(mf15.receitaCorrenteAnterior ?? 0)}). ` +
            (pctRclAtual != null
              ? `Pelo RGF, isso equivale a ${pctRclAtual.toFixed(1)}% da RCL atual`
              : 'A RCL atual não foi localizada no RGF publicado para o mesmo recorte') +
            (pctRclAnteriorMesmoPeriodo != null
              ? ` e a ${pctRclAnteriorMesmoPeriodo.toFixed(1)}% da RCL do mesmo período de ${anoAnterior}`
              : '') +
            '. ' +
            `O empenho excede em ${brl(excesso)} toda a receita corrente do exercício anterior — ` +
            'indício de comprometimento fiscal severo a apurar.',
          sujeitoTipo: 'orgao',
          sujeitoId: `${exercicio}_MF-15`,
          sujeitoRotulo: `Marília — execução orçamentária ${exercicio}`,
          classificacao: 'critico',
          scores: {
            confiabilidade: 72,
            probabilidadeIrregularidade: Math.min(
              95,
              Math.round(70 + (mf15.percentual - 100) * 2),
            ),
          },
          fundamentoLegal: [
            'LRF (LC 101/2000), art. 9º',
            'LRF, art. 59 §1º I',
            'Lei 4.320/1964, art. 59',
          ],
          evidencias: [
            {
              resumo: `Empenhado em ${exercicio} (${mf15.periodo ?? 'acumulado'})`,
              valor: mf15.empenhado ?? 0,
            },
            {
              resumo: `Receita Corrente Bruta arrecadada em ${mf15.anoRCL}`,
              valor: mf15.receitaCorrenteAnterior ?? 0,
            },
            {
              resumo: `Percentual sobre RC Bruta: ${mf15.percentual.toFixed(1)}%`,
            },
            ...(rclAtual != null
              ? [
                  { resumo: `RCL atual (RGF ${exercicio})`, valor: rclAtual },
                  { resumo: `Percentual sobre RCL atual: ${pctRclAtual?.toFixed(1)}%` },
                ]
              : []),
            ...(rclAnteriorMesmoPeriodo != null
              ? [
                  {
                    resumo: `RCL do mesmo período de ${anoAnterior} (RGF)`,
                    valor: rclAnteriorMesmoPeriodo,
                  },
                  {
                    resumo: `Percentual sobre a RCL do mesmo período de ${anoAnterior}: ${pctRclAnteriorMesmoPeriodo?.toFixed(1)}%`,
                  },
                ]
              : []),
            ...(excesso > 0 ? [{ resumo: 'Excesso sobre a RC anterior', valor: excesso }] : []),
          ],
          explicacao:
            'Quando os empenhos de um exercício superam a Receita Corrente do ' +
            'exercício anterior, o município comprometeu mais recursos do que ' +
            'historicamente arrecada — indício de orçamento superestimado ou ' +
            'de comprometimento fiscal que pode gerar RAP e desequilíbrio. ' +
            'O alerta preserva a comparação com a Receita Corrente Bruta do ano ' +
            'anterior, mas também expõe a RCL oficial do RGF atual e a RCL ' +
            'oficial do mesmo período do ano anterior, quando publicadas. ' +
            'Indício a apurar pelas instituições de controle.',
          valorEnvolvido: Math.max(0, excesso),
        });
      }
    } else {
      semDado.push({
        id: 'MF-15',
        motivo:
          'SICONFI não retornou o total empenhado (RREO Anexo 02) e/ou a ' +
          'Receita Corrente do exercício anterior (RREO Anexo 01) de forma extraível.',
      });
    }
  } catch (err) {
    semDado.push({
      id: 'MF-15',
      motivo: `Falha ao buscar RREO para MF-15: ${
        err instanceof Error ? err.message : 'erro desconhecido'
      }.`,
    });
  }

  // ── MF-16 — Liquidação total acima da receita corrente do exercício ────────
  // Sinaliza quando o total liquidado no exercício supera a receita corrente
  // arrecadada no mesmo período — o município liquidou mais do que arrecadou.
  // Alerta: liquidado ≥ 95 % da RC; crítico: ≥ 100 %.
  try {
    const [rreoAnexo01Atual, rreoAnexo02Atual2] = await Promise.all([
      buscarRREOAnexoRecente(exercicio, 'RREO-Anexo 01'),
      buscarRREOAnexoRecente(exercicio, 'RREO-Anexo 02'),
    ]);

    const periodo16 =
      rreoAnexo02Atual2.periodo > 0
        ? `${rreoAnexo02Atual2.periodo}º bim. ${exercicio}`
        : null;

    const mf16 = apurarLiquidacaoVsReceita(
      rreoAnexo01Atual.items,
      rreoAnexo02Atual2.items,
      periodo16,
    );

    execucao.liquidado = mf16.liquidado;
    execucao.receitaCorrente = mf16.receitaCorrente;
    execucao.pctLiquidacaoRc = mf16.percentual;
    execucao.periodo = mf16.periodo ?? execucao.periodo;

    if (mf16.percentual != null) {
      detectoresApurados.push('MF-16');
      if (mf16.percentual > 100) {
        const excesso16 = (mf16.liquidado ?? 0) - (mf16.receitaCorrente ?? 0);
        alertasFiscais.push({
          detectorId: 'MF-16',
          detectorNome: 'Liquidação total acima da receita corrente',
          categoria: 'Metas fiscais e LRF',
          titulo: `Liquidações: ${mf16.percentual.toFixed(1)}% da receita corrente bruta (acima de 100%)`,
          descricao:
            `O total liquidado em ${exercicio} (${brl(mf16.liquidado ?? 0)}) ` +
            `corresponde a ${mf16.percentual.toFixed(1)}% da Receita Corrente ` +
            `arrecadada no mesmo período (${brl(mf16.receitaCorrente ?? 0)}). ` +
            `O município liquidou ${brl(excesso16)} a mais do que arrecadou — ` +
            'a diferença é financiada por caixa anterior, crédito ou gera RAP.',
          sujeitoTipo: 'orgao',
          sujeitoId: `${exercicio}_MF-16`,
          sujeitoRotulo: `Marília — liquidação fiscal ${exercicio}`,
          classificacao: 'critico',
          scores: {
            confiabilidade: 74,
            probabilidadeIrregularidade: Math.min(
              95,
              Math.round(70 + (mf16.percentual - 100) * 2),
            ),
          },
          fundamentoLegal: [
            'LRF (LC 101/2000), art. 42',
            'LRF, art. 9º',
            'Lei 4.320/1964, art. 63',
          ],
          evidencias: [
            {
              resumo: `Liquidado em ${exercicio} (${mf16.periodo ?? 'acumulado'})`,
              valor: mf16.liquidado ?? 0,
            },
            {
              resumo: 'Receita Corrente Bruta arrecadada no período',
              valor: mf16.receitaCorrente ?? 0,
            },
            { resumo: `Percentual sobre RC Bruta: ${mf16.percentual.toFixed(1)}%` },
            ...(excesso16 > 0
              ? [{ resumo: `Liquidado acima da receita corrente (${mf16.percentual.toFixed(1)}%)`, valor: excesso16 }]
              : []),
          ],
          explicacao:
            'Quando o total liquidado supera a receita corrente arrecadada no ' +
            'mesmo período, o município comprometeu mais do que arrecadou — a ' +
            'diferença precisa ser coberta por caixa de exercícios anteriores, ' +
            'operações de crédito ou resulta em Restos a Pagar. É indício de ' +
            'desequilíbrio fiscal a apurar pelas instituições de controle ' +
            '(TCE-SP, Ministério Público, Controladoria). Indício a apurar, ' +
            'não acusação.',
          valorEnvolvido: Math.max(0, excesso16),
        });
      }
    } else {
      semDado.push({
        id: 'MF-16',
        motivo:
          'SICONFI não retornou o total liquidado (RREO Anexo 02) e/ou a ' +
          'Receita Corrente do exercício (RREO Anexo 01) de forma extraível.',
      });
    }
  } catch (err) {
    semDado.push({
      id: 'MF-16',
      motivo: `Falha ao buscar RREO para MF-16: ${
        err instanceof Error ? err.message : 'erro desconhecido'
      }.`,
    });
  }

  const indicadores: IndicadorApurado[] = INDICADORES_FISCAIS.map((def) => {
    const apurado = valores.get(def.chave) ?? null;
    const valor = apurado?.valor ?? null;
    return {
      chave: def.chave,
      rotulo: def.rotulo,
      limite: def.limite,
      sentido: def.sentido,
      fundamento: def.fundamento,
      descricao: def.descricao,
      valor,
      situacao: situacaoIndicador(def, valor),
      periodoApurado: apurado?.periodo ?? null,
    };
  });

  alertasFiscais.sort(
    (a, b) =>
      b.scores.probabilidadeIrregularidade - a.scores.probabilidadeIrregularidade,
  );

  const response: MetasFiscaisResponse = {
    exercicio,
    indicadores,
    alertasFiscais,
    cobertura: { detectoresApurados, semDado },
    rcl: rclValor != null ? { valor: rclValor, periodo: rclPeriodo } : null,
    execucao,
    prazos: calcularPrazosFiscais(exercicio),
    siconfi: { conectado: erro == null, registros, erro },
    fonte: 'SICONFI/STN — Tesouro Nacional (IBGE 3529005 · Marília/SP)',
    atualizadoEm: new Date().toISOString(),
  };

  // Quando a coleta SICONFI falhou (parcial ou total), a resposta é um estado
  // degradado — não cachear como se fosse a apuração estável do exercício.
  return NextResponse.json(response, {
    headers: { 'Cache-Control': erro ? 'no-store' : 'private, max-age=900' },
  });
}
