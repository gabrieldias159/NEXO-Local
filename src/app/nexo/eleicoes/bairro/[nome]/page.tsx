'use client';

/**
 * Ficha do BAIRRO — histórico eleitoral de um bairro de Marília (2016/2020/2024).
 *
 * Para cada eleição: campeão, top-10 vereador e resultado de prefeito NAQUELE
 * bairro (votos nominais por seção do TSE agregados por local de votação).
 * Chave da rota = nome do bairro como está em votos_bairro_{ano}.json.
 * Links: candidato -> ficha da pessoa; mapa -> deep-link já no bairro.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, MapPin, Users, Trophy, Vote } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface CandBairro {
  nome: string;
  partido: string | null;
  sq: string | null;
  personId: string | null;
  eleito: boolean | null;
  total: number;
  votos: number[];
}
interface DadosCargo {
  cands: Record<string, CandBairro>;
  totalPorBairro: number[];
  especiais: Record<string, number[]>;
}
interface VotosBairro {
  bairros: string[];
  cargos: Record<'vereador' | 'prefeito', DadosCargo>;
}

const ANOS = [2024, 2020, 2016, 2012] as const;
const nfmt = new Intl.NumberFormat('pt-BR');

export default function BairroPage() {
  const params = useParams<{ nome: string }>();
  const bairro = decodeURIComponent(Array.isArray(params.nome) ? params.nome[0] : params.nome || '');

  const [vbPorAno, setVbPorAno] = useState<Record<number, VotosBairro | null>>({});
  const [eleitores, setEleitores] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const jsonOr = async (u: string) => {
        try {
          const r = await fetch(u);
          return r.ok ? await r.json() : null;
        } catch {
          return null;
        }
      };
      const [v24, v20, v16, v12, gj] = await Promise.all([
        jsonOr('/eleicoes/votos_bairro_2024.json'),
        jsonOr('/eleicoes/votos_bairro_2020.json'),
        jsonOr('/eleicoes/votos_bairro_2016.json'),
        jsonOr('/eleicoes/votos_bairro_2012.json'),
        jsonOr('/eleicoes/mapa_bairros.geojson'),
      ]);
      if (!vivo) return;
      setVbPorAno({ 2024: v24, 2020: v20, 2016: v16, 2012: v12 });
      const f = gj?.features?.find((x: any) => x?.properties?.bairro === bairro);
      setEleitores(f?.properties?.eleitores ?? null);
      setLoading(false);
    })();
    return () => {
      vivo = false;
    };
  }, [bairro]);

  // por eleição: top vereadores + prefeito neste bairro
  const porAno = useMemo(() => {
    return ANOS.map((ano) => {
      const vb = vbPorAno[ano];
      if (!vb) return null;
      const i = vb.bairros.indexOf(bairro);
      if (i < 0) return null;
      const monta = (d: DadosCargo, n: number) => {
        const tot = d.totalPorBairro[i] || 0;
        return Object.entries(d.cands)
          .map(([nr, c]) => ({
            nr,
            nome: c.nome,
            partido: c.partido,
            personId: c.personId,
            eleito: c.eleito,
            v: c.votos[i] || 0,
            pct: tot ? ((c.votos[i] || 0) / tot) * 100 : 0,
          }))
          .sort((a, b) => b.v - a.v)
          .slice(0, n);
      };
      return {
        ano,
        totalVer: vb.cargos.vereador.totalPorBairro[i] || 0,
        totalPre: vb.cargos.prefeito.totalPorBairro[i] || 0,
        vereadores: monta(vb.cargos.vereador, 10),
        prefeitos: monta(vb.cargos.prefeito, 5),
      };
    }).filter(Boolean) as {
      ano: number;
      totalVer: number;
      totalPre: number;
      vereadores: { nr: string; nome: string; partido: string | null; personId: string | null; eleito: boolean | null; v: number; pct: number }[];
      prefeitos: { nr: string; nome: string; partido: string | null; personId: string | null; eleito: boolean | null; v: number; pct: number }[];
    }[];
  }, [vbPorAno, bairro]);

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (porAno.length === 0) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <Link href="/nexo/eleicoes/mapa" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
          <ArrowLeft className="h-3.5 w-3.5" /> Mapa
        </Link>
        <Card className="mt-4 border-white/10 bg-nexo-chrome">
          <CardContent className="py-10 text-center text-sm text-slate-500">
            Bairro <span className="text-slate-300">{bairro}</span> não encontrado.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <Link href="/nexo/eleicoes/mapa" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
        <ArrowLeft className="h-3.5 w-3.5" /> Mapa por bairro
      </Link>

      <header className="flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
          <MapPin className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-slate-100">{bairro}</h1>
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            {eleitores != null && (
              <>
                <Users className="h-3.5 w-3.5 text-amber-400" /> {nfmt.format(eleitores)} eleitores (2024) ·
              </>
            )}
            histórico eleitoral por local de votação
          </p>
        </div>
      </header>

      {porAno.map((e) => (
        <section key={e.ano} className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Vote className="h-4 w-4 text-slate-400" />
            {e.ano} · {nfmt.format(e.totalVer)} votos nominais p/ vereador
          </h2>
          <div className="grid gap-3 lg:grid-cols-[1fr_300px]">
            <div className="overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full text-sm">
                <thead className="bg-nexo-chrome text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">Vereador (top-10 aqui)</th>
                    <th className="px-3 py-2 text-left">Partido</th>
                    <th className="px-3 py-2 text-right">Votos</th>
                    <th className="px-3 py-2 text-right">% do bairro</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {e.vereadores.map((c, i) => (
                    <tr key={c.nr} className="bg-nexo-inset">
                      <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                      <td className="px-3 py-1.5">
                        {c.personId ? (
                          <Link
                            href={`/nexo/pessoa/${encodeURIComponent(c.personId)}`}
                            className={cn('hover:text-amber-300', c.eleito ? 'text-emerald-300' : 'text-slate-200')}
                          >
                            {c.nome}
                          </Link>
                        ) : (
                          <span className="text-slate-200">{c.nome}</span>
                        )}
                        {c.eleito && <Trophy className="ml-1 inline h-3 w-3 text-emerald-400" />}
                      </td>
                      <td className="px-3 py-1.5 text-slate-400">{c.partido ?? '—'}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-slate-100">{nfmt.format(c.v)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-slate-400">{c.pct.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Card className="h-fit border-white/10 bg-nexo-chrome">
              <CardContent className="p-4">
                <p className="pb-2 text-[11px] uppercase tracking-widest text-slate-500">
                  Prefeito neste bairro · {nfmt.format(e.totalPre)} nominais
                </p>
                <ul className="space-y-1 text-xs">
                  {e.prefeitos.map((c) => (
                    <li key={c.nr} className="flex justify-between gap-2 text-slate-300">
                      <span className="truncate">
                        {c.nome}
                        <span className="text-slate-500"> {c.partido ?? ''}</span>
                        {c.eleito && <Trophy className="ml-1 inline h-3 w-3 text-emerald-400" />}
                      </span>
                      <span className="shrink-0 font-mono text-slate-400">
                        {nfmt.format(c.v)} · {c.pct.toFixed(1)}%
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={`/nexo/eleicoes/mapa?ano=${e.ano}`}
                  className="mt-3 inline-block text-xs text-sky-400 hover:text-sky-300"
                >
                  ver no mapa de {e.ano} →
                </Link>
              </CardContent>
            </Card>
          </div>
        </section>
      ))}

      <p className="text-[11px] leading-relaxed text-slate-400">
        "Bairro" = área de influência dos locais de votação (onde a pessoa VOTA, não onde mora).
        % = fatia do candidato nos votos nominais do cargo neste bairro. Fonte: TSE, votação por
        seção (1º turno), agregada por local de votação.
      </p>
    </div>
  );
}
