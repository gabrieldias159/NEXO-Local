'use client';

/** NEXO — subsistema de Obras: contratos de obra/engenharia via PNCP. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HardHat, RefreshCw, TriangleAlert, Scale, Info } from 'lucide-react';
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
import type { ContratosResponse } from '@/app/api/nexo/contratos/route';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';

const EXERCICIOS = [2026, 2025, 2024];

/**
 * Formata o doc de CNPJ (14 dígitos) por extenso — texto que o `EntityText`
 * detecta e transforma em chip investigável. Outros tamanhos → ''.
 */
function cnpjFormatado(doc: string): string {
  const d = (doc ?? '').replace(/\D/g, '');
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return '';
}

/** Identifica contratos de obra/engenharia pelo objeto. */
const OBRA_REGEX =
  /\b(obra|obras|reforma|pavimenta|recape|recapeament|constru|engenharia|drenagem|edifica|asfalt|cal[çc]ament|terraplan|ponte|viaduto|pra[çc]a|tapa.?buraco|saneament)\b/i;

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

export default function ObrasPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<ContratosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    try {
      const res = await nexoFetch(`/api/nexo/contratos?exercicio=${ano}`);
      // 502 = falha de upstream PNCP: o corpo ainda traz o estado de coleta.
      const json = (await res.json()) as ContratosResponse;
      if (!res.ok && !json?.coleta) throw new Error(`HTTP ${res.status}`);
      if (id === reqId.current) {
        setData(json);
        if (!res.ok) setErro(json?.coleta?.erro ?? `HTTP ${res.status}`);
      }
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

  const cnpjAusente = data?.coleta.cnpjAusente === true;
  const falhaUpstream = !!data?.coleta.erro;

  const obras = useMemo(
    () => (data ? data.contratos.filter((c) => OBRA_REGEX.test(c.objeto)) : []),
    [data],
  );
  const valorObras = obras.reduce((s, o) => s + o.valorGlobal, 0);
  const comAditivo = obras.filter(
    (o) => o.valorInicial > 0 && o.valorGlobal > o.valorInicial * 1.25,
  );

  return (
    <EntityProvider>
    <div className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <HardHat className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Obras</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Contratos de obra e engenharia da Prefeitura de Marília (PNCP), com
            destaque para aditivos acima do limite legal de 25%.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => carregar(exercicio)}
          disabled={loading}
          aria-label="Atualizar contratos de obra"
          title="Recarregar os contratos de obra do exercício selecionado"
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <RefreshCw className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} aria-hidden="true" />
          Atualizar
        </Button>
      </div>

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
        <Card className="border-white/5 bg-nexo-surface">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center" role="status" aria-live="polite">
            <RefreshCw className="h-6 w-6 animate-spin text-amber-400" aria-hidden="true" />
            <p className="text-sm text-slate-300">Consultando contratos de obra no PNCP…</p>
          </CardContent>
        </Card>
      ) : cnpjAusente ? (
        <Card className="border-sky-500/20 bg-sky-500/5" role="status">
          <CardContent className="space-y-1 py-6 text-sm text-sky-300">
            <div className="flex items-center gap-3">
              <Info className="h-5 w-5 shrink-0" aria-hidden="true" />
              CNPJ da Prefeitura não configurado.
            </div>
            <p className="pl-8 text-xs text-sky-300/70">
              A consulta de contratos de obra ao PNCP exige o CNPJ do órgão da
              Prefeitura de Marília em{' '}
              <code className="text-sky-200">src/lib/nexo/constants.ts</code>.
              Sem ele, nenhuma obra é coletada — nenhum dado é inventado.
            </p>
          </CardContent>
        </Card>
      ) : erro || falhaUpstream ? (
        <Card className="border-red-500/20 bg-red-500/5" role="alert">
          <CardContent className="space-y-1 py-6 text-sm text-red-300">
            <div className="flex items-center gap-3">
              <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              Não foi possível consultar o PNCP: {data?.coleta.erro ?? erro}
            </div>
            <p className="pl-8 text-xs text-red-300/70">
              O PNCP exige o CNPJ correto do órgão e bloqueia acessos de fora do
              Brasil (HTTP 403). Em produção a consulta funciona. A ausência de
              obras na lista decorre da fonte não ter respondido — não significa
              que não existam obras no exercício.
            </p>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* KPIs */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Kpi rotulo={obras.length === 1 ? 'Contrato de obra' : 'Contratos de obra'} valor={obras.length.toLocaleString('pt-BR')} />
            <Kpi rotulo="Valor global" valor={brl(valorObras)} />
            <Kpi
              rotulo="Com aditivo acima de 25%"
              valor={comAditivo.length.toLocaleString('pt-BR')}
              destaque={comAditivo.length > 0}
            />
          </div>

          {/* Tabela de obras */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="text-base text-slate-200">
                Contratos de obra — {exercicio}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {obras.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
                  Nenhum contrato de obra identificado no PNCP para este exercício.
                </div>
              ) : (
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead className="text-slate-400">Contrato</TableHead>
                      <TableHead className="text-slate-400">Fornecedor</TableHead>
                      <TableHead className="text-slate-400">Objeto</TableHead>
                      <TableHead className="text-right text-slate-400">Inicial</TableHead>
                      <TableHead className="text-right text-slate-400">Global</TableHead>
                      <TableHead className="text-slate-400">Aditivo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {obras.map((o) => {
                      const variacao =
                        o.valorInicial > 0 ? o.valorGlobal / o.valorInicial - 1 : 0;
                      const aditivoAlto = variacao > 0.25;
                      return (
                        <TableRow key={o.id} className="border-white/5 hover:bg-white/5">
                          <TableCell className="font-mono text-xs text-slate-400">
                            {o.numeroContrato || '—'}
                          </TableCell>
                          <TableCell className="max-w-[12rem]">
                            <div className="truncate font-medium text-slate-200" title={o.fornecedorNome}>
                              {o.fornecedorNome || '—'}
                            </div>
                            {cnpjFormatado(o.fornecedorDoc) && (
                              <div className="mt-0.5 text-[11px] text-slate-500">
                                <EntityText>{cnpjFormatado(o.fornecedorDoc)}</EntityText>
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[18rem] truncate text-xs text-slate-500">
                            {o.objeto || '—'}
                          </TableCell>
                          <TableCell className="text-right font-mono text-slate-400">
                            {brl(o.valorInicial)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-slate-300">
                            {brl(o.valorGlobal)}
                          </TableCell>
                          <TableCell>
                            {variacao > 0.001 ? (
                              <Badge
                                variant="outline"
                                className={
                                  aditivoAlto
                                    ? 'border-red-500/30 bg-red-500/10 text-[10px] text-red-300'
                                    : 'border-white/10 text-[10px] text-slate-400'
                                }
                              >
                                +{Math.round(variacao * 100)}%
                              </Badge>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                </div>
              )}
              <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-400">
                <Scale className="h-3 w-3 shrink-0" aria-hidden="true" />
                Acréscimos acima de 25% sobre o valor inicial extrapolam o limite
                do art. 125 da Lei 14.133/2021 (50% para reforma).
              </p>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
    </EntityProvider>
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
        <div className={'text-xl font-bold ' + (destaque ? 'text-red-300' : 'text-slate-100')}>
          {valor}
        </div>
      </CardContent>
    </Card>
  );
}
