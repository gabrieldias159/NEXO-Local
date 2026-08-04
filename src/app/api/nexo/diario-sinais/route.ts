/**
 * GET /api/nexo/diario-sinais?exercicio=2026
 *
 * Subsistema SINAIS DO DIÁRIO OFICIAL do NEXO. Coleta as edições do Diário
 * Oficial de Marília (DOM) via API de dados-abertos da Prefeitura e roda os
 * detectores do catálogo §11:
 *   - Metadados da edição:
 *       DO-01 — edição publicada em fim de semana / feriado nacional fixo
 *       DO-03 — volume anormal de atos numa edição (proxy estatístico)
 *   - Parsing do texto integral dos atos:
 *       DO-02 — decreto de crédito sem amparo legal citado
 *       DO-04 — republicação/retificação de ato sensível
 *       DO-05 — extrato de contrato sem dados essenciais
 *       DO-06 — composição de comissão de licitação (mapeamento)
 *       DO-07 — fiscal de contrato (mapeamento)
 *       DO-08 — sindicância/PAD aberto
 *
 * Acesso restrito ao NEXO — `verificarSessao` (401 sem token / 403 sem perfil
 * ativo / 502 verificador indisponível). Resposta com Cache-Control private.
 */
import { NextResponse } from 'next/server';
import {
  coletarEdicoesDiario,
  coletarTextosDiario,
  type EdicaoDiarioNorm,
} from '@/lib/nexo/sources/diario';
import {
  analisarDiario,
  analisarAtosDiario,
  DETECTORES_DO_ATO,
} from '@/lib/nexo/detectores/diario-det';
import type { AlertaDetectado } from '@/lib/nexo/detectores/tipos';
import { verificarSessao } from '@/lib/nexo/auth-server';

export const runtime = 'nodejs';
export const revalidate = 1800;
export const maxDuration = 60;

export interface DiarioSinaisResponse {
  exercicio: number;
  coleta: {
    edicoes: number;
    anosConsultados: number[];
    amostra: boolean;
    /** Erro da coleta de metadados das edições. */
    erro: string | null;
    /** Erro da coleta do texto integral (base dos detectores de ato DO-02..08). */
    erroTexto: string | null;
  };
  resumo: {
    totalEdicoes: number;
    edicoesExtras: number;
    edicoesFimDeSemana: number;
    alertas: number;
    detectoresImplementados: string[];
    detectoresPendentes: { id: string; nome: string }[];
  };
  alertas: AlertaDetectado[];
  /** Edições recentes (metadados) — contexto para a página war-room. */
  edicoes: EdicaoDiarioNorm[];
  atualizadoEm: string;
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
  const exercicio =
    Number(searchParams.get('exercicio')) || new Date().getFullYear();

  // Coleta de metadados (inclui o ano anterior como base estatística do DO-03)
  // e coleta de texto integral do exercício (base dos detectores de ato). As
  // duas chamadas batem na mesma fonte; rodam em paralelo.
  const [coleta, coletaTexto] = await Promise.all([
    coletarEdicoesDiario(exercicio),
    coletarTextosDiario(exercicio),
  ]);

  // Edições do exercício-alvo — DO-01 olha todas as edições do ano; DO-03 usa
  // o ano anterior só como base estatística.
  const doExercicio = coleta.edicoes.filter((e) => e.ano === exercicio);

  // Detectores de metadados (DO-01, DO-03) — sujeito sempre uma edição do ano.
  const alertasMetadados = analisarDiario(coleta.edicoes).filter((a) => {
    const ano = Number(a.sujeitoId.split('_')[0]);
    return ano === exercicio;
  });

  // Detectores de ato (DO-02, DO-04..DO-08) — sobre o texto integral do ano.
  const alertasAtos = analisarAtosDiario(coletaTexto.edicoes);

  const alertas = [...alertasMetadados, ...alertasAtos].sort(
    (a, b) =>
      b.scores.probabilidadeIrregularidade - a.scores.probabilidadeIrregularidade,
  );

  const edicoesExtras = doExercicio.filter((e) => e.edicaoExtra).length;
  const edicoesFimDeSemana = doExercicio.filter((e) => e.fimDeSemana).length;

  // `amostra` deve refletir SÓ o exercício-alvo. `coletarEdicoesDiario` puxa o
  // ano anterior como base estatística do DO-03 — se ESSE ano falhar,
  // `coleta.amostra` fica `true` indevidamente, fazendo a página marcar o
  // exercício como parcial quando ele foi coletado por inteiro. `coletaTexto`
  // só consulta o exercício, então sua flag é o sinal honesto para a UI.
  const exercicioParcial = coletaTexto.amostra;

  const response: DiarioSinaisResponse = {
    exercicio,
    coleta: {
      edicoes: coleta.edicoes.length,
      anosConsultados: coleta.anosConsultados,
      amostra: exercicioParcial,
      erro: coleta.erro,
      erroTexto: coletaTexto.erro,
    },
    resumo: {
      totalEdicoes: doExercicio.length,
      edicoesExtras,
      edicoesFimDeSemana,
      alertas: alertas.length,
      detectoresImplementados: [
        'DO-01',
        'DO-03',
        ...DETECTORES_DO_ATO.map((d) => d.id),
      ],
      // Todos os detectores do catálogo §11 estão implementados — lista vazia.
      detectoresPendentes: [],
    },
    alertas,
    edicoes: doExercicio.slice(0, 200),
    atualizadoEm: new Date().toISOString(),
  };

  // Falha total da coleta de metadados — não mascarar como "nenhuma edição".
  if (coleta.edicoes.length === 0 && coleta.erro) {
    return NextResponse.json(response, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // Coleta parcial: se o texto integral falhou, os detectores de ato
  // (DO-02/04/05/06/07/08) rodaram sobre nada — a resposta é incompleta e NÃO
  // pode ser cacheada como estado estável nem confundida com "sem sinais".
  if (coleta.erro || coletaTexto.erro) {
    return NextResponse.json(response, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return NextResponse.json(response, {
    headers: { 'Cache-Control': 'private, max-age=900' },
  });
}
