/**
 * NEXO — Procedência (rastro probatório) de uma evidência.
 *
 * Builder PURO (sem I/O) que, a partir do ref/registro de uma evidência,
 * devolve um link clicável para a PROVA documental de onde o dado saiu — o
 * deep-link da fonte (empenho no portal, PDF no paifileserver, contrato no
 * PNCP, matéria no Diário) + ponteiro ao registro bruto coletado.
 *
 * Receitas confirmadas ao vivo — ver docs/nexo-provas-plano.md.
 * Tudo opcional/retrocompatível: quando não há como provar, retorna null.
 */
import { FONTES, MARILIA } from './constants';
import type { AlertaDetectado, Evidencia, Procedencia } from './detectores/tipos';
import {
  type DocCatalogoLink,
  urlBuscaContratoMunicipal,
  urlContratoMunicipalDetalhe,
  urlDocCatalogo,
  urlEditalMunicipalDetalhe,
  urlListagemComprasDiretas,
  urlListagemLicitacoes,
  urlPdfContratoMunicipal,
  urlPdfDomProxy,
} from './links-doc';

/** Host da SPA do portal (sem o sufixo /paiportalserver). */
const SMARAPD_SPA = FONTES.smarapd.replace(/\/paiportalserver\/?$/, '');

/** Módulo SMARAPD por tipo de objeto → link de consulta + coleção bruta. */
const MAPA_SMARAPD: Record<string, { mod: string; visao: string; col: string }> = {
  empenho: { mod: 'fornecedor', visao: 'fornecedoranalitico', col: 'nexo_empenhos' },
  fornecedor: { mod: 'fornecedor', visao: 'fornecedoranalitico', col: 'nexo_empenhos' },
  contrato: { mod: 'fornecedor', visao: 'fornecedoranalitico', col: 'nexo_empenhos' },
  despesa: { mod: 'DespesaAgrupada', visao: 'DespesaseInvestimentos', col: 'nexo_despesas' },
  diaria: { mod: 'diarias', visao: 'diarias', col: 'nexo_diarias' },
  servidor: { mod: 'pagamentos', visao: 'pagamentoaservidores', col: 'nexo_pagamentos' },
  'servidor-folha': { mod: 'pagamentos', visao: 'pagamentoaservidores', col: 'nexo_pagamentos' },
  resto: { mod: 'restoapagar', visao: 'restoapagar', col: 'nexo_restos' },
  modalidade: { mod: 'quadro_de_renda_local', visao: 'EmpenhoModalidade', col: 'nexo_modalidades' },
};

/** Link de MÓDULO do portal SMARAPD — a prova primária é o registro bruto. */
export function smarapdModulo(
  chave: string,
  exercicio: number,
  ref?: string,
): Procedencia | null {
  const m = MAPA_SMARAPD[chave];
  if (!m) return null;
  // O portal é uma SPA (Angular) e NÃO suporta deep-link por path/query — a
  // rota `/dinamico/{mod}/{visao}` abria EM BRANCO. Apontamos para a HOME do
  // portal (carrega) e identificamos a consulta no `label`; a referência exata
  // do registro fica em refColecao/refId (a prova de 2º nível, sempre presente).
  void exercicio;
  return {
    fonte: 'SMARAPD',
    label: `Abrir o Portal da Transparência (consulta: ${m.mod})`,
    url: `${SMARAPD_SPA}/`,
    tipoDoc: 'modulo',
    podePreview: false,
    refColecao: m.col,
    refId: ref || undefined,
  };
}

/**
 * PDF direto de visão fixa / portaria (paifileserver). Deep-link real e
 * embedável. `arquivoUrl` JÁ vem percent-encoded — passar VERBATIM.
 */
export function smarapdPdf(arquivoUrl: string, label = 'Abrir PDF original'): Procedencia {
  const base = FONTES.smarapdFiles.replace(/\/$/, '');
  return {
    fonte: 'SMARAPD',
    label,
    url: `${base}/filemanager/pai/download?nomeArquivo=${arquivoUrl}&isInlineContent=true`,
    tipoDoc: 'pdf',
    podePreview: true, // CORS '*', sem Content-Disposition → iframe direto
  };
}

/** numeroControlePNCP: {cnpj}-{tipo}-{seq}/{ano}. tipo 2 = contrato, 1 = compra/edital. */
const RE_PNCP = /^(\d{14})-([12])-0*(\d+)\/(\d{4})$/;
export function pncpFromRef(ref?: string): Procedencia | null {
  const m = ref?.match(RE_PNCP);
  if (!m) return null;
  const [, cnpj, tipo, seq, ano] = m;
  const contrato = tipo === '2';
  return {
    fonte: 'PNCP',
    label: contrato ? 'Abrir contrato no PNCP' : 'Abrir edital no PNCP',
    url: `https://pncp.gov.br/app/${contrato ? 'contratos' : 'editais'}/${cnpj}/${ano}/${seq}`,
    tipoDoc: 'pagina',
    podePreview: false, // SPA com frame-guard
    refColecao: 'nexo_contratos_pncp',
    refId: ref,
  };
}

/** Ref do Diário: {ano}_{edicao} (opcionalmente _ato{idx}). Linka a edição interna. */
const RE_DOM = /^(\d{4})_(\d+)(?:_ato\d+)?$/;
export function domFromRef(ref?: string): Procedencia | null {
  const m = ref?.match(RE_DOM);
  if (!m) return null;
  const [, ano, ed] = m;
  return {
    fonte: 'DOM',
    label: 'Abrir edição do Diário Oficial',
    url: `/diario-oficial/${ano}/${ed}`,
    tipoDoc: 'pagina',
    podePreview: false,
    refColecao: 'diarios',
    refId: `${ano}_${ed}`,
  };
}

/**
 * Edição do DOM pela PROVA (PDF) — não pelo ref interno. Recebe `ano`+`edicao`
 * e linka o proxy interno do PDF (`/api/diario-oficial/edition/{ano}/{ed}/pdf`),
 * que é re-servido same-origin e portanto EMBEDÁVEL (preview inline). O `urlPdf`
 * oficial do Querido Diário (quando coletado) vira o ponteiro bruto.
 *
 * Distinto de `domFromRef` (que linka a PÁGINA da edição a partir do ref
 * `{ano}_{edicao}`): aqui o link primário é o PDF da prova.
 *
 * O `urlPdfOficial` (campo `urlPdf` do Querido Diário, quando coletado) NÃO é
 * usado como `url` clicável porque o PDF do portal manda X-Frame que impede
 * embed direto — o proxy interno é que dá o preview. Ele segue como informação
 * de origem implícita no ponteiro bruto `nexo_diario_dom/{ano}_{edicao}`.
 */
export function domEdicaoPdf(
  ano: string | number,
  edicao: string | number,
  _urlPdfOficial?: string | null,
): Procedencia | null {
  const a = String(ano).trim();
  const ed = String(edicao).trim();
  if (!/^\d{4}$/.test(a) || !ed) return null;
  return {
    fonte: 'DOM',
    label: 'Abrir PDF do Diário Oficial',
    url: urlPdfDomProxy(a, ed),
    tipoDoc: 'pdf',
    podePreview: true, // proxy same-origin (X-Frame SAMEORIGIN) → iframe direto
    refColecao: 'nexo_diario_dom',
    refId: `${a}_${ed}`,
  };
}

// ── Documentos do PORTAL da Prefeitura (SiGoverno / Dados Abertos) ────────────

/**
 * Contrato municipal — deep-link do portal institucional. Com o `{id}` interno
 * (descoberto pela coleta) gera o detalhe FORTE `…/portal/contrato/{id}`; com o
 * `{token}` opaco, o PDF assinado (embedável). Sem nenhum dos dois, cai na busca
 * pré-preenchida por contratada/número/processo. NUNCA retorna null: o pior caso
 * ainda é uma busca clicável que leva ao papel.
 */
export function contratoMunicipal(c: {
  idInterno?: string | null;
  tokenPdf?: string | null;
  numeroContrato?: string | null;
  numeroProcesso?: string | null;
  contratada?: string | null;
}): Procedencia {
  const base = {
    fonte: 'PORTAL-MARILIA' as const,
    refColecao: 'nexo_contratos_municipais',
    refId: c.numeroContrato?.trim() || c.numeroProcesso?.trim() || undefined,
  };
  if (c.tokenPdf?.trim()) {
    return {
      ...base,
      label: 'Abrir PDF do contrato',
      url: urlPdfContratoMunicipal(c.tokenPdf.trim()),
      tipoDoc: 'pdf',
      podePreview: true, // PDF assinado inline (CORS same-portal)
    };
  }
  if (c.idInterno?.trim()) {
    return {
      ...base,
      label: 'Abrir contrato no Portal da Prefeitura',
      url: urlContratoMunicipalDetalhe(c.idInterno.trim()),
      tipoDoc: 'pagina',
      podePreview: false,
    };
  }
  return {
    ...base,
    label: 'Buscar contrato no Portal da Prefeitura',
    url: urlBuscaContratoMunicipal({
      contratada: c.contratada,
      numeroContrato: c.numeroContrato,
      numeroProcesso: c.numeroProcesso,
    }),
    tipoDoc: 'modulo',
    podePreview: false,
  };
}

/**
 * Edital / licitação — deep-link do portal. Com o `{id}` interno gera o detalhe
 * forte `…/portal/editais/0/1/{id}/`; sem ele, a listagem de licitações. (O PDF
 * do edital costuma vir em ZIP, não-inline; por isso só página/listagem aqui.)
 */
export function editalLicitacao(l: {
  idInterno?: string | null;
  numeroProcesso?: string | null;
  numeroEdital?: string | null;
}): Procedencia {
  const base = {
    fonte: 'PORTAL-MARILIA' as const,
    refColecao: 'nexo_licitacoes',
    refId: l.numeroProcesso?.trim() || l.numeroEdital?.trim() || undefined,
  };
  if (l.idInterno?.trim()) {
    return {
      ...base,
      label: 'Abrir edital no Portal da Prefeitura',
      url: urlEditalMunicipalDetalhe(l.idInterno.trim()),
      tipoDoc: 'pagina',
      podePreview: false,
    };
  }
  return {
    ...base,
    label: 'Ver licitações no Portal da Prefeitura',
    url: urlListagemLicitacoes(),
    tipoDoc: 'modulo',
    podePreview: false,
  };
}

/**
 * Dispensa / contratação direta (inexigibilidade/adesão) — o portal não expõe
 * URL canônica por processo; o link é a listagem de compras diretas (mesma `url`
 * que `coleta-licitacoes` grava para a categoria `compra-direta`). O nº de
 * processo vai no ponteiro bruto para localizar o registro.
 */
export function dispensa(d: {
  numeroProcesso?: string | null;
  numeroEdital?: string | null;
}): Procedencia {
  return {
    fonte: 'PORTAL-MARILIA',
    label: 'Ver compras diretas no Portal da Prefeitura',
    url: urlListagemComprasDiretas(),
    tipoDoc: 'modulo',
    podePreview: false,
    refColecao: 'nexo_licitacoes',
    refId: d.numeroProcesso?.trim() || d.numeroEdital?.trim() || undefined,
  };
}

/**
 * Documento genérico do catálogo `nexo_documentos` (por `docId`/chave). Usa a
 * URL-prova que o próprio documento carrega (PDF direto > página da fonte). Sem
 * URL alguma, retorna o ponteiro bruto (url '' → a UI degrada para "ver registro
 * bruto" via refColecao/refId), nunca inventando link. `podePreview` só quando o
 * link é PDF.
 */
export function docCatalogo(d: DocCatalogoLink, label?: string): Procedencia {
  const { url, ehPdf } = urlDocCatalogo(d);
  return {
    fonte: 'PORTAL-MARILIA',
    label: label ?? (ehPdf ? 'Abrir documento (PDF)' : 'Abrir documento na fonte'),
    url: url ?? '',
    tipoDoc: ehPdf ? 'pdf' : url ? 'pagina' : 'modulo',
    podePreview: ehPdf,
    refColecao: 'nexo_documentos',
    refId: d.docId?.trim() || d.chave?.trim() || undefined,
  };
}

/** URL determinística da API SICONFI (JSON verificável). */
export function siconfi(
  exercicio: number,
  s: { tipo: 'RREO' | 'RGF' | 'DCA'; periodo: number; anexo: string; poder?: 'E' | 'L' },
): Procedencia {
  const enc = encodeURIComponent(s.anexo);
  const base = `https://apidatalake.tesouro.gov.br/ords/siconfi/tt/${s.tipo.toLowerCase()}`;
  const q =
    s.tipo === 'RGF'
      ? `an_exercicio=${exercicio}&in_periodicidade=Q&nr_periodo=${s.periodo}&co_tipo_demonstrativo=RGF&co_poder=${s.poder ?? 'E'}&id_ente=${MARILIA.ibge}&no_anexo=${enc}`
      : `an_exercicio=${exercicio}&nr_periodo=${s.periodo}&co_tipo_demonstrativo=${s.tipo}&id_ente=${MARILIA.ibge}&no_anexo=${enc}`;
  return {
    fonte: 'SICONFI',
    label: 'Ver na fonte (SICONFI/STN)',
    url: `${base}?${q}`,
    tipoDoc: 'api-json',
    podePreview: false,
  };
}

/** Mapeia o contexto do alerta ao módulo SMARAPD mais provável. */
function chavePorContexto(sujeitoTipo?: string, categoria?: string): string {
  const cat = (categoria ?? '').toLowerCase();
  if (cat.includes('diária') || cat.includes('diaria')) return 'diaria';
  if (cat.includes('folha') || sujeitoTipo === 'servidor') return 'servidor';
  if (cat.includes('resto')) return 'resto';
  if (cat.includes('modalidade')) return 'modalidade';
  if (sujeitoTipo && MAPA_SMARAPD[sujeitoTipo]) return sujeitoTipo;
  return 'empenho';
}

/**
 * Núcleo da derivação por `ref` — DOM e PNCP pelo padrão do `ref`; caso
 * contrário, link de módulo SMARAPD (a prova primária é o registro bruto
 * apontado por refColecao/refId). Compartilhado pela forma legada de 4 args e
 * pela anexação por-evidência.
 */
function procedenciaDeRef(
  ref: string | null | undefined,
  categoria?: string,
  sujeitoTipo?: string,
  exercicio?: number,
): Procedencia | null {
  const ano = exercicio && exercicio > 2000 ? exercicio : new Date().getFullYear();
  if (ref) {
    const dom = domFromRef(ref);
    if (dom) return dom;
    const pncp = pncpFromRef(ref);
    if (pncp) return pncp;
  }
  return smarapdModulo(chavePorContexto(sujeitoTipo, categoria), ano, ref ?? undefined);
}

// ── Extração de CHAVES das evidências (numeroProcesso/Empenho/cnpj/contrato) ──

/** Nº de processo administrativo/licitatório: `12345/2026`, `12.345/2026`, `123/26`. */
const RE_PROCESSO = /\b(\d{1,6}(?:\.\d{3})*\/\d{2,4})\b/;
/** Nº de empenho: rótulo "empenho" seguido do número (com barra/traço/ano opcionais). */
const RE_EMPENHO = /empenho\s*(?:n[º°o.]?\s*)?([\w./-]+)/i;
/** Nº de contrato: rótulo "contrato" seguido do número. */
const RE_CONTRATO = /contrato\s*(?:n[º°o.]?\s*)?([\w./-]+)/i;
/** CNPJ formatado ou só dígitos (14). */
const RE_CNPJ = /\b(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/;

/** Junta os textos onde uma chave pode aparecer (resumo + ref). */
function textoEvidencia(ev: Evidencia): string {
  return `${ev.resumo ?? ''} ${ev.ref ?? ''}`;
}

/** Chaves extraídas de uma evidência no contexto do alerta. */
interface ChavesAchado {
  numeroProcesso?: string;
  numeroEmpenho?: string;
  numeroContrato?: string;
  cnpj?: string;
}

function extrairChaves(ev: Evidencia, alerta: ChavesDoAlerta): ChavesAchado {
  const txt = textoEvidencia(ev);
  const out: ChavesAchado = {};

  const proc = txt.match(RE_PROCESSO);
  if (proc) out.numeroProcesso = proc[1];

  const emp = txt.match(RE_EMPENHO);
  if (emp) out.numeroEmpenho = emp[1];

  const ctr = txt.match(RE_CONTRATO);
  if (ctr) out.numeroContrato = ctr[1];

  // CNPJ: o do sujeito quando o alerta é sobre fornecedor (mais confiável que o
  // texto); senão, tenta achar no resumo.
  if (alerta.sujeitoTipo === 'fornecedor' && /^\d{14}$/.test(alerta.sujeitoId ?? '')) {
    out.cnpj = alerta.sujeitoId;
  } else {
    const cn = txt.match(RE_CNPJ);
    if (cn) out.cnpj = cn[1].replace(/\D/g, '');
  }

  // Contrato pelo sujeito quando o alerta é sobre contrato.
  if (!out.numeroContrato && alerta.sujeitoTipo === 'contrato' && alerta.sujeitoRotulo) {
    out.numeroContrato = alerta.sujeitoRotulo;
  }
  return out;
}

/** Campos do alerta que orientam a escolha do builder de prova. */
interface ChavesDoAlerta {
  categoria?: string;
  detectorId?: string;
  sujeitoTipo?: string;
  sujeitoId?: string;
  sujeitoRotulo?: string;
  exercicio?: number;
}

/** A categoria/detector indica contratação direta (dispensa/inexigibilidade)? */
function ehContratacaoDireta(a: ChavesDoAlerta): boolean {
  const cat = (a.categoria ?? '').toLowerCase();
  const det = (a.detectorId ?? '').toUpperCase();
  return (
    cat.includes('dispensa') ||
    cat.includes('inexig') ||
    /inexig|dispensa|contrata[çc][ãa]o direta/.test(cat) ||
    det.startsWith('DE-') // área "Dispensas e emergenciais" do catálogo
  );
}

/** A categoria indica licitação/edital/contrato? */
function ehLicitacaoOuContrato(a: ChavesDoAlerta): boolean {
  const cat = (a.categoria ?? '').toLowerCase();
  return (
    cat.includes('licita') ||
    cat.includes('contrato') ||
    cat.includes('edital') ||
    cat.includes('compras')
  );
}

/**
 * Deriva a melhor PROVA para UMA evidência, no contexto do alerta. Ordem:
 *  1. `ref` já fala por si (DOM/PNCP) → usa o builder do ref;
 *  2. chaves de contrato/processo/dispensa → deep-link do portal pela prova;
 *  3. fallback: módulo SMARAPD pelo contexto (prova bruta por refColecao/refId).
 * Sempre retorna algo clicável; só devolve null se nem o módulo casar.
 */
function procedenciaParaEvidencia(
  ev: Evidencia,
  alerta: ChavesDoAlerta,
): Procedencia | null {
  // (1) ref auto-suficiente (DOM `{ano}_{ed}`, PNCP `{cnpj}-{tipo}-{seq}/{ano}`).
  if (ev.ref) {
    const dom = domFromRef(ev.ref);
    if (dom) return dom;
    const pncp = pncpFromRef(ev.ref);
    if (pncp) return pncp;
  }

  const chaves = extrairChaves(ev, alerta);

  // (2) Documento-fonte do portal pela natureza do achado.
  if (alerta.sujeitoTipo === 'contrato' || chaves.numeroContrato) {
    return contratoMunicipal({
      numeroContrato: chaves.numeroContrato ?? alerta.sujeitoRotulo,
      numeroProcesso: chaves.numeroProcesso,
      contratada: alerta.sujeitoTipo === 'fornecedor' ? alerta.sujeitoRotulo : undefined,
    });
  }
  if (ehContratacaoDireta(alerta)) {
    return dispensa({ numeroProcesso: chaves.numeroProcesso });
  }
  if (ehLicitacaoOuContrato(alerta) && chaves.numeroProcesso) {
    return editalLicitacao({ numeroProcesso: chaves.numeroProcesso });
  }

  // (3) Fallback: módulo SMARAPD pelo contexto (a prova é o registro bruto).
  return procedenciaDeRef(
    ev.ref,
    alerta.categoria,
    alerta.sujeitoTipo,
    alerta.exercicio,
  );
}

/**
 * Anexa a `Procedencia` correta a cada `Evidencia` do alerta que ainda NÃO tem
 * uma — preservando as existentes. Para a prova (PDF/página) a partir das chaves
 * do alerta (numeroProcesso, numeroEmpenho, cnpj, contrato) e do `ref`. Retorna
 * uma CÓPIA do alerta com `evidencias` enriquecidas (não muta o original).
 *
 * É aditivo e tolerante: qualquer falha numa evidência mantém a evidência como
 * estava (degrada para o texto/ref atual), nunca derruba o alerta.
 */
export function enriquecerProcedencia<A extends AlertaLike>(alerta: A): A;
/**
 * Forma LEGADA (compat) — deriva UMA procedência a partir de `ref` + contexto.
 * Mantida porque a rota de leitura `route.ts` a consome por-evidência.
 */
export function enriquecerProcedencia(
  ref: string | null | undefined,
  categoria?: string,
  sujeitoTipo?: string,
  exercicio?: number,
): Procedencia | null;
export function enriquecerProcedencia(
  alertaOuRef: AlertaLike | string | null | undefined,
  categoria?: string,
  sujeitoTipo?: string,
  exercicio?: number,
): AlertaLike | Procedencia | null {
  // Despacho: objeto com `evidencias` → forma por-alerta; senão forma legada.
  if (
    alertaOuRef &&
    typeof alertaOuRef === 'object' &&
    Array.isArray((alertaOuRef as AlertaLike).evidencias)
  ) {
    const alerta = alertaOuRef as AlertaLike;
    const ctx: ChavesDoAlerta = {
      categoria: alerta.categoria,
      detectorId: alerta.detectorId,
      sujeitoTipo: alerta.sujeitoTipo,
      sujeitoId: alerta.sujeitoId,
      sujeitoRotulo: alerta.sujeitoRotulo,
      exercicio: alerta.exercicio,
    };
    const evidencias = alerta.evidencias.map((ev) => {
      if (ev.procedencia) return ev; // preserva a existente
      try {
        const procedencia = procedenciaParaEvidencia(ev, ctx);
        return procedencia ? { ...ev, procedencia } : ev;
      } catch {
        return ev; // degrada honestamente
      }
    });
    return { ...alerta, evidencias };
  }

  return procedenciaDeRef(
    alertaOuRef as string | null | undefined,
    categoria,
    sujeitoTipo,
    exercicio,
  );
}

/**
 * Forma mínima de alerta aceita por `enriquecerProcedencia(alerta)`: o
 * `AlertaDetectado` e o `AlertaPersistido` (que tem `exercicio`) ambos casam.
 * Campos de contexto são opcionais para tolerar formatos parciais.
 */
export interface AlertaLike
  extends Partial<Pick<AlertaDetectado, 'categoria' | 'detectorId'>> {
  evidencias: Evidencia[];
  sujeitoTipo?: AlertaDetectado['sujeitoTipo'] | string;
  sujeitoId?: string;
  sujeitoRotulo?: string;
  /** Presente no alerta persistido; ausente no `AlertaDetectado` recém-detectado. */
  exercicio?: number;
}
