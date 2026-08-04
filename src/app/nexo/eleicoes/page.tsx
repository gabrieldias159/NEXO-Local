'use client';

/**
 * Módulo ELEIÇÕES — resultados municipais de Marília (2016/2020/2024).
 *
 * Foco em VEREADORES (a Câmara), com Prefeito como aba secundária. Dados
 * estáticos do TSE (dados-abertos) materializados em public/eleicoes/*.json.
 * Ranking ordenável/filtrável; clicar no candidato abre a ficha da pessoa;
 * clicar no partido abre a página do partido. Simulador de recontagem e mapa
 * por bairro em rotas próprias.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Vote,
  Search,
  Trophy,
  ArrowUp,
  ArrowDown,
  Minus,
  Calculator,
  Map as MapIcon,
  ExternalLink,
  HandCoins,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { urlDivulgaCandidato, urlFotoCandidato } from '@/lib/eleicoes/links';

const ANOS = [2024, 2020, 2016, 2012] as const;
type Ano = (typeof ANOS)[number];
type Cargo = 'Vereador' | 'Prefeito';

interface Candidato {
  ano: number;
  sq: string;
  nr: string;
  nome: string;
  urna: string;
  cargo: string;
  partido: string;
  partidoNome: string;
  coligacao: string;
  situacao: string;
  eleito: boolean;
  votos: number;
  votosPorZona: Record<string, number>;
  posicao: number;
  personId: string;
}

interface HistItem {
  ano: number;
  cargo: string;
  partido: string;
  votos: number;
  eleito: boolean;
  situacao: string;
}

const nfmt = new Intl.NumberFormat('pt-BR');
const pct = (v: number, total: number) =>
  total > 0 ? ((v / total) * 100).toFixed(2) + '%' : '—';

export default function EleicoesPage() {
  const [ano, setAno] = useState<Ano>(2024);
  const [cargo, setCargo] = useState<Cargo>('Vereador');
  const [q, setQ] = useState('');
  const [partido, setPartido] = useState('');
  const [ordem, setOrdem] = useState<'votos' | 'nome'>('votos');
  const [dados, setDados] = useState<Record<number, Candidato[]>>({});
  const [hist, setHist] = useState<Record<string, HistItem[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let vivo = true;
    (async () => {
      setLoading(true);
      try {
        const [c, h] = await Promise.all([
          dados[ano]
            ? Promise.resolve(dados[ano])
            : fetch(`/eleicoes/candidatos_${ano}.json`).then((r) => r.json()),
          Object.keys(hist).length
            ? Promise.resolve(hist)
            : fetch('/eleicoes/historico.json').then((r) => r.json()),
        ]);
        if (!vivo) return;
        setDados((d) => ({ ...d, [ano]: c }));
        setHist(h);
      } finally {
        if (vivo) setLoading(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [ano]); // eslint-disable-line react-hooks/exhaustive-deps

  const doCargo = useMemo(
    () => (dados[ano] ?? []).filter((c) => new RegExp('^' + cargo, 'i').test(c.cargo)),
    [dados, ano, cargo],
  );

  const totalCargo = useMemo(() => doCargo.reduce((s, c) => s + c.votos, 0), [doCargo]);
  const eleitos = useMemo(() => doCargo.filter((c) => c.eleito), [doCargo]);
  const partidos = useMemo(
    () => [...new Set(doCargo.map((c) => c.partido))].sort(),
    [doCargo],
  );

  const lista = useMemo(() => {
    const termo = q.trim().toLowerCase();
    let arr = doCargo.filter((c) => {
      if (partido && c.partido !== partido) return false;
      if (termo && !`${c.urna} ${c.nome} ${c.partido}`.toLowerCase().includes(termo)) return false;
      return true;
    });
    arr = [...arr].sort((a, b) =>
      ordem === 'nome' ? a.urna.localeCompare(b.urna) : b.votos - a.votos,
    );
    return arr;
  }, [doCargo, q, partido, ordem]);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      {/* Cabeçalho + seletor de eleição */}
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
            <Vote className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-100">Eleições — Marília</h1>
            <p className="text-xs text-slate-500">
              Resultados municipais oficiais (TSE) · votos por candidato
            </p>
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
        </div>

        {/* Navegação do módulo */}
        <div className="flex flex-wrap gap-2">
          <Link
            href="/nexo/eleicoes/simulador"
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-nexo-chrome px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-amber-500/30 hover:text-amber-300"
          >
            <Calculator className="h-3.5 w-3.5" /> Simulador de recontagem
          </Link>
          <Link
            href="/nexo/eleicoes/mapa"
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-nexo-chrome px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-amber-500/30 hover:text-amber-300"
          >
            <MapIcon className="h-3.5 w-3.5" /> Mapa por bairro
          </Link>
          <Link
            href="/nexo/eleicoes/doadores"
            className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-nexo-chrome px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-red-500/30 hover:text-red-300"
          >
            <HandCoins className="h-3.5 w-3.5" /> Doadores
          </Link>
        </div>

        {/* Cargo (foco vereador) + resumo */}
        <div className="flex flex-wrap items-center gap-2">
          {(['Vereador', 'Prefeito'] as Cargo[]).map((cg) => (
            <button
              key={cg}
              onClick={() => setCargo(cg)}
              className={cn(
                'rounded-md border px-3 py-1 text-sm transition-colors',
                cargo === cg
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                  : 'border-white/10 text-slate-400 hover:text-slate-200',
              )}
            >
              {cg === 'Vereador' ? 'Vereadores' : 'Prefeito'}
            </button>
          ))}
          {!loading && (
            <div className="ml-auto flex gap-2 text-xs text-slate-500">
              <span className="rounded bg-white/5 px-2 py-1">{doCargo.length} candidato(s)</span>
              <span className="rounded bg-emerald-500/10 px-2 py-1 text-emerald-300">
                {eleitos.length} eleito(s)
              </span>
              <span className="rounded bg-white/5 px-2 py-1">{nfmt.format(totalCargo)} votos</span>
            </div>
          )}
        </div>
      </header>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar candidato…"
            className="w-full rounded-md border border-white/10 bg-nexo-chrome py-2 pl-9 pr-3 text-sm text-slate-200 placeholder:text-slate-500 focus:border-amber-500/40 focus:outline-none"
          />
        </div>
        <select
          value={partido}
          onChange={(e) => setPartido(e.target.value)}
          className="rounded-md border border-white/10 bg-nexo-chrome px-2 py-2 text-sm text-slate-300"
        >
          <option value="">Todos os partidos</option>
          {partidos.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button
          onClick={() => setOrdem((o) => (o === 'votos' ? 'nome' : 'votos'))}
          className="rounded-md border border-white/10 px-3 py-2 text-sm text-slate-300 hover:text-slate-100"
        >
          Ordenar: {ordem === 'votos' ? 'votos ↓' : 'nome A–Z'}
        </button>
      </div>

      {/* Ranking */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : lista.length === 0 ? (
        <Card className="border-white/10 bg-nexo-chrome">
          <CardContent className="py-10 text-center text-sm text-slate-500">
            Nenhum candidato para este filtro.
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-nexo-chrome text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">Candidato</th>
                <th className="px-3 py-2 text-left">Partido</th>
                <th className="px-3 py-2 text-right">Votos</th>
                <th className="px-3 py-2 text-right">%</th>
                <th className="px-3 py-2 text-left">Situação</th>
                <th className="px-3 py-2 text-right">TSE</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {lista.map((c) => {
                const h = (hist[c.personId] ?? []).filter((x) => x.ano !== c.ano);
                const anterior = h.find((x) => x.ano < c.ano) ?? h[0];
                const delta = anterior ? c.votos - anterior.votos : null;
                return (
                  <tr key={c.sq} className="bg-nexo-inset transition-colors hover:bg-white/[0.03]">
                    <td className="px-3 py-2 text-slate-500">{c.posicao}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2.5">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={urlFotoCandidato(c.ano, c.sq) ?? undefined}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.visibility = 'hidden';
                          }}
                          className="h-9 w-7 shrink-0 rounded object-cover ring-1 ring-white/10"
                        />
                        <div className="min-w-0">
                          <Link
                            href={`/nexo/pessoa/${encodeURIComponent(c.personId)}`}
                            className="font-medium text-slate-100 hover:text-amber-300"
                          >
                            {c.urna}
                          </Link>
                          <div className="text-[11px] text-slate-500">
                            nº {c.nr}
                            {c.coligacao && c.coligacao !== '#NULO#' ? ` · ${c.coligacao}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/nexo/eleicoes/partido/${encodeURIComponent(c.partido)}`}
                        className="text-slate-300 hover:text-amber-300"
                      >
                        {c.partido}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-100">
                      {nfmt.format(c.votos)}
                      {delta != null && (
                        <span
                          className={cn(
                            'ml-1 inline-flex items-center text-[10px]',
                            delta > 0 ? 'text-emerald-400' : delta < 0 ? 'text-red-400' : 'text-slate-500',
                          )}
                          title={`vs ${anterior?.ano}: ${anterior ? nfmt.format(anterior.votos) : ''}`}
                        >
                          {delta > 0 ? (
                            <ArrowUp className="h-2.5 w-2.5" />
                          ) : delta < 0 ? (
                            <ArrowDown className="h-2.5 w-2.5" />
                          ) : (
                            <Minus className="h-2.5 w-2.5" />
                          )}
                          {nfmt.format(Math.abs(delta))}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-400">
                      {pct(c.votos, totalCargo)}
                    </td>
                    <td className="px-3 py-2">
                      {c.eleito ? (
                        <Badge className="bg-emerald-500/15 text-emerald-300">
                          <Trophy className="mr-1 h-3 w-3" />
                          {c.situacao || 'Eleito'}
                        </Badge>
                      ) : (
                        <span className="text-[11px] text-slate-500">{c.situacao || 'Não eleito'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <a
                        href={urlDivulgaCandidato(c.ano, c.sq)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Abrir no DivulgaCandContas"
                        className="inline-flex text-slate-500 hover:text-sky-400"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-slate-400">
        Fonte: TSE — dados-abertos. Clique no candidato para a ficha completa (trajetória,
        finanças e cruzamentos) ou no partido para a página do partido. A seta ao lado dos
        votos compara com a eleição anterior em que a pessoa concorreu.
      </p>
    </div>
  );
}
