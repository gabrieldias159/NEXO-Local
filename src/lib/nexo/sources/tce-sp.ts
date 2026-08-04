/**
 * Conector TCE-SP (Tribunal de Contas do Estado de São Paulo) — NEXO.
 *
 * ── O QUE O TCE-SP REALMENTE EXPÕE PUBLICAMENTE (pesquisa de campo, mai/2026) ──
 *
 *  1. Portal da Transparência Municipal — APIs REST públicas, sem autenticação:
 *       GET https://transparencia.tce.sp.gov.br/api/json/municipios
 *       GET https://transparencia.tce.sp.gov.br/api/json/despesas/{municipio}/{ano}/{mes}
 *       GET https://transparencia.tce.sp.gov.br/api/json/receitas/{municipio}/{ano}/{mes}
 *     A API de DESPESAS devolve, por empenho: órgão, evento, nº empenho,
 *     `id_fornecedor` (tipo + nº do documento) e `nm_fornecedor`. É a única
 *     fonte pública e estável que dá a lista de FORNECEDORES do município.
 *
 *  2. API de Tramitação de Processos — pública, mas devolve XML e SÓ aceita
 *     consulta por número de processo conhecido OU por data de remessa:
 *       GET https://www.tce.sp.gov.br/api-tramitacao-processos-numero-xml/{numero}
 *       GET https://www.tce.sp.gov.br/api-tramitacao-processos-data-xml/{aaaammdd}
 *     NÃO existe busca de processos por município, por nome de entidade nem por
 *     fornecedor. Sem o número do processo na mão, a fonte é inconsultável.
 *
 *  3. API AUDESP (audesp.tce.sp.gov.br) — TODOS os endpoints exigem login
 *     (Bearer token). Os endpoints de "Consulta" (`/f4/consulta/{protocolo}`,
 *     `/f5/consulta/{protocolo}`) são para o ente que prestou contas conferir
 *     o status do próprio envio — NÃO são consulta pública de licitações.
 *
 *  4. Datasets em CSV/ZIP — `licitacoes-contratos` (2018+) e `pareceres`
 *     (somente 2008-2017). Bulk download de centenas de MB, não consultável
 *     online registro a registro.
 *
 * ── CONCLUSÃO HONESTA ──
 *
 *  O TCE-SP NÃO oferece nenhuma API pública, limpa e estável que devolva
 *  JULGADOS ou APONTAMENTOS de auditoria FILTRÁVEIS POR MUNICÍPIO. O cruzamento
 *  XS-14 (fornecedor de Marília citado em julgado/apontamento do TCE) depende
 *  exatamente desse dado — que não existe publicamente de forma consultável.
 *
 *  Por isso este conector faz duas coisas, ambas honestas:
 *    • `coletarFornecedoresTCE()` — consulta REAL e funcional: lista os
 *      fornecedores de Marília a partir da API pública de despesas do TCE-SP.
 *      Esse lado do cruzamento XS-14 (o conjunto "fornecedores de Marília") é
 *      sólido e operável.
 *    • `coletarJulgadosTCE()` — tenta a fonte pública de julgados/apontamentos.
 *      Como ela não existe de forma consultável, devolve SEMPRE um estado
 *      `integracao: 'pendente'` explicando exatamente o que falta. NÃO inventa
 *      endpoints nem dados.
 *
 * USO SERVER-SIDE APENAS. Apenas dados públicos — LGPD; indício, nunca acusação.
 *
 * Escopo TRAVADO: exclusivamente a Prefeitura Municipal de Marília/SP
 * (IBGE 3529005). Ver `src/lib/nexo/constants.ts`.
 */
import { MARILIA } from '../constants';
import { parseValorBR, parseDataBR, soDigitos } from '../normalizar';

// ── Endpoints públicos do TCE-SP ─────────────────────────────────────────────

/** Base da API pública do Portal da Transparência Municipal do TCE-SP. */
const TCE_TRANSPARENCIA_API = 'https://transparencia.tce.sp.gov.br/api/json';
/** Slug do município de Marília na API do TCE-SP (confirmado via /municipios). */
const TCE_MUNICIPIO_SLUG = 'marilia';
/**
 * Base da API de Tramitação de Processos do TCE-SP (resposta em XML, consulta
 * apenas por número de processo conhecido). Documentada, não usada para varredura.
 */
const TCE_TRAMITACAO_PROC_NUMERO =
  'https://www.tce.sp.gov.br/api-tramitacao-processos-numero-xml';

const UA = 'NEXO/1.0 (monitoramento de transparência pública; +nexo)';

// ── Tipos normalizados ───────────────────────────────────────────────────────

/**
 * Fornecedor da Prefeitura/órgãos de Marília, derivado da API pública de
 * despesas do TCE-SP. É um dos dois lados do cruzamento XS-14.
 */
export interface FornecedorTCE {
  /** Documento (CNPJ/CPF) só dígitos — chave de identidade do fornecedor. */
  documento: string;
  /** Tipo do documento conforme o TCE (`CNPJ - PESSOA JURÍDICA`, etc.). */
  tipoDocumento: string;
  /** Razão social / nome do fornecedor. */
  nome: string;
  /** Valor total empenhado a favor do fornecedor no período coletado (R$). */
  valorEmpenhado: number;
  /** Quantidade de empenhos distintos a favor do fornecedor. */
  qtdEmpenhos: number;
  /** Órgãos contratantes em que o fornecedor aparece. */
  orgaos: string[];
  /** Exercício de referência da coleta. */
  exercicio: number;
}

/**
 * Julgado / parecer / decisão do TCE-SP referente a um processo. O TCE-SP NÃO
 * expõe esse dado de forma consultável por município — esta interface existe
 * para tipar o estado normalizado QUANDO uma fonte vier a existir (ou quando o
 * operador alimentar números de processo manualmente). Hoje, sempre vazio.
 */
export interface JulgadoTCE {
  /** Número do processo TC (formato livre, conforme TCE). */
  numeroProcesso: string;
  /** Tipo do processo (contas anuais, representação, denúncia, etc.). */
  tipo: string;
  /** Ente/órgão jurisdicionado citado no processo. */
  orgaoJurisdicionado: string;
  /** Documento (CNPJ/CPF) do fornecedor citado — só dígitos, se houver. */
  fornecedorDocumento: string;
  /** Nome do fornecedor citado, se houver. */
  fornecedorNome: string;
  /** Relator / conselheiro, quando informado. */
  relator: string;
  /** Resultado do julgamento (regular, irregular, etc.), quando informado. */
  resultado: string;
  /** Resumo/ementa do julgado ou do apontamento. */
  ementa: string;
  /** Data da decisão/sessão em ISO `yyyy-MM-dd`, ou null. */
  data: string | null;
  /** URL pública do processo/decisão, quando disponível. */
  url: string;
}

/**
 * Apontamento de auditoria (relatório de alerta AUDESP / instrução). Mesmo
 * caso de `JulgadoTCE`: não consultável publicamente por município hoje.
 */
export interface ApontamentoTCE {
  /** Identificador do apontamento/alerta. */
  id: string;
  /** Órgão jurisdicionado. */
  orgaoJurisdicionado: string;
  /** Exercício a que o apontamento se refere. */
  exercicio: number;
  /** Categoria do apontamento (gestão fiscal, licitações, índices, etc.). */
  categoria: string;
  /** Descrição da situação desfavorável/irregular apontada. */
  descricao: string;
  /** Documento do fornecedor envolvido, se o apontamento citar um. */
  fornecedorDocumento: string;
  /** Nome do fornecedor envolvido, se houver. */
  fornecedorNome: string;
  /** Data de referência em ISO `yyyy-MM-dd`, ou null. */
  data: string | null;
}

/**
 * Estado da integração com a dimensão de julgados/apontamentos do TCE-SP.
 * `disponivel` só seria `true` se uma fonte pública consultável existisse.
 */
export interface EstadoJulgadosTCE {
  /** `true` se há fonte pública consultável; hoje sempre `false`. */
  disponivel: boolean;
  /** Estado legível: `pendente` enquanto não há fonte consultável. */
  integracao: 'pendente' | 'ativa';
  /** Explicação honesta do que falta para a integração funcionar. */
  motivo: string;
  /** Julgados coletados (vazio enquanto `integracao === 'pendente'`). */
  julgados: JulgadoTCE[];
  /** Apontamentos coletados (vazio enquanto `integracao === 'pendente'`). */
  apontamentos: ApontamentoTCE[];
}

// ── Leitura defensiva ────────────────────────────────────────────────────────

function pickStr(rec: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && v !== '') return String(v).trim();
  }
  return '';
}

/**
 * O campo `id_fornecedor` do TCE-SP vem como
 * `"CNPJ - PESSOA JURÍDICA - 59989830000136"`. Esta função separa o tipo do
 * número (só dígitos). Defensiva: nunca lança em formato inesperado.
 */
function parseIdFornecedor(raw: string): { tipo: string; documento: string } {
  const partes = raw.split('-').map((p) => p.trim());
  if (partes.length >= 3) {
    const documento = soDigitos(partes[partes.length - 1]);
    const tipo = partes.slice(0, -1).join(' - ');
    return { tipo, documento };
  }
  // Sem o separador esperado — tenta extrair só dígitos do todo.
  return { tipo: raw.trim(), documento: soDigitos(raw) };
}

// ── Fetch com timeout / AbortController ──────────────────────────────────────

async function fetchTexto(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const { timeoutMs = 15_000 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, */*' },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`TCE-SP respondeu HTTP ${res.status} em ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<unknown> {
  const txt = await fetchTexto(url, opts);
  if (!txt.trim()) return [];
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`TCE-SP devolveu resposta não-JSON em ${url}`);
  }
}

// ── Coleta REAL: fornecedores de Marília (API pública de despesas) ────────────

export interface ColetaFornecedoresTCE {
  fornecedores: FornecedorTCE[];
  coleta: {
    exercicio: number;
    /** Meses efetivamente coletados (1-12). */
    mesesColetados: number[];
    /** Total de registros brutos de despesa lidos. */
    registrosBrutos: number;
    /** Erro de coleta, ou null se tudo correu. */
    erro: string | null;
    /** Fonte legível dos dados. */
    fonte: string;
  };
}

/**
 * Consulta a API pública de despesas do TCE-SP e agrega os fornecedores de
 * Marília no exercício pedido. Varre mês a mês (a API exige `{ano}/{mes}`),
 * tolerando falha de um mês sem derrubar a coleta toda.
 *
 * Esta é a metade FUNCIONAL do cruzamento XS-14: produz o conjunto
 * "fornecedores que receberam empenho da Prefeitura de Marília".
 */
export async function coletarFornecedoresTCE(
  exercicio: number,
  opts: { meses?: number[]; delayMs?: number; timeoutMs?: number } = {},
): Promise<ColetaFornecedoresTCE> {
  const {
    meses = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    timeoutMs = 15_000,
  } = opts;

  const acc = new Map<string, FornecedorTCE>();
  const mesesColetados: number[] = [];
  let registrosBrutos = 0;
  let erro: string | null = null;

  // Varre os meses EM PARALELO. A API do TCE exige uma chamada por mês; em
  // série eram ~12 round-trips encadeados — o que travava a página em loading
  // por dezenas de segundos. Em paralelo, a coleta dura ~1 round-trip.
  const respostas = await Promise.allSettled(
    meses.map(async (mes) => {
      const url = `${TCE_TRANSPARENCIA_API}/despesas/${TCE_MUNICIPIO_SLUG}/${exercicio}/${mes}`;
      const data = await fetchJson(url, { timeoutMs });
      return { mes, data };
    }),
  );

  for (const resposta of respostas) {
    if (resposta.status === 'rejected') {
      // Guarda só o primeiro erro — meses futuros podem ainda não existir.
      if (!erro) {
        erro =
          resposta.reason instanceof Error
            ? resposta.reason.message
            : 'erro desconhecido na coleta TCE-SP';
      }
      continue;
    }
    {
      const { mes, data } = resposta.value;
      const linhas: Record<string, unknown>[] = Array.isArray(data)
        ? (data as Record<string, unknown>[])
        : Array.isArray((data as { despesas?: unknown }).despesas)
          ? ((data as { despesas: Record<string, unknown>[] }).despesas)
          : [];
      mesesColetados.push(mes);
      registrosBrutos += linhas.length;

      for (const rec of linhas) {
        const evento = pickStr(rec, 'evento', 'tp_despesa').toLowerCase();
        // Só "empenhado" representa contratação a favor do fornecedor.
        // Atenção: a checagem `includes('empenh')` sozinha NÃO basta — eventos
        // como "ANULAÇÃO DE EMPENHO" / "ESTORNO DE EMPENHO" também contêm a
        // raiz e, se passassem, inflariam (ou deveriam abater, mas aqui só
        // somamos) o valor e a contagem. Por isso descartamos explicitamente
        // anulação/estorno/cancelamento antes de exigir a raiz "empenh".
        if (evento) {
          if (/anula|estorno|cancel/.test(evento)) continue;
          if (!evento.includes('empenh')) continue;
        }

        const idRaw = pickStr(rec, 'id_fornecedor', 'fornecedor_id');
        const nome = pickStr(rec, 'nm_fornecedor', 'fornecedor', 'nome_fornecedor');
        if (!idRaw && !nome) continue;

        const { tipo, documento } = parseIdFornecedor(idRaw);
        const chave = documento || nome.toUpperCase();
        if (!chave) continue;

        const valor = parseValorBR(
          pickStr(rec, 'vl_despesa', 'valor', 'vl_empenho'),
        );
        const orgao = pickStr(rec, 'orgao', 'unidade');

        const atual = acc.get(chave);
        if (atual) {
          atual.valorEmpenhado += valor;
          atual.qtdEmpenhos += 1;
          if (orgao && !atual.orgaos.includes(orgao)) atual.orgaos.push(orgao);
          if (!atual.nome && nome) atual.nome = nome;
        } else {
          acc.set(chave, {
            documento,
            tipoDocumento: tipo,
            nome,
            valorEmpenhado: valor,
            qtdEmpenhos: 1,
            orgaos: orgao ? [orgao] : [],
            exercicio,
          });
        }
      }
    }
  }

  const fornecedores = [...acc.values()].sort(
    (a, b) => b.valorEmpenhado - a.valorEmpenhado,
  );

  // Se nenhum mês entrou e há erro, a coleta falhou de fato.
  const falhaTotal = mesesColetados.length === 0 && erro !== null;

  return {
    fornecedores,
    coleta: {
      exercicio,
      mesesColetados,
      registrosBrutos,
      erro: falhaTotal ? erro : mesesColetados.length === 0 ? erro : null,
      fonte: `API pública de despesas do TCE-SP — município "${TCE_MUNICIPIO_SLUG}" (${MARILIA.nome}/${MARILIA.uf})`,
    },
  };
}

// ── Coleta de julgados/apontamentos — scaffold honesto ───────────────────────

/**
 * Tenta coletar julgados e apontamentos do TCE-SP referentes a Marília.
 *
 * NÃO EXISTE fonte pública do TCE-SP que devolva julgados ou apontamentos de
 * auditoria filtráveis por município. As fontes existentes são:
 *   • API de Tramitação de Processos — só consulta por número de processo
 *     conhecido; não há busca por município/entidade;
 *   • API AUDESP — toda autenticada (Bearer token), sem consulta pública;
 *   • Datasets CSV de `pareceres` — só 2008-2017, bulk download, não
 *     consultáveis online registro a registro.
 *
 * Portanto esta função NÃO chama endpoint inventado. Ela devolve sempre um
 * estado `integracao: 'pendente'` honesto. Se o operador fornecer números de
 * processo (`opts.numerosProcesso`), a função até tenta a API de tramitação
 * pública — mas essa API devolve XML de TRAMITAÇÃO (andamento), não a ementa
 * do julgado, então o resultado permanece marcado como pendente para a
 * dimensão de mérito/julgado.
 */
export async function coletarJulgadosTCE(
  _exercicio: number,
  opts: { numerosProcesso?: string[]; timeoutMs?: number } = {},
): Promise<EstadoJulgadosTCE> {
  const numeros = (opts.numerosProcesso ?? []).filter(Boolean);

  // Sem números de processo não há nada consultável — estado pendente puro.
  if (numeros.length === 0) {
    return {
      disponivel: false,
      integracao: 'pendente',
      julgados: [],
      apontamentos: [],
      motivo:
        'O TCE-SP não publica API pública consultável de julgados ou ' +
        'apontamentos de auditoria filtráveis por município. A API de ' +
        'Tramitação de Processos só aceita consulta por número de processo ' +
        'conhecido; a API AUDESP exige autenticação (Bearer token) e não tem ' +
        'consulta pública; os datasets de pareceres em CSV cobrem apenas ' +
        '2008-2017 e exigem download em massa. Para ativar o cruzamento XS-14 ' +
        'é preciso (a) uma fonte oficial de julgados por município, ou ' +
        '(b) alimentar manualmente os números de processo TC do município.',
    };
  }

  // Operador forneceu números de processo: tenta a API pública de tramitação.
  // Mesmo assim a dimensão "julgado/mérito" não é resolvida por essa API —
  // ela devolve andamento processual, não a ementa da decisão.
  const tramitacoes: { numero: string; ok: boolean; detalhe: string }[] = [];
  for (const numero of numeros.slice(0, 20)) {
    const limpo = soDigitos(numero);
    if (!limpo) continue;
    const url = `${TCE_TRAMITACAO_PROC_NUMERO}/${limpo}`;
    try {
      const xml = await fetchTexto(url, { timeoutMs: opts.timeoutMs ?? 15_000 });
      tramitacoes.push({
        numero,
        ok: xml.includes('<'),
        detalhe: xml.includes('<') ? 'tramitação obtida (XML)' : 'resposta vazia',
      });
    } catch (e) {
      tramitacoes.push({
        numero,
        ok: false,
        detalhe: e instanceof Error ? e.message : 'falha na consulta',
      });
    }
  }

  const obtidas = tramitacoes.filter((t) => t.ok).length;
  return {
    disponivel: false,
    integracao: 'pendente',
    julgados: [],
    apontamentos: [],
    motivo:
      `Foram consultados ${tramitacoes.length} número(s) de processo na API ` +
      `pública de Tramitação de Processos do TCE-SP (${obtidas} com tramitação ` +
      'obtida). Essa API devolve apenas o ANDAMENTO processual em XML — não a ' +
      'ementa do julgado nem o resultado de mérito, e não permite descobrir ' +
      'processos por município. A dimensão de julgados/apontamentos do XS-14 ' +
      'permanece pendente: falta uma fonte oficial de decisões por município.',
  };
}
