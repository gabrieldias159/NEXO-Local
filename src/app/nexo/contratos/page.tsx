'use client';

/** NEXO — Contratos & Licitações: contratos da Prefeitura via PNCP. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollText, RefreshCw, TriangleAlert, Scale, Info, Search } from 'lucide-react';
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
import type { AlertaDetectado } from '@/lib/nexo/detectores';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { AlertaDetalhe } from '@/components/nexo/alerta-detalhe';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';

const EXERCICIOS = [2026, 2025, 2024];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

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

export default function ContratosPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<ContratosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);
  const [busca, setBusca] = useState('');

  // Filtro client-side por número/objeto/fornecedor/CNPJ sobre os contratos já
  // carregados do exercício (a página não tinha busca — pedido do dono).
  const contratosVisiveis = useMemo(() => {
    if (!data) return [];
    const t = busca.trim().toLowerCase();
    if (!t) return data.contratos;
    const dig = t.replace(/\D+/g, '');
    return data.contratos.filter((c) => {
      const alvo = `${c.numeroContrato ?? ''} ${c.objeto ?? ''} ${c.fornecedorNome ?? ''}`.toLowerCase();
      return alvo.includes(t) || (dig.length >= 4 && String(c.fornecedorDoc ?? '').includes(dig));
    });
  }, [data, busca]);

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

  return (
    <EntityProvider>
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ScrollText className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Contratos &amp; Licitações
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Contratos da Prefeitura de Marília publicados no PNCP, com detecção
            de aditivos acima do limite legal de 25%.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => carregar(exercicio)}
          disabled={loading}
          aria-label="Atualizar contratos"
          title="Reconsultar os contratos do exercício selecionado no PNCP"
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
        <Card className="border-white/5 bg-nexo-surface">
          <CardContent
            className="flex flex-col items-center gap-3 py-12 text-center"
            role="status"
            aria-live="polite"
          >
            <RefreshCw className="h-6 w-6 animate-spin text-amber-400" aria-hidden="true" />
            <p className="text-sm text-slate-300">Consultando contratos no PNCP…</p>
          </CardContent>
        </Card>
      ) : cnpjAusente ? (
        <Card className="border-sky-500/20 bg-sky-500/5">
          <CardContent className="space-y-1 py-6 text-sm text-sky-300" role="status">
            <div className="flex items-center gap-3">
              <Info className="h-5 w-5 shrink-0" aria-hidden="true" />
              CNPJ da Prefeitura não configurado.
            </div>
            <p className="pl-8 text-xs text-sky-300/70">
              A consulta ao PNCP exige o CNPJ do órgão da Prefeitura de Marília
              em <code className="text-sky-200">src/lib/nexo/constants.ts</code>{' '}
              (<code className="text-sky-200">MARILIA.cnpjPrefeitura</code>).
              Sem ele, nenhum contrato é coletado — nenhum dado é inventado.
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
              A página serve os contratos já coletados pelo cron do PNCP
              (materializados no NEXO). Quando o ano ainda não foi coletado, há
              uma consulta ao vivo via proxy no Brasil — mas o PNCP tem estado
              lento/instável e pode não responder a tempo. Nenhum contrato é
              exibido porque a fonte não respondeu — isto não significa que a
              Prefeitura não tenha contratos; tente novamente ou aguarde a
              próxima coleta.
            </p>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* Banner */}
          <div
            role="status"
            aria-label="Resumo do exercício"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500"
          >
            <span className="text-slate-300">
              {data.resumo.totalContratos.toLocaleString('pt-BR')}{' '}
              {data.resumo.totalContratos === 1 ? 'contrato' : 'contratos'}
            </span>
            <span>·</span>
            <span>valor global <strong className="text-slate-200">{brl(data.resumo.valorTotal)}</strong></span>
            <span>·</span>
            <span>órgão CNPJ {data.cnpjOrgao}</span>
            {data.coleta.amostra && (
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300"
                title="Resultado parcial — apenas uma amostra dos contratos foi coletada"
              >
                amostra
              </Badge>
            )}
          </div>

          {/* Alertas de aditivo */}
          {data.alertas.length > 0 && (
            <Card className="border-amber-500/20 bg-nexo-surface">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                  <Scale className="h-4 w-4 text-amber-400" aria-hidden="true" />
                  {data.alertas.length === 1
                    ? '1 aditivo acima do limite'
                    : `${data.alertas.length.toLocaleString('pt-BR')} aditivos acima do limite`}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.alertas.map((a) => (
                  <div
                    key={a.sujeitoId}
                    role="button"
                    tabIndex={0}
                    aria-label={`Ver detalhes do indício: ${a.titulo}`}
                    onClick={() => setAlertaSel(a)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setAlertaSel(a);
                      }
                    }}
                    className="cursor-pointer rounded-md border border-white/5 bg-nexo-chrome p-3 transition-colors hover:border-amber-500/20 hover:bg-[#14171f] focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Badge
                        variant="outline"
                        title="Indício a apurar — não constitui acusação"
                        className={
                          a.classificacao === 'suspeita'
                            ? 'border-orange-500/30 bg-orange-500/10 text-[10px] uppercase text-orange-300'
                            : 'border-amber-500/30 bg-amber-500/10 text-[10px] uppercase text-amber-300'
                        }
                      >
                        {a.classificacao}
                      </Badge>
                      <span className="font-mono text-xs text-amber-300">
                        +{brl(a.valorEnvolvido)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm text-slate-200">{a.titulo}</p>
                    <p className="mt-1 text-[11px] text-slate-400">{a.descricao}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Tabela de contratos */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base text-slate-200">
                Contratos — {exercicio}
              </CardTitle>
              {data.contratos.length > 0 && (
                <div className="relative w-full sm:w-72">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
                  <input
                    value={busca}
                    onChange={(e) => setBusca(e.target.value)}
                    placeholder="Buscar por objeto, fornecedor, CNPJ ou nº…"
                    className="w-full rounded-md border border-white/10 bg-nexo-chrome py-2 pl-9 pr-3 text-sm text-slate-200 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70"
                  />
                </div>
              )}
            </CardHeader>
            <CardContent>
              {data.contratos.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
                  Nenhum contrato retornado pelo PNCP para este exercício.
                  Verifique o CNPJ do órgão.
                </div>
              ) : contratosVisiveis.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
                  Nenhum contrato para “{busca}”.
                </div>
              ) : (
                <div className="overflow-x-auto" aria-busy={loading}>
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead className="text-slate-400">Contrato</TableHead>
                      <TableHead className="text-slate-400">Fornecedor</TableHead>
                      <TableHead className="text-slate-400">Objeto</TableHead>
                      <TableHead className="text-right text-slate-400">Inicial</TableHead>
                      <TableHead className="text-right text-slate-400">Global</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contratosVisiveis.map((c) => (
                      <TableRow key={c.id} className="border-white/5 hover:bg-white/5">
                        <TableCell className="font-mono text-xs text-slate-400">
                          {c.numeroContrato || '—'}
                        </TableCell>
                        <TableCell className="max-w-[14rem]">
                          <div className="truncate font-medium text-slate-200" title={c.fornecedorNome}>
                            {c.fornecedorNome || '—'}
                          </div>
                          {cnpjFormatado(c.fornecedorDoc) && (
                            <div className="mt-0.5 text-[11px] text-slate-500">
                              <EntityText>{cnpjFormatado(c.fornecedorDoc)}</EntityText>
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="max-w-[20rem] truncate text-xs text-slate-500">
                          {c.objeto || '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono text-slate-400">
                          {brl(c.valorInicial)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-slate-300">
                          {brl(c.valorGlobal)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}

      <AlertaDetalhe alerta={alertaSel} onClose={() => setAlertaSel(null)} />
    </div>
    </EntityProvider>
  );
}
