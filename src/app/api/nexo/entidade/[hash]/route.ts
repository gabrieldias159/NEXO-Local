/**
 * GET /api/nexo/entidade/[hash]
 *
 * PRÉVIA do entity-chip universal. Recebe o HASH irreversível do documento
 * (`hashDoc(CNPJ|CPF)`) — **NUNCA o número cru na URL** (a URL vaza para logs de
 * proxy/Cloud Run/referer; ver §5.2 do design, "CPF NUNCA na URL"). Resolve a
 * identidade canônica lendo a projeção PRÉ-COMPUTADA `nexo_entidades` (gravada
 * pelo cron `onNexoPerfilEntidades`) — leitura O(1) de coleção já ingerida, NÃO
 * bate em API externa ao vivo.
 *
 * Devolve, para o HoverCard: razão social, badge de sanção, presença de
 * contrato ativo (vínculo vivo proxy), total faturado, nº de empenhos/contratos
 * e as top-flags. Documento sempre MASCARADO (`mascararDoc`/`mascararNome`).
 *
 * ── LGPD / fiscalização interna (LAI) ────────────────────────────────────────
 *  • CPF/RG NUNCA trafegam crus na URL/query — o drill-down usa o HASH
 *    irreversível, jamais o número. Esse é o guardrail que PERMANECE.
 *  • Sendo sistema INTERNO (gated a usuário ativo) sobre dados PÚBLICOS de
 *    transparência, a prévia traz os MESMOS agregados para pessoa física e
 *    jurídica (faturamento/empenhos/contratos/sanção/flags). Não há mais
 *    "efeito mosaico" para PF na prévia — é indício a apurar, nunca acusação.
 *  • Gancho de PAPEL: só `admin` (claim `isAdmin` no perfil `/users/{uid}`) vê o
 *    documento por extenso NESTE campo `documento`; o DEFAULT aqui é mascarado.
 *    A EXIBIÇÃO completa do chip é decisão do cliente (que detém a forma
 *    original). O papel granular (leitor/analista/chefe) ainda não existe na
 *    sessão (ver §11/§14.1) — quando existir, refina aqui.
 *
 * ── HONESTIDADE ──────────────────────────────────────────────────────────────
 * Distingue "sem registro" (hash não casou nenhum perfil) de "coleta inativa"
 * (coleção `nexo_entidades` vazia/indisponível). Resposta uniforme em forma para
 * os dois casos (não vira oráculo de enumeração — §5.2 ressalva b).
 *
 * `Cache-Control: no-store` SEMPRE (§5.2 ressalva c). Runtime nodejs.
 */
import { NextResponse } from 'next/server';
import { verificarSessao } from '@/lib/nexo/auth-server';
import { lerColecaoNexo } from '@/lib/nexo/firestore-read';
import { hashDoc } from '@/lib/nexo/pii';
import { mascararDoc, mascararNome } from '@/lib/nexo/normalizar';
import { ehEntidadePublica, soDigitos } from '@/lib/nexo/entidades';
import { firestoreDocumentsBase } from '@/lib/nexo/emulator-endpoints';

export const runtime = 'nodejs';

const FIRESTORE_BASE = firestoreDocumentsBase();

const headersNoStore = { 'Cache-Control': 'no-store' } as const;

/** TTL do cache de módulo de `nexo_entidades` (5 min — espelha o dossiê). */
const TTL_MS = 5 * 60 * 1000;

/**
 * Campos projetados de `nexo_entidades` (`select` do `:runQuery`) — só os que
 * `montarPrevia` lê. Reduz o payload por hover; `_docId` continua exposto pelo
 * `name` mesmo fora da projeção.
 */
const CAMPOS_PREVIA = [
  'doc', 'cnpj', 'cpf', 'tipo', 'nome', 'flags', '_id',
  'totalEmpenhado', 'nEmpenhos', 'nContratos', 'contratosAtivos',
  'sancionado', 'nSancoes',
];

/**
 * Cache de MÓDULO da projeção `nexo_entidades` (P1-E do plano). O entity-chip
 * dispara um GET/POST por hover: telas com dezenas de chips reliam a coleção
 * INTEIRA + `hashDoc` linear a cada passada do mouse. O cache (Map único +
 * TTL 5min) faz a coleção ser lida 1x por janela e compartilhada entre todos os
 * hovers — o casamento por hash continua por-request (não cacheia o resultado da
 * busca, só os perfis). Espelha `risco`/`empenhos` (que já cacheiam).
 */
interface CacheEntidades {
  itens: Record<string, unknown>[];
  ts: number;
}
let cacheEntidades: CacheEntidades | null = null;

async function obterEntidades(idToken: string): Promise<Record<string, unknown>[]> {
  const agora = Date.now();
  if (cacheEntidades && agora - cacheEntidades.ts < TTL_MS) return cacheEntidades.itens;
  const itens = await lerColecaoNexo('nexo_entidades', {}, idToken, CAMPOS_PREVIA);
  cacheEntidades = { itens, ts: agora };
  return itens;
}

/** Tipo da entidade resolvida — espelha `nexo_entidades.tipo`. */
type TipoEntidade = 'empresa' | 'pessoa' | 'orgao';

/**
 * Prévia devolvida ao HoverCard. `documento` é SEMPRE a forma de exibição neste
 * campo (mascarada por padrão; completa só p/ admin). Os agregados
 * (`totalEmpenhado`, `nContratos`, `flags`) vêm preenchidos tanto para pessoa
 * jurídica quanto física (fiscalização interna sobre dado público).
 * `disponivel=false` em "sem registro" e "coleta inativa", distinguidos pelo
 * `motivo`.
 */
interface PreviaEntidade {
  /** Identidade canônica (`_id` de nexo_entidades): CNPJ-raiz | CPF | rótulo. */
  idCanonico: string | null;
  tipo: TipoEntidade | null;
  nome: string;
  /** Documento para EXIBIR — mascarado por padrão; completo só sob papel admin. */
  documento: string;
  /** true quando o doc resolvido é de pessoa física (prévia reduzida — LGPD). */
  pessoaFisica: boolean;
  ehEntidadePublica: boolean;
  /** Agregados reais da entidade (preenchidos p/ PF e PJ; null se ausentes). */
  totalEmpenhado: number | null;
  nEmpenhos: number | null;
  nContratos: number | null;
  /** Proxy de "vínculo vivo": tem contrato municipal vigente hoje. */
  contratoAtivo: boolean | null;
  sancionado: boolean;
  nSancoes: number;
  /** Top flags do perfil (`sancionado`, `acima-limite`, `contrato-ativo`, …). */
  flags: string[];
  disponivel: boolean;
  motivo: string | null;
  /** true só quando o consumidor é admin e o documento saiu por extenso. */
  documentoCompleto: boolean;
  atualizadoEm: string;
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function digits(v: unknown): string {
  return soDigitos(str(v));
}

function ok(body: PreviaEntidade): NextResponse {
  return NextResponse.json(body, { status: 200, headers: headersNoStore });
}

/**
 * Resposta uniforme de "nada resolvido" (sem registro OU coleta inativa) — mesma
 * FORMA para não virar oráculo de enumeração; só o `motivo` muda. Não revela o
 * documento (não temos como, e nem queremos — o hash é irreversível).
 */
function previaVazia(motivo: string): PreviaEntidade {
  return {
    idCanonico: null,
    tipo: null,
    nome: '',
    documento: '',
    pessoaFisica: false,
    ehEntidadePublica: false,
    totalEmpenhado: null,
    nEmpenhos: null,
    nContratos: null,
    contratoAtivo: null,
    sancionado: false,
    nSancoes: 0,
    flags: [],
    disponivel: false,
    motivo,
    documentoCompleto: false,
    atualizadoEm: new Date().toISOString(),
  };
}

/**
 * Gancho de PAPEL — lê `isAdmin` do perfil `/users/{uid}` (mesmo mecanismo de
 * custom claim que o resto do projeto usa). DEFAULT mascarado: qualquer falha,
 * ausência do campo ou usuário não-admin ⇒ `false`. Não derruba a rota — a
 * prévia mascarada é o caminho seguro.
 */
async function ehAdmin(uid: string, idToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${FIRESTORE_BASE}/users/${uid}`, {
      headers: { Authorization: `Bearer ${idToken}` },
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const doc = (await res.json()) as {
      fields?: {
        isAdmin?: { booleanValue?: boolean };
        role?: { stringValue?: string };
      };
    };
    const admin = doc.fields?.isAdmin?.booleanValue === true;
    const role = doc.fields?.role?.stringValue ?? '';
    return admin || role === 'admin' || role === 'chefe';
  } catch {
    return false;
  }
}

/** CNPJ por extenso (sem máscara) — só para o caminho admin de pessoa jurídica. */
function cnpjPorExtenso(d: string): string {
  if (d.length !== 14) return mascararDoc(d);
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** CPF por extenso — só admin (LGPD: caminho explícito, nunca o default). */
function cpfPorExtenso(d: string): string {
  if (d.length !== 11) return mascararDoc(d);
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/**
 * Núcleo compartilhado: dado o HASH alvo, lê a projeção, casa o perfil e monta a
 * prévia mascarada (com gancho de papel). Usado pelo GET (hash na rota) e pelo
 * POST (hash derivado do doc no corpo). Resolução hash→doc é SÓ aqui, server.
 */
async function montarPrevia(
  alvo: string,
  uid: string,
  idToken: string,
): Promise<PreviaEntidade> {
  // hashDoc => sha256 hex (64 chars [0-9a-f]). Forma inválida = sem registro
  // honesto (e blinda contra alguém tentar passar o CPF cru aqui).
  if (!/^[0-9a-f]{64}$/.test(alvo)) {
    return previaVazia(
      'Identificador inválido. Esta rota recebe o hash do documento, nunca o ' +
        'número — o CPF/CNPJ não trafega na URL (LGPD).',
    );
  }

  // Lê a projeção canônica (do cache de módulo, 1x/~5min) e casa o HASH contra
  // `hashDoc(doc)` de cada perfil. O cache evita reler a coleção por hover.
  let perfis: Record<string, unknown>[];
  try {
    perfis = await obterEntidades(idToken);
  } catch {
    return previaVazia(
      'A projeção de entidades (nexo_entidades) não está disponível no ' +
        'momento. O cron de perfis (onNexoPerfilEntidades) pode não ter rodado ' +
        'ainda — prévia indisponível, sem inventar dado.',
    );
  }
  if (perfis.length === 0) {
    return previaVazia(
      'A projeção de entidades (nexo_entidades) está vazia: o cron de perfis ' +
        'ainda não produziu perfis. Prévia indisponível por coleta inativa.',
    );
  }

  const perfil = perfis.find((e) => {
    const d = digits(e.doc ?? e.cnpj ?? e.cpf);
    return d ? hashDoc(d) === alvo : false;
  });
  if (!perfil) {
    return previaVazia(
      'Nenhuma entidade ingerida casa este documento. Pode ser que a coleta ' +
        'ainda não tenha processado a entidade, ou que ela não tenha ' +
        'movimentação na base da Prefeitura.',
    );
  }

  const docDigits = digits(perfil.doc ?? perfil.cnpj ?? perfil.cpf);
  const pessoaFisica = docDigits.length === 11 || str(perfil.tipo) === 'pessoa';
  const nomeCru = str(perfil.nome);
  const admin = await ehAdmin(uid, idToken);

  // Documento de exibição: mascarado por DEFAULT; por extenso só p/ admin.
  let documento: string;
  if (admin) {
    documento = pessoaFisica ? cpfPorExtenso(docDigits) : cnpjPorExtenso(docDigits);
  } else {
    documento = mascararDoc(docDigits);
  }
  // Nome de pessoa física sempre mascarado p/ não-admin (minimização).
  const nome = pessoaFisica && !admin ? mascararNome(nomeCru) : nomeCru;

  const flags = Array.isArray(perfil.flags)
    ? (perfil.flags as unknown[]).map(str).filter(Boolean).slice(0, 5)
    : [];
  const tipo = (str(perfil.tipo) || null) as TipoEntidade | null;

  // Sistema INTERNO de fiscalização (LAI), gated a usuário ativo, sobre dados
  // PÚBLICOS de transparência: a prévia traz os MESMOS agregados para pessoa
  // física e jurídica (faturamento/empenhos/contratos/flags). O guardrail que
  // PERMANECE é o número: o CPF nunca trafega na URL/query — o drill-down usa o
  // HASH irreversível, não o número (o `documento` exibido segue mascarado por
  // default; só admin o vê por extenso na prévia — a EXIBIÇÃO completa do chip é
  // decisão do cliente, que detém a forma original).

  return {
    idCanonico: str(perfil._id) || null,
    tipo,
    nome,
    documento,
    pessoaFisica,
    ehEntidadePublica: ehEntidadePublica(docDigits, nomeCru),
    totalEmpenhado: num(perfil.totalEmpenhado),
    nEmpenhos: num(perfil.nEmpenhos),
    nContratos: num(perfil.nContratos),
    contratoAtivo: (num(perfil.contratosAtivos) ?? 0) > 0,
    sancionado: perfil.sancionado === true,
    nSancoes: num(perfil.nSancoes) ?? 0,
    flags,
    disponivel: true,
    motivo: null,
    documentoCompleto: admin,
    atualizadoEm: new Date().toISOString(),
  };
}

/**
 * GET por HASH na rota — o caminho canônico do drill-down (`/api/nexo/entidade/
 * <hash>`). O número nunca aparece na URL: só o hash irreversível.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ hash: string }> },
) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken || !sessao.uid) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: headersNoStore },
    );
  }
  const { idToken, uid } = sessao;
  const { hash } = await ctx.params;
  return ok(await montarPrevia((hash ?? '').trim().toLowerCase(), uid, idToken));
}

/**
 * POST com o documento CRU no CORPO (nunca na URL) — usado pelo entity-chip do
 * browser, que NÃO consegue computar o hash (depende do segredo `NEXO_PII_SALT`
 * server-side). O servidor hasheia, resolve a prévia e devolve TAMBÉM o `hash`
 * para o chip montar o deep-link do drill-down. O corpo (doc cru) não é logado
 * em proxy/referer como a query-string seria — atende ao guardrail "CPF nunca
 * na URL" sem precisar do salt no cliente.
 */
export async function POST(req: Request) {
  const sessao = await verificarSessao(req);
  if (!sessao.ok || !sessao.idToken || !sessao.uid) {
    return NextResponse.json(
      { erro: 'acesso negado ao NEXO' },
      { status: sessao.status, headers: headersNoStore },
    );
  }
  const { idToken, uid } = sessao;

  let docDigits = '';
  try {
    const body = (await req.json()) as { doc?: unknown };
    docDigits = soDigitos(str(body?.doc));
  } catch {
    /* corpo inválido — cai no caminho de doc vazio abaixo */
  }
  if (docDigits.length !== 11 && docDigits.length !== 14) {
    return NextResponse.json(
      { ...previaVazia('Documento ausente ou de tamanho inválido no corpo.'), hash: null },
      { status: 200, headers: headersNoStore },
    );
  }

  const alvo = hashDoc(docDigits);
  const previa = await montarPrevia(alvo, uid, idToken);
  // Devolve o hash p/ o chip montar `/nexo/busca?tipo=entidade&doc=<hash>` ou
  // `/api/nexo/entidade/<hash>` — o número nunca sai daqui (a não ser, mascarado
  // ou — só admin — por extenso, dentro da própria prévia).
  return NextResponse.json(
    { ...previa, hash: alvo },
    { status: 200, headers: headersNoStore },
  );
}
