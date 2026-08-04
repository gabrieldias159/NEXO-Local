'use client';

/**
 * CONTRAPROVA DOCUMENTAL — cards e gráfico computados direto dos DOCUMENTOS de
 * empenho do Portal da Transparência (nº de empenho, movimentos, anulações),
 * lado a lado com a medição oficial SICONFI do mesmo exercício.
 *
 * Propósito: dar ao usuário uma verificação independente — se a soma dos
 * documentos diverge muito do RREO, ou uma fonte está atrasada ou há dado
 * faltando. As diferenças de período/escopo são declaradas na própria UI.
 */
import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { FileCheck2, Loader2, TriangleAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import type { ContraprovaResponse } from '@/app/api/nexo/empenhos-contraprova/route';
import type { MetasFiscaisResponse } from '@/app/api/nexo/metas-fiscais/route';

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}
function brlCompacto(v: number | null): string {
  if (v == null) return '—';
  if (Math.abs(v) >= 1_000_000_000) {
    return `R$ ${(v / 1_000_000_000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} bi`;
  }
  return `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
}

interface TooltipPayloadItem {
  payload?: ContraprovaResponse['seriePorMes'][number];
}

/** Tooltip por barra: empenhado líquido + detalhamento de movimentos/anulações. */
function TooltipBarra({ active, payload }: { active?: boolean; payload?: TooltipPayloadItem[] }) {
  const p = active && payload?.[0]?.payload;
  if (!p) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-slate-950/95 p-3 text-xs shadow-xl backdrop-blur-md">
      <div className="font-semibold text-slate-100">{p.nomeCurto}</div>
      <div className="mt-1 space-y-0.5 text-slate-300">
        <div>Empenhado líquido: <span className="font-mono text-amber-300">{brl(p.empenhadoLiquido)}</span></div>
        <div>Movimentos no mês: {p.movimentos.toLocaleString('pt-BR')}</div>
        {p.anulado > 0 && (
          <div className="text-slate-400">Anulações no mês: −{brl(p.anulado)}</div>
        )}
      </div>
    </div>
  );
}

export function ContraprovaDocumental({ exercicio }: { exercicio: number }) {
  const [data, setData] = useState<ContraprovaResponse | null>(null);
  const [siconfi, setSiconfi] = useState<MetasFiscaisResponse['execucao'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    setLoading(true);
    setErro(null);
    nexoFetch(`/api/nexo/empenhos-contraprova?exercicio=${exercicio}`)
      .then((r) => (r.ok ? (r.json() as Promise<ContraprovaResponse>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (!cancelado) setData(j);
      })
      .catch((e) => {
        if (!cancelado) setErro(e instanceof Error ? e.message : 'erro');
      })
      .finally(() => {
        if (!cancelado) setLoading(false);
      });
    // SICONFI para o comparativo — best-effort, a seção degrada sem ele.
    nexoFetch(`/api/nexo/metas-fiscais?exercicio=${exercicio}`)
      .then((r) => (r.ok ? (r.json() as Promise<MetasFiscaisResponse>) : Promise.reject()))
      .then((j) => {
        if (!cancelado) setSiconfi(j.execucao ?? null);
      })
      .catch(() => {
        if (!cancelado) setSiconfi(null);
      });
    return () => {
      cancelado = true;
    };
  }, [exercicio]);

  if (loading && !data) {
    return (
      <Card className="border-white/5 bg-nexo-chrome">
        <CardContent className="flex items-center gap-2 py-6 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Computando contraprova documental…
        </CardContent>
      </Card>
    );
  }
  if (erro || !data) {
    return (
      <Card className="border-red-500/20 bg-red-500/5">
        <CardContent className="flex items-center gap-2 py-4 text-xs text-red-300">
          <TriangleAlert className="h-4 w-4" /> Contraprova indisponível: {erro ?? 'sem dados'}
        </CardContent>
      </Card>
    );
  }
  if (data.ingestao.status === 'pendente') {
    return (
      <Card className="border-white/5 bg-nexo-chrome">
        <CardContent className="py-4 text-xs text-slate-500">
          Sem documentos de empenho coletados para {exercicio} — rode a coleta para gerar a contraprova.
        </CardContent>
      </Card>
    );
  }

  const t = data.totais;
  const d = data.documentos;
  const coletaData = data.ultimaColeta ? new Date(data.ultimaColeta).toLocaleDateString('pt-BR') : null;
  const difSiconfi =
    siconfi?.empenhado != null && siconfi.empenhado > 0
      ? ((t.empenhadoLiquido - siconfi.empenhado) / siconfi.empenhado) * 100
      : null;

  const cards = [
    {
      rotulo: 'Empenhos emitidos',
      valor: d.empenhosDistintos.toLocaleString('pt-BR'),
      detalhe: `${d.empenhos.toLocaleString('pt-BR')} movimentos + ${d.anulacoes.toLocaleString('pt-BR')} anulações`,
    },
    {
      rotulo: 'Empenhado líquido',
      valor: brlCompacto(t.empenhadoLiquido),
      detalhe: t.anulado > 0 ? `anulações: −${brlCompacto(t.anulado)}` : 'sem anulações',
    },
    {
      rotulo: 'Liquidado',
      valor: brlCompacto(t.liquidado),
      detalhe: `${t.empenhadoLiquido > 0 ? ((t.liquidado / t.empenhadoLiquido) * 100).toFixed(1) : '—'}% do empenhado`,
    },
    {
      rotulo: 'Pago',
      valor: brlCompacto(t.pago),
      detalhe: `${t.liquidado > 0 ? ((t.pago / t.liquidado) * 100).toFixed(1) : '—'}% do liquidado`,
    },
    {
      rotulo: 'A liquidar | a pagar',
      valor: `${brlCompacto(t.aLiquidar)} | ${brlCompacto(t.aPagar)}`,
      detalhe: 'obrigações em aberto (RAP em formação)',
      alerta: t.aPagar > 0.1 * Math.max(1, t.liquidado),
    },
  ];

  return (
    <Card className="border-white/5 bg-nexo-chrome">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <FileCheck2 className="h-4 w-4 text-amber-400" />
          <CardTitle className="text-sm font-semibold text-slate-100">
            Contraprova documental — documentos de empenho ({exercicio})
          </CardTitle>
        </div>
        <p className="text-[11px] text-slate-500">
          Computado direto dos {d.totalMovimentos.toLocaleString('pt-BR')} movimentos de empenho do Portal da
          Transparência{coletaData ? ` (coletados em ${coletaData})` : ''} — medição independente dos cards
          SICONFI e da síntese orçamentária, para conferência cruzada.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Cards documentais */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {cards.map((c) => (
            <div key={c.rotulo} className="rounded-md border border-white/5 bg-white/[0.02] px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wide text-slate-500">{c.rotulo}</div>
              <div className={`mt-1 text-sm font-semibold ${c.alerta ? 'text-amber-300' : 'text-slate-100'}`}>
                {c.valor}
              </div>
              <div className="text-[10px] text-slate-500">{c.detalhe}</div>
            </div>
          ))}
        </div>

        {/* Comparativo entre as três medições */}
        <div className="rounded-md border border-white/5 bg-white/[0.02] px-3 py-2.5 text-[11px]">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
            Conferência cruzada do empenhado
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-300">
            <span>
              Documentos (portal{coletaData ? ` até ${coletaData}` : ''}):{' '}
              <strong className="text-amber-300">{brlCompacto(t.empenhadoLiquido)}</strong>
            </span>
            <span>
              SICONFI RREO{siconfi?.periodo ? ` (${siconfi.periodo})` : ''}:{' '}
              <strong className="text-slate-100">{brlCompacto(siconfi?.empenhado ?? null)}</strong>
            </span>
            {difSiconfi != null && (
              <span className={Math.abs(difSiconfi) > 15 ? 'text-amber-300' : 'text-slate-400'}>
                diferença: {difSiconfi > 0 ? '+' : ''}{difSiconfi.toFixed(1)}%
              </span>
            )}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
            Diferenças são esperadas: os documentos vão até a última coleta (incluem meses que o RREO bimestral
            ainda não fechou) e o SICONFI consolida órgãos que o portal não publica. Divergência muito acima
            disso indica coleta atrasada ou dado faltante — investigar.
          </p>
        </div>

        {/* Empenhado líquido por mês — direto dos documentos */}
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
            Empenhado líquido por mês (data do documento)
          </div>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.seriePorMes} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis
                  dataKey="nomeCurto"
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={(v: number) => `${Math.round(v / 1_000_000)}mi`}
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                />
                <RechartsTooltip content={<TooltipBarra />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="empenhadoLiquido" fill="#fbbf24" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
