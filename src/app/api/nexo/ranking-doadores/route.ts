/**
 * GET /api/nexo/ranking-doadores?exercicio=<ano>
 *
 * O ENTREGÁVEL CENTRAL do NEXO (plano §2.3): ranking doador ↔ político ↔
 * empresa — pessoas/empresas que DOARAM a campanhas e TAMBÉM receberam
 * empenhos/contratos da Prefeitura, ordenadas pelo `potencial =
 * min(totalDoado, totalEmpenhado)`. SEMPRE indício a apurar, jamais acusação.
 *
 * ── DERIVAÇÃO (Onda 4: materializado primeiro) ────────────────────────────────
 * O cron `onNexoCruzamentos` (functions/src/nexo/cruzamentos.ts) agora MATERIALIZA
 * `nexo_ranking_vinculo` diariamente (1 doc por fornecedor com vínculo
 * doador↔contrato). A LEITURA do usuário PREFERE esse materializado (instantâneo,
 * sempre fresco do dia) — ver `lerRankingMaterializado`. Só se ele estiver VAZIO
 * para o exercício caímos no caminho antigo (snapshot do worker e, por fim, o
 * estado honesto "compile para gerar"). O modo `?compute=1` (worker) segue
 * COMPUTANDO on-the-fly a partir das fontes, reusando o MOTOR do XS-DOADOR:
 *   • `nexo_empenhos` (exercício)  → fornecedores por CNPJ-raiz (totalEmpenhado);
 *   • `nexo_socios`                → QSA (casa sócio↔doador por chaveFraca/cpfHash);
 *   • `nexo_doacoes_tse`           → doações (docHash/chaveFraca, totalDoado).
 * O cruzamento é o de `analisarDoadorPolitico` — mas aqui agregamos por
 * fornecedor para o RANKING (não por alerta).
 *
 * ── PESO/CUSTO → SNAPSHOT ─────────────────────────────────────────────────────
 * É PESADO (lê doações TSE inteira + sócios + empenhos do ano). Por isso é um
 * tipo de SNAPSHOT (Frente E/F): o worker chama `?compute=1` (gateado), computa
 * e persiste; o GET do usuário LÊ o snapshot pronto (instantâneo). Sem snapshot,
 * o GET responde `disponivel:false` HONESTO (a página mostra "compile") — NÃO
 * dispara o cômputo pesado ao vivo na sessão do usuário.
 *
 * ── HONESTIDADE (LGPD/jurídico) ───────────────────────────────────────────────
 * Casamento sócio↔doador é PROBABILÍSTICO (nome+6 díg do CPF — único dado comum
 * às fontes), nunca determinístico. Doação de PJ é vedada desde 2015 (ADI 4650).
 * `classificacaoMax` ≤ 'atencao'. Nenhum CPF cru trafega (hash/máscara).
 */
import { NextResponse } from 'next/server';
import {
  avaliarCompute,
  sessaoLeitura,
  lerSnapshotPainel,
} from '@/lib/nexo/compute-guard';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import { normalizarEmpenhosFornecedor, mascararDoc } from '@/lib/nexo/normalizar';
import { cnpjRaiz, ehEntidadePublica, soDigitos } from '@/lib/nexo/entidades';
import { hashDoc } from '@/lib/nexo/pii';
import {
  doacoesDeDocs,
  sociosComChaveFracaDeDocs,
  type DoacaoCtx,
  type SocioCtxComChaveFraca,
} from '@/lib/nexo/detectores/doador-politico-det';

export const runtime = 'nodejs';
export const maxDuration = 300;

const headersCache = { 'Cache-Control': 'private, max-age=120' } as const;
const headersNoStore = { 'Cache-Control': 'no-store' } as const;

/** Teto de itens no ranking (payload + foco na worklist). */
const LIMITE_RANKING = 200;
/** Teto de políticos listados por item (contexto). */
const MAX_POLITICOS = 8;

type ClassificacaoMax = 'informativo' | 'atencao' | 'suspeita' | 'critico';

/** Coleção materializada pelo cron onNexoCruzamentos (Onda 4). */
const COL_RANKING_MAT = 'nexo_ranking_vinculo';

/** Uma linha do ranking — espelha o contrato consumido por `nexo/ranking/page.tsx`. */
export interface RankingItem {
  id: string;
  kind: 'empresa' | 'pessoa';
  rotulo: string;
  docMasc: string | null;
  cnpj: string | null;
  totalDoado: number;
  totalEmpenhado: number;
  /** min(totalDoado, totalEmpenhado) — a régua de ordenação. */
  potencial: number;
  politicos: string[];
  classificacaoMax: ClassificacaoMax;
  baseConfianca: string[];
}

export interface RankingDoadoresResponse {
  exercicio: number;
  /** false = ranking ainda não materializado (sem snapshot). */
  disponivel: boolean;
  motivo: string | null;
  itens: RankingItem[];
  total: number;
  atualizadoEm: string | null;
}

interface FornecedorAgg {
  raiz: string;
  cnpj: string;
  nome: string;
  valorEmpenhado: number;
}

/** Agrega empenhos por CNPJ-raiz (só PJ privada com CNPJ de 14 díg). */
function fornecedoresPorRaiz(
  empenhos: ReturnType<typeof normalizarEmpenhosFornecedor>,
): Map<string, FornecedorAgg> {
  const por = new Map<string, FornecedorAgg>();
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
 * Lê o ranking MATERIALIZADO de `nexo_ranking_vinculo` (escrito pelo cron
 * `onNexoCruzamentos`) para o exercício. Mapeia cada doc para `RankingItem`,
 * mantendo o contrato consumido por `nexo/ranking/page.tsx`. Retorna null quando
 * não há doc materializado (cai no fallback snapshot/on-the-fly). Os campos já
 * vêm prontos (potencial/totalDoado/totalEmpenhado/classificacaoMax/baseConfianca)
 * — só normalizamos tipos e re-ordenamos por potencial desc (defensivo).
 */
async function lerRankingMaterializado(
  exercicio: number,
  idToken: string,
): Promise<RankingDoadoresResponse | null> {
  const docs = await lerColecaoNexo(COL_RANKING_MAT, { exercicio }, idToken);
  if (docs.length === 0) return null;

  const itens: RankingItem[] = docs.map((d) => {
    const totalDoado = Number(d.totalDoado) || 0;
    const totalEmpenhado = Number(d.totalEmpenhado) || 0;
    const cnpj = d.cnpj != null ? String(d.cnpj) : null;
    const cls = String(d.classificacaoMax ?? 'atencao');
    return {
      id: String(d._docId ?? `vinc:${cnpj ?? ''}`),
      kind: d.kind === 'pessoa' ? 'pessoa' : 'empresa',
      rotulo: String(d.rotulo ?? cnpj ?? ''),
      docMasc: d.docMasc != null ? String(d.docMasc) : cnpj ? mascararDoc(cnpj) : null,
      cnpj,
      totalDoado,
      totalEmpenhado,
      potencial:
        d.potencial != null ? Number(d.potencial) : Math.min(totalDoado, totalEmpenhado),
      politicos: Array.isArray(d.politicos) ? d.politicos.map(String).slice(0, MAX_POLITICOS) : [],
      classificacaoMax: (cls === 'informativo' || cls === 'atencao' || cls === 'suspeita' || cls === 'critico'
        ? cls
        : 'atencao') as ClassificacaoMax,
      baseConfianca: Array.isArray(d.baseConfianca) ? d.baseConfianca.map(String) : [],
    };
  });

  itens.sort((a, b) => b.potencial - a.potencial || b.totalEmpenhado - a.totalEmpenhado);

  return {
    exercicio,
    disponivel: true,
    motivo: null,
    itens: itens.slice(0, LIMITE_RANKING),
    total: itens.length,
    atualizadoEm: new Date().toISOString(),
  };
}

/**
 * NÚCLEO de cômputo do ranking. Cruza fornecedores (empenhos do ano) × doações
 * TSE × sócios (QSA), agregando por fornecedor. Devolve as linhas ordenadas por
 * potencial desc. Mesma honestidade do XS-DOADOR (forte = hash de doc; fraca =
 * chaveFraca nome+cpf6). Não acessa `Request`.
 */
async function computarRanking(
  exercicio: number,
  idToken: string,
): Promise<RankingDoadoresResponse> {
  // Fontes (degradação honesta: doações/sócios podem estar vazios).
  const [docsEmp, docsDoacoes, docsSocios] = await Promise.all([
    lerColecaoNexo('nexo_empenhos', { exercicio, fonte: 'empenhos' }, idToken),
    lerColecaoNexo('nexo_doacoes_tse', {}, idToken, [
      'docHashDoador', 'docMasc', 'nomeDoador', 'candidato', 'cargo', 'ano',
      'valor', 'chaveFraca',
    ]).catch(() => [] as Record<string, unknown>[]),
    lerColecaoNexo('nexo_socios', {}, idToken, [
      '_cnpj', 'cnpj', 'cnpjRaiz', 'razaoSocial', 'socios',
    ]).catch(() => [] as Record<string, unknown>[]),
  ]);

  const empenhos = normalizarEmpenhosFornecedor(docsEmp, exercicio);
  const doacoes: DoacaoCtx[] = doacoesDeDocs(docsDoacoes);
  const socios: SocioCtxComChaveFraca[] = sociosComChaveFracaDeDocs(docsSocios);

  const fornecedores = fornecedoresPorRaiz(empenhos);

  // Sem doações OU sem fornecedores → ranking VAZIO honesto (não é erro).
  if (doacoes.length === 0 || fornecedores.size === 0) {
    return {
      exercicio,
      disponivel: true,
      motivo:
        doacoes.length === 0
          ? 'Sem doações eleitorais ingeridas (nexo_doacoes_tse vazio) — o ' +
            'cruzamento doador↔fornecedor fica inativo. Não é ausência de vínculo: ' +
            'é a base de doações que ainda não foi carregada para o período.'
          : 'Sem fornecedores com CNPJ nos empenhos deste exercício (nexo_empenhos ' +
            'vazio/sem CNPJ). O ranking depende de empenhos a pessoa jurídica.',
      itens: [],
      total: 0,
      atualizadoEm: new Date().toISOString(),
    };
  }

  // Índices de doação por hash de documento e por chaveFraca (probabilística).
  const doacoesPorHash = new Map<string, DoacaoCtx[]>();
  const doacoesPorChaveFraca = new Map<string, DoacaoCtx[]>();
  const indexar = (m: Map<string, DoacaoCtx[]>, k: string, d: DoacaoCtx) => {
    const arr = m.get(k);
    if (arr) arr.push(d);
    else m.set(k, [d]);
  };
  for (const d of doacoes) {
    const h = (d.docHash ?? '').trim();
    if (h) indexar(doacoesPorHash, h, d);
    const cf = (d.chaveFraca ?? '').trim();
    if (cf) indexar(doacoesPorChaveFraca, cf, d);
  }

  // Sócios por raiz (só os que são fornecedores/privados).
  const sociosPorRaiz = new Map<string, SocioCtxComChaveFraca['socios']>();
  for (const sc of socios) {
    const raiz =
      soDigitos(sc.cnpjRaiz).length === 8 ? soDigitos(sc.cnpjRaiz) : cnpjRaiz(soDigitos(sc.cnpj));
    if (!fornecedores.has(raiz)) continue;
    if (ehEntidadePublica(sc.cnpj, sc.razaoSocial)) continue;
    const cur = sociosPorRaiz.get(raiz);
    if (cur) cur.push(...sc.socios);
    else sociosPorRaiz.set(raiz, [...sc.socios]);
  }

  const itens: RankingItem[] = [];
  for (const [raiz, f] of fornecedores) {
    const vistos = new Set<DoacaoCtx>();
    const matches: { doacao: DoacaoCtx; confianca: 'forte' | 'fraca' }[] = [];

    // (1) A própria empresa doou? (hash do CNPJ == docHash) → FORTE.
    const hashCnpj = (hashDoc(f.cnpj) ?? '').trim();
    if (hashCnpj) {
      for (const d of doacoesPorHash.get(hashCnpj) ?? []) {
        if (vistos.has(d)) continue;
        vistos.add(d);
        matches.push({ doacao: d, confianca: 'forte' });
      }
    }
    // (2) Algum sócio doou? (cpfHash → FORTE; chaveFraca → FRACA probabilística).
    for (const p of sociosPorRaiz.get(raiz) ?? []) {
      const hash = (p.cpfHash ?? '').trim();
      if (hash) {
        for (const d of doacoesPorHash.get(hash) ?? []) {
          if (vistos.has(d)) continue;
          vistos.add(d);
          matches.push({ doacao: d, confianca: 'forte' });
        }
      }
      const cf = (p.chaveFraca ?? '').trim();
      if (cf) {
        for (const d of doacoesPorChaveFraca.get(cf) ?? []) {
          if (vistos.has(d)) continue;
          vistos.add(d);
          matches.push({ doacao: d, confianca: 'fraca' });
        }
      }
    }

    if (matches.length === 0) continue;

    const totalDoado = matches.reduce((s, m) => s + (m.doacao.valor ?? 0), 0);
    const totalEmpenhado = f.valorEmpenhado;
    const soFraca = matches.every((m) => m.confianca === 'fraca');
    const politicos = Array.from(
      new Set(matches.map((m) => m.doacao.candidato).filter(Boolean)),
    ).slice(0, MAX_POLITICOS);
    const baseConfianca = Array.from(
      new Set(matches.map((m) => (m.confianca === 'forte' ? 'hash-documento' : 'nome+cpf6'))),
    );

    itens.push({
      id: `raiz:${raiz}`,
      kind: 'empresa',
      rotulo: f.nome || f.cnpj,
      docMasc: mascararDoc(f.cnpj),
      cnpj: f.cnpj,
      totalDoado,
      totalEmpenhado,
      // Potencial = min(doado, empenhado): aproxima "quanto do dinheiro público
      // pode ter ido a quem financiou a campanha". Indício a apurar.
      potencial: Math.min(totalDoado, totalEmpenhado),
      politicos,
      // Teto OBRIGATÓRIO: doação é lícita. Vínculo só-probabilístico (fraca)
      // rebaixa para 'informativo' (homonímia/colisão dos 6 díg não sustenta 'atencao').
      classificacaoMax: soFraca ? 'informativo' : 'atencao',
      baseConfianca,
    });
  }

  itens.sort((a, b) => b.potencial - a.potencial || b.totalEmpenhado - a.totalEmpenhado);
  const total = itens.length;

  return {
    exercicio,
    disponivel: true,
    motivo:
      total === 0
        ? 'Nenhum fornecedor casou como doador (nem a empresa nem seus sócios ' +
          'constam na base de doações TSE ingerida). Ausência aqui não é prova de nada.'
        : null,
    itens: itens.slice(0, LIMITE_RANKING),
    total,
    atualizadoEm: new Date().toISOString(),
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const exercicio =
    Math.trunc(Number(searchParams.get('exercicio'))) || new Date().getFullYear();

  // ── MODO COMPUTE (worker) ────────────────────────────────────────────────────
  const compute = avaliarCompute(req);
  if (compute.modo === 'negado') {
    return NextResponse.json({ erro: compute.erro }, { status: compute.status, headers: headersNoStore });
  }
  if (compute.modo === 'compute') {
    try {
      const payload = await computarRanking(exercicio, compute.idToken);
      return NextResponse.json(payload, { headers: headersNoStore });
    } catch (err) {
      return NextResponse.json(
        { erro: err instanceof Error ? err.message : 'erro ao computar ranking' },
        { status: 502, headers: headersNoStore },
      );
    }
  }

  // ── MODO LEITURA (usuário) ───────────────────────────────────────────────────
  const sessao = await sessaoLeitura(req);
  if (!sessao.ok || !sessao.idToken) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: headersNoStore },
    );
  }
  const idToken = sessao.idToken;

  // Onda 4: PREFERE o ranking MATERIALIZADO pelo cron onNexoCruzamentos
  // (instantâneo, fresco do dia). Só se vazio cai no snapshot do worker e, por
  // fim, no estado honesto "compile para gerar".
  try {
    const mat = await lerRankingMaterializado(exercicio, idToken);
    if (mat) return NextResponse.json(mat, { headers: headersCache });
  } catch {
    /* falha ao ler materializado — tenta o snapshot abaixo */
  }

  // Snapshot-first (fallback). O ranking é PESADO; sem snapshot pronto, NÃO
  // computamos ao vivo na sessão do usuário — devolvemos estado honesto.
  try {
    const snap = await lerSnapshotPainel('ranking', '', exercicio, idToken, sessao.uid ?? undefined);
    if (snap) return NextResponse.json(snap.payload, { headers: headersCache });
  } catch {
    /* falha ao ler snapshot — cai no estado "em compilação" abaixo */
  }

  const vazio: RankingDoadoresResponse = {
    exercicio,
    disponivel: false,
    motivo:
      'O ranking doador↔contrato ainda não foi materializado para este exercício. ' +
      'É um cruzamento pesado (doações TSE × sócios × empenhos) servido por ' +
      'snapshot: use Compilar para enfileirar; quando o worker concluir, esta ' +
      'tela passa a listar os vínculos automaticamente.',
    itens: [],
    total: 0,
    atualizadoEm: null,
  };
  return NextResponse.json(vazio, { headers: headersCache });
}
