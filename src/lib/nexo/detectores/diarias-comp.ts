/**
 * Detectores computáveis de Diárias, Eventos e Publicidade (área DE).
 *
 *  DE-04 — Viagens repetidas ao mesmo destino.
 *  DE-06 — Passagens/locomoção desproporcional na unidade.
 *  DE-12 — Pico de publicidade em janela eleitoral.
 *
 * DE-13 (Publicidade acima do teto da RCL) foi removido deste arquivo: havia
 * uma implementação idêntica (também `[]` por falta da RCL no contexto) em
 * `emergenciais-diarias-cat.ts`, que é o bloco sistemático da área DE.
 * Mantém-se a de lá para não ter dois detectores com o mesmo `DE-13`.
 *
 * Trabalham sobre `diarias` e `DespesaAgrupada`. Linguagem: indício a apurar.
 */
import { formatBRL, type DespesaNorm, type DiariaNorm } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

const RE_PUBLICIDADE =
  /publicidad|propaganda|divulga[çc][ãa]o|marketing|m[íi]dia|assessoria de imprensa|public/i;
const RE_LOCOMOCAO =
  /passage|locomo[çc][ãa]o|transporte|deslocamento|viage|hospedage|di[áa]ria/i;

/**
 * Extrai um destino do texto livre. O módulo de diárias não traz um campo de
 * destino estruturado — usamos a unidade como proxy quando há padrão "para X".
 * Honestidade: sem campo de destino estruturado, a granularidade é limitada.
 */
function destinoDe(d: DiariaNorm): string | null {
  const m = d.unidade.match(/(?:para|destino|cidade de)\s+([A-Za-zÀ-ú\s]{3,40})/i);
  if (m) return m[1].trim().toUpperCase();
  return null;
}

// ── DE-04 — Viagens repetidas ao mesmo destino ───────────────────────────────
/**
 * Catálogo: ≥4 diárias ao mesmo destino para o mesmo grupo no exercício.
 * O módulo de diárias não traz destino estruturado. Quando não houver destino
 * extraível, o detector retorna [] (ver destinoDe). Quando houver, agrupa por
 * (destino + beneficiário).
 */
export const detectorViagensRepetidasDestino: Detector = {
  id: 'DE-04',
  nome: 'Viagens repetidas ao mesmo destino',
  categoria: 'Diárias e eventos',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const grupos = new Map<string, DiariaNorm[]>();
    for (const d of ctx.diarias) {
      if (!d.beneficiario || d.valor <= 0) continue;
      const destino = destinoDe(d);
      if (!destino) continue; // sem destino estruturado — não há como agrupar
      const chave = `${destino}|${d.beneficiario.toUpperCase().trim()}`;
      const arr = grupos.get(chave) ?? [];
      arr.push(d);
      grupos.set(chave, arr);
    }

    for (const [chave, lista] of grupos) {
      if (lista.length < 4) continue;
      const [destino] = chave.split('|');
      const soma = lista.reduce((s, d) => s + d.valor, 0);
      const nome = lista[0].beneficiario;
      out.push({
        detectorId: 'DE-04',
        detectorNome: 'Viagens repetidas ao mesmo destino',
        categoria: 'Diárias e eventos',
        titulo: `Viagens repetidas ao mesmo destino — ${nome}`,
        descricao:
          `${lista.length} diárias ao destino "${destino}" para o mesmo beneficiário ` +
          `no exercício, somando ${formatBRL(soma)}. Possível indício a apurar.`,
        sujeitoTipo: 'servidor',
        sujeitoId: nome,
        sujeitoRotulo: nome,
        classificacao: lista.length >= 8 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 58,
          probabilidadeIrregularidade: Math.min(60, 30 + lista.length * 4),
        },
        fundamentoLegal: ['Lei 4.320/1964 art. 63'],
        evidencias: lista.slice(0, 8).map((d) => ({
          resumo: `Diária ${d.numeroEmpenho || d.id} — ${formatBRL(d.valor)}`,
          valor: d.valor,
          data: d.data,
        })),
        explicacao:
          'Muitas viagens ao mesmo destino para o mesmo servidor são possível ' +
          'indício a apurar — convém verificar a justificativa de cada deslocamento ' +
          'e o resultado das viagens. DEPENDÊNCIA: o módulo de diárias não traz ' +
          'destino estruturado; o destino foi extraído do texto da unidade.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ── DE-06 — Passagens/locomoção desproporcional ──────────────────────────────
/**
 * Catálogo: gasto da UG > média histórica + 2 desvios-padrão. Sem série
 * histórica multi-ano no contexto, usamos a distribuição entre unidades do
 * próprio exercício: unidades cujo gasto de locomoção/passagens é um outlier
 * (acima da média entre UGs + 2 desvios).
 */
export const detectorLocomocaoDesproporcional: Detector = {
  id: 'DE-06',
  nome: 'Passagens/locomoção desproporcional',
  categoria: 'Diárias e eventos',
  detectar(ctx) {
    const loco = ctx.despesas.filter(
      (d) =>
        d.valorEmpenhado > 0 &&
        d.unidadeGestora &&
        (RE_LOCOMOCAO.test(d.objeto) || RE_LOCOMOCAO.test(d.elemento)),
    );
    const porUg = new Map<string, number>();
    for (const d of loco) {
      porUg.set(d.unidadeGestora, (porUg.get(d.unidadeGestora) ?? 0) + d.valorEmpenhado);
    }
    if (porUg.size < 6) return [];

    const valores = [...porUg.values()];
    const media = valores.reduce((s, v) => s + v, 0) / valores.length;
    const desvio = Math.sqrt(
      valores.reduce((s, v) => s + (v - media) ** 2, 0) / valores.length,
    );
    if (desvio === 0) return [];
    const limiar = media + 2 * desvio;

    const out: AlertaDetectado[] = [];
    for (const [ug, valor] of porUg) {
      if (valor <= limiar) continue;
      out.push({
        detectorId: 'DE-06',
        detectorNome: 'Passagens/locomoção desproporcional',
        categoria: 'Diárias e eventos',
        titulo: `Gasto de locomoção atípico — ${ug}`,
        descricao:
          `${formatBRL(valor)} em passagens/locomoção na unidade — acima da média ` +
          `entre unidades (${formatBRL(media)}) + 2 desvios. Possível indício a apurar.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `locomocao-${ug}`,
        sujeitoRotulo: ug,
        classificacao: 'atencao',
        scores: { confiabilidade: 56, probabilidadeIrregularidade: 48 },
        fundamentoLegal: ['LRF; controle interno'],
        evidencias: [
          { resumo: `Gasto da unidade: ${formatBRL(valor)} · média entre UGs: ${formatBRL(media)}`, valor },
        ],
        explicacao:
          'Gasto de passagens/locomoção muito acima do padrão das demais unidades ' +
          'é possível indício a apurar — convém verificar a quantidade de viagens, ' +
          'rotas e a comprovação. DEPENDÊNCIA: sem série histórica multi-ano, ' +
          'compara-se a distribuição entre unidades do exercício.',
        valorEnvolvido: valor,
      });
    }
    return out;
  },
};

// ── DE-12 — Pico de publicidade em janela eleitoral ──────────────────────────
/**
 * Lei 9.504/1997 art. 73, VI/VII: nos 3 meses anteriores ao pleito é vedada a
 * publicidade institucional, salvo exceções. O catálogo pede comparar o gasto
 * do trimestre pré-eleitoral com o ano anterior; sem o ano anterior no contexto,
 * comparamos o gasto de publicidade do trimestre pré-eleitoral (jul–set de ano
 * eleitoral) com a média trimestral do próprio exercício.
 *
 * Eleições municipais ocorrem em anos pares múltiplos de 2 que não são de
 * eleição geral (2024, 2028, ...). O detector só age em ano eleitoral municipal.
 */
function ehAnoEleitoralMunicipal(ano: number): boolean {
  // Eleições municipais: 2020, 2024, 2028, ... (a cada 4 anos a partir de 2020).
  return ano % 4 === 0;
}

export const detectorPicoPublicidadeEleitoral: Detector = {
  id: 'DE-12',
  nome: 'Pico de publicidade em janela eleitoral',
  categoria: 'Diárias e eventos',
  detectar(ctx) {
    if (!ehAnoEleitoralMunicipal(ctx.exercicio)) return [];
    const pub = ctx.despesas.filter(
      (d) =>
        d.valorEmpenhado > 0 &&
        d.data &&
        (RE_PUBLICIDADE.test(d.objeto) || RE_PUBLICIDADE.test(d.elemento)),
    );
    if (pub.length < 4) return [];

    // Gasto por trimestre.
    const porTrim = new Map<number, number>();
    for (const d of pub) {
      const mes = Number(d.data!.slice(5, 7));
      const trim = Math.ceil(mes / 3);
      porTrim.set(trim, (porTrim.get(trim) ?? 0) + d.valorEmpenhado);
    }
    const total = [...porTrim.values()].reduce((s, v) => s + v, 0);
    if (total <= 0) return [];
    // Janela pré-eleitoral municipal: 3º trimestre (jul–set), pleito em outubro.
    const gastoPreEleitoral = porTrim.get(3) ?? 0;
    const mediaTrimestral = total / 4;
    if (mediaTrimestral <= 0 || gastoPreEleitoral <= mediaTrimestral * 1.3) return [];

    const pct = ((gastoPreEleitoral / mediaTrimestral - 1) * 100);
    return [
      {
        detectorId: 'DE-12',
        detectorNome: 'Pico de publicidade em janela eleitoral',
        categoria: 'Diárias e eventos',
        titulo: `Pico de publicidade no trimestre pré-eleitoral (${ctx.exercicio})`,
        descricao:
          `Gasto de publicidade no 3º trimestre de ${ctx.exercicio} ` +
          `(${formatBRL(gastoPreEleitoral)}) foi ${pct.toFixed(0)}% acima da média ` +
          `trimestral do exercício. Possível indício a apurar.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `publicidade-eleitoral-${ctx.exercicio}`,
        sujeitoRotulo: 'Publicidade institucional',
        classificacao: pct >= 60 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 60,
          probabilidadeIrregularidade: Math.min(74, 40 + Math.round(pct / 3)),
        },
        fundamentoLegal: ['Lei 9.504/1997 art. 73 VI/VII'],
        evidencias: [
          {
            resumo: `Trimestre pré-eleitoral: ${formatBRL(gastoPreEleitoral)} · média trimestral: ${formatBRL(mediaTrimestral)}`,
            valor: gastoPreEleitoral,
          },
        ],
        explicacao:
          'Nos três meses anteriores ao pleito é vedada a publicidade ' +
          'institucional, salvo exceções (Lei 9.504/1997 art. 73). Um pico de ' +
          'gasto na janela pré-eleitoral é possível indício a apurar. ' +
          'DEPENDÊNCIA: sem o gasto do exercício anterior no contexto, compara-se ' +
          'com a média trimestral do próprio exercício.',
        valorEnvolvido: gastoPreEleitoral,
      },
    ];
  },
};

// DE-13 (Publicidade acima do teto da RCL) — implementado em
// `emergenciais-diarias-cat.ts`. Removido daqui para não duplicar o ID.
