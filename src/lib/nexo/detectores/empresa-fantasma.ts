import { formatBRL, type DespesaNorm } from '../normalizar';
import { ehEntidadePublica, cnpjRaiz } from '../entidades';
import type { AlertaDetectado, Detector } from './tipos';
import type { SocioCtx } from './socio-comum-det';

const RAMOS_DISTINTOS_MIN = 3;

const RAMOS: ReadonlyArray<{ ramo: string; re: RegExp }> = [
  { ramo: 'combustível', re: /combust[íi]vel|gasolina|diesel|etanol|posto/i },
  { ramo: 'saúde/medicamentos', re: /medicament|f[áa]rmac|hospitalar/i },
  { ramo: 'obras/engenharia', re: /\bobra|pavimenta|constru[çc]|engenharia|asfalt/i },
  { ramo: 'tecnologia/TI', re: /\bTI\b|software|sistema|inform[áa]tica|licen[çc]a/i },
  { ramo: 'alimentação', re: /merenda|alimenta[çc][ãa]o|g[êe]nero aliment/i },
  { ramo: 'limpeza/conservação', re: /limpeza|conserva[çc][ãa]o|higieniza[çc]/i },
  { ramo: 'transporte', re: /transporte escolar|loca[çc][ãa]o de ve[íi]culo/i },
  { ramo: 'construção civil', re: /material de constru[çc]/i },
  { ramo: 'eventos/publicidade', re: /evento|show|publicidad|propaganda/i },
  { ramo: 'serviço jurídico', re: /advocaci|escrit[óo]rio de advoc|assessoria jur[ií]dic/i },
];

function ramosDoObjeto(texto: string): Set<string> {
  const r = new Set<string>();
  for (const { ramo, re } of RAMOS) if (re.test(texto)) r.add(ramo);
  return r;
}

function sociosPorCnpj(socios: SocioCtx[]): Map<string, SocioCtx> {
  const m = new Map<string, SocioCtx>();
  for (const s of socios) m.set(cnpjRaiz(s.cnpj), s);
  return m;
}

export const detectorEmpresaFantasma: Detector = {
  id: 'FN-06',
  nome: 'Empresa fantasma / fachada',
  categoria: 'Fornecedores',
  detectar(ctx) {
    const out: AlertaDetectado[] = [];
    const porCnpj = new Map<string, {
      despesas: DespesaNorm[];
      ramos: Set<string>;
      nome: string;
      dataMaisAntiga: string | null;
    }>();

    for (const d of ctx.despesas) {
      if (!d.cpfCnpj || d.cpfCnpj.length !== 14 || d.valorEmpenhado <= 0) continue;
      if (ehEntidadePublica(d.cpfCnpj, d.fornecedorNome)) continue;
      const raiz = cnpjRaiz(d.cpfCnpj);
      const cur = porCnpj.get(raiz) ?? {
        despesas: [],
        ramos: new Set<string>(),
        nome: d.fornecedorNome,
        dataMaisAntiga: null as string | null,
      };
      cur.despesas.push(d);
      for (const r of ramosDoObjeto(`${d.objeto} ${d.elemento}`)) cur.ramos.add(r);
      if (!cur.nome && d.fornecedorNome) cur.nome = d.fornecedorNome;
      if (d.data && (!cur.dataMaisAntiga || d.data < cur.dataMaisAntiga)) {
        cur.dataMaisAntiga = d.data;
      }
      porCnpj.set(raiz, cur);
    }

    const sociosIndex = ctx.socios ? sociosPorCnpj(ctx.socios) : new Map();

    for (const [raiz, dados] of porCnpj) {
      const soma = dados.despesas.reduce((s, d) => s + Math.abs(d.valorEmpenhado), 0);
      if (soma < 20_000) continue;

      const fatores: string[] = [];
      let scoreExtra = 0;
      const nome = dados.nome || raiz;

      if (dados.ramos.size >= RAMOS_DISTINTOS_MIN) {
        fatores.push(`ramos: ${dados.ramos.size} diferentes`);
        scoreExtra += 15;
      }

      const socioInfo = sociosIndex.get(raiz);
      if (socioInfo && socioInfo.socios.length > 0 && ctx.socios) {
        const hashesSocioInfo = new Set(socioInfo.socios.map((sp: { cpfHash: string }) => sp.cpfHash));
        const socioEmOutros: SocioCtx[] = ctx.socios.filter(
          (s) => cnpjRaiz(s.cnpj) !== raiz && s.socios.some(
            (sp: { cpfHash: string }) => hashesSocioInfo.has(sp.cpfHash),
          ),
        );
        if (socioEmOutros.length >= 2) {
          fatores.push(`sócio compartilhado com ${socioEmOutros.length} outros fornecedores`);
          scoreExtra += 20;
        }
      }

      if (dados.dataMaisAntiga) {
        const mesAno = dados.dataMaisAntiga.slice(0, 7);
        const ano = parseInt(dados.dataMaisAntiga.slice(0, 4), 10);
        const mes = parseInt(dados.dataMaisAntiga.slice(5, 7), 10);
        if (ano === ctx.exercicio && mes >= 9) {
          fatores.push(`1º contrato no ${mesAno} (último trimestre do exercício)`);
          scoreExtra += 15;
        }
      }

      if (fatores.length === 0) continue;

      const classificacao = scoreExtra >= 30 ? 'suspeita' : scoreExtra >= 15 ? 'atencao' : 'informativo';

      out.push({
        detectorId: 'FN-06',
        detectorNome: 'Empresa fantasma / fachada',
        categoria: 'Fornecedores',
        titulo: `Possível empresa fantasma — ${nome}`,
        descricao:
          `Fornecedor com ${formatBRL(soma)} em contratos no exercício ` +
          `apresenta ${fatores.join('; ')}. Possível indício a apurar.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: raiz,
        sujeitoRotulo: nome,
        classificacao,
        scores: {
          confiabilidade: Math.min(80, 50 + scoreExtra),
          probabilidadeIrregularidade: Math.min(78, 30 + scoreExtra * 1.5),
        },
        fundamentoLegal: [
          'Lei 14.133/2021 art. 75 (dispensa — possível fraude)',
          'DL 201/1967, art. 1º, I — a apurar',
        ],
        evidencias: dados.despesas.slice(0, 6).map((d) => ({
          resumo: `${d.objeto || 'sem objeto'} — ${formatBRL(Math.abs(d.valorEmpenhado))}`,
          valor: Math.abs(d.valorEmpenhado),
          data: d.data,
        })),
        explicacao:
          'Empresa fantasma ou de fachada é pessoa jurídica criada com o propósito ' +
          'de emitir notas fiscais para desvio de dinheiro público, sem capacidade ' +
          'operacional real. Este detector sinaliza PADRÕES INDICIÁRIOS: atuação em ' +
          'ramos muito distintos, sócios compartilhados entre múltiplos fornecedores ' +
          'e surgimento recente com contratos relevantes. NENHUM destes fatores, ' +
          'isoladamente, comprova irregularidade — empresas legítimas podem ter ' +
          'sócios em comum e atuar em múltiplas áreas. A apuração exige verificação ' +
          'documental (visita ao endereço, análise de capacidade operacional, ' +
          'consulta ao QSA completo e à situação cadastral na Receita). ' +
          'DEPENDÊNCIA: dados cadastrais (capital social, data de abertura, ' +
          'endereço) não estão no contexto — seriam necessários para refinar a detecção.',
        valorEnvolvido: soma,
      });
    }

    return out;
  },
};
