'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Gauge, Search, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { AREAS_MONITORAMENTO } from '@/lib/nexo/catalogo';

export default function CatalogoDetectoresPage() {
  const [busca, setBusca] = useState('');

  const filtro = busca.toLowerCase().trim();
  const areas = filtro
    ? AREAS_MONITORAMENTO.map((area) => ({
        ...area,
        ativos: area.ativos.filter(
          (d) =>
            d.id.toLowerCase().includes(filtro) ||
            d.nome.toLowerCase().includes(filtro),
        ),
      })).filter((a) => a.ativos.length > 0)
    : AREAS_MONITORAMENTO;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-amber-400" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Catálogo de Detectores
            </h1>
            <Badge variant="outline" className="border-white/10 text-xs text-slate-400">
              {AREAS_MONITORAMENTO.reduce((s, a) => s + a.ativos.length, 0)} ativos
            </Badge>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            {AREAS_MONITORAMENTO.length} áreas de monitoramento — clique em um detector para ver detalhes.
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar detector..."
            className="border-white/10 bg-nexo-chrome pl-8 text-sm text-slate-200 placeholder:text-slate-500"
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {areas.map((area) => (
          <Card key={area.prefixo} className="border-white/5 bg-nexo-surface">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-sm text-slate-200">
                <span>{area.prefixo} — {area.nome}</span>
                <Badge variant="outline" className="border-white/10 text-[10px] text-slate-500">
                  {area.ativos.length}/{area.planejado}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {area.ativos.length === 0 ? (
                <p className="text-xs text-slate-500">Nenhum detector ativo</p>
              ) : (
                area.ativos.map((det) => (
                  <Link
                    key={det.id}
                    href={`/nexo/detectores/${det.id.toLowerCase()}`}
                    className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-white/5"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="outline" className="border-amber-500/20 font-mono text-[10px] text-amber-300 shrink-0">
                        {det.id}
                      </Badge>
                      <span className="truncate text-slate-300">{det.nome}</span>
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                  </Link>
                ))
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
