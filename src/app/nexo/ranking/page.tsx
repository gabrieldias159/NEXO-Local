'use client';

/**
 * NEXO — Ranking de vínculos doador ↔ político ↔ empresa (o ENTREGÁVEL central).
 *
 * Consome `GET /api/nexo/ranking-doadores` (Frente F do plano — AINDA NÃO
 * EXISTE). Enquanto a rota não está no ar, esta página é HONESTA: tenta o fetch,
 * e quando ele 404a (rota ausente) mostra o estado "ranking em compilação" +
 * descreve o SHAPE esperado (para a Frente F implementar a rota contra este
 * contrato). NÃO inventa dados — zero linhas fabricadas.
 *
 * Quando a Frente F entregar a rota com o shape `RankingDoadoresResponse`, esta
 * página passa a renderizar a tabela real sem mais mudanças (o parsing já está
 * pronto). Ordenação por `potencial = min(totalDoado, totalEmpenhado)` (plano
 * §2.3) — o número que aproxima o "quanto do dinheiro público pode ter ido a
 * quem financiou a campanha", SEMPRE como indício a apurar.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Trophy,
  RefreshCw,
  TriangleAlert,
  HandCoins,
  Hammer,
  Building2,
  User,
  Network,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EntityProvider, EntityText } from '@/components/nexo/entity-text';
import { nexoFetch } from '@/lib/nexo/client-fetch';
import { CompilarBotao, BadgeAtualizado } from '@/components/nexo/NexoTarefaTracker';

const EXERCICIOS = [2026, 2025, 2024];

// ── SHAPE ESPERADO (contrato p/ a Frente F) ──────────────────────────────────
// Espelha `nexo_ranking_vinculo` (plano §2.3). A rota deve devolver isto; até
// lá, o tipo serve de documentação viva do contrato cliente↔servidor.

type ClassificacaoMax = 'informativo' | 'atencao' | 'suspeita' | 'critico';

interface RankingItem {
  id: string;
  /** 'empresa' | 'pessoa' — o lado doador/fornecedor do vínculo. */
  kind: 'empresa' | 'pessoa';
  /** Nome/razão social (CPF sempre mascarado pela rota — LGPD). */
  rotulo: string;
  /** Documento mascarado (CNPJ exibível; CPF parcial). */
  docMasc: string | null;
  /** CNPJ só-dígitos quando empresa (alvo do dossiê). */
  cnpj: string | null;
  totalDoado: number;
  totalEmpenhado: number;
  /** min(totalDoado, totalEmpenhado) — a régua de ordenação. */
  potencial: number;
  /** Candidatos/políticos a quem doou (para contexto). */
  politicos: string[];
  classificacaoMax: ClassificacaoMax;
  /** Bases de confiança auditáveis (ex.: 'nome+cpf6'). */
  baseConfianca: string[];
}

interface RankingDoadoresResponse {
  exercicio: number;
  /** false quando o ranking ainda não foi materializado (cron/worker não rodou). */
  disponivel: boolean;
  /** Explicação honesta quando `disponivel=false`. */
  motivo: string | null;
  itens: RankingItem[];
  total: number;
  atualizadoEm: string | null;
}

function brl(v: number): string {
  return v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
}

const CLASSE_CLS: Record<ClassificacaoMax, string> = {
  critico: 'border-red-500/30 bg-red-500/10 text-red-300',
  suspeita: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  atencao: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  informativo: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
};

/** Estado da página: 'rota-ausente' = Frente F ainda não entregou a rota. */
type Fase = 'carregando' | 'ok' | 'rota-ausente' | 'em-compilacao' | 'erro';

export default function RankingPage() {
  const [exercicio, setExercicio] = useState(EXERCICIOS[0]);
  const [fase, setFase] = useState<Fase>('carregando');
  const [data, setData] = useState<RankingDoadoresResponse | null>(null);
  const [motivo, setMotivo] = useState<string | null>(null);

  const reqId = useRef(0);
  const carregar = useCallback(async (ano: number) => {
    const id = ++reqId.current;
    setFase('carregando');
    setMotivo(null);
    try {
      const res = await nexoFetch(`/api/nexo/ranking-doadores?exercicio=${ano}`);
      // Rota ainda não existe (Frente F): 404 → estado honesto, sem inventar.
      if (res.status === 404) {
        if (id === reqId.current) {
          setData(null);
          setFase('rota-ausente');
        }
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as RankingDoadoresResponse;
      if (id !== reqId.current) return;
      if (json.disponivel === false) {
        setData(null);
        setMotivo(json.motivo ?? null);
        setFase('em-compilacao');
      } else {
        setData(json);
        setFase('ok');
      }
    } catch (err) {
      if (id === reqId.current) {
        setMotivo(err instanceof Error ? err.message : 'erro desconhecido');
        setData(null);
        setFase('erro');
      }
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
              <Trophy className="h-5 w-5 text-amber-400" aria-hidden="true" />
              <h1 className="text-2xl font-bold tracking-tight text-slate-100">
                Ranking de vínculos doador ↔ contrato
              </h1>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">
              Pessoas e empresas que <strong>doaram a campanhas</strong> e também{' '}
              <strong>receberam empenhos/contratos</strong> da Prefeitura,
              ordenadas pelo <em>potencial</em> ={' '}
              <code className="font-mono text-slate-300">
                min(total doado, total empenhado)
              </code>
              . Coincidir como doador e fornecedor é vínculo{' '}
              <strong>a apurar</strong> — jamais, por si só, acusação. Doação de
              campanha é ato lícito e público.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => carregar(exercicio)}
                disabled={fase === 'carregando'}
                aria-label="Recarregar ranking"
                className="inline-flex shrink-0 items-center gap-2 rounded-md border border-white/10 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-white/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40 disabled:opacity-50"
              >
                <RefreshCw
                  className={'h-4 w-4' + (fase === 'carregando' ? ' animate-spin' : '')}
                  aria-hidden="true"
                />
                Recarregar
              </button>
              {/* Compila o snapshot do ranking em background (Frente E/F). */}
              <CompilarBotao
                tipo="ranking"
                alvo=""
                exercicio={exercicio}
                rotulo={data?.atualizadoEm ? 'Recompilar' : 'Compilar'}
              />
            </div>
            <BadgeAtualizado geradoEm={data?.atualizadoEm ?? null} />
          </div>
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

        {/* Conteúdo */}
        {fase === 'carregando' ? (
          <div className="space-y-2" role="status" aria-busy="true" aria-live="polite">
            <span className="sr-only">Carregando ranking…</span>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : fase === 'erro' ? (
          <Card className="border-red-500/20 bg-red-500/5" role="alert">
            <CardContent className="flex items-center gap-3 py-6 text-sm text-red-300">
              <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
              Não foi possível carregar o ranking de {exercicio}: {motivo}
            </CardContent>
          </Card>
        ) : fase === 'rota-ausente' || fase === 'em-compilacao' ? (
          <EstadoEmCompilacao
            exercicio={exercicio}
            rotaAusente={fase === 'rota-ausente'}
            motivo={motivo}
          />
        ) : data && data.itens.length === 0 ? (
          <div className="rounded-md border border-dashed border-white/10 py-10 text-center text-sm text-slate-500">
            Nenhum vínculo doador ↔ contrato encontrado para {exercicio}.
          </div>
        ) : data ? (
          <RankingTabela itens={data.itens} total={data.total} />
        ) : null}

        {/* Disclaimer */}
        <div className="flex items-start gap-2 rounded-md border border-white/5 bg-nexo-chrome p-4 text-[11px] leading-relaxed text-slate-500">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400/70" aria-hidden="true" />
          <p>
            O cruzamento doador ↔ sócio é <strong>probabilístico</strong> (nome +
            6 dígitos do CPF — a base aberta da Receita só publica o miolo), nunca
            determinístico. Doação de PJ é vedada desde 2015 (ADI 4650). Tudo aqui
            é <strong>indício a apurar</strong>; a apuração cabe a TCE-SP /
            Ministério Público / Justiça Eleitoral.
          </p>
        </div>
      </div>
    </EntityProvider>
  );
}

// ── Estado honesto: ranking ainda não materializado ───────────────────────────

function EstadoEmCompilacao({
  exercicio,
  rotaAusente,
  motivo,
}: {
  exercicio: number;
  rotaAusente: boolean;
  motivo: string | null;
}) {
  return (
    <Card className="border-amber-500/20 bg-nexo-surface">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <Hammer className="h-7 w-7 text-amber-400" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-200">
          Ranking em compilação — {exercicio}
        </p>
        <p className="max-w-lg text-xs leading-relaxed text-slate-500">
          {rotaAusente
            ? 'A materialização do ranking (nexo_ranking_vinculo + a rota /api/nexo/ranking-doadores) ainda não está no ar. Use o botão Compilar para enfileirar; quando o worker concluir, esta tela passa a listar os vínculos automaticamente.'
            : motivo ??
              'O cron/worker que agrega doador ↔ contrato ainda não rodou para este exercício. Compile para enfileirar a materialização.'}
        </p>

        {/* SHAPE esperado — documentação viva do contrato p/ a Frente F. */}
        <div className="mt-2 w-full max-w-2xl rounded-md border border-white/5 bg-nexo-chrome p-4 text-left">
          <p className="mb-2 text-[10px] uppercase tracking-wide text-slate-400">
            Estrutura esperada de cada linha (quando pronto)
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {[
              ['Doador/fornecedor', 'empresa ou pessoa (CPF mascarado)'],
              ['Total doado', 'soma das doações TSE'],
              ['Total empenhado', 'soma dos empenhos/contratos'],
              ['Potencial', 'min(doado, empenhado) — ordenação'],
              ['Políticos beneficiados', 'candidatos a quem doou'],
              ['Confiança', 'nome+cpf6 · classificação máx.'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline gap-2 text-[11px]">
                <span className="font-mono text-slate-400">{k}</span>
                <span className="text-slate-400">— {v}</span>
              </div>
            ))}
          </div>
        </div>

        <Link
          href="/nexo/tarefas"
          className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 transition-colors hover:text-amber-300"
        >
          <Network className="h-3.5 w-3.5" aria-hidden="true" />
          Acompanhar em Tarefas
        </Link>
      </CardContent>
    </Card>
  );
}

// ── Tabela real (renderiza quando a Frente F entrega dados) ───────────────────

function RankingTabela({ itens, total }: { itens: RankingItem[]; total: number }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/5 bg-nexo-chrome px-4 py-3 text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5">
          <HandCoins className="h-3.5 w-3.5 text-amber-400/80" aria-hidden="true" />
          {total.toLocaleString('pt-BR')} vínculo(s) doador ↔ contrato
        </span>
        <span aria-hidden="true">·</span>
        <span>ordenado por potencial — indício a apurar</span>
      </div>
      <ul className="space-y-2">
        {itens.map((it, i) => {
          const Icon = it.kind === 'empresa' ? Building2 : User;
          const conteudoNome = (
            <span className="truncate text-sm font-medium text-slate-200">
              <EntityText>{it.rotulo}</EntityText>
            </span>
          );
          return (
            <li key={it.id}>
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-white/5 bg-nexo-surface px-3 py-3">
                <span
                  className="w-6 shrink-0 text-center font-mono text-xs text-slate-400"
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <Icon className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  {it.cnpj ? (
                    <Link
                      href={`/nexo/dossie/${it.cnpj}`}
                      className="truncate text-sm font-medium text-amber-300 underline decoration-amber-500/30 decoration-dotted underline-offset-2 hover:text-amber-200"
                    >
                      <EntityText>{it.rotulo}</EntityText>
                    </Link>
                  ) : (
                    conteudoNome
                  )}
                  {it.docMasc && (
                    <p className="font-mono text-[10px] text-slate-400">{it.docMasc}</p>
                  )}
                  {it.politicos.length > 0 && (
                    <p className="mt-0.5 truncate text-[11px] text-slate-500">
                      doou a: {it.politicos.join(' · ')}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-sm text-amber-300">{brl(it.potencial)}</p>
                  <p className="text-[10px] text-slate-400">
                    doado {brl(it.totalDoado)} · empenh. {brl(it.totalEmpenhado)}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className={`shrink-0 text-[10px] uppercase ${CLASSE_CLS[it.classificacaoMax] ?? CLASSE_CLS.informativo}`}
                >
                  {it.classificacaoMax}
                </Badge>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
