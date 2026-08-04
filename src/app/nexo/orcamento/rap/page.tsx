'use client';

/**
 * NEXO — Painel RAP (Restos a Pagar), módulo completo §6.3.
 *
 * Série ano a ano (2013→atual) de restos a pagar: inscritos, processados,
 * não processados, pagamentos reais (TCE-SP) e disponibilidade/cobertura de
 * caixa (métrica MF). Seletor de faixa no topo orienta todos os módulos;
 * cada ano carrega selo de origem/confiança (A1). Ano sem coleta mostra
 * "sem dado" — nunca inventa zero (regra da honestidade).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine } from 'recharts';
import { Landmark, Loader2, TriangleAlert, Info, PiggyBank, FileDown, Building2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import type {
  RapResponse,
  PontoRapAnual,
  OrigemRap,
  SituacaoRap,
} from '@/app/api/nexo/rap/route';

const ANO_ATUAL = new Date().getFullYear();
const ANO_MIN = 2013;

type Grandeza = 'rapInscritos' | 'rapProcessados' | 'rapNaoProcessados' | 'pago' | 'liquidado';

const GRANDEZAS: Array<{ chave: Grandeza; rotulo: string; cor: string; desc: string }> = [
  { chave: 'rapInscritos', rotulo: 'RAP inscritos', cor: '#f43f5e', desc: 'Restos a pagar inscritos no exercício' },
  { chave: 'rapProcessados', rotulo: 'Processados', cor: '#f59e0b', desc: 'RAP processados (obrigação reconhecida)' },
  { chave: 'rapNaoProcessados', rotulo: 'Não processados', cor: '#a855f7', desc: 'RAP não processados (ainda sem atesto)' },
  { chave: 'pago', rotulo: 'Pago (TCE-SP)', cor: '#8b5cf6', desc: 'Pagamento real do exercício (eventos TCE-SP)' },
  { chave: 'liquidado', rotulo: 'Liquidado (TCE-SP)', cor: '#3b82f6', desc: 'Liquidação real do exercício (eventos TCE-SP)' },
];

function brlCurto(v: number): string {
  if (Math.abs(v) >= 1_000_000_000) {
    return `R$ ${(v / 1_000_000_000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} bi`;
  }
  if (Math.abs(v) >= 1_000_000) {
    return `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} mi`;
  }
  return `R$ ${(v / 1_000).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} k`;
}

function brl(v: number | null): string {
  return v == null
    ? '—'
    : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

function pct1(v: number | null): string {
  return v == null ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

/** Selo da origem/confiança de um ano (decisão A1). */
function SeloOrigem({ origem, confianca }: { origem: OrigemRap; confianca: PontoRapAnual['confianca'] }) {
  if (origem === 'sem-dados') {
    return <Badge variant="outline" className="border-white/10 text-[9px] text-slate-500">sem dados</Badge>;
  }
  const cor =
    confianca === 'alta'
      ? 'border-emerald-500/40 text-emerald-300'
      : confianca === 'media'
        ? 'border-amber-500/40 text-amber-300'
        : 'border-white/10 text-slate-400';
  return (
    <Badge variant="outline" className={`border ${cor} text-[9px]`}>
      {origem}
    </Badge>
  );
}

/** Selo da situação de cobertura de caixa (métrica MF). */
function SeloSituacao({ situacao }: { situacao: SituacaoRap }) {
  if (!situacao) return <span className="text-xs text-slate-500">—</span>;
  const map = {
    ok: { cor: 'border-emerald-500/40 text-emerald-300', rotulo: 'ok' },
    atencao: { cor: 'border-amber-500/40 text-amber-300', rotulo: 'atenção' },
    critico: { cor: 'border-rose-500/40 text-rose-300', rotulo: 'crítico' },
  } as const;
  const s = map[situacao];
  return <Badge variant="outline" className={`border ${s.cor} text-[9px]`}>{s.rotulo}</Badge>;
}

/** Variação percentual entre dois anos (null se qualquer lado não tiver dado). */
function deltaPct(anterior: number | null | undefined, atual: number | null | undefined): number | null {
  if (anterior == null || atual == null || anterior === 0) return null;
  return ((atual - anterior) / Math.abs(anterior)) * 100;
}

export default function RapPage() {
  const [de, setDe] = useState(Math.max(ANO_MIN, ANO_ATUAL - 1));
  const [ate, setAte] = useState(ANO_ATUAL);
  const [grandeza, setGrandeza] = useState<Grandeza>('rapInscritos');

  const { data, isLoading: loading, isError, error, refetch } = useQuery({
    queryKey: ['nexo-rap', de, ate],
    queryFn: async () => {
      const p = new URLSearchParams({ de: String(de), ate: String(ate) });
      const res = await nexoFetch(`/api/nexo/rap?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as RapResponse;
    },
  });
  const erro = isError ? (error instanceof Error ? error.message : 'Erro ao carregar RAP') : null;

  // Auto-caída de grandeza: se a selecionada não tem valor em NENHUM ano da
  // faixa (ex.: `rapInscritos` do SICONFI ainda não foi ingerido), cai para a
  // primeira grandeza que tenha dados reais (ex.: liquidação/pagamento TCE-SP).
  // Garante que o painel sempre mostre a absorção disponível, sem inventar zero.
  useEffect(() => {
    if (!data || !data.anos.length) return;
    const anos = data.anos;
    const temValor = (g: Grandeza) =>
      anos.some((a) => (a as unknown as Record<string, number | null>)[g] != null);
    if (temValor(grandeza)) return;
    const alvo = GRANDEZAS.find((g) => temValor(g.chave));
    if (alvo) setGrandeza(alvo.chave);
  }, [data, grandeza]);

  const faixasRapidas = useMemo(() => {
    const out: Array<{ rotulo: string; de: number; ate: number }> = [];
    if (ANO_ATUAL >= 2025) out.push({ rotulo: `${ANO_ATUAL - 1}–${ANO_ATUAL}`, de: ANO_ATUAL - 1, ate: ANO_ATUAL });
    if (ANO_ATUAL >= 2023) out.push({ rotulo: `${ANO_ATUAL - 2}–${ANO_ATUAL}`, de: ANO_ATUAL - 2, ate: ANO_ATUAL });
    out.push({ rotulo: '5 anos', de: ANO_ATUAL - 4, ate: ANO_ATUAL });
    out.push({ rotulo: 'Tudo (2013→)', de: ANO_MIN, ate: ANO_ATUAL });
    return out;
  }, []);

  const anos = useMemo(() => data?.anos ?? [], [data]);
  const temDados = anos.some((a) => a.temDados);
  const anosComDados = anos.filter((a) => a.temDados);
  const credores = useMemo(() => data?.credores ?? [], [data]);

  // Alertas honestos: RAP sem cobertura / sem dado real de pagamento.
  const alertas = useMemo(() => {
    const out: string[] = [];
    for (const a of anos) {
      if (!a.temDados) continue;
      if (a.situacao === 'critico' && a.coberturaCaixa != null) {
        out.push(`${a.exercicio}: cobertura de caixa de ${pct1(a.coberturaCaixa)} sobre os RAP inscritos (${brl(a.rapInscritos)}) — risco de RAP sem lastro financeiro.`);
      } else if (a.situacao === 'atencao' && a.coberturaCaixa != null) {
        out.push(`${a.exercicio}: cobertura de caixa de ${pct1(a.coberturaCaixa)} — atenção ao lastro dos restos a pagar.`);
      }
      if (a.pago == null && a.rapInscritos != null) {
        out.push(`${a.exercicio}: não há pagamento real do TCE-SP disponível para confrontar os RAP inscritos.`);
      }
    }
    return out;
  }, [anos]);

  const gra = GRANDEZAS.find((g) => g.chave === grandeza)!;

  // Quadro resumo: evolução dos RAP inscritos na faixa (Δ% + CAGR).
  const primeiroComDados = anosComDados[0];
  const ultimoComDados = anosComDados[anosComDados.length - 1];
  const resumo = useMemo(() => {
    if (!primeiroComDados || !ultimoComDados || primeiroComDados.exercicio === ultimoComDados.exercicio) return null;
    const ini = primeiroComDados.rapInscritos;
    const fim = ultimoComDados.rapInscritos;
    const crescer = deltaPct(ini, fim);
    const anosSpan = ultimoComDados.exercicio - primeiroComDados.exercicio;
    const cagr =
      ini != null && fim != null && ini !== 0 && anosSpan > 0
        ? (Math.pow(fim / Math.abs(ini), 1 / anosSpan) - 1) * 100
        : null;
    return { ini, fim, crescer, cagr, anosSpan };
  }, [primeiroComDados, ultimoComDados]);

  const chartData = useMemo(() => {
    return anos.map((a) => ({
      ano: String(a.exercicio),
      [gra.chave]: a[grandeza],
      rapInscritos: a.rapInscritos,
      coberturaCaixa: a.coberturaCaixa,
    }));
  }, [anos, gra, grandeza]);

  // Exporta CSV dos RAP por exercício (relatório exportável §6.3).
  const exportarCsv = useCallback(() => {
    if (!data) return;
    const linhas: string[] = [
      'exercicio;rapInscritos;rapProcessados;rapNaoProcessados;rapAnteriores;disponibilidadeCaixa;coberturaCaixa;situacao;periodoRef;restosRegistros;restosTotal;liquidado;pago;origem',
    ];
    for (const a of data.anos) {
      linhas.push(
        [
          a.exercicio,
          a.rapInscritos ?? '',
          a.rapProcessados ?? '',
          a.rapNaoProcessados ?? '',
          a.rapAnteriores ?? '',
          a.disponibilidadeCaixa ?? '',
          a.coberturaCaixa ?? '',
          a.situacao ?? '',
          a.periodoRef ?? '',
          a.restosRegistros ?? '',
          a.restosTotal ?? '',
          a.liquidado ?? '',
          a.pago ?? '',
          a.origem,
        ].join(';'),
      );
    }
    const blob = new Blob(['\ufeff' + linhas.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexo-rap-${data.de}-${data.ate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data]);

  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <PiggyBank className="h-5 w-5 text-rose-400" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Restos a Pagar (RAP)</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Série ano a ano dos restos a pagar do município: inscritos, processados, não processados,
            pagamentos reais (TCE-SP) e a disponibilidade/cobertura de caixa (métrica MF). Anos ainda
            não coletados aparecem como &quot;sem dados&quot; — nunca como zero.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={exportarCsv}
            disabled={loading || !temDados}
            className="border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
          >
            <FileDown className="mr-2 h-4 w-4" />
            Gerar relatório (CSV)
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            disabled={loading}
            className="border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
          >
            <Loader2 aria-hidden className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </Button>        </div>
      </div>

      {/* Seletor de faixa + grandeza */}
      <Card className="border border-white/10 bg-nexo-chrome">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-3">
              <span className="text-[11px] uppercase tracking-wide text-slate-400">Faixa</span>
              <div className="flex items-center gap-1.5">
                <Select value={String(de)} onValueChange={(v) => setDe(Number(v))}>
                  <SelectTrigger aria-label="Ano inicial" className="h-9 w-[92px] border-white/10 bg-transparent text-slate-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: ANO_ATUAL - ANO_MIN + 1 }, (_, i) => ANO_MIN + i)
                      .reverse()
                      .map((a) => (
                        <SelectItem key={a} value={String(a)}>{a}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <span className="text-slate-500">→</span>
                <Select value={String(ate)} onValueChange={(v) => setAte(Number(v))}>
                  <SelectTrigger aria-label="Ano final" className="h-9 w-[92px] border-white/10 bg-transparent text-slate-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: ANO_ATUAL - ANO_MIN + 1 }, (_, i) => ANO_MIN + i)
                      .reverse()
                      .map((a) => (
                        <SelectItem key={a} value={String(a)}>{a}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap gap-1">
                {faixasRapidas.map((f) => {
                  const ativo = de === f.de && ate === f.ate;
                  return (
                    <button
                      key={f.rotulo}
                      type="button"
                      aria-pressed={ativo}
                      onClick={() => { setDe(f.de); setAte(f.ate); }}
                      className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                        ativo
                          ? 'bg-amber-500/15 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30'
                          : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                      }`}
                    >
                      {f.rotulo}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-slate-400">Grandeza</span>
              {GRANDEZAS.map((g) => (
                <button
                  key={g.chave}
                  type="button"
                  aria-pressed={grandeza === g.chave}
                  title={g.desc}
                  onClick={() => setGrandeza(g.chave)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    grandeza === g.chave
                      ? 'bg-rose-500/15 font-medium text-rose-300 ring-1 ring-inset ring-rose-500/30'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                  }`}
                >
                  {g.rotulo}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Alertas honestos */}
      {alertas.length > 0 && (
        <div className="space-y-1.5">
          {alertas.map((a) => (
            <div key={a} className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200" role="alert">
              <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-300" />
              {a}
            </div>
          ))}
        </div>
      )}

      {/* Cartões ano a ano */}
      {!loading && temDados && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {anosComDados.slice(-10).map((a) => (
            <div key={a.exercicio} className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] uppercase tracking-wide text-slate-400">{a.exercicio}</span>
                <SeloSituacao situacao={a.situacao} />
              </div>
              <div className={`mt-1 text-lg font-semibold ${(a.rapInscritos ?? 0) > 0 ? 'text-rose-300' : 'text-slate-200'}`}>
                {brl(a.rapInscritos)}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-1.5 text-[10px] text-slate-400">
                {a.restosTotal != null && <span className="flex items-center gap-1"><Building2 className="h-2.5 w-2.5" />Portal {brlCurto(a.restosTotal)}</span>}
                {a.pago != null && <span>TCE pago {brlCurto(a.pago)}</span>}
              </div>
              <div className="mt-1"><SeloOrigem origem={a.origem} confianca={a.confianca} /></div>
            </div>
          ))}
        </div>
      )}

      {/* Quadro resumo (crescimento dos RAP inscritos na faixa) */}
      {!loading && resumo && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Primeiro ano com dado</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">{primeiroComDados?.exercicio}</div>
            <div className="text-xs text-slate-400">{brl(resumo.ini)}</div>
          </div>
          <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Último ano com dado</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">{ultimoComDados?.exercicio}</div>
            <div className="text-xs text-slate-400">{brl(resumo.fim)}</div>
          </div>
          <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Variação total</div>
            <div className={`mt-1 text-lg font-semibold ${(resumo.crescer ?? 0) > 0 ? 'text-rose-300' : 'text-emerald-400'}`}>
              {resumo.crescer == null ? '—' : `${resumo.crescer > 0 ? '+' : ''}${pct1(resumo.crescer)}`}
            </div>
            <div className="text-xs text-slate-400">{resumo.anosSpan} ano(s)</div>
          </div>
          <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Crescimento médio (CAGR)</div>
            <div className={`mt-1 text-lg font-semibold ${(resumo.cagr ?? 0) > 0 ? 'text-rose-300' : 'text-emerald-400'}`}>
              {resumo.cagr == null ? '—' : `${resumo.cagr > 0 ? '+' : ''}${resumo.cagr.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}
            </div>
            <div className="text-xs text-slate-400">ao ano</div>
          </div>
        </div>
      )}

      {/* Gráfico principal */}
      <Card className="border border-white/10 bg-nexo-chrome">
        <CardHeader className="flex flex-col gap-1 border-b border-white/5 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-rose-400" />
            <div>
              <CardTitle className="text-base font-semibold text-slate-100">
                {gra.rotulo} por ano ({de}–{ate})
              </CardTitle>
              <p className="mt-0.5 text-xs text-slate-400">{gra.desc}</p>
            </div>
          </div>
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-slate-300 hover:bg-white/20" aria-label="Como ler este gráfico">
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end" className="w-80 rounded-xl border border-white/10 bg-slate-950/95 p-4 shadow-2xl text-slate-200">
                <p className="text-xs leading-relaxed">
                  Cada coluna/linha é um exercício fiscal. <strong className="text-white">RAP inscritos</strong> é o
                  saldo do exercício (SICONFI RGF Anexo 05 / RREO Anexo 07); <strong className="text-white">pago/liquidado</strong>
                  são os eventos reais do TCE-SP (2014+, F1). Anos sem coleta ficam em branco — &quot;sem dados&quot;.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </CardHeader>
        <CardContent className="pt-5">
          {loading ? (
            <div className="space-y-2"><Skeleton className="h-72 w-full" /></div>
          ) : erro ? (
            <div className="flex h-72 items-center justify-center text-sm text-red-300">Falha ao carregar: {erro}</div>
          ) : !temDados ? (
            <div className="flex h-72 flex-col items-center justify-center gap-2 text-center text-sm text-slate-400">
              <Landmark className="h-6 w-6 text-slate-500" />
              Nenhum exercício da faixa {de}–{ate} tem dados de RAP coletados ainda.
              <span className="text-xs text-slate-500">O backfill do histórico (F1) preenche os anos anteriores.</span>
            </div>
          ) : (
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 10, right: 16, left: 8, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="ano" stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} />
                  <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => brlCurto(Number(v))} width={72} />
                  <RechartsTooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload || payload.length === 0) return null;
                      const ano = anos.find((a) => String(a.exercicio) === label);
                      return (
                        <div className="rounded-xl border border-white/10 bg-slate-950/95 p-3 shadow-2xl text-slate-200 min-w-[260px]">
                          <div className="border-b border-white/10 pb-2 mb-2">
                            <div className="text-xs font-semibold text-slate-100">Exercício {label}</div>
                            <div className="mt-1 flex items-center gap-2">
                              <span className="text-[10px] text-slate-400">Cobertura de caixa:</span>
                              <span className={`text-[11px] font-semibold ${ano?.situacao === 'critico' ? 'text-rose-300' : ano?.situacao === 'atencao' ? 'text-amber-300' : 'text-emerald-300'}`}>
                                {pct1(ano?.coberturaCaixa ?? null)}
                              </span>
                              <SeloSituacao situacao={ano?.situacao ?? null} />
                            </div>
                            {ano?.periodoRef && <div className="text-[10px] text-slate-500">Fonte: {ano.periodoRef} · {ano.origem}</div>}
                          </div>
                          <div className="space-y-1.5 text-xs">
                            {payload.map((p) => (
                              <div key={String(p.dataKey)} className="flex items-center justify-between gap-4">
                                <span className="flex items-center gap-1.5 font-medium" style={{ color: String(p.color) }}>
                                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: String(p.color) }} />
                                  {GRANDEZAS.find((g) => g.chave === p.dataKey)?.rotulo ?? String(p.dataKey)}:
                                </span>
                                <span className="font-mono text-slate-100">{p.value == null ? 'Sem dado' : brl(Number(p.value))}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Legend
                    verticalAlign="top"
                    height={36}
                    formatter={(value) => {
                      const t = GRANDEZAS.find((g) => g.chave === value)?.rotulo ?? value;
                      return <span className="text-xs font-medium text-slate-300">{t}</span>;
                    }}
                  />
                  <Bar dataKey={gra.chave} name={gra.chave} fill={gra.cor} radius={[3, 3, 0, 0]} />
                  {grandeza !== 'rapInscritos' && (
                    <Line type="monotone" dataKey="rapInscritos" name="rapInscritos" connectNulls={false} stroke="#f43f5e" strokeWidth={2.5} strokeDasharray="6 4" dot={{ r: 3, strokeWidth: 0 }} />
                  )}
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tabela detalhada ano a ano */}
      <Card className="border border-white/10 bg-nexo-chrome">
        <CardHeader className="border-b border-white/5 pb-4">
          <CardTitle className="text-base font-semibold text-slate-100">Detalhamento por exercício</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-white/5 text-slate-400">
                <th className="px-4 py-2.5 font-medium">Ano</th>
                <th className="px-4 py-2.5 font-medium">Inscritos</th>
                <th className="px-4 py-2.5 font-medium">Processados</th>
                <th className="px-4 py-2.5 font-medium">Não processados</th>
                <th className="px-4 py-2.5 font-medium">Disp. caixa</th>
                <th className="px-4 py-2.5 font-medium">Cobertura</th>
                <th className="px-4 py-2.5 font-medium">Pago (TCE)</th>
                <th className="px-4 py-2.5 font-medium">Liquidado (TCE)</th>
                <th className="px-4 py-2.5 font-medium">Portal</th>
                <th className="px-4 py-2.5 font-medium">Origem</th>
              </tr>
            </thead>
            <tbody>
              {anos.map((a) => (
                <tr key={a.exercicio} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-2.5 font-semibold text-slate-200">{a.exercicio}</td>
                  {!a.temDados ? (
                    <td colSpan={9} className="px-4 py-2.5 text-slate-500">Sem dados coletados para este exercício.</td>
                  ) : (
                    <>
                      <td className={`px-4 py-2.5 font-medium ${(a.rapInscritos ?? 0) > 0 ? 'text-rose-300' : 'text-slate-300'}`}>
                        {brl(a.rapInscritos)}
                        {a.periodoRef && <div className="text-[9px] font-normal text-slate-500">{a.periodoRef}</div>}
                      </td>
                      <td className="px-4 py-2.5 text-slate-300">{brl(a.rapProcessados)}</td>
                      <td className="px-4 py-2.5 text-slate-300">{brl(a.rapNaoProcessados)}</td>
                      <td className="px-4 py-2.5 text-slate-300">{brl(a.disponibilidadeCaixa)}</td>
                      <td className="px-4 py-2.5">
                        <span className={a.situacao === 'critico' ? 'font-semibold text-rose-300' : a.situacao === 'atencao' ? 'font-semibold text-amber-300' : 'text-slate-300'}>
                          {pct1(a.coberturaCaixa)}
                        </span>
                        <SeloSituacao situacao={a.situacao} />
                      </td>
                      <td className="px-4 py-2.5 text-slate-300">{brl(a.pago)}</td>
                      <td className="px-4 py-2.5 text-slate-300">{brl(a.liquidado)}</td>
                      <td className="px-4 py-2.5 text-slate-400">
                        {a.restosTotal == null ? '—' : `${brl(a.restosTotal)} (${a.restosRegistros})`}
                      </td>
                      <td className="px-4 py-2.5"><SeloOrigem origem={a.origem} confianca={a.confianca} /></td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Top credores */}
      <Card className="border border-white/10 bg-nexo-chrome">
        <CardHeader className="border-b border-white/5 pb-4">
          <CardTitle className="text-base font-semibold text-slate-100">Top credores em restos a pagar (Portal)</CardTitle>
          <p className="mt-0.5 text-xs text-slate-400">
            Detalhe do módulo <code className="text-amber-300/80">restoapagar</code> da SMARAPD — granularidade por
            fornecedor que o portal municipal publica. Para os demais anos, o agregado vem do SICONFI.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {credores.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-slate-500">
              Nenhum registro de restos a pagar do Portal na faixa {de}–{ate}.
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-white/5 text-slate-400">
                  <th className="px-4 py-2.5 font-medium">#</th>
                  <th className="px-4 py-2.5 font-medium">Exercício</th>
                  <th className="px-4 py-2.5 font-medium">Credor</th>
                  <th className="px-4 py-2.5 font-medium">CPF/CNPJ</th>
                  <th className="px-4 py-2.5 font-medium">Valor</th>
                  <th className="px-4 py-2.5 font-medium">Registros</th>
                </tr>
              </thead>
              <tbody>
                {credores.slice(0, 50).map((c, i) => (
                  <tr key={`${c.exercicio}-${c.cpfCnpj}-${i}`} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5 text-slate-500">{i + 1}</td>
                    <td className="px-4 py-2.5 text-slate-300">{c.exercicio}</td>
                    <td className="px-4 py-2.5 font-medium text-slate-200">{c.nome || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-400">{c.cpfCnpj || '—'}</td>
                    <td className="px-4 py-2.5 font-medium text-rose-300">{brl(c.valor)}</td>
                    <td className="px-4 py-2.5 text-slate-400">{c.qtde}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
