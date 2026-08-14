'use client';

/**
 * Navegação do NEXO — extraída do shell para ser reusada pelo aside (desktop) e
 * pelo drawer (mobile). Grupos colapsáveis (Radix Collapsible), item ativo
 * destacado, estado aberto/fechado persistido em localStorage. Item `externo`
 * (Diário Oficial) abre em nova aba em vez de ejetar do shell.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import {
  Radar, ClipboardList, Database, Building2, ScrollText, HardHat, Users, Gauge,
  ShieldAlert, Newspaper, Cpu, FolderOpen, Landmark, HandCoins, FileSearch,
  FileSignature, Ban, Scale, ScanSearch, Gavel, Wallet, PieChart, Network, Eye,
  ListChecks, Trophy, Vote,   ChevronDown, ExternalLink, Crosshair, UserSearch, MapPinned, Activity,
  TrendingUp, PiggyBank, Clapperboard, Film,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { FOCO_NEXO } from './ui/nexo-tokens';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Rota FORA do shell do NEXO — abre em nova aba (não ejeta a sala). */
  externo?: boolean;
  /** Termos extras (não exibidos) que o omnibox também deve casar. */
  aliases?: string[];
}
export interface NavGrupo {
  grupo: string;
  itens: NavItem[];
}

export const NAV: NavGrupo[] = [
  {
    grupo: 'Inteligência',
    itens: [
      { href: '/nexo', label: 'Painel de Situação', icon: Radar },
      { href: '/nexo/briefing', label: 'Briefing', icon: ClipboardList },
      {
        href: '/nexo/perfis',
        label: 'Pessoa Física / Jurídica',
        icon: UserSearch,
        aliases: ['busca de perfis', 'pessoa fisica', 'pessoa juridica', 'cpf', 'cnpj', 'pf', 'pj'],
      },
      { href: '/nexo/busca', label: 'Busca & Raio-X', icon: ScanSearch },
      { href: '/nexo/grafo', label: 'Grafo de Vínculos', icon: Network },
      { href: '/nexo/ranking', label: 'Ranking de Vínculos', icon: Trophy },
      { href: '/nexo/risco', label: 'Painel de Risco', icon: ShieldAlert },
      { href: '/nexo/investigacoes', label: 'Investigações', icon: Crosshair },
    ],
  },
  {
    grupo: 'Eleições',
    itens: [
      { href: '/nexo/eleicoes', label: 'Eleições Municipais', icon: Vote },
      { href: '/nexo/eleicoes/doadores', label: 'Doadores', icon: HandCoins },
      { href: '/nexo/eleicoes/mapa', label: 'Mapa por Bairro', icon: MapPinned },
    ],
  },
  {
    grupo: 'Dados',
    itens: [
      { href: '/nexo/coleta', label: 'Coleta & Fontes', icon: Database },
      { href: '/nexo/crons', label: 'Cron & Processamento', icon: ListChecks },
      { href: '/nexo/empenhos', label: 'Empenhos & Pagamentos', icon: Wallet },
      { href: '/nexo/orcamento', label: 'Execução Orçamentária', icon: PieChart },
      { href: '/nexo/orcamento/evolucao', label: 'Evolução (multi-ano)', icon: TrendingUp, aliases: ['evolução orçamentária', 'comparar anos', 'histórico orçamento'] },
      { href: '/nexo/orcamento/rap', label: 'Restos a Pagar (RAP)', icon: PiggyBank, aliases: ['rap', 'restos a pagar', 'cobertura de caixa'] },
      { href: '/nexo/emendas', label: 'Emendas Parlamentares', icon: Landmark },
      { href: '/nexo/fornecedores', label: 'Fornecedores', icon: Building2 },
      { href: '/nexo/contratos', label: 'Contratos & Licitações', icon: ScrollText },
      { href: '/nexo/contratos-pncp', label: 'Contratos PNCP', icon: FileSignature },
      { href: '/nexo/licitacoes', label: 'Licitações & Dispensas', icon: Gavel },
      { href: '/nexo/obras', label: 'Obras', icon: HardHat },
      { href: '/nexo/folha', label: 'Folha (Prefeitura)', icon: Users },
      { href: '/nexo/servidores-camara', label: 'Servidores (Câmara)', icon: Building2 },
      { href: '/nexo/receita', label: 'Receita', icon: Landmark },
    ],
  },
  {
    grupo: 'Monitoramento',
    itens: [
      { href: '/nexo/metas-fiscais', label: 'Metas Fiscais', icon: Gauge },
      { href: '/nexo/convenios', label: 'Convênios & 3º Setor', icon: HandCoins },
      { href: '/nexo/empresas-sancionadas', label: 'Empresas Sancionadas', icon: ShieldAlert },
      { href: '/nexo/sancoes', label: 'Sanções Federais', icon: Ban },
      { href: '/nexo/tce', label: 'TCE-SP', icon: Scale },
      { href: '/diario-oficial', label: 'Diário Oficial', icon: Newspaper, externo: true },
      { href: '/nexo/diario-sinais', label: 'Sinais do DOM', icon: FileSearch },
    ],
  },
  {
    grupo: 'Operação',
    itens: [
      { href: '/nexo/tarefas', label: 'Tarefas', icon: ListChecks },
      { href: '/nexo/processadores', label: 'Processadores', icon: Cpu },
      { href: '/nexo/vigilancia', label: 'Vigilância', icon: Eye },
      { href: '/nexo/saude-sistema', label: 'Saúde do Sistema', icon: Activity },
      { href: '/nexo/dossies', label: 'Dossiês', icon: FolderOpen },
    ],
  },
  {
    grupo: 'Estúdio',
    itens: [
      // Ambos vivem FORA do shell (`/apps/*`): são editores full-screen, que
      // precisam da viewport inteira — daí `externo: true` (abre em nova aba,
      // sem ejetar a sala de situação).
      {
        href: '/apps/suite-editor-videos',
        label: 'Estúdio de Vídeo (avançado)',
        icon: Clapperboard,
        externo: true,
        aliases: ['suite', 'editor avançado', 'timeline', 'legendas', 'render'],
      },
      {
        href: '/apps/editor-videos',
        label: 'Estúdio de Vídeo (básico)',
        icon: Film,
        externo: true,
        aliases: ['editor básico', 'logo', 'rodapé', 'marca d\'água'],
      },
    ],
  },
];

/** Todos os hrefs internos do menu — para o "match mais longo vence". */
const TODOS_HREFS = NAV.flatMap((g) => g.itens.filter((i) => !i.externo).map((i) => i.href));

/**
 * Item ativo = o href do menu com o MAIOR prefixo que casa o pathname. Assim
 * `/nexo/eleicoes/doadores` acende SÓ "Doadores" (não também "Eleições"), e
 * `/nexo/eleicoes` acende só "Eleições" — sem marcar dois itens aninhados.
 */
function hrefAtivo(pathname: string): string | null {
  let melhor: string | null = null;
  for (const h of TODOS_HREFS) {
    const casa = h === '/nexo' ? pathname === '/nexo' : pathname === h || pathname.startsWith(h + '/');
    if (casa && (melhor === null || h.length > melhor.length)) melhor = h;
  }
  return melhor;
}

/** Rótulos únicos p/ o omnibox (seção "Ir para"). */
export const ROTAS_NAV = NAV.flatMap((g) =>
  g.itens
    .filter((i) => !i.externo)
    .map((i) => ({ href: i.href, label: i.label, grupo: g.grupo, aliases: i.aliases ?? [] })),
);

const CHAVE_LS = 'nexo:nav:v1';

export function NexoNavList({ aoNavegar }: { aoNavegar?: () => void }) {
  const pathname = usePathname();
  const [fechados, setFechados] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHAVE_LS);
      if (raw) setFechados(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignora — default: todos abertos */
    }
  }, []);

  const alternar = (grupo: string, aberto: boolean) => {
    setFechados((prev) => {
      const prox = new Set(prev);
      if (aberto) prox.delete(grupo);
      else prox.add(grupo);
      try {
        localStorage.setItem(CHAVE_LS, JSON.stringify([...prox]));
      } catch {
        /* ignora */
      }
      return prox;
    });
  };

  const ativo = hrefAtivo(pathname);
  return (
    <nav className="nexo-scroll min-h-0 flex-1 overflow-y-auto px-3 py-4">
      {NAV.map((grupo) => {
        const aberto = !fechados.has(grupo.grupo);
        const temAtivo = grupo.itens.some((i) => !i.externo && i.href === ativo);
        return (
          <Collapsible.Root
            key={grupo.grupo}
            open={aberto || temAtivo}
            onOpenChange={(o) => alternar(grupo.grupo, o)}
            className="mb-4"
          >
            <Collapsible.Trigger
              className={cn(
                'flex w-full items-center justify-between rounded px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400 hover:text-slate-200',
                FOCO_NEXO,
              )}
            >
              {grupo.grupo}
              <ChevronDown
                className={cn('h-3 w-3 transition-transform', !(aberto || temAtivo) && '-rotate-90')}
              />
            </Collapsible.Trigger>
            <Collapsible.Content>
              <ul className="space-y-0.5">
                {grupo.itens.map((item) => {
                  const Icon = item.icon;
                  const active = !item.externo && item.href === ativo;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        target={item.externo ? '_blank' : undefined}
                        rel={item.externo ? 'noopener noreferrer' : undefined}
                        aria-current={active ? 'page' : undefined}
                        onClick={aoNavegar}
                        className={cn(
                          'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                          FOCO_NEXO,
                          active
                            ? 'bg-amber-500/10 font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20'
                            : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                        {item.externo && <ExternalLink className="ml-auto h-3 w-3 shrink-0 text-slate-500" />}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Collapsible.Content>
          </Collapsible.Root>
        );
      })}
    </nav>
  );
}
