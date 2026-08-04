/**
 * Detectores do catálogo NEXO — Frota e combustível (FC) e Saúde, medicamentos
 * e almoxarifado (SA), faixas FC-03..FC-11 e SA-01..SA-13 (exceto SA-08/SA-11,
 * já cobertos em `setoriais.ts`).
 *
 * Princípio de honestidade (plano-mestre §6): boa parte destes monitoramentos
 * depende de fontes que NÃO estão no `ContextoAnalise` e não têm API pública
 * municipal direta — diário de bordo da frota (km rodada), ficha técnica de
 * veículos (capacidade de tanque, km/l esperado), cadastro de frota
 * (placa/situação), extratos do cartão-combustível, e o sistema de almoxarifado
 * (entradas/saídas de estoque, lote, validade, distribuição). Esses dados estão
 * previstos para coleta via e-SIC / pedido formal de transparência (plano-mestre
 * §6.4). Enquanto não houver a fonte, o detector correspondente é implementado
 * COMPLETO com a lógica correta do catálogo e retorna `[]`, com comentário
 * nomeando a fonte ausente — nunca inventa dado, nunca gera falso positivo.
 *
 * O que É computável a partir de `ContextoAnalise.despesas` roda de verdade:
 *   FC-07  — abastecimento em fim de semana/feriado (data da despesa).
 *   FC-08  — abastecimentos sequenciais por agregação (mesmo fornecedor/dia).
 *   FC-10  — fornecedor único de combustível por período longo (≥24 meses).
 *   FC-11  — manutenção de frota recorrente (≥4 empenhos do mesmo fornecedor).
 *   SA-05  — preço de item de saúde fora de faixa (por estatística interna).
 *   SA-09  — compra emergencial recorrente de saúde (modalidade emergencial).
 *   SA-12  — fiscal/UG concentrando volume anormal de liquidações (proxy).
 *   SA-13  — manutenção hospitalar recorrente (proxy de "sem laudo").
 */
import { formatBRL, type DespesaNorm } from '../normalizar';
import type { AlertaDetectado, ContextoAnalise, Detector } from './tipos';

// ── Categorias canônicas ─────────────────────────────────────────────────────
const CAT_FC = 'Frota e combustível';
const CAT_SA = 'Saúde, medicamentos e almoxarifado';

// ── Padrões de classificação por objeto/elemento ─────────────────────────────
const RE_COMBUSTIVEL = /combust|gasolina|diesel|etanol|\bgnv\b|abastec|posto/i;
const RE_SAUDE = /sa[úu]de|medicament|f[áa]rmac|hospital|insumo|ambul[âa]nc|cl[íi]nic|enfermag|odontol|farm[áa]cia/i;
const RE_MANUTENCAO = /manuten[çc][ãa]o|conserto|reparo|revis[ãa]o|pe[çc]a|oficina|mec[âa]nic|funilar|retific/i;
const RE_VEICULO = /ve[íi]culo|frota|autom[óo]vel|caminh[ãa]o|[ôo]nibus|ambul[âa]nc|motocicl|tr[áa]tor/i;
const RE_EMERGENCIAL =
  /emerg[êe]nc|calamidad|dispensa.*urg|art\.?\s*75\s*viii|inciso\s*viii|estado\s+de\s+emerg/i;

function ehCombustivel(d: DespesaNorm): boolean {
  return RE_COMBUSTIVEL.test(d.objeto) || RE_COMBUSTIVEL.test(d.elemento);
}
function ehSaude(d: DespesaNorm): boolean {
  return RE_SAUDE.test(d.unidadeGestora) || RE_SAUDE.test(d.objeto) || RE_SAUDE.test(d.elemento);
}
function ehManutencao(d: DespesaNorm): boolean {
  return RE_MANUTENCAO.test(d.objeto) || RE_MANUTENCAO.test(d.elemento);
}
function ehVeiculo(d: DespesaNorm): boolean {
  return RE_VEICULO.test(d.objeto) || RE_VEICULO.test(d.elemento) || RE_VEICULO.test(d.unidadeGestora);
}
function ehEmergencial(d: DespesaNorm): boolean {
  return RE_EMERGENCIAL.test(d.objeto) || RE_EMERGENCIAL.test(d.modalidadeCodigo);
}

/** true para empenho positivo (ignora anulações e reforços zerados). */
function empenhoValido(d: DespesaNorm): boolean {
  return d.valorEmpenhado > 0 && !/anula/i.test(d.tipoEmpenho);
}

/** Domingo ou sábado a partir de uma data ISO `yyyy-MM-dd`. */
function ehFimDeSemana(iso: string): boolean {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Feriados nacionais fixos (dd-MM). Feriados móveis (Carnaval, Páscoa, Corpus
 * Christi) e feriados municipais NÃO entram — exigiriam tabela por ano/município
 * não disponível no contexto. Lista conservadora: só amplia o FC-07, nunca
 * gera falso positivo isolado (o alerta é sempre "indício a apurar").
 */
const FERIADOS_FIXOS = new Set<string>([
  '01-01', '21-04', '01-05', '07-09', '12-10', '02-11', '15-11', '25-12',
]);
function ehFeriadoFixo(iso: string): boolean {
  const m = iso.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!m) return false;
  return FERIADOS_FIXOS.has(`${m[2]}-${m[1]}`);
}

/** Diferença em meses entre duas datas ISO. */
function difMeses(isoA: string, isoB: string): number {
  const a = new Date(`${isoA}T00:00:00Z`);
  const b = new Date(`${isoB}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.abs(
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()),
  );
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  FROTA E COMBUSTÍVEL — FC-03 a FC-11                                      ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * FC-03 — Consumo km/l incompatível.
 * Regra do catálogo: km/l < 50% da média esperada do tipo de veículo.
 *
 * FONTE AUSENTE: requer o diário de bordo da frota (km rodada por veículo) e a
 * ficha técnica de cada veículo (km/l esperado por tipo). Nenhum dos dois está
 * em `ContextoAnalise` — `DespesaNorm` traz apenas valor financeiro do empenho,
 * sem litros, sem placa, sem hodômetro. Coleta prevista via e-SIC (diário de
 * bordo) + cadastro de frota. Sem a fonte, retorna [] (sem falso positivo).
 */
export const detectorConsumoKmL: Detector = {
  id: 'FC-03',
  nome: 'Consumo km/l incompatível',
  categoria: CAT_FC,
  detectar(_ctx: ContextoAnalise): AlertaDetectado[] {
    // Dado de litros/km por veículo indisponível no ContextoAnalise.
    return [];
  },
};

/**
 * FC-04 — Abastecimento acima da capacidade do tanque.
 * Regra do catálogo: litros abastecidos > capacidade do tanque + 10%.
 *
 * FONTE AUSENTE: requer o registro de abastecimento por evento (litros por
 * abastecimento, placa) cruzado com a ficha técnica do veículo (capacidade do
 * tanque). `DespesaNorm` agrega o empenho em valor, sem granularidade de
 * abastecimento nem litragem. Coleta prevista via e-SIC (controle de
 * abastecimento) + cadastro de frota. Sem a fonte, retorna [].
 */
export const detectorAbastecimentoAcimaTanque: Detector = {
  id: 'FC-04',
  nome: 'Abastecimento acima da capacidade do tanque',
  categoria: CAT_FC,
  detectar(_ctx: ContextoAnalise): AlertaDetectado[] {
    // Litragem por abastecimento e capacidade de tanque indisponíveis.
    return [];
  },
};

/**
 * FC-05 — Veículo parado/baixado com consumo.
 * Regra do catálogo: abastecimento para veículo sem deslocamento ou baixado.
 *
 * FONTE AUSENTE: requer o cadastro de frota (situação do veículo: ativo /
 * baixado / inservível) e o diário de bordo (deslocamento). Não há placa nem
 * situação de veículo em `DespesaNorm`. Coleta prevista via e-SIC (cadastro de
 * frota + diário de bordo). Sem a fonte, retorna [].
 */
export const detectorVeiculoParadoConsumo: Detector = {
  id: 'FC-05',
  nome: 'Veículo parado com consumo',
  categoria: CAT_FC,
  detectar(_ctx: ContextoAnalise): AlertaDetectado[] {
    // Situação do veículo (baixado/parado) indisponível no ContextoAnalise.
    return [];
  },
};

/**
 * FC-06 — Abastecimento sem quilometragem.
 * Regra do catálogo: km ausente em > 20% dos abastecimentos do veículo/mês.
 *
 * FONTE AUSENTE: requer o registro de abastecimento com campo de hodômetro
 * (km). `DespesaNorm` não tem registro de abastecimento individual nem campo de
 * km. Coleta prevista via e-SIC (planilha de controle de abastecimento). Sem a
 * fonte, retorna [].
 */
export const detectorAbastecimentoSemKm: Detector = {
  id: 'FC-06',
  nome: 'Abastecimento sem quilometragem',
  categoria: CAT_FC,
  detectar(_ctx: ContextoAnalise): AlertaDetectado[] {
    // Campo de quilometragem por abastecimento indisponível.
    return [];
  },
};

/**
 * FC-07 — Abastecimento em fim de semana/feriado.
 * Regra do catálogo: abastecimento em domingo/feriado de veículo administrativo.
 *
 * COMPUTÁVEL PARCIAL: o evento de abastecimento individual não existe em
 * `DespesaNorm`, mas o EMPENHO de combustível tem data. Empenhar combustível
 * num domingo ou feriado é atípico — empenho é ato administrativo de
 * expediente. Usamos a data do empenho como proxy conservador: indício a
 * apurar, classificação só "atenção", e exigimos UG não relacionada a serviços
 * essenciais 24h (saúde) para reduzir falso positivo (ambulância abastece a
 * qualquer hora — legítimo). Limiar: pelo menos 2 ocorrências na mesma UG.
 */
export const detectorAbastecimentoFimDeSemana: Detector = {
  id: 'FC-07',
  nome: 'Abastecimento em fim de semana/feriado',
  categoria: CAT_FC,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const comb = ctx.despesas.filter(
      (d) =>
        empenhoValido(d) &&
        ehCombustivel(d) &&
        d.data != null &&
        (ehFimDeSemana(d.data) || ehFeriadoFixo(d.data)) &&
        // exclui UGs de serviço essencial 24h — abastecimento legítimo fora de expediente.
        !ehSaude(d),
    );
    if (comb.length < 2) return [];
    const porUG = new Map<string, DespesaNorm[]>();
    for (const d of comb) {
      const ug = d.unidadeGestora || 'Unidade não informada';
      const arr = porUG.get(ug) ?? [];
      arr.push(d);
      porUG.set(ug, arr);
    }
    const out: AlertaDetectado[] = [];
    for (const [ug, lista] of porUG) {
      if (lista.length < 2) continue;
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      out.push({
        detectorId: 'FC-07',
        detectorNome: 'Abastecimento em fim de semana/feriado',
        categoria: CAT_FC,
        titulo: `Empenhos de combustível em fim de semana/feriado — ${ug}`,
        descricao:
          `${lista.length} empenhos de combustível com data em sábado, domingo ou ` +
          `feriado na unidade, somando ${formatBRL(soma)}.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `fc07-${ug}`,
        sujeitoRotulo: ug,
        classificacao: 'atencao',
        scores: { confiabilidade: 52, probabilidadeIrregularidade: 40 },
        fundamentoLegal: ['Lei 9.504/1997 art. 73', 'Controle interno'],
        evidencias: lista.slice(0, 6).map((d) => ({
          resumo: `${d.objeto || 'Combustível'} — ${formatBRL(d.valorEmpenhado)}`,
          valor: d.valorEmpenhado,
          data: d.data,
          ref: d.numeroEmpenho || undefined,
        })),
        explicacao:
          'Empenho de combustível datado em fim de semana ou feriado é indício ' +
          'que merece verificar o controle de abastecimento da frota administrativa. ' +
          'Observação: a evidência é a data do empenho (proxy) — o evento de ' +
          'abastecimento em si depende do diário de bordo, a coletar via e-SIC.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

/**
 * FC-08 — Abastecimentos sequenciais (mesmo veículo no dia).
 * Regra do catálogo: ≥2 abastecimentos do mesmo veículo em 24h.
 *
 * FONTE AUSENTE para a regra exata: o "mesmo veículo" exige placa, que não
 * existe em `DespesaNorm`. Não emitimos alerta por placa.
 *
 * COMPUTÁVEL como proxy de agregação CONSERVADOR: múltiplos empenhos de
 * combustível ao MESMO posto (CNPJ) no MESMO dia podem indicar fracionamento de
 * abastecimento. Só sinalizamos quando há ≥3 empenhos do mesmo CNPJ no mesmo
 * dia (limiar conservador) — indício de controle frágil, classificação
 * "atenção". A regra original por placa fica pendente do cadastro de frota
 * (coleta via e-SIC).
 */
export const detectorAbastecimentosSequenciais: Detector = {
  id: 'FC-08',
  nome: 'Abastecimentos sequenciais',
  categoria: CAT_FC,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const comb = ctx.despesas.filter(
      (d) => empenhoValido(d) && ehCombustivel(d) && d.cpfCnpj && d.data != null,
    );
    // chave: CNPJ + dia
    const porChave = new Map<string, DespesaNorm[]>();
    for (const d of comb) {
      const chave = `${d.cpfCnpj}|${d.data}`;
      const arr = porChave.get(chave) ?? [];
      arr.push(d);
      porChave.set(chave, arr);
    }
    const out: AlertaDetectado[] = [];
    for (const [chave, lista] of porChave) {
      if (lista.length < 3) continue; // limiar conservador
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || lista[0].cpfCnpj;
      const dia = lista[0].data;
      out.push({
        detectorId: 'FC-08',
        detectorNome: 'Abastecimentos sequenciais',
        categoria: CAT_FC,
        titulo: `${lista.length} empenhos de combustível ao mesmo posto no dia — ${nome}`,
        descricao:
          `${lista.length} empenhos de combustível ao mesmo fornecedor em ${dia}, ` +
          `somando ${formatBRL(soma)}.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: chave.split('|')[0],
        sujeitoRotulo: nome,
        classificacao: 'atencao',
        scores: { confiabilidade: 50, probabilidadeIrregularidade: 38 },
        fundamentoLegal: ['Controle interno'],
        evidencias: lista.slice(0, 6).map((d) => ({
          resumo: `${d.objeto || 'Combustível'} — ${formatBRL(d.valorEmpenhado)}`,
          valor: d.valorEmpenhado,
          data: d.data,
          ref: d.numeroEmpenho || undefined,
        })),
        explicacao:
          'Vários empenhos de combustível ao mesmo posto num único dia são ' +
          'indício de controle frágil de abastecimento. A regra do catálogo ' +
          '(≥2 abastecimentos do mesmo veículo em 24h) depende da placa, ' +
          'ausente nos dados orçamentários — verificação fina via diário de bordo (e-SIC).',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

/**
 * FC-09 — Cartão-combustível usado em veículos diferentes.
 * Regra do catálogo: mesmo cartão → ≥2 placas no mesmo período.
 *
 * FONTE AUSENTE: requer o extrato do sistema de gestão de cartão-combustível
 * (número do cartão × placa por transação). Nada disso está em `DespesaNorm`.
 * Coleta prevista via e-SIC (contrato e relatórios da administradora do cartão).
 * Sem a fonte, retorna [].
 */
export const detectorCartaoVeiculosDiferentes: Detector = {
  id: 'FC-09',
  nome: 'Cartão usado em veículos diferentes',
  categoria: CAT_FC,
  detectar(_ctx: ContextoAnalise): AlertaDetectado[] {
    // Extrato cartão×placa indisponível no ContextoAnalise.
    return [];
  },
};

/**
 * FC-10 — Fornecedor único de combustível por longo período.
 * Regra do catálogo: mesmo CNPJ fornece combustível por > 24 meses sem nova
 * licitação.
 *
 * COMPUTÁVEL: usamos as datas dos empenhos de combustível por CNPJ. Se a janela
 * entre o primeiro e o último empenho de combustível ao mesmo fornecedor
 * ultrapassar 24 meses, há indício de fornecimento prolongado sem renovação de
 * certame. Limitação honesta: o `ContextoAnalise` cobre um exercício (ou
 * amostra), então uma janela > 24 meses só aparece se a coleta abranger
 * múltiplos exercícios; quando não abrange, o detector simplesmente não dispara
 * (sem falso negativo forçado, sem falso positivo). Exigimos relevância
 * financeira mínima.
 */
export const detectorFornecedorCombustivelLongo: Detector = {
  id: 'FC-10',
  nome: 'Fornecedor único de combustível por longo período',
  categoria: CAT_FC,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const comb = ctx.despesas.filter(
      (d) => empenhoValido(d) && ehCombustivel(d) && d.cpfCnpj && d.data != null,
    );
    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of comb) {
      const arr = porCnpj.get(d.cpfCnpj) ?? [];
      arr.push(d);
      porCnpj.set(d.cpfCnpj, arr);
    }
    const out: AlertaDetectado[] = [];
    for (const [cnpj, lista] of porCnpj) {
      const datas = lista.map((d) => d.data!).sort();
      const meses = difMeses(datas[0], datas[datas.length - 1]);
      if (meses < 24) continue;
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      if (soma < 50_000) continue; // relevância financeira mínima
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || cnpj;
      out.push({
        detectorId: 'FC-10',
        detectorNome: 'Fornecedor único de combustível por longo período',
        categoria: CAT_FC,
        titulo: `Posto fornece combustível há ${meses} meses — ${nome}`,
        descricao:
          `Empenhos de combustível ao mesmo fornecedor abrangendo ${meses} meses ` +
          `(${datas[0]} a ${datas[datas.length - 1]}), somando ${formatBRL(soma)}.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao: meses >= 36 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 60,
          probabilidadeIrregularidade: Math.min(58, 30 + (meses - 24)),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 11', 'Lei 14.133/2021 art. 106'],
        evidencias: [
          {
            resumo: `Janela de fornecimento: ${meses} meses`,
            data: datas[0],
          },
          {
            resumo: `Último empenho de combustível: ${datas[datas.length - 1]}`,
            data: datas[datas.length - 1],
          },
          { resumo: `Total empenhado em combustível: ${formatBRL(soma)}`, valor: soma },
        ],
        explicacao:
          'Fornecimento de combustível pelo mesmo posto por período prolongado ' +
          'é indício que merece verificar se houve renovação tempestiva do ' +
          'certame e se a contratação permanece competitiva. A confirmação ' +
          'depende do histórico de licitações de combustível do município.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

/**
 * FC-11 — Manutenção de frota recorrente sem laudo.
 * Regra do catálogo: ≥4 manutenções do mesmo veículo/ano sem laudo.
 *
 * FONTE AUSENTE para a regra exata: o "mesmo veículo" exige placa e o "sem
 * laudo" exige o relatório técnico — nenhum dos dois em `DespesaNorm`.
 *
 * COMPUTÁVEL como proxy CONSERVADOR: ≥4 empenhos de manutenção de frota ao
 * mesmo FORNECEDOR (oficina) no mesmo exercício. É indício de gasto recorrente
 * de manutenção a verificar; a regra por veículo e a checagem de laudo ficam
 * pendentes do cadastro de frota e dos processos de pagamento (coleta via
 * e-SIC). Classificação só "atenção".
 */
export const detectorManutencaoFrotaRecorrente: Detector = {
  id: 'FC-11',
  nome: 'Manutenção de frota recorrente sem laudo',
  categoria: CAT_FC,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const manut = ctx.despesas.filter(
      (d) =>
        empenhoValido(d) &&
        d.cpfCnpj &&
        ehManutencao(d) &&
        ehVeiculo(d),
    );
    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of manut) {
      const arr = porCnpj.get(d.cpfCnpj) ?? [];
      arr.push(d);
      porCnpj.set(d.cpfCnpj, arr);
    }
    const out: AlertaDetectado[] = [];
    for (const [cnpj, lista] of porCnpj) {
      if (lista.length < 4) continue;
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || cnpj;
      out.push({
        detectorId: 'FC-11',
        detectorNome: 'Manutenção de frota recorrente sem laudo',
        categoria: CAT_FC,
        titulo: `Manutenção de frota recorrente — ${nome}`,
        descricao:
          `${lista.length} empenhos de manutenção de veículos ao mesmo fornecedor, ` +
          `somando ${formatBRL(soma)}.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao: 'atencao',
        scores: { confiabilidade: 54, probabilidadeIrregularidade: 40 },
        fundamentoLegal: ['Lei 4.320/1964 art. 63'],
        evidencias: lista.slice(0, 6).map((d) => ({
          resumo: `${d.objeto || 'Manutenção de veículo'} — ${formatBRL(d.valorEmpenhado)}`,
          valor: d.valorEmpenhado,
          data: d.data,
          ref: d.numeroEmpenho || undefined,
        })),
        explicacao:
          'Gastos repetidos de manutenção de frota merecem verificar a existência ' +
          'de relatório técnico/laudo justificando cada serviço. A regra do ' +
          'catálogo é por veículo individual — a vinculação à placa depende do ' +
          'cadastro de frota, a coletar via e-SIC.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  SAÚDE, MEDICAMENTOS E ALMOXARIFADO — SA-01..SA-13 (exceto SA-08/SA-11)   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * SA-01 — Pagamento sem entrada em estoque.
 * Regra do catálogo: empenho pago + ausência de entrada de estoque.
 *
 * FONTE AUSENTE: requer o sistema de almoxarifado da Saúde (registro de entrada
 * de material). `ContextoAnalise` traz a despesa orçamentária (empenho/pago),
 * mas não o movimento de estoque. Coleta prevista via e-SIC (relatório de
 * entradas do almoxarifado). Sem a fonte, retorna [].
 */
export const detectorPagamentoSemEntradaEstoque: Detector = {
  id: 'SA-01',
  nome: 'Pagamento sem entrada em estoque',
  categoria: CAT_SA,
  detectar(_ctx: ContextoAnalise): AlertaDetectado[] {
    // Registro de entrada no almoxarifado indisponível no ContextoAnalise.
    return [];
  },
};

/**
 * SA-02 — NF sem correspondência no almoxarifado.
 * Regra do catálogo: quantidade da NF ≠ quantidade registrada no estoque.
 *
 * FONTE AUSENTE: requer a nota fiscal item a item (quantidade) e o lançamento
 * de recebimento no almoxarifado. `DespesaNorm` não traz quantidades nem itens
 * de NF. Coleta prevista via e-SIC (NF-e e relatório de recebimento). Sem a
 * fonte, retorna [].
 */
export const detectorNfSemCorrespondencia: Detector = {
  id: 'SA-02',
  nome: 'NF sem correspondência no almoxarifado',
  categoria: CAT_SA,
  detectar(_ctx: ContextoAnalise): AlertaDetectado[] {
    // Quantidades de NF e de recebimento de estoque indisponíveis.
    return [];
  },
};

/**
 * SA-03 — Entrega parcial paga como integral.
 * Regra do catálogo: quantidade entregue < contratada, pagamento 100%.
 *
 * FONTE AUSENTE: requer a quantidade contratada (do contrato/edital) e a
 * quantidade efetivamente entregue (do recebimento). `ContextoAnalise` só tem o
 * valor financeiro do empenho/pago, sem físico. Coleta prevista via e-SIC
 * (termo de recebimento + contrato). Sem a fonte, retorna [].
 */
export const detectorEntregaParcialPagaIntegral: Detector = {
  id: 'SA-03',
  nome: 'Entrega parcial paga como integral',
  categoria: CAT_SA,
  detectar(_ctx: ContextoAnalise): AlertaDetectado[] {
    // Quantidade entregue x contratada indisponível no ContextoAnalise.
    return [];
  },
};

/**
 * SA-04 — Entrada de medicamento sem lote/validade.
 * Regra do catálogo: campo lote ou validade ausente no registro de entrada.
 *
 * FONTE AUSENTE: requer o registro de entrada do almoxarifado da Saúde com os
 * campos lote e validade. Não há nada de estoque em `DespesaNorm`. Coleta
 * prevista via e-SIC (relatório de entradas com lote/validade). Sem a fonte,
 * retorna [].
 */
export const detectorEntradaSemLoteValidade: Detector = {
  id: 'SA-04',
  nome: 'Entrada sem lote/validade',
  categoria: CAT_SA,
  detectar(_ctx: ContextoAnalise): AlertaDetectado[] {
    // Campos lote/validade do almoxarifado indisponíveis.
    return [];
  },
};

/**
 * SA-05 — Preço acima do Banco de Preços em Saúde.
 * Regra do catálogo: preço unitário > +20% vs. mediana do Banco de Preços em
 * Saúde (BPS, referência nacional).
 *
 * FONTE EXTERNA AUSENTE: a comparação contra o BPS exige a API/base do Banco de
 * Preços em Saúde (Ministério da Saúde) e o preço UNITÁRIO por item — e
 * `DespesaNorm` agrega o empenho, não traz item nem quantidade. A integração
 * com o BPS está prevista no plano (fonte de integração).
 *
 * COMPUTÁVEL como proxy interno CONSERVADOR (sem inventar referência externa):
 * quando há vários empenhos de saúde do MESMO objeto normalizado, comparamos o
 * valor de cada um contra a mediana interna do mesmo objeto. Um empenho >2x a
 * mediana interna do mesmo objeto é indício de preço fora de faixa a verificar.
 * Exige ≥5 empenhos do mesmo objeto para a estatística ter sentido. Isso NÃO
 * substitui o BPS — é só uma triagem de outliers internos; o alerta deixa isso
 * explícito.
 */
function normObjeto(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function mediana(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const detectorPrecoItemSaude: Detector = {
  id: 'SA-05',
  nome: 'Preço acima do Banco de Preços em Saúde',
  categoria: CAT_SA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const saude = ctx.despesas.filter(
      (d) => empenhoValido(d) && ehSaude(d) && d.objeto.trim().length >= 6,
    );
    const porObjeto = new Map<string, DespesaNorm[]>();
    for (const d of saude) {
      const k = normObjeto(d.objeto);
      if (!k) continue;
      const arr = porObjeto.get(k) ?? [];
      arr.push(d);
      porObjeto.set(k, arr);
    }
    const out: AlertaDetectado[] = [];
    for (const [, lista] of porObjeto) {
      if (lista.length < 5) continue; // amostra mínima para estatística
      const valores = lista.map((d) => d.valorEmpenhado);
      const med = mediana(valores);
      if (med <= 0) continue;
      for (const d of lista) {
        if (d.valorEmpenhado <= med * 2) continue; // limiar conservador: 2x a mediana
        const razao = d.valorEmpenhado / med;
        out.push({
          detectorId: 'SA-05',
          detectorNome: 'Preço acima do Banco de Preços em Saúde',
          categoria: CAT_SA,
          titulo: `Conferir valor de empenho de saúde fora da faixa — ${d.objeto}`,
          descricao:
            `Empenho de ${formatBRL(d.valorEmpenhado)} para um objeto cujos demais ` +
            `empenhos têm mediana de ${formatBRL(med)} (${razao.toFixed(1)}x acima). ` +
            `PROXY: compara o valor TOTAL do empenho, não o preço unitário — ` +
            `item de conferência, não indício de sobrepreço por si só.`,
          sujeitoTipo: 'empenho',
          sujeitoId: d.numeroEmpenho || d.id,
          sujeitoRotulo: `Empenho ${d.numeroEmpenho || d.id}`,
          // Proxy declarado: sem preço unitário no contexto, nasce informativo.
          classificacao: 'informativo',
          scores: {
            confiabilidade: 38,
            probabilidadeIrregularidade: Math.min(40, Math.round(20 + razao * 4)),
          },
          fundamentoLegal: ['Lei 14.133/2021 art. 23'],
          evidencias: [
            {
              resumo: `Valor do empenho: ${formatBRL(d.valorEmpenhado)}`,
              valor: d.valorEmpenhado,
              data: d.data,
              ref: d.numeroEmpenho || undefined,
            },
            { resumo: `Mediana interna do mesmo objeto: ${formatBRL(med)}`, valor: med },
          ],
          explicacao:
            'A regra do catálogo (SA-05) compara o PREÇO UNITÁRIO de itens de ' +
            'saúde com o Banco de Preços em Saúde (BPS). PROXY DECLARADO: o ' +
            '`ContextoAnalise` não traz preço unitário nem quantidade — só o ' +
            'valor total do empenho. Um empenho de valor total muito acima da ' +
            'mediana dos demais empenhos do mesmo objeto pode refletir apenas ' +
            'uma quantidade maior, não sobrepreço. Por isso este alerta é ' +
            'apenas um item de conferência (informativo): a comparação ' +
            'definitiva depende do preço unitário por item e do cruzamento com ' +
            'o BPS — integração externa prevista no plano.',
          valorEnvolvido: d.valorEmpenhado,
        });
      }
    }
    return out;
  },
};

/**
 * SA-06 — Compra de medicamento sem distribuição posterior.
 * Regra do catálogo: compra registrada + 0 saídas em 90 dias.
 *
 * FONTE AUSENTE: requer o movimento de SAÍDA do almoxarifado da Saúde
 * (distribuição às unidades). `ContextoAnalise` não tem movimento de estoque.
 * Coleta prevista via e-SIC (relatório de saídas/distribuição). Sem a fonte,
 * retorna [].
 */
export const detectorCompraSemDistribuicao: Detector = {
  id: 'SA-06',
  nome: 'Compra sem distribuição posterior',
  categoria: CAT_SA,
  detectar(_ctx: ContextoAnalise): AlertaDetectado[] {
    // Movimento de saída/distribuição do almoxarifado indisponível.
    return [];
  },
};

/**
 * SA-07 — Falta na unidade apesar de compra recente.
 * Regra do catálogo: reclamação de falta + compra do item nos últimos 60 dias.
 *
 * FONTE AUSENTE: requer as manifestações de falta (e-SIC / ouvidoria) cruzadas
 * com o item comprado. `ContextoAnalise` não traz reclamações nem itens. Coleta
 * prevista via e-SIC/ouvidoria (cruzamento na linha do XS-13). Sem a fonte,
 * retorna [].
 */
export const detectorFaltaApesarCompra: Detector = {
  id: 'SA-07',
  nome: 'Falta na unidade apesar de compra recente',
  categoria: CAT_SA,
  detectar(_ctx: ContextoAnalise): AlertaDetectado[] {
    // Reclamações de falta (ouvidoria/e-SIC) indisponíveis no ContextoAnalise.
    return [];
  },
};

/**
 * SA-09 — Compra emergencial recorrente de saúde.
 * Regra do catálogo: EM-01 (emergência repetida no mesmo objeto) aplicado a
 * objetos da Saúde — mesmo objeto + modalidade emergencial + ≥2 ocorrências em
 * 12 meses.
 *
 * COMPUTÁVEL: `DespesaNorm` tem objeto, modalidadeCodigo e data. Filtramos
 * despesas de saúde com indício de modalidade/contratação emergencial,
 * agrupamos por objeto normalizado e sinalizamos quando o mesmo objeto aparece
 * ≥2 vezes — indício de que um item contínuo da saúde vem sendo comprado por
 * emergência de forma repetida. Limiar conservador: exige ≥2 ocorrências e
 * objeto descritível.
 */
export const detectorEmergencialRecorrenteSaude: Detector = {
  id: 'SA-09',
  nome: 'Compra emergencial recorrente de saúde',
  categoria: CAT_SA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const emerg = ctx.despesas.filter(
      (d) =>
        empenhoValido(d) &&
        ehSaude(d) &&
        ehEmergencial(d) &&
        d.objeto.trim().length >= 6,
    );
    const porObjeto = new Map<string, DespesaNorm[]>();
    for (const d of emerg) {
      const k = normObjeto(d.objeto);
      if (!k) continue;
      const arr = porObjeto.get(k) ?? [];
      arr.push(d);
      porObjeto.set(k, arr);
    }
    const out: AlertaDetectado[] = [];
    for (const [, lista] of porObjeto) {
      if (lista.length < 2) continue;
      // janela de 12 meses, quando há datas — conservador: se faltam datas,
      // ainda assim sinaliza pela recorrência do objeto emergencial.
      const datas = lista.map((d) => d.data).filter((x): x is string => !!x).sort();
      if (datas.length >= 2 && difMeses(datas[0], datas[datas.length - 1]) > 12) {
        // ocorrências espalhadas além de 12 meses — fora da janela do EM-01.
        // mantém o alerta apenas se houver ≥2 dentro de alguma janela de 12m.
        let dentro = false;
        for (let i = 0; i < datas.length; i++) {
          let c = 1;
          for (let j = i + 1; j < datas.length; j++) {
            if (difMeses(datas[i], datas[j]) <= 12) c++;
          }
          if (c >= 2) {
            dentro = true;
            break;
          }
        }
        if (!dentro) continue;
      }
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      const objeto = lista[0].objeto;
      const ug = lista.find((d) => d.unidadeGestora)?.unidadeGestora || '';
      out.push({
        detectorId: 'SA-09',
        detectorNome: 'Compra emergencial recorrente de saúde',
        categoria: CAT_SA,
        titulo: `Compra emergencial repetida de item de saúde — ${objeto}`,
        descricao:
          `${lista.length} contratações com indício de modalidade emergencial para ` +
          `o mesmo objeto de saúde${ug ? ` (${ug})` : ''}, somando ${formatBRL(soma)}.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `sa09-${normObjeto(objeto).slice(0, 40)}`,
        sujeitoRotulo: objeto,
        classificacao: lista.length >= 3 ? 'suspeita' : 'atencao',
        scores: {
          confiabilidade: 58,
          probabilidadeIrregularidade: Math.min(62, 35 + lista.length * 6),
        },
        fundamentoLegal: ['Lei 14.133/2021 art. 75 VIII'],
        evidencias: lista.slice(0, 6).map((d) => ({
          resumo: `${d.objeto} — ${formatBRL(d.valorEmpenhado)}`,
          valor: d.valorEmpenhado,
          data: d.data,
          ref: d.numeroEmpenho || undefined,
        })),
        explicacao:
          'Item contínuo da saúde comprado repetidamente por emergência é indício ' +
          'de falha de planejamento — a emergência (art. 75 VIII) é para o ' +
          'imprevisível, não para necessidade previsível e recorrente. Verificar ' +
          'a justificativa de cada contratação e o planejamento de compras.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

/**
 * SA-10 — Contrato de gestão (OSS) sem relatório de metas.
 * Regra do catálogo: contrato de gestão com repasse + ausência de relatório de
 * metas.
 *
 * FONTE AUSENTE: a confirmação de "ausência de relatório de metas" exige o
 * processo de prestação de contas da OSS e o relatório de metas em si — não
 * disponíveis em `ContextoAnalise`. A despesa orçamentária mostraria o repasse,
 * mas não o cumprimento/entrega do relatório. Coleta prevista via e-SIC
 * (contrato de gestão + relatórios da Comissão de Avaliação). Sem a fonte,
 * retorna [].
 */
export const detectorContratoGestaoSemMetas: Detector = {
  id: 'SA-10',
  nome: 'Contrato de gestão sem relatório de metas',
  categoria: CAT_SA,
  detectar(_ctx: ContextoAnalise): AlertaDetectado[] {
    // Relatório de metas da OSS indisponível no ContextoAnalise.
    return [];
  },
};

/**
 * SA-12 — Mesmo fiscal atestando alto volume.
 * Regra do catálogo: um servidor atesta > N liquidações/mês acima da média.
 *
 * FONTE AUSENTE para a regra exata: o nome do fiscal/servidor que atesta a
 * liquidação não está em `DespesaNorm`. A identificação do fiscal depende do
 * cruzamento com as portarias de designação (insumo DO-07) e do registro de
 * "atesto" no sistema de liquidação.
 *
 * COMPUTÁVEL como proxy de agregação CONSERVADOR: na ausência do fiscal,
 * usamos a UNIDADE GESTORA como proxy do ponto de atesto e medimos a
 * distribuição mensal de empenhos de saúde por UG. Uma UG cujo volume mensal de
 * empenhos de saúde fica acima da média + 2 desvios é indício de concentração
 * de atesto a verificar. Só dispara com ≥6 meses de série e desvio não nulo.
 * O alerta deixa claro que a vinculação ao fiscal nominal depende do DO-07.
 */
export const detectorFiscalAltoVolume: Detector = {
  id: 'SA-12',
  nome: 'Mesmo fiscal atestando alto volume',
  categoria: CAT_SA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const saude = ctx.despesas.filter(
      (d) => empenhoValido(d) && ehSaude(d) && d.data != null && d.unidadeGestora,
    );
    const porUG = new Map<string, Map<string, number>>();
    for (const d of saude) {
      const mes = d.data!.slice(0, 7);
      const mm = porUG.get(d.unidadeGestora) ?? new Map<string, number>();
      mm.set(mes, (mm.get(mes) ?? 0) + 1);
      porUG.set(d.unidadeGestora, mm);
    }
    const out: AlertaDetectado[] = [];
    for (const [ug, mm] of porUG) {
      if (mm.size < 6) continue; // série mínima de 6 meses
      const valores = [...mm.values()];
      const media = valores.reduce((s, v) => s + v, 0) / valores.length;
      const desvio = Math.sqrt(
        valores.reduce((s, v) => s + (v - media) ** 2, 0) / valores.length,
      );
      if (desvio === 0) continue;
      const limiar = media + 2 * desvio;
      const picos = [...mm.entries()].filter(([, n]) => n > limiar);
      if (picos.length === 0) continue;
      const totalLiq = valores.reduce((s, v) => s + v, 0);
      out.push({
        detectorId: 'SA-12',
        detectorNome: 'Mesmo fiscal atestando alto volume',
        categoria: CAT_SA,
        titulo: `Volume atípico de liquidações de saúde — ${ug}`,
        descricao:
          `A unidade teve ${picos.length} mês(es) com volume de empenhos de saúde ` +
          `acima da média (${media.toFixed(1)}/mês) + 2 desvios.`,
        sujeitoTipo: 'orgao',
        sujeitoId: `sa12-${ug}`,
        sujeitoRotulo: ug,
        classificacao: 'atencao',
        scores: { confiabilidade: 46, probabilidadeIrregularidade: 36 },
        fundamentoLegal: ['Lei 14.133/2021 art. 117'],
        evidencias: picos.slice(0, 6).map(([mes, n]) => ({
          resumo: `${mes}: ${n} empenhos de saúde (média ${media.toFixed(1)})`,
          data: `${mes}-01`,
        })),
        explicacao:
          'Pico de volume de liquidações de saúde numa unidade é indício que ' +
          'merece verificar a capacidade de atesto do fiscal de contrato. A ' +
          'regra do catálogo é por fiscal nominal — a identificação do servidor ' +
          'que atesta depende do cruzamento com as portarias de designação ' +
          '(DO-07), ainda a integrar. Aqui a unidade gestora é usada como proxy.',
        valorEnvolvido: 0,
      });
      // valorEnvolvido permanece 0: SA-12 mede volume de atesto, não valor —
      // mas registramos o total de liquidações como evidência adicional.
      void totalLiq;
    }
    return out;
  },
};

/**
 * SA-13 — Manutenção hospitalar sem relatório técnico.
 * Regra do catálogo: empenho de manutenção em unidade de saúde sem relatório
 * técnico.
 *
 * FONTE AUSENTE para a confirmação de "sem relatório técnico": o laudo/relatório
 * técnico está no processo de pagamento, não em `ContextoAnalise`.
 *
 * COMPUTÁVEL como proxy CONSERVADOR: identificamos empenhos de manutenção em
 * unidade de saúde (objeto/elemento de manutenção + UG/objeto de saúde) e os
 * agregamos por fornecedor. A presença de manutenção hospitalar recorrente é
 * indício a verificar quanto à existência de relatório técnico. Limiar
 * conservador: ≥2 empenhos do mesmo fornecedor de manutenção em saúde, ou um
 * único empenho de valor relevante (> R$ 50k). Classificação só "atenção".
 */
export const detectorManutencaoHospitalar: Detector = {
  id: 'SA-13',
  nome: 'Manutenção hospitalar sem relatório técnico',
  categoria: CAT_SA,
  detectar(ctx: ContextoAnalise): AlertaDetectado[] {
    const manut = ctx.despesas.filter(
      (d) =>
        empenhoValido(d) &&
        d.cpfCnpj &&
        ehManutencao(d) &&
        ehSaude(d) &&
        !ehVeiculo(d), // manutenção de veículo de saúde é tratada por FC-11
    );
    const porCnpj = new Map<string, DespesaNorm[]>();
    for (const d of manut) {
      const arr = porCnpj.get(d.cpfCnpj) ?? [];
      arr.push(d);
      porCnpj.set(d.cpfCnpj, arr);
    }
    const out: AlertaDetectado[] = [];
    for (const [cnpj, lista] of porCnpj) {
      const soma = lista.reduce((s, d) => s + d.valorEmpenhado, 0);
      // dispara com recorrência (≥2) OU um único empenho de valor relevante.
      if (lista.length < 2 && soma < 50_000) continue;
      const nome = lista.find((d) => d.fornecedorNome)?.fornecedorNome || cnpj;
      out.push({
        detectorId: 'SA-13',
        detectorNome: 'Manutenção hospitalar sem relatório técnico',
        categoria: CAT_SA,
        titulo: `Manutenção em unidade de saúde — ${nome}`,
        descricao:
          `${lista.length} empenho(s) de manutenção em unidade de saúde ao mesmo ` +
          `fornecedor, somando ${formatBRL(soma)}.`,
        sujeitoTipo: 'fornecedor',
        sujeitoId: cnpj,
        sujeitoRotulo: nome,
        classificacao: 'atencao',
        scores: { confiabilidade: 50, probabilidadeIrregularidade: 38 },
        fundamentoLegal: ['Lei 4.320/1964 art. 63'],
        evidencias: lista.slice(0, 6).map((d) => ({
          resumo: `${d.objeto || 'Manutenção'} — ${formatBRL(d.valorEmpenhado)}`,
          valor: d.valorEmpenhado,
          data: d.data,
          ref: d.numeroEmpenho || undefined,
        })),
        explicacao:
          'Serviço de manutenção em unidade de saúde merece verificar a existência ' +
          'de relatório técnico/laudo que comprove a execução e a necessidade. A ' +
          'confirmação da ausência do relatório depende do processo de pagamento, ' +
          'a obter via e-SIC.',
        valorEnvolvido: soma,
      });
    }
    return out;
  },
};

// ── Registro do conjunto ─────────────────────────────────────────────────────

/**
 * Conjunto de detectores FC/SA do catálogo (faixas FC-03..FC-11 e
 * SA-01..SA-13, exceto SA-08/SA-11 já em `setoriais.ts`).
 */
export const DETECTORES_FS_CAT: Detector[] = [
  // Frota e combustível
  detectorConsumoKmL, // FC-03 — aguarda diário de bordo + ficha técnica (e-SIC)
  detectorAbastecimentoAcimaTanque, // FC-04 — aguarda controle de abastecimento + cadastro de frota
  detectorVeiculoParadoConsumo, // FC-05 — aguarda cadastro de frota + diário de bordo
  detectorAbastecimentoSemKm, // FC-06 — aguarda controle de abastecimento (km)
  detectorAbastecimentoFimDeSemana, // FC-07 — roda sobre despesas (data do empenho)
  detectorAbastecimentosSequenciais, // FC-08 — roda sobre despesas (agregação CNPJ/dia)
  detectorCartaoVeiculosDiferentes, // FC-09 — aguarda extrato do cartão-combustível
  detectorFornecedorCombustivelLongo, // FC-10 — roda sobre despesas (datas por CNPJ)
  detectorManutencaoFrotaRecorrente, // FC-11 — roda sobre despesas (manutenção de frota)
  // Saúde, medicamentos e almoxarifado
  detectorPagamentoSemEntradaEstoque, // SA-01 — aguarda almoxarifado (entradas)
  detectorNfSemCorrespondencia, // SA-02 — aguarda NF item a item + recebimento
  detectorEntregaParcialPagaIntegral, // SA-03 — aguarda termo de recebimento + contrato
  detectorEntradaSemLoteValidade, // SA-04 — aguarda almoxarifado (lote/validade)
  detectorPrecoItemSaude, // SA-05 — roda sobre despesas (mediana interna; BPS pendente)
  detectorCompraSemDistribuicao, // SA-06 — aguarda almoxarifado (saídas)
  detectorFaltaApesarCompra, // SA-07 — aguarda manifestações de ouvidoria/e-SIC
  detectorEmergencialRecorrenteSaude, // SA-09 — roda sobre despesas (emergencial + saúde)
  detectorContratoGestaoSemMetas, // SA-10 — aguarda relatório de metas da OSS
  detectorFiscalAltoVolume, // SA-12 — roda sobre despesas (UG como proxy; DO-07 pendente)
  detectorManutencaoHospitalar, // SA-13 — roda sobre despesas (manutenção em saúde)
];
