'use client';

/**
 * NEXO — Cron & Processamento: AGENDA dos crons definidos + estado real de
 * absorção de cada um (cruzado com `nexo_sync_state` via /api/nexo/saude-ingestao).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Cpu,
  RefreshCw,
  Clock,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Wallet,
  AlertTriangle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CRONS, type AreaCron, type CronDef } from '@/lib/nexo/crons';
import type {
  SaudeIngestaoResponse,
  FonteSaude,
  StatusSaude,
} from '@/app/api/nexo/saude-ingestao/route';
import { nexoFetch } from '@/lib/nexo/client-fetch';

function saudeBadge(s: StatusSaude): string {
  if (s === 'ok') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  if (s === 'stale') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  if (s === 'degradado') return 'border-orange-500/30 bg-orange-500/10 text-orange-300';
  return 'border-red-500/30 bg-red-500/10 text-red-300';
}

function saudeDot(s: StatusSaude): string {
  if (s === 'ok') return 'bg-emerald-400';
  if (s === 'stale') return 'bg-amber-400';
  if (s === 'degradado') return 'bg-orange-400';
  return 'bg-red-400';
}

function saudeLabel(s: StatusSaude): string {
  return s === 'ok' ? 'OK' : s === 'stale' ? 'Desatualizada' : s === 'degradado' ? 'Degradada' : 'Falha';
}

const AREAS: AreaCron[] = ['Coleta', 'Fontes Externas', 'Inteligência', 'Verticais IA', 'Jobs'];

const AREA_ICON: Record<AreaCron, typeof Cpu> = {
  Coleta: Cpu,
  'Fontes Externas': Wallet,
  Inteligência: Cpu,
  'Verticais IA': Cpu,
  Jobs: Clock,
};

function fmtData(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function CronsPage() {
  const [health, setHealth] = useState<SaudeIngestaoResponse | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [abertos, setAbertos] = useState<Record<AreaCron, boolean>>({
    Coleta: true,
    'Fontes Externas': true,
    Inteligência: true,
    'Verticais IA': true,
    Jobs: true,
  });

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const res = await nexoFetch('/api/nexo/saude-ingestao');
      if (!res.ok) {
        const corpo = (await res.json().catch(() => null)) as { erro?: string } | null;
        throw new Error(corpo?.erro ?? `HTTP ${res.status}`);
      }
      setHealth((await res.json()) as SaudeIngestaoResponse);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'falha ao carregar');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Mapa fonte→saúde (case-insensitive) para cruzar com os crons.
  const porFonte = new Map<string, FonteSaude>();
  for (const f of health?.fontes ?? []) {
    porFonte.set(f.fonte.toLowerCase(), f);
  }

  const porArea = (area: AreaCron): CronDef[] => CRONS.filter((c) => c.area === area);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Cpu className="h-5 w-5 text-primary" /> Cron &amp; Processamento
          </h1>
          <p className="text-sm text-muted-foreground">
            Agenda definida dos processadores e a absorção real de cada um
            (estado vindo de <code>nexo_sync_state</code>).
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void carregar()} disabled={carregando}>
          <RefreshCw className={carregando ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /> Atualizar
        </Button>
      </div>

      {erro && (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="flex items-center gap-2 py-3 text-sm text-red-200">
            <AlertTriangle className="h-4 w-4" /> {erro}
          </CardContent>
        </Card>
      )}

      {health && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { k: 'fontes', label: 'Fontes', v: health.resumo.fontes },
            { k: 'registros', label: 'Registros', v: health.resumo.registros },
            { k: 'ok', label: 'Saudáveis', v: health.resumo.ok },
            { k: 'degradados', label: 'Com problema', v: health.resumo.stale + health.resumo.degradado + health.resumo.falha },
          ].map((card) => (
            <Card key={card.k}>
              <CardContent className="py-3 text-center">
                <div className="text-2xl font-semibold">{carregando ? <Skeleton className="mx-auto h-7 w-12" /> : card.v}</div>
                <div className="text-xs text-muted-foreground">{card.label}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {carregando && !health && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {!carregando && health?.aviso && (
        <Card>
          <CardContent className="py-3 text-sm text-muted-foreground">{health.aviso}</CardContent>
        </Card>
      )}

      {AREAS.map((area) => {
        const Icon = AREA_ICON[area];
        const lista = porArea(area);
        const aberto = abertos[area];
        return (
          <Card key={area}>
            <CardHeader
              className="cursor-pointer select-none py-3"
              onClick={() => setAbertos((a) => ({ ...a, [area]: !aberto }))}
            >
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-primary" /> {area}
                  <Badge variant="outline" className="ml-1">{lista.length}</Badge>
                </span>
                <span className="text-muted-foreground">
                  {aberto ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </span>
              </CardTitle>
            </CardHeader>
            {aberto && (
              <CardContent className="space-y-2 pt-0">
                {lista.map((c) => {
                  const live = c.fonte ? porFonte.get(c.fonte.toLowerCase()) : undefined;
                  return (
                    <div
                      key={c.fn}
                      className="flex flex-col gap-1 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{c.nome}</span>
                          <Badge variant="outline" className="font-mono text-[11px]">{c.cron}</Badge>
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {c.frequencia}</span>
                          <span className="mx-2 text-muted-foreground/40">•</span>
                          <span className="font-mono">{c.fn}</span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-3">
                        {live ? (
                          <>
                            <div className="flex items-center gap-2">
                              <span className={`h-2 w-2 rounded-full ${saudeDot(live.statusSaude)}`} />
                              <Badge className={saudeBadge(live.statusSaude)}>{saudeLabel(live.statusSaude)}</Badge>
                            </div>
                            <div className="hidden text-right text-xs leading-tight md:block">
                              <div className="flex items-center gap-1 text-muted-foreground">
                                <CalendarClock className="h-3 w-3" /> Coleta {fmtData(live.ultimaColeta)}
                              </div>
                              <div className="text-muted-foreground">
                                {live.registros} regs · {fmtMs(live.duracaoMs)}
                              </div>
                              {live.truncado && (
                                <div className="text-amber-300">truncado</div>
                              )}
                              {live.erro && (
                                <div className="max-w-[260px] truncate text-red-300" title={live.erro}>{live.erro}</div>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="text-xs text-muted-foreground/60">sem estado registrado</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}