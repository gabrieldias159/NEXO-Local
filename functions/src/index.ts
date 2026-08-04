/**
 * Entry point das Cloud Functions do NEXO.
 *
 * Extraído do monorepo oficioexpress (barrel original tinha video/diário/acervo
 * também) — aqui só ficam as functions que o NEXO usa: coleta, inteligência
 * (linkage/perfil/score), verticais (gerente/advogado) e infra de jobs.
 * `firebase deploy --only functions` (ou o emulador) descobre cada export aqui.
 */

// NEXO — engine de ingestão: cron diário (todos os módulos SMARAPD ×
// exercício corrente + retroativo 2025) + backfill HTTP sob demanda.
export { onNexoColetaDiaria, onNexoBackfillHttp } from "./nexo/coleta";

// NEXO — crons de ingestão das fontes externas:
export { onNexoSyncSiconfi } from "./nexo/coleta-siconfi";
export { onNexoSyncPncp } from "./nexo/coleta-pncp";
export { onPncpProxy } from "./nexo/pncp-proxy";
export { onNexoSyncSancoes } from "./nexo/coleta-sancoes";
export { onNexoSyncLeniencia } from "./nexo/coleta-leniencia";
export { onNexoSyncSancoesEstaduais } from "./nexo/coleta-sancoes-estaduais";
export {
  onNexoSyncLei13019,
  onNexoBackfillLei13019Http,
} from "./nexo/coleta-lei13019";
export { onNexoMatVinculoVivo } from "./nexo/mat-vinculo-vivo";
export { onNexoSyncTce } from "./nexo/coleta-tce";
export { onNexoSyncTceDespesas } from "./nexo/coleta-tce-despesas";
export { onNexoSyncContratos } from "./nexo/coleta-contratos";
export { onNexoSyncLicitacoes } from "./nexo/coleta-licitacoes";
export { onNexoEnriqueceContratos } from "./nexo/enriquecimento-contratos";

// NEXO — coleta do DOM full-text (Querido Diário):
export { onNexoColetaDom } from "./nexo/coleta-dom";

// NEXO — DOADORES DE CAMPANHA (TSE dados abertos):
export {
  onNexoBackfillTseDoacoes,
  onNexoBackfillTseDoacoesHttp,
  onNexoBackfillChaveFraca,
  onNexoSyncTseDoacoes,
} from "./nexo/coleta-tse-doacoes";

// NEXO — CANDIDATOS TSE:
export { onNexoBackfillTseCandidatos } from "./nexo/coleta-tse-candidatos";
export { onNexoBackfillTseDespesasHttp } from "./nexo/coleta-tse-despesas";

// NEXO — CRUZAMENTO DE PESSOAS:
export { onNexoCruzamentoPessoas } from "./nexo/cruzamento-pessoas";

// NEXO — CONTAS JULGADAS IRREGULARES (TCE-SP):
export {
  onNexoBackfillContasIrregulares,
  onNexoSyncContasIrregulares,
} from "./nexo/coleta-contas-irregulares";

// NEXO — motor de LINKAGE:
export { onNexoLinkage } from "./nexo/linkage";

// NEXO — CRUZAMENTOS MATERIALIZADOS:
export { onNexoCruzamentos } from "./nexo/cruzamentos";

// NEXO — RAIO-X das entidades:
export { onNexoPerfilEntidades } from "./nexo/perfil-entidades";

// NEXO — motor de SCORE de risco:
export { onNexoScoreEntidades } from "./nexo/score-entidades";

// NEXO — GRAFO SOCIETÁRIO:
export { onNexoColetaSocios } from "./nexo/coleta-socios";

// NEXO — ALTERAÇÃO RETROATIVA:
export { onNexoDetectarAlteracoes } from "./nexo/alteracao";

// NEXO — vertical GERENTE:
export { onNexoGerente } from "./nexo/gerente";

// NEXO — vertical ADVOGADO:
export { onNexoAdvogado } from "./nexo/advogado";

// NEXO — INFRA DE JOBS/SNAPSHOTS:
export { onNexoTarefaCriada } from "./nexo/jobs-worker";
export { onNexoTarefasNightly } from "./nexo/jobs-nightly";
export {
  onNexoTarefasTtl,
  onNexoSnapshotDeleted,
} from "./nexo/jobs-ttl";

// ───────────────────────────────────────────────────────────────────────────
// IA — ponte de CONFIG + USO da camada multi-provider. Endpoint HTTP
// `onIaConfigUso`: GET ?action=config lê config/ia (Admin SDK) p/ o app montar
// a cadeia de provedores; POST ?action=uso agrega métricas em
// ia_uso/{AAAA-MM-DD}. O app (Next.js) não tem admin — por isso esta function
// é a que lê/escreve com privilégio. Usada pelas verticais GERENTE/ADVOGADO.
export { onIaConfigUso } from "./ia/config-uso";
