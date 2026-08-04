'use client';

/** NEXO — Briefing de Assessoria: digest priorizado dos indícios. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ClipboardList,
  RefreshCw,
  TriangleAlert,
  Flame,
  FileBarChart,
  ChevronRight,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { AnaliseResponse } from '@/app/api/nexo/analise/route';
import type { AlertasResponse } from '@/app/api/nexo/alertas/route';
import type { AlertaDetectado } from '@/lib/nexo/detectores';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { AlertaDetalhe } from '@/components/nexo/alerta-detalhe';

const EXERCICIOS = [2026, 2025, 2024];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

const CLASS_CLS: Record<string, string> = {
  critico: 'border-red-500/30 bg-red-500/10 text-red-300',
  suspeita: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  atencao: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  informativo: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
};

/** Vista comum do briefing — `nexo_alertas` pré-computado ou `analise` ao vivo. */
interface VistaBriefing {
  alertas: AlertaDetectado[];
  registros: number;
  diarias: number;
  qtdAlertas: number;
  valorSobAlerta: number;
  origem: 'pre-computado' | 'ao-vivo';
}

function vistaAnaliseBriefing(j: AnaliseResponse): VistaBriefing {
  return {
    alertas: j.alertas,
    registros: j.coleta.registros,
    diarias: j.coleta.diarias,
    qtdAlertas: j.resumo.alertas,
    valorSobAlerta: j.resumo.valorSobAlerta,
    origem: 'ao-vivo',
  };
}

function vistaAlertasBriefing(j: AlertasResponse): VistaBriefing {
  return {
    alertas: j.alertas,
    registros: 0,
    diarias: 0,
    qtdAlertas: j.alertas.length,
    valorSobAlerta: j.alertas.reduce((s, a) => s + a.valorEnvolvido, 0),
    origem: 'pre-computado',
  };
}

export default function BriefingPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<VistaBriefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, setPendente] = useState(false);
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);

  const reqId = useRef(0);

  // Caminho primário: o briefing é compilado dos alertas PRÉ-COMPUTADOS de
  // `nexo_alertas`. Se o monitor ainda não rodou, ativa o estado honesto.
  const carregar = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    setPendente(false);
    try {
      const res = await nexoFetch(`/api/nexo/alertas?exercicio=${ano}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as AlertasResponse;
      if (id !== reqId.current) return;
      if (json.ingestao.status === 'pendente') {
        setPendente(true);
        setData(null);
      } else {
        setData(vistaAlertasBriefing(json));
      }
    } catch (err) {
      if (id === reqId.current) {
        setErro(err instanceof Error ? err.message : 'erro desconhecido');
        setData(null);
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  // Fallback de transição: compila o briefing de uma re-análise sob demanda.
  const reanalisarAoVivo = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    setPendente(false);
    try {
      const res = await nexoFetch(`/api/nexo/analise?exercicio=${ano}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as AnaliseResponse;
      if (id === reqId.current) setData(vistaAnaliseBriefing(json));
    } catch (err) {
      if (id === reqId.current) {
        setErro(err instanceof Error ? err.message : 'erro desconhecido');
        setData(null);
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar(exercicio);
  }, [exercicio, carregar]);

  const prioridades = useMemo(() => {
    if (!data) return [];
    return data.alertas
      .filter((a) => a.classificacao === 'critico' || a.classificacao === 'suspeita')
      .slice(0, 6);
  }, [data]);

  const porArea = useMemo(() => {
    if (!data) return [];
    const mapa = new Map<string, { n: number; valor: number }>();
    for (const a of data.alertas) {
      const cur = mapa.get(a.categoria) ?? { n: 0, valor: 0 };
      cur.n += 1;
      cur.valor += a.valorEnvolvido;
      mapa.set(a.categoria, cur);
    }
    return [...mapa.entries()]
      .map(([categoria, d]) => ({ categoria, ...d }))
      .sort((a, b) => b.valor - a.valor);
  }, [data]);

  const hoje = new Date().toLocaleDateString('pt-BR');

  return (
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-amber-400" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Briefing de Assessoria
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Digest priorizado do que o monitoramento encontrou na gestão da
            Prefeitura de Marília — em linguagem direta, sempre como indício a
            apurar. Gerado em {hoje}.
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
            <p className="text-sm text-slate-300">Compilando o briefing…</p>
          </CardContent>
        </Card>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5">
          <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
            <TriangleAlert className="h-5 w-5" />
            Não foi possível gerar o briefing: {erro}
          </CardContent>
        </Card>
      ) : pendente ? (
        <Card className="border-amber-500/20 bg-nexo-surface">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <ClipboardList className="h-7 w-7 text-amber-400" />
            <p className="text-sm font-medium text-slate-200">
              Sem briefing para {exercicio} — o monitor ainda não rodou
            </p>
            <p className="max-w-md text-xs leading-relaxed text-slate-500">
              Nenhum indício pré-computado em <code className="text-slate-400">nexo_alertas</code>.
              Rode a coleta para o monitor compilar o briefing — ou, como
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
          {/* Resumo */}
          <Card className="border-amber-500/20 bg-nexo-surface">
            <CardContent className="pt-6">
              <p className="text-sm leading-relaxed text-slate-300">
                {data.origem === 'pre-computado' ? (
                  <>
                    O monitoramento de <strong className="text-slate-100">{exercicio}</strong>{' '}
                    pré-computou{' '}
                    <strong className="text-amber-300">{data.qtdAlertas} indícios</strong>{' '}
                    a apurar, envolvendo{' '}
                    <strong className="text-amber-300">{brl(data.valorSobAlerta)}</strong>.
                    Abaixo, o que merece atenção primeiro.
                  </>
                ) : (
                  <>
                    A re-análise sob demanda de{' '}
                    <strong className="text-slate-100">{exercicio}</strong> sobre{' '}
                    {data.registros.toLocaleString('pt-BR')} empenhos e{' '}
                    {data.diarias.toLocaleString('pt-BR')} diárias apontou{' '}
                    <strong className="text-amber-300">{data.qtdAlertas} indícios</strong>{' '}
                    a apurar, envolvendo{' '}
                    <strong className="text-amber-300">{brl(data.valorSobAlerta)}</strong>.
                    Abaixo, o que merece atenção primeiro.
                  </>
                )}
              </p>
            </CardContent>
          </Card>

          {/* Prioridades */}
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Flame className="h-4 w-4 text-amber-400" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
                Apurar primeiro
              </h2>
            </div>
            {prioridades.length === 0 ? (
              <div className="rounded-md border border-dashed border-white/10 py-8 text-center text-sm text-slate-500">
                Nenhum indício crítico ou suspeito neste exercício.
              </div>
            ) : (
              <ol className="space-y-2">
                {prioridades.map((a, i) => (
                  <li
                    key={`${a.detectorId}-${a.sujeitoId}-${i}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setAlertaSel(a)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setAlertaSel(a);
                      }
                    }}
                    className="flex cursor-pointer items-start gap-3 rounded-md border border-white/5 bg-nexo-surface p-3 transition-colors hover:border-amber-500/20 hover:bg-[#14171f] focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                  >
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-amber-500/10 font-mono text-xs text-amber-300">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className={`text-[10px] uppercase ${CLASS_CLS[a.classificacao]}`}>
                          {a.classificacao}
                        </Badge>
                        <span className="text-sm font-medium text-slate-200">{a.titulo}</span>
                        <span className="ml-auto font-mono text-xs text-amber-300">
                          {brl(a.valorEnvolvido)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-400">{a.descricao}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* Por área */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                <FileBarChart className="h-4 w-4 text-amber-400" />
                Indícios por área
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {porArea.map((area) => (
                <div key={area.categoria} className="flex items-center justify-between text-sm">
                  <span className="text-slate-300">{area.categoria}</span>
                  <span className="text-slate-500">
                    {area.n} indício{area.n !== 1 ? 's' : ''} · {brl(area.valor)}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Link
            href="/nexo/dossies"
            className="inline-flex items-center gap-1 text-xs text-slate-500 transition-colors hover:text-amber-400"
          >
            Gerar dossiês e minutas de requerimento
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </>
      ) : null}

      <AlertaDetalhe alerta={alertaSel} onClose={() => setAlertaSel(null)} />
    </div>
  );
}
