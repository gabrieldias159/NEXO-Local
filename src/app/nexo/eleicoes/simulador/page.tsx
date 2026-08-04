'use client';

/**
 * Simulador de recontagem — Câmara de Marília.
 *
 * Anule os votos de um partido inteiro ou de candidatos avulsos e veja como as
 * cadeiras (13 em 2016/2020, 17 em 2024) se redistribuem pela regra proporcional
 * brasileira. O motor (distribuirCadeiras) reproduz o resultado oficial do TSE.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Calculator,
  Search,
  ArrowLeft,
  X,
  RotateCcw,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  distribuirCadeiras,
  CADEIRAS_POR_ANO,
  type CandidatoVoto,
} from '@/lib/eleicoes/cadeiras';

const ANOS = [2024, 2020, 2016] as const;
type Ano = (typeof ANOS)[number];

interface Cand extends CandidatoVoto {
  ano: number;
  cargo: string;
  situacao: string;
  eleito: boolean;
  personId: string;
}
type LegendaFile = {
  porPartido?: Record<string, { legenda?: number; nominais?: number }>;
};

const nfmt = new Intl.NumberFormat('pt-BR');

export default function SimuladorPage() {
  const [ano, setAno] = useState<Ano>(2024);
  const [cands, setCands] = useState<Record<number, Cand[]>>({});
  const [legendas, setLegendas] = useState<Record<number, Record<string, number>>>({});
  const [loading, setLoading] = useState(true);
  const [partidosAnul, setPartidosAnul] = useState<Set<string>>(new Set());
  const [candAnul, setCandAnul] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');

  useEffect(() => {
    let vivo = true;
    (async () => {
      setLoading(true);
      try {
        const cRaw: any[] = cands[ano]
          ? cands[ano]
          : await fetch(`/eleicoes/candidatos_${ano}.json`).then((r) => r.json());
        // legenda é opcional (pode ainda não existir)
        let leg: Record<string, number> = legendas[ano] || {};
        if (!legendas[ano]) {
          try {
            const lf: LegendaFile = await fetch(`/eleicoes/legenda_${ano}.json`).then((r) =>
              r.ok ? r.json() : {},
            );
            if (lf.porPartido) {
              leg = {};
              for (const [sg, v] of Object.entries(lf.porPartido)) leg[sg] = v.legenda || 0;
            }
          } catch {
            /* sem legenda: usa só nominais */
          }
        }
        if (!vivo) return;
        const ver: Cand[] = (cRaw as any[])
          .filter((c) => /^vereador/i.test(c.cargo))
          .map((c) => ({
            sq: c.sq,
            urna: c.urna,
            nome: c.nome,
            partido: c.partido,
            coligacao: c.coligacao,
            votos: c.votos,
            ano: c.ano,
            cargo: c.cargo,
            situacao: c.situacao,
            eleito: c.eleito,
            personId: c.personId,
          }));
        setCands((d) => ({ ...d, [ano]: ver }));
        setLegendas((d) => ({ ...d, [ano]: leg }));
      } finally {
        if (vivo) setLoading(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [ano]); // eslint-disable-line react-hooks/exhaustive-deps

  const lista = cands[ano] ?? [];
  const legenda = legendas[ano] ?? {};
  const cadeiras = CADEIRAS_POR_ANO[ano] ?? 17;

  const partidos = useMemo(
    () =>
      [...new Set(lista.map((c) => c.partido))].sort((a, b) => {
        const va = lista.filter((c) => c.partido === a).reduce((s, c) => s + c.votos, 0);
        const vb = lista.filter((c) => c.partido === b).reduce((s, c) => s + c.votos, 0);
        return vb - va;
      }),
    [lista],
  );

  // cenário base (modelo, sem anulação) e cenário simulado
  const base = useMemo(
    () => (lista.length ? distribuirCadeiras({ ano, candidatos: lista, legendaPorPartido: legenda }) : null),
    [lista, ano, legenda],
  );
  const sim = useMemo(
    () =>
      lista.length
        ? distribuirCadeiras({
            ano,
            candidatos: lista,
            legendaPorPartido: legenda,
            partidosAnulados: partidosAnul,
            candidatosAnulados: candAnul,
          })
        : null,
    [lista, ano, legenda, partidosAnul, candAnul],
  );

  const baseSet = useMemo(() => new Set(base?.eleitos.map((e) => e.sq) ?? []), [base]);
  const simSet = useMemo(() => new Set(sim?.eleitos.map((e) => e.sq) ?? []), [sim]);
  const entraram = useMemo(
    () => (sim?.eleitos ?? []).filter((e) => !baseSet.has(e.sq)),
    [sim, baseSet],
  );
  const sairam = useMemo(
    () => (base?.eleitos ?? []).filter((e) => !simSet.has(e.sq)),
    [base, simSet],
  );

  const temAnulacao = partidosAnul.size > 0 || candAnul.size > 0;
  const byId = useMemo(() => Object.fromEntries(lista.map((c) => [c.sq, c])), [lista]);

  const buscados = useMemo(() => {
    const termo = q.trim().toLowerCase();
    if (!termo) return [];
    return lista
      .filter((c) => `${c.urna} ${c.partido}`.toLowerCase().includes(termo))
      .sort((a, b) => b.votos - a.votos)
      .slice(0, 8);
  }, [lista, q]);

  const togglePartido = (p: string) =>
    setPartidosAnul((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  const toggleCand = (sq: string) =>
    setCandAnul((s) => {
      const n = new Set(s);
      n.has(sq) ? n.delete(sq) : n.add(sq);
      return n;
    });
  const limpar = () => {
    setPartidosAnul(new Set());
    setCandAnul(new Set());
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="space-y-3">
        <Link
          href="/nexo/eleicoes"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Eleições
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
            <Calculator className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-100">
              Simulador de recontagem — Câmara
            </h1>
            <p className="text-xs text-slate-500">
              Anule um partido ou candidatos e veja quem fica com as {cadeiras} cadeiras
            </p>
          </div>
          <div className="ml-auto flex rounded-lg border border-white/10 bg-nexo-chrome p-0.5">
            {ANOS.map((a) => (
              <button
                key={a}
                onClick={() => {
                  setAno(a);
                  limpar();
                }}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  ano === a ? 'bg-amber-500/20 text-amber-300' : 'text-slate-400 hover:text-slate-200',
                )}
              >
                {a}
              </button>
            ))}
          </div>
        </div>
      </header>

      {loading || !base || !sim ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <>
          {/* Métricas */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Cadeiras" value={String(cadeiras)} />
            <Metric
              label="Quociente eleitoral"
              value={nfmt.format(sim.qe)}
              sub={temAnulacao && sim.qe !== base.qe ? `era ${nfmt.format(base.qe)}` : undefined}
            />
            <Metric
              label="Votos válidos"
              value={nfmt.format(sim.validos)}
              sub={
                temAnulacao && sim.validos !== base.validos
                  ? `−${nfmt.format(base.validos - sim.validos)}`
                  : undefined
              }
            />
            <Metric
              label="Mudanças"
              value={temAnulacao ? String(entraram.length) : '0'}
              sub={temAnulacao ? 'cadeiras trocaram' : 'sem anulação'}
            />
          </div>

          {/* Controles de anulação */}
          <Card className="border-white/10 bg-nexo-chrome">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                  Anular partido inteiro
                </p>
                {temAnulacao && (
                  <button
                    onClick={limpar}
                    className="inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
                  >
                    <RotateCcw className="h-3 w-3" /> Limpar
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {partidos.map((p) => (
                  <button
                    key={p}
                    onClick={() => togglePartido(p)}
                    className={cn(
                      'rounded-md border px-2 py-1 text-xs transition-colors',
                      partidosAnul.has(p)
                        ? 'border-red-500/40 bg-red-500/15 text-red-300 line-through'
                        : 'border-white/10 text-slate-400 hover:text-slate-200',
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>

              <div className="pt-1">
                <p className="pb-1.5 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                  Anular candidatos avulsos
                </p>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Buscar candidato para anular…"
                    className="w-full rounded-md border border-white/10 bg-nexo-inset py-2 pl-9 pr-3 text-sm text-slate-200 placeholder:text-slate-500 focus:border-amber-500/40 focus:outline-none"
                  />
                </div>
                {buscados.length > 0 && (
                  <div className="mt-1 overflow-hidden rounded-md border border-white/10">
                    {buscados.map((c) => (
                      <button
                        key={c.sq}
                        onClick={() => {
                          toggleCand(c.sq);
                          setQ('');
                        }}
                        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-white/5"
                      >
                        <span className="text-slate-200">
                          {c.urna}{' '}
                          <span className="text-xs text-slate-500">{c.partido}</span>
                        </span>
                        <span className="font-mono text-xs text-slate-400">
                          {nfmt.format(c.votos)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {candAnul.size > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {[...candAnul].map((sq) => (
                      <span
                        key={sq}
                        className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs text-red-300"
                      >
                        {byId[sq]?.urna ?? sq}
                        <button onClick={() => toggleCand(sq)}>
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Efeito da anulação */}
          {temAnulacao && (entraram.length > 0 || sairam.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Card className="border-emerald-500/20 bg-emerald-500/[0.03]">
                <CardContent className="p-4">
                  <p className="flex items-center gap-1.5 pb-2 text-xs font-semibold text-emerald-300">
                    <TrendingUp className="h-3.5 w-3.5" /> Entram ({entraram.length})
                  </p>
                  {entraram.length === 0 ? (
                    <p className="text-xs text-slate-500">Ninguém novo.</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {entraram.map((e) => (
                        <li key={e.sq} className="flex justify-between text-slate-200">
                          <span>
                            {e.urna} <span className="text-xs text-slate-500">{e.partido}</span>
                          </span>
                          <span className="text-[11px] text-slate-500">via {e.via}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
              <Card className="border-red-500/20 bg-red-500/[0.03]">
                <CardContent className="p-4">
                  <p className="flex items-center gap-1.5 pb-2 text-xs font-semibold text-red-300">
                    <TrendingDown className="h-3.5 w-3.5" /> Saem ({sairam.length})
                  </p>
                  {sairam.length === 0 ? (
                    <p className="text-xs text-slate-500">Ninguém perde a cadeira.</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {sairam.map((e) => (
                        <li key={e.sq} className="flex justify-between text-slate-300">
                          <span>
                            {e.urna} <span className="text-xs text-slate-500">{e.partido}</span>
                          </span>
                          <span className="text-[11px] text-slate-500">tinha via {e.via}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Composição simulada da Câmara */}
          <div className="overflow-hidden rounded-lg border border-white/10">
            <div className="flex items-center justify-between border-b border-white/5 bg-nexo-chrome px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                Câmara {temAnulacao ? 'simulada' : '(modelo)'} — {sim.eleitos.length} cadeiras
              </span>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-nexo-chrome text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">Eleito</th>
                  <th className="px-3 py-2 text-left">Partido</th>
                  <th className="px-3 py-2 text-right">Votos</th>
                  <th className="px-3 py-2 text-left">Via</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {sim.eleitos.map((e, i) => {
                  const novo = !baseSet.has(e.sq);
                  return (
                    <tr key={e.sq} className={cn('bg-nexo-inset', novo && 'bg-emerald-500/[0.06]')}>
                      <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                      <td className="px-3 py-2">
                        <span className="font-medium text-slate-100">{e.urna}</span>
                        {novo && (
                          <Badge className="ml-2 bg-emerald-500/15 text-[10px] text-emerald-300">
                            novo
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-300">{e.partido}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-200">
                        {nfmt.format(e.votos)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px]',
                            e.via === 'QP'
                              ? 'bg-sky-500/10 text-sky-300'
                              : 'bg-violet-500/10 text-violet-300',
                          )}
                        >
                          {e.via}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] leading-relaxed text-slate-400">
            Motor de cálculo pela regra proporcional vigente (QE, QP, barreira de votação
            nominal mínima e sobras por maiores médias — Lei 14.211/2021 em 2024; Lei
            13.165/2015 em 2016/2020; federação/coligação como unidade). Reproduz o resultado
            oficial do TSE. A "recontagem" zera os votos selecionados e refaz toda a
            distribuição — inclusive o quociente eleitoral.
          </p>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-nexo-chrome px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className="font-mono text-lg text-slate-100">{value}</p>
      {sub && <p className="text-[10px] text-amber-400/80">{sub}</p>}
    </div>
  );
}
