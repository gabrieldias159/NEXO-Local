/**
 * Normalização de registros crus da API SMARAPD para tipos limpos.
 *
 * A API devolve valores como strings em formato brasileiro ("9.999,99",
 * "dd/MM/yyyy") e nomes de campo que variam de capitalização entre módulos.
 */

export interface EmpenhoNorm {
  id: string;
  /** CNPJ/CPF — apenas dígitos. */
  cpfCnpj: string;
  fornecedorNome: string;
  numeroEmpenho: string;
  exercicio: number;
  /** Data do empenho em ISO `yyyy-MM-dd`, ou null se não parseável. */
  data: string | null;
  valorEmpenhado: number;
  valorPago: number;
  /** true quando há número de liquidação registrado para o empenho. */
  temLiquidacao: boolean;
  processoAdministrativo: string | null;
  processoLicitatorio: string | null;
  unidadeGestora: string;
}

/** Converte um valor monetário em formato brasileiro para número. */
export function parseValorBR(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'string') return 0;
  const s = v.trim();
  if (!s) return 0;
  const limpo = s.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
}

/** Converte uma data `dd/MM/yyyy[ HH:mm]` para ISO `yyyy-MM-dd`. */
export function parseDataBR(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Mantém apenas os dígitos de um valor (para CNPJ/CPF). */
export function soDigitos(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** Formata um número como moeda brasileira. */
export function formatBRL(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function pick(rec: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (rec[k] != null && rec[k] !== '') return rec[k];
  }
  return undefined;
}

function pickStr(rec: Record<string, unknown>, ...keys: string[]): string | null {
  const v = pick(rec, ...keys);
  return v == null ? null : String(v).trim();
}

/**
 * Normaliza registros do módulo `fornecedor`/`fornecedoranalitico`
 * (empenho analítico) da API SMARAPD.
 *
 * IMPORTANTE — canonicalização de fan-out por liquidação: a fonte publica UMA
 * LINHA POR EVENTO DE LIQUIDAÇÃO do mesmo empenho, não uma linha por empenho.
 * `ValorEmpenho` (o compromisso TOTAL) vem repetido, idêntico, em cada linha;
 * só `ValorLiquidoPago` varia (é o valor daquele evento específico). Ver
 * `canonicalizarEmpenhos` abaixo.
 */
export function normalizarEmpenhosFornecedor(
  brutos: Record<string, unknown>[],
  exercicio: number,
): EmpenhoNorm[] {
  const linhas = brutos.map((rec, idx) => ({
    // IDENTIDADE = docId do Firestore (`_docId`, carimbado por lerColecaoNexo/
    // lerDocNexo). É o MESMO id que `nexo_links._de/_para` referenciam e que o
    // detalhe (/api/nexo/empenho/[id]) usa no `lerDocNexo`. O antigo `ID`/`Id`
    // (id do SMARAPD) NÃO casava com o docId, então os links da listagem davam
    // 404 ("identificador pode estar incorreto…") e o empenho não abria. Cai no
    // `ID`/`Id` só se `_docId` faltar (registro não vindo do Firestore).
    id: String(pick(rec, '_docId', 'ID', 'Id') ?? `${exercicio}-${idx}`),
    cpfCnpj: soDigitos(pick(rec, 'CPFCNPJ', 'CpfCnpj', 'CNPJ', 'CpfCnpjFornecedor')),
    fornecedorNome: pickStr(rec, 'NomeFornecedor', 'Fornecedor') ?? '',
    numeroEmpenho: pickStr(rec, 'NroEmpenho', 'NumeroEmpenho', 'NumEmpenho') ?? '',
    exercicio: Number(pick(rec, 'ExercEmpenho', 'Exercicio')) || exercicio,
    data: parseDataBR(pick(rec, 'DataMovimentoEmpenho', 'DataEmp', 'DataMovEmp', 'Data')),
    valorEmpenhado: parseValorBR(pick(rec, 'ValorEmpenho', 'ValorEmpenhado')),
    valorPago: parseValorBR(pick(rec, 'ValorLiquidoPago', 'ValorPago')),
    temLiquidacao: !!pickStr(rec, 'NroLiquidacao', 'NumeroLiquidacao'),
    processoAdministrativo: pickStr(rec, 'NroProcessoAdminEmpenho', 'NroProcessoAdmin', 'ProcessoAdministrativo'),
    processoLicitatorio: pickStr(rec, 'ProcessoLicitatorio', 'NroLicitacao'),
    unidadeGestora: pickStr(rec, 'UG', 'UnidadeGestora') ?? '',
  }));
  return canonicalizarEmpenhos(linhas);
}

/**
 * Colapsa o fan-out de liquidação em UM `EmpenhoNorm` por empenho real.
 *
 * Sem isto, somar `valorEmpenhado` por fornecedor infla o total pelo Nº de
 * parcelas de liquidação — comprovado empiricamente (auditoria 2026-07-27): um
 * fornecedor com pagamento parcelado (concessionária de energia) chegava a
 * quase R$ 1,6 BILHÃO de "total empenhado" em 2025 quando o valor real (51
 * empenhos distintos) era R$ 6,57 milhões — fator de inflação 244x. Isso
 * alimentava DIRETAMENTE fracionamento (LC-01..05), concentração (FN-01) e as
 * anomalias estatísticas (AN-01/03/04), todos consumidores de `ctx.empenhos`.
 *
 * A mesma causa-raiz já tinha sido corrigida do lado de
 * `functions/src/nexo/perfil-entidades.ts` (canonicaliza por
 * fornecedor|UG|NroEmpenho antes de somar) — mas SÓ ali; esta função é o ponto
 * que faltava do lado dos detectores (`/api/nexo/detectar`, `/api/nexo/analise`).
 *
 * Regra: `valorEmpenhado` é o compromisso TOTAL, idêntico por linha do mesmo
 * empenho — toma o MAIOR valor (defensivo contra linha com 0/ausente), NUNCA
 * soma. `valorPago` É incremental por evento de liquidação — soma
 * corretamente. Sem nº de empenho não há como agrupar → mantém 1:1
 * (comportamento antigo, sem perda).
 */
function canonicalizarEmpenhos(linhas: EmpenhoNorm[]): EmpenhoNorm[] {
  const porChave = new Map<string, EmpenhoNorm>();
  for (const l of linhas) {
    const chave = l.numeroEmpenho
      ? `${l.cpfCnpj}|${l.unidadeGestora}|${l.numeroEmpenho}`
      : `doc:${l.id}`;
    const prev = porChave.get(chave);
    if (!prev) {
      porChave.set(chave, { ...l });
      continue;
    }
    if (l.valorEmpenhado > prev.valorEmpenhado) prev.valorEmpenhado = l.valorEmpenhado;
    prev.valorPago += l.valorPago;
    prev.temLiquidacao = prev.temLiquidacao || l.temLiquidacao;
    if (l.data && (!prev.data || l.data < prev.data)) prev.data = l.data;
  }
  return [...porChave.values()];
}

// ── Diárias ──────────────────────────────────────────────────────────────────

export interface DiariaNorm {
  id: string;
  beneficiario: string;
  numeroEmpenho: string;
  exercicio: number;
  data: string | null;
  valor: number;
  valorPago: number;
  unidade: string;
}

/** Normaliza registros do módulo `diarias` da API SMARAPD. */
export function normalizarDiarias(
  brutos: Record<string, unknown>[],
  exercicio: number,
): DiariaNorm[] {
  return brutos.map((rec, idx) => ({
    id: String(pick(rec, 'ID', 'NroEmpenho') ?? `diaria-${exercicio}-${idx}`),
    beneficiario: pickStr(rec, 'NomeFornecedor', 'Beneficiario', 'NomeServidor') ?? '',
    numeroEmpenho: pickStr(rec, 'NroEmpenho', 'NumeroEmpenho') ?? '',
    exercicio: Number(pick(rec, 'Exercicio')) || exercicio,
    data: parseDataBR(pick(rec, 'DataEmp', 'DataEmpenho', 'Data')),
    valor: parseValorBR(pick(rec, 'ValorEmpenhado', 'ValorEmpenho')),
    valorPago: parseValorBR(pick(rec, 'ValorPago')),
    unidade: pickStr(rec, 'UnidadeOrcamentaria', 'UG', 'Programa') ?? '',
  }));
}

// ── Empenho por modalidade (visão agregada) ──────────────────────────────────

export interface ModalidadeTotal {
  modalidade: string;
  valorEmpenhado: number;
}

/** Normaliza o módulo `quadro_de_renda_local` (empenho por modalidade). */
export function normalizarModalidades(
  brutos: Record<string, unknown>[],
): ModalidadeTotal[] {
  return brutos
    .map((rec) => ({
      modalidade: pickStr(rec, 'tipoLic', 'TipoLic', 'Modalidade') ?? '',
      valorEmpenhado: parseValorBR(pick(rec, 'ValorEmpenhado', 'Valor')),
    }))
    .filter((m) => m.modalidade);
}

// ── Contratos (PNCP) ─────────────────────────────────────────────────────────

/** Converte data ISO (`yyyy-MM-dd[...]`) ou BR (`dd/MM/yyyy`) para `yyyy-MM-dd`. */
export function parseDataISO(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return parseDataBR(v);
}

export interface ContratoNorm {
  id: string;
  numeroContrato: string;
  objeto: string;
  fornecedorDoc: string;
  fornecedorNome: string;
  valorInicial: number;
  /** Valor global/atualizado — reflete aditivos quando houver. */
  valorGlobal: number;
  dataAssinatura: string | null;
  vigenciaInicio: string | null;
  vigenciaFim: string | null;
  orgao: string;
}

/** Normaliza contratos vindos da API de Consulta do PNCP. */
export function normalizarContratosPNCP(
  brutos: Record<string, unknown>[],
): ContratoNorm[] {
  return brutos.map((rec, idx) => {
    const orgaoObj = rec.orgaoEntidade as Record<string, unknown> | undefined;
    const valorInicial = parseValorBR(pick(rec, 'valorInicial', 'valorContrato'));
    const valorGlobal = parseValorBR(
      pick(rec, 'valorGlobal', 'valorAtualizado', 'valorAcumulado', 'valorInicial'),
    );
    return {
      id: String(
        pick(rec, 'numeroControlePncpCompra', 'numeroControlePNCP', 'id') ?? `contrato-${idx}`,
      ),
      numeroContrato: pickStr(rec, 'numeroContratoEmpenho', 'numeroContrato') ?? '',
      objeto: pickStr(rec, 'objetoContrato', 'objeto') ?? '',
      fornecedorDoc: soDigitos(pick(rec, 'niFornecedor', 'cnpjCpfFornecedor')),
      fornecedorNome: pickStr(rec, 'nomeRazaoSocialFornecedor', 'nomeFornecedor') ?? '',
      valorInicial,
      valorGlobal: valorGlobal || valorInicial,
      dataAssinatura: parseDataISO(pick(rec, 'dataAssinatura')),
      vigenciaInicio: parseDataISO(pick(rec, 'dataVigenciaInicio', 'vigenciaInicio')),
      vigenciaFim: parseDataISO(pick(rec, 'dataVigenciaFim', 'vigenciaFim')),
      orgao: orgaoObj ? String(orgaoObj.razaoSocial ?? orgaoObj.nome ?? '') : '',
    };
  });
}

// ── Restos a pagar ───────────────────────────────────────────────────────────

export interface RestoPagarNorm {
  id: string;
  cpfCnpj: string;
  fornecedorNome: string;
  exercicio: number;
  valor: number;
}

/** Normaliza registros do módulo `restoapagar` da API SMARAPD. */
export function normalizarRestosAPagar(
  brutos: Record<string, unknown>[],
  exercicio: number,
): RestoPagarNorm[] {
  return brutos.map((rec, idx) => ({
    id: String(pick(rec, 'ID', 'NroEmpenho') ?? `resto-${exercicio}-${idx}`),
    cpfCnpj: soDigitos(pick(rec, 'CPFCNPJ', 'CNPJ', 'CpfCnpj')),
    fornecedorNome: pickStr(rec, 'NomeFornecedor', 'Fornecedor') ?? '',
    exercicio,
    valor: parseValorBR(
      pick(rec, 'ValorRestoAPagar', 'ValorInscrito', 'SaldoRestoAPagar', 'Valor', 'ValorEmpenhado'),
    ),
  }));
}

// ── Folha de pagamento ───────────────────────────────────────────────────────

export interface ServidorNorm {
  matricula: string;
  nome: string;
  cargo: string;
  lotacao: string;
  mes: number;
  dataAdmissao: string | null;
  vencimentos: number;
  descontos: number;
  liquido: number;
}

/** Normaliza registros do módulo `pagamentos` (folha) da API SMARAPD. */
export function normalizarFolha(brutos: Record<string, unknown>[]): ServidorNorm[] {
  return brutos.map((rec) => ({
    matricula: pickStr(rec, 'Matricula', 'NumeroMatricula') ?? '',
    nome: pickStr(rec, 'NomeServidor', 'Nome', 'NomeFornecedor') ?? '',
    cargo: pickStr(rec, 'CargoFuncao', 'Cargo') ?? '',
    lotacao: pickStr(rec, 'Funcao', 'Lotacao', 'Secretaria') ?? '',
    mes: Number(pick(rec, 'Mes')) || 0,
    dataAdmissao: parseDataBR(pick(rec, 'DataAdmissao', 'DataAdmissao')),
    vencimentos: parseValorBR(pick(rec, 'TotalVencimentos', 'Vencimentos')),
    descontos: parseValorBR(pick(rec, 'TotalDescontos', 'Descontos')),
    liquido: parseValorBR(pick(rec, 'SalarioLiquido', 'TotalLiquido', 'Liquido')),
  }));
}

// ── Despesas orçamentárias (DespesaAgrupada) ─────────────────────────────────

export interface DespesaNorm {
  id: string;
  numeroEmpenho: string;
  cpfCnpj: string;
  fornecedorNome: string;
  data: string | null;
  valorEmpenhado: number;
  valorPago: number;
  unidadeGestora: string;
  /** Objeto/tipo do gasto (campo Evento). */
  objeto: string;
  elemento: string;
  modalidadeCodigo: string;
  /** "Empenho" | "Reforço" | "Anulação". */
  tipoEmpenho: string;
  bemOuServico: string;
}

/** Normaliza registros do módulo `DespesaAgrupada` da API SMARAPD. */
export function normalizarDespesas(
  brutos: Record<string, unknown>[],
  exercicio: number,
): DespesaNorm[] {
  return brutos.map((rec, idx) => ({
    id: String(pick(rec, 'ID', 'NroEmpenho') ?? `desp-${exercicio}-${idx}`),
    numeroEmpenho: pickStr(rec, 'NroEmpenho', 'NumeroEmpenho') ?? '',
    cpfCnpj: soDigitos(pick(rec, 'CNPJ', 'CPFCNPJ', 'CpfCnpj')),
    fornecedorNome: pickStr(rec, 'NomeFornecedor', 'Fornecedor') ?? '',
    data: parseDataBR(pick(rec, 'DataMovEmp', 'DataMovimentoEmpenho', 'DataEmp')),
    valorEmpenhado: parseValorBR(pick(rec, 'ValorEmpenhado', 'ValorEmpenho')),
    valorPago: parseValorBR(pick(rec, 'ValorPago')),
    unidadeGestora: pickStr(rec, 'UG', 'UnidadeGestora') ?? '',
    objeto: pickStr(rec, 'Evento', 'Objeto', 'Historico') ?? '',
    elemento: pickStr(rec, 'Elemento', 'ElementoDespesa') ?? '',
    modalidadeCodigo: pickStr(rec, 'Modalidade') ?? '',
    tipoEmpenho: pickStr(rec, 'TipEmpenho', 'TipoEmpenho') ?? '',
    bemOuServico: pickStr(rec, 'BemouServico', 'BemOuServico') ?? '',
  }));
}

/** Mascara o nome para exibição — primeiro nome + iniciais (LGPD, minimização). */
export function mascararNome(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return nome;
  if (partes.length === 1) {
    const p = partes[0];
    return p.length > 3 ? `${p.slice(0, 3)}…` : p;
  }
  return partes.map((p, i) => (i === 0 ? p : `${p[0]}.`)).join(' ');
}

/**
 * Formata um documento para exibição. CNPJ (14 dígitos) é dado de pessoa
 * jurídica — formatado por extenso. CPF (11 dígitos) é dado pessoal — exibido
 * mascarado, preservando os 3 primeiros e os 2 finais (LGPD, minimização).
 * Documento ausente ou de tamanho inesperado vira travessão.
 */
export function mascararDoc(doc: string | null | undefined): string {
  const d = soDigitos(doc);
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  if (d.length === 11) {
    return `${d.slice(0, 3)}.***.***-${d.slice(9)}`;
  }
  return d ? `${d.slice(0, 3)}…` : '—';
}
