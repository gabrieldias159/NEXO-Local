/**
 * GET /api/nexo/analise?exercicio=2026
 *
 * Análise anticorrupção do exercício. Lê os dados já ingeridos pelo cron nas
 * coleções `nexo_*` do Firestore (empenhos, diárias, modalidades, restos,
 * despesas), normaliza, roda o motor de detectores e devolve os alertas + o
 * ranking de fornecedores.
 *
 * Origem dos dados: `nexo_empenhos`, `nexo_diarias`, `nexo_modalidades`,
 * `nexo_restos`, `nexo_despesas` (persistidos pelo cron de ingestão). Como o
 * exercício inteiro é lido do Firestore, o resultado NÃO é amostra. Se a
 * coleção de empenhos estiver vazia para o exercício (cron não rodou), cai no
 * caminho AO VIVO via SMARAPD como fallback — `ingestao.origem` informa qual.
 */
import { NextResponse } from 'next/server';
import { filterModulo, filterModuloAllPages } from '@/lib/nexo/sources/smarapd';
import {
  normalizarEmpenhosFornecedor,
  normalizarDiarias,
  normalizarModalidades,
  normalizarRestosAPagar,
  normalizarDespesas,
} from '@/lib/nexo/normalizar';
import { rodarDetectores, type AlertaDetectado } from '@/lib/nexo/detectores';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import {
  consultasDeDocsSancoes,
  type ConsultaSancaoCnpj,
} from '@/lib/nexo/sources/sancoes-federais';
import { consultasDeDocsSancoesEstaduais } from '@/lib/nexo/detectores/sancoes-estaduais-det';
import {
  acordosDeDocsLeniencia,
  type ConsultaLenienciaCnpj,
} from '@/lib/nexo/sources/leniencia';
import {
  tceDespesasDeDocsTce,
  type TceDespesaNorm,
} from '@/lib/nexo/detectores/tce-divergencia-det';
import { enriquecerProcedencia } from '@/lib/nexo/procedencia';
import { enriquecerCrivoLegal } from '@/lib/nexo/base-legal';
import { sociosDeDocs, type SocioCtx } from '@/lib/nexo/detectores/socio-comum-det';
import { doacoesDeDocs, type DoacaoCtx } from '@/lib/nexo/detectores/doador-politico-det';
import { hashDoc } from '@/lib/nexo/pii';
import { getCnpj } from '@/lib/nexo/sources/cnpj';
import { computarFlagsFornecedor } from '@/lib/nexo/fornecedor-flags';
import { ehEntidadePublica, idCanonicoEntidade } from '@/lib/nexo/entidades';
import { compararPotencial } from '@/lib/nexo/prioridade';
import { resolverProbabilidadeEnquadramento } from '@/lib/nexo/score-risco';

export const runtime = 'nodejs';
// `revalidate` é INERTE aqui (P2-15): `verificarSessao` lê o header Authorization
// → handler dinâmico, então o ISR nunca cacheia. O que vale é o `Cache-Control`
// por resposta. Removido para não enganar.
export const maxDuration = 120;

const PAGINA_TAM = 500;
const MAX_PAGINAS = 25;

// ── Projeções (`select` do `:runQuery`) das coleções pesadas lidas em paralelo ──
// P0-5/P2-16: as 5 leituras vinham SEM projeção (coleção inteira × ~30 campos em
// memória → OOM/latência). Cada lista abaixo é a UNIÃO dos nomes crus que o
// normalizador correspondente lê (todos os fallbacks de `pick`), + `_coletadoEm`
// (origem da coleta) e os campos `_*` carimbados pelo cron. NÃO se aplica `limit`
// (a análise é do exercício INTEIRO — truncar mentiria nos agregados); o ganho
// vem do corte de colunas, não de linhas. `_docId` continua exposto pelo `name`.
const CAMPOS_EMPENHOS = [
  '_exercicio', '_fonte', '_coletadoEm', '_cnpj', '_valor', '_fornecedor',
  'ID', 'Id', 'CPFCNPJ', 'CpfCnpj', 'CNPJ', 'CpfCnpjFornecedor',
  'NomeFornecedor', 'Fornecedor', 'NroEmpenho', 'NumeroEmpenho', 'NumEmpenho',
  'ExercEmpenho', 'Exercicio', 'DataMovimentoEmpenho', 'DataEmp', 'DataMovEmp',
  'Data', 'ValorEmpenho', 'ValorEmpenhado', 'ValorLiquidoPago', 'ValorPago',
  'NroLiquidacao', 'NumeroLiquidacao', 'NroProcessoAdminEmpenho',
  'NroProcessoAdmin', 'ProcessoAdministrativo', 'ProcessoLicitatorio',
  'NroLicitacao', 'UG', 'UnidadeGestora',
];
const CAMPOS_DIARIAS = [
  '_exercicio', '_fonte', '_coletadoEm',
  'ID', 'NroEmpenho', 'NomeFornecedor', 'Beneficiario', 'NomeServidor',
  'NumeroEmpenho', 'Exercicio', 'DataEmp', 'DataEmpenho', 'Data',
  'ValorEmpenhado', 'ValorEmpenho', 'ValorPago', 'UnidadeOrcamentaria', 'UG',
  'Programa',
];
const CAMPOS_MODALIDADES = [
  '_exercicio', '_fonte', '_coletadoEm',
  'tipoLic', 'TipoLic', 'Modalidade', 'ValorEmpenhado', 'Valor',
];
const CAMPOS_RESTOS = [
  '_exercicio', '_fonte', '_coletadoEm',
  'ID', 'NroEmpenho', 'CPFCNPJ', 'CNPJ', 'CpfCnpj', 'NomeFornecedor',
  'Fornecedor', 'ValorRestoAPagar', 'ValorInscrito', 'SaldoRestoAPagar',
  'Valor', 'ValorEmpenhado',
];
const CAMPOS_DESPESAS = [
  '_exercicio', '_fonte', '_coletadoEm',
  'ID', 'NroEmpenho', 'NumeroEmpenho', 'CNPJ', 'CPFCNPJ', 'CpfCnpj',
  'NomeFornecedor', 'Fornecedor', 'DataMovEmp', 'DataMovimentoEmpenho',
  'DataEmp', 'ValorEmpenhado', 'ValorEmpenho', 'ValorPago', 'UG',
  'UnidadeGestora', 'Evento', 'Objeto', 'Historico', 'Elemento',
  'ElementoDespesa', 'Modalidade', 'TipEmpenho', 'TipoEmpenho', 'BemouServico',
  'BemOuServico',
];

export interface TopFornecedor {
  cpfCnpj: string;
  nome: string;
  total: number;
  empenhos: number;
  percentual: number;
}

export interface AnaliseResponse {
  exercicio: number;
  coleta: {
    registros: number;
    diarias: number;
    paginasLidas: number;
    totalPaginas: number;
    amostra: boolean;
    erro: string | null;
  };
  resumo: {
    totalEmpenhado: number;
    fornecedoresUnicos: number;
    alertas: number;
    valorSobAlerta: number;
  };
  alertas: AlertaDetectado[];
  topFornecedores: TopFornecedor[];
  /** Origem efetiva dos dados: Firestore (ingestão) ou coleta ao vivo (fallback). */
  ingestao: { origem: 'firestore' | 'ao-vivo-fallback'; coletadoEm: string | null };
  atualizadoEm: string;
}

/** Extrai o `_coletadoEm` mais recente de um conjunto de docs `nexo_*`. */
function maisRecenteColeta(docs: Record<string, unknown>[]): string | null {
  let recente: string | null = null;
  for (const d of docs) {
    const c = d._coletadoEm;
    if (typeof c === 'string' && (recente === null || c > recente)) recente = c;
  }
  return recente;
}

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const idToken = sessao.idToken;

  const { searchParams } = new URL(req.url);
  const exercicio = Number(searchParams.get('exercicio')) || new Date().getFullYear();

  let empenhos: ReturnType<typeof normalizarEmpenhosFornecedor> = [];
  let diarias: ReturnType<typeof normalizarDiarias> = [];
  let modalidades: ReturnType<typeof normalizarModalidades> = [];
  let restosAPagar: ReturnType<typeof normalizarRestosAPagar> = [];
  let despesas: ReturnType<typeof normalizarDespesas> = [];

  let totalPaginas = 1;
  let paginasLidas = 0;
  let amostra = false;
  let erro: string | null = null;
  let origem: 'firestore' | 'ao-vivo-fallback' = 'firestore';
  let coletadoEm: string | null = null;

  // 1. Origem primária: as coleções `nexo_*` ingeridas pelo cron. Cinco
  // leituras em paralelo — cada doc é o registro bruto da fonte, então os
  // normalizadores recebem a mesma estrutura que receberiam da API.
  try {
    const [
      docsEmpenhos,
      docsDiarias,
      docsModalidades,
      docsRestos,
      docsDespesas,
    ] = await Promise.all([
      lerColecaoNexo('nexo_empenhos', { exercicio, fonte: 'empenhos' }, idToken, CAMPOS_EMPENHOS),
      lerColecaoNexo('nexo_diarias', { exercicio, fonte: 'diarias' }, idToken, CAMPOS_DIARIAS),
      lerColecaoNexo('nexo_modalidades', { exercicio, fonte: 'modalidades' }, idToken, CAMPOS_MODALIDADES),
      lerColecaoNexo('nexo_restos', { exercicio, fonte: 'restos' }, idToken, CAMPOS_RESTOS),
      lerColecaoNexo('nexo_despesas', { exercicio, fonte: 'despesas' }, idToken, CAMPOS_DESPESAS),
    ]);

    if (docsEmpenhos.length > 0) {
      empenhos = normalizarEmpenhosFornecedor(docsEmpenhos, exercicio);
      diarias = normalizarDiarias(docsDiarias, exercicio);
      modalidades = normalizarModalidades(docsModalidades);
      restosAPagar = normalizarRestosAPagar(docsRestos, exercicio);
      despesas = normalizarDespesas(docsDespesas, exercicio);
      // Exercício inteiro lido do Firestore — não é amostra.
      paginasLidas = 1;
      totalPaginas = 1;
      amostra = false;
      coletadoEm = maisRecenteColeta([
        ...docsEmpenhos,
        ...docsDiarias,
        ...docsModalidades,
        ...docsRestos,
        ...docsDespesas,
      ]);
    }
  } catch (err) {
    erro = err instanceof Error ? err.message : 'erro desconhecido';
  }

  // 2. Fallback ao vivo: a coleção de empenhos está vazia para o exercício —
  // o cron ainda não ingeriu. Coleta direto do SMARAPD (caminho original).
  if (empenhos.length === 0) {
    origem = 'ao-vivo-fallback';
    erro = null;
    const brutos: Record<string, unknown>[] = [];
    totalPaginas = 1;
    paginasLidas = 0;

    try {
      const base = {
        chaveModulo: 'fornecedor',
        nomeVisao: 'fornecedoranalitico',
        exercicio,
        periodicidade: 'ANUAL' as const,
        quantidadeRegistros: PAGINA_TAM,
      };
      const primeira = await filterModulo({ ...base, pagina: 1 });
      totalPaginas = primeira.QuantidadePaginas || 1;
      brutos.push(...primeira.Valores);
      paginasLidas = 1;

      const ate = Math.min(totalPaginas, MAX_PAGINAS);
      for (let p = 2; p <= ate; p++) {
        await new Promise((r) => setTimeout(r, 100));
        const resp = await filterModulo({ ...base, pagina: p });
        brutos.push(...resp.Valores);
        paginasLidas = p;
      }
    } catch (err) {
      erro = err instanceof Error ? err.message : 'erro desconhecido';
    }

    empenhos = normalizarEmpenhosFornecedor(brutos, exercicio);
    amostra = totalPaginas > paginasLidas;

    // Diárias — módulo pequeno, coleta completa. Falha aqui não derruba a análise.
    try {
      const brutasDiarias = await filterModuloAllPages(
        {
          chaveModulo: 'diarias',
          nomeVisao: 'diarias',
          exercicio,
          periodicidade: 'ANUAL',
          quantidadeRegistros: PAGINA_TAM,
        },
        { maxPaginas: 20, delayMs: 100 },
      );
      diarias = normalizarDiarias(brutasDiarias, exercicio);
    } catch {
      /* diárias indisponíveis — a análise segue sem elas */
    }

    // Empenho por modalidade — visão agregada, uma página.
    try {
      const r = await filterModulo({
        chaveModulo: 'quadro_de_renda_local',
        nomeVisao: 'EmpenhoModalidade',
        exercicio,
        periodicidade: 'ANUAL',
        pagina: 1,
        quantidadeRegistros: 100,
      });
      modalidades = normalizarModalidades(r.Valores);
    } catch {
      /* modalidades indisponíveis — a análise segue sem elas */
    }

    // Restos a pagar — módulo pequeno, coleta completa.
    try {
      const brutosRestos = await filterModuloAllPages(
        {
          chaveModulo: 'restoapagar',
          nomeVisao: 'restoapagar',
          exercicio,
          periodicidade: 'ANUAL',
          quantidadeRegistros: PAGINA_TAM,
        },
        { maxPaginas: 10, delayMs: 100 },
      );
      restosAPagar = normalizarRestosAPagar(brutosRestos, exercicio);
    } catch {
      /* restos a pagar indisponíveis — a análise segue sem eles */
    }

    // Despesas orçamentárias (DespesaAgrupada) — objeto, elemento, tipo de
    // empenho. Coleta limitada para manter a rota responsiva.
    try {
      const brutasDespesas = await filterModuloAllPages(
        {
          chaveModulo: 'DespesaAgrupada',
          nomeVisao: 'DespesaseInvestimentos',
          exercicio,
          periodicidade: 'ANUAL',
          quantidadeRegistros: PAGINA_TAM,
        },
        { maxPaginas: 30, delayMs: 100 },
      );
      despesas = normalizarDespesas(brutasDespesas, exercicio);
    } catch {
      /* despesas indisponíveis — a análise segue sem elas */
    }
  }

  const totalEmpenhado = empenhos.reduce((s, e) => s + e.valorEmpenhado, 0);

  // Fonte CRUZADA: sanções federais por CNPJ (de `nexo_sancoes`, persistida
  // pelo cron a cada 6h — NÃO é por-exercício). Liga o FR-04 também na análise
  // ao vivo. Ausência/falha degrada para "cruzamento inativo" (FR-04 → []),
  // sem derrubar a análise.
  let sancoes: ConsultaSancaoCnpj[] = [];
  try {
    sancoes = consultasDeDocsSancoes(
      await lerColecaoNexo('nexo_sancoes', {}, idToken),
    );
  } catch {
    /* sanções indisponíveis — FR-04 fica inativo, a análise segue */
  }

  // Fonte CRUZADA: sanções ESTADUAIS (Relação de Apenados do TCE-SP, de
  // `nexo_sancoes_estaduais`). Liga o FR-04E também na análise ao vivo.
  // Ausência/falha degrada para "cruzamento inativo" (FR-04E → []).
  let sancoesEstaduais: ConsultaSancaoCnpj[] = [];
  try {
    sancoesEstaduais = consultasDeDocsSancoesEstaduais(
      await lerColecaoNexo('nexo_sancoes_estaduais', {}, idToken),
    );
  } catch {
    /* sanções estaduais indisponíveis — FR-04E fica inativo, a análise segue */
  }

  // Acordos de leniência da CGU por CNPJ (de `nexo_leniencia`, mensal — NÃO é
  // por-exercício): habilita o FR-05 (leniência×empenho) também na análise ao
  // vivo. Ausência/falha → cruzamento inativo, sem derrubar a análise.
  let leniencia: ConsultaLenienciaCnpj[] = [];
  try {
    leniencia = acordosDeDocsLeniencia(
      await lerColecaoNexo('nexo_leniencia', {}, idToken),
    );
  } catch {
    /* leniência indisponível — FR-05 fica inativo, a análise segue */
  }

  // 2ª fonte oficial por nº empenho (de `nexo_tce_despesas`, exercise-scoped):
  // habilita o detector X2 (divergência SMARAPD×TCE) também na análise ao vivo.
  let tceDespesas: TceDespesaNorm[] = [];
  try {
    tceDespesas = tceDespesasDeDocsTce(
      await lerColecaoNexo('nexo_tce_despesas', { exercicio }, idToken),
    );
  } catch {
    /* TCE-SP indisponível — X2 fica inativo, a análise segue */
  }

  // Grafo societário (nexo_socios) + doações TSE (nexo_doacoes_tse) — não
  // por-exercício. Liga XS-SOCIO/XS-DOADOR ao vivo. hashDoc é a MESMA fn dos
  // coletores → o CNPJ do fornecedor casa com os doadores. Ausência → inativo.
  let socios: SocioCtx[] = [];
  let doacoesTse: DoacaoCtx[] = [];
  try {
    socios = sociosDeDocs(await lerColecaoNexo('nexo_socios', {}, idToken));
  } catch {
    /* sócios indisponíveis — XS-SOCIO inativo, análise segue */
  }
  try {
    doacoesTse = doacoesDeDocs(await lerColecaoNexo('nexo_doacoes_tse', {}, idToken));
  } catch {
    /* TSE indisponível — XS-DOADOR inativo, análise segue */
  }
  const dataReferencia = new Date().toISOString().slice(0, 10);

  const alertas: AlertaDetectado[] = rodarDetectores({
    exercicio,
    empenhos,
    diarias,
    modalidades,
    restosAPagar,
    despesas,
    totalEmpenhado,
    amostra,
    sancoes,
    sancoesEstaduais,
    leniencia,
    tceDespesas,
    socios,
    doacoesTse,
    hashDocFn: hashDoc,
    dataReferencia,
  }).map((a) => enriquecerCrivoLegal(enriquecerProcedencia({ ...a, exercicio })));

  // Ranking de fornecedores — exclui entes públicos (Prefeitura/órgãos NÃO são
  // "fornecedor") e colapsa filiais pela raiz do CNPJ, mantendo um CNPJ completo
  // representativo para enriquecimento/exibição.
  const mapa = new Map<string, { total: number; n: number; nome: string; cnpjFull: string }>();
  for (const e of empenhos) {
    if (!e.cpfCnpj || e.valorEmpenhado <= 0) continue;
    if (ehEntidadePublica(e.cpfCnpj, e.fornecedorNome)) continue;
    const id = idCanonicoEntidade(e.cpfCnpj, e.fornecedorNome);
    const cur = mapa.get(id) ?? { total: 0, n: 0, nome: e.fornecedorNome, cnpjFull: e.cpfCnpj };
    cur.total += e.valorEmpenhado;
    cur.n += 1;
    if (!cur.nome && e.fornecedorNome) cur.nome = e.fornecedorNome;
    if (e.cpfCnpj.length === 14 && cur.cnpjFull.length !== 14) cur.cnpjFull = e.cpfCnpj;
    mapa.set(id, cur);
  }
  const topFornecedores: TopFornecedor[] = [...mapa.values()]
    .map((d) => ({
      cpfCnpj: d.cnpjFull,
      nome: d.nome || d.cnpjFull,
      total: d.total,
      empenhos: d.n,
      percentual: totalEmpenhado > 0 ? (d.total / totalEmpenhado) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 30);

  // Enriquecimento dos maiores fornecedores → alertas de flags cadastrais
  // (outra UF, recém-criada, situação irregular). Em paralelo (allSettled)
  // para não somar timeouts sequenciais.
  const candidatosEnriq = topFornecedores
    .slice(0, 6)
    .filter((f) => f.cpfCnpj.length === 14);
  const enriquecidos = await Promise.allSettled(
    candidatosEnriq.map((f) => getCnpj(f.cpfCnpj)),
  );
  enriquecidos.forEach((res, i) => {
    if (res.status !== 'fulfilled' || !res.value) return;
    const f = candidatosEnriq[i];
    for (const flag of computarFlagsFornecedor(res.value)) {
      alertas.push({
        detectorId: `FN-${flag.tipo}`,
        detectorNome: flag.titulo,
        categoria: 'Fornecedores',
        titulo: `${flag.titulo} — ${f.nome}`,
        descricao: flag.descricao,
        sujeitoTipo: 'fornecedor',
        sujeitoId: f.cpfCnpj,
        sujeitoRotulo: f.nome,
        classificacao: flag.nivel,
        scores: {
          confiabilidade: 80,
          probabilidadeIrregularidade:
            flag.nivel === 'critico' ? 78 : flag.nivel === 'suspeita' ? 62 : 45,
        },
        fundamentoLegal: ['Lei 14.133/2021'],
        evidencias: [{ resumo: flag.descricao }],
        explicacao: flag.descricao,
        valorEnvolvido: f.total,
      });
    }
    // FR-09 — capital social incompatível com o valor contratado.
    const capital = res.value.capitalSocial;
    if (capital && capital > 0 && f.total / capital > 10) {
      alertas.push({
        detectorId: 'FR-09',
        detectorNome: 'Capital social incompatível com contrato',
        categoria: 'Fornecedores',
        titulo: `Capital social incompatível — ${f.nome}`,
        descricao:
          `Valor empenhado supera em mais de 10x o capital social declarado da empresa.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: f.cpfCnpj,
        sujeitoRotulo: f.nome,
        classificacao: 'atencao',
        scores: { confiabilidade: 76, probabilidadeIrregularidade: 52 },
        fundamentoLegal: ['Lei 14.133/2021 art. 69'],
        evidencias: [{ resumo: 'Capital social muito inferior ao valor contratado', valor: f.total }],
        explicacao:
          'Capital social muito inferior ao valor contratado pode indicar ' +
          'fragilidade da qualificação econômico-financeira da empresa.',
        valorEnvolvido: f.total,
      });
    }
  });
  // Coerência de ranking entre telas: deriva a 3ª perna (probabilidadeEnquadramento)
  // quando o detector não a setou — a MESMA régua jurídica de /api/nexo/alertas
  // (que já deriva). Sem isto, /analise rankeava com o default 50 e a ordem
  // divergia da tela de alertas para o mesmo indício.
  for (const a of alertas) {
    if (a.scores.probabilidadeEnquadramento == null) {
      a.scores.probabilidadeEnquadramento = resolverProbabilidadeEnquadramento({
        scores: a.scores,
        classificacao: a.classificacao,
        fundamentoLegal: a.fundamentoLegal,
        sujeitoTipo: a.sujeitoTipo,
      }).valor;
    }
  }
  // Ranking por POTENCIAL (score triplo, média geométrica) — não por R$ cru.
  alertas.sort(compararPotencial);

  const response: AnaliseResponse = {
    exercicio,
    coleta: {
      registros: empenhos.length,
      diarias: diarias.length,
      paginasLidas,
      totalPaginas,
      amostra,
      erro,
    },
    resumo: {
      totalEmpenhado,
      fornecedoresUnicos: mapa.size,
      alertas: alertas.length,
      valorSobAlerta: alertas.reduce((s, a) => s + a.valorEnvolvido, 0),
    },
    alertas,
    topFornecedores,
    ingestao: { origem, coletadoEm },
    atualizadoEm: new Date().toISOString(),
  };

  // Falha total de coleta — não mascarar indisponibilidade da fonte como
  // "nenhum alerta": devolve erro HTTP para o cliente bloquear o resultado.
  if (paginasLidas === 0 && erro) {
    return NextResponse.json(response, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'private, max-age=900',
    },
  });
}
