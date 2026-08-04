/**
 * Detectores do catálogo — FOLHA, CARGOS E TERCEIRIZADOS (FP) e
 * RECEITA E RENÚNCIA (RC).
 *
 * Materializa como `Detector` os monitoramentos do catálogo-mestre
 * (src/lib/nexo/catalogo-completo.ts §8 e §14):
 *
 *  FP-02 — Gratificações inflando o líquido.
 *  FP-03 — CPF duplicado ou inválido.
 *  FP-04 — Múltiplas matrículas simultâneas.
 *  FP-05 — Acúmulo ilegal de cargos.
 *  FP-07 — Nepotismo (mesmo sobrenome do gestor).
 *  FP-08 — Nepotismo cruzado (indício).
 *  FP-10 — Rotatividade anormal de secretários.
 *  FP-11 — Despesa de pessoal em alta vs. receita.
 *  FP-12 — Horas extras concentradas.
 *  FP-13 — Terceirizado sem lista nominal / sem local.
 *  FP-14 — Terceirizado vinculado a mais de um contrato.
 *  RC-03 — Renúncia de receita sem estimativa de impacto.
 *  RC-04 — Dívida ativa estagnada.
 *  RC-06 — Lançamento de receita inconsistente entre fontes.
 *
 * HONESTIDADE DE DADO. O `ContextoAnalise` do pipeline `rodarDetectores`
 * traz apenas `empenhos`, `despesas`, `diarias`, `modalidades` e
 * `restosAPagar` de um único exercício. Ele NÃO traz:
 *   - a folha individualizada (`ServidorNorm` — módulo `pagamentos` /
 *     `folha_pagamento_detalhes` da API SMARAPD), necessária para
 *     FP-02, FP-03, FP-04, FP-05, FP-07, FP-08, FP-10 e FP-12;
 *   - séries multi-exercício de despesa de pessoal e receita realizada,
 *     necessárias para FP-11;
 *   - séries de renúncia/benefício fiscal, estoque de dívida ativa e a
 *     receita reportada ao SICONFI (RREO), necessárias para RC-03,
 *     RC-04 e RC-06.
 *
 * Os detectores cuja fonte está ausente retornam `[]` — com comentário
 * nomeando a fonte que falta — em vez de inventar dado ou gerar falso
 * positivo. Os que SÃO computáveis sobre `despesas`/`empenhos` (FP-13 e
 * FP-14, sobre empenhos de terceirização) rodam de verdade, com limiares
 * conservadores. Todo alerta é INDÍCIO a apurar, nunca acusação
 * (ver docs/nexo-plano-mestre.md §6–§7).
 */
import { formatBRL, type DespesaNorm } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

const CAT_FP = 'Folha, cargos e terceirizados';
const CAT_RC = 'Receita e renúncia';

/** Reconhece um objeto/elemento de despesa como terceirização de mão de obra. */
const RE_TERCEIRIZACAO =
  /terceiri[zs]|m[aã]o\s*de\s*obra|m[aã]o-de-obra|posto(?:s)?\s+de\s+(?:trabalho|servi)|loca[çc][aã]o\s+de\s+m[aã]o|presta[çc][aã]o\s+de\s+servi[çc]os?\s+(?:cont[ií]nuos?|de\s+limpeza|de\s+vigil[aâ]nc|de\s+conserva|de\s+portaria|de\s+seguran[çc]a|de\s+apoio)/i;

/** Termos de objeto que indicam um contrato continuado de pessoal terceirizado. */
const RE_OBJETO_PESSOAL_TERC =
  /limpeza|conserva[çc][aã]o|vigil[aâ]ncia|seguran[çc]a|portaria|copeira|recep[çc]|apoio\s+administrativo|m[aã]o\s*de\s*obra/i;

/** Soma absoluta de uma lista de despesas. */
function somaAbs(lista: DespesaNorm[]): number {
  return lista.reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// FP-02 — Gratificações inflando o líquido
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: `(vencimentos − salário base) / salário base > 0,70`.
 *
 * FONTE AUSENTE: exige a folha individualizada com a decomposição entre
 * salário base e gratificações/vantagens — módulo `pagamentos` /
 * `folha_pagamento_detalhes` da API SMARAPD. O `ServidorNorm` traz apenas
 * `vencimentos` totais (sem o salário base isolado) e não está no
 * `ContextoAnalise`. Sem esses dois componentes não há como computar a
 * proporção de gratificações — retorna [] aguardando a folha detalhada.
 */
export const detectorGratificacoesInflando: Detector = {
  id: 'FP-02',
  nome: 'Gratificações inflando o líquido',
  categoria: CAT_FP,
  detectar(): AlertaDetectado[] {
    // Sem fonte: folha individualizada com salário base x gratificações
    // (módulo `folha_pagamento_detalhes` / `pagamentos` da SMARAPD) não
    // integra o ContextoAnalise. Não há proxy honesta em `despesas`.
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FP-03 — CPF duplicado ou inválido
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: CPF repetido entre matrículas distintas OU dígito
 * verificador inválido.
 *
 * `validarCPF` fica implementado e pronto para uso assim que a folha
 * individualizada entrar no contexto.
 *
 * FONTE AUSENTE: a verificação cruza CPF entre matrículas da folha — módulo
 * `pagamentos` da API SMARAPD (`ServidorNorm`), que NÃO está no
 * `ContextoAnalise`. Os `empenhos`/`despesas` trazem CPF/CNPJ de
 * fornecedores, não de servidores — usá-los aqui seria descontextualizar o
 * monitoramento. Retorna [] aguardando a folha.
 */
export const detectorCpfDuplicadoInvalido: Detector = {
  id: 'FP-03',
  nome: 'CPF duplicado ou inválido',
  categoria: CAT_FP,
  detectar(): AlertaDetectado[] {
    // Sem fonte: cadastro de servidores da folha (`pagamentos`/`ServidorNorm`)
    // não integra o ContextoAnalise — sem ele não há universo de matrículas
    // a cruzar nem campo de CPF de servidor a validar.
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FP-04 — Múltiplas matrículas simultâneas
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: mesmo CPF com ≥2 matrículas ativas no mesmo mês.
 *
 * FONTE AUSENTE: exige a folha individualizada com CPF, matrícula e mês de
 * competência por vínculo — módulo `pagamentos` (`ServidorNorm`), fora do
 * `ContextoAnalise`. Retorna [] aguardando a folha.
 */
export const detectorMultiplasMatriculas: Detector = {
  id: 'FP-04',
  nome: 'Múltiplas matrículas simultâneas',
  categoria: CAT_FP,
  detectar(): AlertaDetectado[] {
    // Sem fonte: vínculos individualizados da folha (`pagamentos`/
    // `ServidorNorm`) não integram o ContextoAnalise.
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FP-05 — Acúmulo ilegal de cargos
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: par de cargos do mesmo CPF fora das exceções
 * constitucionais (CF art. 37 XVI–XVII — só são admitidos certos pares,
 * p.ex. dois cargos de professor, ou um de professor com um técnico/
 * científico, ou dois privativos de saúde com profissão regulamentada).
 *
 * FONTE AUSENTE: exige a folha individualizada com CPF + cargo por vínculo —
 * módulo `pagamentos` (`ServidorNorm`), fora do `ContextoAnalise`. Sem o
 * universo de servidores e seus cargos não há par a classificar. Retorna []
 * aguardando a folha.
 */
export const detectorAcumuloCargos: Detector = {
  id: 'FP-05',
  nome: 'Acúmulo ilegal de cargos',
  categoria: CAT_FP,
  detectar(): AlertaDetectado[] {
    // Sem fonte: cargos por servidor da folha (`pagamentos`/`ServidorNorm`)
    // não integram o ContextoAnalise.
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FP-07 — Nepotismo (mesmo sobrenome do gestor)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: sobrenome do comissionado coincide com o do agente
 * político + provimento por livre escolha (Súmula Vinculante 13).
 *
 * FONTE AUSENTE — dupla: (1) a folha individualizada com nome, cargo e
 * natureza do provimento dos comissionados (módulo `pagamentos` /
 * `ServidorNorm`); e (2) o cadastro de agentes políticos (gestor e
 * secretários) com seus nomes completos. Nenhuma das duas está no
 * `ContextoAnalise`. Retorna [] aguardando essas fontes.
 */
export const detectorNepotismoSobrenome: Detector = {
  id: 'FP-07',
  nome: 'Nepotismo (mesmo sobrenome do gestor)',
  categoria: CAT_FP,
  detectar(): AlertaDetectado[] {
    // Sem fonte: folha de comissionados (`pagamentos`/`ServidorNorm`) e
    // cadastro de agentes políticos do município — ambos fora do
    // ContextoAnalise.
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FP-08 — Nepotismo cruzado (indício)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: grafo de sobrenomes detectando troca cruzada de
 * parentes entre gabinetes (designações recíprocas — SV 13).
 *
 * FONTE AUSENTE: exige a folha individualizada de comissionados com nome e
 * lotação/gabinete (módulo `pagamentos` / `ServidorNorm`) e o cadastro de
 * agentes políticos por gabinete — para montar o grafo de sobrenomes. Nada
 * disso está no `ContextoAnalise`. Retorna [] aguardando essas fontes.
 */
export const detectorNepotismoCruzado: Detector = {
  id: 'FP-08',
  nome: 'Nepotismo cruzado (indício)',
  categoria: CAT_FP,
  detectar(): AlertaDetectado[] {
    // Sem fonte: folha de comissionados por gabinete (`pagamentos`/
    // `ServidorNorm`) e cadastro de agentes políticos — fora do
    // ContextoAnalise.
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FP-10 — Rotatividade anormal de secretários
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: ≥3 trocas de titular na mesma secretaria em 12 meses.
 *
 * FONTE AUSENTE: a contagem de trocas de titular depende das portarias de
 * nomeação/exoneração de secretários publicadas no Diário Oficial (módulo
 * de atos do DOM) ou de um cadastro histórico de titulares. O
 * `ContextoAnalise` traz apenas execução financeira (empenhos/despesas), e
 * a unidade gestora (`unidadeGestora`) identifica a secretaria como ente de
 * gasto, não o seu titular ao longo do tempo. Retorna [] aguardando a fonte
 * de atos de pessoal do DOM.
 */
export const detectorRotatividadeSecretarios: Detector = {
  id: 'FP-10',
  nome: 'Rotatividade anormal de secretários',
  categoria: CAT_FP,
  detectar(): AlertaDetectado[] {
    // Sem fonte: histórico de titulares de secretaria (portarias de
    // nomeação/exoneração no DOM) não integra o ContextoAnalise.
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FP-11 — Despesa de pessoal em alta vs. receita
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: `crescimento% folha(12m) − crescimento% receita(12m) >
 * tolerância` (LRF art. 19–20).
 *
 * FONTE AUSENTE: a regra exige série de pelo menos dois exercícios da
 * despesa de pessoal (módulo `pagamentos` consolidado) E da receita
 * realizada. O `ContextoAnalise` cobre um único exercício e não traz a
 * folha consolidada nem a receita — sem dois pontos no tempo não há
 * crescimento % a comparar. Retorna [] aguardando essas séries.
 */
export const detectorPessoalEmAltaVsReceita: Detector = {
  id: 'FP-11',
  nome: 'Despesa de pessoal em alta vs. receita',
  categoria: CAT_FP,
  detectar(): AlertaDetectado[] {
    // Sem fonte: série multi-exercício de despesa de pessoal (`pagamentos`
    // consolidado) e de receita realizada — o ContextoAnalise é de um único
    // exercício e não inclui nenhuma das duas.
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FP-12 — Horas extras concentradas
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: um setor/servidor concentra fatia anormal das horas
 * extras pagas (LRF art. 22).
 *
 * FONTE AUSENTE: a verba de horas extras é uma rubrica da folha
 * individualizada — exige o módulo `folha_pagamento_detalhes` / `pagamentos`
 * da SMARAPD com o desdobramento por verba e por servidor/setor. O
 * `ContextoAnalise` não traz a folha detalhada. Retorna [] aguardando essa
 * fonte.
 */
export const detectorHorasExtrasConcentradas: Detector = {
  id: 'FP-12',
  nome: 'Horas extras concentradas',
  categoria: CAT_FP,
  detectar(): AlertaDetectado[] {
    // Sem fonte: rubrica de horas extras por servidor/setor da folha
    // detalhada (`folha_pagamento_detalhes`/`pagamentos`) não integra o
    // ContextoAnalise.
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FP-13 — Terceirizado sem lista nominal / sem local  [COMPUTÁVEL]
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: contrato de terceirização de mão de obra sem relação
 * nominal de trabalhadores ou sem posto de trabalho definido (Lei
 * 14.133/2021 art. 117; Súmula TST 331).
 *
 * COMPUTÁVEL com a melhor proxy honesta disponível em `despesas`: a lista
 * nominal e o posto de trabalho NÃO estão no portal — o que se pode medir é
 * a presença de empenhos de terceirização de mão de obra (objeto/elemento
 * compatível) cujo registro não traz processo/objeto detalhado o suficiente
 * para que a relação nominal e o posto sejam rastreáveis. Por isso o
 * detector roda de verdade sobre `despesas`, mas a classificação é de
 * "atenção" e a confiabilidade moderada — a confirmação da ausência da
 * lista nominal exige o processo de contratação completo.
 *
 * Conservador: só entram despesas de valor relevante cujo objeto é
 * inequivocamente de terceirização de pessoal e cujo campo de objeto é
 * genérico (sem o detalhamento que permitiria localizar postos/nominais).
 */
const LIMIAR_FP13 = 50_000;

export const detectorTerceirizadoSemLista: Detector = {
  id: 'FP-13',
  nome: 'Terceirizado sem lista nominal / sem local',
  categoria: CAT_FP,
  detectar(ctx) {
    const out: AlertaDetectado[] = [];

    // Empenhos de terceirização de mão de obra: objeto OU bem/serviço
    // descreve prestação de serviço continuado de pessoal.
    const terceirizacao = ctx.despesas.filter((d) => {
      if (d.valorEmpenhado <= 0) return false;
      const texto = `${d.objeto} ${d.bemOuServico}`;
      return RE_TERCEIRIZACAO.test(texto) && RE_OBJETO_PESSOAL_TERC.test(texto);
    });
    if (terceirizacao.length === 0) return [];

    // Proxy de "sem lista nominal / sem local": objeto genérico (curto, sem
    // indicação de unidade/posto/quantitativo). Só sinaliza os relevantes.
    const semDetalhe = terceirizacao.filter((d) => {
      if (Math.abs(d.valorEmpenhado) < LIMIAR_FP13) return false;
      const obj = d.objeto.trim();
      const temPosto =
        /\d+\s*(?:posto|funcion|colaborad|trabalhador|profissional)/i.test(obj) ||
        /\bunidade|\bsecretaria|\bescola|\bUBS|\bhospital|\bcreche|\bpra[çc]a|\bpr[eé]dio/i.test(
          obj,
        );
      // Objeto curto ou sem qualquer marcador de posto/local: não rastreável.
      return obj.length < 80 || !temPosto;
    });
    if (semDetalhe.length === 0) return [];

    // Agrupa por fornecedor — um contrato de terceirização = um CNPJ.
    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of semDetalhe) {
      const chave = d.cpfCnpj || `sem-cnpj-${d.id}`;
      const arr = porCnpj.get(chave) ?? [];
      arr.push(d);
      porCnpj.set(chave, arr);
    }

    for (const [chave, lista] of porCnpj) {
      const soma = somaAbs(lista);
      if (soma < LIMIAR_FP13) continue;
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || chave;
      out.push({
        detectorId: 'FP-13',
        detectorNome: 'Terceirizado sem lista nominal / sem local',
        categoria: CAT_FP,
        titulo: `Terceirização de mão de obra sem detalhamento rastreável — ${nome}`,
        descricao:
          `${lista.length} empenho(s) de terceirização de mão de obra somando ` +
          `${formatBRL(soma)} cujo registro não traz relação nominal de ` +
          `trabalhadores nem posto/local definido de forma rastreável. ` +
          `Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: lista[0].cpfCnpj || chave,
        sujeitoRotulo: nome,
        classificacao: soma >= 500_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 50,
          probabilidadeIrregularidade: Math.min(60, 32 + lista.length * 5),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 117', 'Súmula TST 331'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo:
            `Empenho ${d.numeroEmpenho || d.id} — ${formatBRL(Math.abs(d.valorEmpenhado))}` +
            `${d.objeto ? ` (${d.objeto})` : ''}`,
          valor: Math.abs(d.valorEmpenhado),
          data: d.data,
        })),
        explicacao:
          'Contratos de terceirização de mão de obra devem ter relação nominal ' +
          'dos trabalhadores e posto/local de prestação definidos, para permitir ' +
          'a fiscalização do contrato (Lei 14.133/2021 art. 117) e afastar o risco ' +
          'de responsabilidade subsidiária (Súmula TST 331). Empenhos de ' +
          'terceirização cujo registro não traz esse detalhamento são possível ' +
          'indício a apurar. DEPENDÊNCIA: a confirmação da ausência da lista ' +
          'nominal exige o processo de contratação completo — fora do contexto ' +
          'desta análise; aqui usa-se a ausência de detalhamento no empenho como proxy.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FP-14 — Terceirizado vinculado a mais de um contrato  [PARCIALMENTE COMPUTÁVEL]
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: mesmo CPF de trabalhador terceirizado aparece em ≥2
 * contratos vigentes ao mesmo tempo (Lei 8.429/1992; fraude documental).
 *
 * A regra exata exige a RELAÇÃO NOMINAL de terceirizados por contrato — que
 * NÃO está no portal de transparência (a despesa registra o CNPJ da empresa
 * prestadora, não os CPFs dos trabalhadores alocados). Por isso o
 * cruzamento por CPF de trabalhador não é computável aqui.
 *
 * O que É computável de forma honesta e relacionada: sinalizar quando a
 * MESMA empresa de terceirização de mão de obra mantém vários contratos/
 * empenhos simultâneos com a Administração — situação que, somada à ausência
 * de relação nominal, eleva o risco de um mesmo trabalhador ser faturado em
 * mais de um contrato. É um indício de SEGUNDA ordem (sobre a empresa, não
 * sobre o trabalhador) — classificação "atenção", confiabilidade moderada,
 * e a explicação deixa explícita a fonte que falta.
 *
 * Conservador: exige ≥2 empenhos de terceirização de pessoal do mesmo CNPJ
 * com soma relevante.
 */
const LIMIAR_FP14 = 100_000;
const MIN_CONTRATOS_FP14 = 2;

export const detectorTerceirizadoMultiContrato: Detector = {
  id: 'FP-14',
  nome: 'Terceirizado vinculado a mais de um contrato',
  categoria: CAT_FP,
  detectar(ctx) {
    const out: AlertaDetectado[] = [];

    // Empenhos de terceirização de mão de obra do exercício.
    const terceirizacao = ctx.despesas.filter((d) => {
      if (d.valorEmpenhado <= 0 || !d.cpfCnpj) return false;
      const texto = `${d.objeto} ${d.bemOuServico}`;
      return RE_TERCEIRIZACAO.test(texto) && RE_OBJETO_PESSOAL_TERC.test(texto);
    });
    if (terceirizacao.length === 0) return [];

    // Agrupa por empresa prestadora (CNPJ).
    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of terceirizacao) {
      const arr = porCnpj.get(d.cpfCnpj) ?? [];
      arr.push(d);
      porCnpj.set(d.cpfCnpj, arr);
    }

    for (const [cnpj, lista] of porCnpj) {
      // Contratos/empenhos distintos = números de empenho distintos.
      const contratos = new Set(
        lista.map((d) => d.numeroEmpenho).filter((n) => /\d/.test(n)),
      );
      if (contratos.size < MIN_CONTRATOS_FP14) continue;
      const soma = somaAbs(lista);
      if (soma < LIMIAR_FP14) continue;
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || cnpj;

      out.push({
        detectorId: 'FP-14',
        detectorNome: 'Terceirizado vinculado a mais de um contrato',
        categoria: CAT_FP,
        titulo: `Empresa de terceirização com vários contratos simultâneos — ${nome}`,
        descricao:
          `${contratos.size} empenho(s)/contrato(s) de terceirização de mão de ` +
          `obra com a mesma empresa, somando ${formatBRL(soma)}. Indício de ` +
          `segunda ordem para o risco de um terceirizado faturado em mais de um ` +
          `contrato — a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao: contratos.size >= 4 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 44,
          probabilidadeIrregularidade: Math.min(54, 26 + contratos.size * 5),
        },
        fundamentoLegal: ['Lei 8.429/1992', 'Lei 14.133/2021 art. 117'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo:
            `Empenho ${d.numeroEmpenho || d.id} — ${formatBRL(Math.abs(d.valorEmpenhado))}` +
            `${d.objeto ? ` (${d.objeto})` : ''}`,
          valor: Math.abs(d.valorEmpenhado),
          data: d.data,
        })),
        explicacao:
          'A mesma empresa de terceirização de mão de obra mantém vários ' +
          'contratos/empenhos simultâneos com a Administração. Sem a relação ' +
          'nominal dos trabalhadores por contrato, há risco de um mesmo ' +
          'terceirizado ser alocado e faturado em mais de um contrato vigente. ' +
          'DEPENDÊNCIA: a regra exata do catálogo cruza CPFs de trabalhadores ' +
          'terceirizados entre contratos — esse dado NÃO está no portal de ' +
          'transparência (a despesa registra apenas o CNPJ da empresa). Este ' +
          'alerta é um indício de segunda ordem, a confirmar com a relação ' +
          'nominal de terceirizados de cada contrato.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// RC-03 — Renúncia de receita sem estimativa de impacto
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: norma que concede benefício/renúncia fiscal (anistia,
 * remissão, isenção, redução de base de cálculo etc.) sem a estimativa de
 * impacto orçamentário-financeiro exigida pela LRF (art. 14).
 *
 * FONTE AUSENTE: depende (1) das normas de renúncia fiscal — leis/decretos
 * publicados no Diário Oficial ou no SAPL — e (2) do anexo de estimativa de
 * impacto que deveria acompanhá-las. O `ContextoAnalise` traz apenas
 * execução de despesa (empenhos/despesas), não normas tributárias nem
 * demonstrativos de renúncia. Retorna [] aguardando essas fontes.
 */
export const detectorRenunciaSemEstimativa: Detector = {
  id: 'RC-03',
  nome: 'Renúncia de receita sem estimativa de impacto',
  categoria: CAT_RC,
  detectar(): AlertaDetectado[] {
    // Sem fonte: normas de renúncia fiscal (DOM/SAPL) e o demonstrativo de
    // estimativa de impacto da LRF — nenhum integra o ContextoAnalise.
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// RC-04 — Dívida ativa estagnada
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: estoque de dívida ativa cresce enquanto a arrecadação
 * de dívida ativa permanece ≈ 0 — indício de inércia na cobrança (LRF
 * art. 11 e 13; Lei 8.429/1992).
 *
 * FONTE AUSENTE: exige (1) a série do estoque de dívida ativa inscrita e
 * (2) a receita realizada na rubrica "dívida ativa". O `ContextoAnalise`
 * cobre execução de DESPESA de um único exercício e não traz nenhuma série
 * de receita nem o estoque de dívida ativa (esses vêm do balanço/SICONFI
 * ou do módulo de receita do portal). Retorna [] aguardando essas séries.
 */
export const detectorDividaAtivaEstagnada: Detector = {
  id: 'RC-04',
  nome: 'Dívida ativa estagnada',
  categoria: CAT_RC,
  detectar(): AlertaDetectado[] {
    // Sem fonte: estoque de dívida ativa inscrita e arrecadação de dívida
    // ativa (módulo de receita do portal / balanço-SICONFI) não integram o
    // ContextoAnalise, que só traz execução de despesa.
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// RC-06 — Lançamento de receita inconsistente entre fontes
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: a receita total do portal de transparência diverge da
 * receita reportada ao SICONFI (RREO) no mesmo período (LRF art. 51; LC
 * 131/2009).
 *
 * FONTE AUSENTE: o cruzamento exige DUAS fontes de receita — a receita
 * realizada do portal de transparência E a receita do RREO publicada no
 * SICONFI. O `ContextoAnalise` não traz nenhuma das duas (cobre apenas a
 * execução de despesa do exercício). Retorna [] aguardando ambas as séries
 * de receita.
 */
export const detectorReceitaInconsistenteEntreFontes: Detector = {
  id: 'RC-06',
  nome: 'Lançamento de receita inconsistente entre fontes',
  categoria: CAT_RC,
  detectar(): AlertaDetectado[] {
    // Sem fonte: receita realizada do portal e receita do RREO/SICONFI — o
    // ContextoAnalise não traz nenhuma série de receita, apenas despesa.
    return [];
  },
};

/**
 * Detectores de FOLHA/CARGOS/TERCEIRIZADOS (FP) e RECEITA/RENÚNCIA (RC)
 * materializados a partir do catálogo-mestre. FP-13 e FP-14 rodam sobre
 * `despesas` (empenhos de terceirização); os demais retornam [] enquanto a
 * fonte de dados necessária (folha individualizada, séries de receita,
 * normas de renúncia, dívida ativa, SICONFI) não integra o ContextoAnalise
 * — ver o comentário de cada detector.
 */
export const DETECTORES_FR_CAT: Detector[] = [
  detectorGratificacoesInflando, // FP-02
  detectorCpfDuplicadoInvalido, // FP-03
  detectorMultiplasMatriculas, // FP-04
  detectorAcumuloCargos, // FP-05
  detectorNepotismoSobrenome, // FP-07
  detectorNepotismoCruzado, // FP-08
  detectorRotatividadeSecretarios, // FP-10
  detectorPessoalEmAltaVsReceita, // FP-11
  detectorHorasExtrasConcentradas, // FP-12
  detectorTerceirizadoSemLista, // FP-13  [computável]
  detectorTerceirizadoMultiContrato, // FP-14  [computável]
  detectorRenunciaSemEstimativa, // RC-03
  detectorDividaAtivaEstagnada, // RC-04
  detectorReceitaInconsistenteEntreFontes, // RC-06
];
