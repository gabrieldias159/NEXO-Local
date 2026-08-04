'use client';

import { useEffect, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import { TrendingUp, Calendar, Info, Layers, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import type { OrcamentoSerieResponse, PontoSerieMensal, FonteReceita, FonteDespesa } from '@/app/api/nexo/orcamento-serie/route';

interface GraficoSerieOrcamentariaProps {
  exercicio: number;
}

type ModoPeriodo = '12m' | 'ano';
type ModoAcumulacao = 'mensal' | 'acumulado';
type ValorGrafico = number | null;

function brlCurto(v: number): string {
  if (Math.abs(v) >= 1_000_000_000) {
    return `R$ ${(v / 1_000_000_000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} bi`;
  }
  if (Math.abs(v) >= 1_000_000) {
    return `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} mi`;
  }
  return `R$ ${(v / 1_000).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} k`;
}

function brlCompleto(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 2 });
}

function formatarTooltipValor(v: ValorGrafico): string {
  return v == null ? 'Sem dado observavel' : brlCompleto(v);
}

export function GraficoSerieOrcamentaria({ exercicio }: GraficoSerieOrcamentariaProps) {
  const [data, setData] = useState<OrcamentoSerieResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [erro, setErro] = useState<string | null>(null);
  const [periodo, setPeriodo] = useState<ModoPeriodo>('ano');
  const [modo, setModo] = useState<ModoAcumulacao>('acumulado');
  const [fonteReceita, setFonteReceita] = useState<FonteReceita>('auto');
  // Padrão = consolidado oficial (RREO An. 01, inclui IPREMM): é o número que
  // fecha com o balanço assinado — o Portal fica como opção de maior frescor.
  const [fonteDespesa, setFonteDespesa] = useState<FonteDespesa>('siconfi');

  // Modo consolidado (RREO An. 01): fonte bimestral — janela de 12 meses não
  // se aplica (cruzaria exercícios com pontos só nos meses pares).
  const consolidado = fonteDespesa === 'siconfi';
  useEffect(() => {
    if (consolidado && periodo === '12m') setPeriodo('ano');
  }, [consolidado, periodo]);

  useEffect(() => {
    let ativo = true;
    setLoading(true);
    setErro(null);

    async function carregar() {
      try {
        const res = await nexoFetch(
          `/api/nexo/orcamento-serie?exercicio=${exercicio}&fonteReceita=${fonteReceita}&fonteDespesa=${fonteDespesa}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as OrcamentoSerieResponse;
        if (ativo) {
          setData(json);
          setLoading(false);
        }
      } catch (err) {
        if (ativo) {
          setErro(err instanceof Error ? err.message : 'Erro ao carregar gráfico');
          setLoading(false);
        }
      }
    }

    void carregar();
    return () => {
      ativo = false;
    };
  }, [exercicio, fonteReceita, fonteDespesa]);

  const serieAtual = periodo === '12m' ? (data?.serie12m ?? []) : (data?.serieAno ?? []);

  const dataChart = serieAtual.map((p) => ({
    chave: p.chave,
    label: p.nomeMes,
    empenhado: modo === 'mensal' ? p.empenhadoMes : (periodo === '12m' ? p.empenhadoAcum12m : p.empenhadoAcum),
    liquidado: modo === 'mensal' ? p.liquidadoMes : (periodo === '12m' ? p.liquidadoAcum12m : p.liquidadoAcum),
    pago: modo === 'mensal' ? p.pagoMes : (periodo === '12m' ? p.pagoAcum12m : p.pagoAcum),
    arrecadado: modo === 'mensal' ? p.arrecadadoMes : (periodo === '12m' ? p.arrecadadoAcum12m : p.arrecadadoAcum),
    arrecadadoFonte: p.arrecadadoFonte,
  }));

  return (
    <Card className="border border-white/10 bg-nexo-chrome shadow-xl">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pb-4 border-b border-white/5">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-amber-400" />
          <div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-base font-semibold text-slate-100">
                Evolução da Execução vs. Arrecadação ({exercicio})
              </CardTitle>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-white/10 text-[10px] text-slate-300 hover:bg-white/20 focus:outline-none"
                      aria-label="Informações pedagógicas sobre o gráfico"
                    >
                      <Info className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    align="start"
                    className="w-80 sm:w-96 rounded-xl border border-white/10 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-md text-slate-200"
                  >
                    <div className="space-y-2.5">
                      <div className="font-semibold text-sm text-amber-200 border-b border-white/10 pb-1.5">
                        Guia Explicativo — Série Orçamentária
                      </div>
                      <div>
                        <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                          O que são as linhas do gráfico?
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-slate-300">
                          Permite comparar em uma única linha do tempo os quatro fluxos vitais do município:
                          a <span className="text-emerald-400 font-medium">Arrecadação (Receita)</span> com as 3 fases legais da despesa (<span className="text-amber-400 font-medium">Empenhado</span>, <span className="text-blue-400 font-medium">Liquidado</span> e <span className="text-violet-400 font-medium">Pago</span>).
                        </p>
                      </div>
                      <div>
                        <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                          Mês a Mês vs. Acumulado
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-slate-300">
                          • <strong className="text-white">Mês a Mês:</strong> Mostra o montante isolado movimentado em cada mês, facilitando identificar picos sazonais (ex.: 13º salário, IPTU).<br />
                          • <strong className="text-white">Acumulado:</strong> Soma contínua do período selecionado, ideal para auditar se a despesa acumulada ultrapassou a arrecadação.
                        </p>
                      </div>
                      <div>
                        <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                          Últimos 12 Meses vs. Somente Este Ano
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-slate-300">
                          • <strong className="text-white">Últimos 12 Meses:</strong> Janela móvel de 12 meses (art. 2º § 3º da LRF), unindo o histórico recente ao ano atual.<br />
                          • <strong className="text-white">Somente Este Ano:</strong> Restringe a visualização de Janeiro a Dezembro do exercício fiscal selecionado ({exercicio}).
                        </p>
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Comparativo mês a mês dos estágios da despesa (Empenho, Liquidação e Pagamento) contra a receita arrecadada.
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">
              {consolidado ? (
                <>
                  Fonte: RREO Anexo 01 (SICONFI) CONSOLIDADO — inclui autarquias e fundos (IPREMM etc.);
                  é o número do balanço oficial. Publicação bimestral: pontos nos meses pares.
                </>
              ) : (
                <>
                  Fonte da despesa: Portal da Transparência (SMARAPD) — recorte menor que o RREO/SICONFI
                  consolidado (não inclui autarquias/fundos); os cards acima usam SICONFI. Receita: SMARAPD com
                  fallback SICONFI. Para o retrato oficial completo, use “SICONFI consolidado”.
                </>
              )}
            </p>
          </div>
        </div>

        {/* Controles interativos do Gráfico */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Seletor de Período (Últimos 12m vs Somente Este Ano) */}
          <div className="inline-flex rounded-lg border border-white/10 bg-slate-900/60 p-0.5">
            <button
              type="button"
              onClick={() => setPeriodo('12m')}
              disabled={consolidado}
              title={consolidado ? 'Indisponível no modo consolidado (fonte bimestral)' : undefined}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                consolidado
                  ? 'cursor-not-allowed text-slate-600'
                  : periodo === '12m'
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow'
                    : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Calendar className="h-3 w-3" />
              Últimos 12 meses
            </button>
            <button
              type="button"
              onClick={() => setPeriodo('ano')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                periodo === 'ano'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Calendar className="h-3 w-3" />
              Somente este ano
            </button>
          </div>

          {/* Seletor de Modo (Mês a Mês vs Acumulado) */}
          <div className="inline-flex rounded-lg border border-white/10 bg-slate-900/60 p-0.5">
            <button
              type="button"
              onClick={() => setModo('mensal')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                modo === 'mensal'
                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers className="h-3 w-3" />
              Mês a Mês
            </button>
            <button
              type="button"
              onClick={() => setModo('acumulado')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                modo === 'acumulado'
                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30 shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers className="h-3 w-3" />
              Acumulado
            </button>
          </div>

          {/* Seletor da FONTE da receita — o usuário escolhe qual medição ver.
              'Auto' usa o Portal e cai na média SICONFI onde o Portal não
              publica; as opções puras nunca misturam fontes. */}
          <div className="inline-flex rounded-lg border border-white/10 bg-slate-900/60 p-0.5" role="group" aria-label="Fonte da receita">
            {([
              { valor: 'auto', rotulo: 'Receita: Auto' },
              { valor: 'smarapd', rotulo: 'Portal' },
              { valor: 'siconfi', rotulo: 'SICONFI (média)' },
            ] as { valor: FonteReceita; rotulo: string }[]).map((f) => (
              <button
                key={f.valor}
                type="button"
                aria-pressed={!consolidado && fonteReceita === f.valor}
                disabled={consolidado}
                title={consolidado ? 'No modo consolidado a receita vem do próprio RREO An. 01' : undefined}
                onClick={() => setFonteReceita(f.valor)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                  consolidado
                    ? 'cursor-not-allowed text-slate-600'
                    : fonteReceita === f.valor
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {f.rotulo}
              </button>
            ))}
          </div>

          {/* Seletor da FONTE da despesa: Síntese (3 estágios, publica após o
              mês fechar) × Documentos (empenhos datados — inclui o mês corrente
              parcial; liquidado/pago não têm mensal nesta fonte). */}
          <div className="inline-flex rounded-lg border border-white/10 bg-slate-900/60 p-0.5" role="group" aria-label="Fonte da despesa">
            {([
              { valor: 'sintese', rotulo: 'Despesa: Síntese' },
              { valor: 'documentos', rotulo: 'Documentos' },
              { valor: 'siconfi', rotulo: 'SICONFI consolidado' },
            ] as { valor: FonteDespesa; rotulo: string }[]).map((f) => (
              <button
                key={f.valor}
                type="button"
                aria-pressed={fonteDespesa === f.valor}
                onClick={() => setFonteDespesa(f.valor)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                  fonteDespesa === f.valor
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {f.rotulo}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-6">
        {loading ? (
          <div className="flex h-72 w-full flex-col items-center justify-center gap-3 text-slate-400">
            <Loader2 className="h-7 w-7 animate-spin text-amber-400" />
            <span className="text-xs">Carregando série histórica de empenho e arrecadação...</span>
          </div>
        ) : erro ? (
          <div className="flex h-72 w-full flex-col items-center justify-center gap-2 text-red-400">
            <span className="text-xs font-medium">Não foi possível carregar a série orçamentária</span>
            <span className="text-[11px] text-slate-400">{erro}</span>
          </div>
        ) : dataChart.length === 0 ? (
          <div className="flex h-72 w-full items-center justify-center text-xs text-slate-400">
            Nenhum dado mensal encontrado para o período selecionado.
          </div>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dataChart} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke="#94a3b8"
                  fontSize={11}
                  tickLine={false}
                  axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                />
                <YAxis
                  stroke="#94a3b8"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(val) => brlCurto(Number(val))}
                  width={68}
                />
                <RechartsTooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const arrec = payload.find((p) => p.dataKey === 'arrecadado')?.value as ValorGrafico;
                    const emp = payload.find((p) => p.dataKey === 'empenhado')?.value as ValorGrafico;
                    const liq = payload.find((p) => p.dataKey === 'liquidado')?.value as ValorGrafico;
                    const pag = payload.find((p) => p.dataKey === 'pago')?.value as ValorGrafico;

                    const estourouEmp = emp != null && arrec != null && emp > arrec && arrec > 0;
                    const estourouLiq = liq != null && arrec != null && liq > arrec && arrec > 0;
                    const ponto = payload[0]?.payload as (typeof dataChart)[number] | undefined;
                    const receitaEstimada = ponto?.arrecadadoFonte === 'siconfi-media';

                    return (
                      <div className="rounded-xl border border-white/10 bg-slate-950/95 p-3.5 shadow-2xl backdrop-blur-md text-slate-200 min-w-[260px]">
                        <div className="border-b border-white/10 pb-2 mb-2">
                          <div className="text-xs font-semibold text-slate-100">{label}</div>
                          <div className="text-[10px] text-slate-400">
                            {modo === 'mensal'
                              ? 'Valores apurados no mês'
                              : periodo === '12m'
                                ? 'Acumulado na JANELA MÓVEL de 12 meses (cruza exercícios — não é o total do ano)'
                                : 'Valores acumulados no exercício'}
                          </div>
                          {fonteDespesa === 'documentos' && (
                            <div className="mt-0.5 text-[10px] text-amber-300/80">
                              Despesa: DOCUMENTOS de empenho datados (inclui mês corrente parcial). Liquidado/Pago não têm mensal nesta fonte.
                            </div>
                          )}
                          {consolidado && (
                            <div className="mt-0.5 text-[10px] text-sky-300/80">
                              CONSOLIDADO RREO An. 01 — inclui autarquias e fundos (IPREMM etc.).{' '}
                              {modo === 'mensal' ? 'Valor do BIMESTRE fechado neste mês.' : 'Acumulado oficial até o bimestre.'}
                            </div>
                          )}
                          {receitaEstimada && (
                            <div className="mt-0.5 text-[10px] text-amber-300/80">
                              Receita deste mês: ESTIMATIVA (média do total SICONFI ÷ 12) — o Portal não publica o mensal deste exercício.
                            </div>
                          )}
                        </div>

                        <div className="space-y-1.5 text-xs">
                          <div className="flex items-center justify-between gap-4">
                            <span className="flex items-center gap-1.5 font-medium text-emerald-400">
                              <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
                              Arrecadado (Receita):
                            </span>
                            <span className="font-mono text-slate-100">{formatarTooltipValor(arrec)}</span>
                          </div>

                          <div className="flex items-center justify-between gap-4">
                            <span className="flex items-center gap-1.5 font-medium text-amber-400">
                              <span className="h-2 w-2 rounded-full bg-amber-500 inline-block" />
                              Empenhado (Mês/Acum):
                            </span>
                            <span className="font-mono text-slate-100">{formatarTooltipValor(emp)}</span>
                          </div>

                          <div className="flex items-center justify-between gap-4">
                            <span className="flex items-center gap-1.5 font-medium text-blue-400">
                              <span className="h-2 w-2 rounded-full bg-blue-500 inline-block" />
                              Liquidado (Mês/Acum):
                            </span>
                            <span className="font-mono text-slate-100">{formatarTooltipValor(liq)}</span>
                          </div>

                          <div className="flex items-center justify-between gap-4">
                            <span className="flex items-center gap-1.5 font-medium text-violet-400">
                              <span className="h-2 w-2 rounded-full bg-violet-500 inline-block" />
                              Pago (Mês/Acum):
                            </span>
                            <span className="font-mono text-slate-100">{formatarTooltipValor(pag)}</span>
                          </div>
                        </div>

                        {(estourouEmp || estourouLiq) && (
                          <div className="mt-2.5 rounded border border-red-500/30 bg-red-500/10 p-2 text-[10px] text-red-200">
                            <strong>⚠️ Alerta Fiscal:</strong> No período, o valor {estourouEmp ? 'empenhado' : 'liquidado'} ultrapassou a receita arrecadada correspondente.
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                <Legend
                  verticalAlign="top"
                  height={36}
                  formatter={(value) => {
                    const dict: Record<string, string> = {
                      empenhado: 'Empenhado no Mês',
                      liquidado: 'Liquidado no Mês',
                      pago: 'Pago no Mês',
                      arrecadado: 'Arrecadado no Mês',
                    };
                    const dictAcum: Record<string, string> = {
                      empenhado: 'Empenhado Acumulado',
                      liquidado: 'Liquidado Acumulado',
                      pago: 'Pago Acumulado',
                      arrecadado: 'Arrecadado Acumulado',
                    };
                    const lbl = modo === 'mensal' ? (dict[value] ?? value) : (dictAcum[value] ?? value);
                    return <span className="text-xs font-medium text-slate-300">{lbl}</span>;
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="arrecadado"
                  name="arrecadado"
                  connectNulls={consolidado}
                  stroke="#10b981"
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: '#10b981', strokeWidth: 0 }}
                  activeDot={{ r: 6, stroke: '#065f46', strokeWidth: 2 }}
                />
                <Line
                  type="monotone"
                  dataKey="empenhado"
                  name="empenhado"
                  connectNulls={consolidado}
                  stroke="#f59e0b"
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: '#f59e0b', strokeWidth: 0 }}
                  activeDot={{ r: 6, stroke: '#92400e', strokeWidth: 2 }}
                />
                <Line
                  type="monotone"
                  dataKey="liquidado"
                  name="liquidado"
                  connectNulls={consolidado}
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#3b82f6', strokeWidth: 0 }}
                  activeDot={{ r: 5, stroke: '#1e40af', strokeWidth: 2 }}
                />
                <Line
                  type="monotone"
                  dataKey="pago"
                  name="pago"
                  connectNulls={consolidado}
                  stroke="#8b5cf6"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#8b5cf6', strokeWidth: 0 }}
                  activeDot={{ r: 5, stroke: '#5b21b6', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
