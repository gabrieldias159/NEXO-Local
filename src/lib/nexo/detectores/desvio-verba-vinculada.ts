import { formatBRL, type DespesaNorm } from '../normalizar';
import { ehEntidadePublica } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';

interface VinculoFonte {
  rotulo: string;
  padroesUG: RegExp[];
  palavrasChave: RegExp;
  usosPermitidos: string[];
}

const FONTES_VINCULADAS: VinculoFonte[] = [
  {
    rotulo: 'FUNDEB (Educação Básica)',
    padroesUG: [/fundeb/i, /educa[cç][aã]o/i, /ensino/i, /merenda/i, /mde/i],
    palavrasChave: /educa[cç][aã]o|ensino|merenda|escola|professor|aluno|magist[eé]rio/i,
    usosPermitidos: ['educação', 'ensino', 'magistério', 'merenda escolar', 'transporte escolar'],
  },
  {
    rotulo: 'FMS (Saúde)',
    padroesUG: [/fms/i, /sa[úu]de/i, /hospitalar/i, /vigil[aâ]ncia sanit[aá]ria/i, /sus/i],
    palavrasChave: /sa[úu]de|hospital|m[eé]dico|medicamento|vacina|UBS|posto de sa[úu]de/i,
    usosPermitidos: ['saúde', 'hospitalar', 'medicamentos', 'vigilância sanitária'],
  },
  {
    rotulo: 'FNAS (Assistência Social)',
    padroesUG: [/fnas/i, /assist[eê]ncia social/i, /cras/i, /creas/i],
    palavrasChave: /assist[eê]ncia social|cras|creas|benef[ií]cio/i,
    usosPermitidos: ['assistência social', 'CRAS', 'CREAS'],
  },
];

function identificarFontes(ug: string): VinculoFonte[] {
  const fontes: VinculoFonte[] = [];
  for (const f of FONTES_VINCULADAS) {
    if (f.padroesUG.some((re) => re.test(ug))) fontes.push(f);
  }
  return fontes;
}

function objetoCompativel(objeto: string, fonte: VinculoFonte): boolean {
  return fonte.palavrasChave.test(objeto);
}

export const detectorDesvioVerbaVinculada: Detector = {
  id: 'OR-11',
  nome: 'Desvio de verba vinculada',
  categoria: 'Execução orçamentária',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const incompatibilidades: Array<{ ug: string; fonte: VinculoFonte; despesas: DespesaNorm[] }> = [];

    for (const d of ctx.despesas) {
      if (d.valorEmpenhado <= 0) continue;
      if (!d.unidadeGestora) continue;
      if (d.cpfCnpj && ehEntidadePublica(d.cpfCnpj, d.fornecedorNome)) continue;

      const fontes = identificarFontes(d.unidadeGestora);
      if (fontes.length === 0) continue;

      for (const fonte of fontes) {
        if (objetoCompativel(d.objeto || '', fonte)) continue;

        let existing = incompatibilidades.find(
          (i) => i.ug === d.unidadeGestora && i.fonte.rotulo === fonte.rotulo,
        );
        if (!existing) {
          existing = { ug: d.unidadeGestora, fonte, despesas: [] };
          incompatibilidades.push(existing);
        }
        existing.despesas.push(d);
      }
    }

    for (const item of incompatibilidades) {
      const soma = item.despesas.reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
      if (soma < 5_000) continue;

      const exemplos = item.despesas.slice(0, 6);
      out.push({
        detectorId: 'OR-11',
        detectorNome: 'Desvio de verba vinculada',
        categoria: 'Execução orçamentária',
        titulo: `Possível desvio de verba vinculada — ${item.fonte.rotulo} em ${item.ug}`,
        descricao:
          `${exemplos.length} despesa(s) na unidade gestora "${item.ug}" ` +
          `(associada a ${item.fonte.rotulo}) com objeto incompatível com a finalidade ` +
          `da fonte, somando ${formatBRL(soma)}. Possível indício a apurar.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `desvio-verba-${item.ug}`,
        sujeitoRotulo: item.ug,
        classificacao: soma > 100_000 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 65,
          probabilidadeIrregularidade: Math.min(80, 45 + exemplos.length * 5),
        },
        fundamentoLegal: [
          'DL 201/1967, art. 1º, III (aplicar indevidamente verbas) — a apurar',
          'LC 101/2000 art. 8º (vinculação de receitas)',
        ],
        evidencias: exemplos.map((d) => ({
          resumo: `${d.objeto || 'sem descrição'} — ${formatBRL(Math.abs(d.valorEmpenhado))}`,
          valor: Math.abs(d.valorEmpenhado),
          data: d.data,
        })),
        explicacao:
          'Recursos vinculados (FUNDEB, FMS, FNAS) têm destinação específica por lei. ' +
          'Empenhos em unidades gestoras associadas a estas fontes com objeto ' +
          'incompatível com a finalidade são possível indício de desvio de finalidade. ' +
          'ATENÇÃO: a associação UG→fonte é baseada em padrões textuais da unidade ' +
          'gestora, não no código de fonte de recurso do empenho (que não está ' +
          'disponível neste contexto). Algumas UGs podem atender a múltiplas fontes. ' +
          'A CONFIRMAÇÃO exige verificar a classificação orçamentária completa.',
        valorEnvolvido: soma,
      });
    }

    return out;
  },
};
