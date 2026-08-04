'use client';

/** NEXO — Convênios & Terceiro Setor: subvenções a OSC e emendas parlamentares. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HeartHandshake, RefreshCw, TriangleAlert, ShieldAlert } from 'lucide-react';
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
import type { ConveniosResponse } from '@/app/api/nexo/convenios/route';
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

function classeBadge(c: string): string {
  switch (c) {
    case 'critico':
      return 'border-red-500/30 bg-red-500/10 text-red-300';
    case 'suspeita':
      return 'border-orange-500/30 bg-orange-500/10 text-orange-300';
    case 'atencao':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
    default:
      return 'border-sky-500/30 bg-sky-500/10 text-sky-300';
  }
}

export default function ConveniosPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<ConveniosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    try {
      const res = await nexoFetch(`/api/nexo/convenios?exercicio=${ano}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ConveniosResponse;
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

  const pctEmendas =
    data && data.resumo.valorEmendasPrevisto > 0
      ? (data.resumo.valorEmendasEmpenhado / data.resumo.valorEmendasPrevisto) * 100
      : null;

  return (
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <HeartHandshake className="h-5 w-5 text-amber-400" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Convênios &amp; Terceiro Setor
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Repasses a OSC/OSS (subvenções, auxílios e contribuições) e emendas
            parlamentares do exercício, com detecção de emenda impositiva sem
            repasse e concentração anormal de parcerias. Indícios a apurar.
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

      {/* Exercício */}
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
            <p className="text-sm text-slate-300">
              Consultando subvenções e emendas no Portal da Transparência…
            </p>
          </CardContent>
        </Card>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5">
          <CardContent className="space-y-1 py-6 text-sm text-red-300">
            <div className="flex items-center gap-3">
              <TriangleAlert className="h-5 w-5" />
              Não foi possível consultar o Portal da Transparência: {erro}
            </div>
            <p className="pl-8 text-xs text-red-300/70">
              A API SMARAPD pode estar indisponível ou os módulos de subvenções/
              emendas não ter dados para o exercício selecionado.
            </p>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* Banner de coleta */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500">
            <span>{data.resumo.totalSubvencoes.toLocaleString('pt-BR')} subvenções</span>
            <span>·</span>
            <span>{brl(data.resumo.valorSubvencoes)} em repasses</span>
            <span>·</span>
            <span>{data.resumo.totalEmendas.toLocaleString('pt-BR')} emendas</span>
            <span>·</span>
            <span>
              emendas {brl(data.resumo.valorEmendasEmpenhado)} /{' '}
              {brl(data.resumo.valorEmendasPrevisto)}
              {pctEmendas !== null && ` (${pctEmendas.toFixed(0)}% empenhado)`}
            </span>
            {data.coleta.erroSubvencoes && (
              <Badge
                variant="outline"
                className="border-red-500/30 bg-red-500/10 text-[10px] text-red-300"
              >
                falha subvenções
              </Badge>
            )}
            {data.coleta.erroEmendas && (
              <Badge
                variant="outline"
                className="border-red-500/30 bg-red-500/10 text-[10px] text-red-300"
              >
                falha emendas
              </Badge>
            )}
          </div>

          {/* Alertas */}
          {data.alertas.length > 0 && (
            <Card className="border-amber-500/20 bg-nexo-surface">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                  <ShieldAlert className="h-4 w-4 text-amber-400" />
                  Indícios detectados ({data.alertas.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.alertas.map((a) => (
                  <div
                    key={`${a.detectorId}-${a.sujeitoId}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setAlertaSel(a)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setAlertaSel(a);
                      }
                    }}
                    className="cursor-pointer rounded-md border border-white/5 bg-nexo-chrome p-3 transition-colors hover:border-amber-500/20 hover:bg-[#14171f] focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={
                            'text-[10px] uppercase ' + classeBadge(a.classificacao)
                          }
                        >
                          {a.classificacao}
                        </Badge>
                        <span className="font-mono text-[10px] text-slate-500">
                          {a.detectorId}
                        </span>
                      </div>
                      <span className="font-mono text-xs text-amber-300">
                        {brl(a.valorEnvolvido)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm text-slate-200">{a.titulo}</p>
                    <p className="mt-1 text-[11px] text-slate-400">{a.descricao}</p>
                    <p className="mt-1.5 text-[11px] text-slate-500">{a.explicacao}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Tabela de subvenções */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="text-base text-slate-200">
                Subvenções e repasses — {exercicio}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.subvencoes.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
                  Nenhuma subvenção retornada pelo portal para este exercício.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead className="text-slate-400">Beneficiário</TableHead>
                      <TableHead className="text-slate-400">Objeto</TableHead>
                      <TableHead className="text-slate-400">Empenho</TableHead>
                      <TableHead className="text-right text-slate-400">Valor</TableHead>
                      <TableHead className="text-right text-slate-400">Pago</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.subvencoes.map((s) => (
                      <TableRow key={s.id} className="border-white/5 hover:bg-white/5">
                        <TableCell className="max-w-[16rem] truncate font-medium text-slate-200">
                          {s.beneficiarioNome || s.beneficiarioDoc || '—'}
                        </TableCell>
                        <TableCell className="max-w-[18rem] truncate text-xs text-slate-500">
                          {s.objeto || '—'}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-slate-400">
                          {s.numeroEmpenho || '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono text-slate-300">
                          {brl(s.valor)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-slate-400">
                          {brl(s.valorPago)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Tabela de emendas */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="text-base text-slate-200">
                Emendas parlamentares — {exercicio}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.emendas.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
                  Nenhuma emenda parlamentar retornada pelo portal para este
                  exercício.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead className="text-slate-400">Emenda</TableHead>
                      <TableHead className="text-slate-400">Autor</TableHead>
                      <TableHead className="text-slate-400">Objeto</TableHead>
                      <TableHead className="text-slate-400">Tipo</TableHead>
                      <TableHead className="text-right text-slate-400">Previsto</TableHead>
                      <TableHead className="text-right text-slate-400">Empenhado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.emendas.map((e) => (
                      <TableRow key={e.id} className="border-white/5 hover:bg-white/5">
                        <TableCell className="font-mono text-xs text-slate-400">
                          {e.numero || '—'}
                        </TableCell>
                        <TableCell className="max-w-[12rem] truncate text-slate-300">
                          {e.autor || '—'}
                        </TableCell>
                        <TableCell className="max-w-[16rem] truncate text-xs text-slate-500">
                          {e.objeto || '—'}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={
                              'text-[10px] uppercase ' +
                              (e.impositiva
                                ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                                : 'border-white/10 bg-transparent text-slate-400')
                            }
                          >
                            {e.impositiva ? 'impositiva' : 'voluntária'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-slate-300">
                          {brl(e.valorPrevisto)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-slate-400">
                          {brl(e.valorEmpenhado)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}

      <AlertaDetalhe alerta={alertaSel} onClose={() => setAlertaSel(null)} />
    </div>
  );
}
