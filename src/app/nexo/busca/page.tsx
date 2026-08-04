'use client';

/**
 * NEXO — Busca & Raio-X.
 *
 * A "barra de pesquisa" da sala de situação: dado um nome de empresa (ou
 * CNPJ/CPF), localiza a entidade nas coleções `nexo_*` JÁ INGERIDAS e, ao
 * clicar, monta o RAIO-X — perfil (total faturado, nº de contratos, objetos,
 * sanções, flags) + os VÍNCULOS (empenhos/contratos/licitações/documentos
 * linkados) com link para CADA prova documental.
 *
 * Abas: Empresas (com flag de contrato ativo) · Servidores · Licitações em
 * andamento · Dispensas em andamento. Tudo via `GET /api/nexo/busca`.
 *
 * Honestidade (regra do dono): coleção vazia NÃO é "nada encontrado" — é coleta
 * inativa. A página distingue os dois pelos campos `disponivel`/`coletaInativa`/
 * `motivo` da resposta. PII (CPF/nome de pessoa física) já vem MASCARADA do
 * backend; o cliente só exibe.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ScanSearch,
  Search,
  RefreshCw,
  TriangleAlert,
  ShieldQuestion,
  Building2,
  Users,
  FileSignature,
  Ban,
  ScrollText,
  CheckCircle2,
  ExternalLink,
  Link2,
  ShieldAlert,
  ShieldCheck,
  Landmark,
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
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { FontesProvas } from '@/components/nexo/fontes-provas';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { mascararDoc } from '@/lib/nexo/normalizar';
import {
  contratoMunicipal,
  dispensa,
  editalLicitacao,
  pncpFromRef,
  smarapdModulo,
} from '@/lib/nexo/procedencia';
import type { Procedencia } from '@/lib/nexo/detectores/tipos';

// ── Tipos da resposta da rota `/api/nexo/busca` ──────────────────────────────
// A rota não exporta seus contratos; replicamos o shape relevante aqui (mesmo
// padrão honesto: `disponivel`/`coletaInativa`/`motivo`).

interface RespostaBase {
  tipo: TipoBusca;
  q: string;
  exercicio: number;
  disponivel: boolean;
  motivo: string | null;
  /** Sinaliza coleta inativa (vs. "nada encontrado"). */
  coletaInativa?: boolean;
  total: number;
  atualizadoEm: string;
}

interface ResultadoEmpresa {
  idCanonico: string;
  documento: string;
  documentoRaw: string;
  nome: string;
  totalEmpenhado: number;
  empenhos: number;
  contratosAtivos: boolean;
  contratos: number;
}

interface ResultadoServidor {
  nome: string;
  cargo: string;
  lotacao: string;
}

interface ResultadoLicitacao {
  numeroProcesso: string;
  numeroEdital: string;
  modalidade: string;
  objeto: string | null;
  situacao: string | null;
  tipo: string | null;
  dataAbertura: string | null;
  valorEstimado: number | null;
}

interface RaioXContrato {
  numeroContrato: string;
  numeroProcesso: string;
  objeto: string | null;
  valor: number;
  vigenciaInicio: string | null;
  vigenciaFim: string | null;
}

interface RaioXLicitacao {
  numeroProcesso: string;
  modalidade: string;
  objeto: string | null;
  situacao: string | null;
  tipo: string | null;
}

interface RaioXVinculo {
  colecao: string;
  id: string;
  tipo: string;
  chave: string;
  chaveTipo: string;
  confianca: string;
}

interface RespostaEntidade extends RespostaBase {
  tipo: 'entidade';
  entidade: {
    documento: string;
    documentoRaw: string;
    nome: string;
    ehEntidadePublica: boolean;
  } | null;
  perfilDisponivel: boolean;
  perfilCanonico: Record<string, unknown> | null;
  empenhos: { total: number; valor: number; docIds: string[] };
  contratos: RaioXContrato[];
  licitacoes: RaioXLicitacao[];
  vinculos: RaioXVinculo[];
}

type RespostaEmpresas = RespostaBase & { resultados: ResultadoEmpresa[] };
type RespostaServidores = RespostaBase & { resultados: ResultadoServidor[] };
type RespostaLicitacoes = RespostaBase & { resultados: ResultadoLicitacao[] };

type RespostaLista =
  | RespostaEmpresas
  | RespostaServidores
  | RespostaLicitacoes;

const TIPOS_LISTA = ['empresas', 'servidores', 'licitacoes', 'dispensas'] as const;
type TipoLista = (typeof TIPOS_LISTA)[number];
type TipoBusca = TipoLista | 'entidade';

const ABAS: { tipo: TipoLista; label: string; icon: typeof Building2 }[] = [
  { tipo: 'empresas', label: 'Empresas', icon: Building2 },
  { tipo: 'servidores', label: 'Servidores', icon: Users },
  { tipo: 'licitacoes', label: 'Licitações', icon: ScrollText },
  { tipo: 'dispensas', label: 'Dispensas', icon: Ban },
];

const EXERCICIOS = [2026, 2025, 2024];

function brl(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
}

/** Pluralização pt-BR simples (1 contrato · 2 contratos). */
function plural(n: number, singular: string, plural: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? singular : plural}`;
}

/** Rótulo humanizado da contagem total por tipo de aba. */
function rotuloTotal(t: TipoBusca, n: number): string {
  switch (t) {
    case 'empresas':
      return plural(n, 'empresa', 'empresas');
    case 'servidores':
      return plural(n, 'servidor', 'servidores');
    case 'dispensas':
      return `${n.toLocaleString('pt-BR')} ${n === 1 ? 'dispensa em andamento' : 'dispensas em andamento'}`;
    default:
      return `${n.toLocaleString('pt-BR')} ${n === 1 ? 'licitação em andamento' : 'licitações em andamento'}`;
  }
}

function fmtData(iso: string | null): string {
  if (!iso) return '—';
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Perfil canônico de `nexo_entidades` — campos variam; leitura tolerante. */
function campoPerfil(perfil: Record<string, unknown> | null, ...chaves: string[]): string {
  if (!perfil) return '';
  for (const k of chaves) {
    const v = perfil[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

export default function BuscaPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [tipo, setTipo] = useState<TipoLista>('empresas');
  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');

  const [data, setData] = useState<RespostaLista | null>(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // RAIO-X (Sheet lateral) — mantém o contexto da lista.
  const [raioXDoc, setRaioXDoc] = useState<string | null>(null);

  // Debounce do termo (~300ms) — busca dispara no termo estável, na troca de
  // aba e na troca de exercício.
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const reqId = useRef(0);
  const carregar = useCallback(
    async (t: TipoLista, termo: string, ano: number) => {
      const id = ++reqId.current;
      setLoading(true);
      setErro(null);
      try {
        const url = `/api/nexo/busca?tipo=${t}&q=${encodeURIComponent(
          termo,
        )}&exercicio=${ano}`;
        const res = await nexoFetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as RespostaLista;
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

  useEffect(() => {
    carregar(tipo, qDebounced, exercicio);
  }, [tipo, qDebounced, exercicio, carregar]);

  // Submit do form (Enter) — força a busca imediata sem esperar o debounce.
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setQDebounced(q);
    carregar(tipo, q, exercicio);
  };

  return (
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ScanSearch className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Busca &amp; Raio-X
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Dado um nome de empresa (ou CNPJ/CPF), localizo a entidade na base já
            ingerida e faço o raio-x: perfil, vínculos e a prova documental de
            cada cruzamento. Busca também servidores, licitações e dispensas em
            andamento.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => carregar(tipo, qDebounced, exercicio)}
          disabled={loading}
          aria-label="Refazer a busca atual"
          title="Refazer a busca atual"
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <RefreshCw
            className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')}
            aria-hidden="true"
          />
          Atualizar
        </Button>
      </div>

      {/* Barra de busca + exercício */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <form
          onSubmit={onSubmit}
          role="search"
          className="relative w-full sm:max-w-md"
        >
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
            aria-hidden="true"
          />
          <label htmlFor="busca-termo" className="sr-only">
            Termo da busca
          </label>
          <Input
            id="busca-termo"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Termo da busca"
            placeholder={
              tipo === 'empresas'
                ? 'Nome da empresa ou CNPJ/CPF…'
                : tipo === 'servidores'
                  ? 'Nome, cargo ou lotação…'
                  : 'Objeto, modalidade ou nº de processo…'
            }
            className="border-white/10 bg-nexo-chrome pl-9 text-slate-200 placeholder:text-slate-500 focus-visible:ring-amber-500/40"
          />
        </form>

        <div
          className="flex items-center gap-2"
          role="group"
          aria-label="Selecionar exercício"
        >
          <span className="text-xs uppercase tracking-wide text-slate-500">
            Exercício
          </span>
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
      </div>

      {/* Abas de tipo (pills) */}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Tipo de busca"
      >
        {ABAS.map((aba) => {
          const Icon = aba.icon;
          const ativo = tipo === aba.tipo;
          return (
            <button
              key={aba.tipo}
              type="button"
              aria-pressed={ativo}
              onClick={() => setTipo(aba.tipo)}
              className={[
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40',
                ativo
                  ? 'bg-amber-500/15 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30'
                  : 'text-slate-400 hover:bg-white/5',
              ].join(' ')}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {aba.label}
            </button>
          );
        })}
      </div>

      {/* Resultados */}
      {loading ? (
        <div
          className="space-y-2"
          role="status"
          aria-busy="true"
          aria-label="Executando a busca"
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5" role="alert">
          <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
            <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
            Não foi possível executar a busca: {erro}
          </CardContent>
        </Card>
      ) : data && data.disponivel === false ? (
        // Estado HONESTO: coleta inativa / fonte não populada (não é "nada
        // encontrado"). A própria resposta traz o motivo.
        <Card className="border-amber-500/20 bg-nexo-surface" role="status">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <ShieldQuestion className="h-7 w-7 text-amber-400" aria-hidden="true" />
            <p className="text-sm font-medium text-slate-200">
              {data.coletaInativa
                ? 'Coleta ainda não populou esta fonte'
                : 'Sem dados para esta busca'}
            </p>
            <p className="max-w-md text-xs leading-relaxed text-slate-500">
              {data.motivo ??
                'A fonte desta busca ainda não foi ingerida para o exercício selecionado.'}
            </p>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* Banner de resumo */}
          <div
            role="status"
            aria-label="Resumo do recorte atual"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500"
          >
            <span>{rotuloTotal(tipo, data.total)}</span>
            <span aria-hidden="true">·</span>
            <span>exercício {data.exercicio}</span>
            {data.q && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  filtro “<span className="text-slate-400">{data.q}</span>”
                </span>
              </>
            )}
            {data.total > 50 && (
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300"
              >
                exibindo os 50 primeiros
              </Badge>
            )}
          </div>

          {tipo === 'empresas' ? (
            <TabelaEmpresas
              data={data as RespostaEmpresas}
              onRaioX={(doc) => setRaioXDoc(doc)}
            />
          ) : tipo === 'servidores' ? (
            <TabelaServidores data={data as RespostaServidores} />
          ) : (
            <GridProcessos
              data={data as RespostaLicitacoes}
              dispensa={tipo === 'dispensas'}
            />
          )}
        </>
      ) : null}

      {/* RAIO-X — painel lateral, mantém a lista no fundo */}
      <RaioXSheet
        doc={raioXDoc}
        exercicio={exercicio}
        onClose={() => setRaioXDoc(null)}
      />
    </div>
  );
}

// ── Tabela: Empresas (fornecedores) ──────────────────────────────────────────

function TabelaEmpresas({
  data,
  onRaioX,
}: {
  data: RespostaEmpresas;
  onRaioX: (doc: string) => void;
}) {
  if (data.resultados.length === 0) return <VazioSemResultado />;
  return (
    <Card className="border-white/5 bg-nexo-surface">
      <CardHeader>
        <CardTitle className="text-base text-slate-200">
          Fornecedores — clique para o raio-x
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-white/5 hover:bg-transparent">
                <TableHead className="w-10 text-slate-400">#</TableHead>
                <TableHead className="text-slate-400">Fornecedor</TableHead>
                <TableHead className="text-slate-400">CNPJ/CPF</TableHead>
                <TableHead className="text-right text-slate-400">Empenhos</TableHead>
                <TableHead className="text-right text-slate-400">Total</TableHead>
                <TableHead className="text-slate-400">Contrato</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.resultados.map((f, i) => {
                const abrir = () => onRaioX(f.documentoRaw || f.idCanonico);
                return (
                  <TableRow
                    key={f.idCanonico}
                    role="button"
                    tabIndex={0}
                    aria-label={`Abrir raio-x de ${f.nome}`}
                    className="cursor-pointer border-white/5 hover:bg-white/5 focus:outline-none focus-visible:bg-white/5 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-amber-500/40"
                    onClick={abrir}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        abrir();
                      }
                    }}
                  >
                    <TableCell className="text-slate-500">{i + 1}</TableCell>
                    <TableCell className="max-w-[18rem] truncate font-medium">
                      <span className="text-slate-200 transition-colors hover:text-amber-300 hover:underline">
                        {f.nome}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-slate-400">
                      {f.documento}
                    </TableCell>
                    <TableCell className="text-right text-slate-400">
                      {f.empenhos.toLocaleString('pt-BR')}
                    </TableCell>
                    <TableCell className="text-right font-mono text-slate-300">
                      {brl(f.totalEmpenhado)}
                    </TableCell>
                    <TableCell>
                      {f.contratosAtivos ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300"
                        >
                          <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" /> ativo
                        </Badge>
                      ) : f.contratos > 0 ? (
                        <span className="text-[11px] text-slate-500">
                          {plural(f.contratos, 'encerrado', 'encerrados')}
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-400">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Tabela: Servidores (folha) ───────────────────────────────────────────────

function TabelaServidores({ data }: { data: RespostaServidores }) {
  if (data.resultados.length === 0) return <VazioSemResultado />;
  return (
    <Card className="border-white/5 bg-nexo-surface">
      <CardHeader className="pb-3">
        <CardTitle className="text-base text-slate-200">
          Servidores — folha de pagamento
        </CardTitle>
        <p className="text-[11px] text-slate-500">
          Dado público da própria folha. Nomes mascarados (LGPD); nenhuma fonte
          externa é consultada.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-white/5 hover:bg-transparent">
                <TableHead className="text-slate-400">Servidor</TableHead>
                <TableHead className="text-slate-400">Cargo / função</TableHead>
                <TableHead className="text-slate-400">Lotação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.resultados.map((s, i) => (
                <TableRow key={i} className="border-white/5 hover:bg-white/5">
                  <TableCell className="font-medium text-slate-200">
                    {s.nome}
                  </TableCell>
                  <TableCell className="text-slate-400">{s.cargo || '—'}</TableCell>
                  <TableCell className="text-slate-400">{s.lotacao || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Grid: Licitações / Dispensas em andamento ────────────────────────────────

function GridProcessos({
  data,
  dispensa: ehDispensa,
}: {
  data: RespostaLicitacoes;
  dispensa: boolean;
}) {
  if (data.resultados.length === 0) return <VazioSemResultado />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {data.resultados.map((l, i) => (
        <Card
          key={`${l.numeroProcesso}-${l.numeroEdital}-${i}`}
          className="border-white/5 bg-nexo-surface"
        >
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className="border-white/10 font-mono text-[10px] text-slate-400"
              >
                {l.modalidade || (ehDispensa ? 'Contratação direta' : 'Licitação')}
              </Badge>
              {l.situacao && (
                <Badge
                  variant="outline"
                  className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300"
                >
                  {l.situacao}
                </Badge>
              )}
              {l.dataAbertura && (
                <span className="ml-auto font-mono text-[11px] text-slate-500">
                  {fmtData(l.dataAbertura)}
                </span>
              )}
            </div>
            <CardTitle className="pt-1 text-sm leading-snug text-slate-200">
              {l.objeto || 'Objeto não informado'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
              {l.numeroProcesso && (
                <span>
                  Processo:{' '}
                  <span className="font-mono text-slate-400">
                    {l.numeroProcesso}
                  </span>
                </span>
              )}
              {l.numeroEdital && (
                <span>
                  Edital:{' '}
                  <span className="font-mono text-slate-400">{l.numeroEdital}</span>
                </span>
              )}
              {l.valorEstimado != null && (
                <span>
                  Estimado:{' '}
                  <span className="font-mono text-slate-300">
                    {brl(l.valorEstimado)}
                  </span>
                </span>
              )}
            </div>
            <FontesProvas
              provas={[
                ehDispensa
                  ? dispensa({
                      numeroProcesso: l.numeroProcesso,
                      numeroEdital: l.numeroEdital,
                    })
                  : editalLicitacao({
                      numeroProcesso: l.numeroProcesso,
                      numeroEdital: l.numeroEdital,
                    }),
              ]}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function VazioSemResultado() {
  return (
    <div className="rounded-md border border-dashed border-white/10 py-12 text-center text-sm text-slate-500">
      Nenhum resultado para o filtro neste exercício. A fonte está ingerida —
      ajuste o termo ou troque de exercício.
    </div>
  );
}

// ── RAIO-X (Sheet lateral) ───────────────────────────────────────────────────

function RaioXSheet({
  doc,
  exercicio,
  onClose,
}: {
  doc: string | null;
  exercicio: number;
  onClose: () => void;
}) {
  const [data, setData] = useState<RespostaEntidade | null>(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const reqId = useRef(0);
  useEffect(() => {
    if (!doc) return;
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    setData(null);
    nexoFetch(
      `/api/nexo/busca?tipo=entidade&q=${encodeURIComponent(doc)}&exercicio=${exercicio}`,
    )
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: RespostaEntidade) => {
        if (id === reqId.current) setData(j);
      })
      .catch((err) => {
        if (id === reqId.current)
          setErro(err instanceof Error ? err.message : 'erro desconhecido');
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false);
      });
  }, [doc, exercicio]);

  const ent = data?.entidade ?? null;

  return (
    <Sheet open={doc !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto border-l border-white/5 bg-nexo-surface p-0 sm:max-w-xl"
      >
        {/* Acessibilidade: o Radix Dialog (base do Sheet) exige Title +
            Description para nomear o painel a leitores de tela. Visualmente
            ocultos — o cabeçalho visível abaixo já mostra a mesma informação. */}
        <SheetTitle className="sr-only">
          {ent?.nome ? `Raio-X de ${ent.nome}` : 'Raio-X da entidade'}
        </SheetTitle>
        <SheetDescription className="sr-only">
          Perfil, contratos, licitações e vínculos cruzados da entidade, com a
          prova documental de cada cruzamento.
        </SheetDescription>
        <div className="flex flex-col">
          {/* Cabeçalho */}
          <div className="space-y-2 border-b border-white/5 bg-nexo-chrome p-5 pr-12">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
              <ScanSearch className="h-3.5 w-3.5 text-amber-400/80" aria-hidden="true" />
              Raio-X da entidade
            </div>
            <h2 className="text-base font-semibold leading-snug text-slate-100">
              {loading ? 'Montando o raio-x…' : ent?.nome || 'Entidade'}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-slate-500">
                {ent ? ent.documento : doc ? mascararDoc(doc) : '—'}
              </span>
              {ent?.ehEntidadePublica && (
                <Badge
                  variant="outline"
                  className="border-sky-500/30 bg-sky-500/10 text-[10px] text-sky-300"
                >
                  <Landmark className="mr-1 h-3 w-3" aria-hidden="true" /> ente público
                </Badge>
              )}
            </div>
          </div>

          {loading ? (
            <div
              className="space-y-3 p-5"
              role="status"
              aria-busy="true"
              aria-label="Montando o raio-x"
            >
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : erro ? (
            <div className="p-5">
              <Card className="border-red-500/20 bg-red-500/5" role="alert">
                <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
                  <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
                  Falha ao montar o raio-x: {erro}
                </CardContent>
              </Card>
            </div>
          ) : data ? (
            <RaioXConteudo data={data} doc={doc} />
          ) : null}

          {/* Rodapé — disclaimer */}
          <div className="flex items-start gap-2 border-t border-white/5 bg-nexo-chrome p-5 text-[11px] leading-relaxed text-slate-500">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400/70" aria-hidden="true" />
            <p>
              Raio-X montado de dados públicos já ingeridos. Os vínculos são{' '}
              <strong className="text-slate-400">indícios</strong> de relação —
              nunca acusação. Cada item traz a prova documental para apuração.
            </p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RaioXConteudo({
  data,
  doc,
}: {
  data: RespostaEntidade;
  doc: string | null;
}) {
  // Vínculos viram provas clicáveis quando a chave é um nº de controle PNCP;
  // senão exibem o ponteiro bruto (coleção/id) — degrada honesto.
  const provasVinculos: Procedencia[] = useMemo(
    () =>
      data.vinculos.flatMap((v) => {
        const p = pncpFromRef(v.chave);
        if (p) return [p];
        // Ponteiro bruto da aresta: sem URL clicável, mas com refColecao/refId
        // — o FontesProvas degrada para "ver registro bruto".
        const sm = smarapdModulo('empenho', data.exercicio, v.id);
        return sm
          ? [{ ...sm, label: `Vínculo ${v.tipo} (${v.colecao})`, refColecao: v.colecao, refId: v.id }]
          : [];
      }),
    [data.vinculos, data.exercicio],
  );

  const semNada =
    data.empenhos.total === 0 &&
    data.contratos.length === 0 &&
    data.licitacoes.length === 0 &&
    data.vinculos.length === 0 &&
    !data.perfilDisponivel;

  return (
    <div className="space-y-6 p-5">
      {/* Motivo honesto (sem perfil canônico / coleta) */}
      {data.motivo && (
        <p
          role="status"
          className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] leading-relaxed text-amber-200/80"
        >
          {data.motivo}
        </p>
      )}

      {semNada ? (
        <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
          Nenhum registro desta entidade nas coleções ingeridas para o
          exercício.
        </div>
      ) : (
        <>
          {/* PERFIL — KPIs */}
          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <Building2 className="h-3.5 w-3.5 text-amber-400/80" aria-hidden="true" />
              Perfil
            </h3>
            <div className="grid grid-cols-3 gap-2">
              <Kpi rotulo="Total faturado" valor={brl(data.empenhos.valor)} />
              <Kpi rotulo="Empenhos" valor={data.empenhos.total.toLocaleString('pt-BR')} />
              <Kpi rotulo="Contratos" valor={data.contratos.length.toLocaleString('pt-BR')} />
            </div>
            {data.perfilDisponivel && data.perfilCanonico && (
              <div className="grid grid-cols-2 gap-3 rounded-md border border-white/5 bg-nexo-chrome p-3">
                <Campo
                  rotulo="Situação"
                  valor={
                    campoPerfil(
                      data.perfilCanonico,
                      'situacaoCadastral',
                      'situacao',
                    ) || '—'
                  }
                />
                <Campo
                  rotulo="Município/UF"
                  valor={
                    campoPerfil(data.perfilCanonico, 'municipio', 'cidade') &&
                    campoPerfil(data.perfilCanonico, 'uf')
                      ? `${campoPerfil(
                          data.perfilCanonico,
                          'municipio',
                          'cidade',
                        )}/${campoPerfil(data.perfilCanonico, 'uf')}`
                      : campoPerfil(data.perfilCanonico, 'uf') || '—'
                  }
                />
                <div className="col-span-2">
                  <Campo
                    rotulo="Atividade (CNAE)"
                    valor={
                      campoPerfil(
                        data.perfilCanonico,
                        'cnaeDescricao',
                        'cnaePrincipal',
                        'atividade',
                      ) || '—'
                    }
                  />
                </div>
              </div>
            )}
            {/* Link para o enriquecimento completo de CNPJ (14 dígitos) */}
            {(ent14(data, doc)) && (
              <Link
                href={`/nexo/fornecedores/${ent14(data, doc)}`}
                className="inline-flex items-center gap-1.5 rounded text-xs text-amber-400 transition-colors hover:text-amber-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                Ver enriquecimento de CNPJ completo (sócios, sanções, flags)
              </Link>
            )}
          </section>

          {/* CONTRATOS */}
          {data.contratos.length > 0 && (
            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <FileSignature className="h-3.5 w-3.5 text-amber-400/80" aria-hidden="true" />
                {plural(data.contratos.length, 'Contrato', 'Contratos')}
              </h3>
              <ul className="space-y-2">
                {data.contratos.map((c, i) => (
                  <li
                    key={`${c.numeroContrato}-${i}`}
                    className="rounded-md border border-white/5 bg-nexo-chrome p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs text-slate-300">
                        {c.numeroContrato || c.numeroProcesso || 'Contrato'}
                      </span>
                      <span className="font-mono text-xs text-amber-300">
                        {brl(c.valor)}
                      </span>
                    </div>
                    {c.objeto && (
                      <p className="mt-1 text-[13px] leading-relaxed text-slate-400">
                        {c.objeto}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-slate-400">
                      <span>
                        Vigência: {fmtData(c.vigenciaInicio)} →{' '}
                        {fmtData(c.vigenciaFim)}
                      </span>
                    </div>
                    <div className="mt-2">
                      <FontesProvas
                        provas={[
                          contratoMunicipal({
                            numeroContrato: c.numeroContrato,
                            numeroProcesso: c.numeroProcesso,
                            contratada: data.entidade?.nome,
                          }),
                        ]}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* LICITAÇÕES ligadas (por nome/objeto) */}
          {data.licitacoes.length > 0 && (
            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <ScrollText className="h-3.5 w-3.5 text-amber-400/80" aria-hidden="true" />
                {data.licitacoes.length === 1
                  ? '1 licitação relacionada'
                  : `${data.licitacoes.length.toLocaleString('pt-BR')} licitações relacionadas`}
              </h3>
              <ul className="space-y-2">
                {data.licitacoes.map((l, i) => (
                  <li
                    key={`${l.numeroProcesso}-${i}`}
                    className="rounded-md border border-white/5 bg-nexo-chrome p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-white/10 font-mono text-[10px] text-slate-400"
                      >
                        {l.modalidade || 'Licitação'}
                      </Badge>
                      {l.situacao && (
                        <span className="text-[11px] text-slate-500">
                          {l.situacao}
                        </span>
                      )}
                      <span className="ml-auto font-mono text-[11px] text-slate-500">
                        {l.numeroProcesso}
                      </span>
                    </div>
                    {l.objeto && (
                      <p className="mt-1 text-[13px] leading-relaxed text-slate-400">
                        {l.objeto}
                      </p>
                    )}
                    <div className="mt-2">
                      <FontesProvas
                        provas={[
                          editalLicitacao({ numeroProcesso: l.numeroProcesso }),
                        ]}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* VÍNCULOS cruzados (nexo_links) */}
          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <Link2 className="h-3.5 w-3.5 text-amber-400/80" aria-hidden="true" />
              {plural(data.vinculos.length, 'Vínculo cruzado', 'Vínculos cruzados')}
            </h3>
            {data.vinculos.length === 0 ? (
              <p className="flex items-center gap-1.5 text-xs text-slate-400">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Nenhum vínculo cruzado registrado no grafo para esta entidade no
                exercício.
              </p>
            ) : (
              <>
                <ul className="space-y-1.5">
                  {data.vinculos.slice(0, 30).map((v, i) => (
                    <li
                      key={`${v.colecao}-${v.id}-${i}`}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-white/5 bg-nexo-chrome px-3 py-2 text-[11px]"
                    >
                      <ShieldAlert className="h-3.5 w-3.5 text-amber-400/70" aria-hidden="true" />
                      <span className="font-medium text-slate-300">{v.tipo}</span>
                      <span className="font-mono text-slate-500">{v.colecao}</span>
                      <span className="font-mono text-slate-400">/{v.id}</span>
                      <Badge
                        variant="outline"
                        className="ml-auto border-white/10 text-[10px] text-slate-500"
                      >
                        {v.confianca || 'confiança n/d'}
                      </Badge>
                    </li>
                  ))}
                </ul>
                {data.vinculos.length > 30 && (
                  <p className="text-[11px] text-slate-400">
                    Exibindo os 30 primeiros de{' '}
                    {data.vinculos.length.toLocaleString('pt-BR')} vínculos.
                  </p>
                )}
                <div className="pt-1">
                  <FontesProvas provas={provasVinculos} />
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Documento de 14 dígitos (CNPJ) para deep-link do enriquecimento, se houver. */
function ent14(data: RespostaEntidade, doc: string | null): string | null {
  const raw = data.entidade?.documentoRaw || doc || '';
  const d = raw.replace(/\D/g, '');
  return d.length === 14 ? d : null;
}

function Kpi({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="rounded-md border border-white/5 bg-nexo-chrome p-3">
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{rotulo}</p>
      <p className="mt-1 font-mono text-sm font-semibold text-slate-100">{valor}</p>
    </div>
  );
}

function Campo({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{rotulo}</p>
      <p className="text-sm text-slate-200">{valor}</p>
    </div>
  );
}
