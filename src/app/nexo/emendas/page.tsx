'use client';

/**
 * NEXO — EMENDAS PARLAMENTARES IMPOSITIVAS de Marília.
 *
 * Lista as emendas impositivas municipais (2023–2026) com AUTORIA (vereador +
 * partido), VETO e o CICLO DE EXECUÇÃO de cada uma: destinado → empenhado →
 * liquidado → pago, barra de progressão e situação. Filtros por exercício,
 * autor, situação e faixa de valor. Painéis por AUTOR (vereador) e por
 * BENEFICIÁRIO. Link externo ao empenho/liquidação no Portal da Transparência e
 * ao PDF da emenda no SAGL. Dados via /api/nexo/emendas.
 *
 * ── FONTE ────────────────────────────────────────────────────────────────────
 *  • AUTORIA + VETO → SAGL da Câmara (emendas da matéria da LOA).
 *  • EXECUÇÃO       → Portal da Transparência de Marília (SMARAPD).
 * Vínculo emenda↔empenho por beneficiário + valor + janela de exercício. Emendas
 * pagas em parcelas/múltiplos empenhos podem aparecer como "sem empenho".
 *
 * Indício a apurar, NUNCA acusação. Estados loading/vazio/erro honestos.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Building2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ExternalLink,
  FileText,
  HandCoins,
  Info,
  Landmark,
  RefreshCw,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import type {
  EmendasResponse,
  EmendaItem,
  ExecucaoEmenda,
  RankingAutor,
  RankingDestinatario,
  VetoAno,
} from '@/app/api/nexo/emendas/route';
import type { ParceriasResponse, ParceriaItem } from '@/app/api/nexo/emendas/parcerias/route';

// Emendas impositivas instituídas em Marília desde 2023 — todos os anos têm dado.
const EXERCICIOS = [2026, 2025, 2024, 2023];
const TAMANHOS = [25, 50, 100, 200];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });
}
function brlCurto(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}
function pct1(v: number): string {
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}
/** "dd/MM/yyyy HH:mm" (cru da fonte) → "dd/MM/yyyy". */
function dataCurta(s: string | null): string {
  if (!s) return '—';
  const m = /^(\d{2}\/\d{2}\/\d{4})/.exec(s.trim());
  return m ? m[1] : s;
}

/** Remove o sufixo " - PARTIDO" do nome do autor (o partido vira chip à parte). */
function nomeAutor(autor: string, partido: string): string {
  if (partido) {
    const sufixo = ` - ${partido}`;
    if (autor.toLowerCase().endsWith(sufixo.toLowerCase())) {
      return autor.slice(0, autor.length - sufixo.length).trim();
    }
  }
  return autor;
}

function ChipPartido({ partido, className }: { partido: string; className?: string }) {
  if (!partido) return null;
  return (
    <Badge
      variant="outline"
      className={`border-white/10 bg-white/5 text-[10px] font-medium tracking-wide text-slate-300 ${className ?? ''}`}
    >
      {partido}
    </Badge>
  );
}

const ROTULO_EXEC: Record<ExecucaoEmenda, { rotulo: string; cls: string; titulo: string }> = {
  PAGA: {
    rotulo: 'Pago',
    cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    titulo: 'Emenda empenhada, liquidada e paga',
  },
  PAGA_PARCIAL: {
    rotulo: 'Pago parcial',
    cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    titulo: 'Pagamento parcial registrado — resta saldo a pagar',
  },
  LIQUIDADA_NAO_PAGA: {
    rotulo: 'Liquidada · não paga',
    cls: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
    titulo: 'Liquidada mas sem pagamento registrado — indício a apurar',
  },
  EMPENHADA_NAO_LIQ: {
    rotulo: 'Empenhada',
    cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    titulo: 'Apenas empenhada — sem liquidação registrada',
  },
  SEM_EMPENHO: {
    rotulo: 'Sem empenho',
    cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    titulo:
      'Sem empenho localizado no exercício — pode ter sido paga em parcelas / múltiplos empenhos',
  },
  VETADA: {
    rotulo: 'Vetada',
    cls: 'border-red-500/30 bg-red-500/10 text-red-300',
    titulo: 'Emenda vetada',
  },
  RETIRADA: {
    rotulo: 'Retirada',
    cls: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
    titulo: 'Retirada pelo autor',
  },
};

/** Título (tooltip) da situação — inclui o veto quando a emenda foi vetada. */
function tituloSituacao(e: EmendaItem, veto: VetoAno | null): string {
  const detalhe = e.statusDetalhe || ROTULO_EXEC[e.execucao].titulo;
  if (e.execucao === 'VETADA' && veto?.materia) return `${veto.materia} — ${detalhe}`;
  return detalhe;
}

/**
 * Barra de progressão do empenho: envelope empenhado (âmbar) → liquidado
 * (laranja) → pago (verde), como frações do valor empenhado. Sem empenho
 * (VETADA/SEM_EMPENHO/RETIRADA) → barra vazia.
 */
function BarraExecucao({ e }: { e: EmendaItem }) {
  const base = e.valorEmpenhado > 0 ? e.valorEmpenhado : 0;
  const pctPago = base > 0 ? Math.round((e.valorPago / base) * 1000) / 10 : 0;
  const wLiq = base > 0 ? Math.min(100, Math.max(0, (e.valorLiquidado / base) * 100)) : 0;
  const wPago = base > 0 ? Math.min(100, Math.max(0, (e.valorPago / base) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div className="text-[11px]">
        <span className="text-slate-400" title="% pago sobre o valor empenhado da emenda">
          {base > 0 ? `${pct1(pctPago)} pago` : 's/ empenho'}
        </span>
      </div>
      <div
        className="relative h-2 w-full overflow-hidden rounded-full bg-white/5"
        role="progressbar"
        aria-label={`Execução: ${base > 0 ? `${pct1(pctPago)} pago do empenhado` : 'sem empenho'}`}
        aria-valuenow={Math.round(pctPago)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {/* Empenhado (âmbar, envelope) → liquidado (laranja) → pago (verde). */}
        {base > 0 && <div className="absolute inset-y-0 left-0 w-full bg-amber-500/25" />}
        <div className="absolute inset-y-0 left-0 bg-orange-500/50" style={{ width: `${wLiq}%` }} />
        <div className="absolute inset-y-0 left-0 bg-emerald-500" style={{ width: `${wPago}%` }} />
      </div>
    </div>
  );
}

// ── Painéis laterais (ranking por autor / por beneficiário) ───────────────────

function LinhaRankingAutor({ r }: { r: RankingAutor }) {
  const pct = Math.min(100, Math.max(0, r.pctPago));
  const nome = nomeAutor(r.autor, r.partido);
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs text-slate-300" title={r.autor}>
            {nome}
          </span>
          <ChipPartido partido={r.partido} />
        </span>
        <span className="shrink-0 text-[11px] text-slate-400" title={`${r.qtd} emenda(s)`}>
          {r.qtd}×
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span>proposto {brlCurto(r.valorProposto)}</span>
        <span className="flex items-center gap-2">
          {r.vetadas > 0 && (
            <span className="inline-flex items-center gap-0.5 text-red-300/80" title={`${r.vetadas} vetada(s)`}>
              <Ban className="h-3 w-3" aria-hidden="true" />
              {r.vetadas}
            </span>
          )}
          <span>{pct1(r.pctPago)} pago</span>
        </span>
      </div>
    </li>
  );
}

function LinhaRankingDestino({ r }: { r: RankingDestinatario }) {
  const pct = Math.min(100, Math.max(0, r.pctPago));
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-slate-300" title={r.beneficiario}>
          {r.beneficiario}
        </span>
        <span className="shrink-0 text-[11px] text-slate-400" title={`${r.qtd} emenda(s)`}>
          {r.qtd}×
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-slate-500">
        <span>proposto {brlCurto(r.valorProposto)}</span>
        <span>{pct1(r.pctPago)} pago</span>
      </div>
    </li>
  );
}

// ── Prestação de contas pública (parcerias com OSCs, lei13019.com.br) ─────────

/** "dd/MM" a partir de "yyyy-MM-dd", ou '—'. */
function dataCurtaIso(s: string | null): string {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

function CartaoParceria({ p }: { p: ParceriaItem }) {
  const pct = Math.min(100, Math.max(0, p.pctPrestado));
  const situacoes = Object.entries(p.despesasPorSituacao);
  return (
    <div className="rounded-md border border-white/5 bg-black/10 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium text-slate-100">{p.entidade || '—'}</h3>
        <Badge variant="outline" className="border-white/10 bg-white/5 text-[10px] text-slate-400">
          {p.instrumento} {p.numeroInstrumento}
          {p.anoInstrumento ? `/${p.anoInstrumento}` : ''}
        </Badge>
      </div>
      <p className="mt-0.5 text-xs text-slate-500">
        {p.unidadeGestora}
        {p.autor && (
          <>
            {' '}· parlamentar <span className="text-slate-400">{p.autor}</span>
          </>
        )}
        {p.vigenciaInicio && (
          <>
            {' '}· vigência {dataCurtaIso(p.vigenciaInicio)}–{dataCurtaIso(p.vigenciaTermino)}
          </>
        )}
      </p>
      {p.objeto && <p className="mt-2 line-clamp-2 text-xs text-slate-400" title={p.objeto}>{p.objeto}</p>}
      <div className="mt-3 flex items-center gap-3">
        <span className="shrink-0 text-xs text-slate-400">{brl(p.valor)} conveniado</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
          <div className="h-full bg-amber-500" style={{ width: `${pct}%` }} />
        </div>
        <span className="shrink-0 text-xs text-slate-400">{pct1(p.pctPrestado)} prestado</span>
      </div>
      {situacoes.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {situacoes.map(([sit, val]) => (
            <Badge
              key={sit}
              variant="outline"
              className={`text-[10px] ${
                /aguardando/i.test(sit)
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              }`}
            >
              {sit}: {brlCurto(val)}
            </Badge>
          ))}
        </div>
      )}
      {p.urlDetalhe && (
        <a
          href={p.urlDetalhe}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-[11px] text-slate-500 underline decoration-slate-600 decoration-dotted underline-offset-2 hover:text-slate-300"
          title="Abrir a prestação de contas da parceria no portal lei13019.com.br"
        >
          Ver prestação de contas <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

function SecaoParcerias({ autor }: { autor: string }) {
  const [data, setData] = useState<ParceriasResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    const p = new URLSearchParams();
    if (autor) p.set('autor', autor);
    p.set('tamanho', '30');
    nexoFetch(`/api/nexo/emendas/parcerias?${p.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ParceriasResponse;
      })
      .then((json) => {
        if (id === reqId.current) setData(json);
      })
      .catch((err) => {
        if (id === reqId.current) {
          setErro(err instanceof Error ? err.message : 'erro desconhecido');
          setData(null);
        }
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false);
      });
  }, [autor]);

  return (
    <section aria-labelledby="parcerias-titulo" className="space-y-3 rounded-md border border-white/5 bg-nexo-chrome p-4">
      <div className="flex items-center gap-2">
        <HandCoins className="h-4 w-4 text-amber-400" aria-hidden="true" />
        <h2 id="parcerias-titulo" className="text-sm font-semibold text-slate-100">
          Prestação de Contas Pública — parcerias com OSCs
        </h2>
      </div>
      <p className="text-xs text-slate-500">
        Convênios/termos de colaboração cuja origem é uma emenda parlamentar
        municipal (Lei 13.019/2014) — entidade beneficiária, valor conveniado e
        quanto já foi <strong className="text-slate-400">efetivamente prestado</strong>{' '}
        em despesas pela OSC. Fonte: portal lei13019.com.br, atualizado
        quinzenalmente. {autor && <>Filtrado por <strong className="text-slate-400">{autor}</strong>.</>}
      </p>

      {loading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : erro ? (
        <p className="flex items-center gap-2 text-xs text-red-300">
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          Não foi possível carregar as parcerias: {erro}
        </p>
      ) : !data || data.ingestao.status === 'pendente' ? (
        <p className="py-4 text-center text-xs text-slate-500">
          Ainda sem dados coletados desta fonte — o próximo ciclo (dias 1 e 16)
          preenche automaticamente.
        </p>
      ) : data.itens.length === 0 ? (
        <p className="py-4 text-center text-xs text-slate-500">
          {autor ? 'Nenhuma parceria encontrada para este autor.' : 'Nenhuma parceria encontrada.'}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-400">
            <span className="text-slate-300">{data.agregados.count.toLocaleString('pt-BR')} parceria(s)</span>
            <span>·</span>
            <span>conveniado <strong className="text-slate-200">{brlCurto(data.agregados.valorTotal)}</strong></span>
            <span>·</span>
            <span>prestado <strong className="text-slate-200">{brlCurto(data.agregados.despesasTotal)}</strong></span>
            <span>·</span>
            <span>{pct1(data.agregados.pctPrestadoGlobal)} comprovado</span>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {data.itens.map((p) => (
              <CartaoParceria key={p.id} p={p} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

type OrdenarPor = 'valor' | 'numero' | 'autor';
type Dir = 'asc' | 'desc';
type EixoRanking = 'autor' | 'destino';

export default function EmendasPage() {
  const [exercicio, setExercicio] = useState(2026);

  const [q, setQ] = useState('');
  const [autor, setAutor] = useState('');
  const [status, setStatus] = useState('todas');
  const [valorMin, setValorMin] = useState('');
  const [valorMax, setValorMax] = useState('');
  const [ordenarPor, setOrdenarPor] = useState<OrdenarPor>('valor');
  const [dir, setDir] = useState<Dir>('desc');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [eixo, setEixo] = useState<EixoRanking>('autor');

  // Versão "aplicada" dos filtros de texto (debounce 400ms).
  const [filtros, setFiltros] = useState({ q: '', autor: '', valorMin: '', valorMax: '' });
  useEffect(() => {
    const t = setTimeout(() => {
      setFiltros({ q, autor, valorMin, valorMax });
      setPageIndex(0);
    }, 400);
    return () => clearTimeout(t);
  }, [q, autor, valorMin, valorMax]);

  const [data, setData] = useState<EmendasResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const reqId = useRef(0);

  const carregar = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    const p = new URLSearchParams();
    p.set('exercicio', String(exercicio));
    if (filtros.q) p.set('q', filtros.q);
    if (filtros.autor) p.set('autor', filtros.autor);
    if (filtros.valorMin) p.set('valorMin', filtros.valorMin);
    if (filtros.valorMax) p.set('valorMax', filtros.valorMax);
    if (status !== 'todas') p.set('execucao', status);
    p.set('ordenarPor', ordenarPor);
    p.set('dir', dir);
    p.set('pagina', String(pageIndex));
    p.set('tamanho', String(pageSize));
    try {
      const res = await nexoFetch(`/api/nexo/emendas?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as EmendasResponse;
      if (id === reqId.current) setData(json);
    } catch (err) {
      if (id === reqId.current) {
        setErro(err instanceof Error ? err.message : 'erro desconhecido');
        setData(null);
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [exercicio, filtros, status, ordenarPor, dir, pageIndex, pageSize]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const itens = data?.itens ?? [];
  const ag = data?.agregados;
  const ranking = data?.ranking ?? [];
  const rankingAutor = data?.rankingAutor ?? [];
  const veto = data?.veto ?? null;
  const loa = data?.loa ?? null;
  const fonte = data?.fonte ?? null;

  const ordenar = (col: OrdenarPor) => {
    if (col === ordenarPor) setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setOrdenarPor(col);
      setDir('desc');
    }
    setPageIndex(0);
  };
  const Seta = ({ col }: { col: OrdenarPor }) =>
    ordenarPor !== col ? null : dir === 'desc' ? (
      <ArrowDown className="ml-1 inline h-3.5 w-3.5" aria-hidden="true" />
    ) : (
      <ArrowUp className="ml-1 inline h-3.5 w-3.5" aria-hidden="true" />
    );
  const ariaSort = (col: OrdenarPor): 'ascending' | 'descending' | 'none' =>
    ordenarPor !== col ? 'none' : dir === 'desc' ? 'descending' : 'ascending';

  const temFiltros = !!(q || autor || valorMin || valorMax) || status !== 'todas';
  const limpar = () => {
    setQ('');
    setAutor('');
    setValorMin('');
    setValorMax('');
    setStatus('todas');
    setPageIndex(0);
  };

  const pctExecGlobal = useMemo(() => {
    if (!ag || ag.valorEmpenhado <= 0) return 0;
    return Math.round((ag.valorPago / ag.valorEmpenhado) * 1000) / 10;
  }, [ag]);

  return (
    <EntityProvider>
      <div className="space-y-6">
        {/* Cabeçalho */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Landmark className="h-5 w-5 text-amber-400" aria-hidden="true" />
              <h1 className="text-2xl font-bold tracking-tight text-slate-100">Emendas Parlamentares</h1>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">
              Emendas impositivas municipais ao orçamento de Marília (instituídas
              desde 2023) — autoria por vereador, veto e o ciclo de execução de
              cada uma: destinado, empenhado, liquidado e pago. Indício a apurar,
              nunca acusação.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={carregar}
            disabled={loading}
            aria-label="Atualizar lista de emendas"
            title="Recarregar as emendas do exercício selecionado"
            className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
          >
            <RefreshCw className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} aria-hidden="true" />
            Atualizar
          </Button>
        </div>

        {/* Nota de método / fonte (substitui o antigo aviso data-blocked) */}
        <div className="flex items-start gap-2 rounded-md border border-sky-500/15 bg-sky-500/5 px-4 py-2.5 text-xs text-slate-400">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400/70" aria-hidden="true" />
          <span>
            <strong className="text-slate-300">Método &amp; fonte:</strong> a{' '}
            <strong className="text-slate-300">autoria</strong> (vereador) e o{' '}
            <strong className="text-slate-300">veto</strong> vêm do{' '}
            <strong className="text-slate-300">SAGL da Câmara</strong> (emendas da
            matéria da LOA); a <strong className="text-slate-300">execução</strong>{' '}
            (empenho → liquidação → pagamento) vem do{' '}
            <strong className="text-slate-300">Portal da Transparência</strong> de
            Marília. Vínculo emenda↔empenho por beneficiário + valor + janela de
            exercício.
            {fonte?.ressalva && <span className="text-slate-500"> {fonte.ressalva}</span>}
          </span>
        </div>

        {/* Exercício */}
        <div className="flex items-center gap-2" role="group" aria-label="Selecionar exercício">
          <span className="text-xs uppercase tracking-wide text-slate-500">Exercício</span>
          {EXERCICIOS.map((ano) => (
            <button
              key={ano}
              type="button"
              aria-pressed={ano === exercicio}
              onClick={() => {
                setExercicio(ano);
                setPageIndex(0);
              }}
              className={[
                'rounded-md px-3 py-1 text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40',
                ano === exercicio
                  ? 'bg-amber-500/15 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30'
                  : 'text-slate-400 hover:bg-white/5',
              ].join(' ')}
            >
              {ano}
            </button>
          ))}
        </div>

        {/* LOA + veto do exercício */}
        {(loa || veto) && (
          <div className="flex flex-col gap-2">
            {loa && (
              <p className="text-xs text-slate-500">
                Orçamento {loa.anoOrcamento}:{' '}
                <strong className="text-slate-300">{loa.lei}</strong>
                {loa.loaPl && <span> · {loa.loaPl}</span>}
                {ag && ag.count > 0 && (
                  <span> · {ag.count.toLocaleString('pt-BR')} emendas · {brlCurto(ag.valorProposto)} destinados</span>
                )}
              </p>
            )}
            {veto && veto.emendasVetadas.length > 0 && (
              <div
                className="flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/5 px-4 py-2.5 text-xs text-red-200"
                role="note"
                title={veto.nota}
              >
                <Ban className="mt-0.5 h-4 w-4 shrink-0 text-red-400/80" aria-hidden="true" />
                <span>
                  <strong className="text-red-200">Veto {veto.materia}:</strong>{' '}
                  {veto.emendasVetadas.length} emenda(s) vetada(s)
                  {veto.disposicao && (
                    <span className="text-red-200/70"> — {veto.disposicao}</span>
                  )}
                  .{' '}
                  <span className="text-red-200/70">
                    Emendas nº {veto.emendasVetadas.join(', ')}.
                  </span>
                </span>
              </div>
            )}
          </div>
        )}

        {/* Filtros */}
        <div className="grid grid-cols-1 gap-3 rounded-md border border-white/5 bg-nexo-chrome p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label htmlFor="em-q" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">
              Busca (beneficiário, autor, finalidade)
            </label>
            <Input
              id="em-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ex.: AMEI, saúde, ou nome do vereador"
              className="border-white/10 bg-transparent text-slate-200 placeholder:text-slate-500"
            />
          </div>
          <div>
            <label htmlFor="em-autor" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Autor (vereador)</label>
            <Input
              id="em-autor"
              value={autor}
              onChange={(e) => setAutor(e.target.value)}
              placeholder="Ex.: Féfin"
              className="border-white/10 bg-transparent text-slate-200 placeholder:text-slate-500"
            />
          </div>
          <div>
            <label htmlFor="em-status" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Situação</label>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                setPageIndex(0);
              }}
            >
              <SelectTrigger id="em-status" aria-label="Filtrar por situação da emenda" className="border-white/10 bg-transparent text-slate-200">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todas">Todas</SelectItem>
                <SelectItem value="pago">Paga</SelectItem>
                <SelectItem value="liquidado">Liquidada não paga</SelectItem>
                <SelectItem value="empenhado">Só empenhada</SelectItem>
                <SelectItem value="sem_empenho">Sem empenho</SelectItem>
                <SelectItem value="vetada">Vetada</SelectItem>
                <SelectItem value="retirada">Retirada</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label htmlFor="em-valor-min" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Valor mín. (R$)</label>
            <Input
              id="em-valor-min"
              type="number"
              inputMode="decimal"
              min={0}
              value={valorMin}
              onChange={(e) => setValorMin(e.target.value)}
              placeholder="0"
              className="border-white/10 bg-transparent text-slate-200 placeholder:text-slate-500"
            />
          </div>
          <div>
            <label htmlFor="em-valor-max" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Valor máx. (R$)</label>
            <Input
              id="em-valor-max"
              type="number"
              inputMode="decimal"
              min={0}
              value={valorMax}
              onChange={(e) => setValorMax(e.target.value)}
              placeholder="sem limite"
              className="border-white/10 bg-transparent text-slate-200 placeholder:text-slate-500"
            />
          </div>
          {temFiltros && (
            <div className="flex items-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={limpar}
                className="text-slate-400 hover:bg-white/5 hover:text-slate-200"
              >
                Limpar filtros
              </Button>
            </div>
          )}
        </div>

        {/* Conteúdo */}
        {loading && !data ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : erro ? (
          <Card className="border-red-500/20 bg-red-500/5" role="alert">
            <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
              <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              Não foi possível carregar as emendas: {erro}
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Resumo do recorte */}
            {ag && (
              <div
                role="status"
                aria-label="Resumo do recorte atual"
                className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-xs text-slate-400"
              >
                <span className="text-slate-300">{ag.count.toLocaleString('pt-BR')} emendas</span>
                <span>·</span>
                <span>destinado <strong className="text-slate-200">{brlCurto(ag.valorProposto)}</strong></span>
                <span>·</span>
                <span>empenhado <strong className="text-slate-200">{brlCurto(ag.valorEmpenhado)}</strong></span>
                <span>·</span>
                <span>pago <strong className="text-slate-200">{brlCurto(ag.valorPago)}</strong></span>
                <span>·</span>
                <span>{pct1(pctExecGlobal)} executado</span>
                {ag.liquidadasNaoPagas > 0 && (
                  <>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1 text-orange-300">
                      <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
                      {ag.liquidadasNaoPagas.toLocaleString('pt-BR')} liquidadas não pagas
                    </span>
                  </>
                )}
                {ag.semEmpenho > 0 && (
                  <>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1 text-amber-300">
                      {ag.semEmpenho.toLocaleString('pt-BR')} sem empenho
                    </span>
                  </>
                )}
                {ag.vetadas > 0 && (
                  <>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1 text-red-300">
                      <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                      {ag.vetadas.toLocaleString('pt-BR')} vetadas
                    </span>
                  </>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_22rem]">
              {/* Tabela de emendas */}
              <div
                className="overflow-x-auto rounded-md border border-white/5 bg-nexo-chrome"
                aria-busy={loading}
              >
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead className="text-slate-400" aria-sort={ariaSort('numero')}>
                        <button
                          type="button"
                          onClick={() => ordenar('numero')}
                          aria-label={`Ordenar por número da emenda (${ariaSort('numero') === 'descending' ? 'decrescente' : ariaSort('numero') === 'ascending' ? 'crescente' : 'sem ordenação'})`}
                          className="inline-flex items-center rounded hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                        >
                          Nº<Seta col="numero" />
                        </button>
                      </TableHead>
                      <TableHead className="text-slate-400" aria-sort={ariaSort('autor')}>
                        <button
                          type="button"
                          onClick={() => ordenar('autor')}
                          aria-label={`Ordenar por autor (${ariaSort('autor') === 'descending' ? 'decrescente' : ariaSort('autor') === 'ascending' ? 'crescente' : 'sem ordenação'})`}
                          className="inline-flex items-center rounded hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                        >
                          Autoria<Seta col="autor" />
                        </button>
                      </TableHead>
                      <TableHead className="text-slate-400">Beneficiário / finalidade</TableHead>
                      <TableHead className="text-right text-slate-400" aria-sort={ariaSort('valor')}>
                        <button
                          type="button"
                          onClick={() => ordenar('valor')}
                          aria-label={`Ordenar por valor destinado (${ariaSort('valor') === 'descending' ? 'decrescente' : ariaSort('valor') === 'ascending' ? 'crescente' : 'sem ordenação'})`}
                          className="inline-flex items-center rounded hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                        >
                          Destinado<Seta col="valor" />
                        </button>
                      </TableHead>
                      <TableHead className="min-w-[10rem] text-slate-400">Execução</TableHead>
                      <TableHead className="text-slate-400">Situação</TableHead>
                      <TableHead className="text-slate-400">Empenho</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {itens.length === 0 ? (
                      <TableRow className="border-white/5 hover:bg-transparent">
                        <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">
                          {temFiltros ? 'Nenhuma emenda casa os filtros.' : 'Sem emendas.'}
                        </TableCell>
                      </TableRow>
                    ) : (
                      itens.map((e) => {
                        const st = ROTULO_EXEC[e.execucao];
                        return (
                          <TableRow key={e.id} className="border-white/5 align-top hover:bg-white/5">
                            {/* Nº → PDF da emenda no SAGL */}
                            <TableCell className="whitespace-nowrap text-slate-300">
                              {e.urlEmenda ? (
                                <a
                                  href={e.urlEmenda}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-slate-300 underline decoration-slate-600 decoration-dotted underline-offset-2 hover:text-slate-100"
                                  title="Abrir o PDF da emenda no SAGL da Câmara"
                                >
                                  {e.numero}
                                  <FileText className="h-3 w-3 opacity-70" aria-hidden="true" />
                                </a>
                              ) : (
                                <span>{e.numero}</span>
                              )}
                            </TableCell>
                            {/* Autoria */}
                            <TableCell className="max-w-[13rem]">
                              <div className="truncate text-slate-200" title={e.autor}>
                                {nomeAutor(e.autor, e.partido) || '—'}
                              </div>
                              {e.partido && <ChipPartido partido={e.partido} className="mt-0.5" />}
                            </TableCell>
                            {/* Beneficiário / finalidade */}
                            <TableCell className="max-w-[18rem]">
                              <div className="truncate text-slate-200" title={e.beneficiario}>
                                {e.beneficiario || '—'}
                              </div>
                              {e.finalidade && (
                                <div className="truncate text-[11px] text-slate-500" title={e.finalidade}>
                                  {e.finalidade}
                                </div>
                              )}
                              {e.cnpj && (
                                <div className="mt-0.5 text-[11px] text-slate-500">
                                  <EntityText>{e.cnpj}</EntityText>
                                </div>
                              )}
                            </TableCell>
                            {/* Destinado */}
                            <TableCell className="whitespace-nowrap text-right text-slate-200">
                              {e.valor > 0 ? brl(e.valor) : '—'}
                            </TableCell>
                            {/* Execução */}
                            <TableCell>
                              <BarraExecucao e={e} />
                              {e.valorEmpenhado > 0 && (
                                <div className="mt-1 flex justify-between text-[10px] text-slate-500">
                                  <span title="Liquidado">liq {brlCurto(e.valorLiquidado)}</span>
                                  <span title="Pago">pago {brlCurto(e.valorPago)}</span>
                                </div>
                              )}
                            </TableCell>
                            {/* Situação */}
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={`text-[10px] ${st.cls}`}
                                title={tituloSituacao(e, veto)}
                              >
                                {st.rotulo}
                              </Badge>
                            </TableCell>
                            {/* Empenho — link externo + selo de atraso */}
                            <TableCell className="whitespace-nowrap">
                              {e.linkEmpenho ? (
                                <a
                                  href={e.linkEmpenho}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-amber-300 underline decoration-amber-500/30 decoration-dotted underline-offset-2 transition-colors hover:text-amber-200"
                                  title="Abrir o empenho no Portal da Transparência"
                                >
                                  {e.numeroEmpenho || 'empenho'}
                                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                                </a>
                              ) : (
                                <span className="text-slate-500" title="Sem empenho localizado no exercício">
                                  —
                                </span>
                              )}
                              {e.numeroEmpenho && (
                                <div className="mt-0.5 flex flex-col gap-0.5 text-[10px] text-slate-500">
                                  <span>{dataCurta(e.dataEmpenho)}</span>
                                  {e.atrasoAnos != null && e.atrasoAnos > 0 && (
                                    <span
                                      className="inline-flex w-fit items-center gap-1 rounded border border-orange-500/25 bg-orange-500/10 px-1 py-px text-[9px] text-orange-300"
                                      title={`Empenhada em ${e.exercEmpenho}, ${e.atrasoAnos} ano(s) após o exercício da emenda`}
                                    >
                                      <TriangleAlert className="h-2.5 w-2.5" aria-hidden="true" />
                                      empenho em {e.exercEmpenho} (+{e.atrasoAnos}a)
                                    </span>
                                  )}
                                  {e.linkLiquidacao && (
                                    <a
                                      href={e.linkLiquidacao}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex w-fit items-center gap-1 text-slate-400 underline decoration-slate-600 decoration-dotted underline-offset-2 hover:text-slate-200"
                                      title="Abrir a liquidação no Portal da Transparência"
                                    >
                                      liquidação
                                      <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                                    </a>
                                  )}
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Painéis: por vereador (autor) / por beneficiário */}
              <aside className="rounded-md border border-white/5 bg-nexo-chrome p-4">
                <div
                  role="tablist"
                  aria-label="Eixo do ranking"
                  className="mb-3 inline-flex rounded-md border border-white/5 bg-black/20 p-0.5 text-xs"
                >
                  <button
                    type="button"
                    role="tab"
                    id="tab-autor"
                    aria-selected={eixo === 'autor'}
                    aria-controls="painel-ranking"
                    onClick={() => setEixo('autor')}
                    className={[
                      'inline-flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40',
                      eixo === 'autor' ? 'bg-amber-500/15 text-amber-300' : 'text-slate-400 hover:text-slate-200',
                    ].join(' ')}
                  >
                    <Users className="h-3.5 w-3.5" aria-hidden="true" />
                    Por vereador
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="tab-destino"
                    aria-selected={eixo === 'destino'}
                    aria-controls="painel-ranking"
                    onClick={() => setEixo('destino')}
                    className={[
                      'inline-flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40',
                      eixo === 'destino' ? 'bg-amber-500/15 text-amber-300' : 'text-slate-400 hover:text-slate-200',
                    ].join(' ')}
                  >
                    <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Por destinatário
                  </button>
                </div>

                <div id="painel-ranking" role="tabpanel" aria-labelledby={eixo === 'autor' ? 'tab-autor' : 'tab-destino'}>
                  {eixo === 'autor' ? (
                    <>
                      <p className="mb-3 text-[11px] text-slate-500">
                        Quanto cada vereador propôs e quanto foi efetivamente pago —
                        revela concentração do recurso. Vetadas sinalizadas.
                      </p>
                      {rankingAutor.length === 0 ? (
                        <p className="py-6 text-center text-xs text-slate-500">Sem dados no recorte.</p>
                      ) : (
                        <ul className="space-y-3">
                          {rankingAutor.slice(0, 14).map((r) => (
                            <LinhaRankingAutor key={r.autor} r={r} />
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="mb-3 text-[11px] text-slate-500">
                        Beneficiário × pago no recorte atual — concentração do destino
                        do recurso.
                      </p>
                      {ranking.length === 0 ? (
                        <p className="py-6 text-center text-xs text-slate-500">Sem dados no recorte.</p>
                      ) : (
                        <ul className="space-y-3">
                          {ranking.slice(0, 14).map((r) => (
                            <LinhaRankingDestino key={r.beneficiario} r={r} />
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              </aside>
            </div>

            {/* Paginação */}
            <div className="flex flex-col items-center justify-between gap-3 text-xs text-slate-400 sm:flex-row">
              <span>{total.toLocaleString('pt-BR')} emenda(s) no total.</span>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <span id="em-page-size-label">Linhas por página</span>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => {
                      setPageSize(Number(v));
                      setPageIndex(0);
                    }}
                  >
                    <SelectTrigger
                      aria-labelledby="em-page-size-label"
                      className="h-8 w-[72px] border-white/10 bg-transparent text-slate-200"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TAMANHOS.map((t) => (
                        <SelectItem key={t} value={String(t)}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <span aria-live="polite">
                  Página {pageCount === 0 ? 0 : pageIndex + 1} de {pageCount}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Primeira página"
                    title="Primeira página"
                    className="h-8 w-8 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
                    onClick={() => setPageIndex(0)}
                    disabled={pageIndex === 0}
                  >
                    <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Página anterior"
                    title="Página anterior"
                    className="h-8 w-8 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
                    onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
                    disabled={pageIndex === 0}
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Próxima página"
                    title="Próxima página"
                    className="h-8 w-8 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
                    onClick={() => setPageIndex((i) => Math.min(pageCount - 1, i + 1))}
                    disabled={pageIndex >= pageCount - 1}
                  >
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Última página"
                    title="Última página"
                    className="h-8 w-8 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
                    onClick={() => setPageIndex(pageCount - 1)}
                    disabled={pageIndex >= pageCount - 1}
                  >
                    <ChevronsRight className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}

        <SecaoParcerias autor={filtros.autor} />
      </div>
    </EntityProvider>
  );
}
