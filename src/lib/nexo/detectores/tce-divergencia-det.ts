/**
 * Detector X2 (XS-TCE) — DIVERGÊNCIA SMARAPD × TCE-SP por nº de empenho — NEXO.
 *
 * Cruzamento de DUPLA FONTE OFICIAL: o empenho registrado no sistema interno da
 * Prefeitura (SMARAPD, via `ctx.empenhos`) contra a mesma despesa publicada pelo
 * Tribunal de Contas do Estado de São Paulo (TCE-SP, via `ctx.tceDespesas`). A
 * chave de junção é (número de empenho normalizado + raiz do CNPJ do credor).
 *
 * Como as duas pontas são prestações de contas OFICIAIS do mesmo fato, este é o
 * detector com o MENOR falso positivo do NEXO: as duas fontes deveriam bater à
 * vírgula. Gera indício quando:
 *   (a) o empenho existe nos dois lados mas os VALORES DIVERGEM além da
 *       tolerância (relativa >1% E absoluta >R$100) → classificacao 'suspeita';
 *   (b) o empenho existe num lado só (SMARAPD sem TCE, ou TCE sem SMARAPD) →
 *       classificacao 'atencao' (pode ser defasagem de publicação/coleta).
 *
 * Se `ctx.tceDespesas` estiver ausente/vazio, o cruzamento está INATIVO e o
 * detector retorna [] honestamente — nunca um falso negativo silencioso.
 *
 * REGRA DE LINGUAGEM: "indício, nunca acusação". Uma divergência pode ter
 * explicação legítima (anulação parcial, reforço lançado só num sistema,
 * defasagem temporal entre a remessa ao TCE e o estado atual do SMARAPD,
 * homologação de complemento). Convém apurar. Ver plano-mestre §6–§7.
 */
import type { EmpenhoNorm } from '../normalizar';
import { formatBRL } from '../normalizar';
import { ehEntidadePublica, cnpjRaiz, soDigitos } from '../entidades';
import type {
  AlertaDetectado,
  ContextoAnalise,
  Detector,
  Evidencia,
} from './tipos';

const CATEGORIA = 'Fiscalização';

/**
 * Despesa do TCE-SP já normalizada. O ORQUESTRADOR adiciona este campo+tipo a
 * `ContextoAnalise` depois (`ctx.tceDespesas?`); aqui só CONSUMIMOS o formato.
 */
export interface TceDespesaNorm {
  nrEmpenho: string;
  cnpj: string;
  nomeCredor: string;
  valor: number;
  data: string | null;
  orgao: string;
  exercicio: number;
}

/**
 * Converte os docs CRUS de `nexo_tce_despesas` (gravados por
 * functions/src/nexo/coleta-tce-despesas.ts) em TceDespesaNorm[]. Usado pela
 * rota de cômputo (`/api/nexo/detectar`) e pela análise ao vivo
 * (`/api/nexo/analise`) para popular `ctx.tceDespesas`.
 */
export function tceDespesasDeDocsTce(
  docs: Record<string, unknown>[],
): TceDespesaNorm[] {
  const out: TceDespesaNorm[] = [];
  for (const d of docs) {
    const nrEmpenho = String(d.nrEmpenho ?? d.nrEmpenhoBruto ?? '').trim();
    if (!nrEmpenho) continue;
    out.push({
      nrEmpenho,
      cnpj: soDigitos(String(d.cnpj ?? '')),
      nomeCredor: String(d.nomeCredor ?? ''),
      valor: typeof d.valor === 'number' ? d.valor : Number(d.valor) || 0,
      data: typeof d.data === 'string' ? d.data : null,
      orgao: String(d.orgao ?? ''),
      exercicio: Number(d._exercicio ?? d.exercicio) || 0,
    });
  }
  return out;
}

/** Tolerância da divergência de valor: precisa furar AMBAS para alertar. */
const TOL_RELATIVA = 0.01; // 1%
const TOL_ABSOLUTA = 100; // R$ 100,00

/**
 * Normaliza o número de empenho para a junção entre fontes. SMARAPD e TCE-SP
 * grafam o mesmo empenho de formas diferentes (zeros à esquerda, barra de
 * exercício, prefixos). Mantemos só os dígitos e tiramos zeros à esquerda — se
 * sobrar vazio (número não numérico), devolve a string crua em maiúsculas para
 * não colidir tudo num bucket vazio.
 */
export function normalizarNrEmpenho(nr: string | null | undefined): string {
  const dig = soDigitos(nr).replace(/^0+/, '');
  if (dig) return dig;
  return (nr ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Chave de junção: nº de empenho normalizado + raiz do CNPJ (colapsa filiais). */
function chaveJuncao(nrEmpenho: string, doc: string): string {
  return `${normalizarNrEmpenho(nrEmpenho)}|${cnpjRaiz(soDigitos(doc))}`;
}

/** true se a diferença de valor fura AMBAS as tolerâncias (relativa E absoluta). */
export function valoresDivergem(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  if (diff <= TOL_ABSOLUTA) return false;
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff / base > TOL_RELATIVA;
}

interface ParSmarapd {
  numeroEmpenho: string;
  cpfCnpj: string;
  nome: string;
  valor: number;
  data: string | null;
}

/**
 * Agrega os empenhos de UMA fonte por chave de junção (mesmo empenho lançado em
 * parcelas/reforços soma o valor; guarda o 1º nome/data não vazios). EXCLUI ente
 * público — divergência intra-governamental (duodécimo, repasse) não é objeto
 * deste detector de fornecedor.
 */
function indexarSmarapd(empenhos: EmpenhoNorm[]): Map<string, ParSmarapd> {
  const por = new Map<string, ParSmarapd>();
  for (const e of empenhos) {
    if (!e.numeroEmpenho || !/\d/.test(e.numeroEmpenho)) continue;
    if (ehEntidadePublica(e.cpfCnpj, e.fornecedorNome)) continue;
    const k = chaveJuncao(e.numeroEmpenho, e.cpfCnpj);
    const cur = por.get(k);
    if (cur) {
      cur.valor += e.valorEmpenhado;
      if (!cur.nome && e.fornecedorNome) cur.nome = e.fornecedorNome;
      if (!cur.data && e.data) cur.data = e.data;
    } else {
      por.set(k, {
        numeroEmpenho: e.numeroEmpenho,
        cpfCnpj: e.cpfCnpj,
        nome: e.fornecedorNome,
        valor: e.valorEmpenhado,
        data: e.data,
      });
    }
  }
  return por;
}

interface ParTce {
  nrEmpenho: string;
  cnpj: string;
  nome: string;
  valor: number;
  data: string | null;
  orgao: string;
}

/** Mesmo de cima para o lado TCE-SP. */
function indexarTce(despesas: TceDespesaNorm[]): Map<string, ParTce> {
  const por = new Map<string, ParTce>();
  for (const d of despesas) {
    if (!d.nrEmpenho || !/\d/.test(d.nrEmpenho)) continue;
    if (ehEntidadePublica(d.cnpj, d.nomeCredor)) continue;
    const k = chaveJuncao(d.nrEmpenho, d.cnpj);
    const cur = por.get(k);
    if (cur) {
      cur.valor += d.valor;
      if (!cur.nome && d.nomeCredor) cur.nome = d.nomeCredor;
      if (!cur.data && d.data) cur.data = d.data;
      if (!cur.orgao && d.orgao) cur.orgao = d.orgao;
    } else {
      por.set(k, {
        nrEmpenho: d.nrEmpenho,
        cnpj: d.cnpj,
        nome: d.nomeCredor,
        valor: d.valor,
        data: d.data,
        orgao: d.orgao,
      });
    }
  }
  return por;
}

/**
 * Acumulador de AUSÊNCIAS de um lado, agregadas por órgão. O split do X2 (ver
 * plano-mestre §2.3) separa X2-VALOR (divergência de valor, indício forte de
 * dupla fonte — sempre ativo, 'suspeita') de X2-AUSÊNCIA (empenho num lado só —
 * causa benigna frequente: defasagem de remessa/cobertura parcial). A ausência,
 * gerada empenho-a-empenho, é ~85% do volume e quase toda ruído. Agregamos UMA
 * linha por órgão (informativo) em vez de milhares de alertas individuais.
 */
interface AcumuladorAusencia {
  qtd: number;
  valorTotal: number;
  /** Amostra de até 3 empenhos (maior valor) para a evidência ser concreta. */
  exemplos: { numeroEmpenho: string; nome: string; valor: number }[];
}

/**
 * Núcleo testável do X2. Recebe as duas fontes já como listas e devolve os
 * alertas. SPLIT (plano-mestre §2.3):
 *  - X2-VALOR: 1 alerta 'suspeita' por empenho cujo valor diverge entre as
 *    fontes oficiais. SEMPRE ativo (menor falso positivo do NEXO).
 *  - X2-AUSÊNCIA: por padrão AGREGADO por órgão (1 'informativo' por órgão/lado),
 *    cortando ~85% do volume de alertas. Passe `ausenciaPorEmpenho:true` para o
 *    comportamento legado (1 'atencao' por empenho) — usado em apuração dirigida.
 */
export function analisarDivergenciaTce(input: {
  empenhos: EmpenhoNorm[];
  tceDespesas: TceDespesaNorm[];
  /** true → 1 alerta por empenho ausente (legado); default false → agregado/órgão. */
  ausenciaPorEmpenho?: boolean;
}): AlertaDetectado[] {
  const smarapd = indexarSmarapd(input.empenhos);
  const tce = indexarTce(input.tceDespesas);
  const agregarAusencia = !input.ausenciaPorEmpenho;

  const out: AlertaDetectado[] = [];
  // Acumuladores de ausência por (lado → órgão). Só usados quando agregando.
  const ausSmarapd = new Map<string, AcumuladorAusencia>();
  const ausTce = new Map<string, AcumuladorAusencia>();

  // Lado A: percorre o SMARAPD. Casa com TCE → compara valor; sem TCE → ausência.
  for (const [k, s] of smarapd) {
    const t = tce.get(k);
    const nome = s.nome || t?.nome || s.cpfCnpj;

    if (t) {
      // Empenho nos dois lados: só alerta se o valor divergir além da tolerância.
      if (!valoresDivergem(s.valor, t.valor)) continue;
      const diff = Math.abs(s.valor - t.valor);
      const evidencias: Evidencia[] = [
        {
          resumo: `SMARAPD (Prefeitura) — empenho ${s.numeroEmpenho}: ${formatBRL(s.valor)}`,
          valor: s.valor,
          data: s.data,
          ref: 'SMARAPD',
        },
        {
          resumo: `TCE-SP — empenho ${t.nrEmpenho}: ${formatBRL(t.valor)}${t.orgao ? ` · órgão: ${t.orgao}` : ''}`,
          valor: t.valor,
          data: t.data,
          ref: 'TCE-SP',
        },
        {
          resumo: `Diferença entre as fontes oficiais: ${formatBRL(diff)}`,
          valor: diff,
          data: null,
          ref: 'X2',
        },
      ];
      out.push({
        detectorId: 'X2',
        detectorNome: 'Divergência SMARAPD × TCE-SP por empenho',
        categoria: CATEGORIA,
        titulo: `Valor de empenho diverge entre SMARAPD e TCE-SP — ${nome}`,
        descricao:
          `O empenho ${s.numeroEmpenho} do fornecedor ${nome} aparece com valores ` +
          `diferentes nas duas fontes oficiais: ${formatBRL(s.valor)} no sistema da ` +
          `Prefeitura (SMARAPD) e ${formatBRL(t.valor)} na prestação de contas ao ` +
          `TCE-SP — diferença de ${formatBRL(diff)}. Duas fontes oficiais do mesmo ` +
          'fato deveriam bater.',
        sujeitoTipo: 'empenho',
        sujeitoId: s.cpfCnpj || k,
        sujeitoRotulo: nome,
        classificacao: 'suspeita',
        scores: {
          // Dupla fonte oficial: confiabilidade altíssima; a divergência em si é
          // o indício, mas a explicação (defasagem/anulação) reduz a chance de
          // irregularidade material.
          confiabilidade: 95,
          probabilidadeIrregularidade: 60,
        },
        fundamentoLegal: [
          'LAI Lei 12.527/2011',
          'LRF LC 101/2000 art.48',
          'dever de fidedignidade',
        ],
        evidencias,
        explicacao:
          'O mesmo empenho está publicado com valores diferentes no sistema interno ' +
          'da Prefeitura (SMARAPD) e na prestação de contas ao TCE-SP. Como ambas ' +
          'são fontes oficiais do mesmo fato, a divergência é um indício forte de ' +
          'inconsistência de dado a apurar. Pode ter explicação legítima — anulação/' +
          'reforço lançado só num sistema, defasagem entre a remessa ao TCE e o ' +
          'estado atual do SMARAPD, ou complemento homologado. Convém confrontar o ' +
          'empenho nas duas pontas. Não constitui, por si só, irregularidade nem ' +
          'acusação.',
        valorEnvolvido: diff,
        discriminador: `valor:${normalizarNrEmpenho(s.numeroEmpenho)}`,
      });
    } else {
      // SMARAPD sem correspondente no TCE. SMARAPD não traz órgão → bucket único.
      if (agregarAusencia) {
        acumularAusencia(ausSmarapd, '(sem órgão informado)', {
          numeroEmpenho: s.numeroEmpenho,
          nome,
          valor: s.valor,
        });
      } else {
        out.push(
          alertaAusencia({
            chave: k,
            lado: 'SMARAPD',
            outroLado: 'TCE-SP',
            numeroEmpenho: s.numeroEmpenho,
            cpfCnpj: s.cpfCnpj,
            nome,
            valor: s.valor,
            data: s.data,
            orgao: undefined,
          }),
        );
      }
    }
  }

  // Lado B: empenhos que existem SÓ no TCE-SP (não estão no SMARAPD coletado).
  for (const [k, t] of tce) {
    if (smarapd.has(k)) continue;
    const nome = t.nome || t.cnpj;
    if (agregarAusencia) {
      acumularAusencia(ausTce, t.orgao || '(sem órgão informado)', {
        numeroEmpenho: t.nrEmpenho,
        nome,
        valor: t.valor,
      });
    } else {
      out.push(
        alertaAusencia({
          chave: k,
          lado: 'TCE-SP',
          outroLado: 'SMARAPD',
          numeroEmpenho: t.nrEmpenho,
          cpfCnpj: t.cnpj,
          nome,
          valor: t.valor,
          data: t.data,
          orgao: t.orgao,
        }),
      );
    }
  }

  // Flush das ausências agregadas: 1 alerta 'informativo' por órgão e lado.
  if (agregarAusencia) {
    for (const [orgao, acc] of ausSmarapd) {
      out.push(alertaAusenciaAgregada('SMARAPD', 'TCE-SP', orgao, acc));
    }
    for (const [orgao, acc] of ausTce) {
      out.push(alertaAusenciaAgregada('TCE-SP', 'SMARAPD', orgao, acc));
    }
  }

  // Suspeitas (divergência de valor) antes das atenções (ausência); dentro de
  // cada classe, maior valor envolvido primeiro.
  const peso: Record<string, number> = {
    critico: 0,
    suspeita: 1,
    atencao: 2,
    informativo: 3,
  };
  return out.sort(
    (a, b) =>
      (peso[a.classificacao] ?? 9) - (peso[b.classificacao] ?? 9) ||
      b.valorEnvolvido - a.valorEnvolvido,
  );
}

/** Monta o alerta de ausência (empenho presente num lado só). */
function alertaAusencia(p: {
  chave: string;
  lado: 'SMARAPD' | 'TCE-SP';
  outroLado: 'SMARAPD' | 'TCE-SP';
  numeroEmpenho: string;
  cpfCnpj: string;
  nome: string;
  valor: number;
  data: string | null;
  orgao?: string;
}): AlertaDetectado {
  const fonteLabel =
    p.lado === 'SMARAPD' ? 'SMARAPD (Prefeitura)' : 'TCE-SP';
  const evidencias: Evidencia[] = [
    {
      resumo:
        `${fonteLabel} — empenho ${p.numeroEmpenho}: ${formatBRL(p.valor)}` +
        (p.orgao ? ` · órgão: ${p.orgao}` : ''),
      valor: p.valor,
      data: p.data,
      ref: p.lado,
    },
    {
      resumo: `Sem correspondente encontrado no ${p.outroLado} (pela chave empenho+CNPJ).`,
      data: null,
      ref: p.outroLado,
    },
  ];
  return {
    detectorId: 'X2',
    detectorNome: 'Divergência SMARAPD × TCE-SP por empenho',
    categoria: CATEGORIA,
    titulo: `Empenho presente só no ${p.lado} — ${p.nome}`,
    descricao:
      `O empenho ${p.numeroEmpenho} do fornecedor ${p.nome} (${formatBRL(p.valor)}) ` +
      `consta no ${fonteLabel}, mas não foi encontrado no ${p.outroLado} pela chave ` +
      'número de empenho + CNPJ. Pode ser defasagem entre as fontes ou cobertura ' +
      'parcial da coleta.',
    sujeitoTipo: 'empenho',
    sujeitoId: p.cpfCnpj || p.chave,
    sujeitoRotulo: p.nome,
    classificacao: 'atencao',
    scores: {
      // Fonte oficial de um dos lados; a ausência no outro tem causa benigna
      // frequente (defasagem temporal/cobertura), por isso prob. menor.
      confiabilidade: 88,
      probabilidadeIrregularidade: 35,
    },
    fundamentoLegal: [
      'LAI Lei 12.527/2011',
      'LRF LC 101/2000 art.48',
      'dever de fidedignidade',
    ],
    evidencias,
    explicacao:
      `O empenho aparece numa fonte oficial (${fonteLabel}) e não na outra ` +
      `(${p.outroLado}). É um indício de descompasso entre os registros a apurar. ` +
      'Causas legítimas são comuns: defasagem temporal entre a remessa ao TCE-SP e ' +
      'o estado atual do SMARAPD, recorte/cobertura parcial da coleta de uma das ' +
      'fontes, ou diferença na grafia do número de empenho. Convém confirmar o ' +
      'empenho diretamente nas duas pontas. Não é, por si só, irregularidade.',
    valorEnvolvido: p.valor,
    discriminador: `${p.lado === 'SMARAPD' ? 'so-smarapd' : 'so-tce'}:${normalizarNrEmpenho(p.numeroEmpenho)}`,
  };
}

/** Acumula um empenho ausente no bucket do órgão (mantém só os 3 maiores). */
function acumularAusencia(
  mapa: Map<string, AcumuladorAusencia>,
  orgao: string,
  emp: { numeroEmpenho: string; nome: string; valor: number },
): void {
  const cur = mapa.get(orgao);
  if (cur) {
    cur.qtd += 1;
    cur.valorTotal += emp.valor;
    cur.exemplos.push(emp);
  } else {
    mapa.set(orgao, { qtd: 1, valorTotal: emp.valor, exemplos: [emp] });
  }
}

/**
 * X2-AUSÊNCIA AGREGADA: UM alerta 'informativo' por órgão somando todos os
 * empenhos presentes só em `lado` (e não no `outroLado`). Substitui milhares de
 * alertas empenho-a-empenho — a ausência tem causa benigna frequente (defasagem
 * de remessa/cobertura parcial), então é sinal de COBERTURA a conferir, não
 * indício de irregularidade. Classificação 'informativo' (teto deste ramo).
 */
function alertaAusenciaAgregada(
  lado: 'SMARAPD' | 'TCE-SP',
  outroLado: 'SMARAPD' | 'TCE-SP',
  orgao: string,
  acc: AcumuladorAusencia,
): AlertaDetectado {
  const fonteLabel = lado === 'SMARAPD' ? 'SMARAPD (Prefeitura)' : 'TCE-SP';
  const top = acc.exemplos
    .slice()
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 3);
  const evidencias: Evidencia[] = [
    {
      resumo:
        `${acc.qtd} empenho(s) constam no ${fonteLabel} e não foram encontrados ` +
        `no ${outroLado} (chave empenho+CNPJ)` +
        (orgao && !orgao.startsWith('(') ? ` · órgão: ${orgao}` : '') +
        ` — total ${formatBRL(acc.valorTotal)}.`,
      valor: acc.valorTotal,
      data: null,
      ref: lado,
    },
    ...top.map((e) => ({
      resumo: `Exemplo — empenho ${e.numeroEmpenho} (${e.nome}): ${formatBRL(e.valor)}`,
      valor: e.valor,
      data: null,
      ref: lado,
    })),
    {
      resumo:
        'Agregado por órgão (X2-ausência). Indica COBERTURA/defasagem entre as ' +
        'fontes a conferir, não irregularidade. Para detalhar empenho-a-empenho, ' +
        'rodar o X2 em modo dirigido (ausenciaPorEmpenho).',
      data: null,
      ref: 'X2',
    },
  ];
  return {
    detectorId: 'X2',
    detectorNome: 'Divergência SMARAPD × TCE-SP por empenho',
    categoria: CATEGORIA,
    titulo:
      `Empenhos só no ${lado}${orgao && !orgao.startsWith('(') ? ` (${orgao})` : ''} ` +
      `— ${acc.qtd} sem correspondência no ${outroLado}`,
    descricao:
      `${acc.qtd} empenho(s) (total ${formatBRL(acc.valorTotal)}) constam no ` +
      `${fonteLabel}${orgao && !orgao.startsWith('(') ? ` para o órgão ${orgao}` : ''} ` +
      `mas não foram localizados no ${outroLado} pela chave número de empenho + ` +
      'CNPJ. Em regra é defasagem entre as fontes (remessa ao TCE-SP vs. estado ' +
      'atual do SMARAPD) ou cobertura parcial da coleta — sinal de completude a ' +
      'conferir, não de irregularidade.',
    sujeitoTipo: 'orgao',
    sujeitoId: `${lado}:${orgao}`,
    sujeitoRotulo: orgao && !orgao.startsWith('(') ? orgao : fonteLabel,
    // Teto deste ramo: 'informativo'. Ausência agregada não é indício material.
    classificacao: 'informativo',
    scores: {
      // Fonte oficial de um lado; ausência agregada tem causa quase sempre
      // benigna (defasagem/cobertura). Sinal de qualidade de dado, prob. baixa.
      confiabilidade: 80,
      probabilidadeIrregularidade: 12,
    },
    fundamentoLegal: [
      'LAI Lei 12.527/2011',
      'LRF LC 101/2000 art.48',
      'dever de fidedignidade',
    ],
    evidencias,
    explicacao:
      `Vários empenhos aparecem numa fonte oficial (${fonteLabel}) e não na outra ` +
      `(${outroLado}). Agregamos por órgão porque, individualmente, a ausência tem ` +
      'causa benigna frequente: defasagem entre a remessa ao TCE-SP e o estado ' +
      'atual do SMARAPD, cobertura parcial da coleta de um dos lados, ou diferença ' +
      'na grafia do número de empenho. É um indicador de COMPLETUDE/defasagem das ' +
      'fontes a conferir — NÃO uma irregularidade. A divergência de VALOR (quando o ' +
      'empenho existe nos dois lados) é tratada à parte, com peso maior. Convém ' +
      'confirmar a cobertura da coleta antes de qualquer leitura.',
    valorEnvolvido: acc.valorTotal,
    discriminador: `aus-agg:${lado}:${orgao}`,
  };
}

/**
 * Shim de FORWARD-COMPATIBILIDADE. O orquestrador ainda vai adicionar o campo
 * `tceDespesas?: TceDespesaNorm[]` em `ContextoAnalise` (tipos.ts). Até lá, este
 * tipo local declara o campo OPCIONAL que CONSUMIMOS, sem editar tipos.ts e sem
 * quebrar o build. Quando o campo entrar no tipo oficial, este `&` é inócuo —
 * basta apagar este alias. COMO FIAR: orquestrador adiciona
 * `tceDespesas?: TceDespesaNorm[]` (e o `import type { TceDespesaNorm }`) em
 * `ContextoAnalise` e popula a partir da coleta TCE-SP.
 */
type ContextoComTce = ContextoAnalise & { tceDespesas?: TceDespesaNorm[] };

/**
 * Detector X2 no formato do pipeline (`rodarDetectores`). Degrada para []
 * honestamente quando o TCE-SP não foi anexado ao contexto (cruzamento inativo)
 * — nunca um falso negativo silencioso.
 */
export const detectorDivergenciaTce: Detector = {
  id: 'X2',
  nome: 'Divergência SMARAPD × TCE-SP por empenho',
  categoria: CATEGORIA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const tceDespesas = (ctx as ContextoComTce).tceDespesas ?? [];
    if (tceDespesas.length === 0) return []; // fonte TCE-SP não anexada
    if (ctx.empenhos.length === 0) return [];
    return analisarDivergenciaTce({
      empenhos: ctx.empenhos,
      tceDespesas,
    });
  },
};
