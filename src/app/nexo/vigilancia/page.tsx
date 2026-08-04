'use client';

/**
 * NEXO — VIGILÂNCIA (watchlist).
 *
 * Reúne num só lugar os ALVOS que o usuário escolheu acompanhar (fornecedores,
 * órgãos e processos), agrupados por tipo. Cada item traz o rótulo, um chip
 * investigável (EntityText) quando é um CNPJ de fornecedor, um botão p/ tirar da
 * vigilância e um deep-link para a tela relevante.
 *
 * Os dados vêm do doc por usuário `nexo_watchlist/{uid}`, lido em tempo real com
 * `useDoc` e escrito client-side (helpers de `@/lib/nexo/watchlist`) — otimista,
 * sem round-trip. Mesmo padrão das interações do Acervo Interno.
 *
 * GUARDRAIL LGPD: a watchlist guarda indícios A APURAR sobre dados públicos.
 * CNPJ (PJ, dado público) vira chip pleno; rótulos de pessoa física devem chegar
 * já mascarados (o número cru nunca aparece aqui).
 *
 * CRUD + lista apenas — o "notificar quando mudar" (cron) é fase posterior.
 */
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { type Firestore, doc } from 'firebase/firestore';
import {
  Building2,
  Eye,
  ExternalLink,
  FileText,
  Landmark,
  Loader2,
  TriangleAlert,
  X,
} from 'lucide-react';

import { useDoc, useFirestore, useMemoFirebase, useUser } from '@/firebase';
import {
  definirVigiado,
  derivarVigiados,
  type AlvoTipo,
  type VigiadoDerivado,
  type WatchlistDoc,
} from '@/lib/nexo/watchlist';
import { useToast } from '@/hooks/use-toast';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';
import { Card, CardContent } from '@/components/ui/card';

/** Formata CNPJ (14 dígitos) por extenso — texto que o `EntityText` vira chip. */
function cnpjFormatado(documento: string): string {
  const d = (documento ?? '').replace(/\D/g, '');
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return '';
}

/** Data ISO → DD/MM/AAAA (padrão das telas do NEXO); '' se não parseável. */
function dataBR(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Metadados de apresentação por tipo de alvo. */
const TIPOS: { tipo: AlvoTipo; titulo: string; icone: React.ComponentType<{ className?: string }> }[] = [
  { tipo: 'fornecedor', titulo: 'Fornecedores', icone: Building2 },
  { tipo: 'orgao', titulo: 'Órgãos', icone: Landmark },
  { tipo: 'processo', titulo: 'Processos', icone: FileText },
];

/** Deep-link para a tela relevante conforme o tipo do alvo. */
function linkDoAlvo(it: VigiadoDerivado): string | null {
  switch (it.alvoTipo) {
    case 'fornecedor':
      return `/nexo/fornecedores/${(it.alvoId ?? '').replace(/\D/g, '')}`;
    case 'orgao':
      return `/nexo/empenhos?orgao=${encodeURIComponent(it.alvoId)}`;
    case 'processo':
      return `/nexo/empenhos?processo=${encodeURIComponent(it.alvoId)}`;
    default:
      return null;
  }
}

export default function VigilanciaPage() {
  const { user } = useUser();
  const firestore = useFirestore() as Firestore;
  const uid = user?.uid ?? null;

  const watchRef = useMemoFirebase(() => {
    if (!firestore || !uid) return null;
    return doc(firestore, 'nexo_watchlist', uid);
  }, [firestore, uid]);
  const { data: watchDoc, isLoading, error } = useDoc(watchRef);

  const vigiadosServidor = useMemo(
    () => derivarVigiados(watchDoc as WatchlistDoc | null | undefined),
    [watchDoc],
  );

  // Remoção otimista: some da lista NA HORA; reaparece se o write falhar.
  const [removidos, setRemovidos] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  const vigiados = useMemo(
    () => vigiadosServidor.filter((v) => !removidos.has(v.chave)),
    [vigiadosServidor, removidos],
  );

  const aoRemover = useCallback(
    (it: VigiadoDerivado) => {
      if (!firestore || !uid) return;
      setRemovidos((s) => new Set(s).add(it.chave));
      definirVigiado(firestore, uid, it, false).catch(() => {
        toast({ title: 'Não foi possível remover o alvo', variant: 'destructive' });
        setRemovidos((s) => {
          const n = new Set(s);
          n.delete(it.chave);
          return n;
        });
      });
    },
    [firestore, uid, toast],
  );

  // Agrupa por tipo, preservando a ordem cronológica desc de `derivarVigiados`.
  const porTipo = useMemo(() => {
    const m = new Map<AlvoTipo, VigiadoDerivado[]>();
    for (const v of vigiados) {
      const arr = m.get(v.alvoTipo) ?? [];
      arr.push(v);
      m.set(v.alvoTipo, arr);
    }
    return m;
  }, [vigiados]);

  const total = vigiados.length;

  return (
    <EntityProvider>
      <div className="space-y-6">
        {/* Cabeçalho */}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Eye className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Vigilância</h1>
            {total > 0 && (
              <span
                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30"
                aria-label={`${total} ${total === 1 ? 'alvo' : 'alvos'} em vigilância`}
              >
                {total} {total === 1 ? 'alvo' : 'alvos'}
              </span>
            )}
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Seus alvos em acompanhamento — fornecedores, órgãos e processos que
            você escolheu seguir. Cada item é um{' '}
            <span className="text-slate-300">indício a apurar</span>, nunca uma
            acusação.
          </p>
        </div>

        {isLoading && vigiadosServidor.length === 0 ? (
          <div
            className="flex items-center gap-2 py-12 text-sm text-slate-500"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-4 w-4 animate-spin text-amber-400/80" aria-hidden="true" />
            Carregando sua vigilância…
          </div>
        ) : error && vigiadosServidor.length === 0 ? (
          <Card className="border-red-500/20 bg-red-500/5" role="alert">
            <CardContent className="flex items-start gap-3 py-6 text-sm text-red-300">
              <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-medium">Não foi possível carregar sua vigilância.</p>
                <p className="mt-1 text-red-300/80">
                  Tente recarregar a página. Se persistir, verifique sua conexão e
                  se você está autenticado.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : total === 0 ? (
          <Card className="border-white/10 bg-nexo-chrome">
            <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <Eye className="h-10 w-10 text-slate-400" aria-hidden="true" />
              <div>
                <p className="font-medium text-slate-300">Nenhum alvo em vigilância.</p>
                <p className="mt-1 max-w-md text-sm text-slate-500">
                  Adicione alvos pela lupa nas telas (Empenhos, Fornecedores,
                  Processos…) para reuni-los aqui.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {TIPOS.map(({ tipo, titulo, icone: Icone }) => {
              const itens = porTipo.get(tipo);
              if (!itens || itens.length === 0) return null;
              return (
                <section key={tipo} className="space-y-2" aria-label={titulo}>
                  <h2 className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
                    <Icone className="h-4 w-4 text-slate-400" aria-hidden="true" />
                    <span>{titulo}</span>
                    <span className="text-slate-400" aria-hidden="true">({itens.length})</span>
                  </h2>
                  <div className="overflow-hidden rounded-md border border-white/5 bg-nexo-chrome">
                    <ul className="divide-y divide-white/5">
                      {itens.map((it) => (
                        <ItemLinha key={it.chave} item={it} onRemover={aoRemover} />
                      ))}
                    </ul>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </EntityProvider>
  );
}

/** Uma linha da watchlist — rótulo, chip (fornecedor CNPJ), link e remover. */
function ItemLinha({
  item,
  onRemover,
}: {
  item: VigiadoDerivado;
  onRemover: (it: VigiadoDerivado) => void;
}) {
  const href = linkDoAlvo(item);
  const cnpjFmt = item.alvoTipo === 'fornecedor' ? cnpjFormatado(item.alvoId) : '';
  const rotulo = item.rotulo || item.alvoId || '—';
  const desde = dataBR(item.criadoEm);

  return (
    <li className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-slate-200" title={rotulo}>
          {rotulo}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
          {cnpjFmt && <EntityText>{cnpjFmt}</EntityText>}
          {desde && (
            <span title={`Adicionado à vigilância em ${desde}`}>
              Em vigilância desde {desde}
            </span>
          )}
        </div>
      </div>

      {href && (
        <Link
          href={href}
          aria-label={`Abrir ${rotulo}`}
          title={`Abrir ${rotulo}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded text-xs font-medium text-amber-400 transition-colors hover:text-amber-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          Abrir
        </Link>
      )}

      <button
        type="button"
        onClick={() => onRemover(item)}
        title={`Remover ${rotulo} da vigilância`}
        aria-label={`Remover ${rotulo} da vigilância`}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </li>
  );
}
