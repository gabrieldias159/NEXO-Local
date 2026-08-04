'use client';

/**
 * NexoTarefaTracker — escuta as tarefas de compilação do NEXO (`nexo_tarefas`)
 * do usuário e dispara toasts persistentes quando uma vira `pronto`/`erro`.
 *
 * Cópia/adaptação de `src/components/recortes/QuickEditJobTracker.tsx`. Por que
 * existe: o botão "Compilar/Atualizar" dos painéis (Painel de Situação, Grafo,
 * Dossiê) NÃO bloqueia — ele só cria um doc `nexo_tarefas` (status `pendente`)
 * via client SDK e devolve o controle ao operador. O worker (Frente E, Admin
 * SDK) computa o snapshot em background e avança o status. Sem este tracker, o
 * operador ficaria sem feedback de quando o snapshot ficou pronto.
 *
 * Como funciona:
 *  - Persistente em localStorage: lista de docIds de tarefas criadas por este
 *    browser. Sobrevive a reload/navegação.
 *  - Escuta cada tarefa via onSnapshot.
 *  - Em `pronto`, dispara toast "pronto — abrir" com link para o painel-alvo e
 *    remove a tarefa da lista local.
 *  - Em `erro`, dispara toast destrutivo e remove.
 *  - Em `processando`, mostra um toast informativo (1x).
 *
 * Para CRIAR uma tarefa rastreada, chame `criarTarefaNexo(firestore, uid, ...)`
 * — ele cria o doc com a chave canônica (`chaveTarefa`) e já registra no
 * tracking. As páginas (Painel/Grafo/Dossiê) importam essa função.
 */

import { useEffect, useRef, useState } from 'react';
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';
import { Hammer, RefreshCw } from 'lucide-react';
import { useFirestore, useUser } from '@/firebase';
import { useToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import {
  chaveTarefa,
  TTL_SNAPSHOT_MS,
  VERSAO_WORKER,
  type NexoTarefa,
  type StatusTarefa,
  type TipoTarefa,
} from '@/lib/nexo/jobs-tipos';

const STORAGE_KEY = 'nexoTarefasTracking';
const COLECAO = 'nexo_tarefas';

/** Rótulo humano do tipo de painel, para os toasts. */
const ROTULO_TIPO: Record<TipoTarefa, string> = {
  dossie: 'Dossiê',
  grafo: 'Grafo de vínculos',
  alertas: 'Indícios',
  risco: 'Painel de risco',
  ranking: 'Ranking de vínculos',
};

/** Caminho do painel-alvo para o link "abrir" do toast de conclusão. */
function rotaDoPainel(tipo: TipoTarefa, alvo: string): string {
  switch (tipo) {
    case 'dossie':
      return alvo ? `/nexo/dossie/${encodeURIComponent(alvo)}` : '/nexo/dossies';
    case 'grafo':
      return '/nexo/grafo';
    case 'alertas':
      return '/nexo';
    case 'risco':
      return '/nexo/risco';
    case 'ranking':
      return '/nexo/ranking';
    default:
      return '/nexo/tarefas';
  }
}

// ── Tracking local (localStorage) ─────────────────────────────────────────────

function lerTracking(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function adicionarTracking(docId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const list = lerTracking();
    if (!list.includes(docId)) {
      list.push(docId);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      window.dispatchEvent(new CustomEvent('nexoTarefaAdicionada', { detail: docId }));
    }
  } catch {
    /* localStorage indisponível — silencia */
  }
}

function removerTracking(docId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const next = lerTracking().filter((id) => id !== docId);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* noop */
  }
}

// ── Criação de tarefa (botão Compilar/Atualizar) ──────────────────────────────

export interface CriarTarefaArgs {
  tipo: TipoTarefa;
  /** Alvo: id de entidade (dossie/risco), "" para grafo/alertas/ranking globais. */
  alvo: string;
  exercicio: number;
}

export interface CriarTarefaResultado {
  docId: string;
  /** `true` se já existia uma tarefa viva (pendente/processando) para a chave. */
  jaExistia: boolean;
}

/**
 * Cria (ou reaproveita) uma tarefa `nexo_tarefas` para um painel/alvo/exercício
 * e a registra no tracking local. A rule é create-only do dono — por isso
 * gravamos `solicitadoPor == uid` e `status == 'pendente'` (exigência da rule).
 *
 * Dedupe: o docId é a chave canônica `{tipo}:{alvo}:{exercicio}`. Se já houver
 * uma tarefa viva (pendente/processando) para a chave, NÃO recria — só re-rastreia
 * e devolve `jaExistia=true` (evita enfileirar duplicado enquanto o worker corre).
 * Se a anterior estiver `pronto`/`erro`/`expirado`, recria (pede recompilação).
 *
 * NB: o update é proibido pela rule (só o worker avança status). Quando a tarefa
 * anterior está concluída, fazemos `setDoc` (recriação) — permitido pelo create
 * porque o doc volta a `status:'pendente'`. O Firestore trata setDoc sobre doc
 * existente como create na avaliação da rule de `create`? NÃO — seria `update`.
 * Por isso, para chaves concluídas, anexamos o epoch ao docId (nova tarefa),
 * mantendo o dedupe só enquanto a tarefa está VIVA.
 */
export async function criarTarefaNexo(
  firestore: Firestore,
  uid: string,
  args: CriarTarefaArgs,
): Promise<CriarTarefaResultado> {
  const chaveViva = chaveTarefa(args.tipo, args.alvo, args.exercicio);
  const refViva = doc(firestore, COLECAO, chaveViva);

  // Se já há uma tarefa VIVA para a chave, reaproveita (não duplica fila).
  try {
    const snap = await getDoc(refViva);
    if (snap.exists()) {
      const st = (snap.data() as Partial<NexoTarefa>).status;
      if (st === 'pendente' || st === 'processando') {
        adicionarTracking(chaveViva);
        return { docId: chaveViva, jaExistia: true };
      }
    }
  } catch {
    /* leitura falhou (rede/permissão) — segue para tentar criar */
  }

  // Doc novo. Para a chave VIVA (sem doc anterior concluído) usamos a própria
  // chave; quando há um doc anterior concluído/erro/expirado, a rule de UPDATE
  // proíbe sobrescrever — então anexamos o epoch para nascer um doc NOVO (create).
  const epoch = Date.now();
  let docId = chaveViva;
  try {
    const snap = await getDoc(refViva);
    if (snap.exists()) docId = `${chaveViva}:${epoch}`;
  } catch {
    /* assume novo */
  }

  const payload: NexoTarefa = {
    tipo: args.tipo,
    alvo: args.alvo,
    exercicio: args.exercicio,
    status: 'pendente',
    origem: 'manual',
    solicitadoPor: uid,
    snapshotId: null,
    progresso: 0,
    erro: null,
    tentativas: 0,
    _versaoWorker: VERSAO_WORKER,
    criadoEm: serverTimestamp(),
  };

  await setDoc(doc(firestore, COLECAO, docId), payload);
  adicionarTracking(docId);
  return { docId, jaExistia: false };
}

// ── Tracker (montado 1x no nexo-shell) ────────────────────────────────────────

/** Monte uma vez na casca do NEXO. É invisível. */
export function NexoTarefaTracker() {
  const firestore = useFirestore();
  const { toast } = useToast();
  const trackedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!firestore) return;

    const unsubs = new Map<string, () => void>();

    const subscribe = (docId: string) => {
      if (unsubs.has(docId)) return;
      const ref = doc(firestore, COLECAO, docId);
      let processandoToasted = false;
      const unsub = onSnapshot(
          ref,
          (snap) => {
            if (!snap.exists()) {
              // TTL apagou ou nunca existiu — limpa o tracking.
              removerTracking(docId);
              unsub();
              unsubs.delete(docId);
              trackedRef.current.delete(docId);
              return;
            }
            const data = snap.data() as Partial<NexoTarefa>;
            const status = data.status as StatusTarefa | undefined;
            const tipo = (data.tipo ?? 'alertas') as TipoTarefa;
            const alvo = data.alvo ?? '';
            const rotulo = ROTULO_TIPO[tipo] ?? 'Painel';

            if (status === 'processando' && !processandoToasted) {
              processandoToasted = true;
              toast({
                title: `${rotulo} em compilação`,
                description: 'O servidor está materializando o snapshot. Aviso quando ficar pronto.',
              });
            }

            if (status === 'pronto') {
              const rota = rotaDoPainel(tipo, alvo);
              toast({
                title: `${rotulo} pronto`,
                description: 'Snapshot materializado — abrir o painel atualizado.',
                variant: 'success',
                action: (
                  <ToastAction
                    altText="Abrir painel"
                    onClick={() => {
                      if (typeof window !== 'undefined') window.location.href = rota;
                    }}
                  >
                    Abrir
                  </ToastAction>
                ),
              });
              removerTracking(docId);
              unsub();
              unsubs.delete(docId);
              trackedRef.current.delete(docId);
            } else if (status === 'erro') {
              toast({
                title: `Falha ao compilar ${rotulo.toLowerCase()}`,
                description: data.erro ?? 'Erro desconhecido no worker de compilação.',
                variant: 'destructive',
              });
              removerTracking(docId);
              unsub();
              unsubs.delete(docId);
              trackedRef.current.delete(docId);
            } else if (status === 'expirado') {
              // Snapshot venceu antes de a UI consumir — apenas para de rastrear.
              removerTracking(docId);
              unsub();
              unsubs.delete(docId);
              trackedRef.current.delete(docId);
            }
          },
          (err) => {
            console.warn('[NexoTarefaTracker] erro na assinatura', err);
            // Não remove — pode ser falha temporária; re-tenta no próximo mount.
          },
      );
      unsubs.set(docId, unsub);
      trackedRef.current.add(docId);
    };

    // Assina as tarefas já em localStorage no mount.
    lerTracking().forEach(subscribe);

    // Escuta novas tarefas criadas via criarTarefaNexo().
    const onAdd = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) subscribe(id);
    };
    window.addEventListener('nexoTarefaAdicionada', onAdd);

    return () => {
      window.removeEventListener('nexoTarefaAdicionada', onAdd);
      unsubs.forEach((u) => u());
      unsubs.clear();
      trackedRef.current.clear();
    };
  }, [firestore, toast]);

  return null;
}

// ── Botão "Compilar/Atualizar" reutilizável ───────────────────────────────────

export interface CompilarBotaoProps {
  tipo: TipoTarefa;
  alvo: string;
  exercicio: number;
  /** "Compilar" (primeiro snapshot) ou "Atualizar" (recompilar). Default: auto. */
  rotulo?: string;
  /** Estilo: 'header' (botão de borda, igual ao Atualizar dos painéis). */
  variante?: 'header';
  className?: string;
}

/**
 * Botão não-bloqueante que cria uma tarefa `nexo_tarefas` (status `pendente`)
 * via client SDK. O worker (Frente E) computa o snapshot em background e o
 * NexoTarefaTracker dá o toast "pronto — abrir". Encapsula firestore/uid/toast
 * para as páginas só passarem tipo/alvo/exercício.
 */
export function CompilarBotao({
  tipo,
  alvo,
  exercicio,
  rotulo = 'Compilar',
  className,
}: CompilarBotaoProps) {
  const firestore = useFirestore();
  const { user } = useUser();
  const { toast } = useToast();
  const [enviando, setEnviando] = useState(false);

  const onClick = async () => {
    if (!firestore || !user?.uid || enviando) return;
    setEnviando(true);
    try {
      const r = await criarTarefaNexo(firestore, user.uid, { tipo, alvo, exercicio });
      toast({
        title: r.jaExistia ? 'Já está em compilação' : 'Compilação enfileirada',
        description: r.jaExistia
          ? 'Há uma tarefa em andamento para este painel — aviso quando ficar pronta.'
          : 'O servidor vai materializar o snapshot. Aviso quando ficar pronto (até alguns minutos).',
      });
    } catch (err) {
      toast({
        title: 'Não foi possível enfileirar',
        description: err instanceof Error ? err.message : 'Erro ao criar a tarefa de compilação.',
        variant: 'destructive',
      });
    } finally {
      setEnviando(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={enviando || !user?.uid}
      aria-label={`${rotulo} snapshot deste painel em background`}
      title="Cria uma tarefa de compilação em background; você é avisado quando o snapshot fica pronto"
      className={
        className ??
        'inline-flex shrink-0 items-center gap-2 rounded-md border border-amber-500/30 px-3 py-1.5 text-sm text-amber-300 transition-colors hover:bg-amber-500/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500/40 disabled:opacity-50'
      }
    >
      {enviando ? (
        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Hammer className="h-4 w-4" aria-hidden="true" />
      )}
      {rotulo}
    </button>
  );
}

// ── Badge "atualizado há X · expira em 3 dias" ────────────────────────────────

function tempoRelativoCurto(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'agora';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'há instantes';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return `há ${d} dia${d > 1 ? 's' : ''}`;
}

export interface BadgeAtualizadoProps {
  /** Quando o snapshot/dado atual foi gerado (epoch ms ou ISO). null = sem dado. */
  geradoEm: number | string | null;
  className?: string;
}

/**
 * Badge "atualizado há X · expira em 3 dias" (TTL_SNAPSHOT_MS). Honesto: se não
 * houver `geradoEm` (sem snapshot materializado ainda), mostra "sem snapshot".
 * A janela de expiração é a do plano (§2.2): geradoEm + 3 dias.
 */
export function BadgeAtualizado({ geradoEm, className }: BadgeAtualizadoProps) {
  const base =
    className ??
    'inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-nexo-chrome px-2.5 py-1 text-[11px] text-slate-500';

  if (geradoEm == null) {
    return (
      <span className={base} title="Nenhum snapshot materializado para este recorte ainda">
        sem snapshot — compile para gerar
      </span>
    );
  }

  const t = typeof geradoEm === 'number' ? geradoEm : new Date(geradoEm).getTime();
  if (!Number.isFinite(t)) {
    return (
      <span className={base} title="Data de geração inválida">
        atualização desconhecida
      </span>
    );
  }

  const idade = Date.now() - t;
  const expiraEm = t + TTL_SNAPSHOT_MS;
  const restanteMs = expiraEm - Date.now();
  const restanteDias = Math.max(0, Math.ceil(restanteMs / (24 * 60 * 60 * 1000)));
  const expirado = restanteMs <= 0;

  return (
    <span
      className={base}
      title={`Gerado em ${new Date(t).toLocaleString('pt-BR')} · expira em ${new Date(expiraEm).toLocaleString('pt-BR')}`}
    >
      atualizado {tempoRelativoCurto(idade)}
      <span aria-hidden="true">·</span>
      {expirado ? (
        <span className="text-amber-400/80">expirado — recompile</span>
      ) : (
        <span>expira em {restanteDias} dia{restanteDias === 1 ? '' : 's'}</span>
      )}
    </span>
  );
}
