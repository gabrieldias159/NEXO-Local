'use client';

/** NEXO — subsistema de Folha & Terceirizados. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Users, RefreshCw, TriangleAlert, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { FolhaResponse } from '@/app/api/nexo/folha/route';
import type { AlertaDetectado } from '@/lib/nexo/detectores';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { AlertaDetalhe } from '@/components/nexo/alerta-detalhe';

const EXERCICIOS = [2026, 2025, 2024];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

const CLASS_CLS: Record<string, string> = {
  critico: 'border-red-500/30 bg-red-500/10 text-red-300',
  suspeita: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  atencao: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  informativo: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
};

export default function FolhaPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<FolhaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    try {
      const res = await nexoFetch(`/api/nexo/folha?exercicio=${ano}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as FolhaResponse;
      if (id === reqId.current) setData(json);
    } catch (err) {
      if (id === reqId.current) {
        setErro(err instanceof Error ? err.message : 'erro desconhecido');
        setData(null);
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregar(exercicio);
  }, [exercicio, carregar]);

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-amber-400" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Folha &amp; Terceirizados
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Auditoria da folha de pagamento da Prefeitura de Marília. Nomes
            exibidos de forma mascarada, conforme a LGPD. Servidores da{' '}
            <a href="/nexo/servidores-camara" className="text-sky-400 hover:text-sky-300">Câmara</a>{' '}
            ficam em página separada.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => carregar(exercicio)}
          disabled={loading}
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <RefreshCw className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} />
          Atualizar
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-slate-500">Exercício</span>
        {EXERCICIOS.map((ano) => (
          <button
            key={ano}
            onClick={() => setExercicio(ano)}
            className={[
              'rounded-md px-3 py-1 text-sm transition-colors',
              ano === exercicio
                ? 'bg-amber-500/15 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30'
                : 'text-slate-400 hover:bg-white/5',
            ].join(' ')}
          >
            {ano}
          </button>
        ))}
      </div>

      {loading ? (
        <Card className="border-white/5 bg-nexo-surface">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <RefreshCw className="h-6 w-6 animate-spin text-amber-400" />
            <p className="text-sm text-slate-300">Coletando a folha de pagamento…</p>
          </CardContent>
        </Card>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5">
          <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
            <TriangleAlert className="h-5 w-5" />
            Não foi possível carregar a folha: {erro}
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {data.coleta.erro && data.coleta.registros > 0 && (
            <Card className="border-amber-500/20 bg-amber-500/5">
              <CardContent className="flex items-center gap-3 py-4 text-xs text-amber-300">
                <TriangleAlert className="h-4 w-4 shrink-0" />
                Coleta parcial do Portal da Transparência — os números abaixo
                refletem apenas os registros recebidos. Detalhe: {data.coleta.erro}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Kpi rotulo="Servidores" valor={data.resumo.totalServidores.toLocaleString('pt-BR')} />
            <Kpi rotulo="Folha bruta (mês)" valor={brl(data.resumo.folhaBruta)} />
            <Kpi rotulo="Alertas" valor={String(data.resumo.alertas)} destaque={data.resumo.alertas > 0} />
          </div>

          {/* Alertas */}
          {data.alertas.length > 0 && (
            <div className="space-y-3">
              {data.alertas.map((a, i) => (
                <Card
                  key={`${a.detectorId}-${i}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setAlertaSel(a)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setAlertaSel(a);
                    }
                  }}
                  className="cursor-pointer border-white/5 bg-nexo-surface transition-colors hover:border-amber-500/20 hover:bg-[#14171f] focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                >
                  <CardContent className="space-y-2 pt-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={`text-[10px] uppercase ${CLASS_CLS[a.classificacao]}`}>
                        {a.classificacao}
                      </Badge>
                      <Badge variant="outline" className="border-white/10 font-mono text-[10px] text-slate-400">
                        {a.detectorId}
                      </Badge>
                      <span className="text-sm font-medium text-slate-200">{a.titulo}</span>
                    </div>
                    <p className="text-xs text-slate-400">{a.descricao}</p>
                    {a.evidencias.length > 0 && (
                      <ul className="space-y-0.5 border-t border-white/5 pt-2">
                        {a.evidencias.slice(0, 8).map((ev, j) => (
                          <li key={j} className="text-[11px] text-slate-500">
                            {ev.resumo}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Top remunerações */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="text-base text-slate-200">
                Maiores remunerações — {exercicio}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.topRemuneracoes.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
                  Nenhum registro de folha retornado para este exercício.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead className="text-slate-400">Servidor</TableHead>
                      <TableHead className="text-slate-400">Cargo</TableHead>
                      <TableHead className="text-slate-400">Lotação</TableHead>
                      <TableHead className="text-right text-slate-400">Bruto</TableHead>
                      <TableHead className="text-right text-slate-400">Líquido</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.topRemuneracoes.map((s, i) => (
                      <TableRow key={s.matricula || i} className="border-white/5 hover:bg-white/5">
                        <TableCell className="font-medium text-slate-200">{s.nome}</TableCell>
                        <TableCell className="max-w-[12rem] truncate text-xs text-slate-400">
                          {s.cargo || '—'}
                        </TableCell>
                        <TableCell className="max-w-[12rem] truncate text-xs text-slate-500">
                          {s.lotacao || '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono text-slate-300">
                          {brl(s.vencimentos)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-slate-400">
                          {brl(s.liquido)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-400">
                <ShieldCheck className="h-3 w-3" />
                Nomes mascarados conforme a LGPD. Dado de origem pública (LAI).
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}

      <AlertaDetalhe alerta={alertaSel} onClose={() => setAlertaSel(null)} />
    </div>
  );
}

function Kpi({
  rotulo,
  valor,
  destaque,
}: {
  rotulo: string;
  valor: string;
  destaque?: boolean;
}) {
  return (
    <Card className="border-white/5 bg-nexo-surface">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-slate-400">{rotulo}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={'text-xl font-bold ' + (destaque ? 'text-amber-300' : 'text-slate-100')}>
          {valor}
        </div>
      </CardContent>
    </Card>
  );
}
