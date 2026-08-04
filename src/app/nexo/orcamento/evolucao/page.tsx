'use client';

/**
 * NEXO — Evolução Orçamentária (multi-ano).
 *
 * Comparativo ano a ano (2013→atual) da execução orçamentária do município:
 * dotação autorizada, empenhado, liquidado, pago e RAP (empenhado − pago).
 * Seletor de faixa no topo orienta todos os gráficos; granularidade alterna
 * Município × Órgão × Função; cada ano carrega selo de origem/confiança (A1).
 * Ano sem coleta mostra "sem dado" — nunca inventa zero (regra da honestidade).
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine } from 'recharts';
import { TrendingUp, Landmark, Loader2, TriangleAlert, Info, BarChart3, Rows3, Scale } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import type {
  OrcamentoEvolucaoResponse,
  PontoEvolucaoAnual,
  AgrupadorEvolucao,
  OrigemEvolucao,
} from '@/app/api/nexo/orcamento-evolucao/route';

const ANO_ATUAL = new Date().getFullYear();
const ANO_MIN = 2013;

type Grandeza = 'empenhado' | 'liquidado' | 'pago' | 'restandoAPagar' | 'dotacaoAutorizada';
type ModoGrafico = 'barras' | 'linhas';

const GRANDEZAS: Array<{ chave: Grandeza; rotulo: string; cor: string; desc: string }> = [
  { chave: 'empenhado', rotulo: 'Empenhado', cor: '#f59e0b', desc: 'Comprometido no ano (empenhos)' },
  { chave: 'liquidado', rotulo: 'Liquidado', cor: '#3b82f6', desc: 'Serviço entregue e atestado' },
  { chave: 'pago', rotulo: 'Pago', cor: '#8b5cf6', desc: 'Desembolsado ao credor' },
  { chave: 'restandoAPagar', rotulo: 'RAP (empenhado−pago)', cor: '#f43f5e', desc: 'Restos a Pagar — empenhado menos pago' },
  { chave: 'dotacaoAutorizada', rotulo: 'Dotação autorizada', cor: '#64748b', desc: 'LOA + créditos/emendas' },
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
function SeloOrigem({ origem, confianca }: { origem: OrigemEvolucao; confianca: PontoEvolucaoAnual['confianca'] }) {
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

/** Selo da fonte da liquidação (§5.4): TCE-SP real (prioridade 1) ou síntese derivada. */
function SeloLiquidacao({ fonte }: { fonte: PontoEvolucaoAnual['fonteLiquidacao'] }) {
  if (fonte === 'tce') {
    return (
      <span title="Liquidação real do TCE-SP (eventos Valor Liquidado/Valor Pago).">
        <Badge variant="outline" className="border-emerald-500/40 text-[9px] text-emerald-300">TCE-SP</Badge>
      </span>
    );
  }
  if (fonte === 'sintese') {
    return (
      <span title="Liquidação derivada da síntese SMARAPD (pago + a liquidar).">
        <Badge variant="outline" className="border-amber-500/40 text-[9px] text-amber-300">síntese</Badge>
      </span>
    );
  }
  return null;
}

/** Variação percentual entre dois anos (null se qualquer lado não tiver dado). */
function deltaPct(anterior: number | null | undefined, atual: number | null | undefined): number | null {
  if (anterior == null || atual == null || anterior === 0) return null;
  return ((atual - anterior) / Math.abs(anterior)) * 100;
}

export default function EvolucaoPage() {
  const [de, setDe] = useState(Math.max(ANO_MIN, ANO_ATUAL - 1));
  const [ate, setAte] = useState(ANO_ATUAL);
  const [grandeza, setGrandeza] = useState<Grandeza>('empenhado');
  const [modo, setModo] = useState<ModoGrafico>('barras');
  const [agruparPor, setAgruparPor] = useState<AgrupadorEvolucao>('municipio');

  const { data, isLoading: loading, isError, error, refetch } = useQuery({
    queryKey: ['nexo-orcamento-evolucao', de, ate, agruparPor],
    queryFn: async () => {
      const p = new URLSearchParams({ de: String(de), ate: String(ate), agruparPor });
      const res = await nexoFetch(`/api/nexo/orcamento-evolucao?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as OrcamentoEvolucaoResponse;
    },
  });
  const erro = isError ? (error instanceof Error ? error.message : 'Erro ao carregar evolução') : null;

  // Pills rápidas de faixas recentes (seletor §6.4).
  const faixasRapidas: Array<{ rotulo: string; de: number; ate: number }> = useMemo(() => {
    const out: Array<{ rotulo: string; de: number; ate: number }> = [];
    if (ANO_ATUAL >= 2025) out.push({ rotulo: `${ANO_ATUAL - 1}–${ANO_ATUAL}`, de: ANO_ATUAL - 1, ate: ANO_ATUAL });
    if (ANO_ATUAL >= 2023) out.push({ rotulo: `${ANO_ATUAL - 2}–${ANO_ATUAL}`, de: ANO_ATUAL - 2, ate: ANO_ATUAL });
    out.push({ rotulo: '5 anos', de: ANO_ATUAL - 4, ate: ANO_ATUAL });
    out.push({ rotulo: 'Tudo (2013→)', de: ANO_MIN, ate: ANO_ATUAL });
    return out;
  }, []);

  const anos = useMemo(() => data?.municipio ?? [], [data]);
  const temDados = anos.some((a) => a.temDados);
  const anosComDados = anos.filter((a) => a.temDados);
  const primeiroComDados = anosComDados[0];
  const ultimoComDados = anosComDados[anosComDados.length - 1];

  // Grandeza selecionada → série para o gráfico.
  const serie = useMemo(() => {
    const base = data?.categorias?.length ? data.categorias : null;
    if (base) {
      return base.map((c) => ({
        chave: c.chave,
        titulo: c.titulo,
        pontos: c.anos.map((a) => ({ exercicio: a.exercicio, valor: a[grandeza] })),
      }));
    }
    return [
      {
        chave: 'municipio',
        titulo: 'Município',
        pontos: anos.map((a) => ({ exercicio: a.exercicio, valor: a[grandeza] })),
      },
    ];
  }, [data, anos, grandeza]);

  // Formato de dados do gráfico: uma linha por ano, coluna por série.
  const chartData = useMemo(() => {
    const pontos = serie[0]?.pontos ?? [];
    return pontos.map((p, i) => {
      const row: Record<string, string | number | null> = { ano: String(p.exercicio), _i: i };
      for (const s of serie) {
        const v = s.pontos[i]?.valor ?? null;
        row[s.chave] = v;
      }
      return row;
    });
  }, [serie]);

  const gra = GRANDEZAS.find((g) => g.chave === grandeza)!;

  // Quadro resumo: variação entre primeiro e último ano com dados + Δ% ano a ano.
  const resumo = useMemo(() => {
    if (!primeiroComDados || !ultimoComDados || primeiroComDados.exercicio === ultimoComDados.exercicio) return null;
    const ini = primeiroComDados[grandeza];
    const fim = ultimoComDados[grandeza];
    const crescer = deltaPct(ini, fim);
    const anosSpan = ultimoComDados.exercicio - primeiroComDados.exercicio;
    const cagr =
      ini != null && fim != null && ini !== 0 && anosSpan > 0
        ? (Math.pow(fim / Math.abs(ini), 1 / anosSpan) - 1) * 100
        : null;
    return { ini, fim, crescer, cagr, anosSpan };
  }, [primeiroComDados, ultimoComDados, grandeza]);

  // Alerta honesto: RAP crescente / liquidação acima do arrecadado.
  const alertas = useMemo(() => {
    const out: string[] = [];
    for (const a of anos) {
      if (!a.temDados) continue;
      if (a.arrecadado != null && a.liquidado != null && a.liquidado > a.arrecadado && a.arrecadado > 0) {
        out.push(`${a.exercicio}: liquidado (${brl(a.liquidado)}) superou a arrecadação (${brl(a.arrecadado)}) — risco de RAP sem cobertura de caixa.`);
      }
      if (a.pago != null && a.liquidado != null && a.liquidado > a.pago) {
        out.push(`${a.exercicio}: há ${brl(a.liquidado - a.pago)} liquidados ainda não pagos.`);
      }
    }
    return out;
  }, [anos]);

  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-amber-400" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Evolução Orçamentária</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Comparativo ano a ano da execução do orçamento municipal. Selecione a faixa e a
            grandeza; cada ano indica a origem dos dados. Anos ainda não coletados aparecem como
            &quot;sem dados&quot; — nunca como zero.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refetch()}
          disabled={loading}
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <Loader2 aria-hidden className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </Button>
      </div>

      {/* Seletor de faixa + granularidade + grandeza (orienta todos os módulos) */}
      <Card className="border border-white/10 bg-nexo-chrome">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {/* Faixa de anos */}
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

            {/* Granularidade */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-slate-400">Visão</span>
              {([
                { valor: 'municipio', rotulo: 'Município' },
                { valor: 'orgao', rotulo: 'por órgão' },
                { valor: 'funcao', rotulo: 'por função' },
              ] as { valor: AgrupadorEvolucao; rotulo: string }[]).map((g) => (
                <button
                  key={g.valor}
                  type="button"
                  aria-pressed={agruparPor === g.valor}
                  onClick={() => setAgruparPor(g.valor)}
                  className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                    agruparPor === g.valor
                      ? 'bg-amber-500/15 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                  }`}
                >
                  {g.rotulo}
                </button>
              ))}
            </div>

            {/* Modo do gráfico */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-slate-400">Gráfico</span>
              <button
                type="button"
                aria-pressed={modo === 'barras'}
                onClick={() => setModo('barras')}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
                  modo === 'barras'
                    ? 'bg-blue-500/20 font-medium text-blue-300 ring-1 ring-inset ring-blue-500/30'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                }`}
              >
                <BarChart3 className="h-3 w-3" /> Barras por ano
              </button>
              <button
                type="button"
                aria-pressed={modo === 'linhas'}
                onClick={() => setModo('linhas')}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
                  modo === 'linhas'
                    ? 'bg-blue-500/20 font-medium text-blue-300 ring-1 ring-inset ring-blue-500/30'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                }`}
              >
                <Rows3 className="h-3 w-3" /> Linhas YoY
              </button>
            </div>
          </div>

          {/* Grandeza */}
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
                    ? 'bg-amber-500/15 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                }`}
              >
                {g.rotulo}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Quadro resumo (crescimento da faixa) */}
      {!loading && resumo && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Primeiro ano</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">{primeiroComDados?.exercicio}</div>
            <div className="text-xs text-slate-400">{brl(resumo.ini)}</div>
          </div>
          <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Último ano</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">{ultimoComDados?.exercicio}</div>
            <div className="text-xs text-slate-400">{brl(resumo.fim)}</div>
          </div>
          <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Variação total</div>
            <div className={`mt-1 text-lg font-semibold ${(resumo.crescer ?? 0) > 0 ? 'text-amber-300' : 'text-emerald-400'}`}>
              {resumo.crescer == null ? '—' : `${resumo.crescer > 0 ? '+' : ''}${pct1(resumo.crescer)}`}
            </div>
            <div className="text-xs text-slate-400">{resumo.anosSpan} ano(s)</div>
          </div>
          <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Crescimento médio (CAGR)</div>
            <div className={`mt-1 text-lg font-semibold ${(resumo.cagr ?? 0) > 0 ? 'text-amber-300' : 'text-emerald-400'}`}>
              {resumo.cagr == null ? '—' : `${resumo.cagr > 0 ? '+' : ''}${resumo.cagr.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}
            </div>
            <div className="text-xs text-slate-400">ao ano</div>
          </div>
        </div>
      )}

      {/* Alertas honestos */}
      {alertas.length > 0 && (
        <div className="space-y-1.5">
          {alertas.map((a) => (
            <div key={a} className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="alert">
              <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
              {a}
            </div>
          ))}
        </div>
      )}

      {/* Gráfico principal */}
      <Card className="border border-white/10 bg-nexo-chrome">
        <CardHeader className="flex flex-col gap-1 border-b border-white/5 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-amber-400" />
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
                  Cada coluna/linha é um exercício fiscal. <strong className="text-white">Barras</strong> compara os
                  totais lado a lado; <strong className="text-white">Linhas YoY</strong> sobrepõe as séries para
                  enxergar tendência. Anos sem coleta não aparecem com zero — ficam em branco (&quot;sem dados&quot;).
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
              <Scale className="h-6 w-6 text-slate-500" />
              Nenhum exercício da faixa {de}–{ate} tem dados coletados ainda.
              <span className="text-xs text-slate-500">A coleta do histórico (F1) vai preencher os anos anteriores.</span>
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
                      return (
                        <div className="rounded-xl border border-white/10 bg-slate-950/95 p-3 shadow-2xl text-slate-200 min-w-[220px]">
                          <div className="border-b border-white/10 pb-2 mb-2">
                            <div className="text-xs font-semibold text-slate-100">Exercício {label}</div>
                            <div className="text-[10px] text-slate-400">{gra.rotulo} — {gra.desc}</div>
                          </div>
                          <div className="space-y-1.5 text-xs">
                            {payload.map((p) => (
                              <div key={String(p.dataKey)} className="flex items-center justify-between gap-4">
                                <span className="flex items-center gap-1.5 font-medium" style={{ color: String(p.color) }}>
                                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: String(p.color) }} />
                                  {serie.find((s) => s.chave === p.dataKey)?.titulo ?? '—'}:
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
                      const t = serie.find((s) => s.chave === value)?.titulo ?? value;
                      return <span className="text-xs font-medium text-slate-300">{t}</span>;
                    }}
                  />
                  {modo === 'barras' ? (
                    serie.map((s) => (
                      <Bar
                        key={s.chave}
                        dataKey={s.chave}
                        name={s.chave}
                        fill={agruparPor === 'municipio' ? gra.cor : undefined}
                        radius={[3, 3, 0, 0]}
                      />
                    ))
                  ) : (
                    serie.map((s, idx) => (
                      <Line
                        key={s.chave}
                        type="monotone"
                        dataKey={s.chave}
                        name={s.chave}
                        connectNulls={false}
                        stroke={agruparPor === 'municipio' ? gra.cor : PALETA_LINHAS[idx % PALETA_LINHAS.length]}
                        strokeWidth={2.5}
                        dot={{ r: 4, strokeWidth: 0 }}
                      />
                    ))
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
                <th className="px-4 py-2.5 font-medium">Dotação inicial</th>
                <th className="px-4 py-2.5 font-medium">Autorizada</th>
                <th className="px-4 py-2.5 font-medium">Empenhado</th>
                <th className="px-4 py-2.5 font-medium">Liquidado</th>
                <th className="px-4 py-2.5 font-medium">Pago</th>
                <th className="px-4 py-2.5 font-medium">RAP</th>
                <th className="px-4 py-2.5 font-medium">% exec.</th>
                <th className="px-4 py-2.5 font-medium">Estouradas</th>
                <th className="px-4 py-2.5 font-medium">Origem</th>
                <th className="px-4 py-2.5 font-medium">Δ ano</th>
              </tr>
            </thead>
            <tbody>
              {anos.map((a, i) => {
                const anterior = anos[i - 1];
                const d = deltaPct(anterior?.empenhado, a.empenhado);
                return (
                  <tr key={a.exercicio} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5 font-semibold text-slate-200">{a.exercicio}</td>
                    {!a.temDados ? (
                      <td colSpan={10} className="px-4 py-2.5 text-slate-500">Sem dados coletados para este exercício.</td>
                    ) : (
                      <>
                        <td className="px-4 py-2.5 text-slate-300">{brl(a.dotacaoInicial)}</td>
                        <td className="px-4 py-2.5 text-slate-300">{brl(a.dotacaoAutorizada)}</td>
                        <td className="px-4 py-2.5 text-slate-200">{brl(a.empenhado)}</td>
                        <td className="px-4 py-2.5 text-slate-200">
                          {brl(a.liquidado)}
                          <span className="ml-2"><SeloLiquidacao fonte={a.fonteLiquidacao} /></span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-200">{brl(a.pago)}</td>
                        <td className={`px-4 py-2.5 font-medium ${(a.restandoAPagar ?? 0) > 0 ? 'text-rose-300' : 'text-slate-300'}`}>
                          {brl(a.restandoAPagar)}
                        </td>
                        <td className="px-4 py-2.5 text-slate-300">{pct1(a.pctExecucao)}</td>
                        <td className={`px-4 py-2.5 ${a.estouradas > 0 ? 'font-semibold text-red-300' : 'text-slate-400'}`}>
                          {a.estouradas}
                        </td>
                        <td className="px-4 py-2.5"><SeloOrigem origem={a.origem} confianca={a.confianca} /></td>
                        <td className={`px-4 py-2.5 font-medium ${d == null ? 'text-slate-500' : d > 0 ? 'text-amber-300' : d < 0 ? 'text-emerald-400' : 'text-slate-300'}`}>
                          {d == null ? '—' : `${d > 0 ? '+' : ''}${d.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

const PALETA_LINHAS = ['#f59e0b', '#3b82f6', '#8b5cf6', '#10b981', '#f43f5e', '#06b6d4'];
