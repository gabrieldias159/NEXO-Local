/**
 * Detectores do catálogo de Licitações e Compras — IDs LC-08..LC-25 restantes.
 *
 * Cobre os 14 monitoramentos da área LC que ainda não tinham detector:
 *
 *  LC-08 — Único habilitado (pregão/concorrência com 1 só licitante).
 *  LC-09 — Baixa competitividade crônica (média de participantes < 3).
 *  LC-10 — Prazo mínimo de publicação (edital→sessão abaixo do mínimo).
 *  LC-11 — Edital com exigência restritiva (NLP no termo de referência).
 *  LC-12 — Orçamento estimado alinhado (cotações com empresas de fachada).
 *  LC-13 — Competição figurativa (grafo: rodízio de vitórias).
 *  LC-14 — Carona / ata de outro município (adesão sem pesquisa local).
 *  LC-15 — Carona com sobrepreço (preço da carona acima do mercado local).
 *  LC-16 — Objeto licitado em excesso (mesmo objeto licitado >3x no ano).
 *  LC-17 — Empenho sem licitação correspondente (modalidade não-direta sem
 *          ProcessoLicitatorio).
 *  LC-21 — Apostilamento mascarando reajuste (apostilamentos sucessivos).
 *  LC-22 — Vencedor recém-aberto (CNPJ aberto < 180 dias antes do certame).
 *  LC-23 — Alteração societária pré-vitória (mudança de sócios às vésperas).
 *  LC-25 — Sobrepreço em compra de bem (preço unitário acima da mediana).
 *
 * HONESTIDADE: vários destes monitoramentos exigem fontes que o
 * `ContextoAnalise` não carrega (texto de edital, datas de sessão, quadro
 * societário/abertura de CNPJ, planilha de itens com quantidade × preço
 * unitário). Onde a fonte falta, o detector está implementado com a lógica
 * correta, mas retorna `[]` — com comentário nomeando a fonte que falta.
 * Nunca se inventa dado e nunca se gera falso positivo: limiares conservadores.
 * Linguagem: indício a apurar, nunca acusação.
 */
import { formatBRL, type DespesaNorm, type EmpenhoNorm } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

// ── Auxiliares ───────────────────────────────────────────────────────────────

const CATEGORIA = 'Licitações e compras';

/** Modalidades competitivas (não-diretas) — exigem processo licitatório. */
const RE_MODALIDADE_COMPETITIVA =
  /preg[ãa]o|concorr[êe]ncia|concurso|leil[ãa]o|di[áa]logo|tomada\s*de\s*pre[çc]o/i;

/** Modalidades de contratação direta — não exigem certame competitivo. */
const RE_MODALIDADE_DIRETA = /dispens|inexig|direta|ades[ãa]o/i;

/**
 * Texto que indica adesão a ata de registro de preços de OUTRO ente (carona).
 * Endurecido: exige a expressão composta de adesão/carona — a palavra "ata"
 * isolada ou "adesão" solta gerava falso positivo grosseiro (qualquer menção).
 */
const RE_CARONA =
  /\bcarona\b|ades[ãa]o\s+(?:a|à|a\s+ata|a\s+registro)|ades[ãa]o\s+a\s+ata|ata\s+de\s+registro\s+de\s+pre[çc]o|adere\s+(?:a|à)\s+ata|ata\s+de\s+outro\s+(?:munic[íi]pio|[óo]rg[ãa]o|ente)/i;
/** Reforço: menção explícita a ente externo (outro município/órgão/estado). */
const RE_ENTE_EXTERNO =
  /outro\s+(?:munic[íi]pio|[óo]rg[ãa]o|ente|estado)|\bgerenciador\b|[óo]rg[ãa]o\s+gerenciador/i;

/** Normaliza um texto de objeto para comparação. */
function normObjeto(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Soma segura de valor empenhado de uma lista de despesas. */
function somar<T extends { valorEmpenhado: number }>(lista: T[]): number {
  return lista.reduce((s, d) => s + (Number.isFinite(d.valorEmpenhado) ? d.valorEmpenhado : 0), 0);
}

/** Nome de fornecedor representativo de uma lista, com fallback na chave. */
function nomeDe(lista: { fornecedorNome: string; cpfCnpj: string }[], chave: string): string {
  return lista.find((d) => d.fornecedorNome)?.fornecedorNome || lista[0]?.cpfCnpj || chave;
}

/** Despesas válidas (entrada vazia/malformada nunca derruba o detector). */
function despesasValidas(ctx: { despesas?: DespesaNorm[] }): DespesaNorm[] {
  return Array.isArray(ctx.despesas) ? ctx.despesas.filter((d) => d && d.valorEmpenhado > 0) : [];
}

/** Empenhos válidos. */
function empenhosValidos(ctx: { empenhos?: EmpenhoNorm[] }): EmpenhoNorm[] {
  return Array.isArray(ctx.empenhos) ? ctx.empenhos.filter((e) => e && e.valorEmpenhado > 0) : [];
}

/** true quando a despesa é uma contratação por modalidade competitiva. */
function ehCompetitiva(mod: string): boolean {
  return RE_MODALIDADE_COMPETITIVA.test(mod);
}

// ── LC-08 — Único habilitado ─────────────────────────────────────────────────
/**
 * Lei 14.133/2021 art. 17: a competitividade é princípio da fase de seleção.
 * O catálogo pede detectar processo competitivo (pregão/concorrência) com UM
 * só licitante habilitado na fase final.
 *
 * DEPENDÊNCIA DE DADO FALTANTE: o `ContextoAnalise` não traz o número de
 * licitantes habilitados por certame — esse dado vem da ata de julgamento /
 * mapa de lances do PNCP ou do portal de licitações, não disponível dentro de
 * um `Detector` síncrono. Para não inventar dado nem gerar falso positivo, o
 * detector retorna []. Quando a contagem de habilitados por processo for
 * incorporada ao contexto, a regra é: `processo competitivo + habilitados == 1`.
 */
export const detectorUnicoHabilitado: Detector = {
  id: 'LC-08',
  nome: 'Único habilitado',
  categoria: CATEGORIA,
  detectar(): AlertaDetectado[] {
    // Fonte ausente: contagem de licitantes habilitados por certame
    // (ata de julgamento / mapa de lances — PNCP ou portal de licitações).
    return [];
  },
};

// ── LC-09 — Baixa competitividade crônica ────────────────────────────────────
/**
 * Lei 14.133/2021 art. 11 e 25: o processo deve buscar a proposta mais
 * vantajosa em ambiente competitivo. O catálogo pede a média de licitantes por
 * certame por objeto/secretaria — quando < 3, há baixa competitividade crônica.
 *
 * DEPENDÊNCIA DE DADO FALTANTE: o `ContextoAnalise` não traz o número de
 * participantes por certame; só há empenhos/despesas (resultado), não a
 * disputa. A contagem de propostas vem da ata de cada licitação (PNCP/portal).
 * Para não inventar dado, o detector retorna []. Regra correta quando a fonte
 * existir: agrupar certames por objeto/UG e alertar quando a média de
 * licitantes por certame for < 3.
 */
export const detectorBaixaCompetitividade: Detector = {
  id: 'LC-09',
  nome: 'Baixa competitividade crônica',
  categoria: CATEGORIA,
  detectar(): AlertaDetectado[] {
    // Fonte ausente: número de licitantes por certame (atas de licitação).
    return [];
  },
};

// ── LC-10 — Prazo mínimo de publicação ───────────────────────────────────────
/**
 * Lei 14.133/2021 art. 55: entre a divulgação do edital e a abertura da sessão
 * há prazos mínimos que variam por modalidade e tipo de objeto. O catálogo pede
 * `(data sessão − data publicação) < prazo legal da modalidade`.
 *
 * DEPENDÊNCIA DE DADO FALTANTE: o `ContextoAnalise` não traz a data de
 * publicação do edital nem a data da sessão — apenas a data do empenho
 * (posterior à homologação). Esses dois marcos vêm do PNCP / portal de
 * licitações. Para não inventar dado nem gerar falso positivo, o detector
 * retorna []. Regra correta quando as datas existirem: comparar o intervalo
 * publicação→sessão com o piso legal do art. 55 conforme a modalidade.
 */
export const detectorPrazoMinimoPublicacao: Detector = {
  id: 'LC-10',
  nome: 'Prazo mínimo de publicação',
  categoria: CATEGORIA,
  detectar(): AlertaDetectado[] {
    // Fonte ausente: data de publicação do edital e data da sessão (PNCP/portal).
    return [];
  },
};

// ── LC-11 — Edital com exigência restritiva ──────────────────────────────────
/**
 * Lei 14.133/2021 art. 9º e art. 25 §1º: é vedado direcionar a competição com
 * exigências de marca, atestados incomuns ou condições restritivas. O catálogo
 * pede NLP sobre o texto do edital / termo de referência.
 *
 * DEPENDÊNCIA DE DADO FALTANTE: o `ContextoAnalise` não traz o texto do edital
 * nem do termo de referência — essa fonte é o documento do processo licitatório
 * (PNCP / portal). Para não inventar dado, o detector retorna []. Regra correta
 * quando o texto existir: aplicar NLP buscando exigência de marca, atestados de
 * capacidade técnica incomuns e prazos/locais incompatíveis com o objeto.
 */
export const detectorEditalRestritivo: Detector = {
  id: 'LC-11',
  nome: 'Edital com exigência restritiva',
  categoria: CATEGORIA,
  detectar(): AlertaDetectado[] {
    // Fonte ausente: texto do edital / termo de referência (PNCP/portal).
    return [];
  },
};

// ── LC-12 — Orçamento estimado alinhado ──────────────────────────────────────
/**
 * Lei 14.133/2021 art. 23: a estimativa de preços deve ser robusta. O catálogo
 * pede detectar pesquisa de preços feita com empresas de fachada (cotações com
 * CNAE incompatível, CNPJ novo ou endereço comum).
 *
 * DEPENDÊNCIA DE DADO FALTANTE: o `ContextoAnalise` não traz as cotações da
 * pesquisa de preços nem o cadastro (CNAE/endereço/abertura) das empresas
 * cotadas — essa fonte é o mapa de cotações do processo somado ao
 * enriquecimento cadastral de cada CNPJ. Para não inventar dado, o detector
 * retorna []. Regra correta quando as cotações existirem: cruzar os CNPJs
 * cotados contra CNAE × objeto, data de abertura e endereço comum.
 */
export const detectorOrcamentoAlinhado: Detector = {
  id: 'LC-12',
  nome: 'Orçamento estimado alinhado',
  categoria: CATEGORIA,
  detectar(): AlertaDetectado[] {
    // Fonte ausente: cotações da pesquisa de preços + cadastro dos CNPJs cotados.
    return [];
  },
};

// ── LC-13 — Competição figurativa ────────────────────────────────────────────
/**
 * Lei 12.846/2013 art. 5º IV: frustrar o caráter competitivo de licitação é ato
 * lesivo. O catálogo pede um grafo: o mesmo grupo de CNPJs em ≥3 certames com
 * rodízio (alternância previsível) de vitória.
 *
 * DEPENDÊNCIA DE DADO FALTANTE: o `ContextoAnalise` traz apenas o vencedor
 * (empenho/despesa), não a lista completa de participantes de cada certame.
 * Sem os participantes não há como reconstruir o grafo de rodízio. Essa fonte
 * é a ata de cada licitação (PNCP/portal). Para não inventar dado, o detector
 * retorna []. Regra correta quando os participantes existirem: identificar
 * grupos de CNPJs recorrentes em ≥3 certames e medir a alternância de vitória.
 */
export const detectorCompeticaoFigurativa: Detector = {
  id: 'LC-13',
  nome: 'Competição figurativa',
  categoria: CATEGORIA,
  detectar(): AlertaDetectado[] {
    // Fonte ausente: lista de participantes por certame (atas de licitação).
    return [];
  },
};

// ── LC-14 — Carona / ata de outro município ──────────────────────────────────
/**
 * Lei 14.133/2021 art. 86 §2º: a adesão a ata de registro de preços de outro
 * ente (carona) exige demonstração de vantagem e pesquisa local. O catálogo
 * pede: empenho com ata externa + sem pesquisa local + preço acima dos
 * contratos locais.
 *
 * PROXY DECLARADO E REBAIXADO: o `ContextoAnalise` não traz um campo "ata
 * externa" estruturado nem a pesquisa de preços. O detector opera por PROXY
 * textual — e a versão anterior disparava por QUALQUER menção a "ata" ou
 * "adesão" acima de R$ 80 mil, um falso positivo grosseiro. Agora:
 *  - a regex exige a expressão composta de adesão/carona a ata (ver RE_CARONA),
 *    não a palavra "ata" isolada;
 *  - o limiar de valor subiu para R$ 250 mil;
 *  - o alerta nasce SEMPRE como `informativo` (nunca escala sozinho a
 *    atenção/suspeita) — é um item de conferência, não uma irregularidade;
 *  - menção explícita a ente externo (outro município/órgão gerenciador) só
 *    eleva levemente o score, sem mudar a classificação.
 * A confirmação de que a ata é de outro município e da ausência de pesquisa
 * local depende do processo (PNCP/portal), que não está no contexto.
 */
const LIMIAR_CARONA = 250_000;

export const detectorCaronaAtaExterna: Detector = {
  id: 'LC-14',
  nome: 'Carona / ata de outro município',
  categoria: CATEGORIA,
  detectar(ctx) {
    const despesas = despesasValidas(ctx);
    const caronas = despesas.filter(
      (d) =>
        d.valorEmpenhado >= LIMIAR_CARONA &&
        (RE_CARONA.test(d.objeto) || RE_CARONA.test(d.modalidadeCodigo)),
    );
    if (caronas.length === 0) return [];

    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of caronas) {
      const chave = d.cpfCnpj || `sem-cnpj-${d.id}`;
      const arr = porCnpj.get(chave) ?? [];
      arr.push(d);
      porCnpj.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porCnpj) {
      const soma = somar(lista);
      const nome = nomeDe(lista, chave);
      // Reforço de evidência: alguma das despesas menciona ente externo.
      const temEnteExterno = lista.some(
        (d) => RE_ENTE_EXTERNO.test(d.objeto) || RE_ENTE_EXTERNO.test(d.modalidadeCodigo),
      );
      out.push({
        detectorId: 'LC-14',
        detectorNome: 'Carona / ata de outro município',
        categoria: CATEGORIA,
        titulo: `Conferir possível adesão a ata de registro de preços — ${nome}`,
        descricao:
          `${lista.length} contratação(ões) cujo objeto/modalidade menciona adesão/` +
          `carona a ata de registro de preços, somando ${formatBRL(soma)}. ` +
          `Item de conferência (proxy textual): verificar se houve pesquisa de ` +
          `preços local e demonstração de vantagem da carona.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj || chave,
        sujeitoRotulo: nome,
        // Proxy textual — nasce SEMPRE como informativo, nunca escala sozinho.
        classificacao: 'informativo',
        scores: {
          confiabilidade: temEnteExterno ? 44 : 32,
          probabilidadeIrregularidade: Math.min(
            temEnteExterno ? 42 : 30,
            (temEnteExterno ? 22 : 14) + lista.length * 3,
          ),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 86 §2º'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Empenho ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)}${d.objeto ? ` (${d.objeto})` : ''}`,
          valor: d.valorEmpenhado,
          data: d.data,
          ref: d.modalidadeCodigo || undefined,
        })),
        explicacao:
          'A adesão a ata de registro de preços de outro ente (carona) exige ' +
          'demonstração de vantagem e pesquisa de preços local (Lei 14.133/2021 ' +
          'art. 86 §2º). PROXY DECLARADO: o contexto não tem um campo estruturado ' +
          'de "ata externa" — o detector apenas sinaliza, como item de ' +
          'conferência, despesas cujo texto menciona adesão/carona a ata. Não é ' +
          'indício de irregularidade por si só: pode ser carona regular e ' +
          'vantajosa. A confirmação de que a ata é de outro município e da ' +
          'ausência de pesquisa local depende do processo licitatório ' +
          '(PNCP/portal), que não está no contexto.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ── LC-15 — Carona com sobrepreço ────────────────────────────────────────────
/**
 * Lei 14.133/2021 art. 23 e 86: a adesão a ata não pode resultar em preço
 * acima do mercado local. O catálogo pede: preço unitário da carona > +15% vs.
 * a mediana de contratos comparáveis.
 *
 * DEPENDÊNCIA DE DADO FALTANTE: a comparação de PREÇO UNITÁRIO exige a planilha
 * de itens (quantidade × preço unitário) tanto da carona quanto dos contratos
 * locais comparáveis. O `ContextoAnalise` traz apenas o valor empenhado total
 * por despesa, sem itens nem quantidades. Essa fonte é o detalhamento de itens
 * do PNCP/portal. Para não inventar dado nem gerar falso positivo, o detector
 * retorna []. Regra correta quando os itens existirem: comparar o preço
 * unitário da carona com a mediana do mesmo item em contratos comparáveis e
 * alertar acima de +15%.
 */
export const detectorCaronaSobrepreco: Detector = {
  id: 'LC-15',
  nome: 'Carona com sobrepreço',
  categoria: CATEGORIA,
  detectar(): AlertaDetectado[] {
    // Fonte ausente: planilha de itens (quantidade × preço unitário) da carona
    // e dos contratos locais comparáveis (PNCP/portal).
    return [];
  },
};

// ── LC-16 — Objeto licitado em excesso ───────────────────────────────────────
/**
 * Lei 14.133/2021 art. 12 e 18: o planejamento deve consolidar demandas para
 * evitar licitar repetidamente o mesmo objeto. O catálogo pede: mesmo objeto
 * licitado >3x no exercício.
 *
 * Roda sobre dado real do contexto: usa as despesas por MODALIDADE COMPETITIVA
 * (pregão/concorrência/etc.), agrupa por objeto normalizado e conta os
 * processos licitatórios distintos. Conservador: agrupa por objeto + UG (uma
 * mesma secretaria licitando o mesmo objeto várias vezes) e exige >3 processos
 * distintos. Quando o número de processo não está disponível, usa a data como
 * delimitador de processo para não superestimar.
 */
export const detectorObjetoLicitadoExcesso: Detector = {
  id: 'LC-16',
  nome: 'Objeto licitado em excesso',
  categoria: CATEGORIA,
  detectar(ctx) {
    const despesas = despesasValidas(ctx).filter(
      (d) => d.objeto && ehCompetitiva(d.modalidadeCodigo),
    );
    if (despesas.length === 0) return [];

    // Agrupa por objeto normalizado + unidade gestora.
    const grupos = new Map<string, DespesaNorm[]>();
    for (const d of despesas) {
      const chave = `${normObjeto(d.objeto)}|${d.unidadeGestora || '—'}`;
      const arr = grupos.get(chave) ?? [];
      arr.push(d);
      grupos.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const lista of grupos.values()) {
      // Conta processos licitatórios distintos; quando o nº não existe,
      // cada data distinta conta como um processo (estimativa conservadora).
      const processos = new Set<string>();
      for (const d of lista) {
        const ref = d.numeroEmpenho ? `emp:${d.numeroEmpenho.replace(/\/.*/, '')}` : '';
        processos.add(ref || `data:${d.data ?? d.id}`);
      }
      if (processos.size <= 3) continue;

      const soma = somar(lista);
      const objeto = lista.find((d) => d.objeto)?.objeto ?? '';
      const ug = lista[0].unidadeGestora || '—';
      out.push({
        detectorId: 'LC-16',
        detectorNome: 'Objeto licitado em excesso',
        categoria: CATEGORIA,
        titulo: `Mesmo objeto licitado ${processos.size}x no exercício — ${ug}`,
        descricao:
          `O objeto "${objeto}" aparece em ${processos.size} processos licitatórios ` +
          `distintos da mesma unidade gestora no exercício, somando ${formatBRL(soma)}. ` +
          `Possível indício a apurar: falta de consolidação do planejamento.`,
        sujeitoTipo: 'orgao',
        sujeitoId: ug,
        sujeitoRotulo: ug,
        classificacao: processos.size >= 6 ? 'atencao' : 'informativo',
        scores: {
          confiabilidade: 58,
          probabilidadeIrregularidade: Math.min(56, 26 + processos.size * 4),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 18, 12'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Empenho ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)} (${d.modalidadeCodigo || 'modalidade não informada'})`,
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'Licitar repetidamente o mesmo objeto na mesma unidade dentro do ' +
          'exercício pode indicar falha de planejamento ou consolidação de ' +
          'demandas (Lei 14.133/2021 art. 12 e 18). É possível indício a apurar — ' +
          'pode também refletir compras programadas legítimas, o que deve ser ' +
          'verificado no plano de contratações. A contagem de processos é ' +
          'estimada pelo número do empenho/data, na ausência de um campo de ' +
          'número de processo no contexto.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ── LC-17 — Empenho sem licitação correspondente ─────────────────────────────
/**
 * Lei 14.133/2021 art. 12: a contratação por modalidade competitiva pressupõe
 * processo licitatório formal e rastreável. O catálogo pede: modalidade
 * pregão/concorrência + `ProcessoLicitatorio` vazio ou não encontrado.
 *
 * Roda sobre dado real do contexto: o módulo `fornecedor`/empenho analítico
 * traz o campo `processoLicitatorio` em `EmpenhoNorm`. O detector cruza
 * empenhos de modalidade competitiva (identificada pela despesa correspondente
 * de mesmo número de empenho) que não têm número de processo licitatório.
 * Conservador: só dispara para valores relevantes e ignora modalidades diretas.
 */
const LIMIAR_SEM_LICITACAO = 50_000;

export const detectorEmpenhoSemLicitacao: Detector = {
  id: 'LC-17',
  nome: 'Empenho sem licitação correspondente',
  categoria: CATEGORIA,
  detectar(ctx) {
    const empenhos = empenhosValidos(ctx);
    const despesas = despesasValidas(ctx);
    if (empenhos.length === 0) return [];

    // Mapa nº de empenho → modalidade declarada na DespesaAgrupada.
    const modalidadePorEmpenho = new Map<string, string>();
    for (const d of despesas) {
      if (d.numeroEmpenho && d.modalidadeCodigo) {
        modalidadePorEmpenho.set(d.numeroEmpenho, d.modalidadeCodigo);
      }
    }

    const semProcesso: { e: EmpenhoNorm; modalidade: string }[] = [];
    for (const e of empenhos) {
      if (e.valorEmpenhado < LIMIAR_SEM_LICITACAO) continue;
      const modalidade = modalidadePorEmpenho.get(e.numeroEmpenho) ?? '';
      // Só interessa quando a modalidade é competitiva. Sem modalidade
      // identificável, não dispara (evita falso positivo).
      if (!modalidade || !ehCompetitiva(modalidade)) continue;
      // Modalidade direta nunca entra (já coberta por LC-06/LC-07/LC-18).
      if (RE_MODALIDADE_DIRETA.test(modalidade)) continue;
      const proc = (e.processoLicitatorio ?? '').trim();
      if (proc) continue; // tem processo — ok.
      semProcesso.push({ e, modalidade });
    }
    if (semProcesso.length === 0) return [];

    const porCnpj = new Map<string, typeof semProcesso>();
    for (const s of semProcesso) {
      const chave = s.e.cpfCnpj || `sem-cnpj-${s.e.id}`;
      const arr = porCnpj.get(chave) ?? [];
      arr.push(s);
      porCnpj.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porCnpj) {
      const soma = lista.reduce((s, x) => s + x.e.valorEmpenhado, 0);
      const nome =
        lista.find((x) => x.e.fornecedorNome)?.e.fornecedorNome || lista[0].e.cpfCnpj || chave;
      out.push({
        detectorId: 'LC-17',
        detectorNome: 'Empenho sem licitação correspondente',
        categoria: CATEGORIA,
        titulo: `Empenho por modalidade competitiva sem nº de processo — ${nome}`,
        descricao:
          `${lista.length} empenho(s) declarados em modalidade competitiva ` +
          `(pregão/concorrência) sem número de processo licitatório registrado, ` +
          `somando ${formatBRL(soma)}. Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].e.cpfCnpj || chave,
        sujeitoRotulo: nome,
        classificacao: soma >= 200_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 60,
          probabilidadeIrregularidade: Math.min(70, 36 + lista.length * 6),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 12'],
        evidencias: lista.slice(0, 8).map((x) => ({
          resumo: `Empenho ${x.e.numeroEmpenho || x.e.id} — ${formatBRL(x.e.valorEmpenhado)} (${x.modalidade})`,
          valor: x.e.valorEmpenhado,
          data: x.e.data,
        })),
        explicacao:
          'Contratação por modalidade competitiva pressupõe processo licitatório ' +
          'formal e rastreável (Lei 14.133/2021 art. 12). Empenho em pregão ou ' +
          'concorrência sem número de processo é possível indício a apurar — pode ' +
          'também ser falha de preenchimento do campo no portal, o que deve ser ' +
          'verificado no PNCP/portal de licitações.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ── LC-21 — Apostilamento mascarando reajuste ────────────────────────────────
/**
 * Lei 14.133/2021 art. 136: o apostilamento serve a registros que não alteram
 * o objeto nem o equilíbrio do contrato (reajuste por índice, atualizações
 * formais). O catálogo pede: ≥3 apostilamentos no mesmo contrato com elevação
 * acumulada > 15% — uso do apostilamento para mascarar reajuste/aditivo.
 *
 * DEPENDÊNCIA DE DADO FALTANTE: o `ContextoAnalise` não traz os registros de
 * apostilamento (nem o histórico de valores por contrato). Essa fonte é o
 * histórico de alterações contratuais do PNCP / portal de contratos. Para não
 * inventar dado, o detector retorna []. Regra correta quando os apostilamentos
 * existirem: contar apostilamentos por contrato e medir a elevação acumulada de
 * valor, alertando com ≥3 e variação > 15%.
 */
export const detectorApostilamentoReajuste: Detector = {
  id: 'LC-21',
  nome: 'Apostilamento mascarando reajuste',
  categoria: CATEGORIA,
  detectar(): AlertaDetectado[] {
    // Fonte ausente: registros de apostilamento por contrato (PNCP/portal).
    return [];
  },
};

// ── LC-22 — Vencedor recém-aberto ────────────────────────────────────────────
/**
 * Lei 14.133/2021 art. 5º: princípios da licitação. O catálogo pede comparar a
 * data de abertura do CNPJ vencedor com a data da licitação (< 180 dias).
 *
 * DEPENDÊNCIA DE DADO FALTANTE: o `ContextoAnalise` não traz a data de abertura
 * do CNPJ — esse dado vem do enriquecimento cadastral (Receita Federal /
 * sources/cnpj), assíncrono e indisponível dentro de um `Detector` síncrono.
 * O enriquecimento já é feito na rota de análise para os maiores fornecedores
 * e gera o alerta FN-recem_criada (ver fornecedor-flags / fornecedores-comp),
 * que cobre parcialmente esta regra. Para não inventar dado nem duplicar
 * alerta, o detector retorna []. Regra correta quando a data de abertura
 * estiver no contexto: `data da licitação − data de abertura do CNPJ < 180d`.
 */
export const detectorVencedorRecemAbertoCat: Detector = {
  id: 'LC-22',
  nome: 'Vencedor recém-aberto',
  categoria: CATEGORIA,
  detectar(): AlertaDetectado[] {
    // Fonte ausente: data de abertura do CNPJ (enriquecimento cadastral —
    // Receita Federal). Cobertura parcial via FN-recem_criada na rota de análise.
    return [];
  },
};

// ── LC-23 — Alteração societária pré-vitória ─────────────────────────────────
/**
 * Lei 12.846/2013 art. 5º IV: manipular o caráter competitivo é ato lesivo. O
 * catálogo pede detectar alteração de sócios nos 90 dias anteriores à vitória.
 *
 * DEPENDÊNCIA DE DADO FALTANTE: o `ContextoAnalise` não traz o quadro
 * societário do CNPJ nem o histórico de alterações societárias — essa fonte é
 * o enriquecimento cadastral (Receita Federal / juntas comerciais). Para não
 * inventar dado, o detector retorna []. Regra correta quando o histórico
 * societário existir: comparar a data de cada alteração de sócios com a data
 * da vitória e alertar quando a alteração ocorreu nos 90 dias anteriores.
 */
export const detectorAlteracaoSocietariaPreVitoria: Detector = {
  id: 'LC-23',
  nome: 'Alteração societária pré-vitória',
  categoria: CATEGORIA,
  detectar(): AlertaDetectado[] {
    // Fonte ausente: histórico de quadro societário do CNPJ
    // (enriquecimento cadastral — Receita Federal / juntas comerciais).
    return [];
  },
};

// ── LC-25 — Sobrepreço em compra de bem ──────────────────────────────────────
/**
 * Lei 14.133/2021 art. 23: o preço contratado deve ser compatível com o
 * mercado. O catálogo pede: preço unitário de item > +25% vs. a mediana do
 * mesmo item no portal/PNCP.
 *
 * DEPENDÊNCIA DE DADO FALTANTE: a comparação exige a planilha de ITENS com
 * quantidade × preço unitário e a identificação do item (descrição/código)
 * para casar com a mediana de mercado. O `ContextoAnalise` traz apenas o valor
 * empenhado total por despesa — sem itens, quantidades nem preço unitário, e
 * sem uma base de medianas por item. Essas fontes são o detalhamento de itens
 * do PNCP/portal e o Painel de Preços. Para não inventar dado nem gerar falso
 * positivo, o detector retorna []. Regra correta quando os itens existirem:
 * casar cada item por descrição/código, calcular a mediana e alertar quando o
 * preço unitário exceder a mediana em +25%.
 */
export const detectorSobreprecoCompraBem: Detector = {
  id: 'LC-25',
  nome: 'Sobrepreço em compra de bem',
  categoria: CATEGORIA,
  detectar(): AlertaDetectado[] {
    // Fonte ausente: planilha de itens (quantidade × preço unitário) e base de
    // medianas por item (detalhamento PNCP/portal + Painel de Preços).
    return [];
  },
};

// ── Registro do catálogo LC ──────────────────────────────────────────────────

/** Os 14 detectores de Licitações e Compras dos IDs LC-08..LC-25 restantes. */
export const DETECTORES_LC_CAT: Detector[] = [
  detectorUnicoHabilitado,
  detectorBaixaCompetitividade,
  detectorPrazoMinimoPublicacao,
  detectorEditalRestritivo,
  detectorOrcamentoAlinhado,
  detectorCompeticaoFigurativa,
  detectorCaronaAtaExterna,
  detectorCaronaSobrepreco,
  detectorObjetoLicitadoExcesso,
  detectorEmpenhoSemLicitacao,
  detectorApostilamentoReajuste,
  detectorVencedorRecemAbertoCat,
  detectorAlteracaoSocietariaPreVitoria,
  detectorSobreprecoCompraBem,
];
