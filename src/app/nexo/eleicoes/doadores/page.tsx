'use client';

/**
 * Ranking de DOADORES de campanha — Marília.
 *
 * Universo: SÓ MUNICIPAIS, últimas 2 eleições (2020/2024). Entra quem doou
 * para candidato a VEREADOR de Marília; o acumulado soma também doações a
 * prefeito de Marília das mesmas pessoas. Estaduais/federais fora do escopo
 * (decisão do dono, 07/2026).
 *
 * Clique no nome (PF) abre a ficha unificada da pessoa; PJ abre o fornecedor.
 * Linha expande com o extrato de doações. "Recursos próprios" (candidato
 * financiando a si mesmo) são ocultáveis — é o default, o interesse é quem
 * financia OS OUTROS.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  HandCoins,
  Search,
  ChevronDown,
  ChevronRight,
  Users,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface Doacao {
  ano: number;
  eleicao?: string;
  candidato: string | null;
  sq?: string | null;
  cargo: string | null;
  partido: string | null;
  valor: number;
  data: string | null;
  natureza?: string | null;
  proprio?: boolean;
}
interface Doador {
  cpf: string;
  nome: string;
  tipo: 'fisica' | 'juridica' | 'partido';
  total: number;
  n: number;
  totalVereador: number;
  nVereador: number;
  acumulado: number;
  anos: Record<string, { total: number; n: number }>;
  doacoes: Doacao[];
  personId: string | null;
  temProprio: boolean;
}

const nfmt = new Intl.NumberFormat('pt-BR');
const brl = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);
const fmtCpfCnpj = (s: string) =>
  s.length === 14
    ? s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
    : s.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');

export default function DoadoresPage() {
  const [doadores, setDoadores] = useState<Doador[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [tipo, setTipo] = useState<'' | 'fisica' | 'juridica' | 'partido'>('');
  const [semProprios, setSemProprios] = useState(true);
  const [ordem, setOrdem] = useState<'valor' | 'qtd'>('valor');
  const [aberto, setAberto] = useState<string | null>(null);

  const [cruz, setCruz] = useState<Record<string, { socio?: unknown; fornecedor?: unknown; servidor?: unknown }>>({});

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const [r, rc] = await Promise.all([
          fetch('/eleicoes/doadores.json'),
          fetch('/eleicoes/cruzamento_nexo.json'),
        ]);
        const j = r.ok ? await r.json() : { doadores: [] };
        const jc = rc.ok ? await rc.json() : {};
        if (vivo) {
          setDoadores(j.doadores ?? []);
          setCruz(jc ?? {});
        }
      } catch {
        if (vivo) setDoadores([]);
      } finally {
        if (vivo) setLoading(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  // valor rankeável conforme o toggle de recursos próprios
  const comCalculo = useMemo(
    () =>
      doadores.map((d) => {
        const proprio = d.doacoes.filter((x) => x.proprio).reduce((s, x) => s + x.valor, 0);
        const nProprio = d.doacoes.filter((x) => x.proprio).length;
        return {
          ...d,
          valorProprio: proprio,
          valorTerceiros: Math.max(0, d.acumulado - proprio),
          nTerceiros: d.n - nProprio,
        };
      }),
    [doadores],
  );

  const lista = useMemo(() => {
    const termo = q.trim().toLowerCase();
    const digitos = termo.replace(/\D+/g, '');
    let arr = comCalculo.filter((d) => {
      if (tipo ? d.tipo !== tipo : d.tipo === 'partido') return false;
      if (semProprios && d.valorTerceiros <= 0) return false;
      if (termo) {
        const bateNome = d.nome.toLowerCase().includes(termo);
        const bateCpf = digitos.length >= 4 && d.cpf.includes(digitos);
        const bateCand = d.doacoes.some((x) => x.candidato?.toLowerCase().includes(termo));
        if (!bateNome && !bateCpf && !bateCand) return false;
      }
      return true;
    });
    const val = (d: (typeof arr)[number]) => (semProprios ? d.valorTerceiros : d.acumulado);
    const qtd = (d: (typeof arr)[number]) => (semProprios ? d.nTerceiros : d.n);
    arr = [...arr].sort((a, b) => (ordem === 'valor' ? val(b) - val(a) : qtd(b) - qtd(a)));
    return arr;
  }, [comCalculo, q, tipo, semProprios, ordem]);

  const totais = useMemo(() => {
    const t = { valor: 0, n: 0 };
    for (const d of lista) {
      t.valor += semProprios ? d.valorTerceiros : d.acumulado;
      t.n += semProprios ? d.nTerceiros : d.n;
    }
    return t;
  }, [lista, semProprios]);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <Link href="/nexo/eleicoes" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
        <ArrowLeft className="h-3.5 w-3.5" /> Eleições
      </Link>

      <header className="flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-500/15 text-red-400">
          <HandCoins className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Doadores de campanha — Marília</h1>
          <p className="text-xs text-slate-500">
            Quem financia candidatos a vereador · eleições municipais de 2012 a 2024
          </p>
        </div>
        {!loading && (
          <div className="ml-auto flex gap-2 text-xs text-slate-500">
            <span className="rounded bg-white/5 px-2 py-1">
              <Users className="mr-1 inline h-3 w-3" />
              {nfmt.format(lista.length)} doador(es)
            </span>
            <span className="rounded bg-red-500/10 px-2 py-1 text-red-300">{brl(totais.valor)}</span>
            <span className="rounded bg-white/5 px-2 py-1">{nfmt.format(totais.n)} doações</span>
          </div>
        )}
      </header>

      {/* filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Nome, CPF/CNPJ ou candidato beneficiado…"
            className="w-full rounded-md border border-white/10 bg-nexo-chrome py-2 pl-9 pr-3 text-sm text-slate-200 placeholder:text-slate-500 focus:border-red-500/40 focus:outline-none"
          />
        </div>
        <select
          value={tipo}
          onChange={(e) => setTipo(e.target.value as typeof tipo)}
          className="rounded-md border border-white/10 bg-nexo-chrome px-2 py-2 text-sm text-slate-300"
        >
          <option value="">PF + PJ (sem partidos)</option>
          <option value="fisica">Pessoa física</option>
          <option value="juridica">Pessoa jurídica</option>
          <option value="partido">Órgãos partidários</option>
        </select>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-white/10 bg-nexo-chrome px-3 py-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={semProprios}
            onChange={(e) => setSemProprios(e.target.checked)}
            className="accent-red-500"
          />
          ocultar recursos próprios (candidato → ele mesmo)
        </label>
        <button
          onClick={() => setOrdem((o) => (o === 'valor' ? 'qtd' : 'valor'))}
          className="rounded-md border border-white/10 px-3 py-2 text-sm text-slate-300 hover:text-slate-100"
        >
          Ordenar: {ordem === 'valor' ? 'valor ↓' : 'nº doações ↓'}
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : lista.length === 0 ? (
        <Card className="border-white/10 bg-nexo-chrome">
          <CardContent className="py-10 text-center text-sm text-slate-500">
            {doadores.length === 0
              ? 'Ranking de doadores ainda não compilado.'
              : 'Nenhum doador para este filtro.'}
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-nexo-chrome text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="w-8 px-2 py-2" />
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">Doador</th>
                <th className="px-3 py-2 text-right">Acumulado</th>
                <th className="px-3 py-2 text-right">Doações</th>
                <th className="px-3 py-2 text-left">Por eleição</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {lista.slice(0, 300).map((d, i) => {
                const expandido = aberto === d.cpf;
                const doacoesVisiveis = semProprios ? d.doacoes.filter((x) => !x.proprio) : d.doacoes;
                return (
                  <>
                    <tr
                      key={d.cpf}
                      onClick={() => setAberto(expandido ? null : d.cpf)}
                      className="cursor-pointer bg-nexo-inset transition-colors hover:bg-white/[0.03]"
                    >
                      <td className="px-2 py-2 text-slate-400">
                        {expandido ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </td>
                      <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                      <td className="px-3 py-2">
                        {d.tipo === 'fisica' && d.personId ? (
                          <Link
                            href={`/nexo/pessoa/${encodeURIComponent(d.personId)}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-medium text-slate-100 hover:text-red-300"
                          >
                            {d.nome}
                          </Link>
                        ) : d.tipo === 'juridica' ? (
                          <Link
                            href={`/nexo/fornecedores/${d.cpf}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-medium text-slate-100 hover:text-red-300"
                          >
                            {d.nome}
                          </Link>
                        ) : (
                          <span className="font-medium text-slate-100">{d.nome}</span>
                        )}
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                          <span className="font-mono">{fmtCpfCnpj(d.cpf)}</span>
                          <span
                            className={cn(
                              'rounded px-1.5 py-px',
                              d.tipo === 'juridica'
                                ? 'bg-sky-500/10 text-sky-300'
                                : d.tipo === 'partido'
                                  ? 'bg-violet-500/10 text-violet-300'
                                  : 'bg-white/5 text-slate-400',
                            )}
                          >
                            {d.tipo === 'juridica' ? 'PJ' : d.tipo === 'partido' ? 'PARTIDO' : 'PF'}
                          </span>
                          {d.temProprio && !semProprios && (
                            <span className="rounded bg-amber-500/10 px-1.5 py-px text-amber-300">
                              inclui recursos próprios
                            </span>
                          )}
                          {d.personId && cruz[d.personId]?.socio ? (
                            <span className="rounded bg-sky-500/10 px-1.5 py-px text-sky-300">
                              sócio de empresa
                            </span>
                          ) : null}
                          {d.personId && cruz[d.personId]?.fornecedor ? (
                            <span className="rounded bg-orange-500/10 px-1.5 py-px text-orange-300">
                              fornecedor da prefeitura
                            </span>
                          ) : null}
                          {d.personId && cruz[d.personId]?.servidor ? (
                            <span className="rounded bg-violet-500/10 px-1.5 py-px text-violet-300">
                              servidor/beneficiário
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-red-300">
                        {brl(semProprios ? d.valorTerceiros : d.acumulado)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-300">
                        {nfmt.format(semProprios ? d.nTerceiros : d.n)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(d.anos)
                            .sort((a, b) => Number(b[0]) - Number(a[0]))
                            .map(([ano, v]) => (
                              <span key={ano} className="rounded bg-white/5 px-1.5 py-px text-[11px] text-slate-400">
                                {ano}: {brl(v.total)}
                              </span>
                            ))}
                        </div>
                      </td>
                    </tr>
                    {expandido && (
                      <tr key={`${d.cpf}-det`} className="bg-nexo-chrome">
                        <td colSpan={6} className="px-4 py-3">
                          <div>
                            <p className="pb-1.5 text-[11px] uppercase tracking-widest text-slate-500">
                              Doações ({doacoesVisiveis.length})
                            </p>
                            <ul className="max-h-64 space-y-1 overflow-y-auto pr-2 text-xs">
                              {doacoesVisiveis.map((x, j) => (
                                <li key={j} className="flex justify-between gap-2 text-slate-300">
                                  <span className="truncate">
                                    <span className="text-slate-500">{x.ano}</span> {x.candidato ?? '—'}
                                    <span className="text-slate-500">
                                      {' '}
                                      {x.partido ?? ''} · {x.cargo?.toLowerCase()}
                                    </span>
                                    {x.proprio && <span className="text-amber-400"> (próprio)</span>}
                                  </span>
                                  <span className="shrink-0 font-mono text-slate-200">{brl(x.valor)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
          {lista.length > 300 && (
            <p className="border-t border-white/5 bg-nexo-chrome px-3 py-2 text-[11px] text-slate-500">
              Mostrando os 300 primeiros de {nfmt.format(lista.length)} — refine com a busca.
            </p>
          )}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-slate-400">
        Fonte: prestação de contas eleitorais do TSE (receitas declaradas pelos candidatos),
        eleições municipais de 2012 a 2024. Entram no ranking apenas doadores com pelo menos
        uma doação a candidato a VEREADOR de Marília; o acumulado soma também doações a
        prefeito de Marília. Doação de EMPRESA era legal até 2015 — as PJs do ranking vêm
        quase todas de 2012. Vínculo por CPF/CNPJ declarado. Doação legal não é
        irregularidade — o ranking é ferramenta de transparência.
      </p>
    </div>
  );
}
