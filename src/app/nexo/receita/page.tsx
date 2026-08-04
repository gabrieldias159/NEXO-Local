'use client';

/** NEXO — subsistema de RECEITA: arrecadação por conta/mês via SMARAPD. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Landmark, RefreshCw, TriangleAlert, ShieldCheck } from 'lucide-react';
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
import type { ReceitaResponse } from '@/app/api/nexo/receita/route';
import type { AlertaDetectado } from '@/lib/nexo/detectores';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { AlertaDetalhe } from '@/components/nexo/alerta-detalhe';

const EXERCICIOS = [2026, 2025, 2024];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
}

const CLASS_CLS: Record<string, string> = {
  critico: 'border-red-500/30 bg-red-500/10 text-red-300',
  suspeita: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  atencao: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  informativo: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
};

const FAMILIA_ROTULO: Record<string, string> = {
  tributaria: 'Tributária',
  transferencia: 'Transferência',
  contribuicao: 'Contribuição',
  patrimonial: 'Patrimonial',
  servicos: 'Serviços',
  'divida-ativa': 'Dívida ativa',
  outras: 'Outras',
};

export default function ReceitaPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<ReceitaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    try {
      const res = await nexoFetch(`/api/nexo/receita?exercicio=${ano}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ReceitaResponse;
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
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Receita &amp; Renúncia
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Arrecadação da Prefeitura de Marília por conta/mês, com detecção de
            queda atípica de tributo, rubrica orçada sem realização e
            transferência abaixo do previsto.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => carregar(exercicio)}
          disabled={loading}
          aria-label="Atualizar a receita do exercício selecionado"
          title="Recarregar a receita do exercício selecionado"
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

      {loading ? (
        <Card className="border-white/5 bg-nexo-surface" role="status" aria-live="polite">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <RefreshCw className="h-6 w-6 animate-spin text-amber-400" aria-hidden="true" />
            <p className="text-sm text-slate-300">Coletando a receita arrecadada…</p>
          </CardContent>
        </Card>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5" role="alert">
          <CardContent className="space-y-1 py-6 text-sm text-red-300">
            <div className="flex items-center gap-3">
              <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              Não foi possível carregar a receita: {erro}
            </div>
            <p className="pl-8 text-xs text-red-300/70">
              Falha na consulta ao Portal da Transparência de Marília. A API
              SMARAPD pode estar indisponível no momento — tente atualizar.
            </p>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* KPIs */}
          <div className="grid gap-4 sm:grid-cols-4">
            <Kpi rotulo="Rubricas" valor={data.resumo.totalRubricas.toLocaleString('pt-BR')} />
            <Kpi rotulo="Previsto (LOA)" valor={brl(data.resumo.totalPrevisto)} />
            <Kpi rotulo="Arrecadado" valor={brl(data.resumo.totalArrecadado)} />
            <Kpi
              rotulo="Realização (vs LOA)"
              valor={data.resumo.realizacaoPct == null ? '—' : `${data.resumo.realizacaoPct}%`}
              destaque
            />
          </div>

          {/* Banner de coleta */}
          <div
            role="status"
            aria-label="Resumo da coleta de receita"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500"
          >
            <span>
              {data.coleta.registros.toLocaleString('pt-BR')}{' '}
              {data.coleta.registros === 1 ? 'registro' : 'registros'} conta/mês
            </span>
            <span>·</span>
            <span>
              {data.resumo.alertas.toLocaleString('pt-BR')}{' '}
              {data.resumo.alertas === 1 ? 'alerta RC' : 'alertas RC'}
            </span>
            {data.coleta.erro && (
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300"
              >
                coleta parcial
              </Badge>
            )}
          </div>

          {/* Alertas RC */}
          {data.alertas.length > 0 && (
            <div className="space-y-3">
              {data.alertas.map((a, i) => (
                <Card
                  key={`${a.detectorId}-${a.sujeitoId}-${i}`}
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
                      <Badge
                        variant="outline"
                        className={`text-[10px] uppercase ${CLASS_CLS[a.classificacao]}`}
                      >
                        {a.classificacao}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="border-white/10 font-mono text-[10px] text-slate-400"
                      >
                        {a.detectorId}
                      </Badge>
                      <span className="text-sm font-medium text-slate-200">{a.titulo}</span>
                      {a.valorEnvolvido > 0 && (
                        <span className="ml-auto font-mono text-xs text-amber-300">
                          {brl(a.valorEnvolvido)}
                        </span>
                      )}
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
                    <p className="text-[11px] italic text-slate-400">{a.explicacao}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Tabela de rubricas */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="text-base text-slate-200">
                Receita por rubrica — {exercicio}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.rubricas.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
                  O Portal da Transparência de Marília não retornou receita por
                  conta/mês para {exercicio}. O módulo `balancetereceita` do
                  portal foi disponibilizado em 2026 — exercícios anteriores
                  costumam voltar vazios.
                </div>
              ) : (
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead className="text-slate-400">Conta</TableHead>
                      <TableHead className="text-slate-400">Descrição</TableHead>
                      <TableHead className="text-slate-400">Família</TableHead>
                      <TableHead className="text-right text-slate-400">Previsto</TableHead>
                      <TableHead className="text-right text-slate-400">Arrecadado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rubricas.map((r, i) => (
                      <TableRow
                        key={`${r.conta}-${i}`}
                        className="border-white/5 hover:bg-white/5"
                      >
                        <TableCell className="font-mono text-xs text-slate-400">
                          {r.conta || '—'}
                        </TableCell>
                        <TableCell
                          className="max-w-[20rem] truncate font-medium text-slate-200"
                          title={r.descricao || undefined}
                        >
                          {r.descricao || '—'}
                        </TableCell>
                        <TableCell className="text-xs text-slate-500">
                          {FAMILIA_ROTULO[r.familia] ?? r.familia}
                        </TableCell>
                        <TableCell className="text-right font-mono text-slate-400">
                          {brl(r.previsto)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-slate-300">
                          {brl(r.arrecadado)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              )}
              <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-400">
                <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
                Dado de origem pública (LAI). Alertas são indícios a apurar, não
                acusações.
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
