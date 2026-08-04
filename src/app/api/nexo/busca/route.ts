/**
 * GET /api/nexo/busca?tipo=<tipo>&q=<termo>&exercicio=<ano>
 *
 * SUBPROGRAMAS DE BUSCA do NEXO — a "barra de pesquisa" da sala de situação.
 * Um único endpoint que, conforme `tipo`, varre as coleções `nexo_*` já
 * INGERIDAS pelo cron (NÃO raspa fontes externas ao vivo) e devolve resultados
 * tipados + honestos:
 *
 *   • tipo=empresas    → fornecedores reais (de `nexo_empenhos`/`nexo_contratos_*`),
 *                        filtrados por nome/CNPJ/objeto. Exclui entes públicos
 *                        (Prefeitura/órgãos NÃO são "fornecedor"). Marca
 *                        `contratosAtivos` quando há contrato vigente.
 *   • tipo=servidores  → folha (`nexo_pagamentos`) por nome/setor/cargo. SÓ dado
 *                        público; nome mascarado (LGPD). Coleção ausente ⇒
 *                        `{disponivel:false, motivo}`.
 *   • tipo=licitacoes  → `nexo_licitacoes` (editais) em andamento.
 *   • tipo=dispensas   → `nexo_licitacoes` modalidade dispensa/inexigibilidade
 *                        (contratação direta) em andamento.
 *   • tipo=entidade    → o RAIO-X: dado um CNPJ/CPF (ou nome em `q`), o perfil
 *                        canônico de `nexo_entidades` (quando a camada de
 *                        resolução estiver ativa) + os vínculos de `nexo_links`
 *                        (empenhos/contratos/licitações/documentos linkados).
 *
 * ── HONESTIDADE (regra do dono) ──────────────────────────────────────────────
 * Coleção vazia para o exercício NÃO é "nada encontrado": é cruzamento/coleta
 * inativo. A resposta carrega `disponivel`/`coletaInativa` para a UI distinguir
 * "não há resultado" de "a ingestão ainda não rodou".
 *
 * ── LGPD ─────────────────────────────────────────────────────────────────────
 * CPF e nome de pessoa física saem MASCARADOS (`mascararDoc`/`mascararNome`).
 * Nenhuma rede social, nenhum dado não-público — só o que a Prefeitura publica.
 *
 * Rota protegida (sessão NEXO). `Cache-Control: no-store` SEMPRE — busca é
 * consulta viva, não cacheável por proxy.
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import {
  urlListagemComprasDiretas,
  urlListagemLicitacoes,
} from '@/lib/nexo/links-doc';
import { mascararDoc, mascararNome } from '@/lib/nexo/normalizar';
import {
  ehEntidadePublica,
  idCanonicoEntidade,
  normalizarNome,
  soDigitos,
} from '@/lib/nexo/entidades';

export const runtime = 'nodejs';

/** Tipos de busca aceitos no query param `tipo`. */
const TIPOS = ['empresas', 'servidores', 'licitacoes', 'dispensas', 'entidade'] as const;
type TipoBusca = (typeof TIPOS)[number];

/** Teto de itens devolvidos por busca — protege payload/latência. */
const LIMITE = 50;

/**
 * Teto de DOCS lidos do Firestore por coleção numa busca. A barra de pesquisa é
 * viva (debounce 300ms, `no-store`): cada digitação varria `nexo_empenhos`/
 * `nexo_*` INTEIRAS em memória (P1-F do plano). O teto corta o `:runQuery` no
 * servidor — a busca por substring vira amostra do recorte, mas a barra deixa de
 * carregar dezenas de milhares de docs por tecla. Folgado o bastante para não
 * truncar coleções de tamanho normal; protege o caso patológico (ano inteiro).
 */
const LIMITE_LEITURA = 4000;

/**
 * Campos projetados das coleções pesadas (`select` do `:runQuery`). Reduz o
 * payload/parse por dois eixos junto com `LIMITE_LEITURA`. Inclui os campos `_*`
 * carimbados pelo cron E os nomes crus alternativos que os helpers leem.
 */
const CAMPOS_EMPENHO = ['_cnpj', '_fornecedor', '_valor', '_docId', 'NomeFornecedor', 'Fornecedor', 'ValorEmpenho', 'ValorEmpenhado'];
const CAMPOS_CONTRATO = ['_cnpj', '_fornecedor', '_valor', 'nomeContratada', 'numeroContrato', 'numeroProcesso', 'objeto', 'valor', 'vigenciaInicio', 'vigenciaFim'];
const CAMPOS_LICITACAO = ['_tipo', 'tipo', 'situacao', 'objeto', 'modalidade', 'numeroProcesso', 'numeroEdital', 'dataAbertura', 'valorEstimado'];
const CAMPOS_PAGAMENTO = ['Matricula', 'NumeroMatricula', 'Mes', 'NomeServidor', 'Nome', 'NomeFornecedor', 'CargoFuncao', 'Cargo', 'Funcao', 'Lotacao', 'Secretaria'];
const CAMPOS_LINK = ['_de', '_para', 'tipo', 'chave', 'chaveTipo', 'confianca'];
const CAMPOS_ENTIDADE = ['_id', 'nome', 'cnpj', 'cpf', 'doc', 'cnpjRaiz', 'tipo'];

/**
 * URL da fonte (listagem do portal) por `_tipo` da licitação — usa os builders
 * CANÔNICOS de links-doc.ts (`/portal/editais/1|4`, verificados HTTP 200). As
 * rotas antigas `/portal/licitacoes` e `/portal/compras-diretas` nunca
 * existiram (404 — links em branco vistos pelo dono em prod, 2026-06-10).
 */
function urlFonteLicitacao(tipo: string): string {
  const ehDireta =
    tipo === 'dispensa' || tipo === 'inexigibilidade' || tipo === 'adesao';
  return ehDireta ? urlListagemComprasDiretas() : urlListagemLicitacoes();
}

// ── Helpers de leitura tipada dos docs `nexo_*` (já decodificados) ───────────

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Só dígitos a partir de um valor cru (`unknown`) de doc Firestore. */
function digits(v: unknown): string {
  return soDigitos(str(v));
}

/** Normaliza um termo de busca (sem acento, caixa alta) para casamento textual. */
function termoNorm(q: string): string {
  return normalizarNome(q);
}

/** true se algum dos campos contém o termo (já normalizado) como substring. */
function casaTexto(termo: string, ...campos: (string | null | undefined)[]): boolean {
  if (!termo) return true; // termo vazio = não filtra (lista tudo, até o limite)
  for (const c of campos) {
    if (c && normalizarNome(c).includes(termo)) return true;
  }
  return false;
}

// ── Contratos do tipo de saída ───────────────────────────────────────────────

interface ResultadoEmpresa {
  idCanonico: string;
  /** CNPJ/CPF formatado p/ exibição (CPF mascarado — LGPD). */
  documento: string;
  /** Só dígitos — para deep-link ao raio-x (`tipo=entidade&q=<doc>`). */
  documentoRaw: string;
  nome: string;
  totalEmpenhado: number;
  empenhos: number;
  /** true quando há contrato municipal vigente com a Prefeitura na data de hoje. */
  contratosAtivos: boolean;
  contratos: number;
}

interface ResultadoServidor {
  nome: string;
  cargo: string;
  lotacao: string;
}

/**
 * Item de licitação/dispensa devolvido pela busca de processos. Exportado para
 * a página `/nexo/licitacoes` tipar o consumo (mesmo padrão de import type das
 * páginas de contratos/fornecedores). `valorEstimado` vem null quando o dados-
 * abertos não publica o valor (exibir "—", nunca R$ 0). `urlFonte` é o link da
 * LISTAGEM do portal por categoria (Marília não expõe deep-link por processo no
 * dados-abertos — o rastro forte fica para a onda de enriquecimento).
 */
export interface ResultadoLicitacao {
  numeroProcesso: string;
  numeroEdital: string;
  modalidade: string;
  objeto: string | null;
  situacao: string | null;
  tipo: string | null;
  dataAbertura: string | null;
  valorEstimado: number | null;
  /** Link da listagem do portal de Dados Abertos para esta categoria. */
  urlFonte: string;
}

interface VinculoEntidade {
  /** Coleção `nexo_*` do outro lado da aresta. */
  colecao: string;
  /** docId do outro lado. */
  id: string;
  tipo: string;
  chave: string;
  chaveTipo: string;
  confianca: string;
}

// ── Resposta base (comum a todos os tipos) ───────────────────────────────────

interface RespostaBase {
  tipo: TipoBusca;
  q: string;
  exercicio: number;
  /** false quando a coleção-fonte não existe/está inativa para esta busca. */
  disponivel: boolean;
  /** Explicação honesta quando `disponivel=false` (coleta/cruzamento inativo). */
  motivo: string | null;
  total: number;
  atualizadoEm: string;
}

/**
 * Resposta de `tipo=licitacoes`/`tipo=dispensas` consumida por `/nexo/licitacoes`.
 * `coletaInativa` só aparece no estado vazio honesto (coleção ainda não ingerida)
 * — distinto de "nada encontrado". Exportada para a página tipar o fetch.
 */
export interface BuscaProcessosResponse extends RespostaBase {
  /** Presente (true) apenas quando a coleção-fonte está inativa para o período. */
  coletaInativa?: boolean;
  resultados: ResultadoLicitacao[];
}

const headersNoStore = { 'Cache-Control': 'no-store' } as const;

function ok(body: object): NextResponse {
  return NextResponse.json(body, { status: 200, headers: headersNoStore });
}

// ── Subprogramas ─────────────────────────────────────────────────────────────

/**
 * BUSCA EMPRESAS — fornecedores reais da Prefeitura, de `nexo_empenhos`
 * (agregados por entidade canônica), filtrados por nome/CNPJ/objeto. Cruza com
 * `nexo_contratos_municipais` para a flag `contratosAtivos`. Exclui entes
 * públicos (transferência intra-governo NÃO é contratação privada).
 */
async function buscarEmpresas(
  q: string,
  exercicio: number,
  idToken: string,
): Promise<NextResponse> {
  const termo = termoNorm(q);
  const docCnpj = soDigitos(q); // se o usuário digitou um CNPJ/CPF

  const empenhos = await lerColecaoNexo(
    'nexo_empenhos',
    { exercicio, fonte: 'empenhos', limit: LIMITE_LEITURA },
    idToken,
    CAMPOS_EMPENHO,
  );

  if (empenhos.length === 0) {
    return resultadoVazioColeta(
      'empresas',
      q,
      exercicio,
      'A coleção de empenhos (nexo_empenhos) ainda não foi ingerida para este ' +
        'exercício. A busca por fornecedores fica indisponível até o cron de ' +
        'coleta SMARAPD rodar.',
    );
  }

  // Contratos municipais do exercício — para a flag de contrato ativo.
  let contratos: Record<string, unknown>[] = [];
  try {
    contratos = await lerColecaoNexo(
      'nexo_contratos_municipais',
      { exercicio, fonte: 'dados-abertos', limit: LIMITE_LEITURA },
      idToken,
      CAMPOS_CONTRATO,
    );
  } catch {
    /* contratos indisponíveis — a flag contratosAtivos degrada para false */
  }

  const hoje = new Date().toISOString().slice(0, 10);
  // Mapa idCanonico → { contratos totais, algum vigente }.
  const contratosPorEntidade = new Map<string, { n: number; ativo: boolean }>();
  for (const c of contratos) {
    const doc = digits(c._cnpj);
    const nome = str(c._fornecedor ?? c.nomeContratada);
    if (ehEntidadePublica(doc, nome)) continue;
    const id = idCanonicoEntidade(doc, nome);
    const fim = str(c.vigenciaFim);
    // Vigente: sem data-fim conhecida (contrato aberto) OU fim >= hoje.
    const vigente = !fim || fim >= hoje;
    const cur = contratosPorEntidade.get(id) ?? { n: 0, ativo: false };
    cur.n += 1;
    if (vigente) cur.ativo = true;
    contratosPorEntidade.set(id, cur);
  }

  // Agrega empenhos por entidade canônica, excluindo entes públicos.
  const mapa = new Map<
    string,
    { total: number; n: number; nome: string; docFull: string }
  >();
  for (const e of empenhos) {
    const doc = digits(e._cnpj);
    const nome = str(e._fornecedor ?? e.NomeFornecedor ?? e.Fornecedor);
    const valor = num(e._valor ?? e.ValorEmpenho ?? e.ValorEmpenhado);
    if (!doc && !nome) continue;
    if (ehEntidadePublica(doc, nome)) continue;
    const id = idCanonicoEntidade(doc, nome);
    const cur = mapa.get(id) ?? { total: 0, n: 0, nome, docFull: doc };
    cur.total += valor;
    cur.n += 1;
    if (!cur.nome && nome) cur.nome = nome;
    // Prefere um CNPJ completo (14) como representante do grupo.
    if (doc.length === 14 && cur.docFull.length !== 14) cur.docFull = doc;
    mapa.set(id, cur);
  }

  let itens: ResultadoEmpresa[] = [...mapa.entries()].map(([id, d]) => {
    const ctr = contratosPorEntidade.get(id);
    return {
      idCanonico: id,
      documento: mascararDoc(d.docFull),
      documentoRaw: d.docFull,
      nome: d.nome || d.docFull,
      totalEmpenhado: d.total,
      empenhos: d.n,
      contratosAtivos: ctr?.ativo ?? false,
      contratos: ctr?.n ?? 0,
    };
  });

  // Filtro por termo (nome/documento) — `objeto` não vive no empenho agregado;
  // o casamento por objeto vale na busca de licitações/dispensas.
  if (termo || docCnpj) {
    itens = itens.filter(
      (it) =>
        (docCnpj && it.documentoRaw.includes(docCnpj)) ||
        casaTexto(termo, it.nome) ||
        it.idCanonico.includes(termo),
    );
  }

  // Ranking por valor empenhado desc (potencial de fiscalização).
  itens.sort((a, b) => b.totalEmpenhado - a.totalEmpenhado);
  const total = itens.length;

  return ok({
    tipo: 'empresas',
    q,
    exercicio,
    disponivel: true,
    motivo: null,
    total,
    resultados: itens.slice(0, LIMITE),
    atualizadoEm: new Date().toISOString(),
  } satisfies RespostaBase & { resultados: ResultadoEmpresa[] });
}

/**
 * BUSCA SERVIDORES — folha de pagamento (`nexo_pagamentos`) por nome/setor/
 * cargo. SÓ dado público; o nome sai MASCARADO (LGPD). Coleção ausente para o
 * exercício ⇒ `{disponivel:false, motivo}` honesto. NÃO há raspagem de rede
 * social nem de qualquer fonte fora do que a Prefeitura publica.
 */
async function buscarServidores(
  q: string,
  exercicio: number,
  idToken: string,
): Promise<NextResponse> {
  const termo = termoNorm(q);

  let docs: Record<string, unknown>[] = [];
  try {
    docs = await lerColecaoNexo(
      'nexo_pagamentos',
      { exercicio, fonte: 'pagamentos', limit: LIMITE_LEITURA },
      idToken,
      CAMPOS_PAGAMENTO,
    );
  } catch (err) {
    return resultadoVazioColeta(
      'servidores',
      q,
      exercicio,
      `Falha ao ler a folha (nexo_pagamentos): ${
        err instanceof Error ? err.message : 'erro desconhecido'
      }.`,
    );
  }

  if (docs.length === 0) {
    return resultadoVazioColeta(
      'servidores',
      q,
      exercicio,
      'A folha de pagamento (nexo_pagamentos) ainda não foi ingerida para este ' +
        'exercício, ou a coleção da folha não existe. A busca por servidores fica ' +
        'indisponível até a ingestão do módulo de pagamentos rodar. Observação: ' +
        'só consultamos dado público da própria folha — nenhuma rede social ou ' +
        'fonte externa é raspada.',
    );
  }

  // Deduplica por matrícula, mantendo o registro de mês mais recente — evita
  // listar o mesmo servidor 12x (um por competência).
  const porMatricula = new Map<string, Record<string, unknown>>();
  for (const d of docs) {
    const mat = str(d.Matricula ?? d.NumeroMatricula);
    if (!mat) continue;
    const mes = num(d.Mes);
    const ex = porMatricula.get(mat);
    if (!ex || mes > num(ex.Mes)) porMatricula.set(mat, d);
  }

  let itens: ResultadoServidor[] = [...porMatricula.values()].map((d) => ({
    nome: mascararNome(str(d.NomeServidor ?? d.Nome ?? d.NomeFornecedor)),
    cargo: str(d.CargoFuncao ?? d.Cargo),
    lotacao: str(d.Funcao ?? d.Lotacao ?? d.Secretaria),
  }));

  // O termo casa contra o nome REAL (antes de mascarar) + cargo + lotação.
  if (termo) {
    const reais = [...porMatricula.values()];
    itens = reais
      .filter((d) =>
        casaTexto(
          termo,
          str(d.NomeServidor ?? d.Nome ?? d.NomeFornecedor),
          str(d.CargoFuncao ?? d.Cargo),
          str(d.Funcao ?? d.Lotacao ?? d.Secretaria),
        ),
      )
      .map((d) => ({
        nome: mascararNome(str(d.NomeServidor ?? d.Nome ?? d.NomeFornecedor)),
        cargo: str(d.CargoFuncao ?? d.Cargo),
        lotacao: str(d.Funcao ?? d.Lotacao ?? d.Secretaria),
      }));
  }

  itens.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const total = itens.length;

  return ok({
    tipo: 'servidores',
    q,
    exercicio,
    disponivel: true,
    motivo: null,
    total,
    resultados: itens.slice(0, LIMITE),
    atualizadoEm: new Date().toISOString(),
  } satisfies RespostaBase & { resultados: ResultadoServidor[] });
}

/**
 * Predicado "em andamento" sobre o campo textual `situacao` do dados-abertos.
 * Conservador: considera ABERTO o que NÃO casa termos terminais (homologado,
 * encerrado, revogado, cancelado, deserto, fracassado, adjudicado, concluído).
 * `situacao` ausente ⇒ tratado como em andamento (não esconder por falta de dado).
 */
const RE_SITUACAO_ENCERRADA =
  /\b(HOMOLOGAD|ADJUDICAD|ENCERRAD|CONCLUID|FINALIZAD|REVOGAD|ANULAD|CANCELAD|DESERT|FRACASSAD|SUSPENS|ARQUIVAD)/;

function emAndamento(situacao: string | null | undefined): boolean {
  const s = normalizarNome(situacao ?? '');
  if (!s) return true;
  return !RE_SITUACAO_ENCERRADA.test(s);
}

/**
 * BUSCA LICITAÇÕES — editais formais de `nexo_licitacoes` (categoria
 * `licitacoes`) ainda EM ANDAMENTO, filtrados por objeto/modalidade/processo.
 */
async function buscarLicitacoes(
  q: string,
  exercicio: number,
  idToken: string,
): Promise<NextResponse> {
  return buscarProcessos('licitacoes', q, exercicio, idToken);
}

/**
 * BUSCA DISPENSAS — contratações DIRETAS de `nexo_licitacoes`
 * (dispensa/inexigibilidade/adesão) ainda EM ANDAMENTO. É o foco de
 * fiscalização: contratação sem licitação formal.
 */
async function buscarDispensas(
  q: string,
  exercicio: number,
  idToken: string,
): Promise<NextResponse> {
  return buscarProcessos('dispensas', q, exercicio, idToken);
}

/** Núcleo comum de licitações/dispensas (mesma coleção, recortes distintos). */
async function buscarProcessos(
  tipo: 'licitacoes' | 'dispensas',
  q: string,
  exercicio: number,
  idToken: string,
): Promise<NextResponse> {
  const termo = termoNorm(q);

  const docs = await lerColecaoNexo(
    'nexo_licitacoes',
    { exercicio, fonte: 'dados-abertos', limit: LIMITE_LEITURA },
    idToken,
    CAMPOS_LICITACAO,
  );

  if (docs.length === 0) {
    return resultadoVazioColeta(
      tipo,
      q,
      exercicio,
      'A coleção de licitações/dispensas (nexo_licitacoes) ainda não foi ' +
        'ingerida para este exercício. A busca fica indisponível até o cron de ' +
        'coleta do portal de Dados Abertos rodar.',
    );
  }

  let itens: ResultadoLicitacao[] = docs
    .filter((d) => {
      // `_tipo` ∈ {edital, dispensa, inexigibilidade, adesao}. Dispensas: as
      // contratações diretas; Licitações: o edital formal.
      const t = str(d._tipo ?? d.tipo);
      const ehDireta = t === 'dispensa' || t === 'inexigibilidade' || t === 'adesao';
      return tipo === 'dispensas' ? ehDireta : !ehDireta;
    })
    .filter((d) => emAndamento(str(d.situacao) || null))
    .filter((d) =>
      casaTexto(
        termo,
        str(d.objeto),
        str(d.modalidade),
        str(d.numeroProcesso),
        str(d.numeroEdital),
      ),
    )
    .map((d) => {
      const tipoLic = str(d._tipo ?? d.tipo);
      return {
        numeroProcesso: str(d.numeroProcesso),
        numeroEdital: str(d.numeroEdital),
        modalidade: str(d.modalidade),
        objeto: str(d.objeto) || null,
        situacao: str(d.situacao) || null,
        tipo: tipoLic || null,
        dataAbertura: str(d.dataAbertura) || null,
        valorEstimado: d.valorEstimado == null ? null : num(d.valorEstimado),
        urlFonte: urlFonteLicitacao(tipoLic),
      };
    });

  // Cronológico desc — o mais recente primeiro (data de abertura/sessão).
  itens.sort((a, b) => (b.dataAbertura ?? '').localeCompare(a.dataAbertura ?? ''));
  const total = itens.length;

  return ok({
    tipo,
    q,
    exercicio,
    disponivel: true,
    motivo: null,
    total,
    resultados: itens.slice(0, LIMITE),
    atualizadoEm: new Date().toISOString(),
  } satisfies RespostaBase & { resultados: ResultadoLicitacao[] });
}

/**
 * BUSCA ENTIDADE (RAIO-X) — dado um CNPJ/CPF (ou nome) em `q`, monta o perfil:
 *  1. o registro canônico de `nexo_entidades` (gravado pelo cron
 *     `onNexoPerfilEntidades`); quando nenhum perfil casa o alvo, `perfilCanonico`
 *     vem null com `perfilDisponivel=false` e `motivo` honesto;
 *  2. a presença do documento nas coleções reais (`nexo_empenhos`,
 *     `nexo_contratos_municipais`, `nexo_licitacoes`) — o raio-x funcional;
 *  3. os VÍNCULOS de `nexo_links` que tocam os docs da entidade (empenho ↔
 *     contrato ↔ licitação ↔ TCE ↔ DOM ↔ documento-fonte).
 *
 * `q` deve ser um documento (CNPJ/CPF) ou um nome. Sem `q` → erro 200 honesto.
 */
async function buscarEntidade(
  q: string,
  exercicio: number,
  idToken: string,
): Promise<NextResponse> {
  const doc = soDigitos(q);
  const termo = termoNorm(q);
  if (!q.trim()) {
    return ok({
      tipo: 'entidade',
      q,
      exercicio,
      disponivel: false,
      motivo:
        'Informe um CNPJ/CPF ou um nome em `q` para montar o raio-x da entidade.',
      total: 0,
      perfilDisponivel: false,
      perfilCanonico: null,
      entidade: null,
      empenhos: { total: 0, valor: 0, docIds: [] },
      contratos: [],
      licitacoes: [],
      vinculos: [],
      atualizadoEm: new Date().toISOString(),
    });
  }

  // 1) Perfil canônico de `nexo_entidades` (gravado pelo cron onNexoPerfilEntidades).
  //    A coleção é keyed pela IDENTIDADE da entidade (1 doc por CNPJ-raiz/CPF/nome),
  //    NÃO por exercício, e NÃO carrega `_cnpj` — os campos são `doc`/`cnpj`/`cpf`/
  //    `cnpjRaiz`/`_id`/`nome`. Por isso lemos a coleção inteira e casamos em
  //    memória (filtrar por `_cnpj` no servidor devolveria SEMPRE zero). Coleção
  //    vazia ⇒ ainda sem perfil pra este alvo: NÃO é erro, degrada honesto.
  let perfilCanonico: Record<string, unknown> | null = null;
  let perfilMotivo: string | null = null;
  try {
    const docsEnt = await lerColecaoNexo(
      'nexo_entidades',
      { limit: LIMITE_LEITURA },
      idToken,
      CAMPOS_ENTIDADE,
    );
    if (docsEnt.length > 0) {
      // Casa por documento (cnpj/cpf/doc, e raiz do CNPJ p/ colapsar filiais) ou,
      // quando a busca foi por nome, pelo nome/_id canônico.
      const docRaiz = doc.length === 14 ? doc.slice(0, 8) : doc;
      perfilCanonico =
        (doc
          ? docsEnt.find((e) => {
              const ed = digits(e.cnpj ?? e.cpf ?? e.doc);
              return ed === doc || (!!docRaiz && digits(e.cnpjRaiz) === docRaiz);
            })
          : undefined) ??
        (termo
          ? docsEnt.find((e) => casaTexto(termo, str(e.nome), str(e._id)))
          : undefined) ??
        null;
      if (!perfilCanonico) {
        perfilMotivo =
          'Nenhum perfil canônico em nexo_entidades casou este alvo. O raio-x ' +
          'abaixo é montado direto das coleções de origem e dos vínculos cruzados.';
      }
    } else {
      perfilMotivo =
        'A coleção de perfis canônicos (nexo_entidades) está vazia para o período: ' +
        'o cron de perfis (onNexoPerfilEntidades) ainda não rodou ou não produziu ' +
        'perfis. O raio-x abaixo é montado direto das coleções de origem e dos ' +
        'vínculos já cruzados.';
    }
  } catch {
    // Coleção inexistente / sem permissão — degrada para o raio-x montado das
    // coleções de origem, sem derrubar a resposta.
    perfilMotivo =
      'A coleção nexo_entidades não está disponível no momento. O raio-x abaixo é ' +
      'montado direto das coleções de origem.';
  }

  // 2) Presença nas coleções reais — o raio-x funcional por documento.
  const [empenhos, contratosRaw, licitacoesRaw] = await Promise.all([
    doc
      ? lerColecaoNexo(
          'nexo_empenhos',
          { exercicio, cnpj: doc, limit: LIMITE_LEITURA },
          idToken,
          CAMPOS_EMPENHO,
        ).catch(() => [])
      : Promise.resolve<Record<string, unknown>[]>([]),
    lerColecaoNexo(
      'nexo_contratos_municipais',
      { exercicio, fonte: 'dados-abertos', limit: LIMITE_LEITURA },
      idToken,
      CAMPOS_CONTRATO,
    ).catch(() => []),
    lerColecaoNexo(
      'nexo_licitacoes',
      { exercicio, fonte: 'dados-abertos', limit: LIMITE_LEITURA },
      idToken,
      CAMPOS_LICITACAO,
    ).catch(() => []),
  ]);

  // Empenhos da entidade (já filtrados por `_cnpj` na query quando há doc; se a
  // busca foi por nome, filtra aqui pelo nome do fornecedor).
  const empenhosEnt = doc
    ? empenhos
    : empenhos.filter((e) =>
        casaTexto(termo, str(e._fornecedor ?? e.NomeFornecedor ?? e.Fornecedor)),
      );
  const valorEmpenhado = empenhosEnt.reduce(
    (s, e) => s + num(e._valor ?? e.ValorEmpenho ?? e.ValorEmpenhado),
    0,
  );
  // Identidade da entidade (rótulo + doc representativo) a partir dos empenhos.
  let nomeEnt = '';
  let docRepresentativo = doc;
  for (const e of empenhosEnt) {
    const n = str(e._fornecedor ?? e.NomeFornecedor ?? e.Fornecedor);
    if (n && !nomeEnt) nomeEnt = n;
    const d = digits(e._cnpj);
    if (d.length === 14 && docRepresentativo.length !== 14) docRepresentativo = d;
  }

  // Contratos da entidade (por doc, ou por nome quando não há doc).
  const contratos = contratosRaw
    .filter((c) =>
      doc
        ? digits(c._cnpj) === doc
        : casaTexto(termo, str(c._fornecedor ?? c.nomeContratada)),
    )
    .map((c) => ({
      numeroContrato: str(c.numeroContrato),
      numeroProcesso: str(c.numeroProcesso),
      objeto: str(c.objeto) || null,
      valor: num(c.valor ?? c._valor),
      vigenciaInicio: str(c.vigenciaInicio) || null,
      vigenciaFim: str(c.vigenciaFim) || null,
    }));

  // Licitações ligadas à entidade só são deriváveis por NOME (o dados-abertos
  // não traz o vencedor); casa o nome/objeto contra o termo quando há termo.
  const licitacoes = (termo
    ? licitacoesRaw.filter((l) =>
        casaTexto(termo, str(l.objeto), str(l.numeroProcesso)),
      )
    : []
  )
    .slice(0, LIMITE)
    .map((l) => ({
      numeroProcesso: str(l.numeroProcesso),
      modalidade: str(l.modalidade),
      objeto: str(l.objeto) || null,
      situacao: str(l.situacao) || null,
      tipo: str(l._tipo ?? l.tipo) || null,
    }));

  if (!nomeEnt) nomeEnt = perfilCanonico ? str(perfilCanonico.nome) : q.trim();

  // 3) Vínculos de `nexo_links` que tocam os docs desta entidade. Lê o grafo do
  //    exercício e filtra as arestas cujo `_de`/`_para` referenciam um empenho/
  //    contrato da entidade, OU cuja `chave` é o CNPJ da entidade.
  // O grafo `nexo_links` referencia o empenho pelo DOCID do Firestore (campo
  // `_docId` que `lerColecaoNexo` injeta), NÃO pelo `ID` cru da fonte SMARAPD.
  // Casar por `e.ID` aqui nunca bateria com `_de`/`_para.id` do linkage.
  const empenhoIds = new Set(empenhos.map((e) => str(e._docId)).filter(Boolean));
  let vinculos: VinculoEntidade[] = [];
  try {
    const links = await lerColecaoNexo(
      'nexo_links',
      { exercicio, limit: LIMITE_LEITURA },
      idToken,
      CAMPOS_LINK,
    );
    const docDigits = docRepresentativo || doc;
    vinculos = links
      .filter((lk) => {
        const de = lk._de as { colecao?: string; id?: string } | undefined;
        const para = lk._para as { colecao?: string; id?: string } | undefined;
        const tocaEmpenho =
          (de?.colecao === 'nexo_empenhos' && empenhoIds.has(str(de?.id))) ||
          (para?.colecao === 'nexo_empenhos' && empenhoIds.has(str(para?.id)));
        const chaveCnpj =
          str(lk.chaveTipo) === 'cnpj' &&
          docDigits &&
          digits(lk.chave) === docDigits;
        return tocaEmpenho || chaveCnpj;
      })
      .map((lk) => {
        const de = lk._de as { colecao?: string; id?: string } | undefined;
        const para = lk._para as { colecao?: string; id?: string } | undefined;
        // Reporta o lado que NÃO é o empenho da própria entidade (o "alvo" do
        // vínculo); se ambos forem empenho, reporta o `_para`.
        const ladoAlvo =
          de?.colecao === 'nexo_empenhos' && empenhoIds.has(str(de?.id))
            ? para
            : de;
        return {
          colecao: str(ladoAlvo?.colecao),
          id: str(ladoAlvo?.id),
          tipo: str(lk.tipo),
          chave: str(lk.chave),
          chaveTipo: str(lk.chaveTipo),
          confianca: str(lk.confianca),
        };
      })
      .slice(0, LIMITE * 4);
  } catch {
    /* grafo de vínculos indisponível — raio-x segue sem a aba de vínculos */
  }

  const algoEncontrado =
    perfilCanonico != null ||
    empenhosEnt.length > 0 ||
    contratos.length > 0 ||
    licitacoes.length > 0 ||
    vinculos.length > 0;

  return ok({
    tipo: 'entidade',
    q,
    exercicio,
    disponivel: algoEncontrado,
    motivo: algoEncontrado
      ? perfilMotivo
      : 'Nenhum registro desta entidade nas coleções ingeridas para o exercício. ' +
        'Pode ser que o cron de coleta ainda não tenha rodado, ou que a entidade ' +
        'não tenha movimentação no período.',
    total: vinculos.length,
    // Identidade resolvida (sempre presente, montada das origens quando não há
    // perfil canônico).
    entidade: {
      documento: mascararDoc(docRepresentativo),
      documentoRaw: docRepresentativo,
      nome: nomeEnt,
      ehEntidadePublica: ehEntidadePublica(docRepresentativo, nomeEnt),
    },
    // Perfil canônico de `nexo_entidades` — null + honesto quando nenhum perfil
    // casa o alvo (ou a coleção ainda não tem perfis pro período).
    perfilDisponivel: perfilCanonico != null,
    perfilCanonico,
    empenhos: {
      total: empenhosEnt.length,
      valor: valorEmpenhado,
      docIds: [...empenhoIds].slice(0, LIMITE),
    },
    contratos: contratos.slice(0, LIMITE),
    licitacoes,
    vinculos,
    atualizadoEm: new Date().toISOString(),
  });
}

// ── Estado honesto de coleção vazia/inativa ──────────────────────────────────

function resultadoVazioColeta(
  tipo: TipoBusca,
  q: string,
  exercicio: number,
  motivo: string,
): NextResponse {
  const body: RespostaBase & { coletaInativa: boolean; resultados: unknown[] } = {
    tipo,
    q,
    exercicio,
    disponivel: false,
    motivo,
    // Sinaliza explicitamente que NÃO é "nada encontrado", e sim coleta inativa.
    coletaInativa: true,
    total: 0,
    resultados: [],
    atualizadoEm: new Date().toISOString(),
  };
  return ok(body);
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: headersNoStore },
    );
  }
  const idToken = sessao.idToken;

  const { searchParams } = new URL(req.url);
  const tipoRaw = (searchParams.get('tipo') ?? '').trim().toLowerCase();
  const q = (searchParams.get('q') ?? '').trim();
  const exercicio =
    Number(searchParams.get('exercicio')) || new Date().getFullYear();

  if (!TIPOS.includes(tipoRaw as TipoBusca)) {
    return NextResponse.json(
      {
        erro: `parâmetro 'tipo' inválido: use um de ${TIPOS.join(', ')}`,
        tiposValidos: TIPOS,
      },
      { status: 400, headers: headersNoStore },
    );
  }
  const tipo = tipoRaw as TipoBusca;

  try {
    switch (tipo) {
      case 'empresas':
        return await buscarEmpresas(q, exercicio, idToken);
      case 'servidores':
        return await buscarServidores(q, exercicio, idToken);
      case 'licitacoes':
        return await buscarLicitacoes(q, exercicio, idToken);
      case 'dispensas':
        return await buscarDispensas(q, exercicio, idToken);
      case 'entidade':
        return await buscarEntidade(q, exercicio, idToken);
    }
  } catch (err) {
    // Falha de leitura do Firestore — NÃO mascarar como "nada encontrado".
    return NextResponse.json(
      {
        tipo,
        q,
        exercicio,
        erro: err instanceof Error ? err.message : 'erro ao executar a busca',
      },
      { status: 502, headers: headersNoStore },
    );
  }
}
