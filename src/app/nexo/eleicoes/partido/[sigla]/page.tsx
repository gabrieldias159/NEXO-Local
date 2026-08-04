'use client';

/**
 * Página do Partido — Marília, por eleição.
 *
 * Lista de candidatos do partido, montante total de receita/despesa de campanha
 * (soma dos candidatos), votos (nominais + legenda), cadeiras conquistadas
 * (motor distribuirCadeiras) e atalhos para as contas do partido (DivulgaSPCA)
 * e para o resultado oficial. Clicar num candidato abre a ficha da pessoa.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  Flag,
  ArrowLeft,
  Trophy,
  ExternalLink,
  Vote,
  HandCoins,
  Landmark,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { distribuirCadeiras, type CandidatoVoto } from '@/lib/eleicoes/cadeiras';
import { urlContasPartido, urlResultados } from '@/lib/eleicoes/links';

const ANOS = [2024, 2020, 2016] as const;
type Ano = (typeof ANOS)[number];
const nfmt = new Intl.NumberFormat('pt-BR');
const brl = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);

interface Cand extends CandidatoVoto {
  ano: number;
  nr?: string;
  cargo: string;
  situacao: string;
  eleito: boolean;
  personId: string;
}

export default function PartidoPage() {
  const params = useParams<{ sigla: string }>();
  const sigla = decodeURIComponent(
    Array.isArray(params.sigla) ? params.sigla[0] : params.sigla || '',
  );

  const [ano, setAno] = useState<Ano>(2024);
  const [cands, setCands] = useState<Record<number, Cand[]>>({});
  const [fin, setFin] = useState<Record<number, Record<string, { receita?: number; despesa?: number }>>>({});
  const [legenda, setLegenda] = useState<Record<number, Record<string, { legenda?: number }>>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let vivo = true;
    (async () => {
      setLoading(true);
      const jsonOr = async (u: string, fb: any) => {
        try {
          const r = await fetch(u);
          return r.ok ? await r.json() : fb;
        } catch {
          return fb;
        }
      };
      const [c, f, l] = await Promise.all([
        cands[ano] ? cands[ano] : jsonOr(`/eleicoes/candidatos_${ano}.json`, []),
        fin[ano] ? fin[ano] : jsonOr(`/eleicoes/financas_${ano}.json`, {}),
        legenda[ano] ? legenda[ano] : jsonOr(`/eleicoes/legenda_${ano}.json`, {}),
      ]);
      if (!vivo) return;
      setCands((d) => ({ ...d, [ano]: c }));
      setFin((d) => ({ ...d, [ano]: f }));
      setLegenda((d) => ({ ...d, [ano]: (l as any).porPartido || {} }));
      setLoading(false);
    })();
    return () => {
      vivo = false;
    };
  }, [ano]); // eslint-disable-line react-hooks/exhaustive-deps

  const todos = (cands[ano] ?? []).filter((c) => /^vereador/i.test(c.cargo));
  const meus = useMemo(
    () => todos.filter((c) => c.partido === sigla).sort((a, b) => b.votos - a.votos),
    [todos, sigla],
  );
  const finAno = fin[ano] ?? {};
  const legAno = legenda[ano] ?? {};

  const totais = useMemo(() => {
    let receita = 0,
      despesa = 0,
      votos = 0;
    for (const c of meus) {
      receita += finAno[c.sq]?.receita || 0;
      despesa += finAno[c.sq]?.despesa || 0;
      votos += c.votos;
    }
    const leg = legAno[sigla]?.legenda || 0;
    return { receita, despesa, votos, leg };
  }, [meus, finAno, legAno, sigla]);

  const cadeiras = useMemo(() => {
    if (!todos.length) return 0;
    const legPart: Record<string, number> = {};
    for (const [sg, v] of Object.entries(legAno)) legPart[sg] = (v as any).legenda || 0;
    const r = distribuirCadeiras({ ano, candidatos: todos, legendaPorPartido: legPart });
    return r.eleitos.filter((e) => e.partido === sigla).length;
  }, [todos, ano, legAno, sigla]);

  const eleitos = meus.filter((c) => c.eleito).length;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <Link href="/nexo/eleicoes" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
        <ArrowLeft className="h-3.5 w-3.5" /> Eleições
      </Link>

      <header className="flex flex-wrap items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
          <Flag className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-slate-100">{sigla}</h1>
          <p className="text-xs text-slate-500">Marília · eleição municipal de {ano}</p>
        </div>
        <div className="ml-auto flex rounded-lg border border-white/10 bg-nexo-chrome p-0.5">
          {ANOS.map((a) => (
            <button
              key={a}
              onClick={() => setAno(a)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                ano === a ? 'bg-amber-500/20 text-amber-300' : 'text-slate-400 hover:text-slate-200',
              )}
            >
              {a}
            </button>
          ))}
        </div>
      </header>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : meus.length === 0 ? (
        <Card className="border-white/10 bg-nexo-chrome">
          <CardContent className="py-10 text-center text-sm text-slate-500">
            Nenhum candidato de {sigla} a vereador em {ano}.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Métricas */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Candidatos" value={String(meus.length)} />
            <Metric label="Cadeiras" value={String(cadeiras)} accent={cadeiras > 0} />
            <Metric label="Votos nominais" value={nfmt.format(totais.votos)} />
            <Metric label="Legenda" value={nfmt.format(totais.leg)} />
            <Metric label="Receita (cands)" value={brl(totais.receita)} />
            <Metric label="Despesa (cands)" value={brl(totais.despesa)} />
          </div>

          {/* Atalhos externos */}
          <div className="flex flex-wrap gap-2">
            <a
              href={urlContasPartido()}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-nexo-chrome px-3 py-1.5 text-xs text-slate-300 hover:text-slate-100"
            >
              <Landmark className="h-3.5 w-3.5 text-amber-400" />
              Contas anuais do partido (DivulgaSPCA)
              <ExternalLink className="h-3 w-3 text-slate-500" />
            </a>
            <a
              href={urlResultados()}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-nexo-chrome px-3 py-1.5 text-xs text-slate-300 hover:text-slate-100"
            >
              <Vote className="h-3.5 w-3.5 text-amber-400" />
              Resultado oficial (TSE)
              <ExternalLink className="h-3 w-3 text-slate-500" />
            </a>
          </div>

          {/* Candidatos */}
          <div className="overflow-hidden rounded-lg border border-white/10">
            <div className="flex items-center justify-between border-b border-white/5 bg-nexo-chrome px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                Candidatos · {eleitos} eleito(s)
              </span>
              <span className="flex items-center gap-1 text-[11px] text-slate-500">
                <HandCoins className="h-3 w-3" /> receita por candidato
              </span>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-white/5">
                {meus.map((c) => {
                  const f = finAno[c.sq];
                  return (
                    <tr key={c.sq} className="bg-nexo-inset hover:bg-white/[0.03]">
                      <td className="px-3 py-2">
                        <Link
                          href={`/nexo/pessoa/${encodeURIComponent(c.personId)}`}
                          className="font-medium text-slate-100 hover:text-amber-300"
                        >
                          {c.urna}
                        </Link>
                        <span className="ml-2 text-[11px] text-slate-500">nº {c.nr ?? ''}</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-200">
                        {nfmt.format(c.votos)}
                      </td>
                      <td className="px-3 py-2">
                        {c.eleito ? (
                          <Badge className="bg-emerald-500/15 text-emerald-300">
                            <Trophy className="mr-1 h-3 w-3" />
                            {c.situacao || 'Eleito'}
                          </Badge>
                        ) : (
                          <span className="text-[11px] text-slate-500">{c.situacao || '—'}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-slate-400">
                        {f?.receita != null ? brl(f.receita) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] leading-relaxed text-slate-400">
            Receita/despesa somam a prestação de contas dos candidatos do partido (TSE). Os
            recursos próprios do diretório (fundo partidário/eleitoral, manutenção) estão nas
            contas anuais — DivulgaSPCA, no atalho acima.
          </p>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-white/10 bg-nexo-chrome px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className={cn('font-mono text-base', accent ? 'text-emerald-300' : 'text-slate-100')}>
        {value}
      </p>
    </div>
  );
}
