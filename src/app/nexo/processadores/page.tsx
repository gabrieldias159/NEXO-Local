'use client';

/** NEXO — Processadores: catálogo completo dos 172 monitoramentos. */
import { useMemo, useState } from 'react';
import { Cpu, CheckCircle2, Circle, CircleDashed } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  AREAS,
  CATALOGO,
  contarPorStatus,
  TOTAL_MONITORAMENTOS,
  type StatusMon,
} from '@/lib/nexo/catalogo-completo';

const STATUS_META: Record<
  StatusMon,
  { rotulo: string; cls: string; icon: React.ComponentType<{ className?: string }> }
> = {
  ativo: {
    rotulo: 'Ativo',
    cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    icon: CheckCircle2,
  },
  computavel: {
    rotulo: 'Computável',
    cls: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
    icon: Circle,
  },
  planejado: {
    rotulo: 'Planejado',
    cls: 'border-slate-500/30 bg-slate-500/10 text-slate-500',
    icon: CircleDashed,
  },
};

type Filtro = 'todos' | StatusMon;

export default function ProcessadoresPage() {
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const cont = useMemo(() => contarPorStatus(), []);

  return (
    <div className="space-y-7">
      <div>
        <div className="flex items-center gap-2">
          <Cpu className="h-5 w-5 text-amber-400" />
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">
            Processadores
          </h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          Catálogo completo — {TOTAL_MONITORAMENTOS} monitoramentos em{' '}
          {AREAS.length} áreas. Cada um gera indício técnico, jamais acusação.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-4">
        <Kpi rotulo="Total catalogado" valor={String(TOTAL_MONITORAMENTOS)} />
        <Kpi rotulo="Ativos" valor={String(cont.ativo)} cor="text-emerald-300" />
        <Kpi rotulo="Computáveis" valor={String(cont.computavel)} cor="text-sky-300" />
        <Kpi rotulo="Planejados" valor={String(cont.planejado)} cor="text-slate-400" />
      </div>

      {/* Filtro */}
      <div className="flex flex-wrap gap-2">
        {(['todos', 'ativo', 'computavel', 'planejado'] as const).map((f) => (
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
            {f === 'todos' ? 'Todos' : STATUS_META[f].rotulo}
          </button>
        ))}
      </div>

      {/* Áreas */}
      <div className="space-y-4">
        {AREAS.map((area) => {
          const itens = CATALOGO.filter(
            (c) => c.area === area.prefixo && (filtro === 'todos' || c.status === filtro),
          );
          if (itens.length === 0) return null;
          return (
            <Card key={area.prefixo} className="border-white/5 bg-nexo-surface">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm text-slate-200">
                  <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                    {area.prefixo}
                  </span>
                  {area.nome}
                  <span className="ml-auto text-[11px] font-normal text-slate-500">
                    {itens.length}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-white/5">
                  {itens.map((c) => {
                    const meta = STATUS_META[c.status];
                    const Icon = meta.icon;
                    return (
                      <li key={c.id} className="flex items-start gap-3 py-2">
                        <Icon
                          className={
                            'mt-0.5 h-3.5 w-3.5 shrink-0 ' +
                            (c.status === 'ativo'
                              ? 'text-emerald-400'
                              : c.status === 'computavel'
                                ? 'text-sky-400'
                                : 'text-slate-400')
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-[11px] text-slate-500">{c.id}</span>
                            <span className="text-sm text-slate-200">{c.nome}</span>
                            <span className="font-mono text-[10px] text-slate-400">
                              sev {c.severidade}
                            </span>
                            <Badge
                              variant="outline"
                              className={`ml-auto text-[9px] uppercase ${meta.cls}`}
                            >
                              {meta.rotulo}
                            </Badge>
                          </div>
                          <p className="text-[11px] text-slate-500">{c.detecta}</p>
                          <p className="mt-0.5 text-[11px] text-slate-400">
                            Regra: {c.regra} · {c.fundamento}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-[11px] text-slate-400">
        Catálogo-mestre completo, com fonte de dados de cada detector, em
        docs/nexo/02-catalogo-de-monitoramentos.md.
      </p>
    </div>
  );
}

function Kpi({ rotulo, valor, cor }: { rotulo: string; valor: string; cor?: string }) {
  return (
    <Card className="border-white/5 bg-nexo-surface">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-slate-400">{rotulo}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={'text-2xl font-bold ' + (cor ?? 'text-slate-100')}>{valor}</div>
      </CardContent>
    </Card>
  );
}
