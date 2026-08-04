'use client';

/**
 * NEXO — Painel de Risco (sala de situação / war-room).
 *
 * Ranking dos FORNECEDORES (empresas) por POTENCIAL DE RISCO a partir do RAIO-X
 * consolidado (`nexo_entidades`): prioriza sancionados, depois nº de flags do
 * perfil, depois volume empenhado. Mostra fornecedor (entity-chip do CNPJ),
 * total empenhado, contratos/vínculos, flags e selo de sanção.
 *
 * É um realce de INDÍCIO A APURAR, NUNCA acusação. Órgãos públicos e pessoas
 * físicas ficam fora do ranking (LGPD / qualidade dos resultados).
 * Fonte: /api/nexo/risco.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ShieldAlert,
  RefreshCw,
  TriangleAlert,
  ShieldCheck,
  Flag,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { RiscoResponse, OrdenarRisco, FornecedorRisco } from '@/app/api/nexo/risco/route';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';

const EXERCICIOS = [0, 2026, 2025] as const;
const TAMANHOS = [25, 50, 100];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

/**
 * Rótulos legíveis para os códigos de flag — nunca exibir o slug cru sozinho
 * (lição do "sancao 900": número/código sem contexto não informa). Códigos
 * desconhecidos caem no `humanizar`, que só troca separadores por espaços.
 */
const FLAG_ROTULO: Record<string, string> = {
  sancionado: 'Sancionado',
  inidoneo: 'Inidôneo (CEIS/CNEP)',
  'acima-limite': 'Acima do limite',
  'sem-processo': 'Sem processo',
  'doc-invalido': 'CNPJ ausente/inválido',
  outra_uf: 'Sede em outra UF',
  recem_criada: 'Empresa recém-criada',
  situacao_irregular: 'Situação cadastral irregular',
};
function humanizar(flag: string): string {
  return flag.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Selo de flag — destaca as de maior peso (sanção/acima-limite) em cores fortes. */
function FlagBadge({ flag }: { flag: string }) {
  const cor =
    flag === 'sancionado' || flag === 'inidoneo' || flag === 'situacao_irregular'
      ? 'border-red-500/30 bg-red-500/10 text-red-300'
      : flag === 'acima-limite'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
        : flag === 'sem-processo' || flag === 'doc-invalido'
          ? 'border-orange-500/30 bg-orange-500/10 text-orange-300'
          : 'border-white/10 bg-white/5 text-slate-400';
  const rotulo = FLAG_ROTULO[flag] ?? humanizar(flag);
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${cor}`} title={`Alerta do perfil: ${rotulo} — indício a apurar`}>
      {rotulo}
    </span>
  );
}

export default function PainelRiscoPage() {
  const [exercicio, setExercicio] = useState<number>(0);
  const [q, setQ] = useState('');
  const [soSancionados, setSoSancionados] = useState(false);
  const [ordenarPor, setOrdenarPor] = useState<OrdenarRisco>('risco');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  const [filtroQ, setFiltroQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setFiltroQ(q);
      setPageIndex(0);
    }, 400);
    return () => clearTimeout(t);
  }, [q]);

  const [data, setData] = useState<RiscoResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const reqId = useRef(0);

  const carregar = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    const p = new URLSearchParams();
    if (exercicio > 0) p.set('exercicio', String(exercicio));
    if (filtroQ) p.set('q', filtroQ);
    if (soSancionados) p.set('soSancionados', '1');
    p.set('ordenarPor', ordenarPor);
    p.set('pagina', String(pageIndex));
    p.set('tamanho', String(pageSize));
    try {
      const res = await nexoFetch(`/api/nexo/risco?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as RiscoResponse;
      if (id === reqId.current) setData(json);
    } catch (err) {
      if (id === reqId.current) {
        setErro(err instanceof Error ? err.message : 'erro desconhecido');
        setData(null);
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [exercicio, filtroQ, soSancionados, ordenarPor, pageIndex, pageSize]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const itens = data?.itens ?? [];
  const ag = data?.agregados;
  const compilando = data?._compilando === true;
  const pendente = data?.ingestao.status === 'pendente';

  return (
    <EntityProvider>
      <div className="space-y-6">
        {/* Cabeçalho */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-400" aria-hidden="true" />
              <h1 className="text-2xl font-bold tracking-tight text-slate-100">Painel de Risco</h1>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">
              Fornecedores da Prefeitura de Marília ordenados por potencial de
              risco — sanção, alertas do perfil e volume empenhado. É indício a
              apurar, nunca acusação. Órgãos públicos e pessoas físicas ficam
              fora do ranking.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={carregar}
            disabled={loading}
            aria-label="Atualizar painel de risco"
            title="Recarregar o ranking de fornecedores"
            className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
          >
            <RefreshCw className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} aria-hidden="true" />
            Atualizar
          </Button>
        </div>

        {/* Exercício */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2" role="group" aria-label="Selecionar exercício">
            <span className="text-xs uppercase tracking-wide text-slate-500">Exercício</span>
            {EXERCICIOS.map((ano) => (
              <button
                key={ano}
                type="button"
                aria-pressed={ano === exercicio}
                onClick={() => {
                  setExercicio(ano);
                  setPageIndex(0);
                }}
                className={[
                  'rounded-md px-3 py-1 text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40',
                  ano === exercicio
                    ? 'bg-amber-500/15 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30'
                    : 'text-slate-400 hover:bg-white/5',
                ].join(' ')}
              >
                {ano === 0 ? 'Todos' : ano}
              </button>
            ))}
          </div>
        </div>

        {/* Filtros */}
        <div className="grid grid-cols-1 gap-3 rounded-md border border-white/5 bg-nexo-chrome p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label htmlFor="risco-q" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Buscar fornecedor / CNPJ</label>
            <Input
              id="risco-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Nome ou dígitos do CNPJ"
              className="border-white/10 bg-transparent text-slate-200 placeholder:text-slate-500"
            />
          </div>
          <div>
            <label htmlFor="risco-ordenar" className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Ordenar por</label>
            <Select
              value={ordenarPor}
              onValueChange={(v) => {
                setOrdenarPor(v as OrdenarRisco);
                setPageIndex(0);
              }}
            >
              <SelectTrigger id="risco-ordenar" aria-label="Ordenar ranking por" className="border-white/10 bg-transparent text-slate-200"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="risco">Potencial de risco</SelectItem>
                <SelectItem value="totalEmpenhado">Total empenhado</SelectItem>
                <SelectItem value="nFlags">Nº de alertas</SelectItem>
                <SelectItem value="nVinculos">Nº de vínculos</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={soSancionados}
                onChange={(e) => {
                  setSoSancionados(e.target.checked);
                  setPageIndex(0);
                }}
                className="h-4 w-4 rounded border-white/20 bg-transparent accent-amber-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
              />
              Só sancionados
            </label>
          </div>
        </div>

        {/* Conteúdo */}
        {loading && !data ? (
          <div className="space-y-2" aria-busy="true" aria-label="Carregando ranking de fornecedores">
            {Array.from({ length: 8 }).map((_, i) => (<Skeleton key={i} className="h-12 w-full" />))}
          </div>
        ) : erro ? (
          <Card className="border-red-500/20 bg-red-500/5" role="alert">
            <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
              <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" /> Não foi possível carregar o painel de risco: {erro}
            </CardContent>
          </Card>
        ) : compilando ? (
          <Card className="border-amber-500/20 bg-nexo-chrome">
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-slate-400">
              <RefreshCw className="h-6 w-6 animate-spin text-amber-400" aria-hidden="true" />
              <span className="font-medium text-slate-200">Compilando o painel de risco…</span>
              <span className="text-[11px] text-slate-500">
                O ranking de fornecedores está sendo gerado em segundo plano.
                Atualize em instantes.
              </span>
            </CardContent>
          </Card>
        ) : pendente ? (
          <Card className="border-white/10 bg-nexo-chrome">
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-slate-400">
              <ShieldCheck className="h-6 w-6 text-slate-400" aria-hidden="true" />
              <span>Sem dados de entidades.</span>
              <span className="text-[11px] text-slate-500">
                O raio-x de entidades (cron diário) ainda não populou
                <code className="mx-1 rounded bg-white/5 px-1 font-mono">nexo_entidades</code>.
                Volte após o próximo ciclo de perfilamento.
              </span>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Cards de resumo */}
            {ag && (
              <div
                className="grid grid-cols-2 gap-3 lg:grid-cols-4"
                role="status"
                aria-label="Resumo do recorte atual"
              >
                {[
                  { rotulo: 'Fornecedores', valor: ag.fornecedores.toLocaleString('pt-BR'), dica: 'Empresas no recorte filtrado.' },
                  { rotulo: 'Sancionados', valor: ag.sancionados.toLocaleString('pt-BR'), alerta: ag.sancionados > 0, dica: 'Com sanção CEIS/CNEP — indício a apurar.' },
                  { rotulo: 'Com alertas', valor: ag.comFlags.toLocaleString('pt-BR'), dica: 'Com ao menos um alerta de perfil.' },
                  { rotulo: 'Total empenhado', valor: brl(ag.totalEmpenhado), dica: 'Soma do empenhado no recorte.' },
                ].map((c) => (
                  <div key={c.rotulo} className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3" title={c.dica}>
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">{c.rotulo}</div>
                    <div className={`mt-1 text-lg font-semibold ${c.alerta ? 'text-red-300' : 'text-slate-100'}`}>{c.valor}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Tabela */}
            <Card className="border-white/5 bg-nexo-surface">
              <CardContent className="overflow-x-auto p-0" aria-busy={loading}>
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead className="w-10 text-slate-400" title="Posição no ranking de risco">#</TableHead>
                      <TableHead className="text-slate-400">Fornecedor</TableHead>
                      <TableHead className="text-right text-slate-400">Total empenhado</TableHead>
                      <TableHead className="text-right text-slate-400" title="Contratos firmados / vínculos no grafo de relacionamentos">Contratos / vínculos</TableHead>
                      <TableHead className="text-slate-400">Alertas</TableHead>
                      <TableHead className="text-right text-slate-400">Sanção</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {itens.length === 0 ? (
                      <TableRow className="border-white/5 hover:bg-transparent">
                        <TableCell colSpan={6} className="py-10 text-center text-sm text-slate-500">
                          Nenhum fornecedor casa os filtros.
                        </TableCell>
                      </TableRow>
                    ) : (
                      itens.map((f, i) => <LinhaFornecedor key={f.id} f={f} pos={pageIndex * pageSize + i + 1} />)
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Paginação */}
            <div className="flex flex-col items-center justify-between gap-3 text-xs text-slate-400 sm:flex-row">
              <span>{total.toLocaleString('pt-BR')} fornecedor(es) no recorte.</span>
              <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                <div className="flex items-center gap-2">
                  <span id="risco-page-size-label">Por página</span>
                  <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPageIndex(0); }}>
                    <SelectTrigger aria-labelledby="risco-page-size-label" className="h-8 w-[72px] border-white/10 bg-transparent text-slate-200"><SelectValue /></SelectTrigger>
                    <SelectContent>{TAMANHOS.map((t) => (<SelectItem key={t} value={String(t)}>{t}</SelectItem>))}</SelectContent>
                  </Select>
                </div>
                <span aria-live="polite">Página {pageIndex + 1} de {pageCount}</span>
                <div className="flex items-center gap-1">
                  <Button type="button" variant="outline" size="icon" aria-label="Primeira página" title="Primeira página" className="h-8 w-8 border-white/10 bg-transparent text-slate-300 hover:bg-white/5" onClick={() => setPageIndex(0)} disabled={pageIndex === 0}>
                    <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" aria-label="Página anterior" title="Página anterior" className="h-8 w-8 border-white/10 bg-transparent text-slate-300 hover:bg-white/5" onClick={() => setPageIndex((i) => Math.max(0, i - 1))} disabled={pageIndex === 0}>
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" aria-label="Próxima página" title="Próxima página" className="h-8 w-8 border-white/10 bg-transparent text-slate-300 hover:bg-white/5" onClick={() => setPageIndex((i) => Math.min(pageCount - 1, i + 1))} disabled={pageIndex >= pageCount - 1}>
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="outline" size="icon" aria-label="Última página" title="Última página" className="h-8 w-8 border-white/10 bg-transparent text-slate-300 hover:bg-white/5" onClick={() => setPageIndex(pageCount - 1)} disabled={pageIndex >= pageCount - 1}>
                    <ChevronsRight className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Disclaimer */}
            <p className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] leading-relaxed text-slate-400">
              Ordenação por potencial de risco é heurística de priorização sobre
              dados públicos já ingeridos — indício para apuração, jamais acusação.
              Convém verificar abrangência da sanção e eventual suspensão judicial.
            </p>
          </>
        )}
      </div>
    </EntityProvider>
  );
}

/** Uma linha do ranking. O CNPJ vira entity-chip (prévia + drill-down de PJ). */
function LinhaFornecedor({ f, pos }: { f: FornecedorRisco; pos: number }) {
  const flagsVisiveis = f.flags.slice(0, 4);
  const extras = f.flags.length - flagsVisiveis.length;
  return (
    <TableRow className="border-white/5 hover:bg-white/5">
      <TableCell className="text-slate-500">{pos}</TableCell>
      <TableCell className="max-w-[22rem]">
        <div className="truncate font-medium text-slate-200" title={f.nome}>{f.nome || '(sem nome)'}</div>
        <div className="mt-0.5 font-mono text-[11px] text-slate-500">
          {f.cnpj ? <EntityText>{f.cnpj}</EntityText> : (f.doc ?? '—')}
        </div>
      </TableCell>
      <TableCell className="text-right font-mono text-slate-300">{brl(f.totalEmpenhado)}</TableCell>
      <TableCell className="whitespace-nowrap text-right text-slate-400">
        <span title={`${f.nContratos} contrato(s)`}>{f.nContratos}</span>
        <span className="text-slate-400"> / </span>
        <span title={`${f.nVinculos} vínculo(s) no grafo`}>{f.nVinculos}</span>
        {f.contratosAtivos > 0 && (
          <Badge variant="outline" className="ml-2 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300" title="Contratos vigentes">
            {f.contratosAtivos} ativo(s)
          </Badge>
        )}
      </TableCell>
      <TableCell>
        {f.flags.length === 0 ? (
          <span className="text-[11px] text-slate-400">—</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {flagsVisiveis.map((fl) => <FlagBadge key={fl} flag={fl} />)}
            {extras > 0 && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] text-slate-500"
                title={`Mais ${extras} alerta(s): ${f.flags.slice(4).map((fl) => FLAG_ROTULO[fl] ?? humanizar(fl)).join(', ')}`}
              >
                <Flag className="h-3 w-3" aria-hidden="true" />+{extras}
              </span>
            )}
          </div>
        )}
      </TableCell>
      <TableCell className="text-right">
        {f.sancionado ? (
          <Badge
            variant="outline"
            className="border-red-500/30 bg-red-500/10 text-[10px] text-red-300"
            title="Fornecedor com sanção CEIS/CNEP — indício a apurar"
          >
            <ShieldAlert className="mr-1 h-3 w-3" aria-hidden="true" />
            {f.nSancoes > 0 ? `${f.nSancoes} sanção(ões)` : 'Sancionado'}
          </Badge>
        ) : (
          <span className="text-[11px] text-slate-400">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}
