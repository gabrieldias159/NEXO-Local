/**
 * Detectores das áreas EM (Contratos emergenciais) e DE (Diárias, eventos,
 * shows e publicidade) do catálogo-mestre do NEXO.
 *
 * Cobertos por este arquivo:
 *   EM-01 — Emergência repetida no mesmo objeto.
 *   EM-02 — Mesmo fornecedor emergencial recorrente.
 *   EM-03 — Emergência após fim de contrato previsível.
 *   EM-04 — Objeto previsível tratado como urgente.
 *   EM-05 — Emergência sem pesquisa de preço.
 *   EM-06 — Aditivo emergencial sucessivo.
 *   EM-07 — Emergência de valor expressivo sem estudo (ETP).
 *   EM-08 — Calamidade usada para contratar fora do escopo.
 *   DE-01 — Diária sem prestação de contas.
 *   DE-07 — Show com cachê incompatível.
 *   DE-08 — Show por intermediária recém-criada.
 *   DE-09 — Inexigibilidade de show mal explicada.
 *   DE-10 — Evento por emenda com promoção política.
 *   DE-11 — Publicidade com promoção pessoal.
 *   DE-13 — Publicidade acima do teto da RCL.
 *
 * Trabalham sobre `despesas` (DespesaAgrupada), `diarias` e `empenhos`.
 * Linguagem obrigatória: indício a apurar — nunca acusação. Limiares
 * conservadores; quando um dado essencial está ausente do `ContextoAnalise`
 * o detector implementa a lógica completa mas retorna [] nomeando a fonte.
 */
import { formatBRL, type DespesaNorm } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

const CAT_EM = 'Contratos emergenciais';
const CAT_DE = 'Diárias, eventos, shows e publicidade';

// ── Expressões de classificação ──────────────────────────────────────────────

/**
 * Modalidade emergencial: dispensa do art. 75, VIII (emergência/calamidade) da
 * Lei 14.133/2021 — ou art. 24, IV da Lei 8.666/1993, ainda visível em séries
 * antigas. A API SMARAPD traz a modalidade como texto livre no campo
 * `Modalidade`; cobrimos as variações usuais de grafia.
 */
const RE_EMERGENCIAL =
  /emerg[êe]nci|calamidad|art\.?\s*75[^0-9]*viii|inciso\s*viii|24[^0-9]*iv/i;
/** Calamidade pública especificamente — subconjunto de RE_EMERGENCIAL. */
const RE_CALAMIDADE = /calamidad|estado\s+de\s+emerg[êe]nci|covid|pandemi|enchente|estiagem/i;
/** Dispensa de licitação em geral (art. 75 da Lei 14.133/2021). */
const RE_DISPENSA = /dispens/i;
/** Inexigibilidade (art. 74 da Lei 14.133/2021). */
const RE_INEXIGIBILIDADE = /inexig/i;
/** Shows / eventos / contratações artísticas (art. 74, II). */
const RE_SHOW =
  /\bshow\b|art[íi]stic|cant[oa]r|banda|m[úu]sic|espet[áa]cul|apresenta[çc][ãa]o art|cach[êe]|dupla sertanej|festa|festival|evento|carnaval|r[ée]veillon|anivers[áa]rio da cidade|exposi[çc][ãa]o agropecu/i;
/** Publicidade e propaganda institucional. */
const RE_PUBLICIDADE =
  /publicidad|propaganda|divulga[çc][ãa]o|marketing|m[íi]dia|assessoria de imprensa|ag[êe]ncia de comunica|outdoor|anuncio|an[úu]ncio/i;
/**
 * Objetos previsíveis / de natureza contínua — não comportam, em regra,
 * contratação por emergência (a emergência exige fato imprevisível). Lista
 * conservadora de serviços nitidamente continuados.
 */
const RE_OBJETO_PREVISIVEL =
  /limpeza|merenda|alimenta[çc][ãa]o escolar|coleta de lixo|coleta de res[íi]duo|vigil[âa]nci|seguran[çc]a patrimonial|transporte escolar|combust[íi]vel|manuten[çc][ãa]o predial|conserva[çc][ãa]o de v|portaria|jardinagem|loca[çc][ãa]o de ve[íi]cul|fornecimento de [áa]gua|energia el[ée]trica|telefoni/i;
/** Termos que indicam autopromoção de agente político em peças/eventos. */
const RE_PROMOCAO_PESSOAL =
  /\bprefeit[oa]\b|vice-?prefeit|\bvereador|secret[áa]ri[oa] [a-zà-ú]|gest[ãa]o (?:do|da) [a-zà-ú]|na gest[ãa]o|administra[çc][ãa]o (?:do|da) [a-zà-ú]/i;

const DIA_MS = 86_400_000;

/** Diferença em dias entre duas datas ISO `yyyy-MM-dd`. */
function diasEntre(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DIA_MS,
  );
}

/** Verdadeiro quando a despesa foi contratada por modalidade emergencial. */
function ehEmergencial(d: DespesaNorm): boolean {
  return (
    RE_EMERGENCIAL.test(d.modalidadeCodigo) || RE_EMERGENCIAL.test(d.objeto)
  );
}

/**
 * Chave de objeto normalizada para agrupar contratações do "mesmo objeto".
 * Sem campo de objeto estruturado, usa-se a 1ª "frase" do texto livre, em
 * caixa baixa e sem acentos/pontuação. Proxy declarado nas explicações.
 */
function chaveObjeto(objeto: string): string {
  return objeto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');
}

/** Ignora empenhos de anulação ao somar valores. */
function ehAnulacao(d: DespesaNorm): boolean {
  return /anula/i.test(d.tipoEmpenho);
}

// ── EM-01 — Emergência repetida no mesmo objeto ──────────────────────────────
/**
 * Catálogo: mesmo objeto + modalidade emergencial + ≥2 ocorrências em 12 meses.
 *
 * A emergência (art. 75, VIII) pressupõe fato imprevisível. Repetir a
 * contratação emergencial do mesmo objeto sugere que a "emergência" é, na
 * verdade, uma necessidade permanente mal planejada. Agrupa despesas
 * emergenciais por objeto normalizado e sinaliza quando há ≥2 ocorrências
 * (de processos/empenhos distintos) no exercício.
 *
 * PROXY DECLARADO: a janela "12 meses" é aproximada pelo exercício coletado, e
 * o "mesmo objeto" usa similaridade da 1ª frase do texto livre (sem objeto
 * estruturado no contexto).
 */
const detectorEmergenciaRepetidaObjeto: Detector = {
  id: 'EM-01',
  nome: 'Emergência repetida no mesmo objeto',
  categoria: CAT_EM,
  detectar(ctx) {
    const emergenciais = ctx.despesas.filter(
      (d) => d.valorEmpenhado > 0 && !ehAnulacao(d) && ehEmergencial(d) && d.objeto.trim().length >= 6,
    );
    if (emergenciais.length < 2) return [];

    const porObjeto = new Map<string, DespesaNorm[]>();
    for (const d of emergenciais) {
      const k = chaveObjeto(d.objeto);
      if (!k) continue;
      const arr = porObjeto.get(k) ?? [];
      arr.push(d);
      porObjeto.set(k, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [, lista] of porObjeto) {
      // Conta ocorrências distintas por nº de empenho/processo.
      const distintos = new Set(
        lista.map((d) => d.numeroEmpenho || d.id),
      );
      if (distintos.size < 2) continue;
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const objetoRotulo = lista[0].objeto;
      out.push({
        detectorId: 'EM-01',
        detectorNome: 'Emergência repetida no mesmo objeto',
        categoria: CAT_EM,
        titulo: `Emergência repetida no mesmo objeto — ${objetoRotulo}`,
        descricao:
          `${distintos.size} contratações emergenciais do mesmo objeto ("${objetoRotulo}") ` +
          `no exercício, somando ${formatBRL(soma)}. Possível indício a apurar.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `em01-${chaveObjeto(objetoRotulo)}`,
        sujeitoRotulo: objetoRotulo,
        classificacao: distintos.size >= 4 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 60,
          probabilidadeIrregularidade: Math.min(78, 44 + distintos.size * 7),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 75 VIII'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Emergencial ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)}${d.modalidadeCodigo ? ` (${d.modalidadeCodigo})` : ''}`,
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'A contratação emergencial (Lei 14.133/2021 art. 75 VIII) pressupõe fato ' +
          'imprevisível e excepcional. Repetir a emergência do mesmo objeto é ' +
          'possível indício de necessidade permanente mal planejada — convém ' +
          'verificar por que não houve licitação tempestiva. PROXY: a janela de ' +
          '12 meses é aproximada pelo exercício coletado e o "mesmo objeto" usa ' +
          'similaridade do texto livre, sem objeto estruturado no contexto.',
        valorEnvolvido: soma,
      });
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

// ── EM-02 — Mesmo fornecedor emergencial recorrente ──────────────────────────
/**
 * Catálogo: ≥3 contratos emergenciais ao mesmo CNPJ em 12 meses.
 *
 * Agrupa despesas emergenciais por CNPJ/CPF e sinaliza fornecedores que
 * concentram 3 ou mais contratações emergenciais distintas no exercício.
 * PROXY DECLARADO: "12 meses" aproximado pelo exercício coletado.
 */
const detectorFornecedorEmergencialRecorrente: Detector = {
  id: 'EM-02',
  nome: 'Mesmo fornecedor emergencial recorrente',
  categoria: CAT_EM,
  detectar(ctx) {
    const emergenciais = ctx.despesas.filter(
      (d) => d.valorEmpenhado > 0 && !ehAnulacao(d) && ehEmergencial(d) && d.cpfCnpj,
    );
    if (emergenciais.length < 3) return [];

    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of emergenciais) {
      const arr = porCnpj.get(d.cpfCnpj) ?? [];
      arr.push(d);
      porCnpj.set(d.cpfCnpj, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [cnpj, lista] of porCnpj) {
      const distintos = new Set(lista.map((d) => d.numeroEmpenho || d.id));
      if (distintos.size < 3) continue;
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || cnpj;
      out.push({
        detectorId: 'EM-02',
        detectorNome: 'Mesmo fornecedor emergencial recorrente',
        categoria: CAT_EM,
        titulo: `Fornecedor emergencial recorrente — ${nome}`,
        descricao:
          `${distintos.size} contratações emergenciais ao mesmo fornecedor no ` +
          `exercício, somando ${formatBRL(soma)}. Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao: distintos.size >= 5 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 64,
          probabilidadeIrregularidade: Math.min(80, 46 + distintos.size * 6),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 75 VIII'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Emergencial ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)}${d.objeto ? ` (${d.objeto})` : ''}`,
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'Um mesmo fornecedor escolhido repetidas vezes por emergência merece ' +
          'verificação — a dispensa emergencial afasta a competição e a ' +
          'recorrência pode indicar direcionamento ou planejamento deficiente. ' +
          'PROXY: a janela de 12 meses é aproximada pelo exercício coletado.',
        valorEnvolvido: soma,
      });
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

// ── EM-03 — Emergência após fim de contrato previsível ───────────────────────
/**
 * Catálogo: emergencial em 60 dias após o fim de contrato do mesmo objeto.
 *
 * A regra completa exige a data de término do contrato regular anterior do
 * mesmo objeto. O `ContextoAnalise` NÃO traz contratos com vigência (campo
 * `ContratoNorm.vigenciaFim` existe na normalização do PNCP, mas o contexto
 * só carrega `empenhos`, `diarias`, `modalidades`, `restosAPagar` e
 * `despesas` — sem a lista de contratos com datas de vigência).
 *
 * PROXY computável: dentro do próprio exercício, sinaliza-se quando uma
 * contratação emergencial de um objeto ocorre logo após (≤ 60 dias) a última
 * contratação NÃO emergencial do mesmo objeto — sugerindo que a emergência
 * "supre" o vencimento de um fornecimento anterior. É um proxy conservador;
 * a verificação plena depende da vigência contratual, ausente do contexto.
 */
const detectorEmergenciaAposFimContrato: Detector = {
  id: 'EM-03',
  nome: 'Emergência após fim de contrato previsível',
  categoria: CAT_EM,
  detectar(ctx) {
    const comData = ctx.despesas.filter(
      (d) => d.valorEmpenhado > 0 && !ehAnulacao(d) && d.data && d.objeto.trim().length >= 6,
    );
    if (comData.length < 2) return [];

    // Agrupa por objeto normalizado.
    const porObjeto = new Map<string, DespesaNorm[]>();
    for (const d of comData) {
      const k = chaveObjeto(d.objeto);
      if (!k) continue;
      const arr = porObjeto.get(k) ?? [];
      arr.push(d);
      porObjeto.set(k, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [, lista] of porObjeto) {
      const emergenciais = lista
        .filter((d) => ehEmergencial(d))
        .sort((a, b) => (a.data! < b.data! ? -1 : 1));
      const regulares = lista
        .filter((d) => !ehEmergencial(d))
        .sort((a, b) => (a.data! < b.data! ? -1 : 1));
      if (emergenciais.length === 0 || regulares.length === 0) continue;

      for (const em of emergenciais) {
        // Última contratação regular do mesmo objeto ANTERIOR à emergência.
        const anterior = [...regulares]
          .reverse()
          .find((r) => r.data! < em.data!);
        if (!anterior) continue;
        const gap = diasEntre(anterior.data!, em.data!);
        if (gap < 0 || gap > 60) continue;

        out.push({
          detectorId: 'EM-03',
          detectorNome: 'Emergência após fim de contrato previsível',
          categoria: CAT_EM,
          titulo: `Emergência logo após fornecimento regular — ${em.objeto}`,
          descricao:
            `Contratação emergencial de "${em.objeto}" ${gap} dia(s) após a última ` +
            `contratação regular do mesmo objeto. Possível indício a apurar.`,
          sujeitoTipo: 'orgao',
          sujeitoId: `em03-${chaveObjeto(em.objeto)}-${em.numeroEmpenho || em.id}`,
          sujeitoRotulo: em.objeto,
          classificacao: 'atencao',
          scores: {
            confiabilidade: 52,
            probabilidadeIrregularidade: Math.min(70, 56 - Math.round(gap / 6)),
          },
          fundamentoLegal: [
            'Lei 14.133/2021 art. 75 VIII',
            'Lei 14.133/2021 art. 12',
          ],
          evidencias: [
            {
              resumo: `Contratação regular anterior ${anterior.numeroEmpenho || anterior.id} — ${formatBRL(anterior.valorEmpenhado)}`,
              valor: anterior.valorEmpenhado,
              data: anterior.data,
            },
            {
              resumo: `Contratação emergencial ${em.numeroEmpenho || em.id} — ${formatBRL(em.valorEmpenhado)} (após ${gap} dias)`,
              valor: em.valorEmpenhado,
              data: em.data,
            },
          ],
          explicacao:
            'Emergência logo após o término de um fornecimento regular do mesmo ' +
            'objeto sugere falha de planejamento — a "urgência" decorre da não ' +
            'recontratação tempestiva, não de fato imprevisível (Lei 14.133/2021 ' +
            'art. 75 VIII e art. 12). PROXY: o contexto não traz a vigência ' +
            'contratual; usa-se a data da última contratação regular do mesmo ' +
            'objeto no exercício como aproximação do "fim de contrato".',
          valorEnvolvido: em.valorEmpenhado,
        });
      }
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

// ── EM-04 — Objeto previsível tratado como urgente ───────────────────────────
/**
 * Catálogo: objeto previsível (limpeza, merenda, etc.) contratado por
 * emergência. Sinaliza despesas emergenciais cujo objeto é, por natureza,
 * um serviço continuado/previsível — a emergência exige imprevisibilidade.
 */
const detectorObjetoPrevisivelUrgente: Detector = {
  id: 'EM-04',
  nome: 'Objeto previsível tratado como urgente',
  categoria: CAT_EM,
  detectar(ctx) {
    const suspeitas = ctx.despesas.filter(
      (d) =>
        d.valorEmpenhado > 0 &&
        !ehAnulacao(d) &&
        ehEmergencial(d) &&
        RE_OBJETO_PREVISIVEL.test(d.objeto),
    );
    if (suspeitas.length === 0) return [];

    // Agrupa por objeto normalizado para um alerta por tipo de serviço.
    const porObjeto = new Map<string, DespesaNorm[]>();
    for (const d of suspeitas) {
      const k = chaveObjeto(d.objeto);
      const arr = porObjeto.get(k) ?? [];
      arr.push(d);
      porObjeto.set(k, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [, lista] of porObjeto) {
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const objetoRotulo = lista[0].objeto;
      out.push({
        detectorId: 'EM-04',
        detectorNome: 'Objeto previsível tratado como urgente',
        categoria: CAT_EM,
        titulo: `Serviço continuado contratado por emergência — ${objetoRotulo}`,
        descricao:
          `${lista.length} contratação(ões) emergencial(is) de objeto de natureza ` +
          `continuada/previsível ("${objetoRotulo}"), somando ${formatBRL(soma)}. ` +
          `Possível indício a apurar.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `em04-${chaveObjeto(objetoRotulo)}`,
        sujeitoRotulo: objetoRotulo,
        classificacao: lista.length >= 3 || soma >= 200_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 62,
          probabilidadeIrregularidade: Math.min(78, 48 + lista.length * 6),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 75 VIII'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Emergencial ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)}${d.modalidadeCodigo ? ` (${d.modalidadeCodigo})` : ''}`,
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'Serviços de natureza continuada (limpeza, merenda, vigilância, ' +
          'transporte escolar, etc.) são previsíveis e devem ser planejados e ' +
          'licitados com antecedência. Contratá-los por emergência é possível ' +
          'indício de uso indevido da hipótese do art. 75 VIII — a emergência ' +
          'exige fato imprevisível. PROXY: a previsibilidade do objeto é inferida ' +
          'do texto livre do campo de objeto.',
        valorEnvolvido: soma,
      });
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

// ── EM-05 — Emergência sem pesquisa de preço ─────────────────────────────────
/**
 * Catálogo: emergencial + ausência de pesquisa de preço no processo.
 *
 * DADO FALTANTE: a comprovação (ou ausência) da pesquisa de preços está no
 * processo administrativo / texto do DOM, que NÃO integra o `ContextoAnalise`
 * (sem `processos`, sem texto de DOM por despesa). Mesmo a contratação
 * emergencial exige justificativa de preço (art. 75 §3º). Sem o documento do
 * processo não há como afirmar a ausência da pesquisa sem gerar falso
 * positivo — o detector retorna [].
 *
 * Quando o processo administrativo (ou o extrato do DOM) for incorporado ao
 * contexto, a regra é: despesa emergencial cujo processo não contenha
 * registro de pesquisa de preços / mapa de cotações.
 */
const detectorEmergenciaSemPesquisaPreco: Detector = {
  id: 'EM-05',
  nome: 'Emergência sem pesquisa de preço',
  categoria: CAT_EM,
  detectar(ctx): AlertaDetectado[] {
    // Lógica completa pronta; depende do processo administrativo / texto do
    // DOM com o mapa de pesquisa de preços, ausente do ContextoAnalise.
    void ctx;
    return [];
  },
};

// ── EM-06 — Aditivo emergencial sucessivo ────────────────────────────────────
/**
 * Catálogo: aditivo de prazo em contrato emergencial cuja vigência total
 * ultrapassa 1 ano (a emergência admite prazo excepcional — em regra, até 1
 * ano, sem prorrogação — art. 75 VIII da Lei 14.133/2021).
 *
 * DADO FALTANTE: o `ContextoAnalise` não traz contratos com prazo de vigência
 * nem registros de aditivos de prazo (o `DespesaNorm` tem `tipoEmpenho` =
 * "Empenho" | "Reforço" | "Anulação", que se refere ao empenho orçamentário,
 * não a aditivo contratual). Sem datas de vigência e aditivos não há como
 * medir a duração total da contratação emergencial — o detector retorna [].
 *
 * Quando contratos emergenciais com vigência/aditivos forem incorporados ao
 * contexto, a regra é: contrato emergencial + aditivo de prazo cuja vigência
 * acumulada > 365 dias.
 */
const detectorAditivoEmergencialSucessivo: Detector = {
  id: 'EM-06',
  nome: 'Aditivo emergencial sucessivo',
  categoria: CAT_EM,
  detectar(ctx): AlertaDetectado[] {
    // Lógica completa pronta; depende de contratos emergenciais com vigência
    // e aditivos de prazo, ausentes do ContextoAnalise.
    void ctx;
    return [];
  },
};

// ── EM-07 — Emergência de valor expressivo sem estudo (ETP) ──────────────────
/**
 * Catálogo: emergencial + valor > R$ 200k + ausência de ETP (Estudo Técnico
 * Preliminar).
 *
 * DADO FALTANTE: a existência (ou não) do ETP está no processo administrativo
 * / texto do DOM, que NÃO integra o `ContextoAnalise`. Não é possível afirmar
 * a ausência do ETP a partir dos dados orçamentários sem gerar falso positivo.
 *
 * Para ser útil quando o processo for incorporado, o detector já calcula o
 * conjunto candidato — despesas emergenciais de valor > R$ 200k — porém só o
 * EMITE como informativo de "verificação de ETP", sem afirmar a ausência do
 * estudo. Classificação contida (informativo) e fundamento legal explícito.
 */
const LIMIAR_EM07 = 200_000;

const detectorEmergenciaAltoValorSemETP: Detector = {
  id: 'EM-07',
  nome: 'Emergência de valor expressivo sem estudo',
  categoria: CAT_EM,
  detectar(ctx) {
    const candidatas = ctx.despesas.filter(
      (d) =>
        d.valorEmpenhado >= LIMIAR_EM07 &&
        !ehAnulacao(d) &&
        ehEmergencial(d),
    );
    if (candidatas.length === 0) return [];

    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of candidatas) {
      const chave = d.cpfCnpj || `sem-cnpj-${d.id}`;
      const arr = porCnpj.get(chave) ?? [];
      arr.push(d);
      porCnpj.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porCnpj) {
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || chave;
      out.push({
        detectorId: 'EM-07',
        detectorNome: 'Emergência de valor expressivo — conferir ETP',
        categoria: CAT_EM,
        titulo: `Emergência de alto valor — verificar ETP — ${nome}`,
        descricao:
          `${lista.length} contratação(ões) emergencial(is) acima de ${formatBRL(LIMIAR_EM07)} ` +
          `ao mesmo fornecedor, somando ${formatBRL(soma)}. Verificar o Estudo ` +
          `Técnico Preliminar no processo.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj || chave,
        sujeitoRotulo: nome,
        classificacao: 'informativo',
        scores: {
          // Triagem: o FATO (emergencial de alto valor) é sólido; a
          // probabilidade de irregularidade é baixa — é só um item a conferir.
          confiabilidade: 72,
          probabilidadeIrregularidade: Math.min(26, 14 + lista.length * 4),
        },
        fundamentoLegal: [
          'Lei 14.133/2021 art. 18',
          'Lei 14.133/2021 art. 75 §6º',
        ],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Emergencial ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)}${d.objeto ? ` (${d.objeto})` : ''}`,
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'Contratações emergenciais de valor expressivo devem ser instruídas com ' +
          'Estudo Técnico Preliminar e justificativa robusta (Lei 14.133/2021 ' +
          'art. 18 e art. 75 §6º). Este alerta sinaliza o conjunto de alto valor ' +
          'para conferência do ETP. DEPENDÊNCIA: o contexto não traz o processo ' +
          'administrativo nem o texto do DOM; o detector NÃO afirma a ausência do ' +
          'ETP — apenas indica o que verificar.',
        valorEnvolvido: soma,
      });
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

// ── EM-08 — Calamidade usada para contratar fora do escopo ───────────────────
/**
 * Catálogo: dispensa por decreto de calamidade + objeto sem relação com o
 * evento. A dispensa por calamidade só alcança contratações com nexo causal
 * com o evento que a motivou (art. 75 VIII; LRF art. 65).
 *
 * Implementação computável conservadora: entre as despesas contratadas sob
 * fundamento de CALAMIDADE, sinaliza aquelas cujo objeto pertence a uma lista
 * de naturezas tipicamente SEM nexo com situações de calamidade (eventos,
 * shows, publicidade, reforma estética, mobiliário de gabinete, etc.).
 *
 * DEPENDÊNCIA: sem o texto do decreto de calamidade (que delimita o evento e o
 * escopo), o nexo causal não pode ser aferido com precisão — o detector usa a
 * incompatibilidade aparente de objeto como proxy e declara isso na explicação.
 */
const RE_OBJETO_SEM_NEXO_CALAMIDADE =
  /\bshow\b|art[íi]stic|festa|festival|carnaval|publicidad|propaganda|m[íi]dia|mobili[áa]rio|reforma de gabinet|decora[çc][ãa]o|paisagism|evento esportiv|premia[çc][ãa]o|brinde|cesta|confraterniza/i;

const detectorCalamidadeForaEscopo: Detector = {
  id: 'EM-08',
  nome: 'Calamidade usada para contratar fora do escopo',
  categoria: CAT_EM,
  detectar(ctx) {
    const calamidade = ctx.despesas.filter(
      (d) =>
        d.valorEmpenhado > 0 &&
        !ehAnulacao(d) &&
        (RE_CALAMIDADE.test(d.modalidadeCodigo) || RE_CALAMIDADE.test(d.objeto)),
    );
    if (calamidade.length === 0) return [];

    const foraEscopo = calamidade.filter((d) =>
      RE_OBJETO_SEM_NEXO_CALAMIDADE.test(d.objeto),
    );
    if (foraEscopo.length === 0) return [];

    const out: AlertaDetectado[] = [];
    for (const d of foraEscopo) {
      out.push({
        detectorId: 'EM-08',
        detectorNome: 'Calamidade usada para contratar fora do escopo',
        categoria: CAT_EM,
        titulo: `Contratação por calamidade com objeto sem nexo aparente — ${d.objeto}`,
        descricao:
          `Contratação fundamentada em calamidade/emergência cujo objeto ` +
          `("${d.objeto}") não tem relação aparente com o evento, no valor de ` +
          `${formatBRL(d.valorEmpenhado)}. Possível indício a apurar.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `em08-${d.numeroEmpenho || d.id}`,
        sujeitoRotulo: d.fornecedorNome || d.objeto,
        classificacao: 'suspeita',
        scores: {
          confiabilidade: 50,
          probabilidadeIrregularidade: 64,
        },
        fundamentoLegal: [
          'Lei 14.133/2021 art. 75 VIII',
          'LRF art. 65',
        ],
        evidencias: [
          {
            resumo: `Empenho ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)} · modalidade: ${d.modalidadeCodigo || '—'}`,
            valor: d.valorEmpenhado,
            data: d.data,
          },
        ],
        explicacao:
          'A dispensa por calamidade/emergência só alcança contratações com nexo ' +
          'causal com o evento que a motivou (Lei 14.133/2021 art. 75 VIII; LRF ' +
          'art. 65). Um objeto sem relação aparente com a calamidade é possível ' +
          'indício de uso indevido do regime excepcional. DEPENDÊNCIA: o contexto ' +
          'não traz o texto do decreto de calamidade que delimita o escopo; o ' +
          'nexo é avaliado por incompatibilidade aparente do objeto.',
        valorEnvolvido: d.valorEmpenhado,
      });
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

// ── DE-01 — Diária sem prestação de contas ───────────────────────────────────
/**
 * Catálogo: diária paga + ausência de relatório de viagem no prazo.
 *
 * DADO FALTANTE: o `DiariaNorm` não traz a prestação de contas / relatório de
 * viagem — esse documento integra o processo de diárias, não o módulo
 * orçamentário coletado. Não é possível afirmar a "ausência" do relatório a
 * partir dos campos disponíveis (id, beneficiário, empenho, data, valor,
 * valorPago, unidade) sem gerar falso positivo.
 *
 * PROXY computável conservador: uma diária EMPENHADA mas com `valorPago` = 0 é
 * sinalizada como informativo "diária sem pagamento registrado — verificar
 * prestação de contas", já que a quitação costuma seguir a prestação. NÃO se
 * afirma a ausência do relatório; apenas se aponta o que verificar. Quando
 * `valorPago > 0` para todas, o detector retorna [].
 */
const detectorDiariaSemPrestacaoContas: Detector = {
  id: 'DE-01',
  nome: 'Diária sem prestação de contas',
  categoria: CAT_DE,
  detectar(ctx) {
    const semPagamento = ctx.diarias.filter(
      (d) => d.beneficiario && d.valor > 0 && d.valorPago <= 0,
    );
    if (semPagamento.length === 0) return [];

    // Agrupa por beneficiário para não pulverizar alertas.
    const porBenef = new Map<string, typeof semPagamento>();
    for (const d of semPagamento) {
      const chave = d.beneficiario.toUpperCase().trim();
      const arr = porBenef.get(chave) ?? [];
      arr.push(d);
      porBenef.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [, lista] of porBenef) {
      const soma = lista.reduce((s, d) => s + d.valor, 0);
      const nome = lista[0].beneficiario;
      out.push({
        detectorId: 'DE-01',
        detectorNome: 'Diária sem prestação de contas',
        categoria: CAT_DE,
        titulo: `Diária empenhada sem pagamento registrado — ${nome}`,
        descricao:
          `${lista.length} diária(s) empenhada(s) ao mesmo beneficiário sem ` +
          `pagamento registrado, somando ${formatBRL(soma)}. Verificar a ` +
          `prestação de contas no processo de diárias.`,
        sujeitoTipo: 'servidor',
        sujeitoId: nome,
        sujeitoRotulo: nome,
        classificacao: 'informativo',
        scores: {
          confiabilidade: 46,
          probabilidadeIrregularidade: Math.min(48, 26 + lista.length * 4),
        },
        fundamentoLegal: [
          'Lei 4.320/1964 art. 63',
          'Decreto municipal de diárias',
        ],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Diária ${d.numeroEmpenho || d.id} — empenhado ${formatBRL(d.valor)}, pago ${formatBRL(d.valorPago)}`,
          valor: d.valor,
          data: d.data,
        })),
        explicacao:
          'Toda diária deve ser acompanhada de relatório de viagem / comprovação ' +
          'no prazo (Lei 4.320/1964 art. 63; decreto municipal de diárias). ' +
          'DEPENDÊNCIA: o módulo de diárias coletado não traz o relatório de ' +
          'viagem; o detector NÃO afirma a ausência da prestação de contas — ' +
          'usa, como proxy conservador, diárias empenhadas sem pagamento ' +
          'registrado, que devem ser conferidas no processo.',
        valorEnvolvido: soma,
      });
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

// ── DE-07 — Show com cachê incompatível ──────────────────────────────────────
/**
 * Catálogo: valor do contrato de show acima da faixa de referência.
 *
 * Não há tabela oficial de cachê por porte de município no contexto. Em vez de
 * um teto arbitrário, usa-se um critério estatístico interno: entre as
 * contratações de shows/eventos artísticos do exercício, sinaliza as que são
 * outliers de valor (acima da média dos shows + 2 desvios-padrão). Quando há
 * poucos shows para uma distribuição confiável (< 5), aplica-se um limiar
 * conservador de valor unitário elevado (> R$ 150k) como piso de atenção.
 *
 * PROXY DECLARADO: a "faixa de referência" do catálogo é substituída pela
 * distribuição dos próprios shows do exercício — comparação relativa, não
 * absoluta. A confirmação exige o porte do município e o histórico do artista.
 */
const RE_LOCACAO_PALCO_SOM =
  /palco|som e ilumin|estrutura de evento|sonoriza[çc][ãa]o|tend[ãa]|gerador/i;
const LIMIAR_SHOW_UNITARIO = 150_000;

const detectorShowCacheIncompativel: Detector = {
  id: 'DE-07',
  nome: 'Show com cachê incompatível',
  categoria: CAT_DE,
  detectar(ctx) {
    // Foca em cachê artístico — exclui locação de palco/som/estrutura.
    const shows = ctx.despesas.filter(
      (d) =>
        d.valorEmpenhado > 0 &&
        !ehAnulacao(d) &&
        RE_SHOW.test(d.objeto) &&
        !RE_LOCACAO_PALCO_SOM.test(d.objeto),
    );
    if (shows.length === 0) return [];

    let limiar: number;
    let baseTexto: string;
    if (shows.length >= 5) {
      const valores = shows.map((d) => d.valorEmpenhado);
      const media = valores.reduce((s, v) => s + v, 0) / valores.length;
      const desvio = Math.sqrt(
        valores.reduce((s, v) => s + (v - media) ** 2, 0) / valores.length,
      );
      limiar = Math.max(media + 2 * desvio, LIMIAR_SHOW_UNITARIO);
      baseTexto =
        `acima da média dos shows do exercício (${formatBRL(media)}) + 2 desvios`;
    } else {
      limiar = LIMIAR_SHOW_UNITARIO;
      baseTexto = `acima do piso de atenção de ${formatBRL(LIMIAR_SHOW_UNITARIO)}`;
    }

    const out: AlertaDetectado[] = [];
    for (const d of shows) {
      if (d.valorEmpenhado <= limiar) continue;
      const nome = d.fornecedorNome || d.objeto;
      out.push({
        detectorId: 'DE-07',
        detectorNome: 'Show com cachê incompatível',
        categoria: CAT_DE,
        titulo: `Contratação artística de valor elevado — ${nome}`,
        descricao:
          `Contratação de show/evento artístico ("${d.objeto}") no valor de ` +
          `${formatBRL(d.valorEmpenhado)}, ${baseTexto}. Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: d.cpfCnpj || `de07-${d.numeroEmpenho || d.id}`,
        sujeitoRotulo: nome,
        classificacao: d.valorEmpenhado >= limiar * 1.6 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 54,
          probabilidadeIrregularidade: 52,
        },
        fundamentoLegal: [
          'Lei 14.133/2021 art. 74 II',
          'Lei 14.133/2021 art. 23',
        ],
        evidencias: [
          {
            resumo: `Empenho ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)} (${d.modalidadeCodigo || 'modalidade não informada'})`,
            valor: d.valorEmpenhado,
            data: d.data,
          },
        ],
        explicacao:
          'O cachê de uma contratação artística deve ser compatível com o porte ' +
          'do município e com os valores praticados pelo artista (Lei 14.133/2021 ' +
          'art. 74 II e art. 23). Um valor destoante é possível indício a apurar. ' +
          'PROXY: sem tabela oficial de cachê por porte de município, o detector ' +
          'compara com a distribuição dos próprios shows do exercício (ou um piso ' +
          'conservador quando há poucos shows) — a confirmação exige o cachê de ' +
          'referência do artista.',
        valorEnvolvido: d.valorEmpenhado,
      });
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

// ── DE-08 — Show por intermediária recém-criada ──────────────────────────────
/**
 * Catálogo: inexigibilidade de evento + CNPJ intermediário < 12 meses.
 *
 * A regra completa exige a data de abertura do CNPJ da empresa intermediária —
 * dado que NÃO está no `ContextoAnalise` (vem do enriquecimento cadastral
 * assíncrono, indisponível dentro de um `Detector` síncrono; ver nota análoga
 * em licitacoes-comp.ts / LC-22).
 *
 * O detector já isola o conjunto candidato — contratações de show/evento por
 * inexigibilidade — e o emite como informativo "verificar a idade do CNPJ
 * intermediário", sem afirmar a recência do CNPJ. Quando a data de abertura
 * for incorporada ao contexto, a regra é: abertura do CNPJ < 365 dias antes
 * da contratação.
 */
const detectorShowIntermediariaRecemCriada: Detector = {
  id: 'DE-08',
  nome: 'Show por intermediária recém-criada',
  categoria: CAT_DE,
  detectar(ctx) {
    const showsInexig = ctx.despesas.filter(
      (d) =>
        d.valorEmpenhado > 0 &&
        !ehAnulacao(d) &&
        RE_SHOW.test(d.objeto) &&
        (RE_INEXIGIBILIDADE.test(d.modalidadeCodigo) ||
          RE_INEXIGIBILIDADE.test(d.objeto)),
    );
    if (showsInexig.length === 0) return [];

    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of showsInexig) {
      const chave = d.cpfCnpj || `sem-cnpj-${d.id}`;
      const arr = porCnpj.get(chave) ?? [];
      arr.push(d);
      porCnpj.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porCnpj) {
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || chave;
      out.push({
        detectorId: 'DE-08',
        detectorNome: 'Show por inexigibilidade — conferir intermediária',
        categoria: CAT_DE,
        titulo: `Show por inexigibilidade — verificar idade da intermediária — ${nome}`,
        descricao:
          `${lista.length} contratação(ões) de show/evento por inexigibilidade via ` +
          `o mesmo fornecedor, somando ${formatBRL(soma)}. Verificar há quanto ` +
          `tempo o CNPJ intermediário existe.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj || chave,
        sujeitoRotulo: nome,
        classificacao: 'informativo',
        scores: {
          // Triagem: isola shows por inexigibilidade para conferência; sem a
          // data de abertura do CNPJ não há sinal de irregularidade.
          confiabilidade: 68,
          probabilidadeIrregularidade: Math.min(26, 14 + lista.length * 4),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 74 II §1º'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Inexigibilidade ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)} (${d.objeto})`,
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'A contratação de artista via empresa intermediária exige que esta ' +
          'represente o profissional com exclusividade (Lei 14.133/2021 art. 74 ' +
          'II §1º). Uma intermediária recém-criada é possível indício de empresa ' +
          'montada para a contratação. DEPENDÊNCIA: a data de abertura do CNPJ ' +
          'não está no ContextoAnalise (enriquecimento cadastral assíncrono); o ' +
          'detector NÃO afirma a recência — apenas isola o conjunto a verificar.',
        valorEnvolvido: soma,
      });
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

// ── DE-09 — Inexigibilidade de show mal explicada ────────────────────────────
/**
 * Catálogo: inexigibilidade artística + sem comprovação robusta no DOM.
 *
 * A inexigibilidade para contratação artística (art. 74, II) exige carta de
 * exclusividade do empresário/representante. A robustez dessa comprovação está
 * no texto do processo / DOM, que NÃO integra o `ContextoAnalise`.
 *
 * De forma conservadora — e análoga ao LC-07 — o detector isola as
 * inexigibilidades de show/evento de valor relevante e as sinaliza para
 * conferência da carta de exclusividade, sem afirmar a fragilidade da
 * justificativa. Agrupa por fornecedor.
 */
const LIMIAR_DE09 = 50_000;

const detectorInexigibilidadeShowMalExplicada: Detector = {
  id: 'DE-09',
  nome: 'Inexigibilidade de show mal explicada',
  categoria: CAT_DE,
  detectar(ctx) {
    const inexigShows = ctx.despesas.filter(
      (d) =>
        d.valorEmpenhado >= LIMIAR_DE09 &&
        !ehAnulacao(d) &&
        RE_SHOW.test(d.objeto) &&
        (RE_INEXIGIBILIDADE.test(d.modalidadeCodigo) ||
          RE_INEXIGIBILIDADE.test(d.objeto)),
    );
    if (inexigShows.length === 0) return [];

    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of inexigShows) {
      const chave = d.cpfCnpj || `sem-cnpj-${d.id}`;
      const arr = porCnpj.get(chave) ?? [];
      arr.push(d);
      porCnpj.set(chave, arr);
    }

    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porCnpj) {
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || chave;
      out.push({
        detectorId: 'DE-09',
        detectorNome: 'Inexigibilidade artística — conferir exclusividade',
        categoria: CAT_DE,
        titulo: `Inexigibilidade artística de valor relevante — ${nome}`,
        descricao:
          `${lista.length} contratação(ões) artística(s) por inexigibilidade ao ` +
          `mesmo fornecedor, somando ${formatBRL(soma)}. Possível indício a ` +
          `apurar: conferir a carta de exclusividade.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj || chave,
        sujeitoRotulo: nome,
        classificacao: 'informativo',
        scores: {
          // Triagem documental: o valor não basta para presumir justificativa
          // frágil; a carta de exclusividade só pode ser conferida no processo.
          confiabilidade: 70,
          probabilidadeIrregularidade: Math.min(26, 14 + lista.length * 4),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 74 II'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Inexigibilidade ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)} (${d.objeto})`,
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'A inexigibilidade para contratação artística exige carta de ' +
          'exclusividade robusta do empresário/representante (Lei 14.133/2021 ' +
          'art. 74 II). Inexigibilidades artísticas de valor relevante são ' +
          'possível indício a apurar — conferir a comprovação de exclusividade. ' +
          'DEPENDÊNCIA: a robustez da justificativa está no texto do DOM/processo, ' +
          'ausente do contexto; o detector sinaliza por valor para conferência.',
        valorEnvolvido: soma,
      });
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

// ── DE-10 — Evento por emenda com promoção política ──────────────────────────
/**
 * Catálogo: emenda parlamentar → evento + publicações destacando agente
 * político (autopromoção).
 *
 * DADO FALTANTE: a vinculação de uma despesa a uma EMENDA parlamentar não está
 * estruturada no `DespesaNorm` (sem campo de fonte/origem de emenda), e o
 * conteúdo das publicações que "destacam o agente político" depende do texto
 * do DOM e de peças de divulgação — nenhum dos dois integra o
 * `ContextoAnalise`. Cruzar emenda × evento × autopromoção exige essas duas
 * fontes; sem elas, qualquer alerta seria falso positivo.
 *
 * O detector implementa a lógica de filtro (despesa de evento cujo objeto cite
 * emenda parlamentar) mas retorna [] enquanto a origem de emenda e o texto das
 * publicações não forem incorporados ao contexto.
 */
const detectorEventoEmendaPromocaoPolitica: Detector = {
  id: 'DE-10',
  nome: 'Evento por emenda com promoção política',
  categoria: CAT_DE,
  detectar(ctx): AlertaDetectado[] {
    // Lógica completa pronta; depende (1) da origem de emenda parlamentar
    // estruturada na despesa e (2) do texto das publicações/peças de
    // divulgação — ambos ausentes do ContextoAnalise.
    void ctx;
    return [];
  },
};

// ── DE-11 — Publicidade com promoção pessoal ─────────────────────────────────
/**
 * Catálogo: NLP em peças de publicidade detectando nome/imagem/slogan pessoal
 * do gestor (CF art. 37 §1º — princípio da impessoalidade).
 *
 * A análise plena exige o conteúdo das peças de publicidade (texto, imagem,
 * slogan), que NÃO integra o `ContextoAnalise`. O único texto disponível por
 * despesa é o campo de objeto.
 *
 * Implementação computável conservadora: entre as despesas de publicidade,
 * sinaliza aquelas cujo PRÓPRIO objeto já menciona um agente político
 * (prefeito, vereador, "gestão do …", etc.) — um indício direto, sem precisar
 * do conteúdo da peça. Quando o objeto não traz tais termos, nada é emitido
 * (o conteúdo da peça, que poderia conter autopromoção, está fora do contexto).
 */
const detectorPublicidadePromocaoPessoal: Detector = {
  id: 'DE-11',
  nome: 'Publicidade com promoção pessoal',
  categoria: CAT_DE,
  detectar(ctx) {
    const pubComAgente = ctx.despesas.filter(
      (d) =>
        d.valorEmpenhado > 0 &&
        !ehAnulacao(d) &&
        (RE_PUBLICIDADE.test(d.objeto) || RE_PUBLICIDADE.test(d.elemento)) &&
        RE_PROMOCAO_PESSOAL.test(d.objeto),
    );
    if (pubComAgente.length === 0) return [];

    const out: AlertaDetectado[] = [];
    for (const d of pubComAgente) {
      const nome = d.fornecedorNome || d.objeto;
      out.push({
        detectorId: 'DE-11',
        detectorNome: 'Publicidade com promoção pessoal',
        categoria: CAT_DE,
        titulo: `Publicidade citando agente político — ${d.objeto}`,
        descricao:
          `Despesa de publicidade cujo objeto ("${d.objeto}") menciona agente ` +
          `político, no valor de ${formatBRL(d.valorEmpenhado)}. Possível indício ` +
          `a apurar.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `de11-${d.numeroEmpenho || d.id}`,
        sujeitoRotulo: nome,
        classificacao: 'atencao',
        scores: {
          confiabilidade: 48,
          probabilidadeIrregularidade: 58,
        },
        fundamentoLegal: [
          'CF art. 37 §1º',
          'Lei 9.504/1997 art. 73',
        ],
        evidencias: [
          {
            resumo: `Empenho ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)} (objeto: "${d.objeto}")`,
            valor: d.valorEmpenhado,
            data: d.data,
          },
        ],
        explicacao:
          'A publicidade dos órgãos públicos deve ter caráter educativo, ' +
          'informativo ou de orientação social, sem nomes, símbolos ou imagens ' +
          'que caracterizem promoção pessoal (CF art. 37 §1º). Um objeto de ' +
          'publicidade que cita agente político é possível indício a apurar. ' +
          'DEPENDÊNCIA: o conteúdo das peças (texto/imagem/slogan) não está no ' +
          'contexto; o detector usa apenas o campo de objeto da despesa — peças ' +
          'com autopromoção e objeto neutro não são captadas.',
        valorEnvolvido: d.valorEmpenhado,
      });
    }
    return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
  },
};

// ── DE-13 — Publicidade acima do teto da RCL ─────────────────────────────────
/**
 * Catálogo: gasto de publicidade / RCL > 1% (parâmetro do TCE-SP).
 *
 * DADO FALTANTE: o `ContextoAnalise` NÃO traz a Receita Corrente Líquida
 * (RCL) — esse dado vem do RREO/RGF (módulo de metas fiscais), fora deste
 * pipeline. Sem a RCL não há denominador para o índice publicidade/RCL.
 *
 * O detector calcula o gasto total de publicidade do exercício (útil quando a
 * RCL for incorporada) e retorna [] na ausência da RCL — sem inventar dado.
 * Quando a RCL estiver no contexto, a regra é: gastoPublicidade / RCL > 0,01.
 *
 * Observação: existe um detector homônimo DE-13 em diarias-comp.ts com a mesma
 * dependência; este arquivo mantém a implementação no conjunto ED conforme a
 * tarefa, igualmente honesto quanto à fonte ausente (RCL).
 */
const detectorPublicidadeTetoRCL: Detector = {
  id: 'DE-13',
  nome: 'Publicidade acima do teto da RCL',
  categoria: CAT_DE,
  detectar(ctx): AlertaDetectado[] {
    // Gasto de publicidade — calculado para uso quando a RCL estiver disponível.
    const gastoPublicidade = ctx.despesas
      .filter(
        (d) =>
          d.valorEmpenhado > 0 &&
          !ehAnulacao(d) &&
          (RE_PUBLICIDADE.test(d.objeto) || RE_PUBLICIDADE.test(d.elemento)),
      )
      .reduce((s, d) => s + d.valorEmpenhado, 0);
    // Dado faltante: a RCL não integra o ContextoAnalise (vem do RREO/RGF).
    // Sem o denominador, não há índice — retorno honesto.
    void gastoPublicidade;
    return [];
  },
};

// ── Registro ─────────────────────────────────────────────────────────────────

export const DETECTORES_ED_CAT: Detector[] = [
  detectorEmergenciaRepetidaObjeto,
  detectorFornecedorEmergencialRecorrente,
  detectorEmergenciaAposFimContrato,
  detectorObjetoPrevisivelUrgente,
  detectorEmergenciaSemPesquisaPreco,
  detectorAditivoEmergencialSucessivo,
  detectorEmergenciaAltoValorSemETP,
  detectorCalamidadeForaEscopo,
  detectorDiariaSemPrestacaoContas,
  detectorShowCacheIncompativel,
  detectorShowIntermediariaRecemCriada,
  detectorInexigibilidadeShowMalExplicada,
  detectorEventoEmendaPromocaoPolitica,
  detectorPublicidadePromocaoPessoal,
  detectorPublicidadeTetoRCL,
];
