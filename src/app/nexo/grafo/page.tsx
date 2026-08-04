'use client';

/**
 * NEXO — Grafo de Vínculos ("TUDO LINKADO").
 *
 * A superfície de exploração do grafo `nexo_links`: dado um nó-semente
 * (empenho/contrato/licitação/TCE/DOM/documento), mostra a VIZINHANÇA até N
 * saltos, agrupada por TIPO de aresta (empenho-contrato, processo-dom, …), cada
 * vínculo com seu badge de CONFIANÇA (forte/média/fraca) e o nó-alvo como item
 * navegável. Clicar num vizinho RE-SEMEIA o grafo (expandir vizinhança).
 *
 * Sem semente, lista os HUBS (nós de maior grau) do exercício como pontos de
 * entrada — onde a teia é mais densa.
 *
 * Visualização leve, sem libs de grafo: lista/árvore com a semente no topo e os
 * vizinhos agrupados. Honestidade: `nexo_links` vazio para o ano NÃO é "nenhum
 * vínculo" — é o cron de linkage que ainda não rodou (a resposta traz o motivo).
 *
 * Tudo via `GET /api/nexo/grafo`. Estética war room (fundo escuro, acento âmbar).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Network,
  Search,
  RefreshCw,
  TriangleAlert,
  ShieldQuestion,
  Crosshair,
  Wallet,
  ScrollText,
  Gavel,
  Scale,
  Newspaper,
  FileText,
  CornerDownRight,
  ChevronRight,
  Link2,
  Circle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { CompilarBotao, BadgeAtualizado } from '@/components/nexo/NexoTarefaTracker';
import type { GrafoResponse, GrafoNo, GrafoAresta } from '@/app/api/nexo/grafo/route';

const EXERCICIOS = [2026, 2025, 2024];

// ── Ícone/rótulo por tipo de nó (coleção) ─────────────────────────────────────

const ICONE_COLECAO: Record<string, typeof Wallet> = {
  nexo_empenhos: Wallet,
  nexo_contratos_municipais: ScrollText,
  nexo_licitacoes: Gavel,
  nexo_tce_despesas: Scale,
  nexo_diario_dom: Newspaper,
  nexo_documentos: FileText,
};

const ROTULO_COLECAO: Record<string, string> = {
  nexo_empenhos: 'Empenho',
  nexo_contratos_municipais: 'Contrato',
  nexo_licitacoes: 'Licitação',
  nexo_tce_despesas: 'Despesa TCE',
  nexo_diario_dom: 'Diário Oficial',
  nexo_documentos: 'Documento',
};

function iconeColecao(colecao: string): typeof Wallet {
  return ICONE_COLECAO[colecao] ?? Circle;
}

function rotuloColecao(colecao: string): string {
  return ROTULO_COLECAO[colecao] ?? colecao.replace(/^nexo_/, '');
}

// ── Confiança → estilo do badge ───────────────────────────────────────────────

function estiloConfianca(c: string): string {
  switch (c) {
    case 'forte':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    case 'media':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
    case 'fraca':
      return 'border-slate-500/30 bg-slate-500/10 text-slate-400';
    default:
      return 'border-white/10 text-slate-500';
  }
}

function rotuloConfianca(c: string): string {
  if (c === 'media') return 'média';
  return c || 'confiança n/d';
}

/** Rótulo legível do tipo de aresta (empenho-contrato → "Empenho ↔ Contrato"). */
function rotuloTipoAresta(tipo: string): string {
  const m: Record<string, string> = {
    'empenho-contrato': 'Empenho ↔ Contrato',
    'empenho-licitacao': 'Empenho ↔ Licitação',
    'empenho-tce': 'Empenho ↔ Despesa TCE',
    'processo-dom': 'Processo ↔ Diário Oficial',
    doc: 'Documento-fonte',
  };
  return m[tipo] ?? tipo;
}

// ── Página ─────────────────────────────────────────────────────────────────────

export default function GrafoPage() {
  const [exercicio, setExercicio] = useState(2026);
  // Semente atual do grafo (null = lista de hubs).
  const [seed, setSeed] = useState<string | null>(null);
  const [saltos, setSaltos] = useState(1);
  // Campo de busca livre (id composto colecao:docId).
  const [input, setInput] = useState('');

  const [data, setData] = useState<GrafoResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(
    async (no: string | null, ano: number, hops: number) => {
      const id = ++reqId.current;
      setLoading(true);
      setErro(null);
      try {
        const params = new URLSearchParams({
          exercicio: String(ano),
          saltos: String(hops),
        });
        if (no) params.set('no', no);
        const res = await nexoFetch(`/api/nexo/grafo?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as GrafoResponse;
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
    carregar(seed, exercicio, saltos);
  }, [seed, exercicio, saltos, carregar]);

  // Re-semeia ao clicar num nó (expandir vizinhança a partir dele).
  const expandir = useCallback((no: string) => {
    setSeed(no);
    setInput(no);
  }, []);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = input.trim();
    setSeed(v || null);
  };

  const limparSemente = () => {
    setSeed(null);
    setInput('');
  };

  return (
    <EntityProvider>
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Network className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Grafo de Vínculos
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Exploração do grafo <span className="font-mono text-slate-300">TUDO LINKADO</span>:
            partindo de um nó (empenho, contrato, licitação, despesa do TCE,
            edição do Diário ou documento-fonte), navego a vizinhança cruzada de{' '}
            <code className="font-mono text-slate-300">nexo_links</code>. Clique
            num vínculo para re-semear a partir dele.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => carregar(seed, exercicio, saltos)}
              disabled={loading}
              aria-label="Recarregar grafo de vínculos"
              title="Recarregar o grafo a partir da semente/exercício atuais"
              className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
            >
              <RefreshCw
                className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')}
                aria-hidden="true"
              />
              Recarregar
            </Button>
            {/* Compila o snapshot do grafo do exercício em background (Frente E). */}
            <CompilarBotao
              tipo="grafo"
              alvo=""
              exercicio={exercicio}
              rotulo={data?.atualizadoEm ? 'Recompilar' : 'Compilar'}
            />
          </div>
          <BadgeAtualizado geradoEm={data?.atualizadoEm ?? null} />
        </div>
      </div>

      {/* Controles: semente + exercício + saltos */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <form onSubmit={onSubmit} className="w-full lg:max-w-lg">
          <label
            htmlFor="grafo-semente"
            className="mb-1 block text-[11px] uppercase tracking-wide text-slate-500"
          >
            Nó-semente
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden="true"
            />
            <Input
              id="grafo-semente"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="colecao:docId (vazio = hubs do exercício)…"
              aria-label="Nó-semente do grafo (formato colecao:docId; vazio lista os hubs do exercício)"
              className="border-white/10 bg-nexo-chrome pl-9 font-mono text-xs text-slate-200 placeholder:text-slate-500 focus-visible:ring-amber-500/40"
            />
          </div>
          {/* Submete via Enter; botão dedicado p/ acessibilidade/toque. */}
          <button type="submit" className="sr-only">
            Explorar nó-semente
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2" role="group" aria-label="Profundidade da vizinhança (saltos)">
            <span className="text-xs uppercase tracking-wide text-slate-500">Saltos</span>
            {[1, 2].map((h) => (
              <button
                key={h}
                type="button"
                aria-pressed={h === saltos}
                aria-label={`${h} ${h === 1 ? 'salto' : 'saltos'} a partir da semente`}
                title={h === 1 ? 'Apenas vizinhos diretos' : 'Vizinhos diretos e indiretos (2º salto)'}
                onClick={() => setSaltos(h)}
                className={[
                  'rounded-md px-3 py-1 text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40',
                  h === saltos
                    ? 'bg-amber-500/15 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30'
                    : 'text-slate-400 hover:bg-white/5',
                ].join(' ')}
              >
                {h}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2" role="group" aria-label="Selecionar exercício">
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
        </div>
      </div>

      {/* Breadcrumb da semente */}
      {seed && (
        <nav className="flex items-center gap-2 text-xs" aria-label="Trilha de navegação do grafo">
          <button
            type="button"
            onClick={limparSemente}
            aria-label="Voltar aos hubs do exercício (limpar semente)"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-amber-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
          >
            <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
            Hubs do exercício
          </button>
          <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
          <span className="truncate font-mono text-slate-300" title={seed}>{seed}</span>
        </nav>
      )}

      {/* Conteúdo */}
      {loading ? (
        <div className="space-y-3" role="status" aria-busy="true" aria-live="polite">
          <span className="sr-only">Carregando grafo de vínculos…</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5" role="alert">
          <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
            <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
            Não foi possível carregar o grafo: {erro}
          </CardContent>
        </Card>
      ) : data && data.disponivel === false ? (
        // Estado HONESTO: linkage inativo (grafo vazio p/ o exercício).
        <Card className="border-amber-500/20 bg-nexo-surface">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <ShieldQuestion className="h-7 w-7 text-amber-400" aria-hidden="true" />
            <p className="text-sm font-medium text-slate-200">
              Grafo de vínculos ainda não construído
            </p>
            <p className="max-w-md text-xs leading-relaxed text-slate-500">
              {data.motivo ??
                'O cron de linkage (onNexoLinkage) ainda não rodou para este exercício.'}
            </p>
          </CardContent>
        </Card>
      ) : data ? (
        data.no ? (
          <VizinhancaView data={data} onExpandir={expandir} />
        ) : (
          <HubsView data={data} onExpandir={expandir} />
        )
      ) : null}

      {/* Disclaimer */}
      <div className="flex items-start gap-2 rounded-md border border-white/5 bg-nexo-chrome p-4 text-[11px] leading-relaxed text-slate-500">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400/70" aria-hidden="true" />
        <p>
          Os vínculos são <strong className="text-slate-400">indícios</strong> de
          relação entre documentos públicos já ingeridos — cruzamento por nº de
          processo/empenho/CNPJ. Nada aqui constitui acusação ou prova; todo
          indício requer apuração. CPF é exibido mascarado (LGPD).
        </p>
      </div>
    </div>
    </EntityProvider>
  );
}

// ── Vista da vizinhança (semente + vizinhos agrupados por tipo de aresta) ─────

function VizinhancaView({
  data,
  onExpandir,
}: {
  data: GrafoResponse;
  onExpandir: (no: string) => void;
}) {
  const seedId = data.no!;
  const seedNo = useMemo(
    () => data.nodes.find((n) => n.id === seedId) ?? null,
    [data.nodes, seedId],
  );
  const nodeById = useMemo(() => {
    const m = new Map<string, GrafoNo>();
    for (const n of data.nodes) m.set(n.id, n);
    return m;
  }, [data.nodes]);

  // Arestas que tocam DIRETAMENTE a semente, agrupadas por tipo de aresta. Cada
  // grupo lista o nó-alvo (a ponta oposta), com a confiança da aresta.
  const grupos = useMemo(() => {
    const porTipo = new Map<string, { alvo: GrafoNo; aresta: GrafoAresta }[]>();
    for (const a of data.edges) {
      let alvoId: string | null = null;
      if (a.de === seedId) alvoId = a.para;
      else if (a.para === seedId) alvoId = a.de;
      if (!alvoId) continue;
      const alvo = nodeById.get(alvoId);
      if (!alvo) continue;
      const lista = porTipo.get(a.tipo) ?? [];
      lista.push({ alvo, aresta: a });
      porTipo.set(a.tipo, lista);
    }
    // Ordena cada grupo por grau do alvo desc (mais conectado primeiro).
    for (const lista of porTipo.values()) {
      lista.sort((x, y) => y.alvo.grau - x.alvo.grau);
    }
    return [...porTipo.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [data.edges, seedId, nodeById]);

  // Vizinhos indiretos (2º salto): nós na resposta sem aresta direta à semente.
  const vizinhosDiretos = useMemo(() => {
    const s = new Set<string>([seedId]);
    for (const a of data.edges) {
      if (a.de === seedId) s.add(a.para);
      if (a.para === seedId) s.add(a.de);
    }
    return s;
  }, [data.edges, seedId]);
  const indiretos = data.nodes.filter((n) => !vizinhosDiretos.has(n.id));

  return (
    <div className="space-y-5">
      {/* Semente */}
      {seedNo && <NoSemente no={seedNo} truncado={data.truncado} totalVizinhos={data.nodes.length - 1} />}

      {grupos.length === 0 ? (
        <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
          {data.motivo ??
            'Este nó não tem vínculos diretos no grafo deste exercício.'}
        </div>
      ) : (
        grupos.map(([tipo, itens]) => (
          <section key={tipo} className="space-y-2">
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-amber-400/80" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-slate-200">
                {rotuloTipoAresta(tipo)}
              </h3>
              <Badge
                variant="outline"
                className="border-white/10 text-[10px] text-slate-500"
                title={`${itens.length} vínculo(s) deste tipo`}
              >
                {itens.length} {itens.length === 1 ? 'vínculo' : 'vínculos'}
              </Badge>
            </div>
            <ul className="space-y-1.5">
              {itens.map(({ alvo, aresta }, i) => (
                <NoVizinho
                  key={`${alvo.id}-${i}`}
                  no={alvo}
                  aresta={aresta}
                  onExpandir={onExpandir}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {/* 2º salto (vizinhos indiretos) */}
      {indiretos.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <CornerDownRight className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-300">
              Alcançados em 2 saltos
            </h3>
            <Badge
              variant="outline"
              className="border-white/10 text-[10px] text-slate-500"
              title="Nós sem vínculo direto com a semente, alcançados via um intermediário"
            >
              {indiretos.length} {indiretos.length === 1 ? 'nó' : 'nós'}
            </Badge>
          </div>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {indiretos
              .slice()
              .sort((a, b) => b.grau - a.grau)
              .map((n) => (
                <NoVizinho key={n.id} no={n} aresta={null} onExpandir={onExpandir} />
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function NoSemente({
  no,
  truncado,
  totalVizinhos,
}: {
  no: GrafoNo;
  truncado: boolean;
  totalVizinhos: number;
}) {
  const Icon = iconeColecao(no.tipo);
  return (
    <Card className="border-amber-500/20 bg-nexo-surface">
      <CardContent className="flex flex-wrap items-center gap-3 py-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-amber-500/10 ring-1 ring-amber-500/30">
          <Icon className="h-5 w-5 text-amber-400" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-amber-400/80">
              {rotuloColecao(no.tipo)} · semente
            </span>
            <Badge
              variant="outline"
              className="border-white/10 text-[10px] text-slate-500"
              title="Grau: nº total de vínculos que tocam este nó no exercício"
            >
              grau {no.grau}
            </Badge>
          </div>
          <p className="truncate text-sm font-semibold text-slate-100">
            <EntityText>{no.rotulo}</EntityText>
          </p>
          <p className="truncate font-mono text-[11px] text-slate-400" title={no.id}>{no.id}</p>
        </div>
        <div className="text-right text-[11px] text-slate-500">
          <span title="Vizinhos trazidos neste recorte">{totalVizinhos} vizinho(s)</span>
          {truncado && (
            <Badge
              variant="outline"
              className="ml-2 border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300"
              title="A vizinhança foi cortada por limite de nós — pode haver mais vínculos"
            >
              recorte limitado
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NoVizinho({
  no,
  aresta,
  onExpandir,
}: {
  no: GrafoNo;
  aresta: GrafoAresta | null;
  onExpandir: (no: string) => void;
}) {
  const Icon = iconeColecao(no.tipo);
  return (
    <li>
      <button
        type="button"
        onClick={() => onExpandir(no.id)}
        aria-label={`Explorar ${rotuloColecao(no.tipo)}: ${no.rotulo} (re-semear o grafo a partir deste nó)`}
        className="group flex w-full flex-wrap items-center gap-2 rounded-md border border-white/5 bg-nexo-chrome px-3 py-2 text-left transition-colors hover:border-amber-500/30 hover:bg-white/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
        title="Re-semear o grafo a partir deste nó"
      >
        <Icon className="h-4 w-4 shrink-0 text-slate-500 group-hover:text-amber-400/80" aria-hidden="true" />
        <span className="text-[10px] uppercase tracking-wide text-slate-500">
          {rotuloColecao(no.tipo)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-slate-200 group-hover:text-amber-200">
          <EntityText>{no.rotulo}</EntityText>
        </span>
        {aresta && (
          <Badge
            variant="outline"
            className={`text-[10px] ${estiloConfianca(aresta.confianca)}`}
            title={`Confiança do vínculo: ${rotuloConfianca(aresta.confianca)}${aresta.chave ? ` · chave: ${aresta.chave}` : ''}`}
          >
            {rotuloConfianca(aresta.confianca)}
          </Badge>
        )}
        <Badge
          variant="outline"
          className="border-white/10 text-[10px] text-slate-400"
          title="Grau: nº total de vínculos deste nó no exercício"
        >
          grau {no.grau}
        </Badge>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400 group-hover:text-amber-400/80" aria-hidden="true" />
      </button>
    </li>
  );
}

// ── Vista de HUBS (sem semente) ────────────────────────────────────────────────

function HubsView({
  data,
  onExpandir,
}: {
  data: GrafoResponse;
  onExpandir: (no: string) => void;
}) {
  if (data.nodes.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
        Nenhum nó no grafo deste exercício.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div
        role="status"
        aria-label="Resumo do grafo do exercício"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500"
      >
        <span className="flex items-center gap-1.5">
          <Crosshair className="h-3.5 w-3.5 text-amber-400/80" aria-hidden="true" />
          Hubs do exercício {data.exercicio} — os nós mais conectados
        </span>
        <span aria-hidden="true">·</span>
        <span>{data.totalArestasExercicio.toLocaleString('pt-BR')} vínculos no grafo</span>
        <span aria-hidden="true">·</span>
        <span>clique para explorar a vizinhança</span>
      </div>

      <ul className="grid gap-2 lg:grid-cols-2">
        {data.nodes.map((n, i) => {
          const Icon = iconeColecao(n.tipo);
          return (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onExpandir(n.id)}
                aria-label={`Hub nº ${i + 1}: ${rotuloColecao(n.tipo)} ${n.rotulo}, ${n.grau} vínculos. Explorar vizinhança.`}
                className="group flex w-full items-center gap-3 rounded-md border border-white/5 bg-nexo-surface px-3 py-2.5 text-left transition-colors hover:border-amber-500/30 hover:bg-white/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
              >
                <span
                  className="w-6 shrink-0 text-center font-mono text-xs text-slate-400"
                  aria-hidden="true"
                  title={`Posição no ranking de conectividade: ${i + 1}º`}
                >
                  {i + 1}
                </span>
                <Icon className="h-4 w-4 shrink-0 text-slate-500 group-hover:text-amber-400/80" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-slate-200 group-hover:text-amber-200">
                    <EntityText>{n.rotulo}</EntityText>
                  </p>
                  <p className="text-[10px] uppercase tracking-wide text-slate-400">
                    {rotuloColecao(n.tipo)}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="shrink-0 border-amber-500/20 bg-amber-500/5 text-[10px] text-amber-300/90"
                  title="Grau: nº total de vínculos deste nó no exercício"
                >
                  {n.grau} vínculos
                </Badge>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400 group-hover:text-amber-400/80" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
