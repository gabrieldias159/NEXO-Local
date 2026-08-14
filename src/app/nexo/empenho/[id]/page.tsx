'use client';

/**
 * NEXO — DETALHE de um empenho ("TUDO LINKADO").
 *
 * Abre a partir do número do empenho em Empenhos & Pagamentos. Mostra TUDO sobre
 * o empenho (valores, situação, órgão, data, fornecedor como chip investigável,
 * processos) e os documentos RELACIONADOS resolvidos do grafo `nexo_links`:
 * contratos, licitações/editais/dispensas, edições do DOM e despesas TCE — cada
 * item com fonte, selo de confiança e marcação ATIVO/INATIVO quando o dado
 * existir. Dados via /api/nexo/empenho/[id].
 *
 * Indício a apurar, NUNCA acusação. Estados loading/vazio/erro honestos.
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
  Landmark,
  Link2,
  ListChecks,
  Newspaper,
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
  EmpenhoDetalheResponse,
  EmpenhoItem,
  ContratoVinculado,
  LicitacaoVinculada,
  DomVinculado,
  TceVinculado,
  VinculoMeta,
} from '@/app/api/nexo/empenho/[id]/route';

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
/** CNPJ (14)/CPF (11) por extenso — texto que o EntityText vira chip. */
function docFormatado(doc: string): string {
  const d = (doc ?? '').replace(/\D/g, '');
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  if (d.length === 11) {
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }
  return '';
}

/** Situação igual à da tabela: Empenhado / Liquidado não pago / Liquidado pago. */
function situacaoEmpenho(temLiquidacao: boolean, valorPago: number): {
  rotulo: string;
  cls: string;
} {
  if (!temLiquidacao) {
    return { rotulo: 'Empenhado', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' };
  }
  if (valorPago > 0) {
    return { rotulo: 'Liquidado · pago', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' };
  }
  return { rotulo: 'Liquidado · não pago', cls: 'border-orange-500/30 bg-orange-500/10 text-orange-300' };
}

// ── Selo de confiança da aresta de vínculo ───────────────────────────────────

const CONF_CLS: Record<string, string> = {
  forte: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  media: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  fraca: 'border-slate-500/30 bg-slate-500/10 text-slate-400',
};
const CONF_ROTULO: Record<string, string> = {
  forte: 'vínculo forte',
  media: 'vínculo médio',
  fraca: 'vínculo fraco',
};

function SeloConfianca({ meta }: { meta: VinculoMeta }) {
  const conf = meta.confianca || '';
  const cls = CONF_CLS[conf] ?? CONF_CLS.fraca;
  const rotulo = CONF_ROTULO[conf] ?? 'vínculo';
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="outline" className={`text-[10px] ${cls}`} title={`Aresta ${meta.tipo || 'vínculo'} — ${rotulo}`}>
        <Link2 className="mr-1 h-3 w-3" />
        {rotulo}
      </Badge>
      {meta.chave && (
        <span className="font-mono text-[10px] text-slate-400" title="Chave que produziu o vínculo">
          {meta.chave}
        </span>
      )}
    </span>
  );
}

/** Selo ATIVO/INATIVO quando há base para inferir (senão nada). */
function SeloVigencia({ ativo }: { ativo: boolean | null }) {
  if (ativo == null) return null;
  return ativo ? (
    <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300">
      Ativo
    </Badge>
  ) : (
    <Badge variant="outline" className="border-slate-500/30 bg-slate-500/10 text-[10px] text-slate-400">
      Inativo
    </Badge>
  );
}

// ── Blocos de UI ──────────────────────────────────────────────────────────────

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

function ItemVinculo({
  titulo,
  link,
  internalLink,
  meta,
  vigencia,
  fonte,
  campos,
}: {
  titulo: string;
  /** Link externo (PDF/portal) — abre em nova aba. */
  link?: string | null;
  /** Rota interna do NEXO (ex.: ficha do contrato) — navega na app. */
  internalLink?: string | null;
  meta: VinculoMeta;
  vigencia?: boolean | null;
  fonte: string;
  campos: { rotulo: string; valor: React.ReactNode }[];
}) {
  const Tit = internalLink ? (
    <Link
      href={internalLink}
      className="inline-flex items-center gap-1 text-sm font-medium text-amber-300 transition-colors hover:text-amber-200"
      title="Abrir a ficha de execução"
    >
      {titulo}
      <Link2 className="h-3 w-3" aria-hidden="true" />
    </Link>
  ) : link ? (
    <a
      href={link}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm font-medium text-amber-300 transition-colors hover:text-amber-200"
    >
      {titulo}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  ) : (
    <span className="text-sm font-medium text-slate-200">{titulo}</span>
  );
  return (
    <Card className="border-white/5 bg-nexo-chrome">
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">{Tit}{vigencia !== undefined && <SeloVigencia ativo={vigencia ?? null} />}</div>
          <SeloConfianca meta={meta} />
        </div>
        {campos.length > 0 && (
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {campos.map((c) => (
              <Campo key={c.rotulo} rotulo={c.rotulo}>{c.valor}</Campo>
            ))}
          </div>
        )}
        <p className="text-[10px] text-slate-400">Fonte: {fonte}</p>
      </CardContent>
    </Card>
  );
}

function Vazio({ children }: { children: React.ReactNode }) {
  return (
    <Card className="border-white/5 bg-nexo-chrome">
      <CardContent className="py-6 text-center text-sm text-slate-500">{children}</CardContent>
    </Card>
  );
}

// ── Página ────────────────────────────────────────────────────────────────────

export default function EmpenhoDetalhePage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params?.id ?? '');

  const [data, setData] = useState<EmpenhoDetalheResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const reqId = useRef(0);

  const carregar = useCallback(() => {
    if (!id) return;
    const req = ++reqId.current;
    setLoading(true);
    setErro(null);
    nexoFetch(`/api/nexo/empenho/${encodeURIComponent(id)}?itens=1`)
      .then(async (r) => {
        const json = (await r.json()) as EmpenhoDetalheResponse & { erro?: string };
        // 404 traz corpo `encontrado:false` — não é erro de rede.
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

  const e = data?.encontrado ? data.empenho : null;
  const v = data?.vinculos;
  const sit = e ? situacaoEmpenho(e.temLiquidacao, e.valorPago) : null;
  const docExt = e?.cpfCnpj ? docFormatado(e.cpfCnpj) : '';

  return (
    <EntityProvider>
      <div className="space-y-6">
        <Link
          href="/nexo/empenhos"
          className="inline-flex items-center gap-1 rounded text-xs text-slate-500 transition-colors hover:text-amber-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Voltar a Empenhos &amp; Pagamentos
        </Link>

        {/* Cabeçalho */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Wallet className="h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
              <h1 className="break-words text-2xl font-bold tracking-tight text-slate-100">
                {loading && !data
                  ? 'Carregando empenho…'
                  : e
                    ? `Empenho ${e.numeroEmpenho || '—'}${e.exercicio ? `/${e.exercicio}` : ''}`
                    : 'Empenho'}
              </h1>
            </div>
            {e && (
              <p className="mt-1 text-sm text-slate-400">
                {e.unidadeGestora || 'Órgão não informado'} · {dataBR(e.data)}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={carregar}
            disabled={loading}
            aria-label="Recarregar o detalhe do empenho"
            title="Reconsultar o empenho e os vínculos"
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
              Não foi possível carregar o empenho: {erro}
            </CardContent>
          </Card>
        ) : data && !data.encontrado ? (
          <Card className="border-white/10 bg-nexo-chrome">
            <CardContent className="py-10 text-center text-sm text-slate-400">
              {data.motivo ?? 'Empenho não localizado.'}
            </CardContent>
          </Card>
        ) : e && v ? (
          <>
            {/* Valores + situação */}
            <Card className="border-white/5 bg-nexo-chrome">
              <CardContent className="grid grid-cols-1 gap-4 py-5 sm:grid-cols-2 lg:grid-cols-4">
                <Campo rotulo="Empenhado">
                  <span className="font-mono text-base text-slate-100">{brl(e.valorEmpenhado)}</span>
                </Campo>
                <Campo rotulo="Liquidado">
                  <span className="font-mono text-base text-slate-200">
                    {e.temLiquidacao ? 'Sim' : 'Não'}
                  </span>
                </Campo>
                <Campo rotulo="Pago">
                  <span className="font-mono text-base text-slate-200">{brl(e.valorPago)}</span>
                </Campo>
                <Campo rotulo="Situação">
                  {sit && (
                    <Badge variant="outline" className={`text-[11px] ${sit.cls}`}>
                      {sit.rotulo}
                    </Badge>
                  )}
                </Campo>
              </CardContent>
            </Card>

            {/* Fornecedor */}
            <Secao icone={Building2} titulo="Fornecedor / credor">
              <Card className="border-white/5 bg-nexo-chrome">
                <CardContent className="space-y-2 py-4">
                  <p className="text-base font-medium text-slate-100">{e.fornecedorNome || '—'}</p>
                  {docExt ? (
                    <p className="text-xs text-slate-500">
                      <EntityText>{docExt}</EntityText>
                    </p>
                  ) : (
                    <p className="text-xs text-slate-400">Documento do fornecedor não informado.</p>
                  )}
                </CardContent>
              </Card>
            </Secao>

            {/* Processos */}
            <Secao icone={ScrollText} titulo="Processo(s)" contagem={data.processos.length}>
              {data.processos.length === 0 ? (
                <Vazio>Nenhum processo administrativo ou licitatório informado neste empenho.</Vazio>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {data.processos.map((p) => (
                    <Link
                      key={`${p.tipo}-${p.numero}`}
                      href={`/nexo/empenhos?processo=${encodeURIComponent(p.numero)}`}
                      className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-nexo-chrome px-3 py-1.5 text-sm text-slate-200 transition-colors hover:border-amber-500/30 hover:text-amber-200"
                      title={`Ver empenhos do processo ${p.numero}`}
                    >
                      <span className="text-[10px] uppercase tracking-wide text-slate-500">
                        {p.tipo === 'administrativo' ? 'Adm.' : 'Licit.'}
                      </span>
                      <span className="font-mono">{p.numero}</span>
                    </Link>
                  ))}
                </div>
              )}
            </Secao>

            {/* Itens do empenho (drill-down analítico) */}
            <Secao icone={ListChecks} titulo="Itens do empenho" contagem={data.itens?.itens.length}>
              {!data.itens ? (
                <Vazio>Itens indisponíveis nesta carga (drill-down não solicitado).</Vazio>
              ) : !data.itens.disponivel ? (
                <Vazio>{data.itens.motivo ?? 'Drill-down de itens indisponível.'}</Vazio>
              ) : data.itens.itens.length === 0 ? (
                <Vazio>O portal não retornou itens analíticos para este empenho.</Vazio>
              ) : (
                <Card className="border-white/5 bg-nexo-chrome">
                  <CardContent className="overflow-x-auto py-2">
                    <table className="w-full min-w-[640px] text-left text-sm">
                      <thead>
                        <tr className="border-b border-white/10 text-[11px] uppercase tracking-wide text-slate-500">
                          <th className="py-2 pr-3 font-medium">#</th>
                          <th className="py-2 pr-3 font-medium">Descrição</th>
                          <th className="py-2 pr-3 text-right font-medium">Qtd.</th>
                          <th className="py-2 pr-3 text-right font-medium">Unitário</th>
                          <th className="py-2 text-right font-medium">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.itens.itens.map((item: EmpenhoItem, i: number) => (
                          <tr key={item.id || i} className="border-b border-white/5 last:border-0">
                            <td className="py-2 pr-2 align-top font-mono text-xs text-slate-500">{i + 1}</td>
                            <td className="py-2 pr-3 align-top text-slate-200">{item.descricao || '—'}</td>
                            <td className="py-2 pr-3 align-top text-right font-mono text-slate-300">
                              {item.quantidade.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}
                            </td>
                            <td className="py-2 pr-3 align-top text-right font-mono text-slate-300">{brl(item.valorUnitario)}</td>
                            <td className="py-2 align-top text-right font-mono text-slate-100">{brl(item.valorTotal)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-2 text-right text-xs text-slate-500">
                      {data.itens.itens.length} item(ns) · {brl(data.itens.itens.reduce((s, i) => s + i.valorTotal, 0))}
                    </p>
                  </CardContent>
                </Card>
              )}
            </Secao>

            {/* Vínculos — TUDO LINKADO */}
            <Secao icone={Link2} titulo="Vínculos — TUDO LINKADO">
              {!v.disponivel ? (
                <Vazio>{v.motivo ?? 'Grafo de vínculos indisponível.'}</Vazio>
              ) : v.totalArestas === 0 ? (
                <Vazio>{v.motivo ?? 'Nenhum vínculo cruzou este empenho.'}</Vazio>
              ) : (
                <div className="space-y-6">
                  {/* Contratos */}
                  <Secao icone={FileText} titulo="Contratos" contagem={v.contratos.length}>
                    {v.contratos.length === 0 ? (
                      <Vazio>Nenhum contrato vinculado.</Vazio>
                    ) : (
                      <div className="space-y-3">
                        {v.contratos.map((c: ContratoVinculado) => (
                          <ItemVinculo
                            key={c.id}
                            titulo={`Contrato ${c.numeroContrato || c.numeroProcesso || c.id}`}
                            internalLink={`/nexo/contrato/${encodeURIComponent(c.id)}`}
                            meta={c}
                            vigencia={c.ativo}
                            fonte="Dados Abertos Marília · nexo_contratos_municipais"
                            campos={[
                              { rotulo: 'Processo', valor: c.numeroProcesso || '—' },
                              { rotulo: 'Valor', valor: brl(c.valor) },
                              {
                                rotulo: 'Vigência',
                                valor: `${dataBR(c.vigenciaInicio)} a ${dataBR(c.vigenciaFim)}`,
                              },
                              { rotulo: 'Fornecedor', valor: c.fornecedorNome || '—' },
                              { rotulo: 'Objeto', valor: c.objeto || '—' },
                            ]}
                          />
                        ))}
                      </div>
                    )}
                  </Secao>

                  {/* Licitações / editais / dispensas */}
                  <Secao icone={Gavel} titulo="Editais / licitações / dispensas" contagem={v.licitacoes.length}>
                    {v.licitacoes.length === 0 ? (
                      <Vazio>Nenhuma licitação, edital ou dispensa vinculada.</Vazio>
                    ) : (
                      <div className="space-y-3">
                        {v.licitacoes.map((l: LicitacaoVinculada) => (
                          <ItemVinculo
                            key={l.id}
                            titulo={`${l.tipoLicitacao || l.modalidade || 'Processo'} ${l.numeroEdital || l.numeroProcesso || l.id}`}
                            meta={l}
                            fonte="Dados Abertos Marília · nexo_licitacoes"
                            campos={[
                              { rotulo: 'Processo', valor: l.numeroProcesso || '—' },
                              { rotulo: 'Modalidade', valor: l.modalidade || '—' },
                              { rotulo: 'Situação', valor: l.situacao || '—' },
                              { rotulo: 'Abertura', valor: dataBR(l.dataAbertura) },
                              { rotulo: 'Valor estimado', valor: brl(l.valorEstimado) },
                              { rotulo: 'Objeto', valor: l.objeto || '—' },
                            ]}
                          />
                        ))}
                      </div>
                    )}
                  </Secao>

                  {/* DOM */}
                  <Secao icone={Newspaper} titulo="Diário Oficial (DOM)" contagem={v.dom.length}>
                    {v.dom.length === 0 ? (
                      <Vazio>Nenhuma menção em edição do DOM vinculada.</Vazio>
                    ) : (
                      <div className="space-y-3">
                        {v.dom.map((d: DomVinculado) => (
                          <ItemVinculo
                            key={d.id}
                            titulo={d.titulo}
                            link={d.urlPdf}
                            meta={d}
                            fonte="Querido Diário · nexo_diario_dom"
                            campos={[{ rotulo: 'Data', valor: dataBR(d.data) }]}
                          />
                        ))}
                      </div>
                    )}
                  </Secao>

                  {/* TCE */}
                  <Secao icone={Landmark} titulo="Despesa declarada ao TCE-SP" contagem={v.tce.length}>
                    {v.tce.length === 0 ? (
                      <Vazio>Nenhuma despesa do TCE-SP vinculada.</Vazio>
                    ) : (
                      <div className="space-y-3">
                        {v.tce.map((t: TceVinculado) => (
                          <ItemVinculo
                            key={t.id}
                            titulo={`Empenho TCE ${t.nrEmpenho || t.id}`}
                            meta={t}
                            fonte="TCE-SP (Audesp) · nexo_tce_despesas"
                            campos={[
                              { rotulo: 'Valor (TCE)', valor: brl(t.valor) },
                              { rotulo: 'Data', valor: dataBR(t.data) },
                              { rotulo: 'Órgão', valor: t.unidadeGestora || '—' },
                              {
                                rotulo: 'Credor',
                                valor: t.fornecedorNome || (t.cnpj ? docFormatado(t.cnpj) || t.cnpj : '—'),
                              },
                            ]}
                          />
                        ))}
                      </div>
                    )}
                  </Secao>
                </div>
              )}
            </Secao>

            {/* Disclaimer */}
            <p className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] leading-relaxed text-slate-500">
              Cruzamento automático de dados públicos já ingeridos (SMARAPD, Dados
              Abertos, Querido Diário, TCE-SP). Os vínculos são INDÍCIO para
              apuração, NUNCA acusação — convém verificar a aderência de cada
              documento ao empenho e eventual divergência de valores antes de
              qualquer conclusão.
            </p>
          </>
        ) : null}
      </div>
    </EntityProvider>
  );
}
