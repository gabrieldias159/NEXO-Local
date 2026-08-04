/**
 * Detector computável de Fornecedores (área FR do catálogo).
 *
 *  FR-08 — CNAE incompatível com o objeto contratado.
 *
 * FR-05 (Empresa punida no portal) foi removido deste arquivo: havia uma
 * implementação idêntica (também `[]` por falta do módulo `empresaspunidas`)
 * em `diversos-cat.ts` (detectorEmpresaPunidaPortal). Mantém-se a de lá para
 * não ter dois detectores com o mesmo `FR-05`.
 *
 * Trabalham sobre `DespesaAgrupada` e `empenhos`. Linguagem: indício a apurar.
 */
import { formatBRL, type DespesaNorm } from '../normalizar';
import type { AlertaDetectado, Detector } from './tipos';

// ── FR-08 — CNAE incompatível com o objeto ───────────────────────────────────
/**
 * Lei 14.133/2021 art. 62/67: a contratada deve ter aderência entre sua
 * atividade econômica (CNAE) e o objeto contratado.
 *
 * O `ContextoAnalise` NÃO traz o CNAE do fornecedor (vem do enriquecimento
 * cadastral assíncrono, fora de um Detector síncrono). Sem o CNAE não é
 * possível medir a aderência ao objeto da forma exata do catálogo.
 *
 * Para entregar valor sem inventar dado, este detector aplica uma proxy
 * conservadora e honesta: detecta o MESMO fornecedor (mesmo CNPJ) recebendo
 * empenhos para objetos de naturezas economicamente MUITO distintas (ex.:
 * combustível + obra + medicamento + serviço de TI). Um fornecedor real tende
 * a operar num ramo; atuar em ramos sem relação entre si é possível indício de
 * que o CNAE não cobre parte dos objetos contratados.
 */
const RAMOS: ReadonlyArray<{ ramo: string; re: RegExp }> = [
  { ramo: 'combustível', re: /combust[íi]vel|gasolina|diesel|etanol|posto/i },
  { ramo: 'saúde/medicamentos', re: /medicament|f[áa]rmac|hospitalar|insumo m[ée]dic|material m[ée]dic/i },
  { ramo: 'obras/engenharia', re: /\bobra|pavimenta|constru[çc]|engenharia|asfalt/i },
  { ramo: 'tecnologia/TI', re: /\bTI\b|software|sistema|inform[áa]tica|licen[çc]a de uso/i },
  { ramo: 'alimentação/merenda', re: /merenda|alimenta[çc][ãa]o|g[êe]nero aliment[íi]cio|cesta b[áa]sica/i },
  { ramo: 'limpeza/conservação', re: /limpeza|conserva[çc][ãa]o|higieniza[çc]/i },
  { ramo: 'transporte/locação de veículo', re: /transporte escolar|loca[çc][ãa]o de ve[íi]culo|fretament/i },
  { ramo: 'construção civil — material', re: /material de constru[çc]/i },
  { ramo: 'mobiliário/equipamento', re: /mobili[áa]rio|m[óo]vel|equipamento de inform/i },
  { ramo: 'eventos/publicidade', re: /evento|show|publicidad|propaganda|sonoriza[çc]/i },
];

function ramosDoObjeto(texto: string): Set<string> {
  const r = new Set<string>();
  for (const { ramo, re } of RAMOS) if (re.test(texto)) r.add(ramo);
  return r;
}

export const detectorCnaeIncompativel: Detector = {
  id: 'FR-08',
  nome: 'CNAE incompatível com o objeto',
  categoria: 'Fornecedores',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const porCnpj = new Map<string, { despesas: DespesaNorm[]; ramos: Set<string>; nome: string }>();

    for (const d of ctx.despesas) {
      if (!d.cpfCnpj || d.cpfCnpj.length !== 14 || d.valorEmpenhado <= 0) continue;
      const ramos = ramosDoObjeto(`${d.objeto} ${d.elemento}`);
      if (ramos.size === 0) continue;
      const cur = porCnpj.get(d.cpfCnpj) ?? {
        despesas: [],
        ramos: new Set<string>(),
        nome: d.fornecedorNome,
      };
      cur.despesas.push(d);
      for (const r of ramos) cur.ramos.add(r);
      if (!cur.nome && d.fornecedorNome) cur.nome = d.fornecedorNome;
      porCnpj.set(d.cpfCnpj, cur);
    }

    for (const [cnpj, dados] of porCnpj) {
      // Sem o CNAE real, esta é uma proxy fraca: heterogeneidade textual de
      // objetos NÃO é incompatibilidade cadastral. Exige-se ≥4 ramos muito
      // distintos só para sinalizar — e o alerta nasce como informativo.
      if (dados.ramos.size < 4) continue;
      const soma = dados.despesas.reduce((s, d) => s + d.valorEmpenhado, 0);
      const nome = dados.nome || cnpj;
      const ramos = [...dados.ramos];
      out.push({
        detectorId: 'FR-08',
        detectorNome: 'CNAE incompatível com o objeto',
        categoria: 'Fornecedores',
        titulo: `Fornecedor atuando em ramos heterogêneos — ${nome}`,
        descricao:
          `O fornecedor recebeu empenhos para ${ramos.length} ramos economicamente ` +
          `distintos (${ramos.join(', ')}), somando ${formatBRL(soma)}. ` +
          `Possível indício a apurar de objeto fora da atividade declarada.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao: dados.ramos.size >= 5 ? 'atencao' : 'informativo',
        scores: {
          confiabilidade: 42,
          probabilidadeIrregularidade: Math.min(48, 18 + dados.ramos.size * 5),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 62, 67'],
        evidencias: ramos.slice(0, 8).map((r) => {
          const exemplo = dados.despesas.find((d) =>
            RAMOS.find((x) => x.ramo === r)?.re.test(`${d.objeto} ${d.elemento}`),
          );
          return {
            resumo: `Ramo "${r}"${exemplo ? ` — ex.: ${exemplo.objeto}` : ''}`,
            valor: exemplo?.valorEmpenhado,
            data: exemplo?.data ?? null,
          };
        }),
        explicacao:
          'A contratada deve ter aderência entre sua atividade econômica e o ' +
          'objeto contratado (Lei 14.133/2021 art. 62/67). Um mesmo fornecedor ' +
          'atuando em ramos sem relação entre si é possível indício a apurar de ' +
          'que o CNAE não cobre parte dos objetos. DEPENDÊNCIA: o CNAE do ' +
          'fornecedor não está no contexto; usa-se a heterogeneidade dos objetos ' +
          'contratados como proxy — a confirmação exige consultar o CNAE no cadastro.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};
