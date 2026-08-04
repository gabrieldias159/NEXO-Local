'use client';

/**
 * NEXO — Tarefas de compilação (fila `nexo_tarefas` do usuário).
 *
 * Lista, EM TEMPO REAL (client SDK / onSnapshot via useCollection), as tarefas
 * de compilação que ESTE usuário solicitou: status, painel-alvo, exercício,
 * quando foi solicitada/concluída e quando expira (TTL de 3 dias, plano §2.2).
 *
 * É a contraparte visível do NexoTarefaTracker (que só dá toast): aqui o
 * operador vê o histórico e o andamento. A rule é create-only do próprio dono;
 * só o worker (Admin SDK) avança o status — esta tela é somente leitura.
 *
 * Honestidade: filtramos por `solicitadoPor == uid` (sem orderBy no servidor,
 * para não exigir índice composto) e ordenamos por data no cliente. Nada é
 * inventado: campos ausentes aparecem como "—".
 */
import { useMemo } from 'react';
import Link from 'next/link';
import {
  ListChecks,
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  Hourglass,
  TriangleAlert,
  ExternalLink,
  CircleDot,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  collection,
  query,
  where,
  type Timestamp,
} from 'firebase/firestore';
import { useCollection, useFirestore, useMemoFirebase, useUser } from '@/firebase';
import {
  TTL_SNAPSHOT_MS,
  type NexoTarefa,
  type StatusTarefa,
  type TipoTarefa,
} from '@/lib/nexo/jobs-tipos';

const ROTULO_TIPO: Record<TipoTarefa, string> = {
  dossie: 'Dossiê',
  grafo: 'Grafo de vínculos',
  alertas: 'Indícios',
  risco: 'Painel de risco',
  ranking: 'Ranking de vínculos',
};

function rotaDoPainel(tipo: TipoTarefa, alvo: string): string {
  switch (tipo) {
    case 'dossie':
      return alvo ? `/nexo/dossie/${encodeURIComponent(alvo)}` : '/nexo/dossies';
    case 'grafo':
      return '/nexo/grafo';
    case 'alertas':
      return '/nexo';
    case 'risco':
      return '/nexo/risco';
    case 'ranking':
      return '/nexo/ranking';
    default:
      return '/nexo/tarefas';
  }
}

const STATUS_META: Record<
  StatusTarefa,
  { rotulo: string; cls: string; icon: typeof Clock }
> = {
  pendente: {
    rotulo: 'Pendente',
    cls: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
    icon: Hourglass,
  },
  processando: {
    rotulo: 'Processando',
    cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    icon: Loader2,
  },
  pronto: {
    rotulo: 'Pronto',
    cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    icon: CheckCircle2,
  },
  erro: {
    rotulo: 'Erro',
    cls: 'border-red-500/30 bg-red-500/10 text-red-300',
    icon: XCircle,
  },
  expirado: {
    rotulo: 'Expirado',
    cls: 'border-white/10 bg-white/5 text-slate-500',
    icon: CircleDot,
  },
};

/** Converte um Timestamp do Firestore (ou epoch/ISO) em ms; null se ausente. */
function tsToMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const maybe = v as Partial<Timestamp>;
  if (typeof maybe.toMillis === 'function') {
    try {
      return maybe.toMillis();
    } catch {
      return null;
    }
  }
  if (typeof (v as { seconds?: number }).seconds === 'number') {
    return (v as { seconds: number }).seconds * 1000;
  }
  return null;
}

function tempoRelativo(ms: number | null): string {
  if (ms == null) return '—';
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff)) return '—';
  if (diff < 0) return 'agora';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'há instantes';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return `há ${d} dia${d > 1 ? 's' : ''}`;
}

function fmtAbsoluto(ms: number | null): string {
  return ms == null ? '—' : new Date(ms).toLocaleString('pt-BR');
}

type TarefaDoc = NexoTarefa & { id: string };

export default function TarefasPage() {
  const firestore = useFirestore();
  const { user, loading: loadingUser } = useUser();

  const tarefasQuery = useMemoFirebase(() => {
    if (!firestore || !user?.uid) return null;
    // Sem orderBy no servidor (evita índice composto); ordenamos no cliente.
    return query(
      collection(firestore, 'nexo_tarefas'),
      where('solicitadoPor', '==', user.uid),
    );
  }, [firestore, user?.uid]);

  const { data: tarefas, isLoading, error } = useCollection<NexoTarefa>(tarefasQuery);

  const ordenadas: TarefaDoc[] = useMemo(() => {
    const lista = (tarefas ?? []) as TarefaDoc[];
    return [...lista].sort((a, b) => {
      const ta = tsToMs(a.criadoEm) ?? 0;
      const tb = tsToMs(b.criadoEm) ?? 0;
      return tb - ta;
    });
  }, [tarefas]);

  const carregando = loadingUser || isLoading;

  return (
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div>
        <div className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-amber-400" aria-hidden="true" />
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">
            Tarefas de compilação
          </h1>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          Suas solicitações de compilação de snapshot (Painel de Situação, Grafo,
          Dossiê). O servidor materializa o resultado em background — você é
          avisado por toast quando fica pronto. Os snapshots expiram em 3 dias.
        </p>
      </div>

      {error ? (
        <Card className="border-red-500/20 bg-red-500/5" role="alert">
          <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
            <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
            Não foi possível carregar suas tarefas: {error.message}
          </CardContent>
        </Card>
      ) : carregando ? (
        <div className="space-y-2" role="status" aria-busy="true" aria-live="polite">
          <span className="sr-only">Carregando tarefas…</span>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : ordenadas.length === 0 ? (
        <Card className="border-white/5 bg-nexo-surface">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <ListChecks className="h-7 w-7 text-amber-400/70" aria-hidden="true" />
            <p className="text-sm font-medium text-slate-200">
              Nenhuma tarefa de compilação ainda
            </p>
            <p className="max-w-md text-xs leading-relaxed text-slate-500">
              Abra um painel (Painel de Situação, Grafo ou um Dossiê) e use o botão{' '}
              <span className="font-medium text-amber-300">Compilar</span> para
              enfileirar a materialização do snapshot. As tarefas aparecem aqui
              em tempo real.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2.5">
          {ordenadas.map((t) => {
            const tipo = (t.tipo ?? 'alertas') as TipoTarefa;
            const status = (t.status ?? 'pendente') as StatusTarefa;
            const meta = STATUS_META[status] ?? STATUS_META.pendente;
            const StatusIcon = meta.icon;
            const criado = tsToMs(t.criadoEm);
            const concluido = tsToMs(t.concluidoEm);
            // expiraEm pode vir do worker; se ausente, deriva de concluído + TTL.
            const expira =
              tsToMs(t.expiraEm) ??
              (concluido != null ? concluido + TTL_SNAPSHOT_MS : null);
            const rota = rotaDoPainel(tipo, t.alvo ?? '');

            return (
              <li key={t.id}>
                <Card className="border-white/5 bg-nexo-surface">
                  <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className={`text-[10px] uppercase ${meta.cls}`}
                        >
                          <StatusIcon
                            className={
                              'mr-1 h-3 w-3' +
                              (status === 'processando' ? ' animate-spin' : '')
                            }
                            aria-hidden="true"
                          />
                          {meta.rotulo}
                        </Badge>
                        <span className="text-sm font-medium text-slate-200">
                          {ROTULO_TIPO[tipo] ?? tipo}
                        </span>
                        {t.alvo ? (
                          <span
                            className="truncate font-mono text-[11px] text-slate-500"
                            title={t.alvo}
                          >
                            {t.alvo}
                          </span>
                        ) : null}
                        {t.exercicio ? (
                          <Badge
                            variant="outline"
                            className="border-white/10 text-[10px] text-slate-500"
                          >
                            exerc. {t.exercicio}
                          </Badge>
                        ) : null}
                        {t.origem === 'nightly' && (
                          <Badge
                            variant="outline"
                            className="border-white/10 text-[10px] text-slate-400"
                            title="Re-enfileirada automaticamente pelo nightly antes de expirar"
                          >
                            auto
                          </Badge>
                        )}
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[11px] text-slate-500">
                        <span title={fmtAbsoluto(criado)}>
                          <Clock className="mr-1 inline h-3 w-3" aria-hidden="true" />
                          solicitada {tempoRelativo(criado)}
                        </span>
                        {status === 'pronto' && concluido != null && (
                          <span title={fmtAbsoluto(concluido)}>
                            concluída {tempoRelativo(concluido)}
                          </span>
                        )}
                        {status === 'pronto' && expira != null && (
                          <span title={`Expira em ${fmtAbsoluto(expira)}`}>
                            expira{' '}
                            {expira <= Date.now()
                              ? '— expirado'
                              : `em ${Math.max(
                                  0,
                                  Math.ceil((expira - Date.now()) / (24 * 60 * 60 * 1000)),
                                )} dia(s)`}
                          </span>
                        )}
                        {typeof t.progresso === 'number' &&
                          status === 'processando' && (
                            <span>{t.progresso}%</span>
                          )}
                      </div>

                      {status === 'erro' && t.erro && (
                        <p className="mt-1 text-[11px] leading-relaxed text-red-300/80">
                          {t.erro}
                        </p>
                      )}
                    </div>

                    {status === 'pronto' && (
                      <Link
                        href={rota}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-emerald-500/30 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        Abrir painel
                      </Link>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {/* Disclaimer */}
      <div className="flex items-start gap-2 rounded-md border border-white/5 bg-nexo-chrome p-4 text-[11px] leading-relaxed text-slate-500">
        <TriangleAlert
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-400/70"
          aria-hidden="true"
        />
        <p>
          A fila é somente leitura: a criação é do próprio operador (botão
          Compilar) e o avanço de status é exclusivo do worker de compilação.
          Snapshots expiram em 3 dias; o nightly re-enfileira os que estão perto
          de vencer para o painel nunca ficar sem dado.
        </p>
      </div>
    </div>
  );
}
