'use client';

/**
 * NEXO — Sanções Federais: cruzamento dos fornecedores da Prefeitura de
 * Marília com os cadastros federais de inidôneos (CEIS/CNEP/CEPIM) da CGU.
 * Alimenta o detector FR-04 (fornecedor inidôneo recebendo recurso público).
 *
 * Todo alerta é indício a apurar — nunca acusação. Apenas dados públicos.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ShieldX,
  RefreshCw,
  TriangleAlert,
  ShieldAlert,
  KeyRound,
  CheckCircle2,
} from 'lucide-react';
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
import type { SancoesResponse } from '@/app/api/nexo/sancoes/route';
import type { AlertaDetectado } from '@/lib/nexo/detectores';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { AlertaDetalhe } from '@/components/nexo/alerta-detalhe';

const EXERCICIOS = [2026, 2025, 2024];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
}

/** Formata um CNPJ (14 dígitos) na máscara padrão. */
function formatCnpj(cnpj: string): string {
  if (cnpj.length !== 14) return cnpj || '—';
  return cnpj.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    '$1.$2.$3/$4-$5',
  );
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

/** Rótulo humano para a classificação do alerta (evita exibir o enum cru). */
function classeRotulo(c: string): string {
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

/** Pluralização pt-BR simples. */
function plural(n: number, sing: string, plur: string): string {
  return n === 1 ? sing : plur;
}

export default function SancoesPage() {
  const [exercicio, setExercicio] = useState(2026);
  const [data, setData] = useState<SancoesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [alertaSel, setAlertaSel] = useState<AlertaDetectado | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    try {
      const res = await nexoFetch(`/api/nexo/sancoes?exercicio=${ano}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SancoesResponse;
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

  return (
    <div className="space-y-7">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldX className="h-5 w-5 text-red-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              Sanções Federais
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Cruzamento dos maiores fornecedores da Prefeitura de Marília com os
            cadastros federais de inidôneos da CGU — CEIS, CNEP e CEPIM.
            Detecta CNPJ sancionado recebendo recurso público (FR-04). Todo
            indício deve ser apurado — não constitui acusação.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => carregar(exercicio)}
          disabled={loading}
          aria-label="Atualizar cruzamento de sanções federais"
          title="Recarregar o cruzamento do exercício selecionado"
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
                ? 'bg-red-500/15 font-medium text-red-300 ring-1 ring-inset ring-red-500/30'
                : 'text-slate-400 hover:bg-white/5',
            ].join(' ')}
          >
            {ano}
          </button>
        ))}
      </div>

      {loading ? (
        <Card className="border-white/5 bg-nexo-surface" aria-busy="true">
          <CardContent
            className="flex flex-col items-center gap-3 py-12 text-center"
            role="status"
          >
            <RefreshCw
              className="h-6 w-6 animate-spin text-red-400"
              aria-hidden="true"
            />
            <p className="text-sm text-slate-300">
              Coletando fornecedores de Marília e cruzando com CEIS/CNEP/CEPIM…
            </p>
          </CardContent>
        </Card>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5" role="alert">
          <CardContent className="space-y-1 py-6 text-sm text-red-300">
            <div className="flex items-center gap-3">
              <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              Não foi possível concluir a consulta: {erro}
            </div>
            <p className="pl-8 text-xs text-red-300/70">
              A API SMARAPD de Marília ou a API do Portal da Transparência
              Federal pode estar indisponível. Tente atualizar em instantes.
            </p>
          </CardContent>
        </Card>
      ) : data ? (
        <>
          {/* Token não configurado — estado NEUTRO, não é erro */}
          {!data.tokenConfigurado && (
            <Card className="border-amber-500/20 bg-nexo-surface">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                  <KeyRound className="h-4 w-4 text-amber-400" aria-hidden="true" />
                  Integração federal pendente de configuração
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-slate-300">
                <p>
                  O cruzamento com os cadastros federais (CEIS/CNEP/CEPIM)
                  precisa de um token de acesso à API do Portal da
                  Transparência Federal. A variável de ambiente{' '}
                  <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-xs text-amber-300">
                    PORTAL_TRANSPARENCIA_TOKEN
                  </code>{' '}
                  ainda não está definida no servidor.
                </p>
                <div className="rounded-md border border-white/5 bg-nexo-chrome p-3 text-xs text-slate-400">
                  <p className="mb-1.5 font-medium text-slate-300">
                    Como obter o token (gratuito):
                  </p>
                  <ol className="list-decimal space-y-1 pl-4">
                    <li>
                      Acesse{' '}
                      <span className="font-mono text-amber-300">
                        portaldatransparencia.gov.br/api-de-dados/cadastrar-email
                      </span>
                    </li>
                    <li>Faça login com a conta gov.br e cadastre um e-mail.</li>
                    <li>O token chega por e-mail em instantes.</li>
                    <li>
                      Defina{' '}
                      <span className="font-mono text-amber-300">
                        PORTAL_TRANSPARENCIA_TOKEN
                      </span>{' '}
                      no ambiente do servidor e recarregue esta página.
                    </li>
                  </ol>
                </div>
                <p className="text-xs text-slate-500">
                  {data.coleta.fornecedoresColetados === 1
                    ? 'O fornecedor da Prefeitura já foi coletado e está pronto'
                    : `Os ${data.coleta.fornecedoresColetados.toLocaleString('pt-BR')} fornecedores da Prefeitura já foram coletados e estão prontos`}{' '}
                  para o cruzamento assim que o token estiver disponível.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Banner de coleta */}
          <div
            role="status"
            aria-label="Resumo da coleta e do cruzamento"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500"
          >
            <span>
              {data.coleta.fornecedoresColetados.toLocaleString('pt-BR')}{' '}
              {plural(
                data.coleta.fornecedoresColetados,
                'fornecedor coletado',
                'fornecedores coletados',
              )}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {data.coleta.fornecedoresConsultados.toLocaleString('pt-BR')}{' '}
              {plural(
                data.coleta.fornecedoresConsultados,
                'cruzado com a CGU',
                'cruzados com a CGU',
              )}
            </span>
            {data.tokenConfigurado && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {data.resumo.fornecedoresComSancaoVigente.toLocaleString(
                    'pt-BR',
                  )}{' '}
                  com sanção vigente
                </span>
                <span aria-hidden="true">·</span>
                <span>{brl(data.resumo.valorEnvolvidoVigente)} envolvidos</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>referência {data.dataReferencia}</span>
            {data.coleta.erroEmpenhos && (
              <Badge
                variant="outline"
                className="border-red-500/30 bg-red-500/10 text-[10px] text-red-300"
              >
                falha coleta SMARAPD
              </Badge>
            )}
            {data.coleta.erroSancoes && (
              <Badge
                variant="outline"
                className="border-red-500/30 bg-red-500/10 text-[10px] text-red-300"
              >
                falha consulta CGU
              </Badge>
            )}
          </div>

          {/* Aviso de coleta parcial (token presente mas algo falhou) */}
          {data.tokenConfigurado && data.aviso && (
            <Card className="border-amber-500/20 bg-amber-500/5" role="alert">
              <CardContent className="flex items-center gap-3 py-4 text-sm text-amber-300">
                <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
                {data.aviso}
              </CardContent>
            </Card>
          )}

          {/* Alertas FR-04 */}
          {data.alertas.length > 0 && (
            <Card className="border-red-500/20 bg-nexo-surface">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-200">
                  <ShieldAlert className="h-4 w-4 text-red-400" aria-hidden="true" />
                  {data.alertas.length}{' '}
                  {plural(
                    data.alertas.length,
                    'indício detectado',
                    'indícios detectados',
                  )}{' '}
                  — FR-04
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
                          {classeRotulo(a.classificacao)}
                        </Badge>
                        <span className="font-mono text-[10px] text-slate-500">
                          {a.detectorId}
                        </span>
                      </div>
                      <span className="font-mono text-xs text-red-300">
                        {brl(a.valorEnvolvido)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm text-slate-200">{a.titulo}</p>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {a.descricao}
                    </p>
                    {a.evidencias.length > 0 && (
                      <ul className="mt-2 space-y-0.5 border-l border-white/10 pl-3">
                        {a.evidencias.map((ev, i) => (
                          <li key={i} className="text-[11px] text-slate-500">
                            {ev.resumo}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-2 text-[11px] text-slate-500">
                      {a.explicacao}
                    </p>
                    <p className="mt-1.5 text-[10px] text-slate-400">
                      Fundamento: {a.fundamentoLegal.join(' · ')}
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Sem indícios — estado positivo */}
          {data.tokenConfigurado &&
            data.alertas.length === 0 &&
            !data.coleta.erroSancoes && (
              <Card className="border-emerald-500/20 bg-emerald-500/5" role="status">
                <CardContent className="flex items-center gap-3 py-5 text-sm text-emerald-300">
                  <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
                  {data.coleta.fornecedoresConsultados === 1
                    ? 'O fornecedor cruzado não consta'
                    : `Nenhum dos ${data.coleta.fornecedoresConsultados.toLocaleString('pt-BR')} maiores fornecedores cruzados consta`}{' '}
                  com sanção federal vigente nos cadastros CEIS/CNEP/CEPIM na
                  data de referência.
                </CardContent>
              </Card>
            )}

          {/* Tabela de fornecedores cruzados */}
          <Card className="border-white/5 bg-nexo-surface">
            <CardHeader>
              <CardTitle className="text-base text-slate-200">
                Maiores fornecedores cruzados — {exercicio}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.fornecedores.length === 0 ? (
                <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
                  Nenhum fornecedor (pessoa jurídica) retornado pelo portal de
                  Marília para este exercício.
                </div>
              ) : (
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead scope="col" className="text-slate-400">
                        Fornecedor
                      </TableHead>
                      <TableHead scope="col" className="text-slate-400">
                        CNPJ
                      </TableHead>
                      <TableHead scope="col" className="text-right text-slate-400">
                        Empenhado
                      </TableHead>
                      <TableHead scope="col" className="text-slate-400">
                        Situação federal
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.fornecedores.map((f) => {
                      const cadastros = Array.from(
                        new Set(f.sancoes.map((s) => s.cadastro)),
                      ).join(', ');
                      return (
                        <TableRow
                          key={f.cnpj}
                          className="border-white/5 hover:bg-white/5"
                        >
                          <TableCell className="max-w-[18rem] truncate font-medium text-slate-200">
                            {f.nome || '—'}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-slate-400">
                            {formatCnpj(f.cnpj)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-slate-300">
                            {brl(f.valorEmpenhado)}
                          </TableCell>
                          <TableCell>
                            {!data.tokenConfigurado ? (
                              <span className="text-xs text-slate-400">
                                não verificado
                              </span>
                            ) : f.temSancaoVigente ? (
                              <Badge
                                variant="outline"
                                className="border-red-500/30 bg-red-500/10 text-[10px] text-red-300"
                              >
                                sanção vigente · {cadastros}
                              </Badge>
                            ) : f.sancoes.length > 0 ? (
                              <Badge
                                variant="outline"
                                className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300"
                              >
                                histórico · {cadastros}
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300"
                              >
                                sem sanção
                              </Badge>
                            )}
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
  );
}
