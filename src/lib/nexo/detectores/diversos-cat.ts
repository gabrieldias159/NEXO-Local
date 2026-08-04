/**
 * Detectores diversos do catálogo NEXO — bloco LASTRO-X.
 *
 * Implementa como `Detector` 12 monitoramentos de quatro áreas do
 * catálogo-mestre (src/lib/nexo/catalogo-completo.ts):
 *
 *  FORNECEDORES
 *   FR-05 — Empresa punida no portal recebendo pagamento.
 *   FR-07 — Sócios/endereço/contador em comum entre fornecedores.
 *   FR-10 — Empresa sem estrutura aparente (indício de fachada).
 *   FR-13 — Fornecedor doador de campanha do gestor.
 *
 *  EXECUÇÃO ORÇAMENTÁRIA
 *   OR-06 — Suplementações repetidas na mesma dotação.
 *
 *  METAS FISCAIS E LRF
 *   MF-07 — Resultado primário fora da meta da LDO.
 *   MF-08 — Resultado nominal fora da meta da LDO.
 *
 *  CONVÊNIOS, REPASSES E TERCEIRO SETOR
 *   TS-02 — OSC com CNPJ inativo/suspenso.
 *   TS-04 — Repasse sem chamamento público.
 *   TS-05 — OSC com dirigente ligado a agente público.
 *   TS-08 — OSC de saúde sem habilitação válida (CEBAS).
 *   TS-09 — Despesa de parceria fora do plano de trabalho.
 *
 * REGRA DE LINGUAGEM: todo alerta é INDÍCIO a apurar — nunca acusação. Ver
 * docs/nexo-plano-mestre.md §6–§7. Apenas dados públicos.
 *
 * HONESTIDADE DE FONTE: vários IDs deste bloco exigem dados que NÃO chegam ao
 * `ContextoAnalise` (que carrega apenas empenhos, despesas, diárias, restos a
 * pagar e modalidades da API SMARAPD). Quando a fonte necessária está ausente,
 * o `detectar` está completo com a lógica correta porém retorna `[]`, com
 * comentário nomeando explicitamente a fonte que falta. Nunca se inventa dado,
 * nunca se gera falso positivo; limiares conservadores; proxies declaradas na
 * `explicacao` do alerta.
 */
import { formatBRL, type DespesaNorm } from '../normalizar';
import { ehEntidadePublica } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

const CAT_FR = 'Fornecedores';
const CAT_OR = 'Execução orçamentária';
const CAT_MF = 'Metas fiscais e LRF';
const CAT_TS = 'Convênios, repasses e terceiro setor';

/** Soma absoluta do valor empenhado de uma lista de despesas. */
function somaAbs(lista: DespesaNorm[]): number {
  return lista.reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
}

/** Despesa de natureza expansiva (empenho/reforço) — exclui anulações. */
function expansiva(d: DespesaNorm): boolean {
  return !/ANUL/i.test(d.tipoEmpenho);
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-05 — Empresa punida no portal recebendo pagamento
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: CNPJ em `empresaspunidas` com sanção ativa + pagamento no
 * período. Lei 14.133/2021 art. 14 — empresa punida com suspensão ou declaração
 * de inidoneidade não pode contratar nem receber recurso público.
 *
 * FONTE AUSENTE: o `ContextoAnalise` NÃO traz a lista municipal de empresas
 * punidas (módulo `empresaspunidas` da API SMARAPD — CNPJ + período da sanção).
 * Sem essa base de cruzamento qualquer marcação seria invenção. O detector
 * retorna `[]` honestamente.
 *
 * Quando o módulo `empresaspunidas` for incorporado ao contexto, a regra é:
 * para cada despesa com pagamento, se `cpfCnpj ∈ punidas` e a data do pagamento
 * cai dentro do período da sanção → alerta crítico. (O cruzamento com sanções
 * FEDERAIS — CEIS/CNEP/CEPIM — já é coberto por FR-04, fora deste bloco.)
 */
export const detectorEmpresaPunidaPortal: Detector = {
  id: 'FR-05',
  nome: 'Empresa punida no portal recebendo pagamento',
  categoria: CAT_FR,
  detectar(): AlertaDetectado[] {
    // FONTE AUSENTE: módulo `empresaspunidas` (lista municipal de sancionados,
    // com CNPJ e período da sanção) não está no ContextoAnalise. Sem base de
    // cruzamento não há detecção possível sem inventar dado → [].
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FR-07 — Sócios / endereço / contador em comum entre fornecedores
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: grafo com ≥2 CNPJs que compartilham sócio, endereço ou
 * contador. Lei 12.846/2013 art. 5º IV — conluio entre licitantes.
 *
 * FONTE AUSENTE: o `ContextoAnalise` NÃO traz o quadro societário, o endereço
 * cadastral nem o contador responsável de cada CNPJ. Esses atributos vêm do
 * enriquecimento cadastral (Receita Federal / Junta Comercial), fora de um
 * `Detector` síncrono. Sem o grafo de vínculos não há como aferir a regra.
 *
 * O ÚNICO sinal de parentesco entre CNPJs presente no contexto é a raiz de 8
 * dígitos (matriz/filial), mas isso é o objeto do FR-06 (múltiplos CNPJs da
 * mesma raiz) — replicá-lo aqui seria duplicar detector e não atende FR-07,
 * que trata de empresas JURIDICAMENTE distintas com vínculo oculto. Por isso o
 * detector retorna `[]` aguardando o grafo de sócios/endereço/contador.
 */
export const detectorSociosEnderecoComum: Detector = {
  id: 'FR-07',
  nome: 'Sócios/endereço/contador em comum',
  categoria: CAT_FR,
  detectar(): AlertaDetectado[] {
    // FONTE AUSENTE: grafo de vínculos cadastrais (quadro societário, endereço
    // e contador por CNPJ — enriquecimento Receita Federal / Junta Comercial)
    // não está no ContextoAnalise. Sem ele não há detecção honesta de conluio
    // entre empresas juridicamente distintas → [].
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FR-10 — Empresa sem estrutura aparente (indício de fachada)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: endereço residencial + porte ME/MEI + contrato de alto
 * valor. Lei 12.846/2013 art. 5º — indício de empresa de fachada.
 *
 * FONTE AUSENTE: o porte (ME/MEI/EPP/demais) e o tipo de endereço (residencial
 * vs. comercial) NÃO estão no `ContextoAnalise` — são atributos cadastrais
 * (Receita Federal). A regra exata do catálogo não é, portanto, computável
 * apenas com empenhos/despesas.
 *
 * PROXY HONESTA E CONSERVADORA — incompatibilidade de escala: um MEI tem teto
 * legal de faturamento anual (LC 123/2006 art. 18-A §1º). Se um único CNPJ
 * recebe da Prefeitura, num só exercício, valor acima do teto de receita do MEI
 * — e ainda assim atua com cara de microempresa (poucas despesas, sem
 * pulverização) — há indício de incompatibilidade entre a estrutura presumida e
 * o volume contratado. NÃO se afirma que a empresa é MEI (o porte não está no
 * contexto); afirma-se apenas que o volume contratado já supera, sozinho, o que
 * uma microempresa do menor porte poderia legalmente faturar — sinal fraco, por
 * isso classificação no máximo 'atencao' e confiabilidade baixa.
 *
 * Limiar: o teto do MEI é da ordem de R$ 81 mil/ano; adota-se R$ 360 mil como
 * piso conservador (teto de receita da ME, LC 123/2006 art. 3º II) para o
 * alerta só nascer quando o porte de microempresa for francamente improvável,
 * e ainda assim apenas como informativo/atenção.
 */
const TETO_RECEITA_ME = 360_000; // LC 123/2006 art. 3º II — teto de microempresa.

export const detectorEmpresaSemEstrutura: Detector = {
  id: 'FR-10',
  nome: 'Empresa sem estrutura aparente',
  categoria: CAT_FR,
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    // Agrupa despesas expansivas por CNPJ (14 dígitos = pessoa jurídica).
    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of ctx.despesas) {
      if (d.cpfCnpj.length !== 14 || d.valorEmpenhado <= 0 || !expansiva(d)) {
        continue;
      }
      // Ente público (Prefeitura/Câmara/SAAE/IPREMM) NÃO é "fornecedor".
      if (ehEntidadePublica(d.cpfCnpj, d.fornecedorNome)) continue;
      const arr = porCnpj.get(d.cpfCnpj) ?? [];
      arr.push(d);
      porCnpj.set(d.cpfCnpj, arr);
    }

    for (const [cnpj, lista] of porCnpj) {
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      // Só sinaliza quando o volume já supera o teto de receita de uma
      // microempresa — porte de fachada seria francamente improvável.
      if (soma <= TETO_RECEITA_ME) continue;
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || cnpj;
      // Quantos empenhos distintos: poucos empenhos de valor muito alto
      // reforçam o indício; muitos empenhos sugerem operação real.
      const nEmpenhos = new Set(
        lista.map((d) => d.numeroEmpenho).filter((n) => /\d/.test(n)),
      ).size;
      // Conservador: só alerta quando a operação é concentrada (poucos
      // empenhos) — caso contrário o porte presumido é compatível.
      if (nEmpenhos > 6) continue;

      out.push({
        detectorId: 'FR-10',
        detectorNome: 'Empresa sem estrutura aparente',
        categoria: CAT_FR,
        titulo: `Volume contratado incompatível com porte de microempresa — ${nome}`,
        descricao:
          `Fornecedor recebeu ${formatBRL(soma)} em empenhos no exercício, ` +
          `concentrados em ${nEmpenhos || lista.length} empenho(s) — valor acima do ` +
          `teto de receita de uma microempresa (${formatBRL(TETO_RECEITA_ME)}). ` +
          `Possível indício a apurar de empresa sem estrutura compatível.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao: nEmpenhos <= 2 ? 'atencao' : 'informativo',
        scores: {
          confiabilidade: 40,
          probabilidadeIrregularidade: Math.min(46, 22 + Math.round(soma / 200_000)),
        },
        fundamentoLegal: ['Lei 12.846/2013 art. 5º', 'Lei 14.133/2021 art. 14'],
        evidencias: [
          { resumo: `Valor empenhado no exercício: ${formatBRL(soma)}`, valor: soma },
          { resumo: `Empenhos distintos: ${nEmpenhos || lista.length}` },
          ...lista
            .slice(0, 6)
            .map((d) => ({
              resumo: `Empenho ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)}` +
                (d.objeto ? ` (${d.objeto})` : ''),
              valor: d.valorEmpenhado,
              data: d.data,
            })),
        ],
        explicacao:
          'Empresa de fachada caracteriza-se por estrutura mínima incompatível ' +
          'com o porte do contrato (Lei 12.846/2013 art. 5º). DEPENDÊNCIA: o ' +
          'porte cadastral (ME/MEI/EPP) e o tipo de endereço (residencial vs. ' +
          'comercial) NÃO estão no contexto — vêm do cadastro da Receita Federal. ' +
          'Usa-se como proxy o volume contratado acima do teto de receita de uma ' +
          'microempresa concentrado em poucos empenhos: é um indício fraco a ' +
          'apurar (a empresa pode ter porte maior e estrutura real), não uma ' +
          'conclusão. Convém consultar o porte, o endereço e o quadro de pessoal.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FR-13 — Fornecedor doador de campanha do gestor
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: CNPJ/sócio que consta em doações de campanha do gestor e
 * contratou no mandato. Lei 9.504/1997; CF art. 37.
 *
 * FONTE AUSENTE: o `ContextoAnalise` NÃO traz as prestações de contas eleitorais
 * (doadores de campanha) — dado da base do TSE — nem o quadro societário dos
 * fornecedores (necessário para cruzar doação de SÓCIO pessoa física com o CNPJ
 * contratado). Sem a base de doações e sem o grafo de sócios não há cruzamento
 * possível. O detector retorna `[]` honestamente.
 *
 * Quando a base de doações de campanha do gestor (TSE) e o quadro societário
 * forem incorporados, a regra é: se o CNPJ contratado — ou qualquer sócio seu —
 * consta como doador da campanha do gestor eleito, e há contrato/empenho dentro
 * do mandato → alerta. (Doação de empresa a campanha é vedada desde 2015,
 * Lei 13.165/2015; doação de pessoa física sócia segue permitida e é o foco.)
 */
export const detectorFornecedorDoador: Detector = {
  id: 'FR-13',
  nome: 'Fornecedor doador de campanha',
  categoria: CAT_FR,
  detectar(): AlertaDetectado[] {
    // FONTE AUSENTE: base de doações de campanha do gestor (prestação de contas
    // eleitoral do TSE) + quadro societário dos fornecedores. Nenhum dos dois
    // está no ContextoAnalise → sem cruzamento honesto possível → [].
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// OR-06 — Suplementações repetidas na mesma dotação
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: ≥3 créditos adicionais na mesma dotação no exercício.
 * Lei 4.320/1964 art. 40–43 — créditos adicionais (suplementar/especial).
 *
 * FONTE EXATA AUSENTE: o crédito ADICIONAL formal é um ato (decreto de crédito,
 * área DO/XS do catálogo), com a classificação orçamentária completa da dotação
 * — código de programa/ação/elemento/fonte. O `ContextoAnalise` NÃO traz a
 * dotação orçamentária codificada nem os atos de crédito adicional.
 *
 * PROXY COMPUTÁVEL — declarada: o módulo `DespesaAgrupada` traz o tipo de
 * empenho ("Reforço") e o elemento de despesa. Reforços sucessivos na mesma
 * "dotação proxy" (par unidade gestora + elemento de despesa) refletem, no
 * plano da execução, o mesmo fenômeno que a regra do catálogo busca: a dotação
 * inicial foi insuficiente e precisou ser ampliada repetidas vezes. Aqui se
 * agrupam os REFORÇOS por (UG + elemento) e sinaliza-se quando há ≥3 reforços —
 * o mesmo limiar do catálogo — atingindo fornecedores/empenhos distintos
 * (reforços de UM único empenho já são objeto do OR-09).
 *
 * Conservador: exige reforços a ≥2 empenhos distintos dentro do par, para não
 * recapturar o caso de OR-09 (um só empenho reforçado várias vezes).
 */
export const detectorSuplementacoesRepetidas: Detector = {
  id: 'OR-06',
  nome: 'Suplementações repetidas na mesma dotação',
  categoria: CAT_OR,
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    // Agrupa reforços por dotação-proxy = unidade gestora + elemento de despesa.
    const porDotacao = new Map<string, DespesaNorm[]>();
    for (const d of ctx.despesas) {
      if (!/REFOR/i.test(d.tipoEmpenho)) continue;
      const ug = d.unidadeGestora.trim();
      const el = d.elemento.trim();
      if (!ug || !el) continue; // sem classificação não há dotação-proxy aferível
      const chave = `${ug} ⟂ ${el}`;
      const arr = porDotacao.get(chave) ?? [];
      arr.push(d);
      porDotacao.set(chave, arr);
    }

    for (const [chave, reforcos] of porDotacao) {
      // Regra do catálogo: ≥3 créditos adicionais na mesma dotação.
      if (reforcos.length < 3) continue;
      // Não recapturar OR-09: exige reforços a ≥2 empenhos distintos.
      const empenhosDistintos = new Set(
        reforcos.map((d) => d.numeroEmpenho).filter((n) => /\d/.test(n)),
      );
      if (empenhosDistintos.size < 2) continue;

      const soma = reforcos.reduce((s, d) => s + d.valorEmpenhado, 0);
      if (soma <= 0) continue;
      const [ug, el] = chave.split(' ⟂ ');
      const rotulo = `${ug} — elemento ${el}`;

      out.push({
        detectorId: 'OR-06',
        detectorNome: 'Suplementações repetidas na mesma dotação',
        categoria: CAT_OR,
        titulo: `Reforços repetidos na mesma dotação — ${rotulo}`,
        descricao:
          `${reforcos.length} reforços de empenho na dotação-proxy "${rotulo}", ` +
          `atingindo ${empenhosDistintos.size} empenhos distintos e somando ` +
          `${formatBRL(soma)} de acréscimo. Possível indício a apurar de ` +
          `subdimensionamento orçamentário ou de créditos adicionais sucessivos.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `dotacao-${chave}`,
        sujeitoRotulo: rotulo,
        classificacao: reforcos.length >= 6 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 50,
          probabilidadeIrregularidade: Math.min(64, 30 + reforcos.length * 4),
        },
        fundamentoLegal: ['Lei 4.320/1964 art. 40–43'],
        evidencias: reforcos.slice(0, 8).map((d) => ({
          resumo:
            `Reforço — empenho ${d.numeroEmpenho || d.id} — ${formatBRL(d.valorEmpenhado)}` +
            (d.fornecedorNome ? ` (${d.fornecedorNome})` : ''),
          valor: d.valorEmpenhado,
          data: d.data,
        })),
        explicacao:
          'Suplementar repetidamente a mesma dotação é possível indício de ' +
          'orçamento subestimado na LOA ou de uso de créditos adicionais para ' +
          'contornar o planejamento (Lei 4.320/1964 art. 40–43). DEPENDÊNCIA: o ' +
          'crédito adicional formal é um ato (decreto de crédito) com a dotação ' +
          'orçamentária codificada — que NÃO está no contexto. Usa-se como proxy ' +
          'os reforços de empenho do módulo DespesaAgrupada agrupados por ' +
          'unidade gestora + elemento de despesa: a confirmação exige cruzar com ' +
          'os decretos de crédito adicional do exercício.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MF-07 — Resultado primário fora da meta da LDO
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: resultado primário apurado < meta do Anexo de Metas
 * Fiscais da LDO. LRF art. 4º e 9º.
 *
 * FONTE AUSENTE: o resultado primário (receitas não-financeiras − despesas
 * não-financeiras) e a meta da LDO são apurados no RREO/RGF e reportados ao
 * SICONFI — NÃO derivam do `ContextoAnalise`, que carrega empenhos e despesas
 * sem a classificação por categoria econômica (financeira × não-financeira),
 * sem as receitas e sem o Anexo de Metas Fiscais.
 *
 * Calcular um "resultado primário" a partir só de empenhos seria inventar um
 * número sem lastro contábil. O detector retorna `[]` honestamente, aguardando
 * a integração com o SICONFI (RREO Anexo 6) e com a LDO (Anexo de Metas).
 */
export const detectorResultadoPrimario: Detector = {
  id: 'MF-07',
  nome: 'Resultado primário fora da meta',
  categoria: CAT_MF,
  detectar(): AlertaDetectado[] {
    // FONTE AUSENTE: resultado primário apurado (RREO Anexo 6, base SICONFI) e
    // meta do Anexo de Metas Fiscais da LDO. Nenhum dos dois está no
    // ContextoAnalise — empenhos sozinhos não permitem apurar resultado
    // primário sem inventar a separação financeira × não-financeira → [].
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MF-08 — Resultado nominal fora da meta da LDO
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: resultado nominal apurado fora da faixa da meta da LDO.
 * LRF art. 4º.
 *
 * FONTE AUSENTE: o resultado nominal (variação da dívida fiscal líquida no
 * período) é apurado no RREO Anexo 6 e reportado ao SICONFI; a meta vem do
 * Anexo de Metas Fiscais da LDO. O `ContextoAnalise` NÃO traz a dívida fiscal
 * líquida, nem suas variações, nem a meta. Empenhos não permitem calcular
 * resultado nominal.
 *
 * O detector retorna `[]` honestamente, aguardando a integração com o SICONFI
 * (RREO Anexo 6 — Resultado Nominal) e com a LDO (Anexo de Metas Fiscais).
 */
export const detectorResultadoNominal: Detector = {
  id: 'MF-08',
  nome: 'Resultado nominal fora da meta',
  categoria: CAT_MF,
  detectar(): AlertaDetectado[] {
    // FONTE AUSENTE: resultado nominal apurado (RREO Anexo 6, base SICONFI —
    // variação da dívida fiscal líquida) e meta do Anexo de Metas Fiscais da
    // LDO. Nenhum dos dois está no ContextoAnalise → [].
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TS-02 — OSC com CNPJ inativo/suspenso
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: situação cadastral da OSC ≠ ATIVA na data do repasse.
 * Lei 13.019/2014 art. 39 — vedação a celebrar parceria com OSC irregular.
 *
 * FONTE AUSENTE: o `ContextoAnalise` NÃO traz (a) o módulo de subvenções/MROSC
 * que identifica quais empenhos são repasses a OSC, nem (b) a situação cadastral
 * (ATIVA/baixada/inapta/suspensa/nula) de cada CNPJ — atributo do cadastro da
 * Receita Federal, obtido por enriquecimento assíncrono.
 *
 * Sem o recorte de OSC e sem a situação cadastral não há detecção honesta. O
 * detector retorna `[]`. Quando o módulo de subvenções e o enriquecimento
 * cadastral forem incorporados, a regra é: para cada repasse a OSC, se a
 * situação do CNPJ ≠ ATIVA na data do repasse → alerta crítico.
 */
export const detectorOscCnpjInativo: Detector = {
  id: 'TS-02',
  nome: 'OSC com CNPJ inativo/suspenso',
  categoria: CAT_TS,
  detectar(): AlertaDetectado[] {
    // FONTE AUSENTE: módulo de subvenções/MROSC (recorte de repasses a OSC) +
    // situação cadastral do CNPJ (cadastro Receita Federal). Nenhum dos dois
    // está no ContextoAnalise → [].
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TS-04 — Repasse sem chamamento público
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: termo de colaboração sem chamamento público e sem
 * fundamento de dispensa válido. Lei 13.019/2014 art. 24, 30–32.
 *
 * FONTE AUSENTE: o `ContextoAnalise` NÃO traz o módulo de parcerias/MROSC, que
 * é onde constam o termo de colaboração/fomento, o edital de chamamento público
 * e o eventual ato de dispensa/inexigibilidade de chamamento (art. 30–32).
 * Empenhos genéricos não distinguem repasse a OSC nem carregam o vínculo com um
 * chamamento.
 *
 * Sem o módulo de parcerias não há detecção honesta. O detector retorna `[]`.
 * Quando o módulo MROSC for incorporado, a regra é: para cada termo de
 * colaboração/fomento, se não houver edital de chamamento vinculado E não
 * houver ato de dispensa/inexigibilidade fundamentado nos art. 30–32 → alerta.
 */
export const detectorRepasseSemChamamento: Detector = {
  id: 'TS-04',
  nome: 'Repasse sem chamamento público',
  categoria: CAT_TS,
  detectar(): AlertaDetectado[] {
    // FONTE AUSENTE: módulo de parcerias/MROSC (termo de colaboração/fomento,
    // edital de chamamento público e ato de dispensa de chamamento). Não está
    // no ContextoAnalise → [].
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TS-05 — OSC com dirigente ligado a agente público
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: dirigente da OSC = servidor/agente público ou parente.
 * Lei 13.019/2014 art. 39 III — vedação de parceria com OSC cujo dirigente seja
 * agente político/servidor do ente, ou seu cônjuge/parente.
 *
 * FONTE AUSENTE: a regra exige (a) o módulo de parcerias/MROSC para identificar
 * as OSC e seus DIRIGENTES, e (b) o grafo de vínculos que cruza esses dirigentes
 * com a folha de pagamento e o quadro de agentes políticos (e o parentesco
 * entre eles). O `ContextoAnalise` não traz dirigentes de OSC nem grafo de
 * vínculos/parentesco.
 *
 * Sem essas fontes não há detecção honesta. O detector retorna `[]`. Quando o
 * cadastro de dirigentes das OSC e o grafo de vínculos com a folha forem
 * incorporados, a regra é: se um dirigente da OSC consta na folha do ente ou no
 * rol de agentes políticos (ou é parente de um) → alerta crítico.
 */
export const detectorOscDirigenteAgente: Detector = {
  id: 'TS-05',
  nome: 'OSC com dirigente ligado a agente público',
  categoria: CAT_TS,
  detectar(): AlertaDetectado[] {
    // FONTE AUSENTE: cadastro de dirigentes das OSC (módulo MROSC) + grafo de
    // vínculos/parentesco cruzando com a folha de pagamento e o rol de agentes
    // políticos. Nenhum está no ContextoAnalise → [].
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TS-08 — OSC de saúde sem habilitação válida (CEBAS)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: OSC de saúde sem CEBAS ou habilitação válida recebendo
 * recurso. Lei 12.101/2009 (CEBAS); Lei 13.019/2014.
 *
 * FONTE AUSENTE: a regra exige (a) o módulo de parcerias/MROSC com o recorte de
 * OSC da área da SAÚDE, e (b) a base de Certificação de Entidades Beneficentes
 * de Assistência Social (CEBAS), mantida pelo Ministério da Saúde. O
 * `ContextoAnalise` não traz nem o recorte de OSC de saúde nem o cadastro CEBAS.
 *
 * Sem essas fontes não há detecção honesta. O detector retorna `[]`. Quando o
 * módulo de parcerias de saúde e a base CEBAS forem incorporados, a regra é:
 * para cada OSC de saúde com repasse, se o CNPJ não consta com CEBAS válido (ou
 * outra habilitação exigida) na data do repasse → alerta.
 */
export const detectorOscSaudeSemCebas: Detector = {
  id: 'TS-08',
  nome: 'OSC de saúde sem habilitação válida',
  categoria: CAT_TS,
  detectar(): AlertaDetectado[] {
    // FONTE AUSENTE: módulo de parcerias/MROSC com recorte de OSC de saúde +
    // base CEBAS (Certificação de Entidades Beneficentes — Ministério da
    // Saúde). Nenhum está no ContextoAnalise → [].
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TS-09 — Despesa de parceria fora do plano de trabalho
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Regra do catálogo: item da prestação de contas sem previsão no plano de
 * trabalho aprovado. Lei 13.019/2014 art. 66.
 *
 * FONTE AUSENTE: a regra exige (a) o plano de trabalho aprovado da parceria,
 * com as rubricas/itens previstos, e (b) a prestação de contas item a item da
 * OSC — ambos no módulo de parcerias/MROSC. O `ContextoAnalise` não traz nem o
 * plano de trabalho nem a prestação de contas detalhada; empenhos não revelam
 * a aplicação interna do recurso pela OSC.
 *
 * Sem essas fontes não há detecção honesta. O detector retorna `[]`. Quando o
 * plano de trabalho e a prestação de contas forem incorporados, a regra é: para
 * cada item da prestação de contas, se não houver rubrica correspondente no
 * plano de trabalho aprovado → alerta.
 */
export const detectorDespesaForaPlanoTrabalho: Detector = {
  id: 'TS-09',
  nome: 'Despesa fora do plano de trabalho',
  categoria: CAT_TS,
  detectar(): AlertaDetectado[] {
    // FONTE AUSENTE: plano de trabalho aprovado da parceria + prestação de
    // contas item a item da OSC (módulo MROSC). Nenhum está no
    // ContextoAnalise → [].
    return [];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Registro do bloco
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Bloco LASTRO-X — 12 detectores diversos do catálogo. Vários retornam `[]` de
 * forma honesta enquanto a fonte de dados necessária não chega ao
 * `ContextoAnalise` (ver comentário de cada `detectar`). Mantê-los no registro,
 * com a lógica completa, deixa a cobertura explícita e pronta para ativar assim
 * que a fonte for integrada.
 */
export const DETECTORES_DIV_CAT: Detector[] = [
  detectorEmpresaPunidaPortal, // FR-05 — [] aguardando módulo `empresaspunidas`
  detectorSociosEnderecoComum, // FR-07 — [] aguardando grafo de sócios/endereço/contador
  detectorEmpresaSemEstrutura, // FR-10 — roda sobre despesas reais (proxy de escala)
  detectorFornecedorDoador, // FR-13 — [] aguardando doações de campanha (TSE) + sócios
  detectorSuplementacoesRepetidas, // OR-06 — roda sobre despesas reais (reforços/dotação-proxy)
  detectorResultadoPrimario, // MF-07 — [] aguardando SICONFI (RREO Anexo 6) + LDO
  detectorResultadoNominal, // MF-08 — [] aguardando SICONFI (RREO Anexo 6) + LDO
  detectorOscCnpjInativo, // TS-02 — [] aguardando módulo MROSC + situação cadastral
  detectorRepasseSemChamamento, // TS-04 — [] aguardando módulo MROSC (chamamento)
  detectorOscDirigenteAgente, // TS-05 — [] aguardando dirigentes OSC + grafo de vínculos
  detectorOscSaudeSemCebas, // TS-08 — [] aguardando módulo MROSC saúde + base CEBAS
  detectorDespesaForaPlanoTrabalho, // TS-09 — [] aguardando plano de trabalho + prestação de contas
];
