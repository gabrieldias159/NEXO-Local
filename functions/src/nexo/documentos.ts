/**
 * Catálogo de documentos públicos — `nexo_documentos` (WF-2 da mega-implementação).
 *
 * Tema-mãe: TUDO LINKADO. Cada número, alerta e achado precisa apontar para o
 * documento-fonte (empenho ↔ contrato ↔ edital ↔ licitação ↔ dispensa ↔ DOM ↔
 * PDF/processo). Este módulo é a base do **"documentos como acessórios de
 * consulta"**: TODO documento público que os coletores acharem (edital,
 * contrato, termo aditivo, processo de dispensa, nota de empenho/liquidação/
 * pagamento, edição do DOM, ato/decreto/lei, ata, parecer, planilha) é
 * registrado aqui com suas **chaves de linkage**, para que o motor de linkage
 * (`nexo_links`) e os painéis de prova consigam costurar o achado ao papel.
 *
 * Contrato `{tipo, orgao, data, numeroProcesso, url, pdfUrl, hash,
 * chavesLinkage[], fonte}` (ver `docs/nexo-mapa-prefeitura.md`).
 *
 * Idempotência: o `docId` é determinístico (sha1 das chaves de identidade do
 * documento), então o `set(..., { merge: true })` faz UPSERT — reexecutar um
 * coletor SOBRESCREVE o catálogo, nunca duplica.
 *
 * Self-contained: o projeto `functions/` não importa de `src/`; só usa
 * `db`/`admin` de `../shared/admin` e `createHash` de `node:crypto`.
 */
import { createHash } from "node:crypto";

import { admin, db } from "../shared/admin";

/** Coleção-catálogo: 1 doc por peça pública encontrada. */
const COLECAO = "nexo_documentos";

/** Tipos canônicos de documento público (catálogo `nexo_documentos`). */
export type TipoDocumento =
  | "edital"
  | "contrato"
  | "termo_aditivo"
  | "dispensa"
  | "inexigibilidade"
  | "empenho"
  | "liquidacao"
  | "pagamento"
  | "dom"
  // Edição inteira do Diário Oficial do Município, catalogada pelo coletor
  // `coleta-dom` (cron Querido Diário). Distinta de `"dom"` (uma ocorrência/
  // extrato dentro de uma edição); `"dom-edicao"` é o PDF da edição completa.
  | "dom-edicao"
  | "ato"
  | "lei"
  | "decreto"
  | "ata"
  | "parecer"
  | "planilha"
  | "outro";

/**
 * Uma chave de linkage — como este documento se conecta ao grafo. O `tipo`
 * nomeia a dimensão (nº empenho, nº processo, CNPJ, numeroControlePNCP…) e o
 * `valor` é o identificador normalizado (só dígitos para CNPJ/empenho).
 */
export interface ChaveLinkage {
  /** Dimensão de junção: `empenho` | `processo` | `contrato` | `licitacao` | `cnpj` | `pncp` | `dom` … */
  tipo: string;
  /** Valor normalizado da chave (ex.: CNPJ só dígitos, nº de processo limpo). */
  valor: string;
}

/**
 * Documento público catalogado. É o "acessório de consulta": o registro
 * mínimo que permite achar o papel-fonte e linká-lo ao que a IA/dados acharam.
 */
export interface DocumentoPublico {
  /** Tipo canônico da peça. */
  tipo: TipoDocumento;
  /** Órgão/unidade emissor (ex.: "Prefeitura Municipal de Marília"). */
  orgao: string;
  /** Data do documento em `YYYY-MM-DD` (ou null quando a fonte não expõe). */
  data: string | null;
  /** Nº do processo administrativo/licitatório, quando houver. */
  numeroProcesso: string | null;
  /** URL da página/registro do documento na fonte. */
  url: string | null;
  /** URL direta do PDF/arquivo, quando a fonte expõe. */
  pdfUrl: string | null;
  /** Hash do conteúdo (quando baixado) — detecta alteração entre coletas. */
  hash: string | null;
  /** Chaves de linkage — como o documento se conecta ao grafo (TUDO LINKADO). */
  chavesLinkage: ChaveLinkage[];
  /** Fonte de origem (`pncp` | `tce_sp` | `dom` | `smarapd` | `dados_abertos` …). */
  fonte: string;
  /** Título/descrição curta, quando disponível (opcional, informativo). */
  titulo?: string | null;
}

/** Normaliza um texto para compor a identidade do doc (trim + lowercase). */
function norm(v: unknown): string {
  return v == null ? "" : String(v).trim().toLowerCase();
}

/** Normaliza uma chave de linkage para a identidade (tipo:valor, ordenável). */
function chaveCanonica(c: ChaveLinkage): string {
  return `${norm(c.tipo)}:${norm(c.valor)}`;
}

/**
 * `docId` determinístico — sha1 das dimensões de identidade do documento. A
 * mesma peça pública sempre produz o mesmo ID, então a gravação é um UPSERT
 * idempotente (chamar duas vezes = um doc só).
 *
 * Identidade = fonte + tipo + numeroProcesso + url + pdfUrl + chaves de linkage
 * (ordenadas). Quando há `hash` de conteúdo, ele NÃO entra no ID (o ID precisa
 * ser estável quando o mesmo papel é re-baixado; o `hash` vai no payload e
 * sinaliza mudança de conteúdo sem trocar o doc).
 */
export function docId(doc: DocumentoPublico): string {
  const chaves = doc.chavesLinkage
    .map(chaveCanonica)
    .filter((k) => k !== ":")
    .sort();
  const identidade = [
    norm(doc.fonte),
    norm(doc.tipo),
    norm(doc.numeroProcesso),
    norm(doc.url),
    norm(doc.pdfUrl),
    chaves.join("|"),
  ].join("§");
  return createHash("sha1").update(identidade).digest("hex");
}

/** Monta o payload persistido a partir do contrato + carimbos `_`-prefixados. */
function montarPayload(
  doc: DocumentoPublico,
  now: admin.firestore.FieldValue,
): Record<string, unknown> {
  // Chaves saneadas e desduplicadas — alimentam o motor de linkage e índices.
  const chavesVistas = new Set<string>();
  const chavesLinkage: ChaveLinkage[] = [];
  for (const c of doc.chavesLinkage) {
    const tipo = String(c.tipo ?? "").trim();
    const valor = String(c.valor ?? "").trim();
    if (!tipo || !valor) continue;
    const canon = chaveCanonica({ tipo, valor });
    if (chavesVistas.has(canon)) continue;
    chavesVistas.add(canon);
    chavesLinkage.push({ tipo, valor });
  }

  return {
    tipo: doc.tipo,
    orgao: doc.orgao ?? "",
    data: doc.data ?? null,
    numeroProcesso: doc.numeroProcesso ?? null,
    url: doc.url ?? null,
    pdfUrl: doc.pdfUrl ?? null,
    hash: doc.hash ?? null,
    chavesLinkage,
    // Índice array-contains-friendly das chaves canônicas (tipo:valor).
    chavesIndex: [...chavesVistas],
    fonte: doc.fonte,
    titulo: doc.titulo ?? null,
    _fonte: doc.fonte,
    _tipo: doc.tipo,
    _coletadoEm: now,
  };
}

/**
 * Registra (UPSERT idempotente) um documento público no catálogo
 * `nexo_documentos`. Retorna o `docId` determinístico gravado, para que o
 * coletor possa anexá-lo às chaves de linkage do achado correspondente.
 */
export async function registrarDocumento(
  doc: DocumentoPublico,
): Promise<string> {
  const id = docId(doc);
  const now = admin.firestore.FieldValue.serverTimestamp();
  await db
    .collection(COLECAO)
    .doc(id)
    .set(montarPayload(doc, now), { merge: true });
  return id;
}

/**
 * Registra um LOTE de documentos em batches do Firestore (até 400 por commit,
 * folga sobre o teto de 500 do Firestore). Cada doc usa o mesmo `docId`
 * determinístico do `registrarDocumento`, então o lote é igualmente idempotente
 * e desduplica entradas com a mesma identidade dentro do próprio lote.
 *
 * Retorna o número de documentos DISTINTOS gravados (após desduplicação por ID).
 */
export async function registrarDocumentosLote(
  docs: DocumentoPublico[],
): Promise<number> {
  if (docs.length === 0) return 0;

  const now = admin.firestore.FieldValue.serverTimestamp();
  let batch = db.batch();
  const vistos = new Set<string>();
  let n = 0;

  for (const doc of docs) {
    const id = docId(doc);
    // Mesma identidade duas vezes no lote = uma escrita só (idempotência local).
    if (vistos.has(id)) continue;
    vistos.add(id);

    batch.set(
      db.collection(COLECAO).doc(id),
      montarPayload(doc, now),
      { merge: true },
    );
    n++;
    if (n % 400 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 400 !== 0) await batch.commit();
  return n;
}
