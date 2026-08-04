// NEXO Local Scheduler — replica local do Cloud Scheduler.
//
// Produção:  Cloud Scheduler (cron) ─▶ Pub/Sub (firebase-schedule-<fn>) ─▶ Cloud Function
// Local:     este daemon (cron)      ─▶ Functions Emulator (hub /triggers) ─▶ mesma function
//
// O Functions Emulator SÓ registra triggers agendados (onSchedule) quando o
// Pub/Sub Emulator está rodando. Este daemon descobre automaticamente TODAS as
// functions onSchedule do código em `functions/src` (fonte única de verdade),
// programa os mesmos cron/time zone de produção e dispara via rota de trigger do
// Functions Emulator (POST /functions/projects/<proj>/triggers/<region>-<fn>-<gen>).
//
// Por que não o tópico Pub/Sub? No firebase-tools 13.35.1 o Pub/Sub Emulator
// rejeita o despacho de functions onSchedule (assinatura "http") com
// "Unsupported trigger signature: http" — o tópico aceita o publish mas a
// function NUNCA é invocada. A rota de trigger do hub invoca de fato a function.
// A chave (região + geração) é descoberta via probe: um POST a um trigger
// inexistente responde 404 com a lista de todas as chaves válidas.

import { Cron } from "croner";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const FUNCTIONS_SRC = path.join(ROOT, "functions", "src");
const LOG_DIR = path.join(ROOT, "logs");

const PUBSUB_HOST = process.env.PUBSUB_EMULATOR_HOST || "127.0.0.1:8085";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const PROJECT_ID = process.env.GCLOUD_PROJECT || "studio-8612233125-caa0a";
const HUB_BASE = `http://${FUNCTIONS_HOST}/functions/projects/${PROJECT_ID}/triggers`;
const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const TICK_MS = Number(process.env.NEXO_CRON_TICK_MS || 60_000);
const ONLY_FN = process.env.NEXO_CRON_ONLY; // filter: comma-separated names

// Cloud Scheduler aceita a forma literal "every <n> minutes|hours" (usada em
// algumas functions). croner só entende cron 5-campos — traduz.
function toCronExpr(raw) {
  const every = raw.match(/^every (\d+) (minutes|hours)$/i);
  if (every) {
    const n = Number(every[1]);
    return every[2] === "hours" ? `0 */${n} * * *` : `*/${n} * * * *`;
  }
  return raw;
}

function log(...args) {
  const ts = new Date().toISOString();
  const line = `${ts} ${args.join(" ")}`;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, "nexo-cron.log"), line + "\n");
  console.log(line);
}

// Descobre functions agendadas lendo o código-fonte (fonte única de verdade).
// Formato detectado:
//   export const onNexoFoo = onSchedule(
//     { schedule: "15 7 * * *", timeZone: "America/Sao_Paulo", ... },
//     async (event) => {...}
//   );
function discoverJobs() {
  const jobs = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts")) {
        const src = fs.readFileSync(p, "utf8");
        const blocks = src.split("export const ").slice(1);
        for (const block of blocks) {
          const fnMatch = block.match(/^(\w+)\s*=\s*onSchedule\(/);
          if (!fnMatch) continue;
          const fn = fnMatch[1];
          const schedule = block.match(/schedule:\s*["']([^"']+)["']/);
          if (!schedule) {
            log(`AVISO ${fn}: onSchedule sem schedule explícito, pulado`);
            continue;
          }
          const timeZone =
            block.match(/timeZone:\s*["']([^"']+)["']/)?.[1] ||
            DEFAULT_TIMEZONE;
          jobs.push({
            fn,
            schedule: toCronExpr(schedule[1]),
            timeZone,
            source: schedule[1],
          });
        }
      }
    }
  };
  walk(FUNCTIONS_SRC);
  return jobs;
}

// Lista as chaves de trigger válidas do Functions Emulator via probe: um POST
// a um trigger inexistente responde 404 com todas as chaves registradas, já com
// região e geração (ex.: "us-central1-onNexoLinkage-0"). Resiliente a reloads:
// se o emulador recarregar (geração sobe), a próxima chamada refaz o probe.
async function getTriggerKeys() {
  const res = await fetch(`${HUB_BASE}/__probe__`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: {} }),
  });
  const text = await res.text();
  const marker = "valid functions are: ";
  const idx = text.indexOf(marker);
  if (res.status !== 404 || idx < 0) return { ok: false, text };
  const keys = text
    .slice(idx + marker.length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { ok: true, keys };
}

// Fallback documental: publish no tópico firebase-schedule-<fn> do Pub/Sub
// Emulator. Não chega a invocar a function no firebase-tools 13.35.1
// (Unsupported trigger signature: http), mas fica registrado no log caso um
// firebase-tools futuro volte a despachar por esse caminho.
async function publishToTopic(fn) {
  const topic = `firebase-schedule-${fn}`;
  const url = `http://${PUBSUB_HOST}/v1/projects/${PROJECT_ID}/topics/${topic}:publish`;
  const body = { messages: [{ data: btoa(JSON.stringify({ job: fn, emittedBy: "nexo-local-scheduler" })) }] };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    log(`  (fallback) tópico ${topic}: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ""} — no firebase-tools 13.x NÃO dispara a function`);
    return res.ok;
  } catch (e) {
    log(`  (fallback) ERRO ${fn}: ${e.message}`);
    return false;
  }
}

// Dispara a function invocando a rota de trigger do hub (funciona de verdade).
// Payload: {"data":{}} — mesmo CloudEvent que o Pub/Sub Emulator entregaria.
async function runJob(job) {
  const fn = job.fn;
  let probe;
  try {
    probe = await getTriggerKeys();
  } catch (e) {
    log(`ERRO ${fn}: hub não respondeu (${e.message}). Functions Emulator rodando em ${FUNCTIONS_HOST}?`);
    return false;
  }
  if (!probe.ok) {
    log(`ERRO ${fn}: probe do hub falhou (HTTP fora de 404): ${probe.text.slice(0, 200)}`);
    return false;
  }
  // Chave: <region>-<fn>-<gen>. Como <fn> não contém hífen, ela é o penúltimo
  // segmento (regiões como southamerica-east1 podem ter hífen).
  const key = probe.keys.find((k) => {
    const parts = k.split("-");
    return parts.length >= 3 && parts[parts.length - 2] === fn;
  });
  if (!key) {
    log(`FALHA ${fn}: trigger não registrado no hub (${probe.keys.length} triggers no total). Emulador ainda subindo?`);
    return false;
  }
  const url = `${HUB_BASE}/${key}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: {} }),
    });
    const text = await res.text();
    const ok = res.ok || res.status < 500;
    log(`DISPARO ${fn} → ${key} (HTTP ${res.status}) em ${Date.now() - started}ms${!ok ? ` ${text.slice(0, 300)}` : ""}`);
    if (!ok) await publishToTopic(fn); // melhor esforço
    return ok;
  } catch (e) {
    log(`ERRO ${fn}: ${e.message}`);
    return false;
  }
}

function buildCron(job) {
  return new Cron(job.schedule, { timezone: job.timeZone }, () => {
    runJob(job);
  });
}

async function main() {
  const args = process.argv.slice(2);
  let jobs = discoverJobs();

  if (ONLY_FN) {
    const allow = ONLY_FN.split(",").map((s) => s.trim());
    jobs = jobs.filter((j) => allow.includes(j.fn));
  }

  // Modo one-shot: NEXO_CRON_RUN="fn1,fn2" dispara imediatamente e encerra.
  if (process.env.NEXO_CRON_RUN) {
    const targets = process.env.NEXO_CRON_RUN.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const fn of targets) {
      const job = jobs.find((j) => j.fn === fn);
      if (!job) {
        log(`AVISO: function ${fn} nao encontrada ou nao agendada.`);
        continue;
      }
      log(`=== DISPARO MANUAL ${fn} ===`);
      await runJob(job);
    }
    // Deixa o processo encerrar naturalmente (process.exit(0) cruza com libuv
    // e dispara o "Assertion failed: UV_HANDLE_CLOSING" no Windows).
    await new Promise((r) => setTimeout(r, 150));
    process.exit(0);
  }

  if (jobs.length === 0) {
    log("Nenhuma function agendada encontrada.");
    process.exit(1);
  }

  log(`=== NEXO LOCAL SCHEDULER (functions emulator ${FUNCTIONS_HOST}, projeto ${PROJECT_ID}) ===`);
  log(`Jobs descobertos: ${jobs.map((j) => j.fn).join(", ")}`);
  log(`Próximos disparos:`);
  for (const j of jobs) {
    const c = new Cron(j.schedule, { timezone: j.timeZone });
    const next = c.nextRun(new Date());
    log(`  ${j.fn.padEnd(28)} ${j.schedule} (${j.timeZone})${j.source !== j.schedule ? ` [${j.source}]` : ""} → ${next?.toISOString()}`);
  }
  log(`Tick a cada ${TICK_MS / 1000}s. Ctrl+C para encerrar.`);

  for (const j of jobs) buildCron(j);

  // Mantém o processo vivo.
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  log(`ERRO FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
