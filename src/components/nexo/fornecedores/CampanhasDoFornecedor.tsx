'use client';

/**
 * Card "Fornecedor de campanha eleitoral (TSE)" — mostra, na página de um CNPJ,
 * se ele prestou serviço a campanhas (cruzamento com `nexo_fornecedores_campanha`).
 * Enquadramento obrigatório: fato lícito e público; vínculo a apurar, nunca
 * acusação (docs/spec-fornecedores-campanha.md §2).
 */
import { useEffect, useState } from 'react';
import { Megaphone, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import type { FornecedorCampanhaResponse } from '@/app/api/nexo/fornecedor-campanha/route';

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

export function CampanhasDoFornecedor({ cnpj }: { cnpj: string }) {
  const [data, setData] = useState<FornecedorCampanhaResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelado = false;
    setLoading(true);
    nexoFetch(`/api/nexo/fornecedor-campanha?cnpj=${encodeURIComponent(cnpj)}`)
      .then((r) => (r.ok ? (r.json() as Promise<FornecedorCampanhaResponse>) : Promise.reject()))
      .then((j) => {
        if (!cancelado) setData(j);
      })
      .catch(() => {
        if (!cancelado) setData(null);
      })
      .finally(() => {
        if (!cancelado) setLoading(false);
      });
    return () => {
      cancelado = true;
    };
  }, [cnpj]);

  if (loading) {
    return (
      <Card className="border-white/5 bg-nexo-chrome">
        <CardContent className="flex items-center gap-2 py-4 text-xs text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cruzando com fornecedores de campanha (TSE)…
        </CardContent>
      </Card>
    );
  }
  if (!data) return null; // falha silenciosa: seção é enriquecimento, não bloqueante

  const tem = data.campanhas.length > 0;
  return (
    <Card className={tem ? 'border-amber-500/20 bg-amber-500/5' : 'border-white/5 bg-nexo-chrome'}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Megaphone className={`h-4 w-4 ${tem ? 'text-amber-400' : 'text-slate-500'}`} />
          <CardTitle className="text-sm font-semibold text-slate-100">
            Fornecedor de campanha eleitoral (TSE)
          </CardTitle>
          {tem && (
            <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-300">
              {data.campanhas.length} campanha(s) · {brl(data.totalGeral)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.ingestao.status === 'pendente' ? (
          <p className="text-xs text-slate-500">
            Base de fornecedores de campanha ainda não coletada — rode o backfill do TSE
            (onNexoBackfillTseDespesasHttp) para habilitar este cruzamento.
          </p>
        ) : !tem ? (
          <p className="text-xs text-slate-500">
            Nenhum registro deste CNPJ como fornecedor de campanha na cobertura atual
            ({data.cobertura}).
          </p>
        ) : (
          <>
            <div className="space-y-1.5">
              {data.campanhas.slice(0, 12).map((c, i) => (
                <div
                  key={`${c.ano}-${c.candidato}-${i}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md border border-white/5 bg-white/[0.02] px-3 py-2"
                >
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-slate-200">{c.candidato}</span>
                    <span className="ml-2 text-[11px] text-slate-400">
                      {[c.partido, c.cargo, c.municipio, c.ano].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <div className="shrink-0 text-right text-xs">
                    <span className="font-semibold text-amber-300">{brl(c.valorTotal)}</span>
                    <span className="ml-1.5 text-[10px] text-slate-500">
                      ({c.nDespesas} despesa{c.nDespesas > 1 ? 's' : ''})
                    </span>
                  </div>
                </div>
              ))}
              {data.campanhas.length > 12 && (
                <p className="text-[11px] text-slate-500">
                  … e mais {data.campanhas.length - 12} campanha(s).
                </p>
              )}
            </div>
            <p className="text-[10px] leading-relaxed text-slate-500">
              Prestar serviço a campanha é ato lícito e público (Lei 9.504/97; dados abertos do
              TSE). A coincidência com fornecimento à Prefeitura é <strong>vínculo a apurar</strong>,
              não indício de irregularidade por si. Cobertura: {data.cobertura}.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
