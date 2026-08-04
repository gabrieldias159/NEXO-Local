/**
 * Catálogo da AGENDA de crons do NEXO — snapshot dos agendamentos das Cloud
 * Functions em `functions/src/nexo/*` (espelho das definições `onSchedule`).
 *
 * Esta tabela alimenta `/nexo/crons` (painel "Cron & Processamento"): permite
 * ver O QUE está agendado (função + cron + área) e cruzar com o estado real de
 * absorção vindo de `nexo_sync_state` via `/api/nexo/saude-ingestao`.
 *
 * `fonte` (opcional) liga o cron à saúde da ingestão: quando presente, o painel
 * tenta casar com a fonte homônima em `SaudeIngestaoResponse.fontes[].fonte`. Se
 * não houver correspondência, o cron aparece mesmo assim (agenda), sem o
 * semáforo — porque nem todo cron grava nexo_sync_state com o mesmo nome.
 *
 * Cron em BRT (America/Sao_Paulo). Manter em sintonia com o código das
 * functions — este arquivo é somente de exibição.
 */
export type AreaCron = 'Coleta' | 'Fontes Externas' | 'Inteligência' | 'Verticais IA' | 'Jobs';

export interface CronDef {
  /** Nome da Cloud Function agendada. */
  fn: string;
  /** Rótulo amigável exibido no painel. */
  nome: string;
  /** Expressão cron (BRT). */
  cron: string;
  /** Leitura humana da frequência. */
  frequencia: string;
  /** Área/categoria do processador. */
  area: AreaCron;
  /** Chave da fonte em `nexo_sync_state` p/ cruzar com a saúde (se aplicável). */
  fonte?: string;
}

/**
 * Fonte única (para exibição) do agendamento. Ordem de exibição segue a lista.
 */
export const CRONS: CronDef[] = [
  // ── Coleta diária (SMARAPD) ────────────────────────────────────────────────
  { fn: 'onNexoColetaDiaria', nome: 'Coleta diária SMARAPD', cron: '15 4 * * *', frequencia: 'Diária 04:15', area: 'Coleta', fonte: 'coleta_diaria' },
  { fn: 'onNexoColetaDom', nome: 'Coleta do Diário Oficial (DOM)', cron: '45 6 * * *', frequencia: 'Diária 06:45', area: 'Coleta', fonte: 'diario_dom' },

  // ── Fontes externas / órgãos fiscalizadores ────────────────────────────────
  { fn: 'onNexoSyncSiconfi', nome: 'SICONFI (RREO/RGF)', cron: '5 5 1,16 * *', frequencia: 'Quinzenal 05:05', area: 'Fontes Externas', fonte: 'siconfi' },
  { fn: 'onNexoSyncTce', nome: 'TCE-SP agregado (fornecedores)', cron: '45 5 1,16 * *', frequencia: 'Quinzenal 05:45', area: 'Fontes Externas', fonte: 'tce' },
  { fn: 'onNexoSyncTceDespesas', nome: 'TCE-SP despesas por empenho', cron: '5 6 1,16 * *', frequencia: 'Quinzenal 06:05', area: 'Fontes Externas', fonte: 'tce_despesas' },
  { fn: 'onNexoSyncContratos', nome: 'Contratos municipais (Dados Abertos)', cron: '35 5 * * *', frequencia: 'Diária 05:35', area: 'Fontes Externas', fonte: 'contratos' },
  { fn: 'onNexoSyncLicitacoes', nome: 'Licitações & dispensas', cron: '45 5 * * *', frequencia: 'Diária 05:45', area: 'Fontes Externas', fonte: 'licitacoes' },
  { fn: 'onNexoSyncPncp', nome: 'Contratos PNCP (portal nacional)', cron: '25 5 * * *', frequencia: 'Diária 05:25', area: 'Fontes Externas', fonte: 'pncp' },
  { fn: 'onNexoSyncSancoes', nome: 'Sanções federais (CGU)', cron: '30 10 * * *', frequencia: 'Diária 10:30', area: 'Fontes Externas', fonte: 'sancoes' },
  { fn: 'onNexoSyncSancoesEstaduais', nome: 'Sanções estaduais (SP)', cron: '15 11 * * *', frequencia: 'Diária 11:15', area: 'Fontes Externas', fonte: 'sancoes_estaduais' },
  { fn: 'onNexoSyncLeniencia', nome: 'Acordos de Leniência', cron: '0 7 3 * *', frequencia: 'Mensal (dia 3) 07:00', area: 'Fontes Externas', fonte: 'leniencia' },
  { fn: 'onNexoSyncLei13019', nome: 'Parcerias (Lei 13.019)', cron: '40 6 1,16 * *', frequencia: 'Quinzenal 06:40', area: 'Fontes Externas', fonte: 'lei13019' },

  // ── Inteligência / processamento ───────────────────────────────────────────
  { fn: 'onNexoMatVinculoVivo', nome: 'Matriz de vínculo vivo', cron: '15 8 * * *', frequencia: 'Diária 08:15', area: 'Inteligência', fonte: 'mat_vínculo_vivo' },
  { fn: 'onNexoLinkage', nome: 'Linkage (concatenação por chave)', cron: '15 7 * * *', frequencia: 'Diária 07:15', area: 'Inteligência', fonte: 'linkage' },
  { fn: 'onNexoPerfilEntidades', nome: 'Perfil de entidades', cron: '45 7 * * *', frequencia: 'Diária 07:45', area: 'Inteligência', fonte: 'perfil_entidades' },
  { fn: 'onNexoScoreEntidades', nome: 'Score de entidades', cron: '30 8 * * *', frequencia: 'Diária 08:30', area: 'Inteligência', fonte: 'score_entidades' },
  { fn: 'onNexoCruzamentos', nome: 'Cruzamentos (lado a lado)', cron: '45 8 * * *', frequencia: 'Diária 08:45', area: 'Inteligência', fonte: 'cruzamentos' },
  { fn: 'onNexoCruzamentoPessoas', nome: 'Cruzamento entre pessoas', cron: '15 9 * * *', frequencia: 'Diária 09:15', area: 'Inteligência', fonte: 'cruzamento_pessoas' },
  { fn: 'onNexoColetaSocios', nome: 'Coleta de sócios (QSA)', cron: '15 8 * * *', frequencia: 'Diária 08:15', area: 'Inteligência', fonte: 'socios' },
  { fn: 'onNexoDetectarAlteracoes', nome: 'Detectar alterações (snapshots)', cron: '35 6 * * *', frequencia: 'Diária 06:35', area: 'Inteligência', fonte: 'alteracoes' },

  // ── Verticais IA ───────────────────────────────────────────────────────────
  { fn: 'onNexoGerente', nome: 'Gerente (briefings)', cron: '0 9 * * *', frequencia: 'Diária 09:00', area: 'Verticais IA', fonte: 'gerente' },
  { fn: 'onNexoAdvogado', nome: 'Advogado (pareceres)', cron: '30 9 * * *', frequencia: 'Diária 09:30', area: 'Verticais IA', fonte: 'advogado' },

  // ── Jobs / manutenção ──────────────────────────────────────────────────────
  { fn: 'onNexoTarefasNightly', nome: 'Enfileira recompute (nightly)', cron: '30 4 * * *', frequencia: 'Diária 04:30', area: 'Jobs', fonte: 'tarefas_nightly' },
  { fn: 'onNexoTarefasTtl', nome: 'TTL (snapshots/tarefas)', cron: '0 */6 * * *', frequencia: '6 em 6h', area: 'Jobs', fonte: 'tarefas_ttl' },
];