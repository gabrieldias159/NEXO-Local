'use client';

/** NEXO — Fornecedores: ranking por valor empenhado, a partir de dados reais. */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Building2, RefreshCw, TriangleAlert } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { AnaliseResponse } from '@/app/api/nexo/analise/route';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { mascararDoc } from '@/lib/nexo/normalizar';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';

const EXERCICIOS = [2026, 2025, 2024];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

/** "1 empenho" / "12 empenhos" — pluralização humanizada. */
function plural(n: number, singular: string, pluralForma: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? singular : pluralForma}`;
}

/**
 * Formata o doc de CNPJ (14 dígitos) por extenso — texto que o `EntityText`
 * detecta e transforma em chip investigável. CPF (11) é deixado mascarado
 * (a própria minimização do entity-chip cuida do resto). Outros tamanhos → ''.
 */
function cnpjFormatado(doc: string): string {
  const d = (doc ?? '').replace(/\D/g, '');
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return '';
}

export default function FornecedoresPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<AnaliseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    try {
      const res = await nexoFetch(`/api/nexo/analise?exercicio=${ano}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as AnaliseResponse;
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
    <EntityProvider>
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Fornecedores</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Ranking dos fornecedores da Prefeitura de Marília por valor
            empenhado. Perfil completo, enriquecimento de CNPJ e grafo de
            relações entram na Fase 1.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => carregar(exercicio)}
          disabled={loading}
          aria-label="Atualizar ranking de fornecedores"
          title="Recarregar o ranking do exercício selecionado"
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <RefreshCw className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} aria-hidden="true" />
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
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5" role="alert">
          <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
            <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
            Não foi possível carregar os fornecedores: {erro}
          </CardContent>
        </Card>
      ) : data ? (
        <>
          <div
            role="status"
            aria-label="Resumo do exercício selecionado"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500"
          >
            <span>{plural(data.resumo.fornecedoresUnicos, 'fornecedor', 'fornecedores')}</span>
            <span aria-hidden="true">·</span>
            <span>total empenhado <strong className="text-slate-300">{brl(data.resumo.totalEmpenhado)}</strong></span>
            {data.coleta.amostra && (
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300"
                title="Ranking baseado em uma amostra parcial das páginas — números provisórios"
              >
                amostra — {data.coleta.paginasLidas}/{data.coleta.totalPaginas} páginas
              </Badge>
            )}
          </div>

          <Card className="border-white/5 bg-nexo-surface">
            <CardContent className="p-0">
              <div className="border-b border-white/5 px-6 py-4">
                <h2 className="text-base font-medium text-slate-200">
                  Maiores fornecedores — {exercicio}
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Ordenados por valor empenhado. Concentração elevada é indício a
                  apurar, nunca acusação.
                </p>
              </div>
              <div className="overflow-x-auto" aria-busy={loading}>
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead className="w-10 text-slate-400">#</TableHead>
                      <TableHead className="text-slate-400">Fornecedor</TableHead>
                      <TableHead className="text-slate-400">CNPJ/CPF</TableHead>
                      <TableHead className="text-right text-slate-400">Empenhos</TableHead>
                      <TableHead className="text-right text-slate-400">Total</TableHead>
                      <TableHead className="text-right text-slate-400">% do total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.topFornecedores.length === 0 ? (
                      <TableRow className="border-white/5 hover:bg-transparent">
                        <TableCell colSpan={6} className="py-10 text-center text-sm text-slate-500">
                          Sem fornecedores empenhados para {exercicio}.
                        </TableCell>
                      </TableRow>
                    ) : (
                      data.topFornecedores.map((f, i) => (
                        <TableRow key={f.cpfCnpj} className="border-white/5 hover:bg-white/5">
                          <TableCell className="text-slate-500 tabular-nums">{i + 1}</TableCell>
                          <TableCell className="max-w-[18rem] truncate font-medium">
                            <Link
                              href={`/nexo/fornecedores/${f.cpfCnpj}`}
                              title={`Abrir perfil de ${f.nome}`}
                              className="rounded text-slate-200 transition-colors hover:text-amber-300 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                            >
                              {f.nome}
                            </Link>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-slate-400">
                            {cnpjFormatado(f.cpfCnpj) ? (
                              <EntityText>{cnpjFormatado(f.cpfCnpj)}</EntityText>
                            ) : (
                              mascararDoc(f.cpfCnpj)
                            )}
                          </TableCell>
                          <TableCell
                            className="text-right text-slate-400 tabular-nums"
                            title={plural(f.empenhos, 'empenho', 'empenhos')}
                          >
                            {f.empenhos.toLocaleString('pt-BR')}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right font-mono text-slate-300">
                            {brl(f.total)}
                          </TableCell>
                          <TableCell className="text-right">
                            <span
                              className={
                                f.percentual >= 20
                                  ? 'font-mono text-amber-300'
                                  : 'font-mono text-slate-500'
                              }
                              title={
                                f.percentual >= 20
                                  ? 'Concentração elevada do total empenhado — indício a apurar'
                                  : undefined
                              }
                            >
                              {f.percentual.toFixed(1)}%
                            </span>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
    </EntityProvider>
  );
}
