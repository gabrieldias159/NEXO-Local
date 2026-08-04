/**
 * Detector XS-14 — RESPONSÁVEL COM CONTAS JULGADAS IRREGULARES NO TCE-SP
 * (Ficha Limpa / LC 64/90) cruzado com FORNECEDORES/SÓCIOS da Prefeitura — NEXO.
 *
 * Cruza a relação pública do TCE-SP de "responsáveis por contas julgadas
 * irregulares" (`ctx.contasIrregulares`, que o ORQUESTRADOR adiciona depois —
 * aqui só CONSUMIMOS) contra:
 *   (a) os FORNECEDORES da Prefeitura (de `ctx.empenhos`), e
 *   (b) os SÓCIOS desses fornecedores (de `ctx.socios`, do XS-SOCIO).
 * Um fornecedor (pessoa física) ou um sócio de fornecedor que ALÉM DISSO consta
 * na lista do TCE como responsável por contas julgadas irregulares é um VÍNCULO
 * A APURAR (quem recebe recurso público de Marília teve contas reprovadas pelo
 * Tribunal — convém verificar idoneidade / impedimento).
 *
 * ── ⚠ GUARDRAILS DUROS (LEIA ANTES DE QUALQUER COISA) ────────────────────────
 *  1. NUNCA AFIRMA INELEGIBILIDADE. "Contas julgadas irregulares no TCE" é
 *     INSUMO da Lei da Ficha Limpa, mas a INELEGIBILIDADE em si é decisão
 *     EXCLUSIVA da JUSTIÇA ELEITORAL (afere dolo, ressarcimento, suspensão
 *     judicial, prazo de 8 anos, recurso etc.). Este detector só diz
 *     "responsável com contas julgadas irregulares no TCE, A VERIFICAR".
 *  2. CPF É ANONIMIZADO NA FONTE (`NNN.XXX.XXX-NN`): não há CPF cru, logo NÃO há
 *     "match por CPF idêntico" de verdade. O casamento é por NOME normalizado.
 *     A "impressão digital" parcial do CPF (`pre3-DV`, ex.: `124-54`) só
 *     CORROBORA um match por nome — ela colide (milhares de CPFs a compartilham),
 *     então sozinha não vale nada e NUNCA é tratada como identidade confirmada.
 *     Classificação:
 *        • NOME + corroboração por CPF parcial → 'atencao' (ainda assim "confirmar
 *          identidade"; é o teto desta fonte);
 *        • NOME apenas (sem CPF parcial batendo) → 'informativo' com o aviso
 *          "confirmar identidade (homonímia)".
 *     NÃO existe aqui o caso "CPF idêntico = atencao" do briefing original porque
 *     a fonte ANONIMIZA o CPF — ver nota de degradação no fim do arquivo.
 *  3. SEM Lei 8.429/92 (improbidade). Nenhum juízo de improbidade é feito.
 *  4. DEGRADA PARA [] sem a fonte: se `ctx.contasIrregulares` está ausente/vazio,
 *     o cruzamento está INATIVO e o detector retorna [] honestamente.
 *  5. ENTE PÚBLICO É EXCLUÍDO (não é "fornecedor" fiscalizável; espelha a regra
 *     P0 do NEXO).
 *
 * LGPD: nenhum CPF cru é exibido ou persistido (a fonte já é anonimizada). O
 * cruzamento usa NOME normalizado + impressão digital parcial; a exibição usa
 * `cpfMasc` e nome.
 */
import { formatBRL } from '../normalizar';
import { ehEntidadePublica, cnpjRaiz, soDigitos, normalizarNome } from '../entidades';
import type { SocioCtx } from './socio-comum-det';
import type { AlertaDetectado, ContextoAnalise, Detector, Evidencia } from './tipos';

const CATEGORIA = 'Fornecedores';

/**
 * Um responsável da relação do TCE-SP de contas julgadas irregulares, já
 * anonimizado pela fonte. O ORQUESTRADOR ainda vai adicionar
 * `ctx.contasIrregulares?: ContaIrregularCtx[]` a `ContextoAnalise`; aqui só
 * CONSUMIMOS este formato (vindo de `nexo_contas_irregulares`).
 *
 * `cpfParcial` = impressão digital `{3 primeiros}-{2 DV}` (ex.: `124-54`),
 * chave FRACA de corroboração. `cpfMasc` = máscara `NNN.XXX.XXX-NN` só p/ exibir.
 * NÃO há CPF cru nem hash de CPF completo (a fonte anonimiza).
 */
export interface ContaIrregularCtx {
  /** Nome do responsável, como veio do TCE. */
  nome: string;
  /** Nome normalizado (sem acento, caixa-alta, espaço único) — chave do match. */
  nomeNorm: string;
  /** CPF mascarado para exibição (`NNN.XXX.XXX-NN`). */
  cpfMasc: string;
  /** Impressão digital parcial `{pre3}-{DV2}` (corroboração fraca). */
  cpfParcial: string;
  /** Nº do processo no TCE-SP (ex.: `512/026/11`). */
  processoTC: string;
  /** Exercício a que se refere a conta julgada. */
  exercicio: number | null;
  /** Órgão de origem (ex.: `DEPARTAMENTO DE AGUA E ESGOTO DE MARILIA`). */
  origem: string;
}

/**
 * Converte os docs CRUS de `nexo_contas_irregulares` (gravados pelo coletor TCE,
 * já anonimizados) em ContaIrregularCtx[]. Usado pelas rotas p/ popular
 * `ctx.contasIrregulares`. Sem CPF cru — só máscara/parcial. Recalcula
 * `nomeNorm` localmente caso o doc não traga (defensivo).
 */
export function contasIrregularesDeDocs(
  docs: Record<string, unknown>[],
): ContaIrregularCtx[] {
  const out: ContaIrregularCtx[] = [];
  for (const d of docs) {
    const nome = String(d.nome ?? '').trim();
    const nomeNorm = String(d.nomeNorm ?? '') || normalizarNome(nome);
    if (!nomeNorm) continue;
    const exRaw = d.exercicio;
    const exercicio =
      typeof exRaw === 'number'
        ? exRaw
        : exRaw != null && exRaw !== ''
          ? Number(exRaw) || null
          : null;
    out.push({
      nome,
      nomeNorm,
      cpfMasc: String(d.cpfMasc ?? ''),
      cpfParcial: String(d.cpfParcial ?? ''),
      processoTC: String(d.processoTC ?? ''),
      exercicio,
      origem: String(d.origem ?? ''),
    });
  }
  return out;
}

/**
 * Shim de FORWARD-COMPATIBILIDADE. O orquestrador ainda vai adicionar a
 * `ContextoAnalise` (tipos.ts) os campos OPCIONAIS que CONSUMIMOS aqui. Até lá,
 * este alias os declara local sem editar tipos.ts e sem quebrar o build. Quando
 * entrarem no tipo oficial, este `&` é inócuo — basta apagar o alias.
 *
 * COMO FIAR (orquestrador):
 *   - adicionar em `ContextoAnalise`:
 *       `contasIrregulares?: ContaIrregularCtx[]`
 *     (e o `import type { ContaIrregularCtx } from './contas-irregulares-det'`);
 *   - popular a partir de `nexo_contas_irregulares` via `contasIrregularesDeDocs`;
 *   - `socios?: SocioCtx[]` já existe no tipo oficial (XS-SOCIO) — reusamos.
 */
type ContextoComContas = ContextoAnalise & {
  contasIrregulares?: ContaIrregularCtx[];
  socios?: SocioCtx[];
};

/**
 * Fundamento legal — SEM Lei 8.429/92. Cita a LC 64/90 (Ficha Limpa) e a CF
 * SÓ como CONTEXTO da relação do TCE (de onde o dado vem), nunca como
 * enquadramento que afirme inelegibilidade — isso é da Justiça Eleitoral.
 */
const FUNDAMENTO_LEGAL = [
  'LC 64/1990 art.1º I "g" e §4º-A (Ficha Limpa, LC 135/2010) — relação do TCE',
  'CF art.37 (idoneidade/impedimentos na contratação pública)',
];

interface FornecedorPF {
  /** Chave de agregação: CPF mascarado (PF não tem CNPJ-raiz). */
  chave: string;
  cpfCnpj: string;
  nome: string;
  nomeNorm: string;
  valorEmpenhado: number;
}

/**
 * Agrega os empenhos de fornecedores PESSOA FÍSICA (CPF, 11 dígitos) por
 * nome normalizado — são os candidatos a casar diretamente com um responsável
 * do TCE (que também é pessoa física). EXCLUI ente público. Pessoa jurídica não
 * entra aqui (casamos PJ pelos seus SÓCIOS, mais abaixo).
 */
function fornecedoresPessoaFisica(
  empenhos: ContextoAnalise['empenhos'],
): Map<string, FornecedorPF> {
  const por = new Map<string, FornecedorPF>();
  for (const e of empenhos) {
    const doc = soDigitos(e.cpfCnpj);
    if (doc.length !== 11) continue; // só pessoa física
    if (ehEntidadePublica(doc, e.fornecedorNome)) continue;
    const nomeNorm = normalizarNome(e.fornecedorNome);
    if (!nomeNorm) continue;
    const cur = por.get(nomeNorm);
    if (cur) {
      cur.valorEmpenhado += e.valorEmpenhado;
    } else {
      por.set(nomeNorm, {
        chave: nomeNorm,
        cpfCnpj: doc,
        nome: e.fornecedorNome,
        nomeNorm,
        valorEmpenhado: e.valorEmpenhado,
      });
    }
  }
  return por;
}

interface FornecedorPJ {
  raiz: string;
  cnpj: string;
  nome: string;
  valorEmpenhado: number;
}

/** Agrega empenhos de PJ por CNPJ-raiz (colapsa filiais). Exclui ente público. */
function fornecedoresPessoaJuridica(
  empenhos: ContextoAnalise['empenhos'],
): Map<string, FornecedorPJ> {
  const por = new Map<string, FornecedorPJ>();
  for (const e of empenhos) {
    const cnpj = soDigitos(e.cpfCnpj);
    if (cnpj.length !== 14) continue;
    if (ehEntidadePublica(cnpj, e.fornecedorNome)) continue;
    const raiz = cnpjRaiz(cnpj);
    const cur = por.get(raiz);
    if (cur) {
      cur.valorEmpenhado += e.valorEmpenhado;
      if (!cur.nome && e.fornecedorNome) cur.nome = e.fornecedorNome;
    } else {
      por.set(raiz, { raiz, cnpj, nome: e.fornecedorNome, valorEmpenhado: e.valorEmpenhado });
    }
  }
  return por;
}

/**
 * "Impressão digital" parcial de um CPF cru (11 díg) — `{pre3}-{DV2}`. Usada
 * SÓ para CORROBORAR um match por nome contra o `cpfParcial` do TCE. NUNCA é um
 * identificador único (colide). Retorna "" se não der pra extrair.
 */
function parcialDeCpfCru(cpf: string): string {
  const d = soDigitos(cpf);
  if (d.length !== 11) return '';
  return `${d.slice(0, 3)}-${d.slice(9, 11)}`;
}

/** Como o match foi feito — controla a classificação e o texto. */
type ViaMatch = 'fornecedor-pf' | 'socio';

interface MatchConta {
  via: ViaMatch;
  /** Rótulo de quem casou (nome do fornecedor PF ou do sócio). */
  quem: string;
  /** CPF parcial do nosso lado (se PF; sócio raramente expõe pre3+DV). */
  parcialNosso: string;
  conta: ContaIrregularCtx;
  /** true quando o `cpfParcial` do TCE corrobora o `parcialNosso`. */
  corroboradoPorCpf: boolean;
}

/**
 * Núcleo testável do XS-14. Recebe fornecedores (empenhos), grafo de sócios e a
 * relação do TCE já como listas. Casa por NOME normalizado; corrobora por CPF
 * parcial quando ambos os lados o expõem. Devolve um alerta por SUJEITO
 * (fornecedor PF ou fornecedor PJ que tenha sócio na lista), ordenado por valor
 * envolvido desc.
 */
export function analisarContasIrregulares(input: {
  empenhos: ContextoAnalise['empenhos'];
  socios: SocioCtx[];
  contas: ContaIrregularCtx[];
}): AlertaDetectado[] {
  const contas = input.contas.filter((c) => c.nomeNorm);
  if (contas.length === 0) return [];

  // Index das contas do TCE por nome normalizado → lista (mesmo nome em vários
  // processos/exercícios).
  const contasPorNome = new Map<string, ContaIrregularCtx[]>();
  for (const c of contas) {
    const arr = contasPorNome.get(c.nomeNorm);
    if (arr) arr.push(c);
    else contasPorNome.set(c.nomeNorm, [c]);
  }

  const out: AlertaDetectado[] = [];

  // ── (1) Fornecedor PESSOA FÍSICA cujo nome casa com um responsável do TCE ──
  const pf = fornecedoresPessoaFisica(input.empenhos);
  for (const f of pf.values()) {
    const candidatas = contasPorNome.get(f.nomeNorm);
    if (!candidatas || candidatas.length === 0) continue;
    const parcialNosso = parcialDeCpfCru(f.cpfCnpj);
    const matches: MatchConta[] = candidatas.map((c) => ({
      via: 'fornecedor-pf',
      quem: f.nome,
      parcialNosso,
      conta: c,
      corroboradoPorCpf:
        !!parcialNosso && !!c.cpfParcial && parcialNosso === c.cpfParcial,
    }));
    out.push(
      montarAlerta({
        sujeitoTipo: 'fornecedor',
        sujeitoId: `pf:${f.nomeNorm}`,
        sujeitoRotulo: f.nome,
        valorEnvolvido: f.valorEmpenhado,
        matches,
      }),
    );
  }

  // ── (2) Fornecedor PJ cujo SÓCIO casa com um responsável do TCE ──
  const pj = fornecedoresPessoaJuridica(input.empenhos);
  // Index sócios por CNPJ-raiz dos fornecedores PJ com empenho.
  const sociosPorRaiz = new Map<string, SocioCtx['socios']>();
  for (const sc of input.socios) {
    const raiz =
      soDigitos(sc.cnpjRaiz).length === 8
        ? soDigitos(sc.cnpjRaiz)
        : cnpjRaiz(soDigitos(sc.cnpj));
    if (!pj.has(raiz)) continue;
    if (ehEntidadePublica(sc.cnpj, sc.razaoSocial)) continue;
    const cur = sociosPorRaiz.get(raiz);
    if (cur) cur.push(...sc.socios);
    else sociosPorRaiz.set(raiz, [...sc.socios]);
  }

  for (const [raiz, f] of pj) {
    const socios = sociosPorRaiz.get(raiz) ?? [];
    if (socios.length === 0) continue;
    const matches: MatchConta[] = [];
    const vistos = new Set<ContaIrregularCtx>();
    for (const s of socios) {
      const nomeNorm = normalizarNome(s.nome);
      if (!nomeNorm) continue;
      for (const c of contasPorNome.get(nomeNorm) ?? []) {
        if (vistos.has(c)) continue;
        vistos.add(c);
        matches.push({
          via: 'socio',
          quem: s.nome || s.cpfMasc || 'sócio',
          // O cpfMasc do sócio (Receita) mascara o MEIO (`***NNNNNN**`), não o
          // pre3+DV — então quase nunca dá pra extrair `{pre3}-{DV}` dele. Por
          // isso a corroboração por CPF parcial via sócio é, na prática, rara.
          parcialNosso: '',
          conta: c,
          corroboradoPorCpf: false,
        });
      }
    }
    if (matches.length === 0) continue;
    out.push(
      montarAlerta({
        sujeitoTipo: 'fornecedor',
        sujeitoId: raiz,
        sujeitoRotulo: f.nome || f.cnpj,
        valorEnvolvido: f.valorEmpenhado,
        matches,
      }),
    );
  }

  return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
}

/**
 * Monta um AlertaDetectado a partir dos matches de um sujeito. Aplica os
 * guardrails de classificação:
 *   • algum match CORROBORADO por CPF parcial → 'atencao' (ainda "confirmar
 *     identidade"; teto desta fonte anonimizada);
 *   • só por NOME                              → 'informativo' (homonímia).
 */
function montarAlerta(args: {
  sujeitoTipo: AlertaDetectado['sujeitoTipo'];
  sujeitoId: string;
  sujeitoRotulo: string;
  valorEnvolvido: number;
  matches: MatchConta[];
}): AlertaDetectado {
  const { sujeitoTipo, sujeitoId, sujeitoRotulo, valorEnvolvido, matches } = args;
  const temCorroboracao = matches.some((m) => m.corroboradoPorCpf);
  const viaSocio = matches.every((m) => m.via === 'socio');
  const classificacao: AlertaDetectado['classificacao'] = temCorroboracao
    ? 'atencao'
    : 'informativo';

  const quemTipo = viaSocio ? 'sócio do fornecedor' : 'fornecedor (pessoa física)';

  const evidencias: Evidencia[] = matches.slice(0, 8).map((m) => {
    const ex = m.conta.exercicio ? `, exercício ${m.conta.exercicio}` : '';
    const proc = m.conta.processoTC ? ` · processo TC ${m.conta.processoTC}` : '';
    const cpf = m.conta.cpfMasc ? ` · CPF ${m.conta.cpfMasc}` : '';
    const corr = m.corroboradoPorCpf
      ? ' [CPF parcial corrobora — confirmar identidade]'
      : ' [match só por nome — confirmar identidade (homonímia)]';
    return {
      resumo:
        (m.via === 'socio' ? `Sócio ${m.quem}` : `Fornecedor ${m.quem}`) +
        ` consta na relação do TCE-SP de contas julgadas irregulares` +
        (m.conta.origem ? ` (origem: ${m.conta.origem})` : '') +
        ex +
        proc +
        cpf +
        corr,
      data: m.conta.exercicio ? `${m.conta.exercicio}-01-01` : null,
      ref: 'TCE-SP',
    };
  });
  evidencias.push({
    resumo: `Empenhado ao fornecedor pela Prefeitura: ${formatBRL(valorEnvolvido)}`,
    valor: valorEnvolvido,
    data: null,
    ref: 'SMARAPD',
  });
  // Nota de limite SEMPRE presente: a fonte anonimiza o CPF; nenhum match aqui é
  // identidade confirmada.
  evidencias.push({
    resumo:
      'LIMITE DA FONTE: o TCE-SP ANONIMIZA o CPF (NNN.XXX.XXX-NN), então este ' +
      'cruzamento é por NOME (e, quando possível, por CPF parcial pre3+DV, que ' +
      'colide). NENHUM match é identidade confirmada — REQUER conferência humana ' +
      'do processo no TCE. NÃO afirma inelegibilidade (decisão da Justiça Eleitoral).',
    data: null,
    ref: 'XS-14',
  });

  return {
    detectorId: 'XS-14',
    detectorNome:
      'Fornecedor/sócio com contas julgadas irregulares no TCE-SP — a verificar',
    categoria: CATEGORIA,
    titulo:
      `Vínculo A VERIFICAR: ${quemTipo} consta na relação do TCE-SP de contas ` +
      `julgadas irregulares — ${sujeitoRotulo}`,
    descricao:
      `O ${quemTipo} ${sujeitoRotulo} recebeu recurso público da Prefeitura ` +
      `(empenhado ${formatBRL(valorEnvolvido)}) e um nome coincidente consta na ` +
      `relação PÚBLICA do TCE-SP de responsáveis por contas julgadas ` +
      `irregulares (LC 64/90, Ficha Limpa). ISTO NÃO AFIRMA INELEGIBILIDADE — ` +
      `a inelegibilidade é decisão da Justiça Eleitoral. É um VÍNCULO A ` +
      `VERIFICAR: o CPF é anonimizado na fonte, o casamento é por nome ` +
      `${temCorroboracao ? '(corroborado por CPF parcial) ' : ''}e pode haver ` +
      `homonímia. REQUER conferência humana do processo no TCE.`,
    sujeitoTipo,
    sujeitoId,
    sujeitoRotulo,
    // Teto OBRIGATÓRIO: no MÁXIMO 'atencao'. Nunca 'suspeita'/'critico'.
    classificacao,
    scores: {
      // Fonte oficial (TCE) — confiabilidade do FATO "consta na lista" é alta,
      // MAS a confiabilidade da IDENTIFICAÇÃO é baixa (CPF anonimizado, match por
      // nome). A probabilidade de irregularidade é moderada-baixa: contas
      // irregulares ≠ ilícito na contratação atual; é sinal de cautela a apurar.
      confiabilidade: temCorroboracao ? 60 : 40,
      probabilidadeIrregularidade: temCorroboracao ? 35 : 20,
    },
    // SEM Lei 8.429. Lista vazia → o pipeline trata como sem fundamento citável.
    fundamentoLegal: FUNDAMENTO_LEGAL.length ? [...FUNDAMENTO_LEGAL] : [],
    evidencias,
    explicacao:
      'Este alerta cruza a relação PÚBLICA do TCE-SP de "responsáveis por contas ' +
      'julgadas irregulares" (insumo da Lei da Ficha Limpa, LC 64/90) com os ' +
      'fornecedores e sócios da Prefeitura. Ele NÃO afirma que a pessoa é ' +
      'inelegível nem "ficha suja" — essa é decisão EXCLUSIVA da Justiça ' +
      'Eleitoral, que afere requisitos próprios. O TCE-SP ANONIMIZA o CPF na ' +
      'publicação, então NÃO há como confirmar a identidade por documento: o ' +
      'casamento é por NOME (sujeito a homonímia) e, no máximo, corroborado por ' +
      'CPF parcial (3 primeiros + 2 verificadores), que colide entre muitos CPFs. ' +
      'Trate como VÍNCULO A APURAR: convém conferir o processo no próprio TCE e ' +
      'a identidade do responsável antes de qualquer conclusão. Nenhum juízo de ' +
      'improbidade (Lei 8.429/92) é feito aqui. REQUER REVISÃO HUMANA.',
    valorEnvolvido,
    discriminador: `contasirreg:${sujeitoId}`,
  };
}

/**
 * Detector XS-14 no formato do pipeline (`rodarDetectores`). Degrada para []
 * honestamente quando a relação do TCE não foi anexada (cruzamento INATIVO) —
 * nunca um falso negativo silencioso.
 *
 * ── NOTA DE DEGRADAÇÃO vs. o briefing original ───────────────────────────────
 * O briefing pedia "match por CPF idêntico (hash) = 'atencao'". Isso pressupõe
 * que a fonte traga o CPF completo. CONFIRMADO em jun/2026 que o TCE-SP
 * ANONIMIZA o CPF (`NNN.XXX.XXX-NN`) — não há CPF completo para hashear nem para
 * casar 1:1 com fornecedores/sócios. Portanto:
 *   • o caminho "CPF idêntico = atencao" é INVIÁVEL com esta fonte;
 *   • o teto efetivo é: NOME + CPF parcial corroborando → 'atencao'; só NOME →
 *     'informativo' (homonímia). Ambos sempre "a verificar", nunca identidade
 *     confirmada e NUNCA inelegibilidade.
 * Se o TCE algum dia publicar o CPF completo (improvável por LGPD), bastará o
 * coletor passar a gravar `cpfHash = hashDoc(CPF completo)` e este detector
 * casar por hash igual ao XS-DOADOR/XS-SOCIO — a estrutura já está pronta.
 */
export const detectorContasIrregulares: Detector = {
  id: 'XS-14',
  nome: 'Fornecedor/sócio com contas julgadas irregulares no TCE-SP — a verificar',
  categoria: CATEGORIA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const c = ctx as ContextoComContas;
    const contas = c.contasIrregulares ?? [];
    if (contas.length === 0) return []; // relação do TCE não anexada
    if (ctx.empenhos.length === 0) return [];
    return analisarContasIrregulares({
      empenhos: ctx.empenhos,
      socios: c.socios ?? [],
      contas,
    });
  },
};
