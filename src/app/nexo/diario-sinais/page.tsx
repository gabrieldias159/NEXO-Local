'use client';

/** NEXO — Sinais do Diário Oficial: edições do DOM de Marília e detectores §11. */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Newspaper,
  RefreshCw,
  TriangleAlert,
  CalendarClock,
  Radar,
} from 'lucide-react';
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
import type { DiarioSinaisResponse } from '@/app/api/nexo/diario-sinais/route';
import type { AlertaDetectado, Classificacao } from '@/lib/nexo/detectores/tipos';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { AlertaDetalhe } from '@/components/nexo/alerta-detalhe';

const EXERCICIOS = [2026, 2025, 2024];

function dataPtBR(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

const CLASSE_BADGE: Record<Classificacao, string> = {
  informativo: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  atencao: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  suspeita: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  critico: 'border-red-500/30 bg-red-500/10 text-red-300',
};

export default function DiarioSinaisPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<DiarioSinaisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    try {
      const res = await nexoFetch(`/api/nexo/diario-sinais?exercicio=${ano}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as DiarioSinaisResponse;
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
            <Newspaper className="h-5 w-5 text-amber-400" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Sinais do Diário Oficial
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Edições do Diário Oficial de Marília (DOM) monitoradas pelos
            detectores do catálogo §11. Os indícios abaixo apontam padrões
            atípicos a apurar — não constituem acusação.
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
            <p className="text-sm text-slate-300">Consultando edições do Diário Oficial…</p>
          </CardContent>
        </Card>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5">
          <CardContent className="space-y-1 py-6 text-sm text-red-300">
            <div className="flex items-center gap-3">
              <TriangleAlert className="h-5 w-5" />
              Não foi possível consultar o Diário Oficial: {erro}
            </div>
            <p className="pl-8 text-xs text-red-300/70">
              A fonte é a API de dados-abertos da Prefeitura de Marília. Tente
              novamente em instantes.
            </p>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* Banner */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500">
            <span>{data.resumo.totalEdicoes.toLocaleString('pt-BR')} edições</span>
            <span>·</span>
            <span>{data.resumo.edicoesExtras} extras</span>
            <span>·</span>
            <span>{data.resumo.edicoesFimDeSemana} em fim de semana</span>
            <span>·</span>
            <span>{data.resumo.alertas} indícios</span>
            {data.coleta.amostra && (
              <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300">
                amostra
              </Badge>
            )}
          </div>

          {/* Cobertura de detectores */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                <Radar className="h-4 w-4 text-amber-400" />
                Cobertura — detectores DO (catálogo §11)
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {data.resumo.detectoresImplementados.map((id) => (
                <Badge
                  key={id}
                  variant="outline"
                  className="border-emerald-500/30 bg-emerald-500/10 text-[11px] text-emerald-300"
                >
                  {id} ativo
                </Badge>
              ))}
              {data.resumo.detectoresPendentes.map((d) => (
                <Badge
                  key={d.id}
                  variant="outline"
                  className="border-white/10 bg-white/5 text-[11px] text-slate-500"
                  title={`${d.nome} — depende de parsing profundo dos atos`}
                >
                  {d.id} pendente
                </Badge>
              ))}
            </CardContent>
          </Card>

          {/* Indícios detectados */}
          {data.alertas.length > 0 && (
            <Card className="border-amber-500/20 bg-nexo-surface">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                  <CalendarClock className="h-4 w-4 text-amber-400" />
                  Indícios no Diário Oficial ({data.alertas.length})
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
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={
                            'text-[10px] uppercase ' +
                            CLASSE_BADGE[a.classificacao]
                          }
                        >
                          {a.classificacao}
                        </Badge>
                        <span className="font-mono text-[10px] text-slate-500">
                          {a.detectorId}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-slate-500">
                        prob. {a.scores.probabilidadeIrregularidade}% · conf.{' '}
                        {a.scores.confiabilidade}%
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm text-slate-200">{a.titulo}</p>
                    <p className="mt-1 text-[11px] text-slate-400">{a.descricao}</p>
                    <p className="mt-1.5 text-[11px] italic text-slate-500">
                      {a.explicacao}
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Edições do exercício */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="text-base text-slate-200">
                Edições do DOM — {exercicio}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.edicoes.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
                  Nenhuma edição retornada para este exercício.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead className="text-slate-400">Edição</TableHead>
                      <TableHead className="text-slate-400">Data</TableHead>
                      <TableHead className="text-slate-400">Tipo</TableHead>
                      <TableHead className="text-right text-slate-400">
                        Volume (caracteres)
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.edicoes.map((e) => (
                      <TableRow key={e.id} className="border-white/5 hover:bg-white/5">
                        <TableCell className="font-mono text-xs text-slate-300">
                          {e.edicao}
                        </TableCell>
                        <TableCell className="text-xs text-slate-400">
                          {dataPtBR(e.dataIso)}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="flex gap-1">
                            {e.edicaoExtra && (
                              <Badge
                                variant="outline"
                                className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300"
                              >
                                extra
                              </Badge>
                            )}
                            {e.fimDeSemana && (
                              <Badge
                                variant="outline"
                                className="border-sky-500/30 bg-sky-500/10 text-[10px] text-sky-300"
                              >
                                fim de semana
                              </Badge>
                            )}
                            {!e.edicaoExtra && !e.fimDeSemana && (
                              <span className="text-slate-400">regular</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-slate-400">
                          {e.textChars.toLocaleString('pt-BR')}
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
