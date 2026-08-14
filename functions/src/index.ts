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

// ───────────────────────────────────────────────────────────────────────────
// ESTÚDIO DE VÍDEO — portado do oficioexpress. Roda no emulador de functions
// com o ffmpeg do `@ffmpeg-installer` (render 100% local, custo zero).
//
// EXCEÇÃO: `onVideoCompressTranscoderRequest`/`onTranscoderPoll` falam com o
// Google Cloud Video Transcoder — serviço PAGO e online. Ficam exportados por
// paridade com a origem, mas NÃO funcionam offline; para render local use os
// tiers `onRenderRequest*`, que são ffmpeg puro.

// Compress: 3 tiers (small ≤100MB, medium ≤500MB, large >500MB).
export {
  onVideoCompressRequestSmall,
  onVideoCompressRequestMedium,
  onVideoCompressRequestLarge,
} from "./video/compress";
export { onCompressionStaleCleanup } from "./video/compress-cleanup";
export { onCleanupOrphanVideos } from "./video/orphan-cleanup";
export {
  onVideoCompressTranscoderRequest,
  onTranscoderPoll,
} from "./video/compress-transcoder";
export { onVideoQuickEditRequest } from "./video/quick-edit";
// Render: 3 tiers (low/medium/high). Cliente seleciona via selectRenderTier().
export {
  onRenderRequestLow,
  onRenderRequestMedium,
  onRenderRequestHigh,
} from "./video/render";
export { onCaptionGenerateRequest } from "./video/caption-generate";

// Recortes: gera CAPA (thumbnail) dos vídeos — trigger p/ novos + backfill admin.
export {
  onRecorteVideoCreated,
  onGerarCapasRecortes,
} from "./video/recorte-thumbnail";
// Render: gera CAPA (thumbnail) do vídeo de saída — triggers (update/create) +
// backfill admin. Sem esses exports os triggers não deployam.
export {
  onRenderJobThumbnail,
  onRenderJobThumbnailCreated,
  onGerarCapasRenders,
} from "./video/render-thumbnail";
// Recortes: PREVIEW (rendition 720p+faststart) no bucket de São Paulo.
export {
  onRecorteVideoPreview,
  onGerarPreviewsRecortes,
} from "./video/recorte-preview";

// Cleanup de Storage ao apagar tasks (manual ou via TTL de 14 dias).
// Evita acumular arquivos orfaos em `renders/{uid}/`.
export {
  onRenderJobDeleted,
  onQuickEditJobDeleted,
} from "./video/job-cleanup";
