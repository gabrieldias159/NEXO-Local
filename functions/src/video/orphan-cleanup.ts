/**
 * Cloud Function HTTP: `onCleanupOrphanVideos`.
 *
 * VARREDURA de vídeos ÓRFÃOS no Storage — sobras de exclusões ANTIGAS, de quando
 * deletar uma pasta de recortes / projeto da suite só apagava o doc no Firestore
 * e deixava os binários no Storage (corrigido em `deleteRecorteFolder`/
 * `deleteProject`, mas o que já vazou continua lá).
 *
 * ESCOPO SEGURO — só "nível A" (dono ausente):
 *   - `recortes/{folderId}/...`      órfão se NÃO existe `recortes/{folderId}`.
 *   - `videoProjects/{projectId}/...` órfão se NÃO existe `videoProjects/{projectId}`.
 * São órfãos INEQUÍVOCOS: o doc-pai sumiu, nada no Firestore os referencia. NÃO
 * mexemos em arquivos de pastas/projetos que AINDA existem (lá pode haver
 * thumbnail/preview/asset em uso — fora do escopo desta limpeza).
 *
 * DRY-RUN por padrão (só relatório). Só apaga com `?apply=true`. Protegido por
 * header `x-backfill-secret` (Secret Manager `DIARIO_BACKFILL_SECRET`, o mesmo
 * dos outros one-shots administrativos).
 *
 *   GET /onCleanupOrphanVideos                 → relatório (dry-run)
 *   GET /onCleanupOrphanVideos?apply=true       → apaga os órfãos e relata
 *     Headers: x-backfill-secret: <SEGREDO>
 */

import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";

import { db, bucket } from "../shared/admin";

const DIARIO_BACKFILL_SECRET = defineSecret("DIARIO_BACKFILL_SECRET");

interface ArquivoInfo {
  name: string;
  size: number;
}

interface GrupoOrfao {
  tipo: "recorte" | "projeto";
  id: string;
  nArquivos: number;
  bytes: number;
  /** Amostra dos caminhos (até 5) p/ conferência humana sem despejar tudo. */
  amostra: string[];
}

/** Lista TODOS os objetos sob um prefixo (auto-paginado). Tamanho vem do list. */
async function listarArquivos(prefix: string): Promise<ArquivoInfo[]> {
  const [files] = await bucket.getFiles({ prefix });
  return files.map((f) => ({
    name: f.name,
    size: Number((f.metadata as { size?: string | number } | undefined)?.size ?? 0),
  }));
}

/**
 * Agrupa os arquivos de um prefixo top-level (`recortes/` ou `videoProjects/`)
 * pelo id do dono (2º segmento do path) e devolve só os grupos cujo doc-pai NÃO
 * existe mais no Firestore (`colecao/{id}`).
 */
async function acharOrfaos(
  prefixTop: string,
  colecao: string,
  tipo: "recorte" | "projeto",
): Promise<GrupoOrfao[]> {
  const files = await listarArquivos(prefixTop);
  const porId = new Map<string, ArquivoInfo[]>();
  for (const f of files) {
    const segs = f.name.split("/");
    // Espera `${colecao}/{id}/...`; ignora caminhos rasos/inesperados.
    if (segs.length < 3 || !segs[1]) continue;
    const id = segs[1];
    const lista = porId.get(id);
    if (lista) lista.push(f);
    else porId.set(id, [f]);
  }

  const ids = [...porId.keys()];
  const orfaos: GrupoOrfao[] = [];
  // Checa existência do doc-pai em paralelo (lotes de 50 leituras).
  for (let i = 0; i < ids.length; i += 50) {
    const lote = ids.slice(i, i + 50);
    const snaps = await Promise.all(
      lote.map((id) => db.collection(colecao).doc(id).get()),
    );
    snaps.forEach((snap, j) => {
      if (snap.exists) return;
      const arquivos = porId.get(lote[j]) ?? [];
      orfaos.push({
        tipo,
        id: lote[j],
        nArquivos: arquivos.length,
        bytes: arquivos.reduce((s, a) => s + a.size, 0),
        amostra: arquivos.slice(0, 5).map((a) => a.name),
      });
    });
  }
  return orfaos;
}

/** Apaga uma lista de objetos do Storage em lotes (best-effort por objeto). */
async function apagarArquivos(prefixTop: string, ids: string[]): Promise<number> {
  // Re-lista por prefixo de cada id e apaga (evita confiar em nomes em memória
  // se a lista for grande). Apaga em lotes de 50 deletes concorrentes.
  let apagados = 0;
  for (const id of ids) {
    const [files] = await bucket.getFiles({ prefix: `${prefixTop}${id}/` });
    for (let i = 0; i < files.length; i += 50) {
      const lote = files.slice(i, i + 50);
      const res = await Promise.allSettled(lote.map((f) => f.delete()));
      apagados += res.filter((r) => r.status === "fulfilled").length;
    }
  }
  return apagados;
}

export const onCleanupOrphanVideos = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
    maxInstances: 1,
    secrets: [DIARIO_BACKFILL_SECRET],
    invoker: "public",
  },
  async (req, res) => {
    const provided = String(req.headers["x-backfill-secret"] ?? "");
    const expected = DIARIO_BACKFILL_SECRET.value();
    if (!expected || provided !== expected) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const apply = String(req.query.apply ?? "") === "true";

    try {
      const [recortesOrfaos, projetosOrfaos] = await Promise.all([
        acharOrfaos("recortes/", "recortes", "recorte"),
        acharOrfaos("videoProjects/", "videoProjects", "projeto"),
      ]);
      const grupos = [...recortesOrfaos, ...projetosOrfaos];

      const totais = {
        nGrupos: grupos.length,
        nArquivos: grupos.reduce((s, g) => s + g.nArquivos, 0),
        bytes: grupos.reduce((s, g) => s + g.bytes, 0),
      };
      const totalMB = Math.round((totais.bytes / 1048576) * 10) / 10;

      let apagados = 0;
      if (apply && grupos.length > 0) {
        const recDel = await apagarArquivos(
          "recortes/",
          recortesOrfaos.map((g) => g.id),
        );
        const projDel = await apagarArquivos(
          "videoProjects/",
          projetosOrfaos.map((g) => g.id),
        );
        apagados = recDel + projDel;
        logger.info("Limpeza de órfãos aplicada.", { apagados, totais });
      } else {
        logger.info("Varredura de órfãos (dry-run).", { totais });
      }

      res.status(200).json({
        ok: true,
        dryRun: !apply,
        aplicado: apply,
        totais: { ...totais, totalMB },
        arquivosApagados: apply ? apagados : 0,
        grupos: grupos
          .sort((a, b) => b.bytes - a.bytes)
          .map((g) => ({
            tipo: g.tipo,
            id: g.id,
            nArquivos: g.nArquivos,
            mb: Math.round((g.bytes / 1048576) * 10) / 10,
            amostra: g.amostra,
          })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Falha na varredura de órfãos.", { err: msg });
      res.status(500).json({ error: msg });
    }
  },
);
