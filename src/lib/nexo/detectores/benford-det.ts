/**
 * Detector BN-01 — LEI DE BENFORD SOBRE OS VALORES DE EMPENHO — NEXO.
 *
 * Aplica a Lei de Newcomb–Benford ao PRIMEIRO dígito significativo dos valores
 * de empenho do exercício. Em séries financeiras que crescem multiplicativamente
 * e abrangem várias ordens de grandeza, o 1º dígito não é uniforme — o "1" abre
 * ~30,1% e o "9" apenas ~4,6%. Quando a distribuição empírica diverge do esperado
 * (medida pelo MAD de Nigrini, faixas marginal/nonconformity), é um SINAL AGREGADO
 * de possível direcionamento, fracionamento sistêmico ou valores fabricados.
 *
 * REGRA DE LINGUAGEM: "indício, nunca acusação". Benford é um teste de TRIAGEM
 * sobre o agregado — não aponta lançamento, fornecedor ou contrato específico, e
 * não prova nada por si só (curvas atípicas têm causas legítimas: poucos
 * fornecedores dominantes, valores tabelados, sazonalidade). Por isso o alerta é
 * SEMPRE 'atencao' — NUNCA 'critico'. É um convite a apurar, não um veredito.
 * Ver docs/nexo-plano-mestre.md §6–§7. Apenas dados públicos.
 */
import { ehEntidadePublica } from '../entidades';
import {
  distribuicaoPrimeiroDigito,
  madDeNigrini,
  esperadoPrimeiroDigito,
  classificarConformidade,
  CORTES_MAD_NIGRINI,
} from '../estatistica/benford';
import type {
  AlertaDetectado,
  ContextoAnalise,
  Detector,
  Evidencia,
} from './tipos';

const CATEGORIA = 'Estatística agregada';

/**
 * Amostra mínima para emitir um veredito de Benford. Benford só tem poder
 * estatístico com amostra grande; abaixo disso o ruído amostral domina e o
 * teste vira leitura de borra de café. Exigimos n ≥ 80 (mais conservador que o
 * piso geral de 50 do módulo de estatística) para um agregado de execução.
 */
const N_MINIMO = 80;

/**
 * Detector BN-01 no formato do pipeline (`rodarDetectores`).
 *
 * Lógica:
 *  - junta os `valorEmpenhado > 0` de `ctx.empenhos`, EXCLUINDO entes públicos
 *    (`ehEntidadePublica`) — transferências/repasses entre órgãos não são
 *    "fornecimento" e poluiriam a distribuição;
 *  - exige n ≥ 80 dígitos válidos; abaixo disso, [] (sem poder estatístico);
 *  - calcula o MAD de Nigrini do 1º dígito. Só dispara quando a conformidade é
 *    'marginal' ou 'nonconformity'; em 'close'/'acceptable', [] (conforme);
 *  - gera UM único alerta informativo/de atenção sobre o órgão executor.
 */
export const detectorBenford: Detector = {
  id: 'BN-01',
  nome: 'Lei de Benford nos valores de empenho',
  categoria: CATEGORIA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    // 1. Junta valores de empenho > 0, excluindo entes públicos.
    const valores: number[] = [];
    let totalConsiderado = 0;
    for (const e of ctx.empenhos) {
      if (!(e.valorEmpenhado > 0)) continue;
      if (ehEntidadePublica(e.cpfCnpj, e.fornecedorNome)) continue;
      valores.push(e.valorEmpenhado);
      totalConsiderado += e.valorEmpenhado;
    }

    // 2. Distribuição do 1º dígito e veredito de amostra.
    const dist = distribuicaoPrimeiroDigito(valores);
    if (dist.n < N_MINIMO) return []; // amostra insuficiente → sem veredito

    // 3. MAD de Nigrini e conformidade.
    const esperado = esperadoPrimeiroDigito();
    const mad = madDeNigrini(dist.proporcoes, esperado);
    const conformidade = classificarConformidade(mad);

    // 4. Só dispara em faixa marginal/nonconformity. Conforme (close/acceptable) → [].
    if (conformidade !== 'marginal' && conformidade !== 'nonconformity') return [];

    const naoConforme = conformidade === 'nonconformity';

    // Maiores desvios observado−esperado (em pontos percentuais) p/ evidência.
    const desvios = dist.digitos
      .map((d, i) => ({
        digito: d,
        obs: dist.proporcoes[i],
        esp: esperado[i],
        delta: dist.proporcoes[i] - esperado[i],
      }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    const evidencias: Evidencia[] = [
      {
        resumo:
          `MAD de Nigrini (1º dígito) = ${mad.toFixed(4)} — faixa ` +
          `"${conformidade}" (corte marginal ≥ ${CORTES_MAD_NIGRINI.acceptable}, ` +
          `nonconformity ≥ ${CORTES_MAD_NIGRINI.marginal}).`,
        data: null,
        ref: 'Benford 1º dígito',
      },
      {
        resumo:
          `Amostra: ${dist.n} valores de empenho (> 0, excluídos entes públicos), ` +
          `somando R$ ${totalConsiderado.toLocaleString('pt-BR', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}.`,
        data: null,
        ref: 'SMARAPD',
      },
      ...desvios.slice(0, 3).map<Evidencia>((x) => ({
        resumo:
          `Dígito ${x.digito}: observado ${(x.obs * 100).toFixed(1)}% vs ` +
          `esperado ${(x.esp * 100).toFixed(1)}% ` +
          `(${x.delta >= 0 ? '+' : ''}${(x.delta * 100).toFixed(1)} p.p.).`,
        data: null,
        ref: `dígito ${x.digito}`,
      })),
    ];

    return [
      {
        detectorId: 'BN-01',
        detectorNome: 'Lei de Benford nos valores de empenho',
        categoria: CATEGORIA,
        titulo:
          'Distribuição dos valores de empenho diverge da Lei de Benford ' +
          `(${ctx.exercicio})`,
        descricao:
          'A distribuição do primeiro dígito dos valores de empenho do ' +
          `exercício diverge do esperado pela Lei de Benford (MAD de Nigrini ` +
          `${mad.toFixed(4)}, faixa "${conformidade}"), sobre ${dist.n} ` +
          'lançamentos. É um possível indício de direcionamento ou ' +
          'fracionamento sistêmico — indício agregado a apurar, não prova.',
        sujeitoTipo: 'orgao',
        sujeitoId: `EXECUCAO-${ctx.exercicio}`,
        sujeitoRotulo: `Execução orçamentária ${ctx.exercicio}`,
        classificacao: 'atencao', // NUNCA 'critico' — Benford é sinal agregado, não prova.
        scores: {
          // Teste de triagem estatística sobre o agregado: confiabilidade
          // moderada (a métrica é objetiva, mas curvas atípicas têm causas
          // legítimas). Probabilidade um pouco maior em nonconformity.
          confiabilidade: 50,
          probabilidadeIrregularidade: naoConforme ? 45 : 35,
        },
        fundamentoLegal: [
          'Lei 14.133/2021',
          'CF art.37 (impessoalidade/economicidade)',
        ],
        evidencias,
        explicacao:
          'A Lei de Benford é um teste de TRIAGEM aplicado ao conjunto de ' +
          'valores de empenho — não aponta lançamento, fornecedor ou contrato ' +
          'específico. Uma divergência da curva esperada pode indicar ' +
          'direcionamento, fracionamento sistêmico para escapar de limites de ' +
          'dispensa, ou valores fabricados; mas também pode ter explicação ' +
          'legítima (poucos fornecedores dominantes, valores tabelados/de ' +
          'pregão, sazonalidade da despesa). Por isso é apenas um indício ' +
          'agregado a apurar — convém inspecionar os dígitos mais ' +
          'sobre-representados e os processos de maior recorrência de valor. ' +
          'Não constitui, por si só, irregularidade nem acusação.',
        valorEnvolvido: totalConsiderado,
      },
    ];
  },
};
