/**
 * Detectores do subsistema CONVÊNIOS E TERCEIRO SETOR — NEXO.
 *
 * Cobertura (ver docs/nexo/02-catalogo-de-monitoramentos.md §12):
 *  TS-06 — Emenda impositiva sem repasse (emenda impositiva não executada).
 *  TS-07 — Concentração de repasses numa OSC (> 30% das parcerias).
 *  TS-01 — Parceria sem ato legal autorizador (proxy do plano de trabalho).
 *  TS-03 — Repasse empenhado e não pago (proxy da prestação de contas).
 *
 * TS-02 (CNPJ inativo), TS-04 (chamamento), TS-05 (dirigente ligado a agente),
 * TS-08 (CEBAS) e TS-09 (despesa fora do plano) dependem de fontes que este
 * vertical não coleta (situação cadastral CNPJ, atos de chamamento, grafo de
 * vínculos, prestação de contas item a item) e ficam fora deste módulo.
 *
 * REGRA DE LINGUAGEM: todo alerta é INDÍCIO a apurar — nunca acusação. Ver
 * plano-mestre §6–§7. Apenas dados públicos.
 */
import { formatBRL } from '../normalizar';
import type { SubvencaoNorm, EmendaNorm } from '../sources/terceiro-setor';
import type { AlertaDetectado } from './tipos';

const CATEGORIA = 'Convênios e terceiro setor';

// ── TS-06 — Emenda impositiva sem repasse ────────────────────────────────────

/**
 * Emenda classificada como impositiva cujo valor empenhado é nulo (ou marginal
 * frente ao previsto). A CF art. 166 §§9º–18 torna a execução obrigatória —
 * a falta de empenho é indício de descumprimento a verificar.
 */
export function detectarEmendaImpositivaSemRepasse(
  emendas: EmendaNorm[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];

  for (const e of emendas) {
    if (!e.impositiva) continue;
    if (e.valorPrevisto <= 0) continue;

    const executado = e.valorEmpenhado;
    const pctExecutado = (executado / e.valorPrevisto) * 100;
    // Considera "sem repasse" quando menos de 10% do previsto foi empenhado.
    if (pctExecutado >= 10) continue;

    const rotulo = e.numero
      ? `Emenda ${e.numero}`
      : e.autor || e.objeto || `Emenda ${e.id}`;
    const naoExecutado = e.valorPrevisto - executado;
    const classificacao = pctExecutado <= 0 ? 'suspeita' : 'atencao';

    out.push({
      detectorId: 'TS-06',
      detectorNome: 'Emenda impositiva sem repasse',
      categoria: CATEGORIA,
      titulo: `Emenda impositiva com execução próxima de zero — ${rotulo}`,
      descricao:
        `Emenda parlamentar impositiva com ${formatBRL(e.valorPrevisto)} previstos e ` +
        `apenas ${formatBRL(executado)} empenhados (${pctExecutado.toFixed(1)}% do previsto).` +
        (e.autor ? ` Autoria: ${e.autor}.` : ''),
      sujeitoTipo: 'empenho',
      sujeitoId: e.id,
      sujeitoRotulo: rotulo,
      classificacao,
      scores: {
        confiabilidade: 70,
        probabilidadeIrregularidade: pctExecutado <= 0 ? 58 : 44,
      },
      fundamentoLegal: [
        'CF, art. 166, §§9º a 18 (execução obrigatória de emendas impositivas)',
        'Lei de Diretrizes Orçamentárias (LDO) do exercício',
      ],
      evidencias: [
        { resumo: `Valor previsto: ${formatBRL(e.valorPrevisto)}`, valor: e.valorPrevisto },
        { resumo: `Valor empenhado: ${formatBRL(executado)}`, valor: executado },
        ...(e.objeto ? [{ resumo: `Objeto: ${e.objeto.slice(0, 140)}` }] : []),
        ...(e.situacao ? [{ resumo: `Situação informada: ${e.situacao}` }] : []),
      ],
      explicacao:
        'Emendas impositivas têm execução obrigatória por mandamento constitucional. ' +
        'A ausência (ou quase ausência) de empenho é um indício de possível ' +
        'descumprimento — convém verificar se houve impedimento técnico formalmente ' +
        'justificado, contingenciamento ou se o estágio da despesa ainda não foi ' +
        'lançado no portal. Não constitui, por si só, irregularidade.',
      valorEnvolvido: naoExecutado,
    });
  }

  return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
}

// ── TS-07 — Concentração de repasses numa OSC ────────────────────────────────

/**
 * Uma mesma entidade (CNPJ/CPF) que concentra fatia anormal do valor total de
 * subvenções do exercício. Concentração não é, por si, irregularidade — pode
 * refletir uma OSS hospitalar legítima — mas merece verificação de
 * impessoalidade e de chamamento público.
 */
export function detectarConcentracaoRepasses(
  subvencoes: SubvencaoNorm[],
): AlertaDetectado[] {
  const total = subvencoes.reduce((s, x) => s + x.valor, 0);
  if (total <= 0) return [];

  const porEntidade = new Map<
    string,
    { total: number; n: number; nome: string }
  >();
  for (const s of subvencoes) {
    if (s.valor <= 0) continue;
    const chave = s.beneficiarioDoc || s.beneficiarioNome;
    if (!chave) continue;
    const cur = porEntidade.get(chave) ?? { total: 0, n: 0, nome: s.beneficiarioNome };
    cur.total += s.valor;
    cur.n += 1;
    if (!cur.nome && s.beneficiarioNome) cur.nome = s.beneficiarioNome;
    porEntidade.set(chave, cur);
  }

  const out: AlertaDetectado[] = [];
  for (const [chave, dados] of porEntidade) {
    const pct = (dados.total / total) * 100;
    if (pct < 30) continue;

    const nome = dados.nome || chave;
    const classificacao = pct >= 50 ? 'suspeita' : 'atencao';

    out.push({
      detectorId: 'TS-07',
      detectorNome: 'Concentração de repasses numa OSC',
      categoria: CATEGORIA,
      titulo: `Concentração de repasses do terceiro setor — ${nome}`,
      descricao:
        `Entidade concentra ${pct.toFixed(1)}% do valor total de subvenções do ` +
        `exercício (${formatBRL(dados.total)} em ${dados.n} repasses).`,
      sujeitoTipo: 'fornecedor',
      sujeitoId: chave,
      sujeitoRotulo: nome,
      classificacao,
      scores: {
        confiabilidade: 78,
        probabilidadeIrregularidade: Math.min(72, Math.round(28 + pct)),
      },
      fundamentoLegal: [
        'Lei 13.019/2014 (MROSC)',
        'CF, art. 37, caput (princípio da impessoalidade)',
      ],
      evidencias: [
        {
          resumo: `${dados.n} repasses · total ${formatBRL(dados.total)}`,
          valor: dados.total,
        },
        { resumo: `Total de subvenções do exercício: ${formatBRL(total)}`, valor: total },
      ],
      explicacao:
        `Esta entidade responde por ${pct.toFixed(1)}% do valor de subvenções do ` +
        'exercício. Concentração não é irregularidade em si — pode haver uma parceria ' +
        'estruturante legítima (ex.: OSS de saúde). Convém verificar se houve ' +
        'chamamento público, se o objeto justifica a escala e se a seleção observou ' +
        'a impessoalidade exigida pelo MROSC.',
      valorEnvolvido: dados.total,
    });
  }

  return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
}

// ── TS-01 — Parceria sem ato legal autorizador ───────────────────────────────

/**
 * Proxy de TS-01: repasse de subvenção sem lei/decreto autorizador informado.
 * A Lei 4.320/1964 (art. 26) e a LDO exigem autorização legislativa específica
 * para transferência a entidade privada — a ausência do ato é indício a apurar.
 * Usa o campo `leiAutorizadora` quando o portal o expõe; só dispara se ao menos
 * parte dos registros traz o campo, evitando ruído quando o módulo não o tem.
 */
export function detectarParceriaSemAtoLegal(
  subvencoes: SubvencaoNorm[],
): AlertaDetectado[] {
  const comValor = subvencoes.filter((s) => s.valor > 0);
  if (comValor.length === 0) return [];

  const comAto = comValor.filter((s) => s.leiAutorizadora).length;
  // Se nenhum registro traz o campo, o portal não o expõe — não inferir nada.
  if (comAto === 0) return [];

  const out: AlertaDetectado[] = [];
  for (const s of comValor) {
    if (s.leiAutorizadora) continue;

    const nome = s.beneficiarioNome || s.beneficiarioDoc || `Repasse ${s.id}`;
    out.push({
      detectorId: 'TS-01',
      detectorNome: 'Parceria sem ato legal autorizador',
      categoria: CATEGORIA,
      titulo: `Repasse sem ato legal autorizador informado — ${nome}`,
      descricao:
        `Subvenção de ${formatBRL(s.valor)} sem lei/decreto autorizador registrado ` +
        `no portal${s.objeto ? ` — objeto: ${s.objeto.slice(0, 100)}` : ''}.`,
      sujeitoTipo: 'empenho',
      sujeitoId: s.id,
      sujeitoRotulo: nome,
      classificacao: 'atencao',
      scores: { confiabilidade: 58, probabilidadeIrregularidade: 40 },
      fundamentoLegal: [
        'Lei 4.320/1964, art. 26 (autorização legislativa para subvenção)',
        'Lei 13.019/2014, art. 42 e 63–69 (plano de trabalho e prestação de contas)',
      ],
      evidencias: [
        { resumo: `Valor do repasse: ${formatBRL(s.valor)}`, valor: s.valor, data: s.data },
        ...(s.beneficiarioDoc ? [{ resumo: `CNPJ/CPF: ${s.beneficiarioDoc}` }] : []),
      ],
      explicacao:
        'Transferências a entidades privadas exigem autorização legislativa e plano ' +
        'de trabalho. A ausência do ato autorizador no portal é um indício de ' +
        'transparência incompleta — pode ser apenas falha de publicação. Convém ' +
        'confirmar a existência da lei autorizadora e do plano de trabalho.',
      valorEnvolvido: s.valor,
    });
  }

  return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
}

// ── TS-03 — Repasse empenhado e não pago / sem liquidação ────────────────────

/**
 * Proxy de TS-03: subvenção empenhada cujo valor pago permanece nulo. Indício
 * de parceria com execução travada — pode refletir pendência de prestação de
 * contas (que condiciona o repasse das parcelas, Lei 13.019/2014 art. 69) ou
 * apenas defasagem de lançamento. Limiar de materialidade para reduzir ruído.
 */
const LIMIAR_TS03 = 5_000;

export function detectarRepasseSemPagamento(
  subvencoes: SubvencaoNorm[],
): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];

  for (const s of subvencoes) {
    if (s.valor < LIMIAR_TS03) continue;
    if (s.valorPago > 0) continue;

    const nome = s.beneficiarioNome || s.beneficiarioDoc || `Repasse ${s.id}`;
    out.push({
      detectorId: 'TS-03',
      detectorNome: 'Repasse empenhado e não pago',
      categoria: CATEGORIA,
      titulo: `Subvenção empenhada sem pagamento registrado — ${nome}`,
      descricao:
        `Subvenção de ${formatBRL(s.valor)} empenhada sem qualquer valor pago ` +
        `registrado no portal${s.data ? ` (empenho em ${s.data})` : ''}.`,
      sujeitoTipo: 'empenho',
      sujeitoId: s.id,
      sujeitoRotulo: nome,
      classificacao: 'informativo',
      scores: { confiabilidade: 62, probabilidadeIrregularidade: 32 },
      fundamentoLegal: [
        'Lei 13.019/2014, art. 69 (prestação de contas como condição do repasse)',
      ],
      evidencias: [
        { resumo: `Valor empenhado: ${formatBRL(s.valor)}`, valor: s.valor, data: s.data },
        { resumo: 'Valor pago: R$ 0,00', valor: 0 },
        ...(s.objeto ? [{ resumo: `Objeto: ${s.objeto.slice(0, 120)}` }] : []),
      ],
      explicacao:
        'A subvenção foi empenhada mas não há pagamento registrado. Pode ser ' +
        'defasagem normal de lançamento ou retenção do repasse por pendência de ' +
        'prestação de contas de parcela anterior. Convém verificar o estágio real ' +
        'da despesa e a situação da prestação de contas da OSC.',
      valorEnvolvido: s.valor,
    });
  }

  return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Roda todos os detectores do terceiro setor sobre a coleta do exercício.
 * Devolve os alertas ordenados por valor envolvido (maiores primeiro).
 */
export function analisarTerceiroSetor(input: {
  subvencoes: SubvencaoNorm[];
  emendas: EmendaNorm[];
}): AlertaDetectado[] {
  return [
    ...detectarEmendaImpositivaSemRepasse(input.emendas),
    ...detectarConcentracaoRepasses(input.subvencoes),
    ...detectarParceriaSemAtoLegal(input.subvencoes),
    ...detectarRepasseSemPagamento(input.subvencoes),
  ].sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
}
