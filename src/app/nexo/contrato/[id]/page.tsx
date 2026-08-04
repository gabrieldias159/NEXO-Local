'use client';

/**
 * NEXO — FICHA DE EXECUÇÃO DE UM CONTRATO ("TUDO LINKADO").
 *
 * Dado um contrato (docId de nexo_contratos_municipais, ex.: 2026-100), mostra a
 * CADEIA cruzada da contratação: Identificação, Origem (edital/licitação/
 * dispensa), Execução Financeira (contratado × empenhado × pago, % e estouro),
 * Aditivos, Medições e Vínculos. Dados via /api/nexo/contrato/[id].
 *
 * Honestidade radical: o casamento contrato↔empenho é por nº de processo + ano —
 * INDÍCIO A APURAR (o nº de processo dos Dados Abertos é de baixa cardinalidade e
 * pode super-coletar). Aditivos NÃO coletados ainda; medições NÃO publicadas.
 * Cada seção degrada sozinha; nada é inventado.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  Building2,
  ChevronLeft,
  ExternalLink,
  FileText,
  Gavel,
  Layers,
  Link2,
  Ruler,
  RefreshCw,
  ScrollText,
  TriangleAlert,
  Wallet,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import type {
  ContratoFichaResponse,
  EmpenhoExec,
  OrigemLicitacao,
  VinculoContrato,
} from '@/app/api/nexo/contrato/[id]/route';

// ── Formatação ────────────────────────────────────────────────────────────────

function brl(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });
}
function dataBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
function pct(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}
/** CNPJ (14)/CPF (11) por extenso — texto que o EntityText vira chip. */
function docFormatado(doc: string | null | undefined): string {
  const d = (doc ?? '').replace(/\D/g, '');
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  return '';
}

// ── Blocos de UI ────────────────────────────────────────────────────────────

function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{rotulo}</p>
      <div className="mt-0.5 break-words text-sm text-slate-200">{children}</div>
    </div>
  );
}

function Secao({
  icone: Icone,
  titulo,
  contagem,
  children,
}: {
  icone: typeof FileText;
  titulo: string;
  contagem?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-300">
        <Icone className="h-4 w-4 text-amber-400/80" aria-hidden="true" />
        {titulo}
        {contagem != null && contagem > 0 && (
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-normal text-slate-400">
            {contagem}
          </span>
        )}
      </h2>
      {children}
    </section>
  );
}

function Vazio({ children }: { children: React.ReactNode }) {
  return (
    <Card className="border-white/5 bg-nexo-chrome">
      <CardContent className="py-6 text-center text-sm text-slate-500">{children}</CardContent>
    </Card>
  );
}

/** Barra comparativa contratado × empenhado × pago. */
function BarraExecucao({
  contratado,
  empenhado,
  pago,
}: {
  contratado: number | null;
  empenhado: number;
  pago: number;
}) {
  // Base da barra: o maior entre contratado e empenhado (p/ mostrar estouro).
  const base = Math.max(contratado ?? 0, empenhado, pago, 1);
  const wEmp = Math.min(100, (empenhado / base) * 100);
  const wPago = Math.min(100, (pago / base) * 100);
  const wContr = contratado != null ? Math.min(100, (contratado / base) * 100) : null;
  return (
    <div className="space-y-1.5">
      <div className="relative h-3 w-full overflow-hidden rounded bg-white/5">
        {/* empenhado */}
        <div
          className="absolute inset-y-0 left-0 rounded bg-amber-500/40"
          style={{ width: `${wEmp}%` }}
          aria-hidden="true"
        />
        {/* pago (sobreposto) */}
        <div
          className="absolute inset-y-0 left-0 rounded bg-emerald-500/60"
          style={{ width: `${wPago}%` }}
          aria-hidden="true"
        />
        {/* marca do valor contratado */}
        {wContr != null && (
          <div
            className="absolute inset-y-0 w-0.5 bg-slate-200"
            style={{ left: `calc(${wContr}% - 1px)` }}
            title="Valor contratado"
            aria-hidden="true"
          />
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-amber-500/40" /> Empenhado
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500/60" /> Pago
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-slate-200" /> Valor contratado
        </span>
      </div>
    </div>
  );
}

// ── Página ────────────────────────────────────────────────────────────────────

export default function ContratoFichaPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params?.id ?? '');

  const [data, setData] = useState<ContratoFichaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const reqId = useRef(0);

  const carregar = useCallback(() => {
    if (!id) return;
    const req = ++reqId.current;
    setLoading(true);
    setErro(null);
    nexoFetch(`/api/nexo/contrato/${encodeURIComponent(id)}`)
      .then(async (r) => {
        const json = (await r.json()) as ContratoFichaResponse & { erro?: string };
        if (!r.ok && r.status !== 404) throw new Error(json.erro || `HTTP ${r.status}`);
        if (req === reqId.current) setData(json);
      })
      .catch((err) => {
        if (req === reqId.current) {
          setErro(err instanceof Error ? err.message : 'erro desconhecido');
          setData(null);
        }
      })
      .finally(() => {
        if (req === reqId.current) setLoading(false);
      });
  }, [id]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const c = data?.encontrado ? data.contrato : null;
  const ex = data?.execucao;
  const docExt = c?.fornecedorDoc ? docFormatado(c.fornecedorDoc) : '';

  return (
    <EntityProvider>
      <div className="space-y-6">
        <Link
          href="/nexo/grafo"
          className="inline-flex items-center gap-1 rounded text-xs text-slate-500 transition-colors hover:text-amber-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Voltar ao NEXO
        </Link>

        {/* Cabeçalho */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
              <h1 className="break-words text-2xl font-bold tracking-tight text-slate-100">
                {loading && !data
                  ? 'Carregando contrato…'
                  : c
                    ? `Contrato ${c.numeroContrato || c.id}${c.exercicio ? `/${c.exercicio}` : ''}`
                    : 'Contrato'}
              </h1>
            </div>
            {c && (
              <p className="mt-1 text-sm text-slate-400">
                {c.fornecedorNome || 'Contratada não informada'}
                {c.numeroProcesso ? ` · proc. ${c.numeroProcesso}` : ''}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={carregar}
            disabled={loading}
            aria-label="Recarregar a ficha do contrato"
            title="Reconsultar o contrato, a execução e os vínculos"
            className="shrink-0 self-start border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
          >
            <RefreshCw className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} aria-hidden="true" />
            Atualizar
          </Button>
        </div>

        {/* Estados */}
        {loading && !data ? (
          <div className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : erro ? (
          <Card className="border-red-500/20 bg-red-500/5" role="alert">
            <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
              <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              Não foi possível carregar o contrato: {erro}
            </CardContent>
          </Card>
        ) : data && !data.encontrado ? (
          <Card className="border-white/10 bg-nexo-chrome">
            <CardContent className="py-10 text-center text-sm text-slate-400">
              {data.motivo ?? 'Contrato não localizado.'}
            </CardContent>
          </Card>
        ) : c && ex ? (
          <>
            {/* Identificação */}
            <Card className="border-white/5 bg-nexo-chrome">
              <CardContent className="grid grid-cols-1 gap-4 py-5 sm:grid-cols-2 lg:grid-cols-3">
                <Campo rotulo="Valor contratado">
                  <span className="font-mono text-base text-slate-100">{brl(c.valor)}</span>
                </Campo>
                <Campo rotulo="Vigência">
                  {dataBR(c.vigenciaInicio)} a {dataBR(c.vigenciaFim)}
                  {c.ativo != null && (
                    <Badge
                      variant="outline"
                      className={
                        'ml-2 text-[10px] ' +
                        (c.ativo
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : 'border-slate-500/30 bg-slate-500/10 text-slate-400')
                      }
                    >
                      {c.ativo ? 'Vigente' : 'Encerrado'}
                    </Badge>
                  )}
                </Campo>
                <Campo rotulo="Processo">
                  <span className="font-mono">{c.numeroProcesso || '—'}</span>
                </Campo>
                <Campo rotulo="Objeto">{c.objeto || 'Não informado'}</Campo>
                <Campo rotulo="Fonte">{c.fonte}</Campo>
                <Campo rotulo="PDF do contrato">
                  {c.pdfUrl ? (
                    <a
                      href={c.pdfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-amber-300 hover:text-amber-200"
                    >
                      Abrir PDF <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="text-slate-400">não disponível</span>
                  )}
                </Campo>
              </CardContent>
            </Card>

            {/* Fornecedor */}
            <Secao icone={Building2} titulo="Contratada">
              <Card className="border-white/5 bg-nexo-chrome">
                <CardContent className="space-y-2 py-4">
                  <p className="text-base font-medium text-slate-100">{c.fornecedorNome || '—'}</p>
                  {docExt ? (
                    <p className="text-xs text-slate-500">
                      <EntityText>{docExt}</EntityText>
                    </p>
                  ) : (
                    <p className="text-xs text-slate-400">
                      Documento da contratada não informado (contrato não enriquecido).
                    </p>
                  )}
                </CardContent>
              </Card>
            </Secao>

            {/* Origem — edital/licitação/dispensa */}
            <Secao icone={Gavel} titulo="Origem — edital / licitação / dispensa" contagem={data.origem.length}>
              {data.origem.length === 0 ? (
                <Vazio>
                  Nenhuma licitação, edital ou dispensa de mesmo nº de processo foi encontrada
                  na base. Pode não ter sido ingerida, ou o processo diverge entre as fontes.
                </Vazio>
              ) : (
                <div className="space-y-3">
                  {data.origem.map((o: OrigemLicitacao) => (
                    <Card key={o.id} className="border-white/5 bg-nexo-chrome">
                      <CardContent className="space-y-3 py-4">
                        <p className="text-sm font-medium text-slate-200">
                          {o.tipoLicitacao || o.modalidade || 'Processo'} {o.numeroEdital || o.numeroProcesso}
                        </p>
                        <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                          <Campo rotulo="Modalidade">{o.modalidade || '—'}</Campo>
                          <Campo rotulo="Situação">{o.situacao || '—'}</Campo>
                          <Campo rotulo="Abertura">{dataBR(o.dataAbertura)}</Campo>
                          <Campo rotulo="Valor estimado">
                            {o.valorEstimado != null ? brl(o.valorEstimado) : 'não publicado'}
                          </Campo>
                          <Campo rotulo="Objeto">{o.objeto || '—'}</Campo>
                        </div>
                        <p className="text-[10px] text-slate-400">
                          Fonte: Dados Abertos Marília · nexo_licitacoes
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </Secao>

            {/* Execução financeira */}
            <Secao icone={Wallet} titulo="Execução financeira" contagem={ex.totalEmpenhos}>
              {!ex.disponivel ? (
                <Vazio>{ex.motivo ?? 'Execução financeira indisponível.'}</Vazio>
              ) : (
                <Card className="border-white/5 bg-nexo-chrome">
                  <CardContent className="space-y-5 py-5">
                    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                      <Campo rotulo="Contratado">
                        <span className="font-mono text-base text-slate-100">{brl(ex.valorContratado)}</span>
                      </Campo>
                      <Campo rotulo="Empenhado">
                        <span className="font-mono text-base text-amber-300">{brl(ex.somaEmpenhado)}</span>
                      </Campo>
                      <Campo rotulo="Pago">
                        <span className="font-mono text-base text-emerald-300">{brl(ex.somaPago)}</span>
                      </Campo>
                      <Campo rotulo="% empenhado / % pago">
                        <span className="font-mono text-sm text-slate-200">
                          {pct(ex.percentualEmpenhado)} / {pct(ex.percentualPago)}
                        </span>
                      </Campo>
                    </div>

                    <BarraExecucao
                      contratado={ex.valorContratado}
                      empenhado={ex.somaEmpenhado}
                      pago={ex.somaPago}
                    />

                    {/* Alertas honestos */}
                    <div className="flex flex-wrap gap-2">
                      {ex.estouro && (
                        <Badge variant="outline" className="border-orange-500/30 bg-orange-500/10 text-[11px] text-orange-300">
                          <TriangleAlert className="mr-1 h-3 w-3" /> Empenhado &gt; contratado — apurar (aditivo?)
                        </Badge>
                      )}
                      {ex.ambiguo && (
                        <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-300">
                          Mais de um contrato compartilha este nº de processo — casamento por aproximação
                        </Badge>
                      )}
                      <Badge variant="outline" className="border-slate-500/30 bg-slate-500/10 text-[11px] text-slate-400">
                        Vínculo {ex.confianca === 'media' ? 'médio' : ex.confianca === 'fraca' ? 'fraco' : 'inexistente'} (processo + ano)
                      </Badge>
                    </div>

                    {ex.empenhos.length === 0 ? (
                      <p className="text-sm text-slate-500">{ex.motivo ?? 'Nenhum empenho casado.'}</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[640px] border-collapse text-sm">
                          <thead>
                            <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-wide text-slate-500">
                              <th className="py-2 pr-3 font-medium">Empenho</th>
                              <th className="py-2 pr-3 font-medium">Data</th>
                              <th className="py-2 pr-3 font-medium">Credor</th>
                              <th className="py-2 pr-3 text-right font-medium">Empenhado</th>
                              <th className="py-2 pr-3 text-right font-medium">Pago</th>
                              <th className="py-2 font-medium">Situação</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ex.empenhos.map((e: EmpenhoExec) => (
                              <tr key={e.id} className="border-b border-white/5 text-slate-300">
                                <td className="py-2 pr-3">
                                  <Link
                                    href={`/nexo/empenho/${encodeURIComponent(e.id)}`}
                                    className="font-mono text-amber-300 hover:text-amber-200"
                                    title="Abrir o raio-x deste empenho"
                                  >
                                    {e.numeroEmpenho || e.id}
                                  </Link>
                                </td>
                                <td className="py-2 pr-3 whitespace-nowrap">{dataBR(e.data)}</td>
                                <td className="py-2 pr-3">{e.fornecedorNome || '—'}</td>
                                <td className="py-2 pr-3 text-right font-mono">{brl(e.valorEmpenhado)}</td>
                                <td className="py-2 pr-3 text-right font-mono">{brl(e.valorPago)}</td>
                                <td className="py-2">
                                  {e.temLiquidacao ? (
                                    e.valorPago > 0 ? (
                                      <span className="text-emerald-300">Liquidado · pago</span>
                                    ) : (
                                      <span className="text-orange-300">Liquidado · não pago</span>
                                    )
                                  ) : (
                                    <span className="text-amber-300">Empenhado</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <p className="text-[10px] text-slate-400">
                      Fonte: SMARAPD · nexo_empenhos. Casamento por nº de processo + ano —
                      INDÍCIO A APURAR (o nº de processo dos Dados Abertos é de baixa
                      cardinalidade e pode agregar empenhos de outro contrato do mesmo processo).
                    </p>
                  </CardContent>
                </Card>
              )}
            </Secao>

            {/* Aditivos — data-blocked (não coletados) */}
            <Secao icone={Layers} titulo="Aditivos">
              <Vazio>{data.aditivos.motivo}</Vazio>
            </Secao>

            {/* Medições — data-blocked (não publicadas) */}
            <Secao icone={Ruler} titulo="Medições / execução física">
              <Vazio>{data.medicoes.motivo}</Vazio>
            </Secao>

            {/* Vínculos do grafo */}
            <Secao icone={Link2} titulo="Vínculos — TUDO LINKADO" contagem={data.vinculos.length}>
              {data.vinculos.length === 0 ? (
                <Vazio>
                  Nenhuma aresta do grafo (nexo_links) tocou este contrato. O cron de linkage
                  ainda não cruza contrato↔empenho (ver relatório); demais vínculos podem
                  aparecer aqui quando o grafo casar por processo/CNPJ.
                </Vazio>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {data.vinculos.map((v: VinculoContrato, i: number) => (
                    <Badge
                      key={`${v.colecao}-${v.id}-${i}`}
                      variant="outline"
                      className="border-white/10 bg-nexo-chrome text-[11px] text-slate-300"
                      title={`Aresta ${v.tipo} (${v.confianca}) por ${v.chave}`}
                    >
                      <Link2 className="mr-1 h-3 w-3" />
                      {v.colecao.replace(/^nexo_/, '')} · {v.tipo}
                    </Badge>
                  ))}
                </div>
              )}
            </Secao>

            {/* Disclaimer */}
            <p className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] leading-relaxed text-slate-500">
              Ficha montada por cruzamento automático de dados públicos já ingeridos
              (SMARAPD, Dados Abertos). A execução é a FINANCEIRA (empenho → liquidação →
              pago) — medições físicas não são publicadas por Marília. Os vínculos e o
              casamento por processo são INDÍCIO para apuração, NUNCA acusação: convém
              conferir a aderência dos empenhos ao contrato e eventual divergência de
              valores antes de qualquer conclusão.
            </p>
          </>
        ) : null}
      </div>
    </EntityProvider>
  );
}
