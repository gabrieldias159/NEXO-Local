'use client';

/**
 * NEXO — Execução Orçamentária.
 *
 * Lista cada RUBRICA com a dotação do orçamento do ano (inicial e autorizada,
 * já com créditos/emendas) e quanto foi USADO (empenhado/liquidado/pago), com
 * BARRA DE PROGRESSO do % executado e destaque de ESTOURO (> 100%). Agrupável
 * por rubrica, função ou órgão. Anos 2026/2025. Fonte: /api/nexo/orcamento.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpDown, ChevronRight, Landmark, Loader2, RefreshCw, TriangleAlert, Info, AlertCircle, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OrcamentoResponse, OrcamentoAgregados, AgruparPor, ItemOrcamento } from '@/app/api/nexo/orcamento/route';
import type { MetasFiscaisResponse, IndicadorApurado } from '@/app/api/nexo/metas-fiscais/route';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { GraficoSerieOrcamentaria } from '@/components/nexo/orcamento/GraficoSerieOrcamentaria';

const EXERCICIOS = [2026, 2025];
const TAMANHOS = [25, 50, 100];

function brl(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}
function pct1(v: number): string {
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

/** Métricas de execução por rubrica: fluxo autorizada → empenhado → liquidado → pago. */
function calcMetricas(i: ItemOrcamento) {
  return [
    {
      chave: 'emp-aut',
      label: 'Empenhado / Dotação autorizada',
      pct: i.pctExecucao,
      num: i.empenhado,
      den: i.dotacaoAutorizada,
      estourado: i.estourado,
      cor: i.estourado ? 'bg-red-500' : i.pctExecucao >= 80 ? 'bg-amber-400' : 'bg-emerald-500',
      titulo: 'Execução Orçamentária — Empenhado vs. Dotação',
      subtitulo: 'Lei nº 4.320/64, art. 58',
      conceito:
        'Mede a porcentagem do orçamento autorizado (LOA + Créditos Adicionais) que já foi comprometido através de notas de empenho para contratos, compras e convênios.',
      formula: '(Total Empenhado ÷ Dotação Autorizada) × 100',
      numeradorLabel: 'Empenhado (Comprometido)',
      denominadorLabel: 'Dotação Autorizada (LOA + Créditos)',
      significado: i.estourado
        ? '⚠️ ALERTA CRÍTICO: O valor empenhado ultrapassou o teto da dotação autorizada por lei para esta rubrica. Exige abertura de crédito suplementar para regularização.'
        : i.pctExecucao >= 80
        ? 'Atenção: Comprometimento superior a 80% da dotação. Monitorar saldo disponível para evitar estouro da rubrica.'
        : 'Execução regular e controlada, dentro do limite orçamentário planejado para a rubrica.',
    },
    {
      chave: 'liq-emp',
      label: 'Liquidado / Empenhado',
      pct: i.empenhado > 0 ? (i.liquidado / i.empenhado) * 100 : 0,
      num: i.liquidado,
      den: i.empenhado,
      estourado: false,
      cor: 'bg-blue-500',
      titulo: 'Liquidação da Despesa — Liquidado vs. Empenhado',
      subtitulo: 'Lei nº 4.320/64, art. 63',
      conceito:
        'Mede a proporção dos valores empenhados em que o credor já cumpriu a prestação (entregou bens ou executou serviços e obras), gerando direito adquirido ao pagamento.',
      formula: '(Total Liquidado ÷ Total Empenhado) × 100',
      numeradorLabel: 'Liquidado (Atestado/Entregue)',
      denominadorLabel: 'Empenhado (Comprometido)',
      significado:
        'Indica o ritmo real de entrega dos fornecedores e execução das obras/serviços. A diferença entre o empenhado e o liquidado representa obrigações em andamento (a liquidar).',
    },
    {
      chave: 'pag-liq',
      label: 'Pago / Liquidado',
      pct: i.liquidado > 0 ? (i.pago / i.liquidado) * 100 : 0,
      num: i.pago,
      den: i.liquidado,
      estourado: false,
      cor: 'bg-violet-500',
      titulo: 'Efetivação Financeira — Pago vs. Liquidado',
      subtitulo: 'Lei nº 4.320/64, art. 64',
      conceito:
        'Mede o percentual das despesas já liquidadas (serviços entregues e atestados) que foram efetivamente pagas mediante desembolso financeiro ao credor.',
      formula: '(Total Pago ÷ Total Liquidado) × 100',
      numeradorLabel: 'Pago (Desembolsado)',
      denominadorLabel: 'Liquidado (Atestado/Entregue)',
      significado:
        'Demonstra a regularidade e adimplência do fluxo financeiro com os credores. Quanto mais próximo de 100%, menor a geração de Restos a Pagar Processados (RAP Processado).',
    },
  ];
}

/** Barras de execução sempre visíveis: fluxo empenho → liquidação → pagamento. */
function BarrasExecucao({ item }: { item: ItemOrcamento }) {
  const metricas = calcMetricas(item);
  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-1.5 min-w-0">
        {metricas.map((m) => {
          const larg = Math.min(100, Math.max(0, m.pct));
          const semBase = m.den <= 0;
          return (
            <Tooltip key={m.chave}>
              <TooltipTrigger asChild>
                <div className="cursor-help rounded px-1 -mx-1 transition-colors hover:bg-white/5 py-0.5">
                  <div className="flex items-center justify-between text-[10px] leading-tight">
                    <span className="truncate text-slate-400 font-medium flex items-center gap-1">
                      {m.chave === 'emp-aut' ? (m.estourado ? 'Estourado' : 'Executado') : m.chave === 'liq-emp' ? 'Liquidado' : 'Pago'}
                    </span>
                    <span className={'ml-2 shrink-0 font-semibold ' + (semBase ? 'text-slate-400' : m.estourado ? 'text-red-300' : 'text-slate-200')}>
                      {semBase ? '—' : pct1(m.pct)}
                    </span>
                  </div>
                  <div className="mt-px h-1.5 w-full overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label={m.label} aria-valuenow={Math.round(m.pct)} aria-valuemin={0} aria-valuemax={100}>
                    <div className={'h-full rounded-full ' + m.cor} style={{ width: `${larg}%` }} />
                  </div>
                  {!semBase && (
                    <div className="text-[9px] leading-tight text-slate-400 mt-0.5">{brl(m.num)} / {brl(m.den)}</div>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="left"
                align="center"
                className="w-80 sm:w-96 max-w-[90vw] rounded-xl border border-white/10 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-md text-slate-200 z-50"
              >
                <div className="space-y-2.5">
                  <div className="border-b border-white/10 pb-2">
                    <div className="font-semibold text-xs text-white">{m.titulo}</div>
                    <div className="text-[10px] text-amber-300/80 mt-0.5">{m.subtitulo}</div>
                  </div>
                  <div>
                    <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">O que é a barra de progresso?</div>
                    <p className="mt-1 text-xs leading-relaxed text-slate-300">{m.conceito}</p>
                  </div>
                  <div className="rounded bg-white/5 p-2.5 space-y-1.5">
                    <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Sobre quais informações se baseia o %?</div>
                    <div className="text-[11px] font-mono text-slate-300 bg-black/40 px-2 py-1 rounded border border-white/5">
                      {m.formula}
                    </div>
                    <div className="grid grid-cols-2 gap-2 pt-1 text-[11px]">
                      <div>
                        <span className="text-slate-400 block text-[10px]">{m.numeradorLabel}:</span>
                        <span className="font-semibold text-white">{brl(m.num)}</span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px]">{m.denominadorLabel}:</span>
                        <span className="font-semibold text-white">{brl(m.den)}</span>
                      </div>
                    </div>
                    <div className="pt-1 border-t border-white/10 flex justify-between items-center text-xs">
                      <span className="text-slate-400 font-medium">Percentual Atingido:</span>
                      <span className={`font-bold ${m.estourado ? 'text-red-300' : 'text-emerald-400'}`}>
                        {semBase ? 'Sem base de dotação' : pct1(m.pct)}
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">O que significa na prática?</div>
                    <p className="mt-1 text-xs leading-relaxed text-slate-300">{m.significado}</p>
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

/** Estado do drill-down de um grupo (órgão/unidade/função). */
type DetalheEstado = { loading: boolean; itens?: ItemOrcamento[]; erro?: string };

/** Leitura executiva: o que importa em linguagem simples, antes dos números. */
function LeituraExecutiva({
  exercicio,
  ag,
  alertasFiscais,
  rclAno,
}: {
  exercicio: number;
  ag: OrcamentoAgregados | null;
  alertasFiscais: MetasFiscaisResponse['alertasFiscais'];
  rclAno?: { rcl: number | null; periodo: string | null; indicadores?: IndicadorApurado[] };
}) {
  if (!ag) return null;  const ex = rclAno;
  const pessoal = ex?.indicadores?.find((i) => i.chave === 'pessoal_executivo');
  const divida = ex?.indicadores?.find((i) => i.chave === 'divida');
  const itens: Array<{ nivel: 'ok' | 'aviso' | 'critico'; texto: string }> = [];

  if (ag.pctExecucaoGlobal >= 80) {
    itens.push({
      nivel: ag.pctExecucaoGlobal > 100 ? 'critico' : 'aviso',
      texto: `Execução de ${pct1(ag.pctExecucaoGlobal)} da dotação autorizada — acima de 80%, vale acompanhar de perto.`,
    });
  }

  if (ag.estouradas > 0) {
    itens.push({
      nivel: 'critico',
      texto: `${ag.estouradas.toLocaleString('pt-BR')} rubrica(s) empenharam mais do que a lei autorizou (estouro). Clique em "Estourado" no filtro para ver quais.`,
    });
  }

  if (pessoal?.valor != null) {
    const sobreAlerta = pessoal.valor >= 54;
    const perto = pessoal.valor >= 48.6;
    itens.push({
      nivel: sobreAlerta ? 'critico' : perto ? 'aviso' : 'ok',
      texto: `Gastos com pessoal do Executivo em ${pessoal.valor.toFixed(1)}% da RCL — limite legal ${sobreAlerta ? 'ultrapassado (54%)' : perto ? 'perto do alerta de 48,6% da LRF' : 'dentro do limite de 54%'}.`,
    });
  }

  if (divida?.valor != null) {
    const sobre = divida.valor >= 120;
    itens.push({
      nivel: sobre ? 'critico' : 'aviso',
      texto: `Dívida Consolidada em ${divida.valor.toFixed(1)}% da RCL — limite legal de 120% (Res. Senado 40/2001) ${sobre ? 'ultrapassado' : 'respeitado'}.`,
    });
  }

  const alertaMF09 = alertasFiscais.find((a) => a.detectorId === 'MF-09');
  if (alertaMF09) {
    itens.push({ nivel: 'aviso', texto: `${alertaMF09.titulo}: ${alertaMF09.descricao}` });
  }

  if (itens.length === 0) {
    itens.push({
      nivel: 'ok',
      texto: `Orçamento de ${exercicio} sem alertas neste recorte: execução dentro dos limites e rubricas dentro da dotação.`,
    });
  }

  const cor = { ok: 'text-emerald-400', aviso: 'text-amber-300', critico: 'text-red-400' } as const;

  return (
    <div className="rounded-md border border-white/10 bg-nexo-surface px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-300">
        <FileText aria-hidden className="h-3.5 w-3.5 text-amber-400" />
        Leitura executiva
      </div>
      <ul className="space-y-1.5">
        {itens.map((i, idx) => (
          <li key={idx} className="flex items-start gap-2 text-sm leading-snug text-slate-200">
            <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${cor[i.nivel]}`} />
            <span>{i.texto}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Nó da árvore de execução: órgão → unidade/secretaria → rubrica. Renderiza a
 * linha do item e, quando EXPANSÍVEL e aberto, seus filhos (recursivo — uma
 * unidade abre nas rubricas; um órgão abre nas unidades). É FOLHA (não expande)
 * quando o agrupamento é 'rubrica' ou quando o id é de rubrica (contém '|').
 */
function NoOrcamento({
  item,
  depth,
  agruparPor,
  expandidos,
  detalhes,
  onToggle,
}: {
  item: ItemOrcamento;
  depth: number;
  agruparPor: AgruparPor;
  expandidos: Set<string>;
  detalhes: Record<string, DetalheEstado>;
  onToggle: (id: string, nivel: 'unidade' | 'rubrica') => void;
}) {
  const ehFolha = agruparPor === 'rubrica' || item.id.includes('|');
  const expansivel = !ehFolha;
  // Que nível os FILHOS deste nó representam: no agrupamento por órgão, o topo
  // (depth 0 = órgão) abre nas UNIDADES/secretarias; qualquer nível abaixo (e o
  // agrupamento por função) abre nas RUBRICAS.
  const nivelFilhos: 'unidade' | 'rubrica' =
    agruparPor === 'orgao' && depth === 0 ? 'unidade' : 'rubrica';
  const aberto = expansivel && expandidos.has(item.id);
  const det = detalhes[item.id];
  const painelId = `det-${item.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const denso = depth > 0;
  const badge =
    typeof item.nUnidades === 'number'
      ? `${item.nUnidades.toLocaleString('pt-BR')} unidade(s)`
      : typeof item.nRubricas === 'number'
        ? `${item.nRubricas.toLocaleString('pt-BR')} rubrica(s)`
        : null;

  const linha = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      {expansivel ? (
        <ChevronRight
          aria-hidden
          className={`mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform sm:mt-0 ${aberto ? 'rotate-90 text-amber-300' : ''}`}
        />
      ) : (
        depth > 0 && <span aria-hidden className="hidden w-4 shrink-0 sm:block" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`truncate ${denso ? 'text-sm text-slate-300' : 'font-medium text-slate-200'}`} title={item.titulo}>{item.titulo}</span>
          {badge && <Badge variant="outline" className="border-white/10 text-[10px] text-slate-400">{badge}</Badge>}
        </div>
        <div className="truncate text-[11px] text-slate-400" title={item.subtitulo}>{item.subtitulo}</div>
      </div>
      <div className="grid grid-cols-4 gap-1 text-right text-xs sm:w-[370px]">
        <div><div className="text-slate-400" title="Dotação autorizada (com créditos e emendas)">Autorizada</div><div className={'font-medium ' + (denso ? 'text-slate-300' : 'text-slate-200')}>{brl(item.dotacaoAutorizada)}</div></div>
        <div><div className="text-slate-400" title="Valor empenhado — comprometido">→ Empenhado</div><div className={denso ? 'text-slate-300' : 'text-slate-200'}>{brl(item.empenhado)}</div></div>
        <div><div className="text-slate-400" title="Valor liquidado — serviço executado">→ Liquidado</div><div className={denso ? 'text-slate-300' : 'text-slate-200'}>{brl(item.liquidado)}</div></div>
        <div><div className="text-slate-400" title="Valor efetivamente pago">→ Pago</div><div className="text-slate-400">{brl(item.pago)}</div></div>
      </div>
      <div className="sm:w-[280px]"><BarrasExecucao item={item} /></div>
    </div>
  );

  const borda = item.estourado ? (denso ? 'border-red-500/20' : 'border-red-500/30') : 'border-white/5';
  const fundo = denso ? 'bg-white/[0.02]' : 'bg-nexo-chrome';

  if (!expansivel) {
    return <div className={`rounded-md border px-3 py-2.5 ${borda} ${fundo}`}>{linha}</div>;
  }

  return (
    <div className={`rounded-md border ${borda} ${fundo}`}>
      <button
        type="button"
        onClick={() => onToggle(item.id, nivelFilhos)}
        aria-expanded={aberto}
        aria-controls={painelId}
        aria-label={`${aberto ? 'Recolher' : 'Expandir'} ${item.titulo}`}
        className="block w-full rounded-md px-4 py-3 text-left transition-colors hover:bg-white/[0.03] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-amber-500/40"
      >
        {linha}
      </button>
      {aberto && (
        <div id={painelId} className="space-y-1.5 border-t border-white/5 px-3 py-3 pl-6 sm:pl-9">
          {det?.loading ? (
            <div className="flex items-center gap-2 py-2 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando…</div>
          ) : det?.erro ? (
            <div className="py-2 text-xs text-red-300">Falha ao carregar: {det.erro}</div>
          ) : det?.itens && det.itens.length > 0 ? (
            det.itens.map((f) => (
              <NoOrcamento
                key={f.id}
                item={f}
                depth={depth + 1}
                agruparPor={agruparPor}
                expandidos={expandidos}
                detalhes={detalhes}
                onToggle={onToggle}
              />
            ))
          ) : (
            <div className="py-2 text-xs text-slate-400">Nada neste recorte.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function OrcamentoPage() {
  const [exercicio, setExercicio] = useState(2026);
  // 'orgao' é o padrão — visão "orçamento geral" com drill-down expansível.
  const [agruparPor, setAgruparPor] = useState<AgruparPor>('orgao');
  const [q, setQ] = useState('');
  const [orgao, setOrgao] = useState('');
  const [situacao, setSituacao] = useState('todas');
  const [ordenarPor, setOrdenarPor] = useState('autorizada');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  const [filtros, setFiltros] = useState({ q: '', orgao: '' });
  useEffect(() => {
    const t = setTimeout(() => {
      setFiltros({ q, orgao });
      setPageIndex(0);
    }, 400);
    return () => clearTimeout(t);
  }, [q, orgao]);

  const [data, setData] = useState<OrcamentoResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const reqId = useRef(0);

  // Painel de alertas fiscais + RCL + indicadores — carregado ao trocar exercício.
  const [alertasFiscais, setAlertasFiscais] = useState<MetasFiscaisResponse['alertasFiscais']>([]);
  interface RclAno {
    rcl: number | null;
    periodo: string | null;
    indicadores: IndicadorApurado[];
    execucao: MetasFiscaisResponse['execucao'] | null;
  }
  const [rclPorAno, setRclPorAno] = useState<Record<number, RclAno>>({});
  useEffect(() => {
    nexoFetch(`/api/nexo/metas-fiscais?exercicio=${exercicio}`)
      .then((r) => r.ok ? r.json() as Promise<MetasFiscaisResponse> : Promise.reject())
      .then((j) => {
        setAlertasFiscais(j.alertasFiscais ?? []);
        setRclPorAno((prev) => ({
          ...prev,
          [exercicio]: {
            rcl: j.rcl?.valor ?? null,
            periodo: j.rcl?.periodo ?? null,
            indicadores: j.indicadores,
            execucao: j.execucao ?? null,
          },
        }));
      })
      .catch(() => setAlertasFiscais([]));
  }, [exercicio]);

  const carregar = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setErro(null);
    const p = new URLSearchParams();
    p.set('exercicio', String(exercicio));
    p.set('agruparPor', agruparPor);
    if (filtros.q) p.set('q', filtros.q);
    if (filtros.orgao) p.set('orgao', filtros.orgao);
    if (situacao !== 'todas') p.set('situacao', situacao);
    p.set('ordenarPor', ordenarPor);
    p.set('dir', dir);
    p.set('pagina', String(pageIndex));
    p.set('tamanho', String(pageSize));
    try {
      const res = await nexoFetch(`/api/nexo/orcamento?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as OrcamentoResponse;
      if (id === reqId.current) setData(json);
    } catch (err) {
      if (id === reqId.current) {
        setErro(err instanceof Error ? err.message : 'erro desconhecido');
        setData(null);
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [exercicio, agruparPor, filtros, situacao, ordenarPor, dir, pageIndex, pageSize]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Drill-down: grupos expandidos + cache dos filhos por id de grupo.
  const expandavel = agruparPor === 'orgao' || agruparPor === 'funcao';
  const [expandidos, setExpandidos] = useState<Set<string>>(() => new Set());
  const [detalhes, setDetalhes] = useState<Record<string, DetalheEstado>>({});

  // Recorte mudou (ano/agrupamento/filtros): zera expansão e cache de filhos.
  useEffect(() => {
    setExpandidos(new Set());
    setDetalhes({});
  }, [exercicio, agruparPor, filtros, situacao, ordenarPor, dir, pageIndex, pageSize]);

  const buscarFilhos = useCallback(async (groupId: string, nivel: 'unidade' | 'rubrica') => {
    const p = new URLSearchParams();
    p.set('exercicio', String(exercicio));
    p.set('agruparPor', agruparPor);
    p.set('detalheDe', groupId);
    p.set('nivel', nivel);
    if (filtros.q) p.set('q', filtros.q);
    if (filtros.orgao) p.set('orgao', filtros.orgao);
    if (situacao !== 'todas') p.set('situacao', situacao);
    p.set('ordenarPor', ordenarPor);
    p.set('dir', dir);
    try {
      const res = await nexoFetch(`/api/nexo/orcamento?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as OrcamentoResponse;
      setDetalhes((d) => ({ ...d, [groupId]: { loading: false, itens: json.itens } }));
    } catch (err) {
      setDetalhes((d) => ({ ...d, [groupId]: { loading: false, erro: err instanceof Error ? err.message : 'erro' } }));
    }
  }, [exercicio, agruparPor, filtros, situacao, ordenarPor, dir]);

  const alternarGrupo = useCallback((groupId: string, nivel: 'unidade' | 'rubrica') => {
    let abrindo = false;
    setExpandidos((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId); // colapsa — mantém cache de filhos (não refetch).
      } else {
        next.add(groupId);
        abrindo = true;
      }
      return next;
    });
    if (!abrindo) return;
    // Lazy-fetch só na primeira abertura (cache de filhos evita refetch ao reexpandir).
    setDetalhes((d) => {
      if (d[groupId]?.itens) return d; // já em cache
      void buscarFilhos(groupId, nivel);
      return { ...d, [groupId]: { loading: true } };
    });
  }, [buscarFilhos]);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const itens = data?.itens ?? [];
  const ag = data?.agregados;

  const temFiltros = !!(q || orgao) || situacao !== 'todas';
  const limpar = () => {
    setQ('');
    setOrgao('');
    setSituacao('todas');
    setPageIndex(0);
  };

  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Landmark className="h-5 w-5 text-amber-400" />
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">Execução Orçamentária</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Orçamento do Município por rubrica — dotação prevista (com créditos e
            emendas) × executado. Barra de % usado e alerta de estouro.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={carregar}
          disabled={loading}
          aria-label="Atualizar execução orçamentária"
          className="shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/5"
        >
          <RefreshCw aria-hidden className={'mr-2 h-4 w-4' + (loading ? ' animate-spin' : '')} />
          {loading ? 'Atualizando…' : 'Atualizar'}
        </Button>
      </div>

      {/* Leitura executiva — o que importa em linguagem simples */}
      <LeituraExecutiva
        exercicio={exercicio}
        ag={ag ?? null}
        alertasFiscais={alertasFiscais}
        rclAno={rclPorAno[exercicio]}
      />

      {/* Painel de alertas fiscais globais (MF-15, MF-16, etc.) */}
      {alertasFiscais.length > 0 && (
        <div className="space-y-2">
          {alertasFiscais
            .filter((a) => ['MF-15', 'MF-16', 'MF-09'].includes(a.detectorId))
            .map((alerta) => {
              const critico = alerta.classificacao === 'critico';
              const suspeito = alerta.classificacao === 'suspeita';
              return (
                <div
                  key={alerta.detectorId}
                  className={[
                    'flex items-start gap-3 rounded-md border px-4 py-3',
                    critico
                      ? 'border-red-500/40 bg-red-500/10'
                      : suspeito
                        ? 'border-orange-500/40 bg-orange-500/10'
                        : 'border-amber-500/30 bg-amber-500/8',
                  ].join(' ')}
                  role="alert"
                  aria-label={`Alerta fiscal ${alerta.detectorId}: ${alerta.titulo}`}
                >
                  <TriangleAlert
                    aria-hidden
                    className={`mt-0.5 h-4 w-4 shrink-0 ${
                      critico ? 'text-red-400' : suspeito ? 'text-orange-400' : 'text-amber-400'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span
                        className={`text-xs font-semibold uppercase tracking-wide ${
                          critico ? 'text-red-400' : suspeito ? 'text-orange-400' : 'text-amber-400'
                        }`}
                      >
                        {alerta.detectorId}
                      </span>
                      <span className={`text-sm font-medium ${
                        critico ? 'text-red-200' : suspeito ? 'text-orange-200' : 'text-amber-200'
                      }`}>
                        {alerta.titulo}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-slate-400">
                      {alerta.descricao}
                    </p>
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* Cards macrofiscais — 100% derivados de /api/nexo/metas-fiscais (SICONFI
          RREO/RGF ao vivo). Nenhum número fixo no código: campo que a fonte não
          publicou degrada para "—" em vez de inventar valor. */}
      {(() => {
        const d = rclPorAno[exercicio];
        const ex = d?.execucao ?? null;
        const rclValor = d?.rcl ?? null;
        const pessoal = d?.indicadores?.find((i) => i.chave === 'pessoal_executivo');
        const divida = d?.indicadores?.find((i) => i.chave === 'divida');
        const saude = d?.indicadores?.find((i) => i.chave === 'saude');

        const pctEmpRcl = ex?.pctEmpenhoRclAtual ?? null;
        const pctEmpRc = ex?.pctEmpenhoRcAnterior ?? null;
        const pctLiq = ex?.pctLiquidacaoRc ?? null;
        const empAcima100 = (pctEmpRc ?? 0) > 100 || (pctEmpRcl ?? 0) > 100;
        const liqAcima100 = (pctLiq ?? 0) > 100;
        const excessoEmp =
          ex?.empenhado != null && ex?.receitaCorrenteAnterior != null
            ? ex.empenhado - ex.receitaCorrenteAnterior
            : null;
        const excessoLiq =
          ex?.liquidado != null && ex?.receitaCorrente != null
            ? ex.liquidado - ex.receitaCorrente
            : null;

        const brlCompacto = (v: number | null) =>
          v == null
            ? '—'
            : v >= 1_000_000_000
              ? `R$ ${(v / 1_000_000_000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} bi`
              : `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mi`;

        return (
          <TooltipProvider delayDuration={150}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {/* CARD 1 — RCL Janela Móvel 12 meses */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 transition-colors hover:border-white/20 cursor-help">
                    <div className="mb-2 flex items-baseline justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] uppercase tracking-wide text-slate-400 font-medium">RCL {exercicio}</span>
                        <Info className="h-3 w-3 text-slate-500 hover:text-amber-300 transition-colors" />
                      </div>
                      {d?.periodo && <span className="text-[10px] text-slate-400">{d.periodo}</span>}
                    </div>
                    <div className="text-xl font-semibold text-slate-100">
                      {brlCompacto(rclValor)}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                      {pessoal?.valor != null && (
                        <span
                          title="LRF Art. 59 §1º: Alerta 48,6% | Prudencial: 51,3% | Máximo: 54%"
                          className={pessoal.valor >= 48.6 ? 'text-amber-300' : 'text-emerald-400'}
                        >
                          Pessoal {pessoal.valor.toFixed(1)}%
                        </span>
                      )}
                      {divida?.valor != null && (
                        <span
                          title="Dívida Consolidada Líquida — Limite: 120% da RCL (Res. Senado nº 40/2001)"
                          className={divida.valor >= 100 ? 'text-amber-300' : 'text-slate-400'}
                        >
                          Dívida {divida.valor.toFixed(1)}%
                        </span>
                      )}
                      {saude?.valor != null && (
                        <span
                          title="Aplicação Mínima Constitucional: 15% (CF art. 198 §2º)"
                          className="text-slate-400"
                        >
                          Saúde {saude.valor.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="w-80 sm:w-96 max-w-[90vw] rounded-xl border border-white/10 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-md text-slate-200">
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2 border-b border-white/10 pb-2">
                      <Landmark className="h-4 w-4 text-amber-400 shrink-0" />
                      <div className="font-semibold text-sm text-amber-200">RCL — Receita Corrente Líquida (12m)</div>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">O que é este indicador?</div>
                      <p className="mt-1 text-xs leading-relaxed text-slate-300">
                        A RCL representa o somatório das receitas correntes tributárias, patrimoniais e de transferências auferidas pelo município nos <strong className="text-white">12 meses anteriores</strong>, deduzidas as contribuições previdenciárias de servidores ao RPPS e repasses ao FUNDEB.
                      </p>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">O que significa na prática?</div>
                      <p className="mt-1 text-xs leading-relaxed text-slate-300">
                        É a base legal indispensável de cálculo (<strong className="text-white">LRF Art. 2º, § 3º</strong>) que determina o teto máximo que a Prefeitura pode comprometer com Pessoal (<strong className="text-white">54%</strong>) e Dívida Consolidada (<strong className="text-white">120%</strong>).
                      </p>
                    </div>
                    <div className="rounded bg-white/5 p-2 text-[11px] text-slate-400">
                      <strong className="text-slate-200">Marília/SP ({exercicio}):</strong>{' '}
                      {rclValor != null
                        ? `RCL apurada de ${brlCompacto(rclValor)}${d?.periodo ? ` (${d.periodo})` : ''}. ` +
                          `Pessoal ${pessoal?.valor != null ? `${pessoal.valor.toFixed(1)}%` : 'sem dado'}, ` +
                          `Dívida ${divida?.valor != null ? `${divida.valor.toFixed(1)}%` : 'sem dado'}, ` +
                          `Saúde ${saude?.valor != null ? `${saude.valor.toFixed(1)}%` : 'sem dado'}.`
                        : 'RCL não localizada no RGF publicado para este exercício.'}
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>

              {/* CARD 2 — Arrecadação Atual no Ano */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 transition-colors hover:border-white/20 cursor-help">
                    <div className="mb-2 flex items-baseline justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] uppercase tracking-wide text-slate-400 font-medium">Arrecadação {exercicio}</span>
                        <Info className="h-3 w-3 text-slate-500 hover:text-emerald-400 transition-colors" />
                      </div>
                      <Badge variant="outline" className="border-emerald-500/30 text-[9px] text-emerald-400">
                        {ex?.periodo ? `RREO STN · ${ex.periodo}` : 'RREO STN'}
                      </Badge>
                    </div>
                    <div className="text-xl font-semibold text-emerald-400">
                      {brlCompacto(ex?.receitaCorrente ?? null)}
                    </div>
                    <div className="mt-2 text-[10px] text-slate-400">
                      {rclValor != null
                        ? `RCL apurada: ${brlCompacto(rclValor)}${d?.periodo ? ` (${d.periodo})` : ''}`
                        : 'RCL não localizada no RGF deste recorte'}
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="w-80 sm:w-96 max-w-[90vw] rounded-xl border border-white/10 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-md text-slate-200">
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2 border-b border-white/10 pb-2">
                      <Info className="h-4 w-4 text-emerald-400 shrink-0" />
                      <div className="font-semibold text-sm text-emerald-200">Arrecadação de Receitas Correntes</div>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">O que é este indicador?</div>
                      <p className="mt-1 text-xs leading-relaxed text-slate-300">
                        Mede a entrada efetiva de recursos nos cofres municipais dentro do exercício (<strong className="text-white">Regime de Caixa — Lei 4.320/64, art. 35</strong>), advindos de impostos locais (IPTU, ISS) e repasses (ICMS, FPM).
                      </p>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">O que significa na prática?</div>
                      <p className="mt-1 text-xs leading-relaxed text-slate-300">
                        Define o <strong className="text-white">caixa real disponível</strong> para liquidar despesas e pagar credores. É o limite físico de liquidez do município para evitar formação de dívida sem lastro.
                      </p>
                    </div>
                    <div className="rounded bg-white/5 p-2 text-[11px] text-slate-400">
                      <strong className="text-slate-200">Marília/SP ({exercicio}):</strong>{' '}
                      {ex?.receitaCorrente != null
                        ? `Receita Corrente arrecadada de ${brl(ex.receitaCorrente)}${ex.periodo ? ` até o ${ex.periodo}` : ''} (RREO Anexo 01).` +
                          (rclValor != null ? ` RCL apurada: ${brlCompacto(rclValor)}.` : '')
                        : 'O SICONFI ainda não publicou a receita deste recorte de forma extraível.'}
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>

              {/* CARD 3 — Empenhos vs. RCL (Alerta MF-15) */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className={`rounded-md border px-4 py-3 transition-colors hover:border-white/20 cursor-help ${
                    empAcima100 ? 'border-red-500/40 bg-red-500/10' : 'border-amber-500/20 bg-amber-500/5'
                  }`}>
                    <div className="mb-2 flex items-baseline justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] uppercase tracking-wide text-slate-300 font-medium">Empenho / RCL (MF-15)</span>
                        {empAcima100 && (
                          <TriangleAlert className="h-4 w-4 text-red-400 animate-pulse shrink-0" />
                        )}
                        <Info className="h-3 w-3 text-slate-500 hover:text-amber-300 transition-colors" />
                      </div>
                      <Badge
                        variant="outline"
                        className={`text-[9px] flex items-center gap-1 ${
                          empAcima100 ? 'border-red-500/50 text-red-300 font-semibold bg-red-500/10' : 'border-amber-500/40 text-amber-300'
                        }`}
                      >
                        {empAcima100 && <AlertCircle className="h-2.5 w-2.5 text-red-400" />}
                        {pctEmpRcl != null
                          ? `${pct1(pctEmpRcl)} RCL`
                          : pctEmpRc != null
                            ? `${pct1(pctEmpRc)} RC ant.`
                            : 'sem dado'}
                      </Badge>
                    </div>
                    <div className={`text-lg font-semibold ${empAcima100 ? 'text-red-300' : 'text-amber-300'}`}>
                      {ex?.empenhado != null ? `${brlCompacto(ex.empenhado)} empenhados` : '—'}
                    </div>
                    <div className="mt-2 text-[10px] text-slate-400">
                      {pctEmpRc != null
                        ? `${pct1(pctEmpRc)} sobre a RC Bruta de ${exercicio - 1}` +
                          (excessoEmp != null && excessoEmp > 0 ? ` | excesso de ${brlCompacto(excessoEmp)}` : '') +
                          (ex?.periodo ? ` · ${ex.periodo}` : '')
                        : 'RC do exercício anterior não extraível no SICONFI'}
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="w-80 sm:w-96 max-w-[90vw] rounded-xl border border-white/10 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-md text-slate-200">
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2 border-b border-white/10 pb-2">
                      <TriangleAlert className="h-4 w-4 text-red-400 shrink-0" />
                      <div className="font-semibold text-sm text-red-200">Comprometimento por Empenho (MF-15)</div>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">O que é este indicador?</div>
                      <p className="mt-1 text-xs leading-relaxed text-slate-300">
                        O empenho é o primeiro estágio da despesa (<strong className="text-white">Lei 4.320/64, art. 58</strong>), reservando recursos para pagar contratos, compras e obras.
                      </p>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">O que significa na prática?</div>
                      <p className="mt-1 text-xs leading-relaxed text-slate-300">
                        Empenhar mais que 100% da receita arrecadada significa comprometer <strong className="text-white">mais recursos do que o município possui ou arrecadará no ano</strong> (<strong className="text-white">LRF Art. 59 § 1º, V</strong>), gerando risco iminente de déficit e insolvência.
                      </p>
                    </div>
                    {empAcima100 && ex?.empenhado != null && (
                      <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-200">
                        <strong>⚠️ Alerta de Superação (&gt; 100%):</strong> Em {exercicio}, a Prefeitura empenhou {brl(ex.empenhado)} —{' '}
                        {[
                          pctEmpRcl != null ? `${pct1(pctEmpRcl)} da RCL apurada` : null,
                          pctEmpRc != null ? `${pct1(pctEmpRc)} da RC Bruta de ${exercicio - 1}` : null,
                        ].filter(Boolean).join(' / ')}
                        {excessoEmp != null && excessoEmp > 0 ? `, excedendo em ${brl(excessoEmp)} a receita corrente do exercício anterior` : ''}.
                      </div>
                    )}
                    <div className="rounded bg-white/5 p-2 text-[11px] text-slate-400">
                      <strong className="text-slate-200">Marília/SP ({exercicio}):</strong>{' '}
                      {ex?.empenhado != null
                        ? `Total empenhado de ${brl(ex.empenhado)}${ex.periodo ? ` até o ${ex.periodo}` : ''} (RREO Anexo 02)` +
                          (pctEmpRc != null ? `, ${pct1(pctEmpRc)} da RC Bruta de ${exercicio - 1}` : '') +
                          (pctEmpRcl != null ? ` e ${pct1(pctEmpRcl)} da RCL do RGF` : '') + '.'
                        : 'O SICONFI ainda não publicou o total empenhado deste recorte de forma extraível.'}
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>

              {/* CARD 4 — Liquidações vs. Arrecadação (Alerta MF-16) */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className={`rounded-md border px-4 py-3 transition-colors hover:border-white/20 cursor-help ${
                    liqAcima100 ? 'border-red-500/40 bg-red-500/10' : 'border-white/5 bg-nexo-chrome'
                  }`}>
                    <div className="mb-2 flex items-baseline justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] uppercase tracking-wide text-slate-300 font-medium">Liquidação / Arrecadado (MF-16)</span>
                        {liqAcima100 && (
                          <TriangleAlert className="h-4 w-4 text-red-400 animate-pulse shrink-0" />
                        )}
                        <Info className="h-3 w-3 text-slate-500 hover:text-red-400 transition-colors" />
                      </div>
                      <Badge
                        variant="outline"
                        className={`text-[9px] flex items-center gap-1 ${
                          liqAcima100 ? 'border-red-500/50 text-red-300 font-semibold bg-red-500/10' : 'border-emerald-500/40 text-emerald-400'
                        }`}
                      >
                        {liqAcima100 && <AlertCircle className="h-2.5 w-2.5 text-red-400" />}
                        {pctLiq != null ? `${pct1(pctLiq)} da RC` : 'sem dado'}
                      </Badge>
                    </div>
                    <div className={`text-lg font-semibold ${liqAcima100 ? 'text-red-300' : 'text-slate-100'}`}>
                      {ex?.liquidado != null ? `${brlCompacto(ex.liquidado)} liquidados` : '—'}
                    </div>
                    <div className="mt-2 text-[10px] text-slate-400">
                      {pctLiq != null
                        ? (liqAcima100
                            ? `Liquidou acima do arrecadado${excessoLiq != null && excessoLiq > 0 ? ` | excesso de ${brlCompacto(excessoLiq)}` : ''}`
                            : `${pct1(pctLiq)} da RC arrecadada no período`) +
                          (ex?.periodo ? ` · ${ex.periodo}` : '')
                        : 'RC arrecadada não extraível no SICONFI'}
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="w-80 sm:w-96 max-w-[90vw] rounded-xl border border-white/10 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-md text-slate-200">
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2 border-b border-white/10 pb-2">
                      <TriangleAlert className="h-4 w-4 text-red-400 shrink-0" />
                      <div className="font-semibold text-sm text-red-200">Liquidações Acima do Caixa e RAP (MF-16)</div>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">O que é este indicador?</div>
                      <p className="mt-1 text-xs leading-relaxed text-slate-300">
                        A liquidação atesta que o serviço foi prestado ou o material entregue (<strong className="text-white">Lei 4.320/64, art. 63</strong>), gerando direito adquirido ao credor e obrigação de pagamento pela Prefeitura.
                      </p>
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">O que significa na prática?</div>
                      <p className="mt-1 text-xs leading-relaxed text-slate-300">
                        Liquidar acima de 100% da arrecadação significa que a Prefeitura <strong className="text-white">recebeu bens e serviços em valor superior a todo o dinheiro arrecadado no ano</strong>. O excesso transforma-se em <strong className="text-white">Restos a Pagar (RAP) sem cobertura de caixa</strong> (<strong className="text-white">LRF Art. 42</strong>).
                      </p>
                    </div>
                    {liqAcima100 && ex?.liquidado != null && (
                      <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-200">
                        <strong>⚠️ Alerta de Superação (&gt; 100%):</strong> Em {exercicio}, o total liquidado foi de {brl(ex.liquidado)}
                        {pctLiq != null ? ` (${pct1(pctLiq)} da receita corrente arrecadada)` : ''}
                        {excessoLiq != null && excessoLiq > 0 ? `, excedendo em ${brl(excessoLiq)} toda a arrecadação do período` : ''}.
                      </div>
                    )}
                    <div className="rounded bg-white/5 p-2 text-[11px] text-slate-400">
                      <strong className="text-slate-200">Marília/SP ({exercicio}):</strong>{' '}
                      {ex?.liquidado != null
                        ? `Total liquidado de ${brl(ex.liquidado)}${ex.periodo ? ` até o ${ex.periodo}` : ''} (RREO Anexo 02)` +
                          (ex.receitaCorrente != null ? ` contra ${brl(ex.receitaCorrente)} arrecadados no mesmo período` : '') +
                          (pctLiq != null ? ` — ${pct1(pctLiq)}` : '') + '.'
                        : 'O SICONFI ainda não publicou o total liquidado deste recorte de forma extraível.'}
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        );
      })()}

      {/* Gráfico Histórico Mês a Mês — 4 Linhas com Filtros (Últimos 12m vs Somente Este Ano / Mensal vs Acumulado) */}
      <GraficoSerieOrcamentaria exercicio={exercicio} />

      {/* Exercício + agrupamento */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-slate-400">Exercício</span>
          {EXERCICIOS.map((ano) => (
            <button
              key={ano}
              type="button"
              aria-pressed={ano === exercicio}
              onClick={() => {
                setExercicio(ano);
                setPageIndex(0);
              }}
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
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-slate-400">Agrupar por</span>
          {(['rubrica', 'funcao', 'orgao'] as AgruparPor[]).map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={g === agruparPor}
              onClick={() => {
                setAgruparPor(g);
                setPageIndex(0);
              }}
              className={[
                'rounded-md px-3 py-1 text-sm capitalize transition-colors',
                g === agruparPor
                  ? 'bg-amber-500/15 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30'
                  : 'text-slate-400 hover:bg-white/5',
              ].join(' ')}
            >
              {g === 'orgao' ? 'órgão' : g === 'funcao' ? 'função' : 'rubrica'}
            </button>
          ))}
        </div>
      </div>

      {/* Filtros */}
      <div className="grid grid-cols-1 gap-3 rounded-md border border-white/5 bg-nexo-chrome p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <label className="mb-1 block text-[11px] uppercase tracking-wide text-slate-400">Buscar rubrica / natureza / função</label>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ex.: saúde, material de consumo" className="border-white/10 bg-transparent text-slate-200 placeholder:text-slate-500" />
        </div>
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wide text-slate-400">Órgão / unidade</label>
          <Input value={orgao} onChange={(e) => setOrgao(e.target.value)} placeholder="Ex.: Educação" className="border-white/10 bg-transparent text-slate-200 placeholder:text-slate-500" />
        </div>
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wide text-slate-400">Situação</label>
          <Select value={situacao} onValueChange={(v) => { setSituacao(v); setPageIndex(0); }}>
            <SelectTrigger className="border-white/10 bg-transparent text-slate-200"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todas">Todas</SelectItem>
              <SelectItem value="estourado">Estourado (&gt; 100%)</SelectItem>
              <SelectItem value="alta">Alta execução (80–100%)</SelectItem>
              <SelectItem value="media">Média (40–80%)</SelectItem>
              <SelectItem value="baixa">Baixa (&lt; 40%)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] uppercase tracking-wide text-slate-400">Ordenar por</label>
          <div className="flex gap-1">
            <Select value={ordenarPor} onValueChange={(v) => { setOrdenarPor(v); setPageIndex(0); }}>
              <SelectTrigger className="flex-1 border-white/10 bg-transparent text-slate-200"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="autorizada">Dotação autorizada</SelectItem>
                <SelectItem value="empenhado">Empenhado</SelectItem>
                <SelectItem value="pct">% execução</SelectItem>
                <SelectItem value="inicial">Dotação inicial</SelectItem>
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={() => { setDir((d) => d === 'asc' ? 'desc' : 'asc'); setPageIndex(0); }}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-white/10 bg-transparent text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
              aria-label={dir === 'asc' ? 'Orden crescente' : 'Orden decrescente'}
              title={dir === 'asc' ? 'Menor para maior' : 'Maior para menor'}
            >
              <ArrowUpDown aria-hidden className={`h-4 w-4 transition-transform ${dir === 'asc' ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>
        {temFiltros && (
          <div className="flex items-end sm:col-span-2 lg:col-span-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={limpar}
              className="text-slate-400 hover:bg-white/5 hover:text-slate-200"
            >
              Limpar filtros
            </Button>
          </div>
        )}
      </div>

      {/* Conteúdo */}
      {loading && !data ? (
        <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => (<Skeleton key={i} className="h-16 w-full" />))}</div>
      ) : erro ? (
        <Card className="border-red-500/20 bg-red-500/5">
          <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
            <TriangleAlert className="h-5 w-5" /> Não foi possível carregar o orçamento: {erro}
          </CardContent>
        </Card>
      ) : data && data.ingestao.status === 'pendente' ? (
        <Card className="border-white/10 bg-nexo-chrome">
          <CardContent className="py-10 text-center text-sm text-slate-400">
            Sem execução orçamentária coletada para {exercicio}.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Resumo geral */}
          {ag && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-7">
              {[
                { rotulo: 'Dotação inicial', valor: brl(ag.dotacaoInicial), dica: 'Dotação prevista na lei orçamentária (LOA), antes de créditos e emendas.' },
                { rotulo: 'Autorizada', valor: brl(ag.dotacaoAutorizada), dica: 'Dotação atual, já incluindo créditos adicionais e emendas.' },
                { rotulo: 'Empenhado', valor: brl(ag.empenhado), dica: 'Total empenhado no recorte.' },
                { rotulo: 'Liquidado', valor: brl(ag.liquidado), dica: 'Total liquidado (empenhado já executado).' },
                { rotulo: 'Pago', valor: brl(ag.pago), dica: 'Total efetivamente pago.' },
                { rotulo: '% execução', valor: pct1(ag.pctExecucaoGlobal), dica: 'Empenhado sobre a dotação autorizada do recorte.' },
                { rotulo: 'Rubricas estouradas', valor: ag.estouradas.toLocaleString('pt-BR'), alerta: ag.estouradas > 0, dica: 'Rubricas com empenhado acima da dotação autorizada — indício a apurar.' },
              ].map((c) => (
                <div key={c.rotulo} title={c.dica} className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
                  <div className="text-[11px] uppercase tracking-wide text-slate-400">{c.rotulo}</div>
                  <div className={`mt-1 flex items-center gap-1.5 text-lg font-semibold ${c.alerta ? 'text-red-300' : 'text-slate-100'}`}>
                    {c.alerta && <TriangleAlert aria-hidden className="h-4 w-4 shrink-0" />}
                    {c.valor}
                  </div>
                </div>
              ))}
            </div>
          )}
          {ag && ag.dotacaoAutorizada > ag.dotacaoInicial && (
            <p className="text-xs text-slate-400">
              Créditos/emendas no recorte: <strong className="text-amber-300">{brl(ag.dotacaoAutorizada - ag.dotacaoInicial)}</strong> acima da dotação inicial.
            </p>
          )}

          {/* % sobre a RCL */}
          {ag && rclPorAno[exercicio]?.rcl != null && ag.dotacaoAutorizada > 0 && (
            <div className="rounded-md border border-white/5 bg-nexo-chrome px-4 py-3">
              <div className="mb-2 text-[11px] uppercase tracking-wide text-slate-400">Execução vs RCL {exercicio}</div>
              <div className="space-y-2">
                {[
                  { label: 'Empenhado / RCL', pct: (ag.empenhado / rclPorAno[exercicio].rcl!) * 100, num: ag.empenhado, den: rclPorAno[exercicio].rcl!, cor: ag.empenhado > rclPorAno[exercicio].rcl! ? 'bg-red-500' : 'bg-amber-400' },
                  { label: 'Liquidado / RCL', pct: (ag.liquidado / rclPorAno[exercicio].rcl!) * 100, num: ag.liquidado, den: rclPorAno[exercicio].rcl!, cor: 'bg-blue-500' },
                ].map((m) => {
                  const larg = Math.min(100, Math.max(0, m.pct));
                  return (
                    <div key={m.label}>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-400">{m.label}</span>
                        <span className={m.pct > 100 ? 'font-semibold text-red-300' : 'text-slate-300'}>{pct1(m.pct)}</span>
                      </div>
                      <div className="mt-0.5 h-2 w-full overflow-hidden rounded-full bg-white/5">
                        <div className={`h-full rounded-full ${m.cor}`} style={{ width: `${larg}%` }} />
                      </div>
                      <div className="text-[9px] text-slate-400">{brl(m.num)} / {brl(m.den)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Legenda da barra de execução + dica de drill-down */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
            <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2 w-3 rounded-full bg-emerald-500" /> Emp./Dot. &lt; 80%</span>
            <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2 w-3 rounded-full bg-amber-400" /> Emp./Dot. 80–100%</span>
            <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2 w-3 rounded-full bg-red-500" /> estourado (&gt; 100%)</span>
            <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2 w-3 rounded-full bg-blue-500" /> Liq./Emp.</span>
            <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2 w-3 rounded-full bg-violet-500" /> Pag./Liq.</span>
            {expandavel && (
              <span className="ml-auto hidden sm:inline">
                {agruparPor === 'orgao'
                  ? 'Clique para abrir os níveis: órgão → secretaria → rubrica.'
                  : 'Clique numa linha para ver as rubricas.'}
              </span>
            )}
          </div>

          {/* Lista hierárquica (órgão → unidade/secretaria → rubrica) */}
          <div className="space-y-2">
            {itens.length === 0 ? (
              <Card className="border-white/10 bg-nexo-chrome"><CardContent className="py-10 text-center text-sm text-slate-400">{temFiltros ? 'Nenhuma rubrica casa os filtros aplicados.' : 'Sem rubricas neste recorte.'}</CardContent></Card>
            ) : (
              itens.map((i) => (
                <NoOrcamento
                  key={i.id}
                  item={i}
                  depth={0}
                  agruparPor={agruparPor}
                  expandidos={expandidos}
                  detalhes={detalhes}
                  onToggle={alternarGrupo}
                />
              ))
            )}
          </div>

          {/* Paginação */}
          <div className="flex flex-col items-center justify-between gap-3 text-xs text-slate-400 sm:flex-row">
            <span>{total.toLocaleString('pt-BR')} {agruparPor === 'rubrica' ? 'rubrica(s)' : agruparPor === 'funcao' ? 'função(ões)' : 'órgão(s)'} no recorte.</span>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span>Por página</span>
                <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPageIndex(0); }}>
                  <SelectTrigger className="h-8 w-[72px] border-white/10 bg-transparent text-slate-200"><SelectValue /></SelectTrigger>
                  <SelectContent>{TAMANHOS.map((t) => (<SelectItem key={t} value={String(t)}>{t}</SelectItem>))}</SelectContent>
                </Select>
              </div>
              <span>Página {total === 0 ? 0 : pageIndex + 1} de {pageCount}</span>
              <div className="flex items-center gap-1">
                <Button type="button" variant="outline" size="sm" aria-label="Página anterior" className="h-8 border-white/10 bg-transparent text-slate-300 hover:bg-white/5" onClick={() => setPageIndex((i) => Math.max(0, i - 1))} disabled={pageIndex === 0}>Anterior</Button>
                <Button type="button" variant="outline" size="sm" aria-label="Próxima página" className="h-8 border-white/10 bg-transparent text-slate-300 hover:bg-white/5" onClick={() => setPageIndex((i) => Math.min(pageCount - 1, i + 1))} disabled={pageIndex >= pageCount - 1}>Próxima</Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
