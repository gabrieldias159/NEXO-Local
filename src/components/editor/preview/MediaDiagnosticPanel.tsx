'use client';

/**
 * MediaDiagnosticPanel.
 *
 * Painel de diagnostico do Media Controller. Mostra:
 *  - Lista de assets em uso com estado atual (badge colorido).
 *  - Log de eventos recentes (filtravel por asset).
 *  - Botoes: limpar log, exportar JSON, reportar problema (Firestore).
 *
 * Acessivel via botao flutuante no canto do preview ou via prop externa.
 */

import { useMemo, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Activity,
  Download,
  Trash2,
  Send,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
} from 'lucide-react';
import { useMediaControllerStore, getMediaControllerSnapshot } from '@/lib/editor/media-controller/store';
import { getMediaController, mediaStateLabel } from '@/lib/editor/media-controller/controller';
import type { MediaState } from '@/lib/editor/media-controller/types';
import { useFirestore, useUser } from '@/firebase';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface MediaDiagnosticPanelProps {
  className?: string;
}

/**
 * Remove valores `undefined` (e NaN/Infinity) recursivamente. O snapshot do
 * media-controller carrega muitos campos opcionais como undefined explicito
 * (clipId, bufferedEnd, duration, url, error.code…), e o Firestore Web SDK
 * (init default, sem ignoreUndefinedProperties) REJEITA `addDoc` com undefined
 * em qualquer profundidade — era por isso que "Reportar problema" sempre falhava.
 */
function sanitizeForFirestore(v: any): any {
  if (Array.isArray(v)) return v.map(sanitizeForFirestore);
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      out[k] = sanitizeForFirestore(val);
    }
    return out;
  }
  return typeof v === 'number' && !Number.isFinite(v) ? null : v;
}

function stateBadge(state: MediaState) {
  const map: Record<MediaState, { variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success'; icon: React.ReactNode; cls?: string }> = {
    idle: { variant: 'outline', icon: <Clock className="h-2.5 w-2.5" /> },
    loading: { variant: 'secondary', icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />, cls: 'bg-blue-500/15 text-blue-700 dark:text-blue-300' },
    buffering: { variant: 'secondary', icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />, cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
    ready: { variant: 'success', icon: <CheckCircle2 className="h-2.5 w-2.5" /> },
    playing: { variant: 'success', icon: <CheckCircle2 className="h-2.5 w-2.5" /> },
    paused: { variant: 'outline', icon: <Clock className="h-2.5 w-2.5" /> },
    stalled: { variant: 'secondary', icon: <AlertTriangle className="h-2.5 w-2.5" />, cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
    error: { variant: 'destructive', icon: <AlertTriangle className="h-2.5 w-2.5" /> },
    failed: { variant: 'destructive', icon: <AlertTriangle className="h-2.5 w-2.5" /> },
  };
  const cfg = map[state];
  return (
    <Badge variant={cfg.variant as any} className={cn('gap-1 text-[10px]', cfg.cls)}>
      {cfg.icon}
      {mediaStateLabel(state)}
    </Badge>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function MediaDiagnosticPanel({ className }: MediaDiagnosticPanelProps) {
  const open = useMediaControllerStore((s) => s.diagnosticOpen);
  const setOpen = useMediaControllerStore((s) => s.setDiagnosticOpen);
  const statuses = useMediaControllerStore((s) => s.statuses);
  const events = useMediaControllerStore((s) => s.events);
  const clearEvents = useMediaControllerStore((s) => s.clearEvents);
  const [filter, setFilter] = useState<string>('all');
  const firestore = useFirestore();
  const { user } = useUser();
  const { toast } = useToast();
  const [reporting, setReporting] = useState(false);

  const statusList = useMemo(() => Object.values(statuses), [statuses]);
  const hasIssue = useMemo(
    () => statusList.some((s) => s.state === 'error' || s.state === 'failed' || s.state === 'stalled'),
    [statusList],
  );
  // Filtro por clip (a chave do slot agora eh o clipId, nao o assetId — clips
  // distintos podem compartilhar o mesmo asset). Eventos carregam clipId.
  const filtered = useMemo(
    () => (filter === 'all' ? events : events.filter((e) => e.clipId === filter)),
    [events, filter],
  );

  const exportJson = () => {
    const snapshot = getMediaControllerSnapshot();
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `media-controller-log-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reportProblem = async () => {
    if (!firestore || !user) {
      toast({ title: 'Login necessário', variant: 'destructive' });
      return;
    }
    setReporting(true);
    try {
      const snapshot = getMediaControllerSnapshot();
      // Cap de eventos + truncagem de strings longas: protege contra estourar o
      // limite de 1MiB do doc (URLs assinadas/mensagens podem ser enormes).
      const payload = sanitizeForFirestore({
        capturedAt: snapshot.capturedAt,
        statuses: snapshot.statuses,
        events: snapshot.events.slice(0, 120).map((e) => ({
          ...e,
          url: e.url?.slice(0, 500),
          message: e.message?.slice(0, 500),
        })),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        url: typeof window !== 'undefined' ? window.location.href : '',
      });
      // serverTimestamp() fica FORA do sanitizer (sentinel nao pode ser percorrido).
      await addDoc(collection(firestore, 'mediaPlayerReports'), {
        ownerUid: user.uid,
        createdAt: serverTimestamp(),
        ...payload,
      });
      toast({ title: 'Problema reportado', description: 'Recebemos o snapshot pra investigar.' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: 'Erro ao reportar', description: msg, variant: 'destructive' });
    } finally {
      setReporting(false);
    }
  };

  // Retry pela CHAVE do slot (clipId), igual a key usada no store/controller.
  const retryByKey = (key: string) => {
    getMediaController().retryManually(key);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-7 w-7 relative', className)}
          title="Diagnostico de midia"
        >
          <Activity className={cn('h-3.5 w-3.5', hasIssue ? 'text-destructive' : 'text-muted-foreground')} />
          {hasIssue && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-destructive ring-1 ring-background" />
          )}
        </Button>
      </SheetTrigger>

      <SheetContent side="right" className="w-full sm:max-w-lg p-0 flex flex-col gap-0">
        <SheetHeader className="border-b px-4 py-3 shrink-0">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />
            Diagnóstico de mídia
          </SheetTitle>
          <SheetDescription className="text-xs">
            Estado do player em tempo real + log de eventos pra debug.
          </SheetDescription>
        </SheetHeader>

        {/* Acoes */}
        <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2 shrink-0">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={exportJson}>
            <Download className="h-3 w-3 mr-1" />
            Exportar JSON
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={reportProblem} disabled={reporting}>
            {reporting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
            Reportar problema
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={clearEvents}>
            <Trash2 className="h-3 w-3 mr-1" />
            Limpar log
          </Button>
        </div>

        <ScrollArea className="flex-1 min-h-0">
          {/* Assets atuais */}
          <div className="px-3 py-2 space-y-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold pt-1">
              Assets ({statusList.length})
            </p>
            {statusList.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">Nenhum asset ativo no player.</p>
            ) : (
              statusList.map((s) => (
                <div
                  key={s.key}
                  className={cn(
                    'rounded-md border p-2 space-y-1 cursor-pointer hover:bg-accent transition-colors',
                    filter === s.key && 'border-primary bg-primary/5',
                  )}
                  onClick={() => setFilter(filter === s.key ? 'all' : s.key)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-mono truncate" title={s.assetId}>
                      {s.assetId.slice(0, 16)}…
                    </p>
                    {stateBadge(s.state)}
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>
                      tentativas: {s.retries}
                      {s.bufferedEnd != null && s.duration ? (
                        <> · buffer {Math.round((s.bufferedEnd / s.duration) * 100)}%</>
                      ) : null}
                    </span>
                    {(s.state === 'error' || s.state === 'failed') && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); retryByKey(s.key); }}
                        className="text-primary hover:underline flex items-center gap-1"
                      >
                        <RefreshCw className="h-2.5 w-2.5" />
                        Tentar de novo
                      </button>
                    )}
                  </div>
                  {s.lastError && (
                    <p className="text-[10px] text-destructive truncate" title={s.lastError}>
                      {s.lastError}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Eventos */}
          <div className="px-3 py-2 space-y-1 border-t">
            <div className="flex items-center justify-between pt-1">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                Eventos ({filtered.length}{filter !== 'all' ? ' filtrado' : ''})
              </p>
              {filter !== 'all' && (
                <button
                  type="button"
                  onClick={() => setFilter('all')}
                  className="text-[10px] text-primary hover:underline"
                >
                  limpar filtro
                </button>
              )}
            </div>
            {filtered.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">Nenhum evento ainda.</p>
            ) : (
              <div className="space-y-0.5 font-mono text-[10px]">
                {filtered.slice(0, 200).map((e, i) => (
                  <div key={`${e.ts}-${i}`} className="flex items-start gap-1.5 py-0.5 border-b border-border/30">
                    <span className="text-muted-foreground shrink-0">{formatTime(e.ts)}</span>
                    <span className={cn(
                      'shrink-0 uppercase',
                      e.kind === 'error' && 'text-destructive',
                      e.kind === 'retry' && 'text-amber-600 dark:text-amber-400',
                      e.kind === 'url-refresh' && 'text-blue-600 dark:text-blue-400',
                      e.kind === 'ready' && 'text-emerald-600 dark:text-emerald-400',
                    )}>{e.kind}</span>
                    <span className="truncate flex-1" title={e.message ?? e.error?.message ?? ''}>
                      {e.state ? `→ ${e.state}` : ''} {e.message ?? e.error?.message ?? ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
