'use client';

/** NEXO — Investigações: alertas detectados ao vivo sobre os dados de Marília. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Crosshair,
  RefreshCw,
  TriangleAlert,
  ShieldQuestion,
  Scale,
  FileSearch,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { AnaliseResponse } from '@/app/api/nexo/analise/route';
import type { AlertasResponse } from '@/app/api/nexo/alertas/route';
import type { AlertaDetectado, Classificacao } from '@/lib/nexo/detectores';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { AlertaDetalhe } from '@/components/nexo/alerta-detalhe';

const EXERCICIOS = [2026, 2025, 2024];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

const CLASS_META: Record<Classificacao, { rotulo: string; cls: string }> = {
  critico: { rotulo: 'Crítico', cls: 'border-red-500/30 bg-red-500/10 text-red-300' },
  suspeita: { rotulo: 'Suspeita', cls: 'border-orange-500/30 bg-orange-500/10 text-orange-300' },
  atencao: { rotulo: 'Atenção', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  informativo: { rotulo: 'Informativo', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-300' },
};

function AlertaCard({
  alerta,
  onSelect,
}: {
  alerta: AlertaDetectado;
  onSelect: () => void;
}) {
  const meta = CLASS_META[alerta.classificacao];
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className="cursor-pointer border-white/5 bg-nexo-surface transition-colors hover:border-amber-500/20 hover:bg-[#14171f] focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
    >
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={`text-[10px] uppercase ${meta.cls}`}>
            {meta.rotulo}
          </Badge>
          <Badge variant="outline" className="border-white/10 font-mono text-[10px] text-slate-400">
            {alerta.detectorId}
          </Badge>
          <span className="text-[11px] text-slate-500">{alerta.categoria}</span>
          <span className="ml-auto font-mono text-xs text-amber-300">
            {brl(alerta.valorEnvolvido)}
          </span>
        </div>
        <CardTitle className="pt-1 text-sm leading-snug text-slate-200">
          {alerta.titulo}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs leading-relaxed text-slate-400">{alerta.descricao}</p>

        {/* Scores */}
        <div className="flex flex-wrap gap-4 text-[11px]">
          <ScorePill rotulo="Confiabilidade" valor={alerta.scores.confiabilidade} />
          <ScorePill rotulo="Prob. irregularidade" valor={alerta.scores.probabilidadeIrregularidade} />
        </div>

        {/* Evidências */}
        {alerta.evidencias.length > 0 && (
          <div className="rounded-md border border-white/5 bg-nexo-chrome p-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              <FileSearch className="h-3 w-3" /> Evidências ({alerta.evidencias.length})
            </p>
            <ul className="space-y-0.5">
              {alerta.evidencias.slice(0, 6).map((ev, i) => (
                <li key={i} className="flex justify-between gap-3 text-[11px] text-slate-400">
                  <span className="truncate">{ev.resumo}</span>
                  {ev.data && <span className="shrink-0 font-mono text-slate-400">{ev.data}</span>}
                </li>
              ))}
              {alerta.evidencias.length > 6 && (
                <li className="text-[11px] text-slate-400">
                  + {alerta.evidencias.length - 6} outras
                </li>
              )}
            </ul>
          </div>
        )}

        {/* Explicação */}
        <p className="text-[11px] leading-relaxed text-slate-500">{alerta.explicacao}</p>

        {/* Fundamento */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Scale className="h-3 w-3 text-slate-400" />
          {alerta.fundamentoLegal.map((f) => (
            <Badge key={f} variant="outline" className="border-white/10 text-[10px] text-slate-500">
              {f}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ScorePill({ rotulo, valor }: { rotulo: string; valor: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-slate-500">{rotulo}</span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/5">
        <div className="h-full bg-amber-500" style={{ width: `${valor}%` }} />
      </div>
      <span className="font-mono text-slate-300">{valor}</span>
    </div>
  );
}

/** Forma comum de exibição — `nexo_alertas` pré-computado ou `analise` ao vivo. */
interface VistaInvestigacoes {
  alertas: AlertaDetectado[];
  registros: number;
  diarias: number;
  totalEmpenhado: number;
  fornecedoresUnicos: number;
  valorSobAlerta: number;
  amostra: boolean;
  paginasLidas: number;
  totalPaginas: number;
  /** Origem da vista: alertas pré-computados ou re-análise sob demanda. */
  origem: 'pre-computado' | 'ao-vivo';
}

function vistaDeAnalise(j: AnaliseResponse): VistaInvestigacoes {
  return {
    alertas: j.alertas,
    registros: j.coleta.registros,
    diarias: j.coleta.diarias,
    totalEmpenhado: j.resumo.totalEmpenhado,
    fornecedoresUnicos: j.resumo.fornecedoresUnicos,
    valorSobAlerta: j.resumo.valorSobAlerta,
    amostra: j.coleta.amostra,
    paginasLidas: j.coleta.paginasLidas,
    totalPaginas: j.coleta.totalPaginas,
    origem: 'ao-vivo',
  };
}

function vistaDeAlertas(j: AlertasResponse): VistaInvestigacoes {
  return {
    alertas: j.alertas,
    registros: 0,
    diarias: 0,
    totalEmpenhado: 0,
    fornecedoresUnicos: 0,
    valorSobAlerta: j.alertas.reduce((s, a) => s + a.valorEnvolvido, 0),
    amostra: false,
    paginasLidas: 0,
    totalPaginas: 0,
    origem: 'pre-computado',
  };
}

export default function InvestigacoesPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<VistaInvestigacoes | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, setPendente] = useState(false);
  const [filtro, setFiltro] = useState<'todos' | Classificacao>('todos');
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);

  // Caminho primário: alertas PRÉ-COMPUTADOS de `nexo_alertas`. Se o monitor
  // ainda não rodou (`ingestao.status==='pendente'`), entra o estado honesto
  // e o usuário pode disparar a re-análise sob demanda.
  const carregar = useCallback(async (ano: number) => {
    setLoading(true);
    setErro(null);
    setPendente(false);
    try {
      const res = await nexoFetch(`/api/nexo/alertas?exercicio=${ano}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as AlertasResponse;
      if (json.ingestao.status === 'pendente') {
        setPendente(true);
        setData(null);
      } else {
        setData(vistaDeAlertas(json));
      }
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'erro desconhecido');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fallback de transição: re-análise sob demanda via `/api/nexo/analise`
  // (roda os detectores na hora) quando o pré-computado está pendente.
  const reanalisarAoVivo = useCallback(async (ano: number) => {
    setLoading(true);
    setErro(null);
    setPendente(false);
    try {
      const res = await nexoFetch(`/api/nexo/analise?exercicio=${ano}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(vistaDeAnalise((await res.json()) as AnaliseResponse));
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'erro desconhecido');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar(exercicio);
  }, [exercicio, carregar]);

  const alertasFiltrados = useMemo(() => {
    if (!data) return [];
    return filtro === 'todos'
      ? data.alertas
      : data.alertas.filter((a) => a.classificacao === filtro);
  }, [data, filtro]);

  return (
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Crosshair className="h-5 w-5 text-amber-400" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Investigações</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Indícios detectados sobre os empenhos da Prefeitura de Marília —
            pré-computados pelo monitor. Cada alerta é indício a apurar, nunca
            acusação.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => carregar(exercicio)}
          disabled={loading}
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <RefreshCw className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} />
          Atualizar
        </Button>
      </div>

      {/* Exercício */}
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-slate-500">Exercício</span>
        {EXERCICIOS.map((ano) => (
          <button
            key={ano}
            onClick={() => setExercicio(ano)}
            className={[
              'rounded-md px-3 py-1 text-sm transition-colors',
              ano === exercicio
                ? 'bg-amber-500/15 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30'
                : 'text-slate-400 hover:bg-white/5',
            ].join(' ')}
          >
            {ano}
          </button>
        ))}
      </div>

      {loading ? (
        <Card className="border-white/5 bg-nexo-surface">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <RefreshCw className="h-6 w-6 animate-spin text-amber-400" />
            <p className="text-sm text-slate-300">
              Carregando os indícios pré-computados pelo monitor…
            </p>
          </CardContent>
        </Card>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5">
          <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
            <TriangleAlert className="h-5 w-5" />
            Não foi possível carregar os indícios: {erro}
          </CardContent>
        </Card>
      ) : pendente ? (
        <Card className="border-amber-500/20 bg-nexo-surface">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <ShieldQuestion className="h-7 w-7 text-amber-400" />
            <p className="text-sm font-medium text-slate-200">
              O monitor ainda não rodou para {exercicio}
            </p>
            <p className="max-w-md text-xs leading-relaxed text-slate-500">
              Nenhum indício pré-computado em <code className="text-slate-400">nexo_alertas</code>.
              Rode a coleta para que o monitor compute os detectores — ou, como
              transição, faça uma re-análise sob demanda agora.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => reanalisarAoVivo(exercicio)}
              className="mt-1 border-amber-500/30 bg-transparent text-amber-300 hover:bg-amber-500/10"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Re-analisar sob demanda
            </Button>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* Banner de origem */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500">
            {data.origem === 'pre-computado' ? (
              <span>{data.alertas.length.toLocaleString('pt-BR')} indícios pré-computados pelo monitor</span>
            ) : (
              <>
                <span>{data.registros.toLocaleString('pt-BR')} empenhos analisados</span>
                <span>·</span>
                <span>{data.diarias.toLocaleString('pt-BR')} diárias</span>
                <span>·</span>
                <span>total {brl(data.totalEmpenhado)}</span>
                <span>·</span>
                <span>{data.fornecedoresUnicos.toLocaleString('pt-BR')} fornecedores</span>
              </>
            )}
            {data.origem === 'ao-vivo' && (
              <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300">
                re-análise sob demanda
              </Badge>
            )}
            {data.amostra && (
              <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300">
                amostra — {data.paginasLidas}/{data.totalPaginas} páginas
              </Badge>
            )}
          </div>

          {/* KPIs */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Kpi rotulo="Alertas" valor={String(data.alertas.length)} icon={ShieldQuestion} />
            <Kpi rotulo="Valor sob alerta" valor={brl(data.valorSobAlerta)} icon={TriangleAlert} />
            <Kpi
              rotulo="Críticos / suspeitas"
              valor={String(
                data.alertas.filter((a) => a.classificacao === 'critico' || a.classificacao === 'suspeita').length,
              )}
              icon={Crosshair}
            />
          </div>

          {/* Filtros */}
          <div className="flex flex-wrap gap-2">
            {(['todos', 'critico', 'suspeita', 'atencao'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFiltro(f)}
                className={[
                  'rounded-md px-3 py-1 text-xs transition-colors',
                  filtro === f
                    ? 'bg-amber-500/15 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30'
                    : 'text-slate-400 hover:bg-white/5',
                ].join(' ')}
              >
                {f === 'todos' ? 'Todos' : CLASS_META[f].rotulo}
              </button>
            ))}
          </div>

          {/* Lista */}
          {alertasFiltrados.length === 0 ? (
            <div className="rounded-md border border-dashed border-white/10 py-12 text-center text-sm text-slate-500">
              Nenhum alerta nesta classificação para {exercicio}.
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {alertasFiltrados.map((a, i) => (
                <AlertaCard
                  key={`${a.detectorId}-${a.sujeitoId}-${i}`}
                  alerta={a}
                  onSelect={() => setAlertaSel(a)}
                />
              ))}
            </div>
          )}
        </>
      ) : null}

      <AlertaDetalhe alerta={alertaSel} onClose={() => setAlertaSel(null)} />
    </div>
  );
}

function Kpi({
  rotulo,
  valor,
  icon: Icon,
}: {
  rotulo: string;
  valor: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="border-white/5 bg-nexo-surface">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-slate-400">{rotulo}</CardTitle>
        <Icon className="h-4 w-4 text-amber-400/70" />
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold text-slate-100">{valor}</div>
      </CardContent>
    </Card>
  );
}
