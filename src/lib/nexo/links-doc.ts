/**
 * NEXO — deep-links de DOCUMENTOS (camada de strings de URL, sem I/O).
 *
 * Helper PURO que materializa as receitas de URL CONFIRMADAS para os papéis
 * públicos que o `procedencia.ts` transforma em `Procedencia`. Aqui mora só a
 * construção da string (padrão da fonte + encode); a embalagem no contrato
 * `Procedencia` (label, tipoDoc, podePreview, refColecao/refId) fica no builder.
 *
 * Por que separado: as receitas de URL são compartilhadas (contrato municipal,
 * edital/dispensa do portal, edição do DOM, doc do catálogo) e precisam ser
 * testáveis isoladamente. NÃO inventar URL: cada função abaixo reproduz um
 * padrão já verificado ao vivo — ver docs/nexo-provas-plano.md e os coletores
 * em functions/src/nexo/{coleta-contratos,coleta-licitacoes,coleta-dom}.ts.
 */
import { FONTES } from './constants';

/** Base do portal institucional (SiGoverno) — `…/portal`, sem barra final. */
export const PORTAL_BASE = FONTES.portalPrefeitura.replace(/\/$/, '');

/** Normaliza para o deep-link posicional do portal (vazio → "0"). */
function seg(v: string | null | undefined): string {
  const s = (v ?? '').trim();
  return s ? encodeURIComponent(s) : '0';
}

// ── Contrato municipal (Portal SiGoverno / Dados Abertos) ────────────────────

/**
 * Deep-link FORTE de detalhe de contrato no portal — `…/portal/contrato/{id}`.
 * O `{id}` é o sequencial INTERNO do portal (não derivável de número/processo);
 * só existe quando a coleta já o descobriu. Use quando tiver o id; senão use
 * `urlBuscaContratoMunicipal`.
 */
export function urlContratoMunicipalDetalhe(idInterno: string): string {
  return `${PORTAL_BASE}/contrato/${encodeURIComponent(idInterno)}`;
}

/**
 * Busca pré-preenchida de contrato no portal (mesma forma posicional que o
 * coletor `coleta-contratos` grava como `url` do documento). Filtra por
 * contratada/número/processo. É o fallback quando não há o `{id}` interno.
 */
export function urlBuscaContratoMunicipal(c: {
  contratada?: string | null;
  numeroContrato?: string | null;
  numeroProcesso?: string | null;
}): string {
  const contratada = seg(c.contratada);
  const numero = seg(c.numeroContrato);
  const processo = seg(c.numeroProcesso);
  return `${PORTAL_BASE}/contratos/1/0/${contratada}/${numero}/${processo}/0/9/0/0/0/0/0/0/0`;
}

/** PDF assinado do contrato — `…/portal/download/contratos/{token}/` ({token} opaco). */
export function urlPdfContratoMunicipal(token: string): string {
  return `${PORTAL_BASE}/download/contratos/${encodeURIComponent(token)}/`;
}

// ── Edital / licitação (Portal SiGoverno) ────────────────────────────────────

/** Detalhe FORTE de edital — `…/portal/editais/0/1/{id}/` ({id} interno do portal). */
export function urlEditalMunicipalDetalhe(idInterno: string): string {
  return `${PORTAL_BASE}/editais/0/1/${encodeURIComponent(idInterno)}/`;
}

/**
 * Listagem de editais/licitações do portal — fallback sem `{id}` interno.
 * Forma posicional `…/portal/editais/1` (tipo 1 = licitação). Verificado ao vivo
 * (HTTP 200, listagem com 5.577 editais). O antigo `…/portal/licitacoes`
 * retornava HTTP 404 (rota inexistente no SiGoverno) — link "em branco/404".
 */
export function urlListagemLicitacoes(): string {
  return `${PORTAL_BASE}/editais/1`;
}

// ── Dispensa / contratação direta (Portal SiGoverno) ─────────────────────────

/**
 * Listagem de compras diretas (dispensa/inexigibilidade/adesão) do portal — a
 * fonte não expõe URL canônica por processo, então o link forte é a listagem.
 * Forma posicional `…/portal/editais/4` (tipo 4 = Compra Direta). Verificado ao
 * vivo (HTTP 200, 1.688 registros: Dispensa/Inexigibilidade/Credenciamento). O
 * antigo `…/portal/compras-diretas` retornava HTTP 404 (rota inexistente) —
 * link "em branco/404". NB: `coleta-licitacoes.ts` grava essa MESMA url quebrada
 * em `nexo_licitacoes.url` (functions/, fora deste arquivo) → bug gêmeo a tratar
 * na pista de coleta.
 */
export function urlListagemComprasDiretas(): string {
  return `${PORTAL_BASE}/editais/4`;
}

// ── Edição do DOM (Querido Diário + visualizador interno) ────────────────────

/** Página interna da edição do Diário Oficial — `/diario-oficial/{ano}/{edicao}`. */
export function urlPaginaDom(ano: string | number, edicao: string | number): string {
  return `/diario-oficial/${ano}/${edicao}`;
}

/**
 * Proxy interno do PDF da edição (re-servido same-origin → EMBEDÁVEL em iframe).
 * `/api/diario-oficial/edition/{ano}/{edicao}/pdf`. Preferir quando há nº de
 * edição; é o que dá o preview inline da prova.
 */
export function urlPdfDomProxy(ano: string | number, edicao: string | number): string {
  return `/api/diario-oficial/edition/${ano}/${edicao}/pdf`;
}

/**
 * URL do PDF OFICIAL da edição, direto do Querido Diário — o campo `url`
 * (`urlPdf`) que o coletor `coleta-dom` persiste em `nexo_diario_dom`/
 * `nexo_documentos`. É a prova primária; passar VERBATIM (não re-encodar).
 */
export function urlPdfDomQueridoDiario(urlPdf: string): string {
  return urlPdf;
}

// ── Documento genérico do catálogo `nexo_documentos` ─────────────────────────

/** Campos do catálogo que carregam a URL-prova de um documento. */
export interface DocCatalogoLink {
  /** `docId` determinístico (sha1) do registro em `nexo_documentos`. */
  docId?: string | null;
  /** Chave canônica `tipo:valor` (ex.: `processo:12345/2026`), p/ rastro. */
  chave?: string | null;
  /** URL da página/registro do documento na fonte (campo `url` do catálogo). */
  url?: string | null;
  /** URL direta do PDF/arquivo (campo `pdfUrl` do catálogo), quando exposta. */
  pdfUrl?: string | null;
}

/**
 * Escolhe a melhor URL-prova de um documento do catálogo: PDF direto (preferido,
 * embedável) > página/registro da fonte. `null` quando o documento não expõe
 * nenhuma URL — honesto, sem inventar link. O `docId`/`chave` continuam servindo
 * como ponteiro ao registro bruto (2º nível), independentemente da URL.
 */
export function urlDocCatalogo(d: DocCatalogoLink): {
  url: string | null;
  ehPdf: boolean;
} {
  const pdf = (d.pdfUrl ?? '').trim();
  if (pdf) return { url: pdf, ehPdf: true };
  const url = (d.url ?? '').trim();
  if (url) return { url, ehPdf: false };
  return { url: null, ehPdf: false };
}
