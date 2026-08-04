'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Radar, Database, Target, Crosshair, Gauge, ShieldAlert,
  Building2, ScrollText, HardHat, Users, ClipboardList,
  AlertTriangle, ChevronRight, CircleCheck, CircleX,
  RefreshCw, TriangleAlert, Wallet, Landmark,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { NexoStatusResponse } from '@/app/api/nexo/status/route';
import type { AnaliseResponse } from '@/app/api/nexo/analise/route';
import type { AlertasResponse } from '@/app/api/nexo/alertas/route';
import type { AlertaDetectado, Classificacao } from '@/lib/nexo/detectores';
import { compararPotencial } from '@/lib/nexo/prioridade';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { NexoStagger, NexoItem } from '@/components/nexo/ui/nexo-motion';
import { AlertaDetalhe } from '@/components/nexo/alerta-detalhe';
import { ScoreGauge } from '@/components/nexo/score-gauge';
import { CompilarBotao, BadgeAtualizado } from '@/components/nexo/NexoTarefaTracker';

const EXERCICIOS = [2026, 2025, 2024];

interface KpiDef {
  label: string;
  valor: string;
  detalhe: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SUBSISTEMAS = [
  { href: '/nexo/metas-fiscais', label: 'Metas Fiscais', icon: Gauge, nota: 'Operacional' },
  { href: '/nexo/empresas-sancionadas', label: 'Empresas Sancionadas', icon: ShieldAlert, nota: 'Operacional' },
  { href: '/nexo/investigacoes', label: 'Investigações', icon: Crosshair, nota: 'Operacional' },
  { href: '/nexo/fornecedores', label: 'Fornecedores', icon: Building2, nota: 'Operacional' },
  { href: '/nexo/coleta', label: 'Coleta & Fontes', icon: Database, nota: 'Operacional' },
  { href: '/nexo/contratos', label: 'Contratos & Licitações', icon: ScrollText, nota: 'Operacional' },
  { href: '/nexo/emendas', label: 'Emendas Parlamentares', icon: Landmark, nota: 'Operacional' },
  { href: '/nexo/obras', label: 'Obras', icon: HardHat, nota: 'Fase 2' },
  { href: '/nexo/folha', label: 'Folha & Terceirizados', icon: Users, nota: 'Fase 2' },
  { href: '/nexo/briefing', label: 'Briefing de Assessoria', icon: ClipboardList, nota: 'Operacional' },
];


function classeBadgeClass(classe: Classificacao): string {
  if (classe === 'critico') return 'border-red-500/30 bg-red-500/10 text-red-300';
  if (classe === 'suspeita') return 'border-orange-500/30 bg-orange-500/10 text-orange-300';
  if (classe === 'atencao') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-slate-500/30 bg-slate-500/10 text-slate-300';
}

/** Rótulo humano da classificação (sem expor o enum cru ao operador). */
function classeLabel(classe: Classificacao): string {
  if (classe === 'critico') return 'Crítico';
  if (classe === 'suspeita') return 'Suspeita';
  if (classe === 'atencao') return 'Atenção';
  return 'Informativo';
}

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

/** Vista do painel — alertas pré-computados ou re-análise sob demanda. */
interface VistaPainel {
  alertas: AlertaDetectado[];
  qtdAlertas: number;
  valorSobAlerta: number;
  totalEmpenhado: number;
  registros: number;
  amostra: boolean;
  paginasLidas: number;
  totalPaginas: number;
  origem: 'pre-computado' | 'ao-vivo';
}

function vistaPainelAnalise(j: AnaliseResponse): VistaPainel {
  return {
    alertas: j.alertas,
    qtdAlertas: j.resumo.alertas,
    valorSobAlerta: j.resumo.valorSobAlerta,
    totalEmpenhado: j.resumo.totalEmpenhado,
    registros: j.coleta.registros,
    amostra: j.coleta.amostra,
    paginasLidas: j.coleta.paginasLidas,
    totalPaginas: j.coleta.totalPaginas,
    origem: 'ao-vivo',
  };
}

function vistaPainelAlertas(j: AlertasResponse): VistaPainel {
  return {
    alertas: j.alertas,
    // Contagem e valor vêm dos AGREGADOS do servidor (sobre todo o recorte) —
    // `j.alertas` agora traz só o topo por potencial (payload limitado), então
    // derivar do array daria números truncados.
    qtdAlertas: j.total,
    valorSobAlerta: j.valorSobAlerta,
    totalEmpenhado: 0,
    registros: 0,
    amostra: false,
    paginasLidas: 0,
    totalPaginas: 0,
    origem: 'pre-computado',
  };
}

export default function NexoPainelPage() {
  const [exercicio, setExercicio] = useState(EXERCICIOS[0]);
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);
  const [modoAoVivo, setModoAoVivo] = useState(false);

  const { data: status, isLoading: loadingStatus } = useQuery({
    queryKey: ['nexo-status'],
    queryFn: async () => {
      const res = await nexoFetch('/api/nexo/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as NexoStatusResponse;
    },
  });

  const analiseQuery = useQuery({
    queryKey: modoAoVivo ? ['nexo-analise', exercicio] : ['nexo-alertas', exercicio],
    queryFn: async () => {
      const url = modoAoVivo
        ? `/api/nexo/analise?exercicio=${exercicio}`
        : `/api/nexo/alertas?exercicio=${exercicio}`;
      const res = await nexoFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (modoAoVivo) {
        const json = (await res.json()) as AnaliseResponse;
        return { pendente: false, geradoEm: null, ...vistaPainelAnalise(json) };
      }
      const json = (await res.json()) as AlertasResponse;
      if (json.ingestao.status === 'pendente') {
        return { pendente: true, geradoEm: null } as const;
      }
      return {
        pendente: false,
        geradoEm: json.ingestao.ultimaDeteccaoEm ?? json.atualizadoEm ?? null,
        ...vistaPainelAlertas(json),
      };
    },
  });

  const { data: analise, isLoading: loadingAnalise, isError, error: analiseErro, refetch: recarregarAnalise } = analiseQuery;
  const erroAnalise = isError ? (analiseErro instanceof Error ? analiseErro.message : 'erro desconhecido') : null;
  const geradoEm = analise && !analise.pendente ? analise.geradoEm : null;
  const pendenteAnalise = analise?.pendente === true;

  const fontesConectadas = status
    ? [status.fontes.smarapd.conectado, status.fontes.siconfi.conectado].filter(Boolean).length
    : 0;

  const indiciosPrioritarios: AlertaDetectado[] = useMemo(() => {
    if (!analise || analise.pendente) return [];
    return [...analise.alertas].sort(compararPotencial).slice(0, 3);
  }, [analise]);

  const alertasPorDetector = useMemo(() => {
    if (!analise || analise.pendente) return [];
    const map = new Map<string, number>();
    for (const a of analise.alertas) {
      map.set(a.detectorId, (map.get(a.detectorId) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([detectorId, qtd]) => ({ detectorId, qtd }))
      .sort((a, b) => b.qtd - a.qtd)
      .slice(0, 12);
  }, [analise]);

  const kpis: KpiDef[] = [
    {
      label: 'Fontes conectadas',
      valor: loadingStatus ? '—' : `${fontesConectadas}/2`,
      detalhe: 'SMARAPD · SICONFI',
      icon: Database,
    },
    {
      label: 'Indícios no exercício',
      valor: loadingAnalise
        ? '—'
        : erroAnalise || pendenteAnalise
          ? '—'
          : String(analise?.qtdAlertas ?? 0),
      detalhe: erroAnalise
        ? 'análise indisponível'
        : pendenteAnalise
          ? 'monitor ainda não rodou'
          : analise
            ? analise.origem === 'pre-computado'
              ? 'indícios pré-computados'
              : `${analise.registros.toLocaleString('pt-BR')} empenhos analisados`
            : '—',
      icon: AlertTriangle,
    },
    {
      label: 'Valor sob alerta',
      valor:
        loadingAnalise || erroAnalise || pendenteAnalise || !analise
          ? '—'
          : brl(analise.valorSobAlerta),
      detalhe:
        !loadingAnalise && !erroAnalise && !pendenteAnalise && analise
          ? analise.origem === 'pre-computado'
            ? 'soma dos indícios ativos'
            : `de ${brl(analise.totalEmpenhado)} empenhados`
          : pendenteAnalise
            ? 'monitor ainda não rodou'
            : '—',
      icon: Wallet,
    },
    { label: 'Alvo de investigação', valor: 'Marília/SP', detalhe: 'Prefeitura · IBGE 3529005', icon: Target },
  ];

  return (
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Radar className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Painel de Situação
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Sala de situação de fiscalização parlamentar. Coleta, cruza e detecta
            padrões atípicos na gestão da Prefeitura de Marília — sempre como
            indício a apurar, nunca como acusação.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => recarregarAnalise()}
              disabled={loadingAnalise}
              aria-label="Recarregar indícios do exercício"
              title="Recarregar os indícios do exercício selecionado"
              className="inline-flex shrink-0 items-center gap-2 rounded-md border border-white/10 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40 disabled:opacity-50"
            >
              <RefreshCw className={'h-4 w-4' + (loadingAnalise ? ' animate-spin' : '')} aria-hidden="true" />
              Recarregar
            </button>
            {/* Compila/recompila o snapshot de indícios em background (Frente E). */}
            <CompilarBotao
              tipo="alertas"
              alvo=""
              exercicio={exercicio}
              rotulo={geradoEm ? 'Recompilar' : 'Compilar'}
            />
          </div>
          <BadgeAtualizado geradoEm={geradoEm} />
        </div>
      </div>

      {/* Exercício */}
      <div className="flex items-center gap-2" role="group" aria-label="Selecionar exercício">
        <span className="text-xs uppercase tracking-wide text-slate-500">Exercício</span>
        {EXERCICIOS.map((ano) => (
          <button
            key={ano}
            type="button"
            aria-pressed={ano === exercicio}
            onClick={() => setExercicio(ano)}
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

      {/* KPIs */}
      <NexoStagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <NexoItem key={kpi.label}>
              <Card className="h-full border-white/5 bg-nexo-surface">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-xs font-medium text-slate-400">
                    {kpi.label}
                  </CardTitle>
                  <Icon className="h-4 w-4 text-amber-400/70" aria-hidden="true" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-slate-100">{kpi.valor}</div>
                  <p className="text-xs text-slate-500">{kpi.detalhe}</p>
                </CardContent>
              </Card>
            </NexoItem>
          );
        })}
      </NexoStagger>

      {/* Gráfico de alertas por detector */}
      {alertasPorDetector.length > 0 && (
        <Card className="border-white/5 bg-nexo-surface">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-slate-200">
              <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden="true" />
              Alertas por detector
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={alertasPorDetector} margin={{ top: 0, right: 0, left: -16, bottom: 0 }}>
                <XAxis
                  dataKey="detectorId"
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                  axisLine={{ stroke: '#ffffff10' }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #ffffff20', borderRadius: 6, fontSize: 13 }}
                  labelStyle={{ color: '#f1f5f9' }}
                  formatter={(value: number) => [value, 'Alertas']}
                />
                <Bar dataKey="qtd" fill="#f59e0b" radius={[3, 3, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Estado das fontes */}
      <Card className="border-white/5 bg-nexo-surface">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-200">
            <Database className="h-4 w-4 text-amber-400" aria-hidden="true" />
            Estado das fontes de dados
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {loadingStatus ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : (
            <>
              <FonteRow
                nome="Portal da Transparência (SMARAPD)"
                ok={status?.fontes.smarapd.conectado ?? false}
                detalhe={
                  status?.fontes.smarapd.conectado
                    ? `${status.fontes.smarapd.modulos ?? '—'} módulos disponíveis`
                    : status?.fontes.smarapd.erro ?? 'sem resposta'
                }
              />
              <FonteRow
                nome="SICONFI / Tesouro Nacional"
                ok={status?.fontes.siconfi.conectado ?? false}
                detalhe={
                  status?.fontes.siconfi.conectado
                    ? 'RREO / RGF / DCA acessíveis'
                    : status?.fontes.siconfi.erro ?? 'sem resposta'
                }
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* Indícios prioritários — alertas pré-computados de /api/nexo/alertas */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden="true" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
            Indícios prioritários — a apurar
          </h2>
        </div>

        {loadingAnalise ? (
          <div className="grid gap-4 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="border-white/5 bg-nexo-surface">
                <CardHeader className="pb-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="mt-3 h-4 w-full" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-12 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : erroAnalise ? (
          <Card className="border-red-500/20 bg-red-500/5" role="alert">
            <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
              <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              Não foi possível carregar os indícios de {exercicio}: {erroAnalise}
            </CardContent>
          </Card>
        ) : pendenteAnalise ? (
          <Card className="border-amber-500/20 bg-nexo-surface">
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <Database className="h-7 w-7 text-amber-400" aria-hidden="true" />
              <p className="text-sm font-medium text-slate-200">
                O monitor ainda não rodou para {exercicio}
              </p>
              <p className="max-w-md text-xs leading-relaxed text-slate-500">
                Nenhum indício pré-computado em{' '}
                <code className="text-slate-400">nexo_alertas</code>. Rode a
                coleta para o monitor computar os detectores — ou faça uma
                re-análise sob demanda agora.
              </p>
              <button
                type="button"
                onClick={() => { setModoAoVivo(true); recarregarAnalise(); }}
                disabled={loadingAnalise}
                className="mt-1 inline-flex items-center gap-2 rounded-md border border-amber-500/30 px-3 py-1.5 text-sm text-amber-300 transition-colors hover:bg-amber-500/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40 disabled:opacity-50"
              >
                <RefreshCw className={'h-4 w-4' + (loadingAnalise ? ' animate-spin' : '')} aria-hidden="true" />
                Re-analisar sob demanda
              </button>
            </CardContent>
          </Card>
        ) : indiciosPrioritarios.length === 0 ? (
          <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
            Nenhum indício detectado no exercício de {exercicio}.
          </div>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-3">
              {indiciosPrioritarios.map((ind, i) => (
                <Card
                  key={`${ind.detectorId}-${ind.sujeitoId}-${i}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`Abrir detalhe do indício: ${ind.titulo}`}
                  onClick={() => setAlertaSel(ind)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setAlertaSel(ind);
                    }
                  }}
                  className="cursor-pointer border-white/5 bg-nexo-surface transition-colors hover:border-amber-500/20 hover:bg-[#14171f] focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <Badge
                        variant="outline"
                        className={`text-[10px] uppercase ${classeBadgeClass(ind.classificacao)}`}
                      >
                        {classeLabel(ind.classificacao)}
                      </Badge>
                      <span className="font-mono text-xs text-amber-300">
                        {ind.valorEnvolvido > 0 ? brl(ind.valorEnvolvido) : 'a apurar'}
                      </span>
                    </div>
                    <CardTitle className="pt-2 text-sm leading-snug text-slate-200">
                      {ind.titulo}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <ScoreGauge
                      confiabilidade={ind.scores.confiabilidade}
                      probabilidadeIrregularidade={ind.scores.probabilidadeIrregularidade}
                      probabilidadeEnquadramento={ind.scores.probabilidadeEnquadramento}
                      size="sm"
                    />
                    <p className="text-xs leading-relaxed text-slate-400">{ind.descricao}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="text-[11px] text-slate-400">
                {analise?.origem === 'pre-computado'
                  ? `Indícios pré-computados pelo monitor para ${exercicio}`
                  : `Indícios da re-análise sob demanda dos dados de ${exercicio}`}
                {analise?.amostra
                  ? ` (amostra — ${analise.paginasLidas}/${analise.totalPaginas} páginas)`
                  : ''}
                . Cada um requer apuração documental antes de qualquer juízo de valor.
              </p>
              <div className="flex gap-3">
                <Link
                  href="/nexo/investigacoes"
                  className="inline-flex items-center gap-1 rounded text-[11px] text-slate-500 transition-colors hover:text-amber-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                >
                  {(analise?.qtdAlertas ?? 0) === 1
                    ? 'Ver o indício'
                    : `Ver todos os ${analise?.qtdAlertas ?? 0} indícios`}
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
                <Link
                  href="/nexo/detectores"
                  className="inline-flex items-center gap-1 rounded text-[11px] text-slate-500 transition-colors hover:text-amber-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                >
                  Catálogo de detectores
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Subsistemas */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-300">
          Subsistemas
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SUBSISTEMAS.map((s) => {
            const Icon = s.icon;
            return (
              <Link
                key={s.href}
                href={s.href}
                aria-label={`Abrir subsistema ${s.label} (${s.nota})`}
                className="group flex items-center gap-3 rounded-lg border border-white/5 bg-nexo-surface p-3 transition-colors hover:border-amber-500/20 hover:bg-[#14171f] focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-400">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-200">{s.label}</p>
                  <p className="text-[11px] text-slate-500">{s.nota}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-slate-400 transition-colors group-hover:text-amber-400" aria-hidden="true" />
              </Link>
            );
          })}
        </div>
      </div>

      <AlertaDetalhe alerta={alertaSel} onClose={() => setAlertaSel(null)} />
    </div>
  );
}

function FonteRow({ nome, ok, detalhe }: { nome: string; ok: boolean; detalhe: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
      <div className="flex items-center gap-3">
        {ok ? (
          <CircleCheck className="h-4 w-4 text-emerald-400" aria-hidden="true" />
        ) : (
          <CircleX className="h-4 w-4 text-red-400" aria-hidden="true" />
        )}
        <span className="text-sm text-slate-200">
          {nome}
          <span className="sr-only">{ok ? ' — conectado' : ' — sem conexão'}</span>
        </span>
      </div>
      <span className="text-xs text-slate-500">{detalhe}</span>
    </div>
  );
}
