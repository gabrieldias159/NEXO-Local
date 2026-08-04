'use client';

/** NEXO — Dossiês & Requerimentos: empacota indícios + minuta de requerimento. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  FolderOpen,
  RefreshCw,
  TriangleAlert,
  FileText,
  Copy,
  Check,
  ChevronDown,
  FileSearch,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { AlertasResponse } from '@/app/api/nexo/alertas/route';
import type { AlertaDetectado } from '@/lib/nexo/detectores';
import { montarDossie, type Dossie } from '@/lib/nexo/dossie';
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

function DossieCard({
  dossie,
  indice,
  onVerDetalhe,
}: {
  dossie: Dossie;
  indice: number;
  onVerDetalhe: () => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const { alerta, modelo, textoRequerimento } = dossie;

  const copiar = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(textoRequerimento);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    } catch {
      /* clipboard indisponível */
    }
  }, [textoRequerimento]);

  return (
    <Card className="border-white/5 bg-nexo-surface">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-slate-500">
            DOSSIÊ {String(indice + 1).padStart(3, '0')}
          </span>
          <Badge variant="outline" className={`text-[10px] uppercase ${CLASS_CLS[alerta.classificacao]}`}>
            {alerta.classificacao}
          </Badge>
          <Badge variant="outline" className="border-white/10 font-mono text-[10px] text-slate-400">
            {alerta.detectorId}
          </Badge>
          {modelo && (
            <Badge variant="outline" className="border-amber-500/20 font-mono text-[10px] text-amber-300/80">
              {modelo.id}
            </Badge>
          )}
          <span className="ml-auto font-mono text-xs text-amber-300">
            {brl(alerta.valorEnvolvido)}
          </span>
        </div>
        <CardTitle className="pt-1 text-sm leading-snug text-slate-200">
          {alerta.titulo}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs leading-relaxed text-slate-400">{alerta.explicacao}</p>

        <button
          type="button"
          onClick={onVerDetalhe}
          className="flex items-center gap-1.5 text-xs font-medium text-slate-400 transition-colors hover:text-amber-300"
        >
          <FileSearch className="h-3.5 w-3.5" />
          Ver indício detalhado — evidências, scores e fundamento
        </button>

        {modelo ? (
          <>
            <button
              onClick={() => setAberto((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-amber-300 hover:text-amber-200"
            >
              <FileText className="h-3.5 w-3.5" />
              Minuta de requerimento ({modelo.id} — {modelo.titulo})
              <ChevronDown
                className={'h-3.5 w-3.5 transition-transform' + (aberto ? ' rotate-180' : '')}
              />
            </button>

            {aberto && (
              <div className="space-y-2">
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-white/5 bg-nexo-chrome p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                  {textoRequerimento}
                </pre>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={copiar}
                    className="h-8 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
                  >
                    {copiado ? (
                      <>
                        <Check className="mr-1.5 h-3.5 w-3.5" /> Copiado
                      </>
                    ) : (
                      <>
                        <Copy className="mr-1.5 h-3.5 w-3.5" /> Copiar minuta
                      </>
                    )}
                  </Button>
                  <Button
                    asChild
                    size="sm"
                    variant="outline"
                    className="h-8 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
                  >
                    <Link href="/requerimentos/novo">Abrir editor de Requerimentos</Link>
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-[11px] text-slate-400">
            Sem modelo de requerimento associado a este detector.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function DossiesPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<AlertasResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    try {
      // Serve do SNAPSHOT (rápido, cap 300) em vez de /analise, que computava
      // todos os detectores AO VIVO sobre o exercício inteiro e estourava o
      // timeout de 90s do cliente ("fonte lenta/indisponível"). O NEXO serve
      // snapshot, nunca computa live no request.
      const res = await nexoFetch(`/api/nexo/alertas?exercicio=${ano}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as AlertasResponse;
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

  const dossies = useMemo(
    () => (data ? data.alertas.map((a) => montarDossie(a)) : []),
    [data],
  );

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5 text-amber-400" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Dossiês &amp; Requerimentos
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Cada indício empacotado com uma minuta de requerimento de
            informação pronta para o gabinete adaptar e protocolar.
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
            <p className="text-sm text-slate-300">Montando dossiês…</p>
          </CardContent>
        </Card>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5">
          <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
            <TriangleAlert className="h-5 w-5" />
            Não foi possível montar os dossiês: {erro}
          </CardContent>
        </Card>
      ) : dossies.length === 0 ? (
        <div className="rounded-md border border-dashed border-white/10 py-12 text-center text-sm text-slate-500">
          Nenhum indício para empacotar em {exercicio}.
        </div>
      ) : (
        <div className="space-y-4">
          {dossies.map((d, i) => (
            <DossieCard
              key={`${d.alerta.detectorId}-${d.alerta.sujeitoId}-${i}`}
              dossie={d}
              indice={i}
              onVerDetalhe={() => setAlertaSel(d.alerta)}
            />
          ))}
        </div>
      )}

      <AlertaDetalhe alerta={alertaSel} onClose={() => setAlertaSel(null)} />
    </div>
  );
}
