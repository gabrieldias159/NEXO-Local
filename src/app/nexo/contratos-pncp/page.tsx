'use client';

/**
 * NEXO — Contratos (PNCP): contratos da Prefeitura de Marília no Portal
 * Nacional de Contratações Públicas, com detecção de aditivos acima do limite
 * (LC-19) e prorrogações de prazo desproporcionais (LC-20).
 *
 * O PNCP é geo-bloqueado fora do Brasil — fora de produção a coleta falha; a
 * página exibe esse estado de forma honesta, sem inventar dados.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileSignature,
  RefreshCw,
  TriangleAlert,
  ShieldAlert,
  Info,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { mascararDoc } from '@/lib/nexo/normalizar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ContratosPNCPResponse } from '@/app/api/nexo/contratos-pncp/route';
import type { AlertaDetectado } from '@/lib/nexo/detectores';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { AlertaDetalhe } from '@/components/nexo/alerta-detalhe';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';

const EXERCICIOS = [2026, 2025, 2024];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
}

/** Pluralização pt-BR simples ("1 contrato" / "2 contratos"). */
function plural(n: number, singular: string, plural: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? singular : plural}`;
}

/** Rótulo humanizado da classificação do indício (nada de enum cru). */
function rotuloClasse(c: string): string {
  switch (c) {
    case 'critico':
      return 'Crítico';
    case 'suspeita':
      return 'Suspeita';
    case 'atencao':
      return 'Atenção';
    default:
      return 'Informativo';
  }
}

/**
 * Formata 14 dígitos como CNPJ por extenso — texto que o `EntityText` detecta
 * e converte em chip investigável. Outros tamanhos → '' (não é CNPJ).
 */
function cnpjFormatado(doc: string | null | undefined): string {
  const d = (doc ?? '').replace(/\D/g, '');
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return '';
}

function classeBadge(c: string): string {
  switch (c) {
    case 'critico':
      return 'border-red-500/30 bg-red-500/10 text-red-300';
    case 'suspeita':
      return 'border-orange-500/30 bg-orange-500/10 text-orange-300';
    case 'atencao':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
    default:
      return 'border-sky-500/30 bg-sky-500/10 text-sky-300';
  }
}

export default function ContratosPncpPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<ContratosPNCPResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    try {
      const res = await nexoFetch(`/api/nexo/contratos-pncp?exercicio=${ano}`);
      // 502 = falha de upstream PNCP: o corpo ainda traz o estado de coleta.
      const json = (await res.json()) as ContratosPNCPResponse;
      if (!res.ok && !json?.coleta) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (id === reqId.current) {
        setData(json);
        if (!res.ok) {
          setErro(json?.coleta?.erro ?? `HTTP ${res.status}`);
        }
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
            <FileSignature className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Contratos &mdash; PNCP
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Contratos da Prefeitura de Marília no Portal Nacional de
            Contratações Públicas (Lei 14.133/2021), com o elo edital &rarr;
            contrato &rarr; vigência &rarr; aditivo. Detecção de aditivos acima
            do limite legal (LC-19) e prorrogações de prazo desproporcionais
            (LC-20). Indícios a apurar.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => carregar(exercicio)}
          disabled={loading}
          aria-label="Atualizar contratos do PNCP"
          title="Recarregar os contratos do exercício selecionado"
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <RefreshCw
            className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')}
            aria-hidden="true"
          />
          Atualizar
        </Button>
      </div>

      {/* Exercício */}
      <div className="flex items-center gap-2" role="group" aria-label="Selecionar exercício">
        <span className="text-xs uppercase tracking-wide text-slate-500">
          Exercício
        </span>
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
        <Card className="border-white/5 bg-nexo-surface" role="status" aria-busy="true">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <RefreshCw className="h-6 w-6 animate-spin text-amber-400" aria-hidden="true" />
            <p className="text-sm text-slate-300">
              Consultando contratos no PNCP&hellip;
            </p>
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
              A consulta ao PNCP exige o CNPJ do órgão da Prefeitura de Marília
              em <code className="text-sky-200">src/lib/nexo/constants.ts</code>{' '}
              (<code className="text-sky-200">MARILIA.cnpjPrefeitura</code>).
              Sem ele, nenhum contrato pode ser coletado — nenhum dado é
              inventado.
            </p>
          </CardContent>
        </Card>
      ) : erro || falhaUpstream ? (
        <Card className="border-red-500/20 bg-red-500/5" role="alert">
          <CardContent className="space-y-1 py-6 text-sm text-red-300">
            <div className="flex items-center gap-3">
              <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              Não foi possível consultar o PNCP:{' '}
              {data?.coleta.erro ?? erro}
            </div>
            <p className="pl-8 text-xs text-red-300/70">
              O PNCP bloqueia o acesso a partir de IPs fora do Brasil (HTTP
              403). Em produção a rota roda em região brasileira; em ambiente de
              desenvolvimento essa falha é esperada. Nenhum contrato é exibido
              porque a fonte não respondeu &mdash; isto não significa que a
              Prefeitura não tenha contratos no exercício.
            </p>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* Banner de coleta */}
          <div
            role="status"
            aria-label="Resumo da coleta no PNCP"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500"
          >
            <span>{plural(data.resumo.totalContratos, 'contrato', 'contratos')}</span>
            <span aria-hidden="true">&middot;</span>
            <span>{brl(data.resumo.valorInicialTotal)} valor inicial</span>
            <span aria-hidden="true">&middot;</span>
            <span>{brl(data.resumo.valorGlobalTotal)} valor global</span>
            <span aria-hidden="true">&middot;</span>
            <span>{plural(data.resumo.totalAditivos, 'aditivo', 'aditivos')}</span>
            {data.cnpjOrgao && (
              <>
                <span aria-hidden="true">&middot;</span>
                <span className="font-mono">CNPJ {data.cnpjOrgao}</span>
              </>
            )}
            <span aria-hidden="true">&middot;</span>
            <span>{plural(data.coleta.totalPaginas, 'página', 'páginas')} no PNCP</span>
          </div>

          {/* Alertas */}
          {data.alertas.length > 0 && (
            <Card className="border-amber-500/20 bg-nexo-surface">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                  <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden="true" />
                  {data.alertas.length === 1
                    ? '1 indício detectado'
                    : `${data.alertas.length.toLocaleString('pt-BR')} indícios detectados`}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.alertas.map((a) => (
                  <div
                    key={`${a.detectorId}-${a.sujeitoId}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Abrir detalhe do indício: ${a.titulo}`}
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
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={'text-[10px] ' + classeBadge(a.classificacao)}
                        >
                          {rotuloClasse(a.classificacao)}
                        </Badge>
                        <span className="font-mono text-[10px] text-slate-500">
                          {a.detectorId}
                        </span>
                      </div>
                      <span className="font-mono text-xs text-amber-300">
                        {brl(a.valorEnvolvido)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm text-slate-200">{a.titulo}</p>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {a.descricao}
                    </p>
                    <p className="mt-1.5 text-[11px] text-slate-500">
                      {a.explicacao}
                    </p>
                    {a.fundamentoLegal.length > 0 && (
                      <p className="mt-1.5 text-[10px] text-slate-400">
                        {a.fundamentoLegal.join(' · ')}
                      </p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Tabela de contratos */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="text-base text-slate-200">
                Contratos no PNCP &mdash; {exercicio}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.contratos.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
                  Nenhum contrato retornado pelo PNCP para este exercício. A
                  ausência de retorno não significa que a Prefeitura não tenha
                  contratos no período.
                </div>
              ) : (
                <div className="overflow-x-auto" aria-busy={loading}>
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead className="text-slate-400">Contrato</TableHead>
                      <TableHead className="text-slate-400">
                        Fornecedor
                      </TableHead>
                      <TableHead className="text-slate-400">Objeto</TableHead>
                      <TableHead className="text-slate-400">
                        Modalidade
                      </TableHead>
                      <TableHead className="text-right text-slate-400">
                        Valor inicial
                      </TableHead>
                      <TableHead className="text-right text-slate-400">
                        Valor global
                      </TableHead>
                      <TableHead className="text-right text-slate-400">
                        Aditivos
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.contratos.map((c) => {
                      const cnpj = cnpjFormatado(c.fornecedorDoc);
                      const acrescimoPct =
                        c.valorGlobal > c.valorInicial && c.valorInicial > 0
                          ? (c.valorGlobal / c.valorInicial - 1) * 100
                          : null;
                      return (
                      <TableRow
                        key={c.id}
                        className="border-white/5 hover:bg-white/5"
                      >
                        <TableCell className="whitespace-nowrap font-mono text-xs text-slate-400">
                          {c.numeroContrato || c.id}
                        </TableCell>
                        <TableCell className="max-w-[16rem]">
                          <div className="truncate font-medium text-slate-200" title={c.fornecedorNome || undefined}>
                            {c.fornecedorNome || mascararDoc(c.fornecedorDoc)}
                          </div>
                          {c.fornecedorNome &&
                            (cnpj ? (
                              <div className="mt-0.5 text-[11px] text-slate-500">
                                <EntityText>{cnpj}</EntityText>
                              </div>
                            ) : c.fornecedorDoc ? (
                              <div className="mt-0.5 text-[11px] text-slate-500">
                                {mascararDoc(c.fornecedorDoc)}
                              </div>
                            ) : null)}
                        </TableCell>
                        <TableCell className="max-w-[16rem] truncate text-xs text-slate-500" title={c.objeto || undefined}>
                          {c.objeto || '—'}
                        </TableCell>
                        <TableCell className="text-xs text-slate-400">
                          {c.modalidade || '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right font-mono text-slate-300">
                          {brl(c.valorInicial)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right font-mono text-slate-400">
                          {brl(c.valorGlobal)}
                          {acrescimoPct != null && (
                            <span
                              className="ml-1 text-[10px] text-amber-400"
                              title="Acréscimo do valor global sobre o valor inicial — indício a apurar"
                            >
                              +{acrescimoPct.toFixed(0)}%
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-slate-400">
                          {c.aditivos.length}
                        </TableCell>
                      </TableRow>
                      );
                    })}
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
