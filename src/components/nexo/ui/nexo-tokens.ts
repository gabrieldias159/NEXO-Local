/**
 * Tokens compartilhados do NEXO (sala de situação, tema escuro próprio).
 *
 * PALETA SEMÂNTICA (documentada — usar sempre estes papéis, nunca hex solto):
 *  - âmbar  → marca, ação primária, item ativo, chips de entidade
 *  - emerald→ positivo / vínculo vivo / status online
 *  - red    → sanção, risco alto, erro (o `rose-*` do cluster eleições migra p/ cá)
 *  - sky    → informativo neutro / ente público / link externo (uso contido)
 *
 * SUPERFÍCIES (tokens Tailwind `nexo.*` em tailwind.config.ts):
 *  - bg-nexo-bg      fundo do shell
 *  - bg-nexo-chrome  sidebar/header/inputs/thead
 *  - bg-nexo-surface cards de conteúdo (superfície de leitura)
 *  - bg-nexo-inset   linhas de tabela / poços / células KPI
 *
 * CINZAS (contraste sobre #0a0b0f): texto load-bearing mínimo `slate-400`
 *  (~7:1). `slate-500` só decorativo/redundante. `slate-600` proibido p/ texto.
 */

/** Anel de foco padrão do NEXO — visível (ring-2 âmbar) sobre fundo escuro. */
export const FOCO_NEXO =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/80 focus-visible:ring-offset-1 focus-visible:ring-offset-nexo-bg';

/** Classe base de input/select/controle do NEXO. */
export const INPUT_NEXO =
  'rounded-md border border-white/10 bg-nexo-chrome text-slate-200 placeholder:text-slate-500 ' +
  FOCO_NEXO;

/** Card padrão (superfície de leitura). */
export const CARD_NEXO = 'rounded-lg border border-white/10 bg-nexo-surface';

/** Poço interno (linha de tabela, célula de KPI). */
export const INSET_NEXO = 'rounded-md border border-white/10 bg-nexo-inset';
