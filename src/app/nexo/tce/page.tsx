'use client';

/**
 * NEXO — TCE-SP: cruzamento XS-14 (fornecedor/contrato de Marília citado em
 * julgado ou apontamento do Tribunal de Contas do Estado de São Paulo).
 *
 * A página mostra dois lados:
 *  • o lado FUNCIONAL — fornecedores de Marília coletados da API pública de
 *    despesas do TCE-SP;
 *  • o lado PENDENTE — julgados/apontamentos, que o TCE-SP não expõe de forma
 *    consultável por município. Esse estado é mostrado de forma honesta e
 *    explícita; nenhum dado é simulado.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Scale,
  RefreshCw,
  TriangleAlert,
  ShieldAlert,
  Clock,
  Building2,
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
import type { TceResponse } from '@/app/api/nexo/tce/route';
import type { AlertaDetectado } from '@/lib/nexo/detectores';
import { AlertaDetalhe } from '@/components/nexo/alerta-detalhe';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';

const EXERCICIOS = [2026, 2025, 2024];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
}

/** Pluralização pt-BR simples (1 → singular, demais → plural). */
function plural(n: number, singular: string, plural: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? singular : plural}`;
}

/**
 * Formata o doc de CNPJ (14 dígitos) por extenso — texto que o `EntityText`
 * detecta e transforma em chip investigável. Outros tamanhos (CPF etc.) → ''
 * para cair no fallback mascarado, respeitando a minimização de PII (LGPD).
 */
function cnpjFormatado(doc: string): string {
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

export default function TcePage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<TceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    try {
      const res = await nexoFetch(`/api/nexo/tce?exercicio=${ano}`);
      // 502 ainda traz corpo JSON útil (estado de coleta) — só tratamos como
      // erro se não houver corpo parseável.
      const json = (await res.json()) as TceResponse | { erro?: string };
      if (!res.ok && !('exercicio' in json)) {
        throw new Error(
          ('erro' in json && json.erro) || `HTTP ${res.status}`,
        );
      }
      if (id === reqId.current) {
        if ('exercicio' in json) {
          setData(json as TceResponse);
        } else {
          throw new Error('resposta inesperada da API');
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

  return (
    <EntityProvider>
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Scale className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              TCE-SP — Cruzamento XS-14
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Cruzamento entre os fornecedores da Prefeitura de Marília e julgados
            ou apontamentos de auditoria do Tribunal de Contas do Estado de São
            Paulo. Indícios a apurar — nunca acusação.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => carregar(exercicio)}
          disabled={loading}
          aria-label="Atualizar cruzamento do TCE-SP"
          title="Reconsultar a API pública do TCE-SP para o exercício selecionado"
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
      <div
        className="flex items-center gap-2"
        role="group"
        aria-label="Selecionar exercício"
      >
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
        <Card className="border-white/5 bg-nexo-surface" role="status" aria-live="polite">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <RefreshCw className="h-6 w-6 animate-spin text-amber-400" aria-hidden="true" />
            <p className="text-sm text-slate-300">
              Consultando a API pública do TCE-SP…
            </p>
          </CardContent>
        </Card>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5" role="alert">
          <CardContent className="space-y-1 py-6 text-sm text-red-300">
            <div className="flex items-center gap-3">
              <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              Não foi possível consultar o TCE-SP: {erro}
            </div>
            <p className="pl-8 text-xs text-red-300/70">
              A API pública de despesas do TCE-SP pode estar indisponível ou o
              exercício selecionado ainda não ter dados publicados.
            </p>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* Estado da integração XS-14 — honesto e explícito */}
          <Card
            className={
              data.cruzamentoXS14.integracao === 'pendente'
                ? 'border-amber-500/25 bg-nexo-surface'
                : 'border-emerald-500/25 bg-nexo-surface'
            }
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                {data.cruzamentoXS14.integracao === 'pendente' ? (
                  <Clock className="h-4 w-4 text-amber-400" aria-hidden="true" />
                ) : (
                  <ShieldAlert className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                )}
                Estado do cruzamento XS-14
                <Badge
                  variant="outline"
                  className={
                    'text-[10px] uppercase ' +
                    (data.cruzamentoXS14.integracao === 'pendente'
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300')
                  }
                >
                  {data.cruzamentoXS14.integracao === 'pendente'
                    ? 'integração pendente'
                    : 'integração ativa'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-slate-300">{data.cruzamentoXS14.motivo}</p>
              <div className="rounded-md border border-white/5 bg-nexo-chrome p-3">
                <div className="flex items-start gap-2 text-[12px] text-slate-400">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                  <span>
                    O que o TCE-SP <strong className="text-slate-300">expõe</strong>{' '}
                    publicamente: a API de despesas do Portal da Transparência
                    Municipal — usada aqui para listar os fornecedores de
                    Marília. O que o TCE-SP{' '}
                    <strong className="text-slate-300">não expõe</strong> de
                    forma consultável por município: julgados e apontamentos de
                    auditoria. A API de Tramitação de Processos só aceita
                    consulta por número de processo conhecido; a API AUDESP é
                    autenticada. Por isso o lado &quot;julgados&quot; do
                    cruzamento permanece pendente — e nenhum dado é simulado.
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Banner de coleta */}
          <div
            role="status"
            aria-label="Resumo da coleta de fornecedores"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500"
          >
            <span>
              {plural(data.fornecedores.total, 'fornecedor', 'fornecedores')}
            </span>
            <span>·</span>
            <span>{brl(data.fornecedores.valorTotalEmpenhado)} empenhados</span>
            <span>·</span>
            <span>
              {plural(
                data.fornecedores.mesesColetados.length,
                'mês coletado',
                'meses coletados',
              )}
            </span>
            <span>·</span>
            <span>
              {plural(
                data.fornecedores.registrosBrutos,
                'registro bruto',
                'registros brutos',
              )}
            </span>
            {data.fornecedores.erro && (
              <Badge
                variant="outline"
                className="border-red-500/30 bg-red-500/10 text-[10px] text-red-300"
              >
                falha parcial na coleta
              </Badge>
            )}
          </div>

          {/* Alertas XS-14 */}
          {data.alertas.length > 0 ? (
            <Card className="border-amber-500/20 bg-nexo-surface">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                  <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden="true" />
                  Indícios XS-14 detectados ({data.alertas.length.toLocaleString('pt-BR')})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.alertas.map((a) => (
                  <div
                    key={`${a.detectorId}-${a.sujeitoId}-${a.titulo}`}
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
                          className={
                            'text-[10px] uppercase ' +
                            classeBadge(a.classificacao)
                          }
                        >
                          {a.classificacao}
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
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : (
            <Card className="border-white/5 bg-nexo-surface">
              <CardContent className="flex items-start gap-3 py-5 text-sm">
                <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
                <div className="space-y-1">
                  <p className="text-slate-300">
                    Nenhum indício XS-14 — o cruzamento não pode rodar com a
                    dimensão de julgados/apontamentos do TCE-SP pendente.
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Os fornecedores de Marília abaixo já estão prontos para o
                    cruzamento. Assim que uma fonte oficial de julgados por
                    município existir — ou que números de processo TC sejam
                    alimentados manualmente — o detector XS-14 passará a gerar
                    indícios. Nada é inventado até lá.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Fornecedores de Marília — lado funcional do cruzamento */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                <Building2 className="h-4 w-4 text-slate-400" aria-hidden="true" />
                Fornecedores de Marília no TCE-SP — {exercicio}
              </CardTitle>
              <p className="text-[11px] text-slate-500">{data.fornecedores.fonte}</p>
            </CardHeader>
            <CardContent>
              {data.fornecedores.lista.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
                  Nenhum fornecedor retornado pela API de despesas do TCE-SP
                  para este exercício.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-white/5 hover:bg-transparent">
                        <TableHead className="text-slate-400">
                          Fornecedor
                        </TableHead>
                        <TableHead className="text-slate-400">
                          Documento
                        </TableHead>
                        <TableHead className="text-right text-slate-400">
                          Empenhos
                        </TableHead>
                        <TableHead className="text-right text-slate-400">
                          Valor empenhado
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.fornecedores.lista.map((f) => (
                        <TableRow
                          key={f.documento || f.nome}
                          className="border-white/5 hover:bg-white/5"
                        >
                          <TableCell className="max-w-[20rem] truncate font-medium text-slate-200" title={f.nome}>
                            {f.nome || '—'}
                          </TableCell>
                          <TableCell className="whitespace-nowrap font-mono text-xs text-slate-400">
                            {cnpjFormatado(f.documento) ? (
                              <EntityText>{cnpjFormatado(f.documento)}</EntityText>
                            ) : (
                              mascararDoc(f.documento)
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-slate-400">
                            {f.qtdEmpenhos.toLocaleString('pt-BR')}
                          </TableCell>
                          <TableCell className="text-right font-mono text-slate-300">
                            {brl(f.valorEmpenhado)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Disclaimer */}
          <p className="px-1 text-[11px] leading-relaxed text-slate-400">
            {data.disclaimer}
          </p>
        </>
      ) : null}

      <AlertaDetalhe alerta={alertaSel} onClose={() => setAlertaSel(null)} />
    </div>
    </EntityProvider>
  );
}
