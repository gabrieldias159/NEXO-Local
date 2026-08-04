'use client';

/**
 * NEXO — Financeiro: EMPENHOS, LIQUIDAÇÃO e PAGAMENTO.
 *
 * Abre listando o EXERCÍCIO CORRENTE em ordem CRONOLÓGICA DECRESCENTE (mais
 * recente primeiro), paginado. Busca por destinatário (empresa/pessoa — nome ou
 * CNPJ/CPF), por período, por faixa de valor, por órgão e por situação de
 * liquidação. Ordenação clicável por Data ou Valor. Dados via /api/nexo/empenhos
 * (lê `nexo_empenhos`, filtra/ordena/pagina no servidor com cache por ano).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
  Wallet,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { EmpenhosResponse } from '@/app/api/nexo/empenhos/route';
import Link from 'next/link';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';
import { ContraprovaDocumental } from '@/components/nexo/empenhos/ContraprovaDocumental';

const EXERCICIOS = [2026, 2025, 2024];
const TAMANHOS = [25, 50, 100, 200];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });
}
function brlCurto(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}
function dataBR(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/**
 * Formata o doc por extenso — texto que o `EntityText` detecta e transforma em
 * chip investigável. CNPJ (14 díg) e CPF (11 díg) viram chip clicável (raio-x);
 * fiscalização interna exibe o CPF completo. O número fica só na EXIBIÇÃO — o
 * deep-link do chip usa o HASH, nunca o número na URL. Outros tamanhos → ''.
 */
function docFormatado(doc: string): string {
  const d = (doc ?? '').replace(/\D/g, '');
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  return '';
}

const MS_DIA = 86_400_000;
/** Dias decorridos de uma data ISO até hoje (null se não parseável). */
function diasDesde(iso: string | null): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const hoje = Date.now();
  if (!Number.isFinite(t) || t > hoje) return null;
  return Math.floor((hoje - t) / MS_DIA);
}

/** Detalhe (Processo) — adm. com fallback p/ licitatório. */
function processoBR(adm: string | null, lic: string | null): string {
  return adm || lic || '—';
}

type OrdenarPor = 'data' | 'valor';
type Dir = 'asc' | 'desc';

/** Lê `?processo=` da URL no 1º render (client). Permite o deep-link da coluna
 *  Processo seedar o filtro ao abrir os empenhos daquele processo. */
function processoInicial(): string {
  if (typeof window === 'undefined') return '';
  try {
    return new URLSearchParams(window.location.search).get('processo') ?? '';
  } catch {
    return '';
  }
}

export default function EmpenhosPage() {
  const [exercicio, setExercicio] = useState(2026);

  // Filtros digitados (debounced) e aplicados.
  const [q, setQ] = useState('');
  const [orgao, setOrgao] = useState('');
  const [processo, setProcesso] = useState(processoInicial);
  const [dataIni, setDataIni] = useState('');
  const [dataFim, setDataFim] = useState('');
  const [valorMin, setValorMin] = useState('');
  const [valorMax, setValorMax] = useState('');
  const [situacao, setSituacao] = useState('todas');
  const [ordenarPor, setOrdenarPor] = useState<OrdenarPor>('data');
  const [dir, setDir] = useState<Dir>('desc');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  // Versão "aplicada" dos filtros de texto (debounce 400ms). `processo` já vem
  // seedado da URL (deep-link da coluna Processo) para filtrar na 1ª carga.
  const [filtros, setFiltros] = useState({ q: '', orgao: '', processo: processoInicial(), dataIni: '', dataFim: '', valorMin: '', valorMax: '' });
  useEffect(() => {
    const t = setTimeout(() => {
      setFiltros({ q, orgao, processo, dataIni, dataFim, valorMin, valorMax });
      setPageIndex(0);
    }, 400);
    return () => clearTimeout(t);
  }, [q, orgao, processo, dataIni, dataFim, valorMin, valorMax]);

  const [data, setData] = useState<EmpenhosResponse | null>(null);
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
    if (filtros.orgao) p.set('orgao', filtros.orgao);
    if (filtros.processo) p.set('processo', filtros.processo);
    if (filtros.dataIni) p.set('dataIni', filtros.dataIni);
    if (filtros.dataFim) p.set('dataFim', filtros.dataFim);
    if (filtros.valorMin) p.set('valorMin', filtros.valorMin);
    if (filtros.valorMax) p.set('valorMax', filtros.valorMax);
    if (situacao !== 'todas') p.set('situacao', situacao);
    p.set('ordenarPor', ordenarPor);
    p.set('dir', dir);
    p.set('pagina', String(pageIndex));
    p.set('tamanho', String(pageSize));
    try {
      const res = await nexoFetch(`/api/nexo/empenhos?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as EmpenhosResponse;
      if (id === reqId.current) setData(json);
    } catch (err) {
      if (id === reqId.current) {
        setErro(err instanceof Error ? err.message : 'erro desconhecido');
        setData(null);
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [exercicio, filtros, situacao, ordenarPor, dir, pageIndex, pageSize]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const itens = data?.itens ?? [];
  const ag = data?.agregados;
  const porMes = data?.porMes ?? [];

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

  const temFiltros =
    !!(q || orgao || processo || dataIni || dataFim || valorMin || valorMax) || situacao !== 'todas';
  const limpar = () => {
    setQ('');
    setOrgao('');
    setProcesso('');
    setDataIni('');
    setDataFim('');
    setValorMin('');
    setValorMax('');
    setSituacao('todas');
    setPageIndex(0);
  };

  const pctLiquidado = useMemo(() => {
    if (!ag || ag.count === 0) return 0;
    return Math.round((ag.comLiquidacao / ag.count) * 100);
  }, [ag]);

  return (
    <EntityProvider>
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Empenhos &amp; Pagamentos</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Execução da despesa da Prefeitura de Marília — empenho, liquidação e
            pagamento. Busca por destinatário, período e diversos filtros.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={carregar}
          disabled={loading}
          aria-label="Atualizar lista de empenhos"
          title="Recarregar os empenhos do exercício selecionado"
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <RefreshCw className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} aria-hidden="true" />
          Atualizar
        </Button>
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

      {/* Contraprova documental: totais e série computados direto dos documentos */}
      <ContraprovaDocumental exercicio={exercicio} />

      {/* Filtros */}
      <div className="grid grid-cols-1 gap-3 rounded-md border border-white/5 bg-nexo-chrome p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <label htmlFor="emp-q" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">
            Destinatário (nome ou CNPJ/CPF)
          </label>
          <Input
            id="emp-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ex.: empresa X, ou 12345678000199"
            className="border-white/10 bg-transparent text-slate-200 placeholder:text-slate-500"
          />
        </div>
        <div>
          <label htmlFor="emp-orgao" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Órgão / unidade</label>
          <Input
            id="emp-orgao"
            value={orgao}
            onChange={(e) => setOrgao(e.target.value)}
            placeholder="Ex.: Saúde"
            className="border-white/10 bg-transparent text-slate-200 placeholder:text-slate-500"
          />
        </div>
        <div>
          <label htmlFor="emp-processo" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Processo (adm./licit.)</label>
          <Input
            id="emp-processo"
            value={processo}
            onChange={(e) => setProcesso(e.target.value)}
            placeholder="Ex.: 1234/2026"
            className="border-white/10 bg-transparent text-slate-200 placeholder:text-slate-500"
          />
        </div>
        <div>
          <label htmlFor="emp-situacao" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Situação</label>
          <Select
            value={situacao}
            onValueChange={(v) => {
              setSituacao(v);
              setPageIndex(0);
            }}
          >
            <SelectTrigger id="emp-situacao" aria-label="Filtrar por situação de liquidação" className="border-white/10 bg-transparent text-slate-200">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todas">Todas</SelectItem>
              <SelectItem value="liquidado">Com liquidação</SelectItem>
              <SelectItem value="sem_liquidacao">Sem liquidação</SelectItem>
              <SelectItem value="sancionado">Só sancionados</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label htmlFor="emp-data-ini" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Período — de</label>
          <Input
            id="emp-data-ini"
            type="date"
            value={dataIni}
            max={dataFim || undefined}
            onChange={(e) => setDataIni(e.target.value)}
            className="border-white/10 bg-transparent text-slate-200"
          />
        </div>
        <div>
          <label htmlFor="emp-data-fim" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Período — até</label>
          <Input
            id="emp-data-fim"
            type="date"
            value={dataFim}
            min={dataIni || undefined}
            onChange={(e) => setDataFim(e.target.value)}
            className="border-white/10 bg-transparent text-slate-200"
          />
        </div>
        <div>
          <label htmlFor="emp-valor-min" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Valor mín. (R$)</label>
          <Input
            id="emp-valor-min"
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
          <label htmlFor="emp-valor-max" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Valor máx. (R$)</label>
          <Input
            id="emp-valor-max"
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
            Não foi possível carregar os empenhos: {erro}
          </CardContent>
        </Card>
      ) : data && data.ingestao.status === 'pendente' ? (
        <Card className="border-white/10 bg-nexo-chrome">
          <CardContent className="py-10 text-center text-sm text-slate-400">
            Sem empenhos coletados para {exercicio}. A ingestão do SMARAPD ainda não
            rodou para este exercício.
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
              <span className="text-slate-300">{ag.count.toLocaleString('pt-BR')} empenhos</span>
              <span>·</span>
              <span>empenhado <strong className="text-slate-200">{brlCurto(ag.totalEmpenhado)}</strong></span>
              <span>·</span>
              <span>pago <strong className="text-slate-200">{brlCurto(ag.totalPago)}</strong></span>
              <span>·</span>
              <span>{pctLiquidado}% com liquidação</span>
              {ag.sancionados > 0 && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1 text-red-300">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    {ag.sancionados.toLocaleString('pt-BR')} com fornecedor sancionado
                  </span>
                </>
              )}
            </div>
          )}

          <div
            className="overflow-x-auto rounded-md border border-white/5 bg-nexo-chrome"
            aria-busy={loading}
          >
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 hover:bg-transparent">
                  <TableHead className="text-slate-400" aria-sort={ariaSort('data')}>
                    <button
                      type="button"
                      onClick={() => ordenar('data')}
                      aria-label={`Ordenar por data (${ariaSort('data') === 'descending' ? 'decrescente' : ariaSort('data') === 'ascending' ? 'crescente' : 'sem ordenação'})`}
                      className="inline-flex items-center rounded hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                    >
                      Data<Seta col="data" />
                    </button>
                  </TableHead>
                  <TableHead className="text-slate-400">Empenho</TableHead>
                  <TableHead className="text-slate-400">Destinatário</TableHead>
                  <TableHead className="text-slate-400">Órgão</TableHead>
                  <TableHead className="text-slate-400">Processo</TableHead>
                  <TableHead className="text-right text-slate-400" aria-sort={ariaSort('valor')}>
                    <button
                      type="button"
                      onClick={() => ordenar('valor')}
                      aria-label={`Ordenar por valor empenhado (${ariaSort('valor') === 'descending' ? 'decrescente' : ariaSort('valor') === 'ascending' ? 'crescente' : 'sem ordenação'})`}
                      className="inline-flex items-center rounded hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                    >
                      Empenhado<Seta col="valor" />
                    </button>
                  </TableHead>
                  <TableHead className="text-right text-slate-400">Pago</TableHead>
                  <TableHead className="text-slate-400">Situação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {itens.length === 0 ? (
                  <TableRow className="border-white/5 hover:bg-transparent">
                    <TableCell colSpan={8} className="py-10 text-center text-sm text-slate-500">
                      {temFiltros ? 'Nenhum empenho casa os filtros.' : 'Sem empenhos.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  itens.map((e) => (
                    <TableRow key={e.id} className="border-white/5 hover:bg-white/5">
                      <TableCell className="whitespace-nowrap text-slate-300">{dataBR(e.data)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Link
                          href={`/nexo/empenho/${encodeURIComponent(e.id)}`}
                          className="text-amber-300 underline decoration-amber-500/30 decoration-dotted underline-offset-2 transition-colors hover:text-amber-200"
                          title="Ver tudo sobre este empenho e seus vínculos"
                        >
                          {e.numeroEmpenho || '—'}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-[22rem]">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-slate-200" title={e.fornecedorNome}>
                            {e.fornecedorNome || '—'}
                          </span>
                          {e.sancionado && (
                            <Badge
                              variant="outline"
                              className="shrink-0 border-red-500/30 bg-red-500/10 text-[10px] text-red-300"
                              title="Fornecedor com sanção CEIS/CNEP — indício a apurar"
                            >
                              <ShieldAlert className="mr-1 h-3 w-3" />
                              Sancionado{e.nSancoes > 0 ? ` (${e.nSancoes})` : ''}
                            </Badge>
                          )}
                        </div>
                        {e.cpfCnpj && docFormatado(e.cpfCnpj) && (
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            <EntityText>{docFormatado(e.cpfCnpj)}</EntityText>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[12rem] truncate text-slate-400" title={e.unidadeGestora}>
                        {e.unidadeGestora || '—'}
                      </TableCell>
                      <TableCell
                        className="max-w-[10rem] truncate text-slate-400"
                        title={processoBR(e.processoAdministrativo, e.processoLicitatorio)}
                      >
                        {(() => {
                          const proc = processoBR(e.processoAdministrativo, e.processoLicitatorio);
                          // Processo vazio ("—") não vira link. Caso contrário,
                          // abre os empenhos daquele processo (a página aceita ?processo).
                          return proc === '—' ? (
                            proc
                          ) : (
                            <Link
                              href={`/nexo/empenhos?processo=${encodeURIComponent(proc)}`}
                              className="text-amber-300 underline decoration-amber-500/30 decoration-dotted underline-offset-2 transition-colors hover:text-amber-200"
                              title={`Ver empenhos do processo ${proc}`}
                            >
                              {proc}
                            </Link>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-slate-200">
                        <TooltipProvider delayDuration={300}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help border-b border-dotted border-slate-600/50 hover:border-slate-400 transition-colors">
                                {brl(e.valorEmpenhado)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent
                              side="left"
                              align="center"
                              className="w-80 sm:w-96 max-w-[90vw] rounded-xl border border-white/10 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-md text-slate-200 z-50"
                            >
                              <div className="space-y-2">
                                <div className="border-b border-white/10 pb-2">
                                  <div className="font-semibold text-xs text-white">Detalhes do Empenho</div>
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-[11px]">
                                  <div>
                                    <span className="text-slate-400 block text-[10px]">Empenhado</span>
                                    <span className="font-semibold text-emerald-300">{brl(e.valorEmpenhado)}</span>
                                  </div>
                                  <div>
                                    <span className="text-slate-400 block text-[10px]">Pago</span>
                                    <span className="font-semibold text-violet-300">{brl(e.valorPago)}</span>
                                  </div>
                                  <div>
                                    <span className="text-slate-400 block text-[10px]">Liquidação</span>
                                    <span className={e.temLiquidacao ? 'text-emerald-300' : 'text-amber-300'}>{e.temLiquidacao ? 'Sim' : 'Não'}</span>
                                  </div>
                                  <div>
                                    <span className="text-slate-400 block text-[10px]">Fornecedor</span>
                                    <span className="text-slate-200 truncate block max-w-[8rem]" title={e.fornecedorNome}>{e.fornecedorNome || '—'}</span>
                                  </div>
                                </div>
                                {porMes.length > 0 && (
                                  <>
                                    <div className="border-t border-white/10 pt-2">
                                      <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wider mb-1">Comparativo mês a mês — {exercicio}</div>
                                    </div>
                                    <div className="max-h-40 overflow-y-auto scrollbar-thin">
                                      <table className="w-full text-[10px]">
                                        <thead>
                                          <tr className="text-slate-500">
                                            <th className="text-left py-0.5 pr-2">Mês</th>
                                            <th className="text-right py-0.5 pr-2">Empenhado</th>
                                            <th className="text-right py-0.5 pr-2">Pago</th>
                                            <th className="text-right py-0.5">Emps.</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {porMes.map((m) => (
                                            <tr key={m.mes} className="border-t border-white/5 hover:bg-white/5">
                                              <td className="text-left py-0.5 pr-2 text-slate-300">{String(m.mes).padStart(2, '0')}</td>
                                              <td className="text-right py-0.5 pr-2 text-emerald-300/90">{brlCurto(m.empenhado)}</td>
                                              <td className="text-right py-0.5 pr-2 text-violet-300/90">{brlCurto(m.pago)}</td>
                                              <td className="text-right py-0.5 text-slate-400">{m.count}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-slate-400">
                        <TooltipProvider delayDuration={300}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help border-b border-dotted border-slate-600/50 hover:border-slate-400 transition-colors">
                                {brl(e.valorPago)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent
                              side="left"
                              align="center"
                              className="w-80 sm:w-96 max-w-[90vw] rounded-xl border border-white/10 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-md text-slate-200 z-50"
                            >
                              <div className="space-y-2">
                                <div className="border-b border-white/10 pb-2">
                                  <div className="font-semibold text-xs text-white">Detalhes do Pagamento</div>
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-[11px]">
                                  <div>
                                    <span className="text-slate-400 block text-[10px]">Valor Pago</span>
                                    <span className="font-semibold text-violet-300">{brl(e.valorPago)}</span>
                                  </div>
                                  <div>
                                    <span className="text-slate-400 block text-[10px]">Empenhado</span>
                                    <span className="font-semibold text-emerald-300">{brl(e.valorEmpenhado)}</span>
                                  </div>
                                  <div>
                                    <span className="text-slate-400 block text-[10px]">% Pago</span>
                                    <span className={e.valorEmpenhado > 0 ? 'text-slate-200' : 'text-slate-500'}>
                                      {e.valorEmpenhado > 0 ? `${((e.valorPago / e.valorEmpenhado) * 100).toFixed(1)}%` : '—'}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-slate-400 block text-[10px]">Liquidação</span>
                                    <span className={e.temLiquidacao ? 'text-emerald-300' : 'text-amber-300'}>{e.temLiquidacao ? 'Sim' : 'Não'}</span>
                                  </div>
                                </div>
                                {porMes.length > 0 && (
                                  <>
                                    <div className="border-t border-white/10 pt-2">
                                      <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wider mb-1">Comparativo mês a mês — {exercicio}</div>
                                    </div>
                                    <div className="max-h-40 overflow-y-auto scrollbar-thin">
                                      <table className="w-full text-[10px]">
                                        <thead>
                                          <tr className="text-slate-500">
                                            <th className="text-left py-0.5 pr-2">Mês</th>
                                            <th className="text-right py-0.5 pr-2">Pago</th>
                                            <th className="text-right py-0.5 pr-2">Empenhado</th>
                                            <th className="text-right py-0.5">Emps.</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {porMes.map((m) => (
                                            <tr key={m.mes} className="border-t border-white/5 hover:bg-white/5">
                                              <td className="text-left py-0.5 pr-2 text-slate-300">{String(m.mes).padStart(2, '0')}</td>
                                              <td className="text-right py-0.5 pr-2 text-violet-300/90">{brlCurto(m.pago)}</td>
                                              <td className="text-right py-0.5 pr-2 text-emerald-300/90">{brlCurto(m.empenhado)}</td>
                                              <td className="text-right py-0.5 text-slate-400">{m.count}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </>
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell>
                        {e.temLiquidacao ? (
                          e.valorPago > 0 ? (
                            <Badge
                              variant="outline"
                              className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300"
                              title="Despesa liquidada e paga"
                            >
                              Liquidado · pago
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="border-orange-500/30 bg-orange-500/10 text-[10px] text-orange-300"
                              title="Liquidado mas sem pagamento registrado — indício a apurar"
                            >
                              Liquidado · não pago
                            </Badge>
                          )
                        ) : (
                          (() => {
                            // OR-03: empenho relevante (≥ R$10k) sem liquidação há > 90d → indício.
                            const dias = diasDesde(e.data);
                            const orcado = e.valorEmpenhado >= 10000 && dias != null && dias > 90;
                            return (
                              <div className="flex flex-col items-start gap-1">
                                <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300">
                                  Empenhado
                                </Badge>
                                {orcado && (
                                  <Badge
                                    variant="outline"
                                    className="border-amber-500/40 bg-amber-500/15 text-[10px] font-medium text-amber-200"
                                    title="Empenho relevante sem liquidação registrada — indício a apurar (OR-03)"
                                  >
                                    <TriangleAlert className="mr-1 h-3 w-3" />
                                    Sem liquidação há {dias}d
                                  </Badge>
                                )}
                              </div>
                            );
                          })()
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Paginação (estilo SAPL) */}
          <div className="flex flex-col items-center justify-between gap-3 text-xs text-slate-400 sm:flex-row">
            <span>{total.toLocaleString('pt-BR')} empenho(s) no total.</span>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span id="emp-page-size-label">Linhas por página</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(v) => {
                    setPageSize(Number(v));
                    setPageIndex(0);
                  }}
                >
                  <SelectTrigger
                    aria-labelledby="emp-page-size-label"
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
    </div>
    </EntityProvider>
  );
}
