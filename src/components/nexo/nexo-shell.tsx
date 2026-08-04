'use client';

/**
 * NexoShell — a "sala de situação" do NEXO.
 *
 * Layout próprio, separado do app principal: o NEXO assume a tela inteira
 * (ver LayoutWrapper). Estética de war room — fundo escuro, acento âmbar.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useUser } from '@/firebase';
import { Crosshair, ChevronLeft, Lock, Menu, Search, Type } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { NexoTarefaTracker } from '@/components/nexo/NexoTarefaTracker';
import { NexoNavList } from '@/components/nexo/nexo-nav';
import { NexoOmnibox } from '@/components/nexo/nexo-omnibox';
import { NexoMotionProvider } from '@/components/nexo/ui/nexo-motion';
import { FOCO_NEXO } from '@/components/nexo/ui/nexo-tokens';

/** Escala de fonte do NEXO — aplicada na raiz <html> (rem) e persistida. */
const CHAVE_FONTE = 'nexo:acessibilidade:fonte:v1';
const FONTES: Array<{ rotulo: string; valor: number }> = [
  { rotulo: 'A−', valor: 90 },
  { rotulo: 'A', valor: 100 },
  { rotulo: 'A+', valor: 115 },
];

export function NexoShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, loading } = useUser();
  const [drawerAberto, setDrawerAberto] = useState(false);
  const [omniAberto, setOmniAberto] = useState(false);
  const [fontePct, setFontePct] = useState(100);

  // Restaura o tamanho de fonte persistido e aplica na raiz <html> (escala rem).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHAVE_FONTE);
      if (raw) setFontePct(Number(raw));
    } catch {
      /* ignora — default 100% */
    }
  }, []);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontePct}%`;
    try {
      localStorage.setItem(CHAVE_FONTE, String(fontePct));
    } catch {
      /* ignora */
    }
  }, [fontePct]);

  // Fecha o drawer ao trocar de rota (navegou → some o menu no mobile).
  useEffect(() => {
    setDrawerAberto(false);
  }, [pathname]);

  // Atalho global do omnibox (Ctrl/⌘+K).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOmniAberto((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Gate de acesso: a sala de situação só renderiza para usuário autenticado
  // e ATIVO. O LayoutWrapper cuida do redirecionamento; este gate garante que
  // nenhum conteúdo do NEXO apareça antes da confirmação (defesa em camadas).
  if (loading || !user || user.isActive !== true) {
    return (
      <div className="dark">
        <div className="flex min-h-svh items-center justify-center bg-nexo-bg text-sm text-slate-400">
          Verificando acesso à sala de situação…
        </div>
      </div>
    );
  }

  const marca = (
    <Link href="/nexo" className={cnMarca}>
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-amber-500/10 ring-1 ring-amber-500/30">
        <Crosshair className="h-5 w-5 text-amber-400" />
      </div>
      <div className="leading-tight">
        <p className="font-mono text-sm font-bold tracking-[0.2em] text-amber-400">NEXO</p>
        <p className="text-[10px] uppercase tracking-wider text-slate-400">Sala de Situação</p>
      </div>
    </Link>
  );
  const rodapeAside = (
    <div className="flex items-center gap-2 border-t border-white/5 px-5 py-3 text-xs text-slate-500">
      <ChevronLeft className="h-3.5 w-3.5 opacity-0" aria-hidden />
      NEXO-Local — 100% local, custo zero
    </div>
  );

  return (
    <div className="dark">
      <NexoMotionProvider>
        {/* Acessibilidade: pular direto para o conteúdo (teclado/leitor de tela). */}
        <a
          href="#nexo-conteudo"
          className={`sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-amber-400 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-950 ${FOCO_NEXO}`}
        >
          Pular para o conteúdo
        </a>
        {/* Tracker invisível: escuta nexo_tarefas do usuário e dá toast ao concluir. */}
        <NexoTarefaTracker />
        <NexoOmnibox aberto={omniAberto} aoFechar={() => setOmniAberto(false)} />
        <div className="flex h-svh bg-nexo-bg text-slate-300">
          {/* Sidebar desktop */}
          <aside className="hidden h-svh w-64 shrink-0 flex-col border-r border-white/5 bg-nexo-chrome md:flex">
            {marca}
            <NexoNavList />
            {rodapeAside}
          </aside>

          {/* Área principal */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/5 bg-nexo-chrome px-3 sm:px-5">
              {/* Drawer mobile */}
              <Sheet open={drawerAberto} onOpenChange={setDrawerAberto}>
                <SheetTrigger
                  aria-label="Abrir navegação"
                  className={`rounded-md p-2 text-slate-300 hover:bg-white/5 md:hidden ${FOCO_NEXO}`}
                >
                  <Menu className="h-5 w-5" />
                </SheetTrigger>
                <SheetContent side="left" className="flex w-72 flex-col border-white/10 bg-nexo-chrome p-0">
                  <SheetTitle className="sr-only">Navegação do NEXO</SheetTitle>
                  {marca}
                  <NexoNavList aoNavegar={() => setDrawerAberto(false)} />
                  {rodapeAside}
                </SheetContent>
              </Sheet>

              {/* Omnibox trigger */}
              <button
                onClick={() => setOmniAberto(true)}
                className={`flex flex-1 items-center gap-2 rounded-md border border-white/10 bg-nexo-inset px-3 py-1.5 text-sm text-slate-400 hover:border-white/20 hover:text-slate-200 sm:max-w-xs ${FOCO_NEXO}`}
              >
                <Search className="h-4 w-4" />
                <span className="flex-1 text-left">Buscar…</span>
                <kbd className="hidden rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-500 sm:inline">Ctrl K</kbd>
              </button>

              <div className="ml-auto flex items-center gap-2">
                {/* Controle de tamanho de fonte (acessibilidade) */}
                <div
                  className="flex items-center gap-0.5 rounded-md border border-white/10 bg-nexo-inset p-0.5"
                  role="group"
                  aria-label="Tamanho da letra"
                >
                  <Type aria-hidden className="ml-1 mr-0.5 h-3.5 w-3.5 text-slate-400" />
                  {FONTES.map((f) => (
                    <button
                      key={f.valor}
                      type="button"
                      aria-pressed={fontePct === f.valor}
                      onClick={() => setFontePct(f.valor)}
                      title={f.rotulo === 'A−' ? 'Letra menor' : f.rotulo === 'A+' ? 'Letra maior' : 'Letra padrão'}
                      className={`rounded px-1.5 py-0.5 text-xs font-semibold transition-colors ${FOCO_NEXO} ${
                        fontePct === f.valor
                          ? 'bg-amber-500/15 text-amber-300'
                          : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                      }`}
                    >
                      {f.rotulo}
                    </button>
                  ))}
                </div>
                <Lock className="hidden h-3.5 w-3.5 text-amber-500/70 sm:block" />
                <span className="hidden font-mono text-xs uppercase tracking-wider text-slate-400 lg:inline">
                  Núcleo de Enfrentamento e Inteligência Pública
                </span>
                <span className="relative flex h-2 w-2" title="ao vivo">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:animate-none" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
              </div>
            </header>

            <main id="nexo-conteudo" className="nexo-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-5 sm:p-6 lg:p-8">
              {children}
            </main>

            <footer className="border-t border-white/5 px-6 py-3 text-[11px] leading-relaxed text-slate-500">
              O NEXO processa dados públicos e aponta padrões atípicos que podem
              (ou não) indicar irregularidades. Nada aqui constitui acusação ou
              prova — todo indício requer apuração pelos órgãos competentes.
            </footer>
          </div>
        </div>
      </NexoMotionProvider>
    </div>
  );
}

const cnMarca = 'flex items-center gap-3 border-b border-white/5 px-5 py-4';
