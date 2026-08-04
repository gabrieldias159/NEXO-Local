/**
 * Detectores de folha de pagamento.
 *
 *  FP-01 — Remuneração acima do teto (proxy declarado — sem o teto no dado).
 *  FP-09 — Nomeação concentrada pré-eleição (proxy de janela eleitoral).
 *
 * `analisarFolha` é o runner da rota /api/nexo/folha. Nomes são mascarados
 * nas evidências (LGPD).
 */
import { formatBRL, mascararNome, type ServidorNorm } from '../normalizar';
import type { AlertaDetectado } from './tipos';

/**
 * Piso de TRIAGEM para FP-01. NÃO é o teto constitucional — o teto (subsídio do
 * Prefeito, no âmbito municipal) não está no `ServidorNorm`. É apenas um corte
 * conservador para LISTAR remunerações altas a conferir contra o teto real.
 */
const PISO_TRIAGEM_REMUNERACAO = 28_000;
/** Janela pré-eleitoral da regra FP-09: ~90 dias antes do pleito. */
const FATOR_PICO_ELEITORAL = 1.5; // pico > +50% da média mensal (catálogo).

/** Eleições municipais: 2020, 2024, 2028… (a cada 4 anos a partir de 2020). */
function ehAnoEleitoralMunicipal(ano: number): boolean {
  return ano % 4 === 0;
}

export function analisarFolha(servidores: ServidorNorm[]): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];

  // ── FP-01 — Remuneração acima do teto (PROXY DECLARADO) ────────────────────
  // O catálogo exige comparar a remuneração com o TETO CONSTITUCIONAL. O teto
  // aplicável não está no contexto da folha — então o detector NÃO crava um
  // valor como se fosse o teto. Apenas lista, como item de conferência, as
  // remunerações brutas acima de um piso de triagem, deixando claro que o
  // enquadramento no teto exige o subsídio do Prefeito (não disponível aqui).
  const altos = servidores
    .filter((s) => s.vencimentos > PISO_TRIAGEM_REMUNERACAO)
    .sort((a, b) => b.vencimentos - a.vencimentos);
  if (altos.length > 0) {
    const total = altos.reduce((s, x) => s + x.vencimentos, 0);
    out.push({
      detectorId: 'FP-01',
      detectorNome: 'Remuneração acima do teto',
      categoria: 'Folha de pagamento',
      titulo: `${altos.length} servidor(es) com remuneração bruta a conferir contra o teto`,
      descricao:
        `${altos.length} servidor(es) com remuneração bruta mensal acima de ` +
        `${formatBRL(PISO_TRIAGEM_REMUNERACAO)} (piso de triagem, NÃO o teto). ` +
        `Item de conferência: o enquadramento no teto constitucional depende do ` +
        `subsídio do Prefeito, que não está no contexto.`,
      sujeitoTipo: 'orgao',
      sujeitoId: 'folha',
      sujeitoRotulo: 'Folha de pagamento',
      // Proxy declarado: sem o teto, não se afirma "acima do teto" → informativo.
      classificacao: 'informativo',
      scores: { confiabilidade: 40, probabilidadeIrregularidade: 30 },
      fundamentoLegal: ['CF, art. 37, XI'],
      evidencias: altos.slice(0, 12).map((s) => ({
        resumo: `${mascararNome(s.nome)} — ${s.cargo || '—'} — ${formatBRL(s.vencimentos)}`,
        valor: s.vencimentos,
      })),
      explicacao:
        'A Constituição limita a remuneração ao teto (no âmbito municipal, o ' +
        'subsídio do Prefeito) — CF art. 37 XI. PROXY DECLARADO: o teto aplicável ' +
        'NÃO está no contexto da folha; o detector não crava um valor como se ' +
        'fosse o teto. Ele apenas lista, como item de conferência, as ' +
        'remunerações brutas acima de um piso de triagem — convém comparar cada ' +
        'uma com o teto real e verificar abatimentos e parcelas de natureza ' +
        'indenizatória, que não entram no teto.',
      valorEnvolvido: total,
    });
  }

  // ── FP-09 — Nomeação concentrada pré-eleição ───────────────────────────────
  // Catálogo: nº de nomeações nos 90 dias pré-eleição > +50% da média mensal.
  // O detector compara cada mês com a média mensal de admissões do conjunto e,
  // em ano eleitoral municipal, foca a janela pré-pleito (jul–set; pleito em
  // outubro). Fora de ano eleitoral, sem janela aplicável, não dispara —
  // evita o falso positivo de "≥20 admissões em qualquer mês".
  const porMes = new Map<string, number>();
  for (const s of servidores) {
    if (!s.dataAdmissao) continue;
    const mes = s.dataAdmissao.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) continue;
    porMes.set(mes, (porMes.get(mes) ?? 0) + 1);
  }
  if (porMes.size > 0) {
    const totalAdmissoes = [...porMes.values()].reduce((s, n) => s + n, 0);
    const mediaMensal = totalAdmissoes / porMes.size;
    for (const [mes, qtd] of porMes) {
      const ano = Number(mes.slice(0, 4));
      const numMes = Number(mes.slice(5, 7));
      // Regra do catálogo: pico > +50% da média. Sem isso, não há indício.
      if (mediaMensal <= 0 || qtd <= mediaMensal * FATOR_PICO_ELEITORAL) continue;
      // Janela pré-eleitoral municipal: jul–set de ano eleitoral (~90 dias).
      const naJanelaEleitoral =
        ehAnoEleitoralMunicipal(ano) && numMes >= 7 && numMes <= 9;
      const pct = (qtd / mediaMensal - 1) * 100;
      out.push({
        detectorId: 'FP-09',
        detectorNome: 'Nomeação concentrada pré-eleição',
        categoria: 'Folha de pagamento',
        titulo: naJanelaEleitoral
          ? `Pico de admissões na janela pré-eleitoral — ${mes}`
          : `Pico de admissões em ${mes} (fora de janela eleitoral)`,
        descricao:
          `${qtd} admissões em ${mes} — ${pct.toFixed(0)}% acima da média mensal ` +
          `de admissões do período (${mediaMensal.toFixed(1)}/mês). ` +
          (naJanelaEleitoral
            ? 'Mês dentro da janela pré-eleitoral municipal — possível indício a apurar.'
            : 'Fora de ano/janela eleitoral — item de conferência da forma de provimento.'),
        sujeitoTipo: 'orgao',
        sujeitoId: `admissoes-${mes}`,
        sujeitoRotulo: `Admissões ${mes}`,
        // Só vira "atenção" dentro da janela eleitoral (regra FP-09 do catálogo);
        // fora dela é apenas item de conferência (informativo).
        classificacao: naJanelaEleitoral ? 'atencao' : 'informativo',
        scores: {
          confiabilidade: naJanelaEleitoral ? 58 : 40,
          probabilidadeIrregularidade: Math.min(
            naJanelaEleitoral ? 64 : 38,
            (naJanelaEleitoral ? 34 : 18) + Math.round(pct / 4),
          ),
        },
        fundamentoLegal: ['Lei 9.504/1997, art. 73, V', 'CF, art. 37, II'],
        evidencias: [
          {
            resumo: `${qtd} admissões em ${mes} · média mensal ${mediaMensal.toFixed(1)}`,
            valor: qtd,
          },
        ],
        explicacao:
          'A regra FP-09 do catálogo trata do pico de nomeações nos ~90 dias ' +
          'anteriores ao pleito (> +50% da média) — a Lei 9.504/1997 art. 73 V ' +
          'veda nomear, contratar ou admitir servidor na janela pré-eleitoral, ' +
          'salvo exceções. Este alerta marca um mês cujas admissões superam em ' +
          'mais de 50% a média mensal do período. Quando o mês cai na janela ' +
          'pré-eleitoral de ano eleitoral municipal, é possível indício a ' +
          'apurar; fora dela, é apenas item de conferência da forma de ' +
          'provimento (concurso × livre nomeação). PROXY: a média é calculada ' +
          'sobre os meses presentes na folha consultada, não sobre série ' +
          'histórica plena.',
        valorEnvolvido: 0,
      });
    }
  }

  // FP-06 — Comissionado sem lotação visível.
  const reComissionado = /comiss|assessor|diretor|chefe|gabinete|coorden/i;
  const semLotacao = servidores.filter(
    (s) => reComissionado.test(s.cargo) && s.lotacao.trim().length < 3,
  );
  if (semLotacao.length >= 3) {
    out.push({
      detectorId: 'FP-06',
      detectorNome: 'Comissionado sem lotação visível',
      categoria: 'Folha de pagamento',
      titulo: `${semLotacao.length} cargos comissionados sem lotação informada`,
      descricao:
        `${semLotacao.length} servidores em cargo de provimento em comissão sem ` +
        `unidade de lotação registrada na folha.`,
      sujeitoTipo: 'orgao',
      sujeitoId: 'comissionados-sem-lotacao',
      sujeitoRotulo: 'Cargos comissionados',
      classificacao: 'atencao',
      scores: { confiabilidade: 60, probabilidadeIrregularidade: 44 },
      fundamentoLegal: ['CF art. 37, V; Súmula Vinculante 13'],
      evidencias: semLotacao.slice(0, 10).map((s) => ({
        resumo: `${mascararNome(s.nome)} — ${s.cargo || '—'}`,
      })),
      explicacao:
        'Cargo em comissão sem lotação ou atribuição clara dificulta verificar a ' +
        'efetiva prestação do serviço — ponto de atenção quanto à finalidade da nomeação.',
      valorEnvolvido: 0,
    });
  }

  return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
}
