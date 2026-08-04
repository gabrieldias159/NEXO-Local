'use client';

/** NEXO — Coleta & Fontes: saúde da ingestão + estado ao vivo dos conectores. */
import { useEffect, useRef, useState } from 'react';
import {
  Database,
  RefreshCw,
  CircleCheck,
  CircleX,
  Clock,
  CircleHelp,
  Activity,
  AlertTriangle,
  HeartPulse,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { NexoStatusResponse } from '@/app/api/nexo/status/route';
import type {
  SaudeIngestaoResponse,
  FonteSaude,
  StatusSaude,
} from '@/app/api/nexo/saude-ingestao/route';
import { nexoFetch } from '@/lib/nexo/client-fetch';

/**
 * Domínios de dados monitorados. Cada um se ancora numa fonte upstream cuja
 * conectividade é sondada ao vivo por `/api/nexo/status`. O estado exibido
 * NÃO é fixo — deriva da sonda da fonte de origem.
 */
type FonteId = 'smarapd' | 'siconfi' | 'pncp';

interface DominioDef {
  nome: string;
  fonte: string;
  ancora: FonteId;
}

const DOMINIOS: DominioDef[] = [
  { nome: 'Empenho analítico', fonte: 'SMARAPD · fornecedor', ancora: 'smarapd' },
  { nome: 'Despesas orçamentárias', fonte: 'SMARAPD · DespesaAgrupada', ancora: 'smarapd' },
  { nome: 'Diárias', fonte: 'SMARAPD · diarias', ancora: 'smarapd' },
  { nome: 'Restos a pagar', fonte: 'SMARAPD · restoapagar', ancora: 'smarapd' },
  { nome: 'Empenho por modalidade', fonte: 'SMARAPD · EmpenhoModalidade', ancora: 'smarapd' },
  { nome: 'Indicadores fiscais (RREO/RGF)', fonte: 'SICONFI/STN', ancora: 'siconfi' },
  { nome: 'Contratos e aditivos', fonte: 'PNCP', ancora: 'pncp' },
];

type EstadoFonte = 'online' | 'offline' | 'desconhecido';

function estadoFonte(status: NexoStatusResponse | null, ancora: FonteId): EstadoFonte {
  if (!status) return 'desconhecido';
  return status.fontes[ancora].conectado ? 'online' : 'offline';
}

function estadoBadge(estado: EstadoFonte): string {
  if (estado === 'online') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (estado === 'offline') return 'border-red-500/30 bg-red-500/10 text-red-300';
  return 'border-slate-500/30 bg-slate-500/10 text-slate-400';
}

function estadoLabel(estado: EstadoFonte): string {
  if (estado === 'online') return 'Online';
  if (estado === 'offline') return 'Offline';
  return 'Sem leitura';
}

// ── Saúde da ingestão (de /api/nexo/saude-ingestao) ──────────────────────────

/** Cor de fundo/borda do semáforo de saúde da ingestão. */
function saudeBadge(s: StatusSaude): string {
  if (s === 'ok') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (s === 'stale') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  if (s === 'degradado') return 'border-orange-500/30 bg-orange-500/10 text-orange-300';
  return 'border-red-500/30 bg-red-500/10 text-red-300';
}

/** Cor da bolinha do semáforo. */
function saudeDot(s: StatusSaude): string {
  if (s === 'ok') return 'bg-emerald-400';
  if (s === 'stale') return 'bg-amber-400';
  if (s === 'degradado') return 'bg-orange-400';
  return 'bg-red-400';
}

function saudeLabel(s: StatusSaude): string {
  if (s === 'ok') return 'OK';
  if (s === 'stale') return 'Desatualizada';
  if (s === 'degradado') return 'Degradada';
  return 'Falha';
}

const CADENCIA_LABEL: Record<string, string> = {
  diario: 'diária',
  quinzenal: 'quinzenal',
  '6h': 'a cada 6h',
};

/** Tempo relativo em pt-BR a partir de um timestamp ISO ("há 3 horas"). */
function tempoRelativo(iso: string | null): string {
  if (!iso) return 'nunca';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'data inválida';
  if (ms < 0) return 'agora mesmo';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'há instantes';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `há ${d} dia${d > 1 ? 's' : ''}`;
  const meses = Math.floor(d / 30);
  return `há ${meses} ${meses > 1 ? 'meses' : 'mês'}`;
}

export default function ColetaPage() {
  const [status, setStatus] = useState<NexoStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Saúde da ingestão (estado já persistido pelo cron em nexo_sync_state).
  const [saude, setSaude] = useState<SaudeIngestaoResponse | null>(null);
  const [loadingSaude, setLoadingSaude] = useState(true);
  const [erroSaude, setErroSaude] = useState<string | null>(null);

  const reqId = useRef(0);
  const carregar = () => {
    const id = ++reqId.current;
    setLoading(true);
    setLoadingSaude(true);
    setErro(null);
    setErroSaude(null);

    // Conectividade ao vivo das fontes.
    nexoFetch('/api/nexo/status')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as NexoStatusResponse;
      })
      .then((j) => {
        if (id === reqId.current) setStatus(j);
      })
      .catch((err) => {
        if (id === reqId.current) {
          setStatus(null);
          setErro(err instanceof Error ? err.message : 'erro desconhecido');
        }
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false);
      });

    // Saúde real da ingestão.
    nexoFetch('/api/nexo/saude-ingestao')
      .then(async (r) => {
        if (!r.ok) {
          const corpo = (await r.json().catch(() => null)) as
            | { erro?: string }
            | null;
          throw new Error(corpo?.erro ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as SaudeIngestaoResponse;
      })
      .then((j) => {
        if (id === reqId.current) setSaude(j);
      })
      .catch((err) => {
        if (id === reqId.current) {
          setSaude(null);
          setErroSaude(err instanceof Error ? err.message : 'erro desconhecido');
        }
      })
      .finally(() => {
        if (id === reqId.current) setLoadingSaude(false);
      });
  };

  useEffect(() => {
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Coleta &amp; Fontes</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Saúde real da ingestão automática e estado ao vivo dos conectores de
            dados do NEXO. A saúde de cada fonte vem do que o cron de coleta
            registrou — não de uma sondagem fixa.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={carregar}
          disabled={loading || loadingSaude}
          aria-label="Atualizar saúde da ingestão e conectividade das fontes"
          title="Reler o estado das fontes e a saúde da ingestão"
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5 focus-visible:ring-1 focus-visible:ring-amber-500/40"
        >
          <RefreshCw
            className={
              'mr-2 h-4 w-4' + (loading || loadingSaude ? ' animate-spin' : '')
            }
            aria-hidden="true"
          />
          Atualizar
        </Button>
      </div>

      {/* Saúde da ingestão — seção principal */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <HeartPulse className="h-4 w-4 text-amber-400" aria-hidden="true" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
            Saúde da ingestão
          </h2>
          {saude?.ingestaoExecutou && (
            <span className="text-[11px] text-slate-400">
              {saude.resumo.fontes.toLocaleString('pt-BR')} fonte{saude.resumo.fontes !== 1 ? 's' : ''}
              {' · '}
              {saude.resumo.registros.toLocaleString('pt-BR')} registro{saude.resumo.registros !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {loadingSaude ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-busy="true" aria-label="Carregando saúde da ingestão">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : erroSaude ? (
          <Card className="border-red-500/20 bg-nexo-surface" role="alert">
            <CardContent className="flex items-start gap-3 pt-6">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-slate-200">
                  Não foi possível ler a saúde da ingestão
                </p>
                <p className="mt-1 text-xs text-red-400/80">{erroSaude}</p>
              </div>
            </CardContent>
          </Card>
        ) : saude && !saude.ingestaoExecutou ? (
          <Card className="border-white/5 bg-nexo-surface" role="status">
            <CardContent className="flex items-start gap-3 pt-6">
              <CircleHelp className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-slate-200">
                  Ingestão ainda não rodou
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {saude.aviso ??
                    'A coleção nexo_sync_state está vazia — nenhuma coleta foi registrada.'}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : saude ? (
          <>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Resumo das fontes por estado de saúde">
              <ResumoChip
                cor="emerald"
                label="OK"
                valor={saude.resumo.ok}
              />
              <ResumoChip
                cor="amber"
                label="Desatualizadas"
                valor={saude.resumo.stale}
              />
              <ResumoChip
                cor="orange"
                label="Degradadas"
                valor={saude.resumo.degradado}
              />
              <ResumoChip cor="red" label="Falha" valor={saude.resumo.falha} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {saude.fontes.map((f) => (
                <SaudeCard key={f.fonte} fonte={f} />
              ))}
            </div>
            {saude.resumo.ultimaColeta && (
              <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <Activity className="h-3 w-3" aria-hidden="true" />
                Coleta mais recente {tempoRelativo(saude.resumo.ultimaColeta)}
                {' · '}
                {new Date(saude.resumo.ultimaColeta).toLocaleString('pt-BR')}
              </p>
            )}
          </>
        ) : null}
      </section>

      {/* Conectividade ao vivo */}
      <div
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        aria-busy={loading}
        {...(loading ? { role: 'status', 'aria-label': 'Verificando conectividade das fontes' } : {})}
      >
        {loading ? (
          <>
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </>
        ) : (
          <>
            <FonteCard
              nome="Portal da Transparência"
              sub="Plataforma SMARAPD · paiportalserver"
              estado={estadoFonte(status, 'smarapd')}
              detalhe={
                status?.fontes.smarapd.conectado
                  ? `${status.fontes.smarapd.modulos ?? '—'} módulos · HTTP ${status.fontes.smarapd.status ?? '—'}`
                  : status?.fontes.smarapd.erro ?? erro ?? 'sem resposta'
              }
            />
            <FonteCard
              nome="SICONFI / Tesouro Nacional"
              sub="RREO · RGF · DCA — IBGE 3529005"
              estado={estadoFonte(status, 'siconfi')}
              detalhe={
                status?.fontes.siconfi.conectado
                  ? 'Indicadores fiscais acessíveis'
                  : status?.fontes.siconfi.erro ?? erro ?? 'sem resposta'
              }
            />
            <FonteCard
              nome="PNCP — Contratações Públicas"
              sub="Contratos e aditivos · Lei 14.133/2021"
              estado={estadoFonte(status, 'pncp')}
              detalhe={
                status?.fontes.pncp.conectado
                  ? 'Contratos do órgão acessíveis'
                  : status?.fontes.pncp.erro ?? erro ?? 'sem resposta'
              }
            />
          </>
        )}
      </div>

      {status && (
        <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <Clock className="h-3 w-3" aria-hidden="true" />
          Verificado em {new Date(status.verificadoEm).toLocaleString('pt-BR')}
          {' · '}exercício de referência {status.exercicioReferencia}
        </p>
      )}

      {/* Domínios de dados */}
      <Card className="border-white/5 bg-nexo-surface">
        <CardHeader>
          <CardTitle className="text-base text-slate-200">Domínios monitorados</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-white/5">
            {DOMINIOS.map((d) => {
              const estado = estadoFonte(status, d.ancora);
              return (
                <div key={d.nome} className="flex items-center justify-between py-2.5">
                  <div>
                    <p className="text-sm text-slate-200">{d.nome}</p>
                    <p className="text-[11px] text-slate-500">{d.fonte}</p>
                  </div>
                  <Badge
                    variant="outline"
                    className={`text-[10px] uppercase ${estadoBadge(estado)}`}
                  >
                    {loading ? '…' : estadoLabel(estado)}
                  </Badge>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Coleta automática */}
      <Card className="border-white/5 bg-nexo-surface">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-200">
            <Clock className="h-4 w-4 text-amber-400" aria-hidden="true" />
            Coleta automática
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-slate-400">
          <p>
            A Cloud Function{' '}
            <code className="rounded bg-white/5 px-1 text-amber-300">onNexoColetaDiaria</code>{' '}
            roda todo dia às 04h15 (horário de Brasília): coleta empenhos e
            diárias do Portal da Transparência e persiste nas coleções{' '}
            <code className="rounded bg-white/5 px-1 text-slate-300">nexo_*</code>{' '}
            do Firestore, com hash de conteúdo para só reescrever quando os
            dados mudam.
          </p>
          <p className="text-[11px] text-slate-400">
            Requer deploy:{' '}
            <code className="rounded bg-white/5 px-1">firebase deploy --only functions</code>.
            O estado de cada coleta fica registrado em{' '}
            <code className="rounded bg-white/5 px-1">nexo_sync_state</code>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function FonteCard({
  nome,
  sub,
  estado,
  detalhe,
}: {
  nome: string;
  sub: string;
  estado: EstadoFonte;
  detalhe: string;
}) {
  return (
    <Card className="border-white/5 bg-nexo-surface">
      <CardContent className="flex items-start gap-3 pt-6">
        {estado === 'online' ? (
          <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
        ) : estado === 'offline' ? (
          <CircleX className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden="true" />
        ) : (
          <CircleHelp className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-200">
            {nome}
            <span className="sr-only"> — {estadoLabel(estado).toLowerCase()}</span>
          </p>
          <p className="text-[11px] text-slate-500">{sub}</p>
          <p
            className={
              'mt-1 text-xs ' +
              (estado === 'online'
                ? 'text-emerald-400/80'
                : estado === 'offline'
                  ? 'text-red-400/80'
                  : 'text-slate-500')
            }
          >
            {detalhe}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Chip de contagem do resumo de saúde (quantas fontes em cada estado). */
function ResumoChip({
  cor,
  label,
  valor,
}: {
  cor: 'emerald' | 'amber' | 'orange' | 'red';
  label: string;
  valor: number;
}) {
  const cores: Record<typeof cor, string> = {
    emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    orange: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
    red: 'border-red-500/30 bg-red-500/10 text-red-300',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] ${
        valor > 0 ? cores[cor] : 'border-white/5 bg-white/5 text-slate-500'
      }`}
    >
      <span className="font-semibold tabular-nums">{valor}</span>
      {label}
    </span>
  );
}

/** Card de saúde de uma fonte de ingestão — semáforo + métricas do cron. */
function SaudeCard({ fonte }: { fonte: FonteSaude }) {
  const s = fonte.statusSaude;
  return (
    <Card className="border-white/5 bg-nexo-surface">
      <CardContent className="space-y-3 pt-6">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${saudeDot(s)}`}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-200">
                {fonte.fonte}
              </p>
              {fonte.colecao && (
                <p className="truncate text-[11px] text-slate-500">
                  {fonte.colecao}
                </p>
              )}
            </div>
          </div>
          <Badge
            variant="outline"
            className={`shrink-0 text-[10px] uppercase ${saudeBadge(s)}`}
          >
            {saudeLabel(s)}
          </Badge>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-slate-400">
          <Clock className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
          Atualizada {tempoRelativo(fonte.ultimaColeta)}
          {fonte.cadencia && (
            <span className="text-slate-400">
              · coleta {CADENCIA_LABEL[fonte.cadencia] ?? fonte.cadencia}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <p className="text-[10px] uppercase text-slate-400">Registros</p>
            <p className="tabular-nums text-slate-300">
              {fonte.registros.toLocaleString('pt-BR')}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-slate-400">
              Erros consecutivos
            </p>
            <p
              className={
                'tabular-nums ' +
                (fonte.errosConsecutivos > 0
                  ? 'text-red-400'
                  : 'text-slate-300')
              }
            >
              {fonte.errosConsecutivos}
            </p>
          </div>
        </div>

        <div className="text-[11px] text-slate-400">
          Exercícios:{' '}
          {fonte.exercicios.length > 0 ? (
            <span className="text-slate-400">
              {fonte.exercicios.join(', ')}
            </span>
          ) : (
            <span className="text-slate-500">nenhum</span>
          )}
          {fonte.ultimoSucesso && fonte.ultimoSucesso !== fonte.ultimaColeta && (
            <span className="block">
              Último sucesso {tempoRelativo(fonte.ultimoSucesso)}
            </span>
          )}
        </div>

        {fonte.erro && (
          <p className="flex items-start gap-1.5 rounded-md border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-400/90">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="break-words">{fonte.erro}</span>
          </p>
        )}
        {fonte.parcial && !fonte.erro && (
          <p className="flex items-center gap-1.5 text-[11px] text-orange-400/80">
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
            Última coleta parcial — alguns dados podem faltar.
          </p>
        )}
        {fonte.derivado && (
          <p className="text-[10px] text-slate-400">
            Estado derivado — registro de coleta sem campo de saúde.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
