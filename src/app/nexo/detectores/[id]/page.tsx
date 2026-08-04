'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, AlertTriangle, Gauge,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis,
} from 'recharts';
import type { AlertasResponse } from '@/app/api/nexo/alertas/route';
import type { AlertaDetectado, Classificacao } from '@/lib/nexo/detectores';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { ScoreGauge } from '@/components/nexo/score-gauge';
import { AlertaDetalhe } from '@/components/nexo/alerta-detalhe';

const EXERCICIOS = [2026, 2025, 2024];
const CLASS_CORES: Record<Classificacao, string> = {
  critico: '#ef4444',
  suspeita: '#f97316',
  atencao: '#f59e0b',
  informativo: '#64748b',
};

function classeBadge(classe: Classificacao): string {
  const m: Record<Classificacao, string> = {
    critico: 'border-red-500/30 bg-red-500/10 text-red-300',
    suspeita: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
    atencao: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    informativo: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
  };
  return m[classe];
}

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

export default function DetectorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const detectorId = (id ?? '').toUpperCase();
  const [exercicio, setExercicio] = useState(EXERCICIOS[0]);
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['nexo-alertas', exercicio],
    queryFn: async () => {
      const res = await nexoFetch(`/api/nexo/alertas?exercicio=${exercicio}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as AlertasResponse;
    },
  });

  const alertasDoDetector = useMemo(() => {
    if (!data) return [];
    return data.alertas.filter((a) => a.detectorId === detectorId);
  }, [data, detectorId]);

  const porClassificacao = useMemo(() => {
    const map = new Map<Classificacao, number>();
    for (const a of alertasDoDetector) {
      map.set(a.classificacao, (map.get(a.classificacao) ?? 0) + 1);
    }
    return [...map.entries()].map(([name, value]) => ({ name, value }));
  }, [alertasDoDetector]);

  const maiorValor = alertasDoDetector.reduce((s, a) => s + a.valorEnvolvido, 0);
  const nome = alertasDoDetector[0]?.detectorNome ?? detectorId;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/nexo"
          className="inline-flex items-center gap-1 rounded text-sm text-slate-400 transition-colors hover:text-amber-400"
        >
          <ArrowLeft className="h-4 w-4" /> Voltar
        </Link>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-amber-400" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">{nome}</h1>
            <Badge variant="outline" className="border-white/10 font-mono text-xs text-slate-400">{detectorId}</Badge>
          </div>
          <p className="mt-1 text-sm text-slate-400">{alertasDoDetector[0]?.categoria ?? 'Detector NEXO'}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          {EXERCICIOS.map((ano) => (
            <button
              key={ano}
              type="button"
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
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-32 rounded-lg bg-nexo-surface" />)}
        </div>
      ) : alertasDoDetector.length === 0 ? (
        <Card className="border-white/5 bg-nexo-surface">
          <CardContent className="py-10 text-center text-sm text-slate-500">
            Nenhum alerta do detector {detectorId} em {exercicio}.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="border-white/5 bg-nexo-surface">
              <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-slate-400">Alertas</CardTitle></CardHeader>
              <CardContent><div className="text-2xl font-bold text-slate-100">{alertasDoDetector.length}</div></CardContent>
            </Card>
            <Card className="border-white/5 bg-nexo-surface">
              <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-slate-400">Valor envolvido</CardTitle></CardHeader>
              <CardContent><div className="text-2xl font-bold text-slate-100">{brl(maiorValor)}</div></CardContent>
            </Card>
            <Card className="border-white/5 bg-nexo-surface">
              <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-slate-400">Classificação</CardTitle></CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1">
                  {porClassificacao.map((c) => (
                    <Badge key={c.name} variant="outline" className={classeBadge(c.name)}>
                      {c.name}: {c.value}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="border-white/5 bg-nexo-surface">
              <CardHeader><CardTitle className="flex items-center gap-2 text-sm text-slate-200"><PieChart className="h-4 w-4 text-amber-400" /> Distribuição</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={porClassificacao} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, value }) => `${name}: ${value}`}>
                      {porClassificacao.map((e, i) => <Cell key={i} fill={CLASS_CORES[e.name]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="border-white/5 bg-nexo-surface">
              <CardHeader><CardTitle className="flex items-center gap-2 text-sm text-slate-200"><BarChart className="h-4 w-4 text-amber-400" /> Valor por alerta</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={alertasDoDetector.slice(0, 10)} layout="vertical" margin={{ left: -16, right: 8 }}>
                    <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="sujeitoRotulo" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={100} />
                    <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #ffffff20', borderRadius: 6, fontSize: 12 }} />
                    <Bar dataKey="valorEnvolvido" fill="#f59e0b" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader><CardTitle className="flex items-center gap-2 text-sm text-slate-200"><AlertTriangle className="h-4 w-4 text-amber-400" /> Alertas ({alertasDoDetector.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {alertasDoDetector.map((a, i) => (
                <div
                  key={`${a.detectorId}-${a.sujeitoId}-${i}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setAlertaSel(a)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAlertaSel(a); } }}
                  className="cursor-pointer rounded-md border border-white/5 bg-nexo-chrome p-3 transition-colors hover:border-amber-500/20"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`text-[10px] uppercase ${classeBadge(a.classificacao)}`}>{a.classificacao}</Badge>
                        <span className="text-xs text-slate-500">{a.sujeitoRotulo}</span>
                      </div>
                      <p className="mt-1 text-sm text-slate-200">{a.titulo}</p>
                      <ScoreGauge
                        confiabilidade={a.scores.confiabilidade}
                        probabilidadeIrregularidade={a.scores.probabilidadeIrregularidade}
                        size="sm"
                      />
                    </div>
                    <span className="shrink-0 font-mono text-xs text-amber-300">{a.valorEnvolvido > 0 ? brl(a.valorEnvolvido) : ''}</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}

      <AlertaDetalhe alerta={alertaSel} onClose={() => setAlertaSel(null)} />
    </div>
  );
}
