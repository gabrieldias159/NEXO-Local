'use client';

import { useEffect, useState } from 'react';
import { Activity, CircleCheck, CircleX, Database, HeartPulse, RefreshCw, Server } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { SaudeSistemaResponse } from '@/app/api/nexo/saude-sistema/route';
import { nexoFetch } from '@/lib/nexo/client-fetch';

function brl(v: number): string {
  return v.toLocaleString('pt-BR');
}

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

function Indicador({ ok, label }: { ok: boolean; label: string }) {
  return ok
    ? <span className="inline-flex items-center gap-1 text-emerald-400"><CircleCheck className="h-3.5 w-3.5" /> {label}</span>
    : <span className="inline-flex items-center gap-1 text-red-400"><CircleX className="h-3.5 w-3.5" /> {label}</span>;
}

export default function SaudeSistemaPage() {
  const [dados, setDados] = useState<SaudeSistemaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = () => {
    setLoading(true);
    setErro(null);
    nexoFetch('/api/nexo/saude-sistema')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as SaudeSistemaResponse;
      })
      .then(setDados)
      .catch((err) => setErro(err instanceof Error ? err.message : 'erro desconhecido'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { carregar(); }, []);

  const saudavel =
    dados &&
    dados.servicos.every((s) => s.ok) &&
    dados.fontes.smarapd.ok &&
    dados.fontes.siconfi.ok &&
    dados.fontes.pncp.ok;

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <HeartPulse className="h-5 w-5 text-amber-400" aria-hidden />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Saúde do Sistema</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Status de todos os serviços, conectividade com fontes externas e
            frescor dos dados do NEXO.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={carregar} disabled={loading}
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5">
          <RefreshCw aria-hidden className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} />
          {loading ? 'Verificando…' : 'Atualizar'}
        </Button>
      </div>

      {erro && (
        <Card className="border-red-500/20 bg-red-500/5">
          <CardContent className="py-4 text-sm text-red-300">Falha ao carregar: {erro}</CardContent>
        </Card>
      )}

      {loading && !dados ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : dados && (
        <>
          {/* Resumo geral */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className={'border ' + (saudavel ? 'border-emerald-500/30' : 'border-red-500/30')}>
              <CardContent className="flex items-center gap-3 py-4">
                <HeartPulse className={'h-8 w-8 ' + (saudavel ? 'text-emerald-400' : 'text-red-400')} />
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Estado geral</div>
                  <div className={'text-lg font-semibold ' + (saudavel ? 'text-emerald-300' : 'text-red-300')}>
                    {saudavel ? 'Saudável' : 'Atenção'}
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-white/5">
              <CardContent className="flex items-center gap-3 py-4">
                <Server className="h-8 w-8 text-slate-400" />
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Ambiente</div>
                  <div className="text-lg font-semibold text-slate-100">
                    {dados.ambiente.emulador ? 'Emulador Local' : 'Produção'}
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-white/5">
              <CardContent className="flex items-center gap-3 py-4">
                <Server className="h-8 w-8 text-slate-400" />
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Projeto</div>
                  <div className="text-lg font-semibold text-slate-100">{dados.ambiente.projeto}</div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-white/5">
              <CardContent className="flex items-center gap-3 py-4">
                <Activity className="h-8 w-8 text-slate-400" />
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">Verificado em</div>
                  <div className="text-lg font-semibold text-slate-100">
                    {new Date(dados.verificadoEm).toLocaleTimeString('pt-BR')}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Serviços Firebase */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-200">
                <Database className="h-4 w-4 text-amber-400" /> Serviços Firebase
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {dados.servicos.map((s) => (
                  <div key={s.nome} className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-300">{s.nome}</span>
                      <Indicador ok={s.ok} label={s.ok ? 'OK' : 'Offline'} />
                    </div>
                    <div className="mt-1 text-[10px] text-slate-500">{s.detalhe}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Fontes externas */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-200">
                <Activity className="h-4 w-4 text-amber-400" /> Fontes externas
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-300">SMARAPD</span>
                    <Indicador ok={dados.fontes.smarapd.ok} label={dados.fontes.smarapd.ok ? 'Online' : 'Offline'} />
                  </div>
                  {dados.fontes.smarapd.erro && (
                    <div className="mt-1 text-[10px] text-red-400">{dados.fontes.smarapd.erro}</div>
                  )}
                </div>
                <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-300">SICONFI (STN)</span>
                    <Indicador ok={dados.fontes.siconfi.ok} label={dados.fontes.siconfi.ok ? 'Online' : 'Offline'} />
                  </div>
                  {dados.fontes.siconfi.erro && (
                    <div className="mt-1 text-[10px] text-red-400">{dados.fontes.siconfi.erro}</div>
                  )}
                </div>
                <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-300">PNCP</span>
                    <Indicador ok={dados.fontes.pncp.ok} label={dados.fontes.pncp.ok ? 'Online' : 'Offline'} />
                  </div>
                  {dados.fontes.pncp.erro && (
                    <div className="mt-1 text-[10px] text-red-400">{dados.fontes.pncp.erro}</div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Coleções Firestore */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-200">
                <Database className="h-4 w-4 text-amber-400" /> Coleções monitoradas
              </CardTitle>
            </CardHeader>
            <CardContent>
              {dados.observacao && (
                <div className="mb-3 text-[11px] text-slate-500">{dados.observacao}</div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/5 text-slate-500">
                      <th className="pb-2 pr-4 font-medium uppercase tracking-wide">Coleção</th>
                      <th className="pb-2 pr-4 font-medium uppercase tracking-wide">Documentos</th>
                      <th className="pb-2 font-medium uppercase tracking-wide">Última atualização</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dados.colecoes.map((c) => (
                      <tr key={c.nome} className="border-b border-white/5 last:border-0">
                        <td className="py-2 pr-4 font-medium text-slate-300">{c.nome}</td>
                        <td className="py-2 pr-4 text-slate-400">
                          {c.documentos < 0 ? (
                            <span className="text-red-400">falha na leitura</span>
                          ) : (
                            brl(c.documentos)
                          )}
                        </td>
                        <td className="py-2 text-slate-400">{tempoRelativo(c.ultimaAtualizacao)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
