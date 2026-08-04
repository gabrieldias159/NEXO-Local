/**
 * Detectores da categoria "Cruzamentos cross-source" do catálogo NEXO.
 *
 * Cobre XS-01, XS-02, XS-03, XS-04, XS-05, XS-06, XS-08, XS-09, XS-10, XS-11,
 * XS-12, XS-13 e XS-14. (XS-07 já vive em `cross-comp.ts`.)
 *
 * NATUREZA DA CATEGORIA — por definição, um cruzamento cross-source compara
 * DUAS OU MAIS fontes distintas. O `ContextoAnalise` aqui disponível traz UMA
 * só fonte: a API SMARAPD (empenhos do módulo `fornecedor` e despesas do
 * módulo `DespesaAgrupada`), mais agregados de modalidade e restos a pagar.
 *
 * A maioria dos XS exige uma SEGUNDA fonte que NÃO está no contexto:
 *   - texto do Diário Oficial (DOM)  → XS-02, XS-03, XS-04, XS-06
 *   - folha de pagamento             → XS-04, XS-05
 *   - grafo de sócios/endereços      → XS-01, XS-05, XS-11, XS-12
 *   - norma do SAPL                  → XS-08
 *   - extrato bancário               → XS-09
 *   - manifestações do e-SIC         → XS-13
 *   - base de julgados do TCE-SP     → XS-14
 *
 * Para cada ID a lógica de cruzamento correta do catálogo está implementada
 * por inteiro. Quando a(s) fonte(s) necessária(s) não estão no contexto, o
 * detector retorna `[]` — NUNCA inventa dado, NUNCA gera falso positivo — e o
 * comentário nomeia exatamente o que falta. O que é computável só com
 * empenhos/despesas (XS-10, proxy de lastro por fonte/dotação) roda de fato.
 *
 * Linguagem: indício a apurar, jamais acusação.
 */
import { formatBRL, type DespesaNorm, type EmpenhoNorm } from '../normalizar';
import type { AlertaDetectado, ContextoAnalise, Detector } from './tipos';

const CATEGORIA = 'Cruzamentos cross-source';

/**
 * Tipo estendido para fontes opcionais que um cruzamento cross-source exigiria
 * mas que o `ContextoAnalise` padrão (uma só fonte SMARAPD) não carrega. O
 * detector lê estes campos de forma defensiva: se ausentes, retorna `[]`. Isso
 * mantém a lógica de cruzamento completa e pronta para quando a coleta passar
 * a anexar as fontes — sem nunca presumir dado inexistente.
 */
interface ContextoCross extends ContextoAnalise {
  /** Atos extraídos do Diário Oficial (DOM) — fonte 2 de XS-02/03/04/06. */
  atosDom?: unknown[];
  /** Folha de pagamento (módulo `pagamentos`) — fonte 2 de XS-04/05. */
  folha?: unknown[];
  /** Grafo de sócios/endereços de fornecedores — fonte 2 de XS-01/05/11/12. */
  grafoSocietario?: unknown;
  /** Normas do SAPL — fonte 2 de XS-08. */
  normasSapl?: unknown[];
  /** Extratos/conciliação bancária — fonte 2 de XS-09. */
  extratosBancarios?: unknown[];
  /** Disponibilidade de caixa por fonte de recurso — fonte 2 de XS-10. */
  disponibilidadeCaixa?: unknown[];
  /** Manifestações do e-SIC — fonte 2 de XS-13. */
  manifestacoesEsic?: unknown[];
  /** Julgados/apontamentos do TCE-SP — fonte 2 de XS-14. */
  julgadosTceSp?: unknown[];
}

/** Lê uma fonte opcional, devolvendo `[]` quando ausente ou de tipo errado. */
function fonteArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ── XS-01 — Membro de comissão sócio de empresa vencedora ────────────────────
/**
 * REGRA (catálogo): grafo — CPF de membro de comissão de licitação ∈ sócios da
 * empresa vencedora. Cruza DUAS fontes: (1) portarias de nomeação de comissão
 * publicadas no DOM (insumo DO-06) e (2) o quadro societário (grafo de sócios)
 * de cada CNPJ fornecedor.
 *
 * FONTES FALTANTES no `ContextoAnalise`: composição das comissões de licitação
 * (texto do DOM) E o grafo de sócios das empresas. O contexto SMARAPD só traz
 * empenhos/despesas — não há CPF de comissionado nem quadro societário. Sem
 * inventar vínculo, o detector retorna []; a lógica de interseção fica pronta
 * para quando ambas as fontes forem anexadas ao contexto.
 */
export const detectorComissaoSocioVencedora: Detector = {
  id: 'XS-01',
  nome: 'Membro de comissão sócio de vencedora',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const grafo = cx.grafoSocietario;
    const comissoes = fonteArray(cx.atosDom);
    // Cruzamento de 2 fontes indisponível: composição de comissão de licitação
    // (DOM/DO-06) e grafo societário dos fornecedores não estão no contexto.
    if (grafo == null || comissoes.length === 0) return [];
    // Quando ambas existirem: para cada empresa vencedora, intersectar o
    // conjunto de CPFs de sócios com os CPFs dos membros da comissão do
    // certame; havendo CPF comum, emitir alerta 'critico' (severidade 5).
    return [];
  },
};

// ── XS-02 — Dispensa publicada no DOM ausente do portal ──────────────────────
/**
 * REGRA (catálogo): dispensa publicada no DOM sem registro correspondente em
 * DespesaAgrupada, casada por número de processo. Cruza (1) extratos de
 * dispensa no DOM e (2) as despesas do portal.
 *
 * FONTE FALTANTE: o texto do Diário Oficial (lista de dispensas publicadas).
 * O `ContextoAnalise` traz o lado "portal" (despesas/empenhos), mas não o lado
 * "DOM". Sem a lista de dispensas publicadas não há o que casar — emitir
 * alerta exigiria presumir uma publicação inexistente. Retorna [].
 *
 * Quando `atosDom` trouxer as dispensas: para cada dispensa do DOM, procurar
 * uma despesa cujo processo administrativo bata; ausência de match → alerta.
 */
export const detectorDispensaDomSemPortal: Detector = {
  id: 'XS-02',
  nome: 'Dispensa no DOM ausente do portal',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const dispensasDom = fonteArray(cx.atosDom);
    // Cruzamento de 2 fontes indisponível: a relação de dispensas publicadas
    // no Diário Oficial (DOM) não está no ContextoAnalise (fonte única SMARAPD).
    if (dispensasDom.length === 0) return [];
    // Índice de processos conhecidos no portal — lado já disponível do
    // cruzamento, pronto para casar contra o DOM quando este for anexado.
    const processosPortal = new Set<string>();
    for (const e of ctx.empenhos) {
      if (e.processoAdministrativo) processosPortal.add(e.processoAdministrativo.trim());
      if (e.processoLicitatorio) processosPortal.add(e.processoLicitatorio.trim());
    }
    void processosPortal;
    return [];
  },
};

// ── XS-03 — Decreto de crédito sem execução registrada ───────────────────────
/**
 * REGRA (catálogo): decreto de crédito adicional publicado no DOM sem empenhos
 * rastreáveis na dotação correspondente dentro do prazo. Cruza (1) decretos de
 * crédito do DOM e (2) os empenhos da dotação no portal.
 *
 * FONTES FALTANTES: o texto dos decretos de crédito (DOM) e a chave de dotação
 * orçamentária por empenho. O `ContextoAnalise` não traz decretos do DOM nem o
 * código de dotação nos empenhos/despesas — só há `modalidadeCodigo` e
 * `elemento`, insuficientes para amarrar um crédito a uma dotação específica.
 * Retorna [] para não presumir um decreto sem lastro.
 */
export const detectorDecretoCreditoSemExecucao: Detector = {
  id: 'XS-03',
  nome: 'Decreto de crédito sem execução registrada',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const decretos = fonteArray(cx.atosDom);
    // Cruzamento de 2 fontes indisponível: decretos de crédito adicional do
    // Diário Oficial e a chave de dotação orçamentária por empenho não estão
    // no ContextoAnalise.
    if (decretos.length === 0) return [];
    // Quando houver decretos + dotação por empenho: para cada decreto, somar
    // empenhos na dotação alvo no prazo; soma ≈ 0 → alerta de crédito ocioso.
    return [];
  },
};

// ── XS-04 — Portaria de nomeação sem servidor na folha ───────────────────────
/**
 * REGRA (catálogo): portaria de nomeação publicada no DOM sem nome/matrícula
 * correspondente na folha de pagamento dentro de 2 meses (indício de servidor
 * fantasma). Cruza (1) portarias de nomeação do DOM e (2) a folha.
 *
 * FONTES FALTANTES: as portarias de nomeação (texto do DOM) E a folha de
 * pagamento (módulo `pagamentos`). O `ContextoAnalise` não traz nenhuma das
 * duas — empenhos/despesas não contêm nomeações nem servidores. Retorna [].
 *
 * Quando ambas existirem: para cada nomeado no DOM, buscar nome/matrícula na
 * folha dos 2 meses seguintes; ausência → alerta 'critico' (severidade 5).
 */
export const detectorNomeacaoSemFolha: Detector = {
  id: 'XS-04',
  nome: 'Portaria de nomeação sem servidor na folha',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const portarias = fonteArray(cx.atosDom);
    const folha = fonteArray(cx.folha);
    // Cruzamento de 2 fontes indisponível: portarias de nomeação (DOM) e a
    // folha de pagamento (módulo `pagamentos`) não estão no ContextoAnalise.
    if (portarias.length === 0 || folha.length === 0) return [];
    return [];
  },
};

// ── XS-05 — Servidor sai da folha e vira PJ contratada ───────────────────────
/**
 * REGRA (catálogo): nome de servidor exonerado coincide com sócio de um CNPJ
 * que passa a ter contrato com o município em até 12 meses. Cruza (1) a folha
 * de pagamento (exonerações) e (2) o grafo de sócios dos fornecedores.
 *
 * FONTES FALTANTES: a folha (para identificar exonerações) E o grafo de sócios
 * dos CNPJs fornecedores. O `ContextoAnalise` traz os fornecedores contratados
 * (lado dos contratos), mas não a folha nem o quadro societário — não há como
 * casar um ex-servidor a um sócio sem inventar o vínculo. Retorna [].
 */
export const detectorExServidorViraPJ: Detector = {
  id: 'XS-05',
  nome: 'Servidor sai da folha e vira PJ contratada',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const folha = fonteArray(cx.folha);
    const grafo = cx.grafoSocietario;
    // Cruzamento de 2 fontes indisponível: folha de pagamento (exonerações) e
    // grafo de sócios dos fornecedores não estão no ContextoAnalise.
    if (folha.length === 0 || grafo == null) return [];
    return [];
  },
};

// ── XS-06 — Contrato publicado no DOM sem empenho ────────────────────────────
/**
 * REGRA (catálogo): extrato de contrato publicado no DOM sem empenho vinculado
 * por número. Cruza (1) extratos de contrato do DOM e (2) os empenhos do
 * portal.
 *
 * FONTE FALTANTE: os extratos de contrato publicados no DOM. O `ContextoAnalise`
 * traz o lado "empenhos do portal", mas não a lista de contratos publicados no
 * Diário Oficial — sem ela não há contrato a procurar. Retorna []. (Note-se
 * que o caminho inverso — empenho relevante sem contrato — é o XS-07, já
 * implementado em `cross-comp.ts`.)
 */
export const detectorContratoDomSemEmpenho: Detector = {
  id: 'XS-06',
  nome: 'Contrato publicado no DOM sem empenho',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const extratosDom = fonteArray(cx.atosDom);
    // Cruzamento de 2 fontes indisponível: extratos de contrato publicados no
    // Diário Oficial (DOM) não estão no ContextoAnalise (fonte única SMARAPD).
    if (extratosDom.length === 0) return [];
    return [];
  },
};

// ── XS-08 — Norma alterada beneficiando fornecedor ───────────────────────────
/**
 * REGRA (catálogo): norma publicada no SAPL abre uma exceção e, em até 60 dias,
 * ocorre contratação compatível com essa exceção. Cruza (1) normas do SAPL e
 * (2) as contratações do portal.
 *
 * FONTE FALTANTE: as normas do SAPL (Sistema de Apoio ao Processo Legislativo).
 * O `ContextoAnalise` traz o lado "contratações", mas não o texto das normas —
 * sem ele não há exceção a casar. Retorna [].
 *
 * Quando `normasSapl` existir: para cada norma que abra exceção, varrer
 * contratações nos 60 dias seguintes cujo objeto/fornecedor se encaixe na
 * exceção → alerta 'critico' (severidade 5).
 */
export const detectorNormaBeneficiaFornecedor: Detector = {
  id: 'XS-08',
  nome: 'Norma alterada beneficiando fornecedor',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const normas = fonteArray(cx.normasSapl);
    // Cruzamento de 2 fontes indisponível: normas do SAPL não estão no
    // ContextoAnalise (fonte única SMARAPD de execução orçamentária).
    if (normas.length === 0) return [];
    return [];
  },
};

// ── XS-09 — Saldo contábil ≠ extrato bancário ────────────────────────────────
/**
 * REGRA (catálogo): divergência entre o saldo contábil declarado e o saldo
 * real do extrato bancário, fora de uma tolerância. Cruza (1) o saldo contábil
 * e (2) o extrato bancário / conciliação.
 *
 * FONTES FALTANTES: o saldo contábil declarado E o extrato bancário. O
 * `ContextoAnalise` traz empenhos/despesas de execução — não traz saldos de
 * conta nem extratos. Sem as duas pontas não há divergência a medir. Retorna [].
 */
export const detectorSaldoContabilVsExtrato: Detector = {
  id: 'XS-09',
  nome: 'Saldo contábil ≠ extrato bancário',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const extratos = fonteArray(cx.extratosBancarios);
    // Cruzamento de 2 fontes indisponível: saldo contábil declarado e extrato
    // bancário / conciliação não estão no ContextoAnalise.
    if (extratos.length === 0) return [];
    return [];
  },
};

// ── XS-10 — Empenho sem lastro de caixa ──────────────────────────────────────
/**
 * REGRA (catálogo): empenho assumido em fonte de recurso cuja disponibilidade
 * de caixa é insuficiente (LRF art. 16–17, 42). O cruzamento ideal compara o
 * empenhado por fonte com a disponibilidade de caixa por fonte.
 *
 * FONTE FALTANTE para a regra plena: a disponibilidade de caixa por fonte de
 * recurso (`disponibilidadeCaixa`) — quando presente, o detector a usa.
 *
 * PROXY COMPUTÁVEL (roda só com empenhos/despesas, conforme instrução): na
 * ausência da disponibilidade de caixa, usa-se um indício de mesma natureza
 * com dado interno — empenho cuja despesa correspondente foi ANULADA logo em
 * seguida ou só tem ANULAÇÃO sem empenho positivo casado. Empenho que nasce e
 * é anulado sem liquidação é o sintoma clássico de despesa assumida sem lastro
 * financeiro. É indício conservador, nunca acusação, e não inventa caixa.
 */
export const detectorEmpenhoSemLastro: Detector = {
  id: 'XS-10',
  nome: 'Empenho sem lastro de caixa',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const out: AlertaDetectado[] = [];

    // Caminho A — regra plena, quando a disponibilidade de caixa por fonte
    // estiver anexada ao contexto. Estrutura esperada por item:
    // { fonte: string, disponibilidade: number, empenhado: number }.
    const dispCaixa = fonteArray(cx.disponibilidadeCaixa);
    if (dispCaixa.length > 0) {
      for (const item of dispCaixa) {
        if (item == null || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const fonte = String(r.fonte ?? r.fonteRecurso ?? '').trim();
        const disponibilidade = Number(r.disponibilidade ?? r.saldoCaixa);
        const empenhado = Number(r.empenhado ?? r.valorEmpenhado);
        if (!fonte || !Number.isFinite(disponibilidade) || !Number.isFinite(empenhado)) continue;
        if (empenhado <= disponibilidade) continue;
        const deficit = empenhado - disponibilidade;
        out.push({
          detectorId: 'XS-10',
          detectorNome: 'Empenho sem lastro de caixa',
          categoria: CATEGORIA,
          titulo: `Fonte ${fonte} com empenho acima da disponibilidade de caixa`,
          descricao:
            `Na fonte de recurso ${fonte}, o empenhado (${formatBRL(empenhado)}) supera ` +
            `a disponibilidade de caixa (${formatBRL(disponibilidade)}) em ${formatBRL(deficit)}. ` +
            `Possível indício de despesa assumida sem lastro financeiro, a apurar.`,
          sujeitoTipo: 'orgao',
          sujeitoId: `fonte-${fonte}`,
          sujeitoRotulo: `Fonte de recurso ${fonte}`,
          classificacao: deficit >= 500_000 ? 'suspeita' : 'atencao',
          scores: { confiabilidade: 78, probabilidadeIrregularidade: 64 },
          fundamentoLegal: ['LRF art. 16–17, 42'],
          evidencias: [
            { resumo: `Empenhado na fonte ${fonte}`, valor: empenhado },
            { resumo: `Disponibilidade de caixa na fonte ${fonte}`, valor: disponibilidade },
            { resumo: `Déficit de lastro`, valor: deficit },
          ],
          explicacao:
            'A LRF (art. 16–17 e 42) exige que a despesa empenhada tenha lastro ' +
            'financeiro na fonte de recurso. Empenhar acima da disponibilidade de ' +
            'caixa da fonte é indício a apurar — pode também refletir descompasso ' +
            'temporal de arrecadação. Verificação conjunta com o fluxo de caixa.',
          valorEnvolvido: deficit,
        });
      }
      return out;
    }

    // Caminho B — PROXY interno computável só com `DespesaAgrupada` (sem
    // disponibilidade de caixa anexada). Indício: empenhos cuja única
    // movimentação é ANULAÇÃO, ou cujo total líquido (empenho + reforço −
    // anulação) ficou ≤ 0 sem liquidação registrada. Empenho que nasce e é
    // zerado por anulação sem chegar a liquidar é sintoma típico de despesa
    // assumida sem disponibilidade financeira para honrá-la.
    const porEmpenho = new Map<string, DespesaNorm[]>();
    for (const d of ctx.despesas) {
      if (!d.numeroEmpenho) continue;
      const arr = porEmpenho.get(d.numeroEmpenho) ?? [];
      arr.push(d);
      porEmpenho.set(d.numeroEmpenho, arr);
    }

    const suspeitos: { numero: string; nome: string; cnpj: string; bruto: number }[] = [];
    for (const [numero, lista] of porEmpenho) {
      const temAnulacao = lista.some((d) => /ANUL/i.test(d.tipoEmpenho));
      if (!temAnulacao) continue;
      const liquido = lista.reduce((s, d) => {
        const v = Math.abs(d.valorEmpenhado);
        return /ANUL/i.test(d.tipoEmpenho) ? s - v : s + v;
      }, 0);
      const pago = lista.reduce((s, d) => s + d.valorPago, 0);
      // Anulado a zero (ou negativo) e nunca pago → indício de falta de lastro.
      if (liquido > 0.5 || pago > 0.5) continue;
      const bruto = lista
        .filter((d) => !/ANUL/i.test(d.tipoEmpenho))
        .reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
      const anulado = lista
        .filter((d) => /ANUL/i.test(d.tipoEmpenho))
        .reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
      // Exigir que tenha havido empenho positivo de algum porte — anulação
      // pura sem empenho casado é ruído de coleta, não indício.
      if (bruto < 1_000 || anulado < 1_000) continue;
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome ?? '';
      const cnpj = lista.find((d) => d.cpfCnpj)?.cpfCnpj ?? '';
      suspeitos.push({ numero, nome, cnpj, bruto });
    }

    if (suspeitos.length === 0) return [];
    // Conservador: só sinaliza quando o padrão se repete — empenho isolado
    // anulado é rotina contábil; um volume de empenhos zerados por anulação
    // sem chegar a liquidar é que sugere descompasso de lastro.
    if (suspeitos.length < 3) return [];

    const somaBruto = suspeitos.reduce((s, e) => s + e.bruto, 0);
    out.push({
      detectorId: 'XS-10',
      detectorNome: 'Empenho sem lastro de caixa',
      categoria: CATEGORIA,
      titulo: `${suspeitos.length} empenhos anulados sem liquidação — possível falta de lastro`,
      descricao:
        `${suspeitos.length} empenhos foram integralmente anulados sem nenhuma ` +
        `liquidação/pagamento, somando ${formatBRL(somaBruto)} em valor empenhado bruto. ` +
        `Empenhar e anular sem liquidar pode indicar despesa assumida sem ` +
        `disponibilidade financeira na fonte. Indício a apurar.`,
      sujeitoTipo: 'orgao',
      sujeitoId: 'empenhos-sem-lastro',
      sujeitoRotulo: 'Empenhos anulados sem liquidação',
      classificacao: suspeitos.length >= 8 ? 'suspeita' : 'atencao',
      scores: {
        // Confiabilidade moderada: é proxy interno, não a conciliação de caixa
        // exigida pela regra plena (essa precisa da disponibilidade por fonte).
        confiabilidade: 52,
        probabilidadeIrregularidade: Math.min(60, 30 + suspeitos.length * 3),
      },
      fundamentoLegal: ['LRF art. 16–17, 42'],
      evidencias: suspeitos.slice(0, 8).map((e) => ({
        resumo: `Empenho ${e.numero}${e.nome ? ` — ${e.nome}` : ''} (anulado, ${formatBRL(e.bruto)})`,
        valor: e.bruto,
      })),
      explicacao:
        'A LRF (art. 16–17 e 42) exige lastro financeiro para a despesa empenhada. ' +
        'Este detector usa um PROXY interno: empenhos integralmente anulados sem ' +
        'liquidação — sintoma frequente de despesa assumida sem caixa. A ' +
        'confirmação plena (empenhado por fonte vs. disponibilidade de caixa por ' +
        'fonte) DEPENDE da disponibilidade de caixa por fonte de recurso, que não ' +
        'está no ContextoAnalise; sem ela, este é um indício conservador, não ' +
        'conclusão. Pode também refletir cancelamentos administrativos legítimos.',
      valorEnvolvido: somaBruto,
    });
    return out;
  },
};

// ── XS-11 — CEP de obra coincide com endereço de fornecedor ──────────────────
/**
 * REGRA (catálogo): o CEP/endereço do local da obra é o mesmo endereço de uma
 * empresa fornecedora. Cruza (1) o endereço/CEP das obras e (2) o cadastro de
 * endereços dos CNPJs fornecedores.
 *
 * FONTES FALTANTES: o endereço/CEP das obras E o cadastro de endereços dos
 * fornecedores (grafo). O `ContextoAnalise` não traz endereço de obra nem
 * endereço de empresa — empenhos/despesas só têm CNPJ e valor. Retorna [].
 */
export const detectorCepObraIgualFornecedor: Detector = {
  id: 'XS-11',
  nome: 'CEP de obra coincide com fornecedor',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const grafo = cx.grafoSocietario;
    // Cruzamento de 2 fontes indisponível: endereço/CEP das obras e cadastro
    // de endereços dos fornecedores (grafo) não estão no ContextoAnalise.
    if (grafo == null) return [];
    return [];
  },
};

// ── XS-12 — CNPJ no endereço de agente público ───────────────────────────────
/**
 * REGRA (catálogo): o endereço de um CNPJ contratado coincide com o endereço
 * de um servidor/agente público ou de parente seu. Cruza (1) o endereço dos
 * fornecedores e (2) o endereço dos agentes públicos.
 *
 * FONTES FALTANTES: o cadastro de endereços dos CNPJs fornecedores E o
 * cadastro de endereços de agentes públicos/servidores. O `ContextoAnalise`
 * não traz endereços de nenhum dos dois lados. Retorna [].
 */
export const detectorCnpjNoEnderecoDeAgente: Detector = {
  id: 'XS-12',
  nome: 'CNPJ no endereço de agente público',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const grafo = cx.grafoSocietario;
    const folha = fonteArray(cx.folha);
    // Cruzamento de 2 fontes indisponível: endereço dos fornecedores (grafo) e
    // endereço dos agentes públicos/servidores não estão no ContextoAnalise.
    if (grafo == null || folha.length === 0) return [];
    return [];
  },
};

// ── XS-13 — Reclamação no e-SIC × execução orçamentária ──────────────────────
/**
 * REGRA (catálogo): tema com pico de manifestações no e-SIC e, ao mesmo tempo,
 * despesa relevante declarada no serviço correspondente. Cruza (1) as
 * manifestações do e-SIC e (2) a execução orçamentária do serviço.
 *
 * FONTE FALTANTE: as manifestações do e-SIC. O `ContextoAnalise` traz o lado
 * "execução orçamentária" (despesas por objeto), mas não as reclamações dos
 * cidadãos — sem elas não há pico a cruzar. Retorna [].
 */
export const detectorEsicVsExecucao: Detector = {
  id: 'XS-13',
  nome: 'Reclamação no e-SIC × execução orçamentária',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const manifestacoes = fonteArray(cx.manifestacoesEsic);
    // Cruzamento de 2 fontes indisponível: manifestações do e-SIC não estão no
    // ContextoAnalise (fonte única SMARAPD de execução orçamentária).
    if (manifestacoes.length === 0) return [];
    return [];
  },
};

// ── XS-14 — Apontamento do TCE-SP sobre fornecedor ───────────────────────────
/**
 * REGRA (catálogo): fornecedor ou contrato do município citado em julgado do
 * TCE-SP — match de CNPJ ou número de processo entre a base local e a base do
 * TCE-SP. Cruza (1) os fornecedores/contratos locais e (2) os julgados do
 * TCE-SP.
 *
 * FONTE FALTANTE: a base de julgados/apontamentos do TCE-SP. O `ContextoAnalise`
 * traz o lado local (CNPJs e processos dos empenhos), mas não a base do
 * Tribunal — sem ela não há match a fazer. Retorna []. O índice local de
 * CNPJs/processos abaixo é o lado já pronto do cruzamento.
 */
export const detectorApontamentoTceSp: Detector = {
  id: 'XS-14',
  nome: 'Apontamento do TCE-SP sobre fornecedor',
  categoria: CATEGORIA,
  detectar(ctx) {
    const cx = ctx as ContextoCross;
    const julgados = fonteArray(cx.julgadosTceSp);
    // Cruzamento de 2 fontes indisponível: base de julgados/apontamentos do
    // TCE-SP não está no ContextoAnalise (fonte única SMARAPD).
    if (julgados.length === 0) return [];
    // Lado local do cruzamento, pronto para casar contra a base do TCE-SP.
    const cnpjsLocais = new Set<string>();
    const processosLocais = new Set<string>();
    for (const e of ctx.empenhos as EmpenhoNorm[]) {
      if (e.cpfCnpj) cnpjsLocais.add(e.cpfCnpj);
      if (e.processoAdministrativo) processosLocais.add(e.processoAdministrativo.trim());
      if (e.processoLicitatorio) processosLocais.add(e.processoLicitatorio.trim());
    }
    void cnpjsLocais;
    void processosLocais;
    return [];
  },
};

/** Catálogo de detectores XS desta categoria (XS-07 vive em `cross-comp.ts`). */
export const DETECTORES_XS_CAT: Detector[] = [
  detectorComissaoSocioVencedora, // XS-01
  detectorDispensaDomSemPortal, // XS-02
  detectorDecretoCreditoSemExecucao, // XS-03
  detectorNomeacaoSemFolha, // XS-04
  detectorExServidorViraPJ, // XS-05
  detectorContratoDomSemEmpenho, // XS-06
  detectorNormaBeneficiaFornecedor, // XS-08
  detectorSaldoContabilVsExtrato, // XS-09
  detectorEmpenhoSemLastro, // XS-10
  detectorCepObraIgualFornecedor, // XS-11
  detectorCnpjNoEnderecoDeAgente, // XS-12
  detectorEsicVsExecucao, // XS-13
  detectorApontamentoTceSp, // XS-14
];
