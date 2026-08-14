/**
 * Cloud Function: `onCompressionStaleCleanup`.
 *
 * Roda a cada 30 minutos e marca como `error` qualquer
 * `compressionJobs/{id}` que esteja `compressing` mas sem heartbeat
 * recente (>10 min). Necessário porque quando o worker morre por OOM
 * ou timeout, ele não consegue atualizar o Firestore — sem isso, o
 * job ficaria "Comprimindo… 0%" pra sempre na UI.
 *
 * CUSTO: era `every 2 minutes` (720 invocações/dia constantes). Vídeo é
 * pouco usado; 30min corta isso para ~48/dia. O worker heartbeata a cada
 * 15s, então job vivo nunca é marcado stale — só afeta a latência de
 * detecção de job MORTO (até 30min na UI antes de virar erro).
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { admin, db } from "../shared/admin";

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutos sem heartbeat = morto

export const onCompressionStaleCleanup = onSchedule(
  {
    schedule: "every 30 minutes",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async () => {
    const cutoff = admin.firestore.Timestamp.fromMillis(
      Date.now() - STALE_THRESHOLD_MS,
    );
    const snap = await db
      .collection("compressionJobs")
      .where("status", "==", "compressing")
      .get();

    if (snap.empty) {
      return;
    }

    const stale: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    for (const doc of snap.docs) {
      const hb = doc.get("lastHeartbeat") as
        | FirebaseFirestore.Timestamp
        | undefined;
      // Se nunca enviou heartbeat e foi criado há mais de 2 min, considera morto.
      const started = (doc.get("startedAt") as FirebaseFirestore.Timestamp | undefined)
        ?? (doc.get("createdAt") as FirebaseFirestore.Timestamp | undefined);
      const reference = hb ?? started;
      if (!reference) continue;
      if (reference.toMillis() < cutoff.toMillis()) {
        stale.push(doc);
      }
    }

    if (stale.length === 0) {
      return;
    }

    logger.warn(`Detectados ${stale.length} jobs de compressão travados`, {
      ids: stale.map((d) => d.id),
    });

    const batch = db.batch();
    for (const doc of stale) {
      batch.update(doc.ref, {
        status: "error",
        error:
          "Compressão parou sem aviso (provável OOM/timeout no servidor). Tente novamente — vídeos muito grandes podem requerer qualidade 'low'.",
        progress: null,
        cleanedUpAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    logger.info(`${stale.length} jobs marcados como error.`);
  },
);
