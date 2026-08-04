'use client';

/** NEXO — subsistema de Empresas Sancionadas (migrado do Diário Oficial). */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ShieldAlert,
  Search,
  FileText,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  EmpresasSancionadasResponse,
  EmpresaSancionada,
} from '@/app/api/diario-oficial/empresas-sancionadas/route';
import { nexoFetch } from '@/lib/nexo/client-fetch';

function EmpresaRow({ empresa }: { empresa: EmpresaSancionada }) {
  return (
    <div className="rounded-md border border-white/5 bg-nexo-chrome p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-400">
          <ShieldAlert className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-slate-200">{empresa.empresa}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {empresa.portarias.map((p, i) => (
              <div key={i} className="flex items-center gap-1">
                <Badge variant="outline" className="border-white/10 text-xs text-slate-400">
                  {p.titulo.trim()}
                </Badge>
                {p.pdfUrl && (
                  <a
                    href={p.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Abrir PDF da portaria"
                    className="rounded p-0.5 text-slate-500 hover:text-amber-400"
                  >
                    <FileText className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function NexoEmpresasSancionadasPage() {
  const [data, setData] = useState<EmpresasSancionadasResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const reqId = useRef(0);
  const carregar = useCallback(async (q: string) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    try {
      const url = q
        ? `/api/diario-oficial/empresas-sancionadas?q=${encodeURIComponent(q)}`
        : '/api/diario-oficial/empresas-sancionadas';
      const res = await nexoFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as EmpresasSancionadasResponse;
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
    carregar('');
  }, [carregar]);

  const totalPortarias =
    data?.empresas.reduce((acc, e) => acc + e.portarias.length, 0) ?? 0;

  return (
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-400" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Empresas Sancionadas
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Empresas impedidas de licitar ou contratar com a Prefeitura de
            Marília, conforme portarias publicadas no Diário Oficial.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => carregar(search.trim())}
          disabled={loading}
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <RefreshCw className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} />
          Atualizar
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="border-white/5 bg-nexo-surface">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-slate-400">
              Empresas sancionadas
            </CardTitle>
            <ShieldAlert className="h-4 w-4 text-red-400" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              <div className="text-2xl font-bold text-red-300">{data?.total ?? 0}</div>
            )}
            <p className="text-xs text-slate-500">Impedidas de contratar com o Município</p>
          </CardContent>
        </Card>
        <Card className="border-white/5 bg-nexo-surface">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-slate-400">
              Portarias de sanção
            </CardTitle>
            <FileText className="h-4 w-4 text-amber-400/70" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              <div className="text-2xl font-bold text-slate-100">{totalPortarias}</div>
            )}
            <p className="text-xs text-slate-500">Portarias emitidas no total</p>
          </CardContent>
        </Card>
        <Card className="border-white/5 bg-nexo-surface">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-slate-400">Fonte</CardTitle>
            <Search className="h-4 w-4 text-amber-400/70" />
          </CardHeader>
          <CardContent>
            <div className="text-sm font-medium text-slate-200">Portal Transparência</div>
            <p className="text-xs text-slate-500">Prefeitura Municipal de Marília</p>
          </CardContent>
        </Card>
      </div>

      {/* Busca */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          carregar(search.trim());
        }}
        className="flex gap-2"
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome da empresa ou número de portaria…"
            className="h-10 border-white/10 bg-nexo-chrome pl-9 text-slate-200 placeholder:text-slate-500"
          />
        </div>
        <Button type="submit" disabled={loading}>
          Buscar
        </Button>
      </form>

      {/* Erro */}
      {erro && (
        <Card className="border-red-500/20 bg-red-500/5">
          <CardContent className="flex items-center gap-3 py-5 text-sm text-red-300">
            <TriangleAlert className="h-5 w-5" />
            Não foi possível consultar o Portal da Transparência: {erro}
          </CardContent>
        </Card>
      )}

      {/* Lista */}
      <Card className="border-white/5 bg-nexo-surface">
        <CardHeader>
          <CardTitle className="text-base text-slate-200">
            Lista de empresas impedidas
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : !data || data.empresas.length === 0 ? (
            <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
              {search
                ? `Nenhuma empresa encontrada para "${search}".`
                : 'Nenhuma empresa sancionada no momento.'}
            </div>
          ) : (
            <div className="space-y-3">
              {data.empresas.map((empresa, i) => (
                <EmpresaRow key={i} empresa={empresa} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Link
        href="/diario-oficial/buscar?q=inid%C3%B4nea&tipo=portaria&from=2015-01-01"
        className="inline-flex items-center gap-1 text-xs text-slate-500 transition-colors hover:text-amber-400"
      >
        Buscar portarias de sanção no Diário Oficial indexado →
      </Link>
    </div>
  );
}
