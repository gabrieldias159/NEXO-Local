/**
 * Detectores adicionais de Diárias.
 *
 *  DE-03 — Diárias do mesmo beneficiário na mesma data.
 *  DE-05 — Grupo fixo de viajantes (sempre os mesmos juntos).
 *
 * Os detectores de publicidade/eventos (DE-06/12/13) dependem dos módulos
 * `passagenslocomocao` e `publicidade` — ficam como computáveis no catálogo
 * até que esses conectores entrem.
 */
import { formatBRL, type DiariaNorm } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

export const detectorDiariasMesmaData: Detector = {
  id: 'DE-03',
  nome: 'Diárias na mesma data',
  categoria: 'Diárias e eventos',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const porBenef = new Map<string, Map<string, DiariaNorm[]>>();
    for (const d of ctx.diarias) {
      if (!d.beneficiario || !d.data || d.valor <= 0) continue;
      const chave = d.beneficiario.toUpperCase().trim();
      const porData = porBenef.get(chave) ?? new Map<string, DiariaNorm[]>();
      const arr = porData.get(d.data) ?? [];
      arr.push(d);
      porData.set(d.data, arr);
      porBenef.set(chave, porData);
    }
    for (const porData of porBenef.values()) {
      const colisoes = [...porData.values()].filter((a) => a.length >= 2);
      if (colisoes.length === 0) continue;
      const todas = colisoes.flat();
      const nome = todas[0].beneficiario;
      const soma = todas.reduce((s, d) => s + d.valor, 0);
      out.push({
        detectorId: 'DE-03',
        detectorNome: 'Diárias na mesma data',
        categoria: 'Diárias e eventos',
        titulo: `Diárias concomitantes — ${nome}`,
        descricao:
          `${colisoes.length} data(s) com ${todas.length} diárias do mesmo ` +
          `beneficiário no mesmo dia, somando ${formatBRL(soma)}.`,
        sujeitoTipo: 'servidor',
        sujeitoId: nome,
        sujeitoRotulo: nome,
        classificacao: 'suspeita',
        scores: { confiabilidade: 74, probabilidadeIrregularidade: 60 },
        fundamentoLegal: ['Lei 8.429/1992 art. 10; decreto municipal de diárias'],
        evidencias: colisoes.slice(0, 6).map((a) => ({
          resumo: `${a.length} diárias em ${a[0].data} — ${formatBRL(a.reduce((s, d) => s + d.valor, 0))}`,
          data: a[0].data,
        })),
        explicacao:
          'Mais de uma diária para o mesmo servidor no mesmo dia merece ' +
          'verificação — uma diária é indenização por um deslocamento; datas ' +
          'concomitantes podem indicar duplicidade ou erro de prestação de contas.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

export const detectorGrupoViajantes: Detector = {
  id: 'DE-05',
  nome: 'Grupo fixo de viajantes',
  categoria: 'Diárias e eventos',
  detectar(ctx) {
    const porData = new Map<string, Set<string>>();
    for (const d of ctx.diarias) {
      if (!d.beneficiario || !d.data) continue;
      const set = porData.get(d.data) ?? new Set<string>();
      set.add(d.beneficiario.toUpperCase().trim());
      porData.set(d.data, set);
    }
    const pares = new Map<string, number>();
    for (const set of porData.values()) {
      const arr = [...set].sort();
      if (arr.length < 2 || arr.length > 30) continue;
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const k = `${arr[i]}|||${arr[j]}`;
          pares.set(k, (pares.get(k) ?? 0) + 1);
        }
      }
    }
    const out: AlertaDetectado[] = [];
    for (const [par, n] of pares) {
      if (n < 5) continue;
      const [a, b] = par.split('|||');
      out.push({
        detectorId: 'DE-05',
        detectorNome: 'Grupo fixo de viajantes',
        categoria: 'Diárias e eventos',
        titulo: `Dupla recorrente em diárias — ${a} & ${b}`,
        descricao: `Os dois beneficiários receberam diárias na mesma data ${n} vezes.`,
        sujeitoTipo: 'servidor',
        sujeitoId: par,
        sujeitoRotulo: `${a} & ${b}`,
        classificacao: 'atencao',
        scores: { confiabilidade: 62, probabilidadeIrregularidade: Math.min(64, 30 + n * 4) },
        fundamentoLegal: ['Controle interno; princípio da impessoalidade'],
        evidencias: [{ resumo: `${n} deslocamentos coincidentes` }],
        explicacao:
          'Sempre o mesmo grupo viajando junto não é irregularidade em si, mas ' +
          'merece verificar a necessidade e o resultado dos deslocamentos.',
        valorEnvolvido: 0,
      });
    }
    return out.sort((x, y) => y.scores.probabilidadeIrregularidade - x.scores.probabilidadeIrregularidade).slice(0, 8);
  },
};
