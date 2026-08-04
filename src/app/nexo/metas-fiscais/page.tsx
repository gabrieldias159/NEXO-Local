'use client';

/** NEXO — subsistema de Metas Fiscais & Orçamentárias. */
import { useCallback, useEffect, useState } from 'react';
import { Gauge, RefreshCw, Scale, TriangleAlert, Info, CalendarClock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listLimitesDispensa } from '@/lib/nexo/limites';
import type { MetasFiscaisResponse, IndicadorApurado } from '@/app/api/nexo/metas-fiscais/route';
import { nexoFetch } from '@/lib/nexo/client-fetch';

const EXERCICIOS = [2026, 2025, 2024, 2023];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const PRAZO_META: Record<string, { rotulo: string; cls: string }> = {
  futuro: { rotulo: 'Futuro', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-400' },
  aberto: { rotulo: 'Prazo aberto', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300' },
  vence_em_breve: { rotulo: 'Vence em breve', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  encerrado: { rotulo: 'Prazo encerrado', cls: 'border-slate-600/30 bg-slate-600/10 text-slate-500' },
};

const SITUACAO_META: Record<string, { rotulo: string; cls: string; barra: string }> = {
  ok: { rotulo: 'Dentro do limite', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300', barra: 'bg-emerald-500' },
  atencao: { rotulo: 'Faixa de alerta', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300', barra: 'bg-amber-500' },
  prudencial: { rotulo: 'Faixa prudencial', cls: 'border-orange-500/30 bg-orange-500/10 text-orange-300', barra: 'bg-orange-500' },
  estourado: { rotulo: 'Limite ultrapassado', cls: 'border-red-500/30 bg-red-500/10 text-red-300', barra: 'bg-red-500' },
  sem_dado: { rotulo: 'A apurar', cls: 'border-slate-500/30 bg-slate-500/10 text-slate-400', barra: 'bg-slate-600' },
};

function IndicadorCard({ ind }: { ind: IndicadorApurado }) {
  const meta = SITUACAO_META[ind.situacao] ?? SITUACAO_META.sem_dado;
  const temValor = ind.valor != null;
  // Largura da barra: razão valor/limite, travada em 100%.
  const pct = temValor ? Math.min(100, Math.round((ind.valor! / ind.limite) * 100)) : 0;

  return (
    <Card className="border-white/5 bg-nexo-surface">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm leading-snug text-slate-200">
            {ind.rotulo}
          </CardTitle>
          <Badge variant="outline" className={`shrink-0 text-[10px] uppercase ${meta.cls}`}>
            {meta.rotulo}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-end justify-between">
          <span className="text-2xl font-bold text-slate-100">
            {temValor ? `${ind.valor!.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '—'}
          </span>
          <span className="text-xs text-slate-500">
            {ind.sentido === 'minimo' ? 'mínimo' : 'limite'} {ind.limite}%
          </span>
        </div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-white/5"
          role="progressbar"
          aria-valuenow={temValor ? pct : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${ind.rotulo}: ${temValor ? `${pct}% do ${ind.sentido === 'minimo' ? 'mínimo' : 'limite'} de ${ind.limite}%` : 'valor a apurar'}`}
        >
          <div className={`h-full ${meta.barra}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-[11px] text-slate-500">
          {ind.descricao} · {ind.fundamento}
          {ind.periodoApurado ? ` · ${ind.periodoApurado}` : ''}
        </p>
      </CardContent>
    </Card>
  );
}

export default function MetasFiscaisPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<MetasFiscaisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async (ano: number) => {
    setLoading(true);
    setErro(null);
    try {
      const res = await nexoFetch(`/api/nexo/metas-fiscais?exercicio=${ano}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as MetasFiscaisResponse);
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

  return (
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Metas Fiscais &amp; Orçamentárias
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Monitoramento contínuo dos limites constitucionais e da LRF —
            exercício atual e série histórica. Cumprir estas metas é obrigação
            inegociável do gestor.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => carregar(exercicio)}
          disabled={loading}
          aria-label="Atualizar indicadores de metas fiscais"
          title="Recarregar os indicadores do exercício selecionado"
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <RefreshCw className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} aria-hidden="true" />
          Atualizar
        </Button>
      </div>

      {/* Seletor de exercício */}
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

      {/* Indicadores */}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Carregando indicadores">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5" role="alert">
          <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
            <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
            Não foi possível carregar os indicadores: {erro}
          </CardContent>
        </Card>
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.indicadores.map((ind) => (
              <IndicadorCard key={ind.chave} ind={ind} />
            ))}
          </div>
          <div className="flex items-start gap-2 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400/70" aria-hidden="true" />
            <span>
              Fonte: {data.fonte}. {data.siconfi.registros.toLocaleString('pt-BR')}{' '}
              {data.siconfi.registros === 1 ? 'registro lido' : 'registros lidos'} do
              SICONFI. A apuração automática de valor cobre, na Fase 0, a despesa
              com pessoal (RGF); saúde, educação e dívida têm os limites
              definidos e a extração de valor entra na Fase 1.
            </span>
          </div>

          {/* Prazos de publicação RREO/RGF */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                <CalendarClock className="h-4 w-4 text-amber-400" aria-hidden="true" />
                Prazos de publicação — RREO e RGF
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {data.prazos.map((p) => {
                const meta = PRAZO_META[p.situacao] ?? PRAZO_META.futuro;
                return (
                  <div
                    key={p.rotulo}
                    className="flex items-center justify-between rounded-md border border-white/5 bg-nexo-chrome px-3 py-2"
                  >
                    <span className="text-sm text-slate-300">{p.rotulo}</span>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs text-slate-500">{p.prazo}</span>
                      <Badge
                        variant="outline"
                        className={`text-[10px] uppercase ${meta.cls}`}
                      >
                        {meta.rotulo}
                      </Badge>
                    </div>
                  </div>
                );
              })}
              <p className="pt-1 text-[11px] text-slate-400">
                Prazo legal: 30 dias após o fim do período (LRF, arts. 52 e 55).
                Perder o prazo de publicação é causa frequente de multa e rejeição
                de contas.
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}

      {/* Tabela de limites de dispensa */}
      <Card className="border-white/5 bg-nexo-surface">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-200">
            <Scale className="h-4 w-4 text-amber-400" aria-hidden="true" />
            Limites de dispensa de licitação por exercício
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-white/5 hover:bg-transparent">
                <TableHead className="text-slate-400">Exercício</TableHead>
                <TableHead className="text-slate-400">Compras e serviços</TableHead>
                <TableHead className="text-slate-400">Obras e engenharia</TableHead>
                <TableHead className="text-slate-400">Decreto federal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {listLimitesDispensa().map((l) => (
                <TableRow key={l.exercicio} className="border-white/5 hover:bg-white/5">
                  <TableCell className="font-medium text-slate-200">{l.exercicio}</TableCell>
                  <TableCell className="font-mono text-slate-300">{brl(l.comprasServicos)}</TableCell>
                  <TableCell className="font-mono text-slate-300">{brl(l.obrasEngenharia)}</TableCell>
                  <TableCell className="text-slate-500">{l.decreto}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
          <p className="mt-3 text-[11px] text-slate-400">
            Art. 75, I e II, da Lei 14.133/2021 — valores atualizados por decreto
            federal. Esta tabela é a fonte única do detector de fracionamento.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
