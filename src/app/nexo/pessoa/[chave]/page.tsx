'use client';

/**
 * Ficha unificada de Pessoa Física — o hub que cruza TUDO sobre uma pessoa.
 *
 * Chave = personId ('n:'+nome_normalizado). Qualquer link de pessoa no NEXO
 * (candidato, doador, sócio, servidor, citado no DOM) aponta pra cá. Junta:
 *  - trajetória eleitoral (candidaturas + resultados, todas as eleições)
 *  - finanças de campanha (receita/despesa por eleição)
 *  - doações que fez / recebeu
 *  - empresas onde é sócio  · vínculo de servidor  · fornecedor da prefeitura
 *  - citações no Diário Oficial (decretos/portarias/nomeações)
 *
 * Dados eleitorais são estáticos (public/eleicoes/*); os cruzamentos vêm de
 * cruzamento_nexo.json (materializado por processo de fundo). Seções sem dado
 * simplesmente não aparecem.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  UserSquare2,
  ArrowLeft,
  Trophy,
  Vote,
  HandCoins,
  Building2,
  Briefcase,
  Newspaper,
  ExternalLink,
  Wallet,
  Landmark,
  Map as MapIcon,
  AlertTriangle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { urlDivulgaCandidato, urlContasCandidato } from '@/lib/eleicoes/links';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import type { PessoaConexoesResponse } from '@/app/api/nexo/pessoa-conexoes/route';

const ANOS = [2024, 2020, 2016, 2012] as const;
const nfmt = new Intl.NumberFormat('pt-BR');
const brl = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);

interface Cand {
  ano: number;
  sq: string;
  nr: string;
  nome: string;
  urna: string;
  cargo: string;
  partido: string;
  coligacao: string;
  situacao: string;
  eleito: boolean;
  votos: number;
  personId: string;
  titulo?: string | null;
  aliasIds?: string[];
}
interface Ficha {
  titulo: string | null;
  nascimento: string | null;
  genero: string | null;
  instrucao: string | null;
  estadoCivil: string | null;
  corRaca: string | null;
  ocupacao: string | null;
  foto: string;
  bensTotal: number;
  bens: { tipo: string | null; descricao: string | null; valor: number }[];
}
interface Cruz {
  doou?: {
    valorTotal: number;
    n: number;
    para?: { candidato: string; valor: number }[];
    municipio?: string;
  };
  recebeu?: { valorTotal: number; n: number; de?: string[] };
  socio?: { empresas: { cnpj: string; razaoSocial?: string; nome?: string }[] };
  fornecedor?: { total: number; entidadeId?: string; cnpj?: string; nEmpenhos?: number; nContratos?: number };
  servidor?: {
    cargo?: string | null;
    orgao?: string;
    orgaos?: string[];
    vinculo?: string;
    valorDiariasPassagens?: number;
    nMovimentos?: number;
  };
  dom?: {
    n: number;
    exemplos?: { data?: string; tipo?: string; trecho?: string; edicao?: string }[];
  };
}
type Financas = Record<string, { receita?: number; despesa?: number }>;

interface DoadorDet {
  cpf: string;
  nome: string;
  tipo: string;
  acumulado: number;
  n: number;
  personId: string | null;
  doacoes: {
    ano: number;
    candidato: string | null;
    cargo: string | null;
    partido: string | null;
    valor: number;
    proprio?: boolean;
  }[];
}

export default function PessoaPage() {
  const params = useParams<{ chave: string }>();
  const personId = decodeURIComponent(
    Array.isArray(params.chave) ? params.chave[0] : params.chave || '',
  );

  const [cands, setCands] = useState<Cand[]>([]);
  const [cruz, setCruz] = useState<Cruz | null>(null);
  const [fin, setFin] = useState<Record<number, Financas>>({});
  const [fichas, setFichas] = useState<Record<number, Record<string, Ficha>>>({});
  const [fotoOk, setFotoOk] = useState(true);
  const [loading, setLoading] = useState(true);
  const [doadorDet, setDoadorDet] = useState<DoadorDet | null>(null);
  const [conexoes, setConexoes] = useState<PessoaConexoesResponse | null>(null);
  const [conexoesLoading, setConexoesLoading] = useState(false);
  // drill-down dos empenhos do fornecedor PF (via raio-x) — sob demanda.
  const [empenhoIds, setEmpenhoIds] = useState<string[] | null>(null);
  const [empLoading, setEmpLoading] = useState(false);

  useEffect(() => {
    let vivo = true;
    (async () => {
      setLoading(true);
      setFotoOk(true);
      const jsonOr = async (u: string, fb: any) => {
        try {
          const r = await fetch(u);
          return r.ok ? await r.json() : fb;
        } catch {
          return fb;
        }
      };
      const [c24, c20, c16, c12, cruzAll, f24, f20, f16, fi24, fi20, fi16, fi12, doadoresAll] = await Promise.all([
        jsonOr('/eleicoes/candidatos_2024.json', []),
        jsonOr('/eleicoes/candidatos_2020.json', []),
        jsonOr('/eleicoes/candidatos_2016.json', []),
        jsonOr('/eleicoes/candidatos_2012.json', []),
        jsonOr('/eleicoes/cruzamento_nexo.json', {}),
        jsonOr('/eleicoes/financas_2024.json', {}),
        jsonOr('/eleicoes/financas_2020.json', {}),
        jsonOr('/eleicoes/financas_2016.json', {}),
        jsonOr('/eleicoes/fichas_2024.json', {}),
        jsonOr('/eleicoes/fichas_2020.json', {}),
        jsonOr('/eleicoes/fichas_2016.json', {}),
        jsonOr('/eleicoes/fichas_2012.json', {}),
        jsonOr('/eleicoes/doadores.json', { doadores: [] }),
      ]);
      if (!vivo) return;
      const meus = ([] as Cand[])
        .concat(c24, c20, c16, c12)
        .filter((c: Cand) => c.personId === personId || c.aliasIds?.includes(personId))
        .sort((a, b) => b.ano - a.ano);
      setCands(meus);
      setCruz(cruzAll[personId] ?? cruzAll[meus[0]?.personId ?? ''] ?? null);
      setFin({ 2024: f24, 2020: f20, 2016: f16 });
      setFichas({ 2024: fi24, 2020: fi20, 2016: fi16, 2012: fi12 });
      const ids = new Set([personId, meus[0]?.personId].filter(Boolean));
      setDoadorDet(
        ((doadoresAll.doadores ?? []) as DoadorDet[]).find((x) => x.personId && ids.has(x.personId)) ?? null,
      );
      setLoading(false);
    })();
    return () => {
      vivo = false;
    };
  }, [personId]);

  // conexões dinâmicas (QSA + agregados de contratos) — consulta o NEXO ao vivo
  const nomeBusca = cands[0]?.nome || doadorDet?.nome || personId.replace(/^n:/, '');
  useEffect(() => {
    if (loading || !nomeBusca || nomeBusca.length < 5) return;
    let vivo = true;
    (async () => {
      setConexoesLoading(true);
      try {
        const r = await nexoFetch(`/api/nexo/pessoa-conexoes?nome=${encodeURIComponent(nomeBusca)}`);
        const j = r.ok ? ((await r.json()) as PessoaConexoesResponse) : null;
        if (vivo) setConexoes(j);
      } catch {
        if (vivo) setConexoes(null);
      } finally {
        if (vivo) setConexoesLoading(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [loading, nomeBusca]);

  const nome = cands[0]?.nome || cands[0]?.urna || doadorDet?.nome || personId.replace(/^n:/, '');
  const ultimo = cands[0];
  const fichaAtual: Ficha | null = ultimo ? fichas[ultimo.ano]?.[ultimo.sq] ?? null : null;

  // idade a partir de dd/mm/aaaa
  const idade = useMemo(() => {
    const m = fichaAtual?.nascimento?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const nasc = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    const hoje = new Date();
    let a = hoje.getFullYear() - nasc.getFullYear();
    if (hoje < new Date(hoje.getFullYear(), nasc.getMonth(), nasc.getDate())) a--;
    return a;
  }, [fichaAtual]);

  // homônimo real: mesmo nome com títulos de eleitor diferentes
  const multiTitulo = useMemo(() => {
    const t = new Set(cands.map((c) => c.titulo).filter(Boolean));
    return t.size > 1;
  }, [cands]);

  // bens declarados por eleição (um registro por ano, do mais recente pro mais antigo)
  const bensPorAno = useMemo(
    () =>
      cands
        .map((c) => ({ ano: c.ano, ficha: fichas[c.ano]?.[c.sq] }))
        .filter((x): x is { ano: number; ficha: Ficha } => !!x.ficha && x.ficha.bens.length > 0),
    [cands, fichas],
  );

  // Busca os empenhos do fornecedor PF (docIds) via raio-x, sob demanda —
  // cada um vira link para /nexo/empenho/{id} (detalhe com notas e vínculos).
  const verEmpenhosFornecedor = async () => {
    if (empLoading || empenhoIds) return;
    setEmpLoading(true);
    try {
      const r = await nexoFetch(`/api/nexo/busca?tipo=entidade&q=${encodeURIComponent(nomeBusca)}`);
      const j = r.ok ? await r.json() : null;
      const ids = (j?.empenhos?.docIds ?? []) as string[];
      setEmpenhoIds(ids);
    } catch {
      setEmpenhoIds([]);
    } finally {
      setEmpLoading(false);
    }
  };

  const empresasConexao = conexoes?.empresas ?? [];
  const empresasComDinheiro = empresasConexao.filter((e) => e.totalEmpenhado > 0 || e.nContratos > 0);
  const ehDoador = !!doadorDet || !!cruz?.doou;
  const ehSocio = empresasConexao.length > 0 || !!cruz?.socio;
  const ehFornecedor = !!cruz?.fornecedor || !!conexoes?.fornecedorPF;

  const tags = useMemo(() => {
    const t: { label: string; cls: string }[] = [];
    if (cands.length) t.push({ label: 'Candidato', cls: 'bg-amber-500/15 text-amber-300' });
    if (cands.some((c) => c.eleito)) t.push({ label: 'Eleito', cls: 'bg-emerald-500/15 text-emerald-300' });
    if (ehDoador) t.push({ label: 'Doador', cls: 'bg-red-500/15 text-red-300' });
    if (ehSocio) t.push({ label: 'Sócio de empresa', cls: 'bg-sky-500/15 text-sky-300' });
    if (cruz?.servidor) t.push({ label: 'Servidor público', cls: 'bg-violet-500/15 text-violet-300' });
    if (ehFornecedor) t.push({ label: 'Fornecedor', cls: 'bg-orange-500/15 text-orange-300' });
    if (cruz?.dom) t.push({ label: 'Citado no DOM', cls: 'bg-slate-500/20 text-slate-300' });
    return t;
  }, [cands, cruz, ehDoador, ehSocio, ehFornecedor]);

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!cands.length && !cruz && !doadorDet) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Link href="/nexo/eleicoes" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
          <ArrowLeft className="h-3.5 w-3.5" /> Eleições
        </Link>
        <Card className="mt-4 border-white/10 bg-nexo-chrome">
          <CardContent className="py-10 text-center text-sm text-slate-500">
            Nenhum registro encontrado para <span className="text-slate-300">{nome}</span>.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <Link href="/nexo/eleicoes" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
        <ArrowLeft className="h-3.5 w-3.5" /> Eleições
      </Link>

      {/* Cabeçalho */}
      <div className="flex flex-wrap items-start gap-3">
        {fichaAtual && fotoOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={fichaAtual.foto}
            alt={`Foto oficial de ${nome} (TSE)`}
            onError={() => setFotoOk(false)}
            className="h-20 w-16 rounded-lg border border-white/10 object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-slate-500/15 text-slate-300">
            <UserSquare2 className="h-6 w-6" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-slate-100">{nome}</h1>
          {ultimo && (
            <p className="text-xs text-slate-500">
              Última candidatura: {ultimo.cargo?.toLowerCase()} em {ultimo.ano} · {ultimo.partido}
            </p>
          )}
          {fichaAtual && (
            <p className="mt-0.5 text-xs text-slate-400">
              {[
                idade != null ? `${idade} anos` : null,
                fichaAtual.ocupacao?.toLowerCase(),
                fichaAtual.instrucao?.toLowerCase(),
                fichaAtual.estadoCivil?.toLowerCase(),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span key={t.label} className={cn('rounded px-2 py-0.5 text-[11px] font-medium', t.cls)}>
                {t.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {multiTitulo && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Atenção: existem <b>duas pessoas diferentes</b> com este nome (títulos de eleitor
            distintos no TSE). A trajetória abaixo pode misturar as duas — confira ano a ano.
          </span>
        </div>
      )}

      {/* RADAR: contas julgadas irregulares no TCE-SP (Ficha Limpa) */}
      {conexoes?.contasIrregulares?.length ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/[0.07] px-3 py-2.5 text-xs text-red-200">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <b>TCE-SP Ficha Limpa:</b> há {conexoes.contasIrregulares.length} registro(s) de{' '}
              <b>contas julgadas irregulares</b> em nome idêntico. Match por NOME — confirme a
              identidade pelo CPF parcial antes de qualquer conclusão.
            </span>
          </p>
          <ul className="mt-1.5 space-y-0.5 pl-6">
            {conexoes.contasIrregulares.map((c, i) => (
              <li key={i} className="text-red-200/90">
                {c.processoTC ? `TC ${c.processoTC}` : 'processo s/nº'}
                {c.exercicio ? ` · exercício ${c.exercicio}` : ''}
                {c.origem ? ` · ${c.origem}` : ''}
                {c.cpfParcial ? ` · CPF parcial ${c.cpfParcial}` : ''}
                {c.transitoJulgado ? ` · trânsito ${c.transitoJulgado}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* RADAR: doador com empresa que recebe dinheiro público */}
      {ehDoador && empresasComDinheiro.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/[0.07] px-3 py-2.5 text-xs text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <b>Radar:</b> esta pessoa é <b>doadora de campanha</b> e sócia de{' '}
            {empresasComDinheiro.length === 1 ? 'uma empresa' : `${empresasComDinheiro.length} empresas`} com
            dinheiro público —{' '}
            {brl(empresasComDinheiro.reduce((s, e) => s + e.totalEmpenhado, 0))} em empenhos da
            prefeitura. Cruzamento por nome (confira homônimos); doação legal não é irregularidade.
          </span>
        </div>
      )}

      {/* Trajetória eleitoral */}
      {cands.length > 0 && (
        <Secao icon={Vote} titulo="Trajetória eleitoral">
          <div className="overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full text-sm">
              <thead className="bg-nexo-chrome text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Ano</th>
                  <th className="px-3 py-2 text-left">Cargo</th>
                  <th className="px-3 py-2 text-left">Partido</th>
                  <th className="px-3 py-2 text-right">Votos</th>
                  <th className="px-3 py-2 text-left">Situação</th>
                  <th className="px-3 py-2 text-right">Campanha</th>
                  <th className="px-3 py-2 text-right">TSE</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {cands.map((c) => {
                  const f = fin[c.ano]?.[c.sq];
                  return (
                    <tr key={`${c.ano}-${c.sq}`} className="bg-nexo-inset">
                      <td className="px-3 py-2 font-mono text-slate-300">{c.ano}</td>
                      <td className="px-3 py-2 text-slate-400">{c.cargo?.toLowerCase()}</td>
                      <td className="px-3 py-2 text-slate-300">{c.partido}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-100">
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
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {f?.receita != null ? (
                          <span className="text-slate-300" title={`Despesa: ${brl(f.despesa || 0)}`}>
                            {brl(f.receita)}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <a
                          href={urlDivulgaCandidato(c.ano, c.sq)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
                        >
                          ficha <ExternalLink className="h-3 w-3" />
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {cands.some((c) => fin[c.ano]?.[c.sq]?.receita != null) && (
            <p className="mt-1.5 text-[11px] text-slate-400">
              "Campanha" = receita declarada; passe o mouse para a despesa. Custo por voto e
              detalhamento na ficha do TSE.
            </p>
          )}
          {ultimo && (
            <Link
              href={`/nexo/eleicoes/mapa?cargo=${ultimo.cargo?.toLowerCase().startsWith('prefeito') ? 'prefeito' : 'vereador'}&cand=${ultimo.nr}&ano=${ultimo.ano}`}
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300"
            >
              <MapIcon className="h-3.5 w-3.5" /> ver força por bairro no mapa ({ultimo.ano}) →
            </Link>
          )}
        </Secao>
      )}

      {/* Bens declarados (TSE) */}
      {bensPorAno.length > 0 && (
        <Secao icon={Landmark} titulo="Bens declarados ao TSE">
          {bensPorAno.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {[...bensPorAno]
                .sort((a, b) => a.ano - b.ano)
                .map((b, i, arr) => {
                  const ant = i > 0 ? arr[i - 1].ficha.bensTotal : null;
                  const delta = ant != null && ant > 0 ? ((b.ficha.bensTotal - ant) / ant) * 100 : null;
                  return (
                    <div key={b.ano} className="rounded-md border border-white/10 bg-nexo-chrome px-3 py-2">
                      <p className="text-[11px] text-slate-500">{b.ano}</p>
                      <p className="font-mono text-sm text-slate-200">{brl(b.ficha.bensTotal)}</p>
                      {delta != null && (
                        <p className={cn('text-[11px]', delta > 0 ? 'text-emerald-400' : delta < 0 ? 'text-red-400' : 'text-slate-500')}>
                          {delta > 0 ? '+' : ''}
                          {delta.toFixed(0)}% vs {arr[i - 1].ano}
                        </p>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full text-sm">
              <thead className="bg-nexo-chrome text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">
                    Declaração de {bensPorAno[0].ano} · {bensPorAno[0].ficha.bens.length} bem(ns)
                  </th>
                  <th className="px-3 py-2 text-right font-mono normal-case text-slate-300">
                    {brl(bensPorAno[0].ficha.bensTotal)}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {bensPorAno[0].ficha.bens.map((b, i) => (
                  <tr key={i} className="bg-nexo-inset">
                    <td className="px-3 py-1.5">
                      <span className="text-slate-300">{b.tipo || 'Bem'}</span>
                      {b.descricao && <span className="text-[11px] text-slate-500"> — {b.descricao}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-slate-300">{brl(b.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-400">
            Autodeclarado ao TSE no registro de candidatura (valores nominais da época, sem
            correção). Variação entre eleições pode refletir só mudança no que foi declarado.
          </p>
        </Secao>
      )}

      {/* Doações — extrato rico do módulo de doadores */}
      {doadorDet && (
        <Secao icon={HandCoins} titulo={`Doações que fez · ${brl(doadorDet.acumulado)}`}>
          <div className="overflow-x-auto rounded-lg border border-red-500/20">
            <table className="w-full text-sm">
              <thead className="bg-nexo-chrome text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Ano</th>
                  <th className="px-3 py-2 text-left">Beneficiado</th>
                  <th className="px-3 py-2 text-left">Partido</th>
                  <th className="px-3 py-2 text-right">Valor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {doadorDet.doacoes.map((x, i) => (
                  <tr key={i} className="bg-nexo-inset">
                    <td className="px-3 py-1.5 font-mono text-slate-400">{x.ano}</td>
                    <td className="px-3 py-1.5 text-slate-200">
                      {x.candidato ?? '—'}
                      <span className="text-[11px] text-slate-500"> {x.cargo?.toLowerCase()}</span>
                      {x.proprio && <span className="text-[11px] text-amber-400"> (recursos próprios)</span>}
                    </td>
                    <td className="px-3 py-1.5 text-slate-400">{x.partido ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-red-300">{brl(x.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Link href="/nexo/eleicoes/doadores" className="text-xs text-sky-400 hover:text-sky-300">
            ver no ranking de doadores →
          </Link>
        </Secao>
      )}

      {/* Doações (resumo do cruzamento, quando não há extrato / recebidas) */}
      {((!doadorDet && cruz?.doou) || cruz?.recebeu) && (
        <Secao icon={HandCoins} titulo={doadorDet ? 'Doações recebidas (campanha)' : 'Doações de campanha'}>
          <div className="grid gap-3 sm:grid-cols-2">
            {!doadorDet && cruz?.doou && (
              <Card className="border-red-500/20 bg-red-500/[0.03]">
                <CardContent className="p-4">
                  <p className="text-xs text-slate-400">Doou (como financiador)</p>
                  <p className="font-mono text-lg text-red-300">{brl(cruz.doou.valorTotal)}</p>
                  <p className="text-[11px] text-slate-500">
                    {cruz.doou.n} doação(ões){cruz.doou.municipio ? ` · ${cruz.doou.municipio}` : ''}
                  </p>
                  {cruz.doou.para?.length ? (
                    <p className="mt-1 text-[11px] text-slate-400">
                      Para: {cruz.doou.para.slice(0, 6).map((p) => p.candidato).join(', ')}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            )}
            {cruz?.recebeu && (
              <Card className="border-white/10 bg-nexo-chrome">
                <CardContent className="p-4">
                  <p className="text-xs text-slate-400">Recebeu (na campanha)</p>
                  <p className="font-mono text-lg text-slate-200">{brl(cruz.recebeu.valorTotal)}</p>
                  <p className="text-[11px] text-slate-500">{cruz.recebeu.n} doação(ões)</p>
                </CardContent>
              </Card>
            )}
          </div>
        </Secao>
      )}

      {/* Empresas (sócio) — dinâmico: QSA do NEXO + agregados de dinheiro público */}
      {(() => {
        // funde a consulta ao vivo com o cruzamento estático (CNPJs que só um dos dois conhece)
        const vistos = new Set(empresasConexao.map((e) => e.cnpj));
        const soEstaticas = (cruz?.socio?.empresas ?? []).filter((e) => !vistos.has(e.cnpj));
        const total = empresasConexao.length + soEstaticas.length;
        if (total === 0 && !conexoesLoading) return null;
        return (
          <Secao icon={Building2} titulo={`Empresas (sócio)${total ? ` · ${total}` : ''}`}>
            {conexoesLoading && (
              <p className="text-xs text-slate-500">consultando conexões no NEXO…</p>
            )}
            <ul className="space-y-1.5">
              {empresasConexao.map((e) => (
                <li
                  key={e.cnpj}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm',
                    e.totalEmpenhado > 0 || e.nContratos > 0
                      ? 'border-orange-500/25 bg-orange-500/[0.04]'
                      : 'border-white/10 bg-nexo-inset',
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/nexo/fornecedores/${e.cnpj}`} className="font-medium text-slate-200 hover:text-sky-300">
                      {e.razaoSocial || e.cnpj}
                    </Link>
                    <span className="font-mono text-xs text-slate-500">{e.cnpj}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                    {e.qualificacao && <span className="text-slate-500">{e.qualificacao}</span>}
                    {e.cpfMasc && <span className="font-mono text-slate-400">{e.cpfMasc}</span>}
                    {e.totalEmpenhado > 0 && (
                      <span className="rounded bg-orange-500/15 px-1.5 py-px font-mono text-orange-300">
                        {brl(e.totalEmpenhado)} empenhados
                      </span>
                    )}
                    {e.nContratos > 0 && (
                      <span className="rounded bg-orange-500/10 px-1.5 py-px text-orange-300">
                        {e.nContratos} contrato(s){e.contratosAtivos > 0 ? ` · ${e.contratosAtivos} ativo(s)` : ''}
                      </span>
                    )}
                    {e.sancionado && (
                      <span className="rounded bg-red-500/15 px-1.5 py-px font-semibold text-red-300">
                        SANCIONADA{e.nSancoes ? ` (${e.nSancoes})` : ''}
                      </span>
                    )}
                    {e.totalEmpenhado === 0 && e.nContratos === 0 && !e.sancionado && (
                      <span className="text-slate-400">sem dinheiro público identificado</span>
                    )}
                  </div>
                </li>
              ))}
              {soEstaticas.map((e) => (
                <li
                  key={e.cnpj}
                  className="flex items-center justify-between rounded-md border border-white/10 bg-nexo-inset px-3 py-2 text-sm"
                >
                  <Link href={`/nexo/fornecedores/${e.cnpj}`} className="text-slate-200 hover:text-sky-300">
                    {e.razaoSocial || e.nome || e.cnpj}
                  </Link>
                  <span className="font-mono text-xs text-slate-500">{e.cnpj}</span>
                </li>
              ))}
            </ul>
            {conexoes && !conexoes.disponivel && (
              <p className="text-[11px] text-amber-400/80">
                consulta ao vivo indisponível ({conexoes.motivo}) — mostrando só o cruzamento materializado.
              </p>
            )}
          </Secao>
        );
      })()}

      {/* Servidor / beneficiário público — folha real + diárias ao vivo + cruzamento */}
      {(cruz?.servidor || conexoes?.folha || conexoes?.diarias) && (
        <Secao icon={Briefcase} titulo="Servidor / beneficiário público">
          <div className="grid gap-3 sm:grid-cols-2">
            {conexoes?.folha && (
              <Card className="border-violet-500/25 bg-violet-500/[0.05]">
                <CardContent className="space-y-1 p-4 text-sm text-slate-300">
                  <p className="text-[11px] uppercase tracking-widest text-violet-300">
                    Na folha de pagamento ({conexoes.folha.exercicio})
                  </p>
                  {conexoes.folha.cargo && <p className="font-medium">{conexoes.folha.cargo}</p>}
                  {conexoes.folha.lotacao && <p className="text-slate-400">{conexoes.folha.lotacao}</p>}
                  <p className="text-[11px] text-slate-500">Fonte: folha municipal (SMARAPD) · match por nome</p>
                </CardContent>
              </Card>
            )}
            {conexoes?.diarias && (
              <Card className="border-violet-500/20 bg-violet-500/[0.03]">
                <CardContent className="space-y-1 p-4 text-sm text-slate-300">
                  <p className="text-[11px] uppercase tracking-widest text-violet-300">Diárias e passagens</p>
                  <p className="font-mono text-lg text-violet-200">{brl(conexoes.diarias.total)}</p>
                  <p className="text-[11px] text-slate-500">{conexoes.diarias.n} movimento(s)</p>
                  <ul className="space-y-0.5 pt-1 text-[11px] text-slate-400">
                    {conexoes.diarias.ultimas.slice(0, 5).map((m, i) => (
                      <li key={i} className="flex justify-between gap-2">
                        <span>
                          {m.data ?? '—'} · {m.tipo}
                        </span>
                        <span className="font-mono">{brl(m.valor)}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
            {cruz?.servidor && !conexoes?.folha && !conexoes?.diarias && (
              <Card className="border-violet-500/20 bg-violet-500/[0.03]">
                <CardContent className="space-y-1 p-4 text-sm text-slate-300">
                  {cruz.servidor.cargo && <p className="font-medium">{cruz.servidor.cargo}</p>}
                  {(cruz.servidor.orgaos?.length || cruz.servidor.orgao) && (
                    <p className="text-slate-400">
                      {(cruz.servidor.orgaos ?? [cruz.servidor.orgao!]).join(' · ')}
                    </p>
                  )}
                  <p className="text-[11px] text-slate-500">
                    {cruz.servidor.vinculo === 'beneficiario-diaria-passagem'
                      ? 'Beneficiário de diárias/passagens'
                      : cruz.servidor.vinculo}
                    {cruz.servidor.nMovimentos ? ` · ${cruz.servidor.nMovimentos} movimento(s)` : ''}
                    {cruz.servidor.valorDiariasPassagens
                      ? ` · ${brl(cruz.servidor.valorDiariasPassagens)}`
                      : ''}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </Secao>
      )}

      {/* Atos de pessoal no DOM (nomeações/exonerações estruturadas) */}
      {conexoes?.nomeacoes?.length ? (
        <Secao icon={Briefcase} titulo={`Atos de pessoal no Diário Oficial · ${conexoes.nomeacoes.length}`}>
          <ul className="space-y-1.5">
            {conexoes.nomeacoes.map((a, i) => (
              <li key={i} className="rounded-md border border-white/10 bg-nexo-inset px-3 py-2 text-sm">
                <div className="flex flex-wrap gap-2 text-[11px]">
                  {a.data && <span className="text-slate-500">{a.data}</span>}
                  {a.tipo && <span className="font-medium uppercase text-violet-300">{a.tipo}</span>}
                  {a.cargo && <span className="text-slate-400">{a.cargo}</span>}
                  {a.secretaria && <span className="text-slate-500">{a.secretaria}</span>}
                  {a.urlPdf && (
                    <a href={a.urlPdf} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:text-sky-300">
                      edição <ExternalLink className="inline h-3 w-3" />
                    </a>
                  )}
                </div>
                {a.trecho && <p className="pt-0.5 text-xs text-slate-400">{a.trecho}</p>}
              </li>
            ))}
          </ul>
        </Secao>
      ) : null}

      {/* Fornecedor (PF) — cruzamento estático ou consulta ao vivo */}
      {(() => {
        const f = cruz?.fornecedor
          ? { total: cruz.fornecedor.total, nEmpenhos: cruz.fornecedor.nEmpenhos, nContratos: cruz.fornecedor.nContratos, cnpj: cruz.fornecedor.cnpj, sancionado: false }
          : conexoes?.fornecedorPF
            ? { total: conexoes.fornecedorPF.totalEmpenhado, nEmpenhos: conexoes.fornecedorPF.nEmpenhos, nContratos: conexoes.fornecedorPF.nContratos, cnpj: undefined, sancionado: conexoes.fornecedorPF.sancionado }
            : null;
        if (!f) return null;
        return (
          <Secao icon={Wallet} titulo="Fornecedor da prefeitura (como pessoa física)">
            <Card className="border-orange-500/20 bg-orange-500/[0.03]">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-mono text-lg text-orange-300">{brl(f.total)}</span>
                    {(f.nEmpenhos || f.nContratos) ? (
                      <p className="text-[11px] text-slate-500">
                        {f.nEmpenhos ? `${f.nEmpenhos} empenho(s)` : ''}
                        {f.nContratos ? ` · ${f.nContratos} contrato(s)` : ''}
                        {f.sancionado ? ' · SANCIONADO' : ''}
                      </p>
                    ) : null}
                  </div>
                  {f.cnpj && (
                    <Link href={`/nexo/fornecedores/${f.cnpj}`} className="text-xs text-sky-400 hover:text-sky-300">
                      ver no NEXO →
                    </Link>
                  )}
                </div>

                {/* Drill-down: lista os empenhos, cada um abre o detalhe (notas/vínculos) */}
                {!empenhoIds ? (
                  <button
                    type="button"
                    onClick={verEmpenhosFornecedor}
                    disabled={empLoading}
                    className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-nexo-chrome px-2.5 py-1 text-xs text-slate-300 hover:border-orange-500/40 hover:text-orange-300 disabled:opacity-60"
                  >
                    {empLoading ? 'carregando…' : `ver ${f.nEmpenhos ? `os ${f.nEmpenhos} ` : ''}empenhos`}
                  </button>
                ) : empenhoIds.length === 0 ? (
                  <p className="text-[11px] text-slate-500">Não foi possível listar os empenhos individuais desta pessoa.</p>
                ) : (
                  <ul className="space-y-1">
                    {empenhoIds.map((eid) => (
                      <li key={eid}>
                        <Link
                          href={`/nexo/empenho/${encodeURIComponent(eid)}`}
                          className="flex items-center justify-between rounded-md border border-white/10 bg-nexo-inset px-3 py-1.5 text-xs hover:border-orange-500/40"
                        >
                          <span className="font-mono text-slate-300">empenho {eid}</span>
                          <span className="inline-flex items-center gap-1 text-orange-300">
                            abrir <ExternalLink className="h-3 w-3" />
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </Secao>
        );
      })()}

      {/* DOM */}
      {cruz?.dom && (
        <Secao icon={Newspaper} titulo={`Citações no Diário Oficial · ${cruz.dom.n}`}>
          <ul className="space-y-1.5">
            {(cruz.dom.exemplos ?? []).map((ex, i) => (
              <li key={i} className="rounded-md border border-white/10 bg-nexo-inset px-3 py-2 text-sm">
                <div className="flex gap-2 text-[11px] text-slate-500">
                  {ex.data && <span>{ex.data}</span>}
                  {ex.tipo && <span className="text-slate-400">{ex.tipo}</span>}
                </div>
                {ex.trecho && <p className="text-slate-300">{ex.trecho}</p>}
              </li>
            ))}
          </ul>
        </Secao>
      )}

      <p className="text-[11px] leading-relaxed text-slate-400">
        Ficha consolidada de fontes públicas (TSE + bases do NEXO). Cruzamentos por nome
        podem conter homônimos — todo indício requer conferência. Nada aqui é acusação.
      </p>
    </div>
  );
}

function Secao({
  icon: Icon,
  titulo,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
        <Icon className="h-4 w-4 text-slate-400" />
        {titulo}
      </h2>
      {children}
    </section>
  );
}
