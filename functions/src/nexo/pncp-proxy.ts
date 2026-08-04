/**
 * Proxy regional BR — `onPncpProxy` (HTTP, southamerica-east1).
 *
 * POR QUE EXISTE: fontes públicas BR (PNCP, TCE-SP Apenados) geo-bloqueiam IPs
 * fora do Brasil (HTTP 403) e o app/cron rodam em us-central1 (EUA) — toda
 * chamada direta de prod falhava (403/timeout). Esta function roda em SÃO
 * PAULO: o egress é IP brasileiro e a fonte responde.
 *
 * MULTI-HOST por ALLOWLIST (sem SSRF — host NUNCA vem livre do request):
 *   - `host=pncp` (DEFAULT, retrocompatível): `https://pncp.gov.br/api/consulta`,
 *     paths `^/v1/...`. Usado por `src/lib/nexo/sources/pncp.ts` quando
 *     `PNCP_PROXY_URL` está configurada no apphosting.yaml.
 *   - `host=tce-sp-apenados`: `https://www4.tce.sp.gov.br/apenados/webapi/P`,
 *     paths `^/impedimento`. Usado pelo cron `onNexoSyncSancoesEstaduais`
 *     (`functions/src/nexo/coleta-sancoes-estaduais.ts`) — o TCE-SP devolve 200
 *     deste ambiente (BR) mas 403 do us-central1; é geo/IP-block, NÃO fonte
 *     morta. O cliente NÃO escolhe URL: só envia o RÓTULO do host, e o proxy
 *     resolve para uma base FIXA da allowlist + valida o path por host.
 *
 * SEGURANÇA (não é proxy aberto):
 *   - exige `x-nexo-secret` (mesmo segredo compartilhado das rotas de cômputo);
 *   - só GET;
 *   - host restrito à allowlist abaixo (base FIXA por rótulo) — sem SSRF;
 *   - path validado por host (regex de prefixo) — sem path traversal de host.
 *
 * Contrato: GET ?path=/v1/contratos&host=pncp&cnpjOrgao=...&pagina=1 → repassa
 * ao `{base do host}{path}` com os demais query params (exceto `path`/`host`) e
 * devolve o status + corpo JSON da fonte (204 vira 204 sem corpo).
 */
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";

const BACKFILL_SECRET = defineSecret("DIARIO_BACKFILL_SECRET");

const TIMEOUT_MS = 25_000;

/**
 * ALLOWLIST de hosts repassáveis. O cliente envia só o RÓTULO (`host=...`); a
 * BASE e a regex de path são FIXAS aqui — assim nenhum request consegue apontar
 * o proxy para um destino arbitrário (anti-SSRF). `host` ausente → `pncp`
 * (retrocompatível com `pncp.ts`, que não envia `host`).
 *
 * `referer`: alguns WAFs (o do TCE-SP em especial) exigem o Referer do app
 * público; o PNCP não precisa, então fica vazio.
 */
const HOSTS: Record<
  string,
  { base: string; pathOk: RegExp; referer?: string }
> = {
  pncp: {
    base: "https://pncp.gov.br/api/consulta",
    pathOk: /^\/v1\/[\w/-]*$/,
  },
  "tce-sp-apenados": {
    base: "https://www4.tce.sp.gov.br/apenados/webapi/P",
    pathOk: /^\/impedimento$/,
    referer: "https://www4.tce.sp.gov.br/apenados/publico/",
  },
};

/** Mesmo UA de browser do client — as fontes recusam clients sem UA reconhecível. */
const HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
};

export const onPncpProxy = onRequest(
  {
    region: "southamerica-east1",
    memory: "256MiB",
    timeoutSeconds: 60,
    // Página + detectores em paralelo cabem em poucas instâncias; teto baixo
    // contém custo e abuso.
    maxInstances: 5,
    secrets: [BACKFILL_SECRET],
  },
  async (req, res) => {
    const segredo = (BACKFILL_SECRET.value() ?? "").trim();
    if (!segredo) {
      res.status(503).json({ erro: "proxy sem segredo configurado" });
      return;
    }
    if ((req.get("x-nexo-secret") ?? "") !== segredo) {
      res.status(401).json({ erro: "acesso negado" });
      return;
    }
    if (req.method !== "GET") {
      res.status(405).json({ erro: "método não suportado" });
      return;
    }

    // Resolve o host pela allowlist — base e regex de path FIXAS por rótulo.
    const rotuloHost = String(req.query.host ?? "pncp");
    const alvo = HOSTS[rotuloHost];
    if (!alvo) {
      res
        .status(400)
        .json({ erro: `host inválido (aceitos: ${Object.keys(HOSTS).join(", ")})` });
      return;
    }

    const path = String(req.query.path ?? "");
    if (!alvo.pathOk.test(path)) {
      res
        .status(400)
        .json({ erro: `path inválido para host '${rotuloHost}'` });
      return;
    }

    const url = new URL(`${alvo.base}${path}`);
    for (const [k, v] of Object.entries(req.query)) {
      if (k === "path" || k === "host" || typeof v !== "string") continue;
      url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = { ...HEADERS };
    if (alvo.referer) headers.Referer = alvo.referer;

    try {
      const upstream = await fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (upstream.status === 204) {
        res.status(204).end();
        return;
      }
      const corpo = await upstream.text();
      res
        .status(upstream.status)
        .set("Content-Type", "application/json; charset=utf-8")
        .send(corpo);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`proxy BR — falha upstream ${rotuloHost}${path}: ${msg}`);
      res
        .status(502)
        .json({ erro: `fonte '${rotuloHost}' indisponível via proxy: ${msg}` });
    }
  },
);
