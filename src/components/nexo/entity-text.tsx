'use client';

/**
 * NEXO — Entity-text / entity-chip universal.
 *
 * Recebe TEXTO livre e o renderiza VERBATIM, mas transforma cada CNPJ/CPF VÁLIDO
 * (detecção pura em `entity-detect.ts`) num CHIP investigável: hover/clique abre
 * uma PRÉVIA (razão social, sanção, vínculo vivo, total faturado) e o clique
 * navega para o subprograma da entidade (raio-x da busca / enriquecimento de
 * CNPJ). É a superfície que torna qualquer documento na tela um ponto de entrada
 * — pipeline DETECÇÃO → PRÉVIA → DRILL-DOWN (§5 do design).
 *
 * ── GUARDRAILS (fiscalização interna / LAI; gated a usuário ativo) ────────────
 *  • RG: `entity-detect` só DESTACA (nunca resolve). Aqui o RG é renderizado
 *    neutro/sublinhado, JAMAIS clicável e SEM prévia. Não vira entidade.
 *  • CPF (pessoa física, dado público de transparência): chip PLENO — EXIBE o
 *    CPF completo (dd d.ddd.ddd-dd) e a prévia traz os mesmos agregados do CNPJ.
 *    O guardrail que PERMANECE é a URL: o número CRU nunca entra na URL/query —
 *    o drill-down usa o HASH irreversível (ver "CPF NUNCA NA URL").
 *  • CNPJ (pessoa jurídica, dado público): chip pleno — prévia com agregados +
 *    deep-link ao enriquecimento `/nexo/fornecedores/<cnpj>`.
 *
 * ── CPF NUNCA NA URL ──────────────────────────────────────────────────────────
 * O browser NÃO consegue computar `hashDoc` (depende do segredo `NEXO_PII_SALT`,
 * server-side). Por isso a prévia é resolvida por `POST /api/nexo/entidade/<hash>`
 * com o doc no CORPO (não na query-string → não vaza em logs/referer). O servidor
 * devolve a prévia + o `hash`; o drill-down do CPF usa o HASH, nunca o número.
 *
 * ── DESEMPENHO ───────────────────────────────────────────────────────────────
 * `EntityProvider` (opt-in por rota) instrumenta o rollout gradual. A prévia tem
 * cache em memória + dedupe por doc (uma requisição por documento, compartilhada
 * entre todos os chips iguais na tela). Hover-intent com debounce (~140ms) para
 * não disparar fetch em passagem rápida do mouse.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import {
  Building2,
  User,
  Landmark,
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  ExternalLink,
  ScanSearch,
  TriangleAlert,
  Loader2,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import {
  detectarEntidades,
  type SegmentoEntidade,
} from '@/lib/nexo/entity-detect';

// ── Tipos da prévia (espelham PreviaEntidade da rota) ─────────────────────────

export interface PreviaEntidade {
  idCanonico: string | null;
  tipo: 'empresa' | 'pessoa' | 'orgao' | null;
  nome: string;
  documento: string;
  pessoaFisica: boolean;
  ehEntidadePublica: boolean;
  totalEmpenhado: number | null;
  nEmpenhos: number | null;
  nContratos: number | null;
  contratoAtivo: boolean | null;
  sancionado: boolean;
  nSancoes: number;
  flags: string[];
  disponivel: boolean;
  motivo: string | null;
  documentoCompleto: boolean;
  atualizadoEm: string;
  /** Hash do doc devolvido pelo POST — base do deep-link (nunca o número). */
  hash: string | null;
}

type EstadoPrevia =
  | { status: 'carregando' }
  | { status: 'ok'; previa: PreviaEntidade }
  | { status: 'erro'; mensagem: string };

// ── Cache + dedupe por documento (compartilhado entre chips) ──────────────────
// Uma requisição por doc; o resultado fica em memória pela vida da página. Como
// a prévia é leitura de projeção (muda no máximo 1x/dia), cache de sessão basta.

const cachePrevia = new Map<string, PreviaEntidade>();
const emVoo = new Map<string, Promise<PreviaEntidade>>();

async function resolverPrevia(docDigits: string): Promise<PreviaEntidade> {
  const cacheado = cachePrevia.get(docDigits);
  if (cacheado) return cacheado;
  const jaVoando = emVoo.get(docDigits);
  if (jaVoando) return jaVoando;

  const p = (async () => {
    // POST com o doc no CORPO (CPF nunca na URL). `[hash]` é placeholder na
    // rota POST — só o GET usa o segmento; o servidor hasheia o corpo.
    const res = await nexoFetch('/api/nexo/entidade/resolver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: docDigits }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const previa = (await res.json()) as PreviaEntidade;
    cachePrevia.set(docDigits, previa);
    return previa;
  })();
  emVoo.set(docDigits, p);
  try {
    return await p;
  } finally {
    emVoo.delete(docDigits);
  }
}

/** Hook de prévia: lazy (só dispara quando `ativo`), dedupado, cacheado. */
function useEntidadePreview(docDigits: string, ativo: boolean): EstadoPrevia {
  const [estado, setEstado] = useState<EstadoPrevia>(() => {
    const c = cachePrevia.get(docDigits);
    return c ? { status: 'ok', previa: c } : { status: 'carregando' };
  });

  useEffect(() => {
    if (!ativo) return;
    const c = cachePrevia.get(docDigits);
    if (c) {
      setEstado({ status: 'ok', previa: c });
      return;
    }
    let vivo = true;
    setEstado({ status: 'carregando' });
    resolverPrevia(docDigits)
      .then((previa) => {
        if (vivo) setEstado({ status: 'ok', previa });
      })
      .catch((err) => {
        if (vivo)
          setEstado({
            status: 'erro',
            mensagem: err instanceof Error ? err.message : 'erro desconhecido',
          });
      });
    return () => {
      vivo = false;
    };
  }, [docDigits, ativo]);

  return estado;
}

// ── Provider opt-in por rota (rollout gradual) ────────────────────────────────

interface EntityCtx {
  /** Liga/desliga a instrumentação do entity-chip na subárvore. */
  habilitado: boolean;
}

const EntityContext = createContext<EntityCtx>({ habilitado: true });

/**
 * Envolve uma subárvore para habilitar (ou suspender) os chips do entity-text.
 * Útil para rollout gradual: telas onde o chip ainda não foi validado passam
 * `habilitado={false}` e o `<EntityText>` cai no texto puro.
 */
export function EntityProvider({
  habilitado = true,
  children,
}: {
  habilitado?: boolean;
  children: React.ReactNode;
}) {
  const valor = useMemo(() => ({ habilitado }), [habilitado]);
  return (
    <EntityContext.Provider value={valor}>{children}</EntityContext.Provider>
  );
}

// ── Util de formatação ────────────────────────────────────────────────────────

function brl(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
}

/**
 * Formata o documento por extenso para EXIBIÇÃO no chip: CNPJ (14 díg) ou CPF
 * (11 díg). Fiscalização interna → CPF é exibido COMPLETO. O número só aparece
 * aqui na superfície; jamais na URL/query (o deep-link usa o hash).
 */
function docPorExtenso(doc: string): string {
  const d = (doc ?? '').replace(/\D/g, '');
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  return doc;
}

const ICONE_TIPO = {
  empresa: Building2,
  pessoa: User,
  orgao: Landmark,
} as const;

// ── Chip individual ───────────────────────────────────────────────────────────

interface ChipProps {
  /** Dígitos crus do documento (CNPJ 14 ou CPF 11). */
  doc: string;
  /** 'cnpj' | 'cpf' — define minimização e deep-link. */
  tipo: 'cnpj' | 'cpf';
  /** Texto original do trecho (preserva a grafia que o usuário vê). */
  rotuloBruto: string;
}

function EntityChip({ doc, tipo, rotuloBruto }: ChipProps) {
  const [aberto, setAberto] = useState(false);
  // `ativo` dispara o fetch só depois do hover-intent / abertura — lazy.
  const [ativo, setAtivo] = useState(false);
  const timerAbrir = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerFechar = useRef<ReturnType<typeof setTimeout> | null>(null);

  const estado = useEntidadePreview(doc, ativo || aberto);

  const limparTimers = useCallback(() => {
    if (timerAbrir.current) clearTimeout(timerAbrir.current);
    if (timerFechar.current) clearTimeout(timerFechar.current);
    timerAbrir.current = null;
    timerFechar.current = null;
  }, []);

  // Hover-intent: abre após ~140ms de permanência; cancela na saída rápida.
  const onEnter = useCallback(() => {
    if (timerFechar.current) clearTimeout(timerFechar.current);
    setAtivo(true); // pré-carrega a prévia (dedupe garante 1 req/doc)
    timerAbrir.current = setTimeout(() => setAberto(true), 140);
  }, []);
  const onLeave = useCallback(() => {
    if (timerAbrir.current) clearTimeout(timerAbrir.current);
    timerFechar.current = setTimeout(() => setAberto(false), 120);
  }, []);

  useEffect(() => () => limparTimers(), [limparTimers]);

  // Exibição por extenso na superfície (fiscalização interna, dado público):
  // CNPJ mantém a grafia original do trecho; CPF é exibido COMPLETO e formatado.
  // O número só aparece AQUI — nunca na URL (o deep-link de CPF usa o hash).
  const rotulo =
    tipo === 'cnpj' ? rotuloBruto : docPorExtenso(doc);

  // Deep-link: o clique leva ao DOSSIÊ "TUDO LINKADO" da entidade (cruza tudo).
  // CNPJ (dado público de PJ) entra na URL por extenso; CPF entra SÓ pelo HASH
  // irreversível (o número NUNCA na URL — o hash chega na prévia via POST).
  // `/nexo/fornecedores/<cnpj>` segue existindo (citado dentro do dossiê), mas o
  // chip agora aponta para o dossiê completo.
  const hash = estado.status === 'ok' ? estado.previa.hash : null;
  const href =
    tipo === 'cnpj'
      ? `/nexo/dossie/${doc}`
      : hash
        ? `/nexo/dossie/${hash}`
        : null;

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          onFocus={() => setAtivo(true)}
          onClick={() => {
            setAtivo(true);
            setAberto((v) => !v);
          }}
          className="inline-flex items-center gap-1 rounded border border-amber-500/20 bg-amber-500/5 px-1 font-mono text-[0.95em] text-amber-300 underline decoration-amber-500/40 decoration-dotted underline-offset-2 transition-colors hover:border-amber-500/40 hover:bg-amber-500/10"
          aria-label={`Entidade ${rotulo} — abrir prévia`}
        >
          <ScanSearch className="h-3 w-3 shrink-0 opacity-70" />
          {rotulo}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        onMouseEnter={() => {
          if (timerFechar.current) clearTimeout(timerFechar.current);
        }}
        onMouseLeave={onLeave}
        className="w-80 border-white/10 bg-nexo-surface p-0 text-slate-200 shadow-xl"
      >
        <PreviaConteudo estado={estado} href={href} tipo={tipo} />
      </PopoverContent>
    </Popover>
  );
}

// ── Conteúdo da prévia ────────────────────────────────────────────────────────

function PreviaConteudo({
  estado,
  href,
  tipo,
}: {
  estado: EstadoPrevia;
  href: string | null;
  tipo: 'cnpj' | 'cpf';
}) {
  if (estado.status === 'carregando') {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin text-amber-400/80" />
        Resolvendo a entidade…
      </div>
    );
  }
  if (estado.status === 'erro') {
    return (
      <div className="flex items-start gap-2 p-4 text-xs text-red-300">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        Não foi possível carregar a prévia: {estado.mensagem}
      </div>
    );
  }

  const p = estado.previa;

  // Estado HONESTO: sem registro / coleta inativa (a rota devolve `motivo`).
  if (!p.disponivel) {
    return (
      <div className="space-y-2 p-4">
        <p className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
          <ShieldCheck className="h-3.5 w-3.5 text-slate-500" />
          Sem prévia para este documento
        </p>
        <p className="text-[11px] leading-relaxed text-slate-500">
          {p.motivo ?? 'Documento não localizado na base ingerida.'}
        </p>
        {href && (
          <LinkDrillDown href={href}>Abrir o raio-x mesmo assim</LinkDrillDown>
        )}
      </div>
    );
  }

  const Icone = p.tipo ? ICONE_TIPO[p.tipo] : Building2;

  return (
    <div className="flex flex-col">
      {/* Cabeçalho */}
      <div className="space-y-2 border-b border-white/5 p-3">
        <div className="flex items-start gap-2">
          <Icone className="mt-0.5 h-4 w-4 shrink-0 text-amber-400/80" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-snug text-slate-100">
              {p.nome || p.documento || 'Entidade'}
            </p>
            <p className="font-mono text-[11px] text-slate-500">{p.documento}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {p.ehEntidadePublica && (
            <Badge
              variant="outline"
              className="border-sky-500/30 bg-sky-500/10 text-[10px] text-sky-300"
            >
              <Landmark className="mr-1 h-3 w-3" /> ente público
            </Badge>
          )}
          {p.sancionado && (
            <Badge
              variant="outline"
              className="border-red-500/30 bg-red-500/10 text-[10px] text-red-300"
            >
              <ShieldAlert className="mr-1 h-3 w-3" /> sanção
              {p.nSancoes > 0 ? ` (${p.nSancoes})` : ''}
            </Badge>
          )}
          {p.contratoAtivo && (
            <Badge
              variant="outline"
              className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300"
            >
              <CheckCircle2 className="mr-1 h-3 w-3" /> vínculo vivo
            </Badge>
          )}
        </div>
      </div>

      {/* Agregados — mesmos para PF e PJ (fiscalização interna sobre dado
          público). O número do CPF nunca trafega na URL; o deep-link usa hash. */}
      <div className="grid grid-cols-3 gap-px bg-white/5 text-center">
        <CelulaKpi rotulo="Faturado" valor={brl(p.totalEmpenhado)} />
        <CelulaKpi rotulo="Empenhos" valor={p.nEmpenhos != null ? String(p.nEmpenhos) : '—'} />
        <CelulaKpi rotulo="Contratos" valor={p.nContratos != null ? String(p.nContratos) : '—'} />
      </div>

      {/* Flags */}
      {p.flags.length > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-white/5 p-3">
          {p.flags.map((f) => (
            <span
              key={f}
              className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400"
            >
              {f}
            </span>
          ))}
        </div>
      )}

      {/* Drill-down */}
      <div className="border-t border-white/5 p-3">
        {href ? (
          <LinkDrillDown href={href}>
            Abrir dossiê — Tudo Linkado
          </LinkDrillDown>
        ) : (
          <p className="text-[11px] text-slate-400">
            Drill-down indisponível (sem identificador resolvido).
          </p>
        )}
      </div>

      {/* Disclaimer — indício, nunca acusação */}
      <p className="border-t border-white/5 px-3 py-2 text-[10px] leading-relaxed text-slate-400">
        Prévia de dados públicos já ingeridos. É indício para apuração, nunca
        acusação. Convém verificar abrangência e eventual suspensão judicial.
      </p>
    </div>
  );
}

function CelulaKpi({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="bg-nexo-chrome px-2 py-2">
      <p className="text-[9px] uppercase tracking-wide text-slate-400">{rotulo}</p>
      <p className="mt-0.5 font-mono text-xs font-semibold text-slate-200">
        {valor}
      </p>
    </div>
  );
}

function LinkDrillDown({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 transition-colors hover:text-amber-300"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {children}
    </Link>
  );
}

// ── Renderização de um segmento ───────────────────────────────────────────────

function renderSegmento(seg: SegmentoEntidade, idx: number): React.ReactNode {
  // RG: GUARDRAIL LGPD — só destaque neutro, NUNCA chip/prévia/link.
  if (seg.tipo === 'rg') {
    return (
      <span
        key={idx}
        title="Documento pessoal (RG) — não investigável por LGPD"
        className="text-slate-400 underline decoration-slate-600 decoration-dotted underline-offset-2"
      >
        {seg.texto}
      </span>
    );
  }
  if ((seg.tipo === 'cnpj' || seg.tipo === 'cpf') && seg.valido) {
    return (
      <EntityChip
        key={idx}
        doc={seg.doc}
        tipo={seg.tipo}
        rotuloBruto={seg.texto}
      />
    );
  }
  // Texto cru.
  return <span key={idx}>{seg.texto}</span>;
}

// ── Componente público ────────────────────────────────────────────────────────

export interface EntityTextProps {
  /** Texto a renderizar; CNPJ/CPF válidos viram chips. Aceita null/undefined. */
  children: string | null | undefined;
  /** Classe do wrapper `<span>` (herda estilo do contexto por padrão). */
  className?: string;
}

/**
 * Renderiza `children` (texto) com os CNPJ/CPF válidos transformados em chips
 * investigáveis. Fora do `EntityProvider` (ou com ele desabilitado / sem nenhum
 * documento), devolve o texto puro — degradação transparente. Memoiza a detecção
 * por string para não re-varrer a cada render.
 */
export function EntityText({ children, className }: EntityTextProps) {
  const { habilitado } = useContext(EntityContext);
  const texto = children ?? '';

  const segmentos = useMemo(
    () => (habilitado ? detectarEntidades(texto) : null),
    [texto, habilitado],
  );

  // Desabilitado ou sem nenhum documento detectado → texto puro (sem overhead).
  if (
    !segmentos ||
    !segmentos.some((s) => s.tipo === 'cnpj' || s.tipo === 'cpf' || s.tipo === 'rg')
  ) {
    return <span className={className}>{texto}</span>;
  }

  return (
    <span className={className}>
      {segmentos.map((seg, i) => renderSegmento(seg, i))}
    </span>
  );
}

export default EntityText;
