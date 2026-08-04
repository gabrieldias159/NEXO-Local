'use client';

/**
 * NEXO — Contratos, Editais, Licitações e Processos de Dispensa MUNICIPAIS.
 *
 * Fonte: portal de DADOS ABERTOS da Prefeitura de Marília (coleção
 * `nexo_licitacoes`), NÃO o PNCP. É distinta de:
 *   • /nexo/contratos-pncp → contratos da Prefeitura no PNCP (Lei 14.133);
 *   • /nexo/contratos       → contratos PNCP com detecção de aditivos.
 *
 * Lista editais formais (Licitações) e contratações diretas (Dispensas /
 * Inexigibilidades / Adesões) ainda EM ANDAMENTO, com busca por objeto /
 * modalidade / número de processo, e link para a LISTAGEM-fonte do portal.
 *
 * Honestidade (regra do dono): coleta inativa ≠ "nada encontrado"; valor
 * estimado ausente aparece como "—", nunca R$ 0.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Gavel,
  Search,
  RefreshCw,
  TriangleAlert,
  ExternalLink,
  Info,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  BuscaProcessosResponse,
  ResultadoLicitacao,
} from '@/app/api/nexo/busca/route';
import { nexoFetch } from '@/lib/nexo/client-fetch';

const EXERCICIOS = [2026, 2025, 2024];

type TipoProc = 'licitacoes' | 'dispensas';

const TIPOS: { id: TipoProc; label: string; sublabel: string }[] = [
  { id: 'licitacoes', label: 'Licitações & Editais', sublabel: 'Processos licitatórios formais' },
  { id: 'dispensas', label: 'Dispensas & Inexigibilidades', sublabel: 'Contratação direta' },
];

/** Moeda BR sem centavos; null/0-honesto vira "—" no chamador. */
function brl(v: number): string {
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
}

/** Data ISO (YYYY-MM-DD…) → DD/MM/AAAA; vazio/inválido → "—". */
function dataBr(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return iso;
}

/** true quando a situação não casa termos terminais (espelha o backend). */
const RE_ENCERRADA =
  /HOMOLOGAD|ADJUDICAD|ENCERRAD|CONCLUID|FINALIZAD|REVOGAD|ANULAD|CANCELAD|DESERT|FRACASSAD|SUSPENS|ARQUIVAD/i;

function emAndamento(situacao: string | null): boolean {
  if (!situacao) return true;
  return !RE_ENCERRADA.test(situacao);
}

export default function LicitacoesPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [tipo, setTipo] = useState<TipoProc>('licitacoes');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<BuscaProcessosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(
    async (t: TipoProc, ano: number, q: string) => {
      const id = ++reqId.current;
      setLoading(true);
      setErro(null);
      try {
        const url =
          `/api/nexo/busca?tipo=${t}&exercicio=${ano}` +
          (q ? `&q=${encodeURIComponent(q)}` : '');
        const res = await nexoFetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as BuscaProcessosResponse;
        if (id === reqId.current) setData(json);
      } catch (err) {
        if (id === reqId.current) {
          setErro(err instanceof Error ? err.message : 'erro desconhecido');
          setData(null);
        }
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [],
  );

  // Recarrega ao trocar de tipo ou exercício (mantém o termo de busca corrente).
  useEffect(() => {
    carregar(tipo, exercicio, search.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipo, exercicio, carregar]);

  const coletaInativa = data ? !data.disponivel : false;
  const resultados = data?.resultados ?? [];
  const tipoAtual = TIPOS.find((x) => x.id === tipo)!;

  return (
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Gavel className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Contratos, Editais e Dispensas
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Licitações, editais e processos de dispensa/inexigibilidade
            MUNICIPAIS, do portal de Dados Abertos da Prefeitura de Marília
            (distinto do PNCP). Mostra os processos ainda em andamento, com link
            para o documento-fonte. Indícios a apurar, não acusação.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => carregar(tipo, exercicio, search.trim())}
          disabled={loading}
          aria-label="Atualizar a lista de processos"
          title="Recarregar os processos do exercício e tipo selecionados"
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <RefreshCw
            className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')}
            aria-hidden="true"
          />
          Atualizar
        </Button>
      </div>

      {/* Exercício */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Selecionar exercício">
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

      {/* Tipo de processo */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Selecionar tipo de processo">
        <span className="text-xs uppercase tracking-wide text-slate-500">Tipo</span>
        {TIPOS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={t.id === tipo}
            onClick={() => setTipo(t.id)}
            title={t.sublabel}
            className={[
              'rounded-md px-3 py-1 text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40',
              t.id === tipo
                ? 'bg-amber-500/15 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30'
                : 'text-slate-400 hover:bg-white/5',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Busca */}
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          carregar(tipo, exercicio, search.trim());
        }}
        className="flex gap-2"
      >
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar por objeto, modalidade ou número de processo"
            placeholder="Buscar por objeto, modalidade ou número de processo…"
            className="h-10 border-white/10 bg-nexo-chrome pl-9 text-slate-200 placeholder:text-slate-500"
          />
        </div>
        <Button type="submit" disabled={loading}>
          Buscar
        </Button>
      </form>

      {/* Estados */}
      {loading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Carregando processos">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5" role="alert">
          <CardContent className="flex items-start gap-3 py-6 text-sm text-red-300">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <p>Não foi possível consultar os Dados Abertos: {erro}</p>
              <p className="mt-1 text-xs text-red-300/70">
                A fonte não respondeu — isto não significa que não haja
                processos no exercício.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : coletaInativa ? (
        <Card className="border-sky-500/20 bg-sky-500/5" role="status">
          <CardContent className="flex items-start gap-3 py-6 text-sm text-sky-300">
            <Info className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <p>Coleta inativa para este exercício.</p>
              <p className="mt-1 text-xs text-sky-300/70">
                {data?.motivo ??
                  'A coleção de licitações/dispensas ainda não foi ingerida ' +
                    'para este período. Isto não é "nada encontrado" — é a ' +
                    'coleta do portal de Dados Abertos que ainda não rodou.'}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Banner de resumo */}
          <div
            role="status"
            aria-label="Resumo do recorte atual"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500"
          >
            <span>
              <strong className="text-slate-300">
                {resultados.length.toLocaleString('pt-BR')}
              </strong>{' '}
              {resultados.length === 1 ? 'processo' : 'processos'} em andamento
              {data && data.total > resultados.length
                ? ` de ${data.total.toLocaleString('pt-BR')}`
                : ''}
            </span>
            <span>·</span>
            <span>exercício {exercicio}</span>
            <span>·</span>
            <span>{tipoAtual.label.toLowerCase()}</span>
            <span>·</span>
            <span>fonte Dados Abertos · Marília/SP</span>
          </div>

          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="text-base text-slate-200">
                {tipoAtual.label} — {exercicio}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {resultados.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
                  {search.trim()
                    ? `Nenhum processo em andamento para "${search.trim()}" neste exercício.`
                    : 'Nenhum processo em andamento neste exercício.'}
                </div>
              ) : (
                <>
                  {/* Desktop: tabela */}
                  <div className="hidden overflow-x-auto md:block" aria-busy={loading}>
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/5 hover:bg-transparent">
                          <TableHead className="text-slate-400">Nº Processo</TableHead>
                          <TableHead className="text-slate-400">Modalidade</TableHead>
                          <TableHead className="text-slate-400">Objeto</TableHead>
                          <TableHead className="text-slate-400">Situação</TableHead>
                          <TableHead className="text-slate-400">Abertura</TableHead>
                          <TableHead className="text-right text-slate-400">
                            Valor estimado
                          </TableHead>
                          <TableHead className="text-right text-slate-400">Fonte</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {resultados.map((r, i) => (
                          <TableRow
                            key={`${r.numeroProcesso || r.numeroEdital || i}`}
                            className="border-white/5 hover:bg-white/5"
                          >
                            <TableCell className="font-mono text-xs text-slate-400">
                              {r.numeroProcesso || r.numeroEdital || '—'}
                            </TableCell>
                            <TableCell
                              className="max-w-[10rem] truncate text-xs text-slate-400"
                              title={r.modalidade || undefined}
                            >
                              {r.modalidade || '—'}
                            </TableCell>
                            <TableCell
                              className="max-w-[22rem] truncate text-xs text-slate-300"
                              title={r.objeto || undefined}
                            >
                              {r.objeto || '—'}
                            </TableCell>
                            <TableCell>
                              <SituacaoBadge situacao={r.situacao} />
                            </TableCell>
                            <TableCell className="whitespace-nowrap font-mono text-xs text-slate-400">
                              {dataBr(r.dataAbertura)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-right font-mono text-slate-300">
                              {r.valorEstimado == null ? '—' : brl(r.valorEstimado)}
                            </TableCell>
                            <TableCell className="text-right">
                              <FonteLink item={r} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Mobile: cards */}
                  <div className="space-y-3 md:hidden">
                    {resultados.map((r, i) => (
                      <div
                        key={`${r.numeroProcesso || r.numeroEdital || i}-m`}
                        className="rounded-md border border-white/5 bg-nexo-chrome p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-mono text-xs text-slate-400">
                            {r.numeroProcesso || r.numeroEdital || '—'}
                          </span>
                          <SituacaoBadge situacao={r.situacao} />
                        </div>
                        <p className="mt-1.5 text-sm leading-snug text-slate-200">
                          {r.objeto || '—'}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                          <span>{r.modalidade || 'modalidade —'}</span>
                          <span>·</span>
                          <span>abertura {dataBr(r.dataAbertura)}</span>
                          <span>·</span>
                          <span>
                            {r.valorEstimado == null
                              ? 'valor —'
                              : brl(r.valorEstimado)}
                          </span>
                        </div>
                        <div className="mt-2">
                          <FonteLink item={r} comRotulo />
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <p className="text-[11px] leading-relaxed text-slate-400">
            O portal de Dados Abertos de Marília não publica deep-link por número
            de processo: o link de fonte abre a LISTAGEM da categoria. O rastro
            empenho/contrato linkado por número de processo entra na próxima onda.
          </p>
        </>
      )}
    </div>
  );
}

/** Badge de situação: âmbar quando em andamento, neutra quando encerrada. */
function SituacaoBadge({ situacao }: { situacao: string | null }) {
  const aberto = emAndamento(situacao);
  return (
    <Badge
      variant="outline"
      className={
        aberto
          ? 'border-amber-500/30 bg-amber-500/10 text-[10px] uppercase text-amber-300'
          : 'border-white/10 bg-white/5 text-[10px] uppercase text-slate-400'
      }
    >
      {situacao || 'em andamento'}
    </Badge>
  );
}

/** Link externo para a listagem-fonte do portal de Dados Abertos. */
function FonteLink({
  item,
  comRotulo = false,
}: {
  item: ResultadoLicitacao;
  comRotulo?: boolean;
}) {
  return (
    <a
      href={item.urlFonte}
      target="_blank"
      rel="noopener noreferrer"
      title="Abrir a listagem-fonte no portal de Dados Abertos (nova aba)"
      aria-label="Abrir a listagem-fonte no portal de Dados Abertos (nova aba)"
      className="inline-flex items-center gap-1 rounded text-xs text-slate-400 transition-colors hover:text-amber-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      {comRotulo && <span>Documento-fonte</span>}
    </a>
  );
}
