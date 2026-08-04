/**
 * Cloud Function HTTP: `onIaConfigUso`.
 *
 * Ponte de CONFIG + USO da camada de IA do app, dado que o app no App Hosting
 * NÃO tem `firebase-admin` (não lê/escreve Firestore com privilégio). Esta
 * function TEM admin, então:
 *
 *   GET  ?action=config  → lê o doc `config/ia` (Admin SDK) e devolve
 *                          `{ config }`. Sem segredo: o doc NÃO contém chaves —
 *                          só rótulos de provedor, modelos e flags. O painel
 *                          /admin/ia ESCREVE esse doc via client SDK (rule
 *                          isAdmin); o multi-provider só LÊ por aqui.
 *
 *   POST ?action=uso     → recebe 1 evento de uso e INCREMENTA contadores
 *                          agregados em `ia_uso/{AAAA-MM-DD}` (FieldValue
 *                          .increment). Fire-and-forget do app; resposta 204.
 *
 * CORS liberado (GET/POST) — o multi-provider chama de outro origin (o app), e
 * o evento de uso não carrega segredo nenhum (só métricas).
 *
 * Isolado em `functions/src/ia/*` — não toca em nenhuma área de outro processo.
 */

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

import { admin, db } from "../shared/admin";

interface EventoUsoIa {
  provedor?: unknown;
  modelo?: unknown;
  tokensEntrada?: unknown;
  tokensSaida?: unknown;
  latenciaMs?: unknown;
  sucesso?: unknown;
  foi429?: unknown;
  erro?: unknown;
  /** Capacidade exercida (aditivo): texto/json/audio/imagem/visao/tools/streaming. */
  capacidade?: unknown;
  /** Classe do erro (aditivo, quando !sucesso): timeout/429/5xx/4xx/auth/... */
  classeErro?: unknown;
  /** Status HTTP da falha (aditivo). */
  httpStatus?: unknown;
}

/** Capacidades aceitas como sub-chave (aditivo). Desconhecida → 'outro'. */
const CAPACIDADES = new Set([
  "texto",
  "json",
  "audio",
  "imagem",
  "visao",
  "tools",
  "streaming",
]);

/** Classes de erro aceitas como sub-chave (aditivo). Desconhecida → 'outro'. */
const CLASSES_ERRO = new Set([
  "timeout",
  "429",
  "5xx",
  "4xx",
  "auth",
  "json_invalido",
  "vazio",
  "rede",
  "outro",
]);

/** Coage para um token seguro de sub-chave de map, dentro de um conjunto. */
function tokenDe(v: unknown, permitidos: Set<string>, fallback: string): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return permitidos.has(s) ? s : fallback;
}

/** AAAA-MM-DD no fuso de São Paulo (o dia "de negócio" do dono). */
function diaSaoPaulo(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // en-CA → "AAAA-MM-DD"
}

/** Coage a inteiro >= 0 (default 0). */
function inteiro(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Sanitiza o rótulo do provedor/modelo (chave de map no Firestore).
 *
 * IMPORTANTE (bug-fix custo Gemini $0): a normalização DEVE casar com
 * `chaveModeloUso` do app (`src/ai/ia-config.ts`) — minúsculas + troca de
 * caracteres proibidos em nome de campo de map ('.', '/', '~', '*', '[', ']')
 * por '_'. Sem o `toLowerCase`, o painel (que reindexa a tabela de preço por
 * minúsculas) não casaria a chave do modelo e o custo voltaria a aparecer $0.
 * Os ids de modelo já são minúsculos hoje, então o lowercase é no-op para os
 * dados existentes (não migra/quebra agregados antigos).
 */
function rotulo(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!s) return fallback;
  // Firestore não aceita '.', '/', '~', '*', '[', ']' em nomes de campo de map;
  // troca por '_' para usar como chave aninhada com segurança.
  return s.replace(/[.\/~*[\]]/g, "_").slice(0, 80);
}

export const onIaConfigUso = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,
    maxInstances: 5,
    cors: true,
    invoker: "public",
  },
  async (req, res) => {
    const action = String(req.query.action ?? "");

    // ── GET config ────────────────────────────────────────────────────────────
    if (req.method === "GET" && action === "config") {
      try {
        const snap = await db.doc("config/ia").get();
        const config = snap.exists ? snap.data() : {};
        res
          .status(200)
          .set("Cache-Control", "no-store")
          .json({ config });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`onIaConfigUso GET config falhou: ${msg}`);
        // Devolve config vazia (→ o app usa o default) em vez de 500, pra não
        // derrubar a geração de IA por uma leitura de config.
        res.status(200).set("Cache-Control", "no-store").json({ config: {} });
      }
      return;
    }

    // ── POST uso ────────────────────────────────────────────────────────────────
    if (req.method === "POST" && action === "uso") {
      try {
        const ev = (req.body ?? {}) as EventoUsoIa;
        const provedor = rotulo(ev.provedor, "desconhecido");
        const modelo = rotulo(ev.modelo, "desconhecido");
        const tokensEntrada = inteiro(ev.tokensEntrada);
        const tokensSaida = inteiro(ev.tokensSaida);
        const latenciaMs = inteiro(ev.latenciaMs);
        const sucesso = ev.sucesso === true;
        const foi429 = ev.foi429 === true;
        const erro =
          typeof ev.erro === "string" ? ev.erro.slice(0, 300) : null;
        const capacidade = tokenDe(ev.capacidade, CAPACIDADES, "texto");
        const classeErro = sucesso
          ? null
          : tokenDe(ev.classeErro, CLASSES_ERRO, "outro");

        const inc = admin.firestore.FieldValue.increment;
        // Estrutura: ia_uso/{dia}.provedores.{provedor}.{modelo}.{metricas}
        // (shape histórico PRESERVADO; campos novos abaixo são ADITIVOS).
        const baseKey = `provedores.${provedor}.${modelo}`;
        const update: Record<string, unknown> = {
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
          [`${baseKey}.chamadas`]: inc(1),
          [`${baseKey}.tokensEntrada`]: inc(tokensEntrada),
          [`${baseKey}.tokensSaida`]: inc(tokensSaida),
          // latenciaMsTotal MANTIDO (compat) — soma sucesso + falha.
          [`${baseKey}.latenciaMsTotal`]: inc(latenciaMs),
          // ADITIVO: latência SEPARADA p/ a média de sucesso não ser poluída
          // por timeouts/429 (bug 2). O painel deve dividir
          // latenciaMsTotalSucesso por sucessos.
          [`${baseKey}.latenciaMsTotalSucesso`]: inc(sucesso ? latenciaMs : 0),
          [`${baseKey}.latenciaMsTotalFalha`]: inc(sucesso ? 0 : latenciaMs),
          [`${baseKey}.sucessos`]: inc(sucesso ? 1 : 0),
          [`${baseKey}.erros`]: inc(sucesso ? 0 : 1),
          [`${baseKey}.r429`]: inc(foi429 ? 1 : 0),
          // ADITIVO: contagem por capacidade exercida.
          [`${baseKey}.porCapacidade.${capacidade}`]: inc(1),
        };
        // ADITIVO: contagem de erros por CLASSE (timeout/429/5xx/4xx/...).
        if (!sucesso && classeErro) {
          update[`${baseKey}.porClasseErro.${classeErro}`] = inc(1);
        }
        if (!sucesso && erro) {
          update[`${baseKey}.ultimoErro`] = erro;
          update[`${baseKey}.ultimoErroEm`] =
            admin.firestore.FieldValue.serverTimestamp();
        }

        await db.doc(`ia_uso/${diaSaoPaulo()}`).set(update, { merge: true });
        res.status(204).end();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`onIaConfigUso POST uso falhou: ${msg}`);
        // 204 mesmo em erro: o registro de uso é best-effort, nunca um problema
        // para o chamador (que é fire-and-forget).
        res.status(204).end();
      }
      return;
    }

    res
      .status(400)
      .json({ erro: "use GET ?action=config ou POST ?action=uso" });
  },
);
