/**
 * Detector XS-SOCIO — SÓCIO EM COMUM ENTRE FORNECEDORES (possível grupo
 * econômico / cartel A APURAR) — NEXO.
 *
 * Cruza o grafo de sócios dos fornecedores (`ctx.socios`, que o ORQUESTRADOR
 * adiciona depois — aqui só CONSUMIMOS) procurando um MESMO sócio (mesmo
 * `cpfHash`, comparação determinística de hash, nunca CPF cru) que figura em
 * CNPJ-raiz DISTINTOS, com a condição de que AMBOS os CNPJ-raiz tenham empenho
 * da Prefeitura (`ctx.empenhos`). Dois fornecedores que dividem sócio e ambos
 * recebem recurso público são um indício de grupo econômico / possível conluio
 * entre licitantes (cartel) A APURAR.
 *
 * Se `ctx.socios` estiver ausente/vazio, o cruzamento está INATIVO e o detector
 * retorna [] honestamente — nunca um falso negativo silencioso.
 *
 * LGPD: nenhum CPF cru é persistido nem exibido. Trabalhamos só com `cpfHash`
 * (determinístico) para o cruzamento e com `cpfMasc` (mascarado, p.ex.
 * `123.***.***-45`) e nome para o texto da evidência. Ente público é EXCLUÍDO
 * (não há "sócio" de Prefeitura; senão reintroduz o bug "órgão como fornecedor").
 *
 * REGRA DE LINGUAGEM: "indício, nunca acusação". Sócio em comum tem explicações
 * legítimas (grupo familiar, holding declarada, mesmo administrador profissional
 * em empresas independentes, participação minoritária pulverizada). O indício é
 * de GRUPO ECONÔMICO / POSSÍVEL CARTEL a verificar, não afirmação de
 * irregularidade. Convém apurar (disputa real na licitação, propostas
 * coordenadas). Ver plano-mestre §6–§7. Apenas dados públicos.
 */
import { formatBRL } from '../normalizar';
import { ehEntidadePublica, cnpjRaiz, soDigitos } from '../entidades';
import type { AlertaDetectado, ContextoAnalise, Detector, Evidencia } from './tipos';

const CATEGORIA = 'Fornecedores';

/**
 * Sócio de um fornecedor, já anonimizado pela LGPD. O ORQUESTRADOR adiciona
 * `ctx.socios?: SocioCtx[]` a `ContextoAnalise` depois (grafo de sócios da
 * Receita/QSA); aqui só CONSUMIMOS o formato.
 */
export interface SocioPessoa {
  /** Hash determinístico do CPF do sócio (nunca o CPF cru). Chave do cruzamento. */
  cpfHash: string;
  /** CPF mascarado para exibição (ex.: `123.***.***-45`). Só para texto. */
  cpfMasc: string;
  nome: string;
}

/** Quadro societário de UM fornecedor (1 CNPJ → seus sócios). */
export interface SocioCtx {
  /** CNPJ do fornecedor — só dígitos (ou já formatado; normalizamos). */
  cnpj: string;
  /** Raiz do CNPJ (8 dígitos) — colapsa filiais do mesmo grupo. */
  cnpjRaiz: string;
  razaoSocial: string;
  socios: SocioPessoa[];
}

/**
 * Converte os docs CRUS de `nexo_socios` (grafo QSA, já anonimizado pelo
 * coletor) em SocioCtx[]. Usado pela rota de cômputo e pela análise ao vivo p/
 * popular `ctx.socios`. NÃO há CPF cru — só cpfHash/cpfMasc.
 */
export function sociosDeDocs(docs: Record<string, unknown>[]): SocioCtx[] {
  const out: SocioCtx[] = [];
  for (const d of docs) {
    const cnpj = String(d._cnpj ?? d.cnpj ?? '').replace(/\D/g, '');
    if (cnpj.length !== 14) continue;
    const sociosRaw = Array.isArray(d.socios) ? d.socios : [];
    const socios: SocioPessoa[] = sociosRaw
      .map((s) => {
        const r = (s ?? {}) as Record<string, unknown>;
        return {
          cpfHash: String(r.cpfHash ?? ''),
          cpfMasc: String(r.cpfMasc ?? ''),
          nome: String(r.nome ?? ''),
        };
      })
      .filter((s) => s.cpfHash || s.nome);
    out.push({
      cnpj,
      cnpjRaiz: String(d.cnpjRaiz ?? cnpj.slice(0, 8)),
      razaoSocial: String(d.razaoSocial ?? ''),
      socios,
    });
  }
  return out;
}

/**
 * Shim de FORWARD-COMPATIBILIDADE. O orquestrador ainda vai adicionar o campo
 * `socios?: SocioCtx[]` em `ContextoAnalise` (tipos.ts). Até lá, este tipo local
 * declara o campo OPCIONAL que CONSUMIMOS, sem editar tipos.ts e sem quebrar o
 * build. Quando o campo entrar no tipo oficial, este `&` é inócuo — basta apagar
 * este alias. COMO FIAR: orquestrador adiciona `socios?: SocioCtx[]` (e o
 * `import type { SocioCtx }`) em `ContextoAnalise` e o popula a partir do grafo
 * de sócios (Receita/QSA), já anonimizado (cpfHash/cpfMasc).
 */
type ContextoComSocios = ContextoAnalise & { socios?: SocioCtx[] };

/** Raiz canônica de um SocioCtx (usa `cnpjRaiz` informado; senão deriva do CNPJ). */
function raizDe(s: SocioCtx): string {
  const raiz = soDigitos(s.cnpjRaiz);
  if (raiz.length === 8) return raiz;
  return cnpjRaiz(soDigitos(s.cnpj));
}

interface FornecedorComEmpenho {
  raiz: string;
  nome: string;
  valorEmpenhado: number;
}

/**
 * Agrega os empenhos por CNPJ-RAIZ (colapsa filiais) só de fornecedores
 * PRIVADOS com CNPJ de 14 dígitos. EXCLUI ente público (`ehEntidadePublica`) —
 * Prefeitura/Câmara/autarquia não têm "sócio". Devolve só raízes com algum
 * empenho: o cruzamento exige que AMBOS os fornecedores tenham recebido recurso.
 */
function fornecedoresComEmpenhoPorRaiz(
  empenhos: ContextoAnalise['empenhos'],
): Map<string, FornecedorComEmpenho> {
  const por = new Map<string, FornecedorComEmpenho>();
  for (const e of empenhos) {
    const cnpj = soDigitos(e.cpfCnpj);
    if (cnpj.length !== 14) continue; // sócio é de empresa; CPF não entra aqui
    if (ehEntidadePublica(cnpj, e.fornecedorNome)) continue;
    const raiz = cnpjRaiz(cnpj);
    const cur = por.get(raiz);
    if (cur) {
      cur.valorEmpenhado += e.valorEmpenhado;
      if (!cur.nome && e.fornecedorNome) cur.nome = e.fornecedorNome;
    } else {
      por.set(raiz, {
        raiz,
        nome: e.fornecedorNome,
        valorEmpenhado: e.valorEmpenhado,
      });
    }
  }
  return por;
}

interface DadosSocio {
  cpfMasc: string;
  nome: string;
  /** raiz do CNPJ → razão social do fornecedor onde o sócio aparece. */
  empresas: Map<string, string>;
}

/**
 * Núcleo testável do XS-SOCIO. Recebe o grafo de sócios e os empenhos já como
 * listas e devolve um alerta por sócio que liga DOIS OU MAIS fornecedores
 * (raízes distintas) ambos com empenho. Ordenado por valor envolvido desc.
 */
export function analisarSocioComum(input: {
  socios: SocioCtx[];
  empenhos: ContextoAnalise['empenhos'];
}): AlertaDetectado[] {
  const comEmpenho = fornecedoresComEmpenhoPorRaiz(input.empenhos);
  if (comEmpenho.size < 2) return []; // precisa de ao menos 2 fornecedores

  // Indexa: cpfHash → sócio + conjunto de raízes (com empenho) onde aparece.
  const porSocio = new Map<string, DadosSocio>();
  for (const sc of input.socios) {
    const raiz = raizDe(sc);
    if (!comEmpenho.has(raiz)) continue; // este fornecedor não tem empenho
    if (ehEntidadePublica(sc.cnpj, sc.razaoSocial)) continue; // blindagem extra
    const nomeEmpresa = comEmpenho.get(raiz)?.nome || sc.razaoSocial || raiz;
    for (const p of sc.socios) {
      const hash = (p.cpfHash ?? '').trim();
      if (!hash) continue; // sem hash não há cruzamento determinístico possível
      const cur = porSocio.get(hash);
      if (cur) {
        if (!cur.empresas.has(raiz)) cur.empresas.set(raiz, nomeEmpresa);
        if (!cur.nome && p.nome) cur.nome = p.nome;
        if (!cur.cpfMasc && p.cpfMasc) cur.cpfMasc = p.cpfMasc;
      } else {
        porSocio.set(hash, {
          cpfMasc: p.cpfMasc ?? '',
          nome: p.nome ?? '',
          empresas: new Map([[raiz, nomeEmpresa]]),
        });
      }
    }
  }

  const out: AlertaDetectado[] = [];
  for (const [, dados] of porSocio) {
    if (dados.empresas.size < 2) continue; // sócio em UM fornecedor só → nada

    const raizes = [...dados.empresas.keys()];
    const nomesEmpresas = [...dados.empresas.values()];
    const valorEnvolvido = raizes.reduce(
      (acc, r) => acc + (comEmpenho.get(r)?.valorEmpenhado ?? 0),
      0,
    );
    const rotuloSocio = dados.nome || dados.cpfMasc || 'sócio em comum';

    const evidencias: Evidencia[] = raizes.map((r) => {
      const f = comEmpenho.get(r);
      const nomeEmp = dados.empresas.get(r) || r;
      return {
        resumo:
          `Fornecedor com empenho: ${nomeEmp} (raiz CNPJ ${r})` +
          ` — empenhado ${formatBRL(f?.valorEmpenhado ?? 0)}`,
        valor: f?.valorEmpenhado ?? 0,
        data: null,
        ref: 'SMARAPD',
      };
    });
    evidencias.push({
      resumo:
        `Sócio em comum (mesmo cadastro pelo hash do CPF): ${rotuloSocio}` +
        (dados.cpfMasc ? ` · CPF ${dados.cpfMasc}` : '') +
        ` — figura em ${dados.empresas.size} fornecedores distintos.`,
      data: null,
      ref: 'QSA/Receita',
    });

    const listaEmpresas = nomesEmpresas.join(', ');
    out.push({
      detectorId: 'XS-SOCIO',
      detectorNome: 'Sócio em comum entre fornecedores',
      categoria: CATEGORIA,
      titulo: `Sócio em comum entre fornecedores com empenho — ${rotuloSocio}`,
      descricao:
        `O sócio ${rotuloSocio}${dados.cpfMasc ? ` (CPF ${dados.cpfMasc})` : ''} ` +
        `consta no quadro societário de ${dados.empresas.size} fornecedores de ` +
        `CNPJ-raiz distintos que receberam empenho da Prefeitura: ${listaEmpresas}. ` +
        'Sócio compartilhado entre empresas que ambas contratam com o poder ' +
        'público é um indício de grupo econômico / possível conluio entre ' +
        'licitantes A APURAR — não é, por si só, irregularidade.',
      sujeitoTipo: 'fornecedor',
      // Sujeito = a raiz de maior empenho (entidade-âncora do indício).
      sujeitoId:
        raizes.slice().sort(
          (a, b) =>
            (comEmpenho.get(b)?.valorEmpenhado ?? 0) -
            (comEmpenho.get(a)?.valorEmpenhado ?? 0),
        )[0] ?? raizes[0],
      sujeitoRotulo: rotuloSocio,
      // cpfHash idêntico → 'atencao' (teto deste detector). Nunca crítico:
      // sócio em comum, por si, não é irregularidade.
      classificacao: 'atencao',
      scores: {
        // Vínculo societário pela Receita é dado oficial (confiabilidade boa); a
        // chance de irregularidade material é menor (grupo econômico é lícito; o
        // problema seria conluio em licitação, que precisa de outra prova).
        confiabilidade: 78,
        probabilidadeIrregularidade: 40,
      },
      fundamentoLegal: [
        'Lei 14.133/2021 art.14 (impedimentos)',
        'Lei 14.133/2021 art.9',
        'CF art.37 (isonomia/competitividade)',
      ],
      evidencias,
      explicacao:
        'Dois ou mais fornecedores que receberam recurso público dividem um mesmo ' +
        'sócio (identificado pelo hash do CPF — nenhum CPF cru é exibido ou ' +
        'persistido). Isso caracteriza indício de grupo econômico e, quando as ' +
        'empresas disputaram a mesma licitação, de possível conluio (cartel) a ' +
        'apurar. Há explicações legítimas: grupo familiar, holding declarada, ' +
        'administrador profissional em empresas independentes, participação ' +
        'minoritária. Convém verificar se houve disputa real (propostas ' +
        'coordenadas, mesma sequência de lances) e se a relação foi declarada. ' +
        'Não constitui, por si só, irregularidade nem acusação. Requer revisão ' +
        'humana.',
      valorEnvolvido: valorEnvolvido,
      // Estável por sócio (hash): não duplica entre execuções do monitor.
      discriminador: `socio:${raizes.slice().sort().join('-')}`,
    });
  }

  // Maior valor envolvido primeiro (todos são 'atencao').
  return out.sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
}

/**
 * Detector XS-SOCIO no formato do pipeline (`rodarDetectores`). Degrada para []
 * honestamente quando o grafo de sócios não foi anexado ao contexto (cruzamento
 * inativo) — nunca um falso negativo silencioso.
 */
export const detectorSocioComum: Detector = {
  id: 'XS-SOCIO',
  nome: 'Sócio em comum entre fornecedores',
  categoria: CATEGORIA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const socios = (ctx as ContextoComSocios).socios ?? [];
    if (socios.length === 0) return []; // grafo de sócios não anexado
    if (ctx.empenhos.length === 0) return [];
    return analisarSocioComum({ socios, empenhos: ctx.empenhos });
  },
};
