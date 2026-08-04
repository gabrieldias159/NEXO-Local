'use client';

/** NEXO — Perfil de fornecedor: dados cadastrais enriquecidos + flags. */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { mascararDoc, soDigitos } from '@/lib/nexo/normalizar';
import {
  Building2,
  ChevronLeft,
  ExternalLink,
  RefreshCw,
  TriangleAlert,
  Users,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { FornecedorResponse } from '@/app/api/nexo/fornecedor/[cnpj]/route';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { CampanhasDoFornecedor } from '@/components/nexo/fornecedores/CampanhasDoFornecedor';

/** Mesma normalização usada nos personId das fichas de pessoa ('n:'+NOME). */
function personIdDe(nome: string): string {
  return (
    'n:' +
    nome
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .trim()
  );
}

function fmtData(iso: string | null): string {
  if (!iso) return '—';
  const m = iso.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** CNPJ (14 dígitos) com máscara legível; outros tamanhos caem no mascararDoc. */
function fmtCnpj(d: string): string {
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return mascararDoc(d);
}

const NIVEL_CLS: Record<string, string> = {
  atencao: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  suspeita: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  critico: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const NIVEL_ROTULO: Record<string, string> = {
  atencao: 'Atenção',
  suspeita: 'Suspeita',
  critico: 'Crítico',
};

function Campo({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{rotulo}</p>
      <p className="break-words text-sm text-slate-200">{valor}</p>
    </div>
  );
}

export default function FornecedorPerfilPage() {
  const params = useParams<{ cnpj: string }>();
  const cnpj = soDigitos(params?.cnpj ?? '');
  const [data, setData] = useState<FornecedorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // índice de doadores (personId -> acumulado) p/ marcar sócios que doaram
  const [doadores, setDoadores] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let vivo = true;
    fetch('/eleicoes/doadores.json')
      .then((r) => (r.ok ? r.json() : { doadores: [] }))
      .then((j) => {
        if (!vivo) return;
        const m = new Map<string, number>();
        for (const d of j.doadores ?? [])
          if (d.personId) m.set(d.personId as string, d.acumulado as number);
        setDoadores(m);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);

  const reqId = useRef(0);
  const carregar = useCallback(() => {
    const id = ++reqId.current;
    setLoading(true);
    nexoFetch(`/api/nexo/fornecedor/${cnpj}`)
      .then((r) => r.json())
      .then((j: FornecedorResponse) => {
        if (id === reqId.current) setData(j);
      })
      .catch(() => {
        if (id === reqId.current) setData(null);
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false);
      });
  }, [cnpj]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const info = data?.info ?? null;

  return (
    <div className="space-y-6">
      <Link
        href="/nexo/fornecedores"
        className="inline-flex items-center gap-1 rounded text-xs text-slate-500 transition-colors hover:text-amber-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Voltar ao ranking de fornecedores
      </Link>

      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
            <h1 className="break-words text-2xl font-bold tracking-tight text-slate-100">
              {loading ? 'Carregando perfil…' : info?.razaoSocial || 'Fornecedor'}
            </h1>
          </div>
          <p className="mt-1 font-mono text-sm text-slate-500">
            <span className="font-sans text-[11px] uppercase tracking-wide text-slate-400">CNPJ </span>
            {fmtCnpj(cnpj)}
          </p>
          {!loading && info?.nomeFantasia && (
            <p className="mt-0.5 text-sm text-slate-400">Nome fantasia: {info.nomeFantasia}</p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={carregar}
          disabled={loading}
          aria-label="Atualizar dados do fornecedor"
          title="Reconsultar dados cadastrais e sanções deste CNPJ"
          className="shrink-0 self-start border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <RefreshCw className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} aria-hidden="true" />
          Atualizar
        </Button>
      </div>

      {/* Cruzamento com fornecedores de campanha eleitoral (TSE) */}
      {cnpj.length === 14 && <CampanhasDoFornecedor cnpj={cnpj} />}

      {loading ? (
        <div className="space-y-3" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Carregando perfil do fornecedor…</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : !info ? (
        <Card className="border-red-500/20 bg-red-500/5" role="alert">
          <CardContent className="flex flex-col gap-3 py-6 text-sm text-red-300 sm:flex-row sm:items-center">
            <div className="flex items-start gap-3">
              <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span>{data?.erro ?? 'Não foi possível enriquecer este CNPJ.'}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={carregar}
              className="shrink-0 border-red-500/30 bg-transparent text-red-200 hover:bg-red-500/10 sm:ml-auto"
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Flags de risco — indícios a apurar, nunca acusação */}
          {data && data.flags.length > 0 && (
            <section aria-label="Indícios a apurar" className="space-y-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">
                Indícios a apurar ({data.flags.length})
              </p>
              {data.flags.map((f) => (
                <div
                  key={f.tipo}
                  className={`rounded-md border p-3 ${NIVEL_CLS[f.nivel] ?? NIVEL_CLS.atencao}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <p className="text-sm font-medium">{f.titulo}</p>
                    <Badge
                      variant="outline"
                      className={`ml-auto text-[10px] ${NIVEL_CLS[f.nivel] ?? NIVEL_CLS.atencao}`}
                    >
                      {NIVEL_ROTULO[f.nivel] ?? f.nivel}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs opacity-80">{f.descricao}</p>
                </div>
              ))}
            </section>
          )}

          {/* Dados cadastrais */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="text-base text-slate-200">Dados cadastrais</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Campo rotulo="Situação cadastral" valor={info.situacaoCadastral || '—'} />
              <Campo rotulo="Abertura" valor={fmtData(info.dataAbertura)} />
              <Campo
                rotulo="Sede"
                valor={info.municipio ? `${info.municipio}/${info.uf ?? '—'}` : info.uf ?? '—'}
              />
              <Campo rotulo="CNAE principal" valor={info.cnaePrincipal ?? '—'} />
              <Campo
                rotulo="Capital social"
                valor={
                  info.capitalSocial != null
                    ? info.capitalSocial.toLocaleString('pt-BR', {
                        style: 'currency',
                        currency: 'BRL',
                        maximumFractionDigits: 0,
                      })
                    : '—'
                }
              />
              <Campo rotulo="Nome fantasia" valor={info.nomeFantasia ?? '—'} />
              {info.cnaeDescricao && (
                <div className="col-span-2 sm:col-span-3">
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">
                    Atividade
                  </p>
                  <p className="text-sm text-slate-300">{info.cnaeDescricao}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Sócios */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                <Users className="h-4 w-4 text-amber-400" aria-hidden="true" />
                Quadro societário
                <span className="text-sm font-normal text-slate-500">
                  ({info.socios.length} {info.socios.length === 1 ? 'sócio' : 'sócios'})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {info.socios.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Sem sócios informados na base cadastral (BrasilAPI/minhareceita).
                </p>
              ) : (
                <ul className="divide-y divide-white/5">
                  {info.socios.map((s, i) => {
                    const pid = personIdDe(s.nome);
                    const doou = doadores.get(pid);
                    return (
                      <li
                        key={i}
                        className="flex flex-col gap-0.5 py-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                      >
                        <span className="min-w-0">
                          <Link
                            href={`/nexo/pessoa/${encodeURIComponent(pid)}`}
                            className="break-words text-slate-200 underline-offset-2 hover:text-amber-300 hover:underline"
                            title="Abrir ficha completa da pessoa"
                          >
                            {s.nome}
                          </Link>
                          {doou != null && (
                            <span className="ml-2 rounded bg-rose-500/15 px-1.5 py-px text-[11px] text-rose-300">
                              doador de campanha ·{' '}
                              {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(doou)}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs text-slate-500">{s.qualificacao || '—'}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Sanções — detalhe do nexo_sancoes (qual/onde/fonte/quando) */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden="true" />
                Sanções (inidoneidade)
              </CardTitle>
              <p className="mt-1 text-xs text-slate-500">
                Cadastros federais de empresas inidôneas e suspensas — CEIS, CNEP e CEPIM (CGU).
              </p>
            </CardHeader>
            <CardContent>
              {data?.sancoesDetalhe && data.sancoesDetalhe.registros.length > 0 ? (
                (() => {
                  const sd = data.sancoesDetalhe!;
                  const cadastros =
                    sd.cadastros.length > 0
                      ? sd.cadastros
                      : ['CEIS/CNEP'];
                  const rotuloCadastros =
                    cadastros.length === 1
                      ? cadastros[0]
                      : cadastros.slice(0, -1).join(', ') + ' e ' + cadastros[cadastros.length - 1];
                  const urlTransparencia = `https://portaldatransparencia.gov.br/sancoes/consulta?cpfCnpj=${cnpj}`;
                  return (
                    <div className="space-y-3">
                      {/* Callout CRÍTICO */}
                      <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3">
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
                          <span className="text-[11px] font-bold uppercase tracking-wide text-red-300">
                            Crítico — Inidoneidade Federal
                          </span>
                          <a
                            href={urlTransparencia}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-red-300/80 underline decoration-red-500/30 decoration-dotted underline-offset-2 transition-colors hover:text-red-200"
                          >
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            Ver no Portal da Transparência
                          </a>
                        </div>
                        <p className="text-sm font-semibold leading-snug text-red-200">
                          Consta em {rotuloCadastros} — impedida de contratar com a
                          administração pública. Pagamento a empresa inidonea é irregularidade
                          grave.
                        </p>
                        <p className="mt-1.5 text-[11px] leading-relaxed text-red-300/70">
                          Indício a apurar — verifique abrangência exata (matriz/filiais) e
                          eventual suspensão judicial da sanção antes de qualquer conclusão.
                        </p>
                      </div>

                      {/* Lista detalhada de registros */}
                      <ul className="space-y-2">
                        {sd.registros.map((s, i) => (
                          <li key={i} className="rounded-md border border-red-500/20 bg-red-500/[0.04] p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge
                                variant="outline"
                                className="border-red-500/30 bg-red-500/10 text-[10px] text-red-300"
                                title="Cadastro de origem da sanção"
                              >
                                {s.cadastro || 'Cadastro'}
                              </Badge>
                              <span className="text-sm font-medium text-slate-200">{s.tipoSancao || 'Sanção'}</span>
                              <span
                                className="ml-auto whitespace-nowrap text-[11px] text-slate-500"
                                title="Período da sanção (início — fim)"
                              >
                                {fmtData(s.dataInicio)} — {s.dataFim ? fmtData(s.dataFim) : 'vigente'}
                              </span>
                            </div>
                            {s.orgaoSancionador && (
                              <p className="mt-1 break-words text-xs text-slate-400">
                                <span className="text-slate-500">Órgão sancionador:</span> {s.orgaoSancionador}
                              </p>
                            )}
                            {s.fundamentacao && (
                              <p className="mt-1 break-words text-xs text-slate-500">
                                <span className="text-slate-400">Fundamentação:</span> {s.fundamentacao}
                              </p>
                            )}
                            {/* Link de fonte por item */}
                            <a
                              href={urlTransparencia}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-amber-400/70 underline decoration-amber-500/20 decoration-dotted underline-offset-2 transition-colors hover:text-amber-300"
                            >
                              <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                              Fonte: {sd.fonte || 'Portal da Transparência'}
                            </a>
                          </li>
                        ))}
                      </ul>
                      <p className="text-[11px] text-slate-400">
                        Coletado em {fmtData(sd.verificadoEm)}.
                      </p>
                    </div>
                  );
                })()
              ) : data?.sancoesDetalhe && !data.sancoesDetalhe.sancionado ? (
                <div className="space-y-1">
                  <p className="flex items-center gap-2 text-sm text-slate-300">
                    <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
                    Verificado nos cadastros federais (CEIS/CNEP/CEPIM): não consta.
                  </p>
                  {data.sancoesDetalhe.verificadoEm && (
                    <p className="pl-7 text-[11px] text-slate-400">
                      Coletado em {fmtData(data.sancoesDetalhe.verificadoEm)}.
                    </p>
                  )}
                </div>
              ) : data?.sancoes.verificado ? (
                data.sancoes.ceis + data.sancoes.cnep > 0 ? (
                  (() => {
                    const ceisParts = data.sancoes.ceis > 0 ? [`${data.sancoes.ceis} registro${data.sancoes.ceis === 1 ? '' : 's'} no CEIS`] : [];
                    const cnepParts = data.sancoes.cnep > 0 ? [`${data.sancoes.cnep} registro${data.sancoes.cnep === 1 ? '' : 's'} no CNEP`] : [];
                    const partes = [...ceisParts, ...cnepParts];
                    const rotuloCadastrosFallback = [
                      ...(data.sancoes.ceis > 0 ? ['CEIS'] : []),
                      ...(data.sancoes.cnep > 0 ? ['CNEP'] : []),
                    ];
                    const rotuloCadastros =
                      rotuloCadastrosFallback.length === 1
                        ? rotuloCadastrosFallback[0]
                        : rotuloCadastrosFallback.join(' e ');
                    const urlTransparencia = `https://portaldatransparencia.gov.br/sancoes/consulta?cpfCnpj=${cnpj}`;
                    return (
                      <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3">
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
                          <span className="text-[11px] font-bold uppercase tracking-wide text-red-300">
                            Crítico — Inidoneidade Federal
                          </span>
                          <a
                            href={urlTransparencia}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-red-300/80 underline decoration-red-500/30 decoration-dotted underline-offset-2 transition-colors hover:text-red-200"
                          >
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            Ver no Portal da Transparência
                          </a>
                        </div>
                        <p className="text-sm font-semibold leading-snug text-red-200">
                          Consta em {rotuloCadastros} — impedida de contratar com a
                          administração pública. Pagamento a empresa inidonea é irregularidade
                          grave.
                        </p>
                        <p className="mt-1 text-[11px] text-red-300/70">
                          {partes.join(' e ')}. Indício a apurar — verifique abrangência e
                          eventual suspensão judicial.
                        </p>
                      </div>
                    );
                  })()
                ) : (
                  <p className="flex items-center gap-2 text-sm text-slate-300">
                    <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
                    Não consta em CEIS/CNEP.
                  </p>
                )
              ) : (
                <p className="flex items-start gap-2 text-sm text-slate-500">
                  <RefreshCw className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                  <span>
                    Sanções ainda não coletadas para este CNPJ (cron CGU) — sem indício de
                    inidoneidade verificado.
                  </span>
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
