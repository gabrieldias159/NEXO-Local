/**
 * Detectores sobre contratos do PNCP.
 *
 *  LC-19 — Aditivo acima do limite (em `aditivo.ts`).
 *  FR-01 — Concentração de contratos num fornecedor.
 *
 * `analisarContratos` é o runner usado pela rota /api/nexo/contratos.
 *
 * NOTA DE NUMERAÇÃO: este arquivo emitia antes `LC-08`/`LC-09`, mas esses IDs
 * do catálogo são "Único habilitado" e "Baixa competitividade crônica" —
 * regras que dependem da contagem de licitantes por certame, não computáveis
 * a partir só da lista de contratos. A regra de concentração de contratos por
 * fornecedor é o catálogo `FR-01`. O antigo `detectarValorAtipico` (que emitia
 * `LC-09`) foi removido: "contrato de valor atípico" por desvio da mediana de
 * VALOR TOTAL não corresponde a nenhum ID do catálogo — o LC-25 (sobrepreço)
 * é por PREÇO UNITÁRIO de item, dado que a lista de contratos não traz.
 */
import { detectarAditivos } from './aditivo';
import { formatBRL, type ContratoNorm } from '../normalizar';
import type { AlertaDetectado } from './tipos';

/** Catálogo FR-01: um fornecedor concentra fatia anormal dos contratos. */
const LIMIAR_CONCENTRACAO = 0.2;

/**
 * FR-01 — Concentração de contratos num fornecedor.
 *
 * Catálogo: um CNPJ (raiz) concentra > 20% do valor de contratos ativos.
 * Lei 14.133/2021 art. 11 — a competitividade evita a dependência de um único
 * fornecedor. Conservador: só dispara com base de contratos suficiente e
 * sempre como indício a apurar, nunca como acusação.
 */
function detectarConcentracao(contratos: ContratoNorm[]): AlertaDetectado[] {
  const out: AlertaDetectado[] = [];
  const valido = contratos.filter((c) => c.fornecedorDoc && c.valorGlobal > 0);
  if (valido.length < 5) return [];

  const totalCarteira = valido.reduce((s, c) => s + c.valorGlobal, 0);
  if (totalCarteira <= 0) return [];

  // Agrupa por raiz de CNPJ (8 primeiros dígitos) — matriz/filiais juntas.
  const porRaiz = new Map<string, ContratoNorm[]>();
  for (const c of valido) {
    const raiz = c.fornecedorDoc.replace(/\D/g, '').slice(0, 8) || c.fornecedorDoc;
    const arr = porRaiz.get(raiz) ?? [];
    arr.push(c);
    porRaiz.set(raiz, arr);
  }

  for (const [raiz, lista] of porRaiz) {
    const total = lista.reduce((s, c) => s + c.valorGlobal, 0);
    const fatia = total / totalCarteira;
    if (fatia <= LIMIAR_CONCENTRACAO) continue;

    const pct = fatia * 100;
    const nome = lista.find((c) => c.fornecedorNome)?.fornecedorNome || raiz;
    out.push({
      detectorId: 'FR-01',
      detectorNome: 'Concentração de contratos',
      categoria: 'Fornecedores',
      titulo: `Fornecedor concentra ${pct.toFixed(0)}% dos contratos — ${nome}`,
      descricao:
        `${lista.length} contrato(s) para o mesmo fornecedor, somando ` +
        `${formatBRL(total)} — ${pct.toFixed(1)}% do valor total de contratos do ` +
        `período. Possível indício a apurar.`,
      sujeitoTipo: 'fornecedor',
      sujeitoId: raiz,
      sujeitoRotulo: nome,
      classificacao: fatia >= 0.4 ? 'suspeita' : 'atencao',
      scores: {
        confiabilidade: 70,
        probabilidadeIrregularidade: Math.min(74, 36 + Math.round(pct)),
      },
      fundamentoLegal: ['Lei 14.133/2021, art. 11'],
      evidencias: lista.slice(0, 8).map((c) => ({
        resumo: `Contrato ${c.numeroContrato || c.id} — ${formatBRL(c.valorGlobal)}`,
        valor: c.valorGlobal,
      })),
      explicacao:
        `O fornecedor concentra ${pct.toFixed(1)}% do valor de contratos do ` +
        `período. Concentração não é irregularidade, mas uma fatia anormal é ` +
        `possível indício a apurar — convém verificar a competitividade das ` +
        `contratações e se há objetos que deveriam ter sido licitados de forma ` +
        `a ampliar a disputa (Lei 14.133/2021 art. 11).`,
      valorEnvolvido: total,
    });
  }
  return out;
}

/** Runner — roda todos os detectores de contratos do PNCP. */
export function analisarContratos(contratos: ContratoNorm[]): AlertaDetectado[] {
  return [
    ...detectarAditivos(contratos),
    ...detectarConcentracao(contratos),
  ].sort((a, b) => b.valorEnvolvido - a.valorEnvolvido);
}
